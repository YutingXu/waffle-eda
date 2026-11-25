"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {appFile}=require("../support/app-source-paths.cjs");
globalThis.CFB=require(appFile("vendor/cfb.min.js"));
for(const file of ["model","parts","sch-import","io","source-file","sch-patch","source-copy","spatial","pcb-appearance","sch-appearance","canvas"])require(appFile(file+".js"));
const A=Atrium,appearance=AtriumSchAppearance;
require(appFile("sch-objects.js"));
function close(a,b){assert.ok(Math.abs(a-b)<1e-6,"expected "+a+" ≈ "+b);}
{
  // A rotated component's parameter coordinates are sheet coordinates, including the fractional
  // ticks. A user-visible caption can be a different parameter from the hidden BOM value.
  const source=["|RECORD=31|FontIdCount=1|Size1=10|FontName1=Arial",
    "|RECORD=1|LibReference=Probe|Orientation=1|Location.X=100|Location.Y=160",
    "|RECORD=34|OwnerIndex=1|Text=X1|Location.X=97|Location.Y=170",
    "|RECORD=41|OwnerIndex=1|Name=Value|Text=Logical|IsHidden=T|Location.X=80|Location.Y=90",
    "|RECORD=41|OwnerIndex=1|Name=Rating|Text=3 V|Location.X=116|Location.X_Frac=25000|Location.Y=140|Justification=2|Orientation=1",
    "|RECORD=41|OwnerIndex=1|Name=Hidden|Text=Never|IsHidden=T|Location.X=10|Location.Y=20"].join("\n");
  const {documents:[sheet]}=AtriumSCH.read("Probe.SchDoc",null,source),part=sheet.items.find(i=>i.kind==="part");
  assert.equal(part.value,"Logical");assert.equal(part.showValue,false);
  assert.deepEqual(AtriumSchObjects.shownParams(part),["RATING"]);
  let at,angle,record;
  const ctx={save(){},restore(){},translate(x,y){at=[x,y];},rotate(a){angle=a;},fillText(t,x,y){record=[t,this.textAlign,this.textBaseline,y<0];}};
  AtriumSchObjects.drawParams(ctx,part,{},10,false);
  close(at[0],116.25*.254);close(at[1],-140*.254);close(Math.sin(angle),-1);assert.deepEqual(record,["3 V","right","alphabetic",true],"bottom-anchored text is drawn on the alphabetic baseline, raised by the descent");
  part.x+=7;part.parameters={RATING:"5 V"};
  AtriumSchObjects.drawParams(ctx,part,{},10,false);close(at[0],116.25*.254+7);assert.equal(record[0],"5 V");
}
function graphics(){
  const text=[],strokes=[],fills=[],stack=[];
  const ctx=new Proxy({save(){stack.push(Object.fromEntries(Object.entries(this).filter(([key,v])=>typeof v!=="function")));},
    restore(){Object.assign(this,stack.pop());},fillText(value,x,y){text.push({value,x,y,ink:this.fillStyle,font:this.font});},
    stroke(){strokes.push(this.strokeStyle);},fill(){fills.push(this.fillStyle);},
    fillRect(){fills.push(this.fillStyle);},measureText(value){return {width:value.length*1.3};}},
    {get:(obj,key)=>obj[key]??(()=>{})});
  const view=AtriumCanvas.create({getContext:()=>ctx,getBoundingClientRect:()=>({width:1100,height:720})});
  return {text,strokes,fills,ctx,view};
}
{
  // In Nordic's published four-gate schematic the native designator records all say
  // U1; the printed sheet shows U1A…U1D. The connector and PCB keep the base reference.
  const records=["|RECORD=31|FontIdCount=1|Size1=10|FontName1=Arial"];
  for(let n=1;n<=4;n++){
    const idx=records.length;
    records.push(`|RECORD=1|LibReference=MCU|PartCount=5|CurrentPartID=${n}|Orientation=3|Location.X=${40*n}|Location.Y=20`,
      `|RECORD=34|OwnerIndex=${idx}|Text=U1|Location.X=${40*n+2}|Location.Y=25`,
      `|RECORD=13|OwnerIndex=${idx}|OwnerPartID=${n}|Location.X=${40*n}|Location.Y=20|Corner.X=${40*n+4}|Corner.Y=20`);
  }
  const header=Buffer.concat(records.map(line=>{const data=Buffer.from(line+"\0"),len=Buffer.alloc(4);len.writeUInt32LE(data.length);return Buffer.concat([len,data]);}));
  const streams=new Map([["fileheader",header]]);
  const {documents:[sheet],library}=AtriumSCH.read("MCU.SchDoc",streams),defs=new Map(library.map(d=>[d.id,d]));
  const parts=sheet.items.filter(i=>i.kind==="part");assert.deepEqual(parts.map(p=>p.ref),Array(4).fill("U1"));
  assert.equal(sheet.schDrawing.textPlacement,2);
  for(const [n,p] of parts.entries()){
    const point=A.world(p.refAt,p);close(point[0],((n+1)*40+2)*.254);close(point[1],-25*.254);
  }
  const draw=()=>{const g=graphics();g.view.fit(sheet,defs);g.view.render(sheet,defs);return g.text.map(t=>t.value).filter(t=>/^U\d/.test(t));};
  assert.deepEqual(draw(),["U1A","U1B","U1C","U1D"]);
  parts[1].ref="U23";assert.deepEqual(draw(),["U1A","U23B","U1C","U1D"]);
  const legacy=AtriumSCH.read("MCU.SchDoc",streams,null,{textPlacement:1}).documents[0];
  assert.equal(legacy.schDrawing.textPlacement,1);assert.ok(legacy.items.every(i=>!i.schPaint?.designatorUnit));
}
const sample=AtriumParts.example(),draft=sample.documents[0],symbols=new Map(sample.library.map(d=>[d.id,d]));
{
  const src=["|RECORD=31|FontIdCount=2|SystemFont=2|Size1=10|FontName1=Times New Roman|Size2=10|FontName2=Arial",
    "|RECORD=17|IsCrossSheetConnector=T|Text=SDA|ShowNetName=T|Color=255|FontId=1|Location.X=100|Location.Y=50",
    "|RECORD=41|OwnerIndex=1|Name=CrossRef|Text=MCU[3D]|Location.X=174|Location.X_Frac=25000|Location.Y=55|Justification=3|Orientation=2|FontId=1",
    "|RECORD=41|OwnerIndex=1|Name=CrossRef|Text=Suppressed|IsHidden=T|Location.X=174|Location.Y=55",
    "|RECORD=18|Name=DATA|Width=40|Height=10|Location.X=20|Location.Y=10|FontId=2",
    "|RECORD=41|OwnerIndex=4|Name=CrossRef|Text=Child[1B]|Location.X=80|Location.Y=12|FontId=1",
    "|RECORD=27|LocationCount=2|X1=60|Y1=10|X2=60|Y2=40",
    "|RECORD=17|Text=VOUT|ShowNetName=T|Style=2|Orientation=1|Location.X=750|Location.Y=500|FontId=2",
    "|RECORD=1|LibReference=Probe|Orientation=1|Location.X=50|Location.Y=40",
    "|RECORD=2|OwnerIndex=8|PinConglomerate=56|PinLength=10|Location.X=60|Location.Y=40|Name=CLK|Designator=9|PinName_PositionConglomerate=16|Name_CustomFontId=1"].join("\n");
  const {documents:[sheet],library}=AtriumSCH.read("Crossing.SchDoc",null,src);
  const output=[],frames=[];let frame={x:0,y:0,angle:0};
  const ctx=new Proxy({save(){frames.push({...frame});},restore(){frame=frames.pop();},rotate(r){frame.angle+=r*180/Math.PI;},
    translate(x,y){[frame.x,frame.y]=A.world([x,y],frame);},fillText(t,x,y){output.push({t,at:A.world([x,0],frame),angle:frame.angle,align:this.textAlign,face:this.font});}},
    {get:(o,k)=>o[k]??(()=>{})});
  const paintLabel=i=>{output.length=0;appearance.label(ctx,i,15,false);return output;};
  const matches=(v,x,y,angle,align)=>{close(v.at[0],x);close(v.at[1],y);close((v.angle-angle)%360,0);assert.equal(v.align,align);};
  const off=sheet.items.find(i=>i.text==="SDA"),port=sheet.items.find(i=>i.text==="DATA"),power=sheet.items.find(i=>i.text==="VOUT");
  let words=paintLabel(off);assert.deepEqual(words.map(w=>w.t),["SDA","MCU[3D]"]);assert.match(words[0].face,/Arial/);assert.match(words[1].face,/Times New Roman/);
  matches(words[1],174.25*.254,-55*.254,180,"left");const bounds=appearance.labelBox(off);assert.ok(bounds[2]>=words[1].at[0]);
  const stored=off.schPaint.crossReferences[0].at;off.x+=3;off.angle=90;const moved=A.world(stored,off);matches(paintLabel(off)[1],...moved,270,"left");
  close(port.x,60*.254);matches(paintLabel(port)[1],80*.254,-12*.254,0,"left");
  // Nine upward power labels share the bar's bottom-text anchor in two Nordic Altium prints.
  matches(paintLabel(power)[0],750*.254,-500*.254-2.54,0,"center");
  const part=sheet.items.find(i=>i.kind==="part");output.length=0;appearance.pinText(ctx,part,library[0],15,false);
  matches(output[0],60*.254-1.778,-40*.254,0,"right");assert.match(output[0].face,/Times New Roman/);
  matches(output[1],60*.254+2.032,-40*.254,0,"left");assert.match(output[1].face,/Arial/);
  const project={...A.project("Crossing"),library,documents:[sheet]};A.validate(project);
  const badCaption=A.clone(project);badCaption.documents[0].items.find(i=>i.text==="SDA").schPaint.crossReferences[0].at=[0];
  assert.throws(()=>A.validate(badCaption),/Invalid Waffle editor model/);
  const badFont=A.clone(project);badFont.library[0].schDrawing.pins[0].nameFont.size=0;assert.throws(()=>A.validate(badFont),/Invalid Waffle editor model/);
}
assert.ok(draft.items.some(i=>i.kind==="netlabel"&&i.schPaint?.type==="power"));
const plain=draft.items.find(i=>i.kind==="netlabel"&&i.text==="VIN");
assert.equal(plain.schPaint,undefined);
{
  const probe=graphics(),def=new Map(),sheet=A.sheet("schematic","Anchors");
  const item={id:"label",kind:"netlabel",text:"NET",x:17,y:-11,angle:90};
  const ghost={...item,id:"preview",x:21,y:-8};sheet.items=[item];
  probe.view.fit(sheet,def);const circles=[];probe.ctx.arc=(x,y,r)=>circles.push([x,y,r*probe.view.scale()]);
  const anchor=(item,r)=>circles.some(([x,y,s])=>x===item.x&&y===item.y&&Math.abs(r-s)<1e-6);
  probe.view.render(sheet,def);assert.equal(circles.length,0,"the editor anchor is omitted in output artwork");
  probe.view.render(sheet,def,{editorPane:true});assert.ok(anchor(item,2.5),"placed label marks its stored electrical point");
  circles.length=0;probe.view.render(sheet,def,{editorPane:true,selected:item.id,ghost});
  assert.ok(anchor(item,4.1)&&anchor(ghost,4.1),"selected labels and placement previews emphasize the same anchor");
}
const synthetic="|RECORD=31|UseCustomSheet=T|CustomX=650|CustomY=500|WorkspaceOrientation=1|VisibleGridSize=5|AreaColor=16777215|FontIdCount=1|Size1=10|FontName1=Arial\n|RECORD=18|Name=DATA|Style=5|Height=12|Width=40|Location.X=25|Location.Y=25|Color=255|AreaColor=65280|Alignment=1\n|RECORD=17|Text=VSS|Style=4|Orientation=3|Location.X=10|Location.Y=20|ShowNetName=T";
const doc=AtriumSCH.read("Control.SchDoc",null,synthetic).documents[0],page=appearance.pageBounds(doc);
assert.deepEqual(page,[0,-650*.254,500*.254,0]);close(doc.schDrawing.grid,1.27);
const port=doc.items.find(i=>i.text==="DATA"),bound=appearance.labelBox(port);
assert.equal(port.schPaint.type,"port");assert.equal(port.schPaint.ink,"#ff0000");assert.equal(port.schPaint.paper,"#00ff00");
close(bound[3],port.y);close(bound[1],port.y-10.16);
const graphics1=graphics();graphics1.view.fit(doc,new Map(),"document");graphics1.view.render(doc,new Map());
const glyphs=graphics1.text.map(t=>t.value);
assert.ok(glyphs.includes("DATA")&&glyphs.includes("VSS"));
assert.ok(graphics1.fills.includes("#00ff00")&&graphics1.strokes.includes("#ff0000"));
assert.equal(graphics1.view.hit(doc,new Map(),[port.x,port.y-5])?.id,port.id);
// The imported sheet has its own template, so no native title block is drawn over it.
assert.ok(!glyphs.includes("Drawn By:"));
// A native sheet uses Altium's defaults: paper, black border with 4 × 4 zones, the
// standard title block, a light line grid, navy wires and text, maroon/yellow bodies,
// black pins with numbers, and Times New Roman designators.
const native=graphics();native.view.fit(draft,symbols,"document");native.view.render(draft,symbols);
const words=native.text.map(t=>t.value);
for(const w of ["Title","Size","A4","Number","Revision","Date:","File:","Sheet","of","Drawn By:","Analog front end","Analog front end.SchDoc",
  "1","4","A","D","J1","U1","Buffer","10 kΩ","FILTER","VIN","BUF","VOUT","VDD","GND","5"])assert.ok(words.includes(w),w);
