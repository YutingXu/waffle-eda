"use strict";
const assert = require("node:assert/strict");
for (const name of ["model","parts","spatial","connectivity","pcb-appearance","pcb-pours","stackup","sch-appearance","sch-objects","hierarchy",
  "multichannel","rules","erc","netlist","netlist-text","vectorize","pcb-text-rich","pcb-text","canvas","zip","bom","fab-outputs","path-record",
  "pdf","vendor/dejavu-sans","pdf-fonts","print","drawing-views","drawing"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));

const PR=AtriumPrint, P=AtriumPDF, date=new Date("2026-01-05T00:00:00Z");
const raw=bytes=>new TextDecoder("latin1").decode(bytes);
const hex=s=>"<FEFF"+Array.from(s,c=>c.charCodeAt(0).toString(16).padStart(4,"0")).join("")+">";
const fixture=()=>{
  const p=AtriumParts.example(), [root,board]=p.documents;
  root.id="analogue"; board.id="board";
  const child=Atrium.sheet("schematic","Controller"); child.id="controller";
  root.items.push({id:"sheet-child",kind:"sheetsymbol",x:122,y:95,w:27,h:12,name:"Controller",sheet:child.id,entries:[]},
    {id:"clock-source",kind:"offsheet",x:106,y:98,text:"SPI_CLK",angle:0},
    {id:"wire-only",kind:"wire",points:[[88,101],[107,101]],net:"WIRE_SENSE"});
  child.items.push({id:"clock-destination",kind:"offsheet",x:53,y:32,text:"SPI_CLK",angle:0});
  const opamp=p.library.find(d=>d.id==="std-opamp");
  opamp.description="Rail-to-rail test amplifier";
  opamp.symbol.pins[0].name="OUT_SENSE";
  const u=root.items.find(i=>i.ref==="U1");
  u.value="Analog buffer"; u.showValue=false;
  u.parameters={"Mfr. Part No.":"WA-TEST-42","Gain bandwidth":"2 MHz"};
  board.items.push({id:"inner-sense",kind:"track",layer:"Inner 1",net:"PCB_ONLY_SENSE",width:.45,points:[[8,3],[17,3]]});
  p.documents.splice(1,0,child);
  return p;
};
// Representative per-sheet Notes scene in physical sheet units. Its API is
// shared with #40. This fixture exercises the PDF contract without its editor.
const notes={
  sheetNotes({sheetId,clip,purpose,includeNotes}) {
    assert.equal(purpose,"print"); assert.ok(clip[2]>clip[0]);
    return sheetId==="analogue" && includeNotes!==false ? [{id:"review",bounds:[63,100,80,107]}] : [];
  },
  draw(c) {
    c.fillStyle="#ffcc33";c.globalAlpha=.38;c.fillRect(63,104,15,2);
    c.globalAlpha=1;c.fillStyle="#243249";c.font="2.4px Helvetica";c.fillText("Review checked",63,105);
  }
};
const options={date,layerSets:["composite"],attachments:true,notebook:notes};
const project=fixture(), result=PR.build(project,options), plain=raw(result.bytes({compress:false}));
assert.equal(result.pages.length,3);
assert.ok(plain.includes("/Version /1.7") && plain.includes("/OCProperties"));
for (const layer of ["Sensor board · Top","Sensor board · Bottom","Sensor board · Inner 1","Analog front end · Notes"])
  assert.ok(plain.includes("/Type /OCG /Name "+hex(layer)),layer);
assert.match(plain,/\/Subtype \/Text/); assert.match(plain,/\/Subtype \/Link/); assert.match(plain,/3 Tr/);
assert.ok(plain.includes("/M (D:20260105000000Z) /CreationDate (D:20260105000000Z)"));
for (const s of ["WIRE_SENSE","SPI_CLK","PCB_ONLY_SENSE"]) assert.ok(plain.includes("/Title "+hex(s)),"net bookmark "+s);
const prop="Value: Analog buffer\nMPN: WA-TEST-42\nFootprint: "+project.library.find(d=>d.id==="std-opamp").footprint.name+
  "\nDescription: Rail-to-rail test amplifier\nGain bandwidth: 2 MHz";