assert.ok(!words.includes("E")&&!words.includes("6"),"A4 sheets have four zones each way");
const designator=native.text.find(t=>t.value==="U1");
assert.equal(designator.ink,appearance.wire);assert.match(designator.font,/Times New Roman/);
assert.equal(native.text.find(t=>t.value==="5").ink,"#000000");
for(const ink of ["#000000","#800000","#000080","#e6e3dc"])assert.ok(native.strokes.includes(ink),ink);
assert.ok(native.fills.includes("#fffcf8")&&native.fills.includes("#ffffb0"));
const gridless=graphics();gridless.view.fit(draft,symbols,"document");gridless.view.render(draft,symbols,{grid:false});
assert.ok(!gridless.strokes.includes("#e6e3dc"));
assert.equal(symbols.get("std-opamp").schDrawing.pins.length,5);assert.equal(symbols.get("std-j3").schDrawing.pins.length,3);
assert.equal(symbols.get("std-r").schDrawing,undefined);
// Every sample terminal sits on Altium's 100 mil grid.
for(const part of draft.items.filter(i=>i.kind==="part"))for(const pin of A.pins(part,symbols.get(part.def),"schematic"))
  for(const v of pin.at)close(Math.round(v/2.54)*2.54,v);
// Sheet templates: sizes, orientation, zones, title blocks and Altium special strings.
const sized=A.clone(sample),sheetB=sized.documents[0];
assert.deepEqual(appearance.pageBounds(sheetB),[-12.7,-12.7,292.1-12.7,193.04-12.7]);
sheetB.sheet={size:"ANSI B",titleBlock:"ansi",params:{Title:"Sensor interface",DocumentNumber:"AFE-001",Revision:"B",
  CompanyName:"Waffle Labs",DrawnBy:"Y. T.",CAGE:"1ABC2",Note:"=Engineer"}};
sized.parameters={CompanyName:"Project Co",Engineer:"E. Ng"};
appearance.validateSheet(sheetB.sheet);
const reloaded=A.validate(JSON.parse(JSON.stringify(A.validate(sized))));
assert.deepEqual(reloaded.documents[0].sheet,sheetB.sheet);
const b=appearance.pageBounds(sheetB);close(b[2]-b[0],431.8);close(b[3]-b[1],279.4);close(b[0],-12.7);
let t=appearance.sheetOf(sheetB);assert.deepEqual([t.label,t.zonesX,t.zonesY,t.titleBlock,t.margin],["B",8,4,"ansi",5.08]);
t=appearance.sheetOf({sheet:{size:"ANSI B",orientation:"portrait"}});close(t.width,279.4);close(t.height,431.8);assert.deepEqual([t.zonesX,t.zonesY],[4,8]);
t=appearance.sheetOf({sheet:{size:"A3",zones:{x:10}}});assert.deepEqual([t.width,t.height,t.zonesX,t.zonesY],[420,297,10,6]);
t=appearance.sheetOf({sheet:{size:"Huge",zones:{x:-3},titleBlock:"fancy",params:[1]}});
assert.deepEqual([t.size,t.zonesX,t.zonesY,t.titleBlock,t.params],["Altium A4",4,4,"standard",{}]);
for(const bad of [{size:"Huge"},{orientation:"sideways"},{zones:{x:0}},{titleBlock:"fancy"},{params:{Title:3}},[]])
  assert.throws(()=>appearance.validateSheet(bad),/supported Waffle project/);