assert.ok(plain.includes("/Contents "+hex(prop)),"canonical procurement aliases and user parameters");
assert.ok(plain.includes("/Type /EmbeddedFile /Subtype /text#2Fcsv"));
assert.ok(plain.includes(AtriumBOM.csv(AtriumBOM.report(project,{titleBlock:false})).split("\n")[0].replace(/^\uFEFF/,"")));
assert.ok(plain.includes(AtriumNetlistText.compile(project).text.split("\n")[0]));
assert.ok(plain.includes("/UF "+hex("netlist.txt")));
assert.equal(raw(result.bytes()),raw(PR.build(project,options).bytes()));
assert.deepEqual(result.notes,[]);
const sch=result.pages[0], pcb=result.pages[2];
assert.ok(sch.marks.some(m=>m.word==="Analog buffer") && sch.marks.some(m=>m.word==="OUT_SENSE"));
assert.ok(pcb.marks.some(m=>m.net==="PCB_ONLY_SENSE"));
assert.ok(pcb.list.some(o=>o.layer?.name==="Sensor board · Inner 1" && o.k==="p"));
const without=raw(PR.build(project,{...options,viewerLayers:false,includeNotes:false,properties:false,attachments:false}).bytes({compress:false}));
assert.ok(!without.includes("/OCProperties") && !without.includes("/Subtype /Text") && !without.includes("/EmbeddedFiles"));
const top=PR.build(project,{...options,documents:["board"],layerSets:["top"]});
assert.ok(!top.pages[0].marks.some(m=>m.net==="PCB_ONLY_SENSE"));
assert.ok(!raw(top.bytes({compress:false})).includes("/Title "+hex("PCB_ONLY_SENSE")));
const cropped=P.recorder(100,90);
const image={width:4,height:2,rgb:new Uint8Array(24)};
cropped.ctx.translate(1,2); cropped.ctx.withLayer("Notes",()=>cropped.ctx.drawImage(image,1,0,2,1,10,20,8,4));
assert.equal(cropped.list[0].layer,"Notes");
assert.deepEqual(cropped.list[0].m.map(n=>n || 0),[16,0,0,-8,7,30]);
assert.deepEqual(cropped.list[0].clip.d,[0,11,22,1,19,22,1,19,26,1,11,26,3]);
assert.equal(cropped.ctx.getTransform().e,1);

// Wall-clock and local-time defaults must not leak through schematic, assembly
// or drawing title blocks when the export has its own frozen timestamp.
const withDrawing=fixture(), drawing={...Atrium.sheet("schematic","Assembly drawing"),kind:"drawing",id:"draft",
  drawing:{version:1,board:"board",sheets:[{id:"drawing-sheet",name:"Sheet 1",size:"A4",titleBlock:true}],
    views:[],dimensions:[],notes:[],revisions:[],parameters:{}}};
withDrawing.documents.push(drawing);
const drawingSource=JSON.stringify(drawing), NativeDate=Date;
function atTime(day,explicitDate) {
  globalThis.Date=class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [day])); }
    static now() { return NativeDate.now(); }
  };
  try {
    const opts={layerSets:["assembly-top"],attachments:true,...(explicitDate ? {date:new Date(explicitDate)} : {})};
    return PR.build(withDrawing,opts).bytes();
  } finally { globalThis.Date=NativeDate; }
}
for (const date of [null,"2026-01-05T00:10:00Z"]) {
  const one=atTime("2025-02-10T23:50:00Z",date), two=atTime("2027-03-22T04:00:00Z",date);
  assert.ok(one.length===two.length && one.every((v,i)=>v===two[i]),"reproducible on different calendar days");
}
assert.equal(JSON.stringify(drawing),drawingSource,"printing leaves drawing records intact");

async function snapshot() {
  let released=0, prepared=0;
  const saved=fixture(), current=fixture(); saved.name="Saved revision";current.name="Unsaved changes";
  const archive=AtriumZip.create([{name:"Design.waffle",data:"synthetic saved snapshot"}],{date});
  const provider={
    acquireSavedExportSnapshot:async()=>({project:saved,snapshotId:"revision-4",
      projectArchive:async()=>({name:"Design.zip",bytes:archive,snapshotId:"revision-4"}),release:()=>released++}),
    prepareAssets:async(p,{documentIds,windows})=>{
      assert.strictEqual(p,saved);assert.deepEqual(documentIds,["analogue"]);assert.equal(windows.get("analogue").length,1);
      prepared++;return {assets:new Map(),release:()=>released++};
    }
  };
  const args={...options,documents:["analogue"],includeProject:true,compress:false};
  const bytes=raw(await PR.preparePDF(current,args,provider));
  assert.ok(bytes.includes("/Title "+hex("Saved revision")) && !bytes.includes(hex("Unsaved changes")));
  assert.ok(bytes.includes("/UF "+hex("Design.zip")) && bytes.includes("synthetic saved snapshot"));assert.equal(released,2);assert.equal(prepared,1);
  for (const value of [null,{snapshotId:"other",name:"Wrong.zip",bytes:archive}]) {
    let message="";
    try { await PR.preparePDF(current,args,{acquireSavedExportSnapshot:()=>({project:saved,snapshotId:"revision-4",projectArchive:()=>value,release:()=>released++})}); }
    catch (e) { message=e.message; }
    assert.match(message,/unavailable|snapshot/);
  }
  assert.equal(released,4);
  let snapshotName;
  const pending=PR.preparePDF(current,{...options,documents:["analogue"],compress:false},{
    prepareAssets:async(p)=>{await Promise.resolve();snapshotName=p.name;return new Map();}
  });
  current.name="Changed while preparing";
  const consistent=raw(await pending);
  assert.equal(snapshotName,"Unsaved changes");assert.ok(consistent.includes("/Title "+hex(snapshotName)));
}
snapshot().then(()=>console.log("smart-pdf: ok"),e=>{throw e;});
module.exports={fixture,options};