const resolve=(text,opts)=>appearance.resolveSpecialStrings(text,sized,sheetB,opts);
assert.equal(resolve("=Title"),"Sensor interface");assert.equal(resolve("=title"),"Sensor interface");
assert.equal(resolve("Sheet =SheetNumber of =SheetTotal"),"Sheet 1 of 1");
assert.equal(resolve("=ProjectName / =DocumentName"),"Sensor interface / Analog front end.SchDoc");
assert.equal(resolve("=CompanyName"),"Waffle Labs","sheet parameters override project parameters");
assert.equal(resolve("=Engineer"),"E. Ng");assert.equal(resolve("=Note"),"=Engineer","values are not resolved twice");
assert.equal(resolve("=SheetSize"),"B");assert.equal(resolve("=Unknown"),"*");assert.equal(resolve("=Unknown",{missing:""}),"");
assert.equal(resolve("a=b, x = y"),"a=b, x = y");
const day=new Date(2026,10,18);assert.equal(resolve("=CurrentDate",{now:day}),day.toLocaleDateString());
appearance.setProject(sized);
const ansiSheet=graphics();ansiSheet.view.fit(sheetB,symbols,"document");ansiSheet.view.render(sheetB,symbols);
const ansiWords=ansiSheet.text.map(v=>v.value);
for(const w of ["APPROVALS","DRAWN","CHECKED","APPROVED","TITLE","SIZE","FSCM NO.","DWG NO.","REV","SCALE","SHEET","OF",
  "Waffle Labs","Sensor interface","B","1ABC2","AFE-001","Y. T.","NONE","1","8","D"])assert.ok(ansiWords.includes(w),w);
assert.ok(!ansiWords.includes("Drawn By:"));
sheetB.sheet.size="ANSI E";const large=graphics();large.view.fit(sheetB,symbols,"document");large.view.render(sheetB,symbols);
const largeWords=large.text.map(v=>v.value);assert.ok(largeWords.includes("J")&&largeWords.includes("16")&&!largeWords.includes("I"),"ASME zones skip I");
const iso=A.clone(sample);iso.documents[0].sheet={size:"A3",params:{DrawnBy:"Y. T."}};appearance.setProject(iso);
const isoSheet=graphics();isoSheet.view.fit(iso.documents[0],symbols,"document");isoSheet.view.render(iso.documents[0],symbols);
const isoWords=isoSheet.text.map(v=>v.value);
for(const w of ["Title","Drawn By:","Y. T.","A3","8","F"])assert.ok(isoWords.includes(w),w);assert.ok(!isoWords.includes("G"));
iso.documents[0].sheet.titleBlock="none";const bare=graphics();bare.view.fit(iso.documents[0],symbols,"document");bare.view.render(iso.documents[0],symbols);
assert.ok(!bare.text.some(v=>v.value==="Title"));
appearance.setProject(null);
const f=process.argv.indexOf("--fixtures");
if(f>=0){
  const name="Level.Shifter.SchDoc",source=fs.readFileSync(path.join(process.argv[f+1],name));
  const imported=AtriumIO.read(name,source),d=imported.documents[0],defs=new Map(imported.library.map(def=>[def.id,def]));
  const project=A.project("Source",imported.library);project.documents=[d];A.validate(project);
  const invalidPort=A.clone(project);invalidPort.documents[0].items.find(i=>i.schPaint?.type==="port").schPaint.offset=null;
  assert.throws(()=>A.validate(invalidPort),/Invalid Waffle editor model/);
  const objects=graphics();objects.view.fit(d,defs,"objects");objects.view.render(d,defs);
  const ic=d.items.find(i=>i.ref==="IC5"),def=defs.get(ic.def),texts=objects.text.map(v=>v.value);
  assert.deepEqual(appearance.pageBounds(d),[0,-193.04,292.1,0]);
  assert.equal(d.schDrawing.paper,"#fffcf8");assert.equal(d.schDrawing.font[0].family,"Times New Roman");
  assert.ok(d.schDrawing.frame.some(v=>v.text==="Level Shifter"));assert.ok(d.schDrawing.frame.some(v=>v.kind==="path"));
  assert.equal(d.items.filter(i=>i.schPaint?.type==="port").length,8);
  assert.equal(d.items.filter(i=>i.schPaint?.type==="power").length,5);
  assert.ok(d.items.filter(i=>i.kind==="wire").every(i=>i.schPaint.ink==="#000080"));
  assert.equal(def.schDrawing.pins.find(p=>p.name==="VCCA").number,"1");
  assert.ok(def.symbol.shapes.some(s=>s.fill&&s.schPaint?.ink==="#800000"&&s.schPaint.fill==="#ffffb0"));
  for(const value of ["1","14","VCCA","VCCB","IC5","CS_3V3","TXU0304PWR"])assert.ok(texts.includes(value),value);
  assert.ok(objects.fills.includes("#ffffb0")&&objects.strokes.includes("#000080"));
  const before=graphics();before.view.fit(d,defs,"document");
  assert.ok(before.view.scale()<objects.view.scale()/2);
  const exact=AtriumSourceCopy.prepare(d,imported.library,source);
  assert.deepEqual(Buffer.from(exact.bytes),source);
  // A 0.3 saved document omits these optional display fields. Its wire and component
  // geometry must still match byte-for-byte on the original projection.
  const legacy=AtriumSCH.read(name,AtriumIO.streams(source),null,{appearance:false});
  const old=legacy.documents[0];old.sourceSha256=d.sourceSha256;assert.equal(old.schDrawing,undefined);
  old.items.find(i=>i.ref==="C17").ref="C1701";
  const copy=AtriumSourceCopy.prepare(old,legacy.library,source);
  assert.deepEqual(copy.records,[161]);assert.deepEqual(AtriumIO.read(copy.name,copy.bytes).documents[0].items.filter(i=>i.ref==="C1701").length,1);
  const oldDefs=new Map(legacy.library.map(def=>[def.id,def])),oldIc=old.items.find(i=>i.ref==="IC5");
  const beforeItems=JSON.stringify(old.items),beforeDefs=JSON.stringify(legacy.library);
  assert.equal(appearance.eligible(old),true);
  assert.throws(()=>appearance.planRestore(old,legacy.library,{...imported,documents:[{...d,sourceSha256:"a".repeat(64)}]}),/differs/);
  const linked=appearance.planRestore(old,legacy.library,imported);
  assert.equal(linked.custom,0);assert.equal(linked.matched,old.items.length);
  const customDefs=A.clone(legacy.library),customIc=customDefs.find(v=>v.id===oldIc.def);
  customIc.symbol.shapes[0].width=2;
  const custom=appearance.planRestore(old,customDefs,imported);
  assert.ok(custom.custom>0);assert.equal(custom.appearance.definitions[oldIc.def],undefined);
  old.schRestored=linked.appearance;
  assert.deepEqual(appearance.pageBounds(old),appearance.pageBounds(d));
  const legacyProject=A.project("Edited",legacy.library);legacyProject.documents=[old];A.validate(legacyProject);
  assert.equal(JSON.stringify(old.items),beforeItems);assert.equal(JSON.stringify(legacy.library),beforeDefs);
  const seen=graphics();seen.view.fit(old,oldDefs,"objects");seen.view.render(old,oldDefs);
  assert.ok(seen.fills.includes("#ffffb0")&&seen.strokes.includes("#000080"));
  assert.ok(seen.text.some(t=>t.value==="VCCA")&&seen.text.some(t=>t.value==="C1701"));
  assert.deepEqual(Buffer.from(AtriumSourceCopy.prepare(old,legacy.library,source).bytes),Buffer.from(copy.bytes));
  const round=A.validate(JSON.parse(JSON.stringify(legacyProject)));
  assert.equal(round.documents[0].schRestored.sheet.frame.length,d.schDrawing.frame.length);
  const invalid=A.clone(round);invalid.documents[0].schRestored.definitions[oldIc.def].pins=null;
  assert.throws(()=>A.validate(invalid),/Invalid Waffle editor model/);
  console.log("PASS source sheet, title block, ports, power symbols, pin numbers, native colors and 0.3 appearance restoration with retained edits and native copy");
}
console.log("PASS schematic sheet fit, custom portrait page, port bounds/picking, grid, pin labels, plain net labels, the native Altium-style sheet, sheet templates and special strings");
{
  // Altium negation (beta feedback on the private-project-03 import): "C\S\" shows CS with a bar over each letter, a
  // leading backslash stays literal, and a port's cross-reference turned half round reads upright with its
  // anchor kept (Altium places it to the left of a left-pointing connector).
  const drawn=[],bars=[];let align;
  const ctx={save(){},restore(){},translate(){},rotate(){},getTransform(){return {a:10,b:0,c:0,d:10,e:0,f:0};},
    measureText(s){return {width:s.length,actualBoundingBoxAscent:1.5};},fillText(t){drawn.push(t);align=this.textAlign;},fillRect(x,y,w,h){bars.push([x,w]);},
    beginPath(){},moveTo(){},lineTo(){},stroke(){},closePath(){},arc(){},fill(){}};
  appearance.glyph(ctx,"C\\S\\",0,0,{size:2,family:"Arial"},10);
  assert.deepEqual(drawn,["CS"]);assert.deepEqual(bars,[[0,1],[1,1]]);
  // Single "\" negation is on by default (Preferences › Schematic › General): \SPI_CS is barred whole, in one bar.
  assert.equal(appearance.singleNegation(),true,"single negation defaults on");
  drawn.length=bars.length=0;appearance.glyph(ctx,"\\SPI_CS",0,0,{size:2,family:"Arial"},10);
  assert.deepEqual(drawn,["SPI_CS"]);assert.deepEqual(bars,[[0,6]]);
  drawn.length=bars.length=0;appearance.glyph(ctx,"\\SPI_CS",0,0,{size:2,family:"Arial",align:"right"},10,null);
  assert.deepEqual(bars,[[-6,6]],"the bar follows the justification");
  // Per-character marks work in both modes; \\ at the start writes one literal backslash.
  drawn.length=bars.length=0;appearance.glyph(ctx,"R\\E\\S\\E\\T\\",0,0,{size:2,family:"Arial"},10);
  assert.deepEqual(drawn,["RESET"]);assert.equal(bars.length,5);
  drawn.length=bars.length=0;appearance.glyph(ctx,"\\\\SPI_C\\S\\",0,0,{size:2,family:"Arial"},10);
  assert.deepEqual(drawn,["\\SPI_CS"]);assert.deepEqual(bars,[[5,1],[6,1]]);
  // Off (Altium's default): a leading backslash stays literal.
  appearance.singleNegation(false);
  drawn.length=bars.length=0;appearance.glyph(ctx,"\\SPI_CS",0,0,{size:2,family:"Arial"},10);
  assert.deepEqual(drawn,["\\SPI_CS"]);assert.deepEqual(bars,[]);
  drawn.length=bars.length=0;appearance.glyph(ctx,"R\\E\\S\\E\\T\\",0,0,{size:2,family:"Arial"},10);
  assert.deepEqual(drawn,["RESET"]);assert.equal(bars.length,5);
  appearance.singleNegation(true);
  // Every negated object kind draws the bar: net labels, ports and power ports (imported paint and native).
  for(const item of [{kind:"netlabel",x:0,y:0,text:"\\RESET"},{kind:"port",x:0,y:0,text:"\\RESET",schPaint:{type:"port",offset:[0,0],width:10,height:3,style:2,align:"center",size:2,family:"Arial"}},
    {kind:"power",x:0,y:0,text:"\\RESET",schPaint:{type:"power",direction:1,style:2,showName:true,size:2,family:"Arial"}}]){
    drawn.length=bars.length=0;appearance.label(ctx,item,10);
    assert.ok(drawn.includes("RESET")&&!drawn.some(t=>t.includes("\\")),item.kind+" draws RESET");assert.equal(bars.length,1,item.kind+" has one bar");
  }
  drawn.length=0;
  appearance.label(ctx,{kind:"netlabel",x:0,y:0,text:"NPM_GP0",schPaint:{type:"power",direction:2,offSheet:true,showName:true,size:2,family:"Arial",
    crossReferences:[{text:"NRF5340[2E]",at:[-14,0],angle:180,align:"left",baseline:"middle",size:2,family:"Times New Roman"}]}},10);
  assert.equal(drawn.at(-1),"NRF5340[2E]");assert.equal(align,"right","the half-turned caption is drawn upright, right-aligned at its anchor");
  console.log("PASS Altium negation bars and upright half-turned cross-references");
}
{
  // Altium's pens: LINEWIDTH 0 (or absent) Smallest, 1 Small (10 mil), 2 Medium, 3 Large. A pin record has no
  // width; Altium draws the pin line with the Small pen, so a pin leg matches a Small wire and a Small body line.
  const src=["|RECORD=31|FontIdCount=1|Size1=10|FontName1=Arial",
    "|RECORD=1|LibReference=Cap|Location.X=100|Location.Y=100",
    "|RECORD=2|OwnerIndex=1|PinConglomerate=1|PinLength=20|Location.X=100|Location.Y=120|Name=1|Designator=1",
    "|RECORD=13|OwnerIndex=1|LineWidth=1|Color=16711680|Location.X=90|Location.Y=120|Corner.X=110|Corner.Y=120",
    "|RECORD=6|OwnerIndex=1|LineWidth=2|Color=16711680|LocationCount=2|X1=90|Y1=116|X2=110|Y2=116",
    "|RECORD=13|OwnerIndex=1|Color=128|Location.X=90|Location.Y=110|Corner.X=110|Corner.Y=110",
    ...[0,1,2,3].map(w=>`|RECORD=27|LineWidth=${w}|Color=8388608|LocationCount=2|X1=${200+w*10}|Y1=10|X2=${200+w*10}|Y2=40`),
    "|RECORD=27|Color=8388608|LocationCount=2|X1=100|Y1=140|X2=100|Y2=170"].join("\n");
  const {documents:[sheet],library:[cap]}=AtriumSCH.read("Pens.SchDoc",null,src);
  const pens=sheet.items.filter(i=>i.kind==="wire").map(w=>w.schPaint.width);
  assert.deepEqual(pens,[.10,.254,.508,.762,.10],"wire pens: Smallest, Small, Medium, Large; absent is Smallest");
  assert.ok(sheet.items.filter(i=>i.kind==="wire").every(w=>w.schPaint.ink==="#000080"));
  const [leg,plate,medium,hairline]=cap.symbol.shapes;
  assert.deepEqual([leg.schPaint.ink,leg.schPaint.width],["#000000",.254],"the pin leg uses Altium's Small pen, in the pin colour");
  assert.deepEqual([plate.schPaint.ink,plate.schPaint.width],["#0000ff",.254]);
  assert.deepEqual([medium.schPaint.width,hairline.schPaint.width],[.508,.10]);
  // Drawn at the same zoom, a pin leg and a Small wire and body line have the same stroke.
  const strokes=[];
  const ctx=new Proxy({stroke(){strokes.push(this.lineWidth);}},{get:(o,k)=>o[k]??(()=>{}),set:(o,k,v)=>(o[k]=v,true)});
  for(const s of [leg,plate])appearance.shape(ctx,s,8,false);
  assert.deepEqual(strokes,[.254,.254]);
  // Zoomed out, both reach the wire's one-pixel floor together.
  strokes.length=0;appearance.shape(ctx,leg,2,false);assert.deepEqual(strokes,[.5]);
  console.log("PASS Altium pin legs, wires and body lines use Altium's line widths");
}
