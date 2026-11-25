"use strict";
// Fabrication outputs: Gerber X2, Excellon, pick and place, assembly SVG and the ZIP writer.
const assert=require("node:assert/strict");
const {parseGerber,parseExcellon}=require("./gerber-compare.cjs");
const {check:checkGerber}=require("./gerber-check.cjs");
for(const m of ["model","parts","pcb-pours","pcb-appearance","zip","fab-outputs"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const A=Atrium,F=AtriumFabOutputs,Z=AtriumZip;
const date=new Date(2026,10,18,10,30,0);

// Direct fabrication loads the same stroke font as the board editor.
assert.strictEqual(F.strokeText,AtriumPCBText.strokeText);
assert.equal(F.glyphs.size,95);
assert.equal(Z.crc32(Z.utf8(JSON.stringify([...F.glyphs]))),0xeb75de52);
assert.deepEqual(F.strokeText("L",[10,20],0,6,"center",true),{strokes:[[[12,14],[12,20],[8,20]]],unsupported:0});
assert.deepEqual(F.strokeText("漢😀",[0,0],0,6),{...F.strokeText("??",[0,0],0,6),unsupported:2});

// ---- ZIP ------------------------------------------------------------------
assert.equal(Z.crc32(Z.utf8("123456789")),0xcbf43926);
assert.deepEqual(Array.from(Z.utf8("Aü€😀")),[0x41,0xc3,0xbc,0xe2,0x82,0xac,0xf0,0x9f,0x98,0x80]);
{
  const payload=new Uint8Array([0,1,2,255]);
  const zip=Z.create([{name:"a.txt",data:"hello\n"},{name:"dir\\ü.bin",data:payload},{name:"empty.txt",data:""}],{date});
  const v=new DataView(zip.buffer,zip.byteOffset,zip.byteLength),end=zip.length-22;
  assert.equal(v.getUint32(end,true),0x06054b50);
  assert.equal(v.getUint16(end+8,true),3);assert.equal(v.getUint16(end+10,true),3);
  let cd=v.getUint32(end+16,true);assert.equal(cd+v.getUint32(end+12,true),end);
  const names=[];
  for(let n=0;n<3;n++){
    assert.equal(v.getUint32(cd,true),0x02014b50);
    assert.equal(v.getUint16(cd+8,true)&0x800,0x800);assert.equal(v.getUint16(cd+10,true),0);
    const crc=v.getUint32(cd+16,true),size=v.getUint32(cd+20,true),nameLength=v.getUint16(cd+28,true),local=v.getUint32(cd+42,true);
    assert.equal(size,v.getUint32(cd+24,true));
    const name=new TextDecoder().decode(zip.subarray(cd+46,cd+46+nameLength));names.push(name);
    assert.equal(v.getUint32(local,true),0x04034b50);assert.equal(v.getUint32(local+14,true),crc);
    const start=local+30+v.getUint16(local+26,true)+v.getUint16(local+28,true),data=zip.subarray(start,start+size);
    assert.equal(Z.crc32(data),crc);
    if(name==="a.txt")assert.equal(new TextDecoder().decode(data),"hello\n");
    if(name==="dir/ü.bin")assert.deepEqual(Array.from(data),[0,1,2,255]);
    const time=v.getUint16(cd+12,true),day=v.getUint16(cd+14,true);
    assert.deepEqual([(day>>9)+1980,(day>>5)&15,day&31,time>>11,(time>>5)&63],[2026,11,18,10,30]);
    cd+=46+nameLength;
  }
  assert.deepEqual(names,["a.txt","dir/ü.bin","empty.txt"]);
  assert.throws(()=>Z.create([{name:"x",data:"1"},{name:"x",data:"2"}]),/Duplicate/);
  assert.throws(()=>Z.create([{name:"../x",data:"1"}]),/Invalid/);
  assert.throws(()=>Z.create([{name:"x",data:5}]),/string or Uint8Array/);
}

// Check grammar separately from decoding artwork and tool geometry.
function readFilm(text){
  assert.deepEqual(checkGerber(text,{legacy:true}).issues,[]);
  const film=parseGerber(text);
  assert.deepEqual(film.warnings,[]);
  assert.ok(film.draws.every(d=>d.ap?.type==="C"),"draws use circular apertures");
  return film;
}
function readDrill(text){
  const commands=text.split(/\r?\n/).filter(l=>l&&!l.startsWith(";"));
  const divider=commands.indexOf("%"),unit=commands.findIndex(l=>/^(METRIC|INCH)(?:,|$)/.test(l));
  assert.equal(commands[0],"M48");assert.equal(commands.indexOf("M30"),commands.length-1);
  assert.ok(unit>0&&unit<divider,"drill units are declared in the header");
  assert.ok(!commands.slice(1,divider).some(l=>/^(?:[XY]|T\d+$)/.test(l)),"drill coordinates and tool selections follow the header");
  assert.ok(!commands.slice(divider+1).some(l=>/^T\d+C/.test(l)),"tools must be declared in the header");
  const drill=parseExcellon(text);
  assert.deepEqual(drill.warnings,[]);
  return drill;
}

// ---- Sample board -----------------------------------------------------------
const project=AtriumParts.example(),doc=project.documents[1],defs=new Map(project.library.map(d=>[d.id,d]));
const frozen=JSON.stringify(project),result=F.build(project,doc,{date});
assert.equal(JSON.stringify(project),frozen,"outputs never modify the design");
assert.deepEqual(result.files.map(f=>f.name),["Sensor board.GTL","Sensor board.GBL","Sensor board.GTO","Sensor board.GTS","Sensor board.GBS","Sensor board.GTP","Sensor board.GM1",
  "Sensor board-Plated.TXT","Sensor board-NonPlated.TXT","Sensor board.GD1","Sensor board-DrillReport.txt","Pick Place for Sensor board.csv","Sensor board-Assembly-Top.svg","Sensor board-Fabrication-Readme.txt"]);
assert.deepEqual(result.warnings,[]);
assert.equal(F.build(project,doc.id,{date}).files.map(f=>f.content).join(),result.files.map(f=>f.content).join(),"deterministic for a fixed date");

// Job-owned data can serve both placement styles and every NC output. A print
// unit change must rebuild the tools, while origin and format only affect writing.
{
  const model = result.model, prepared = F.createPreparation(), group = F.drillGroups(model)[0];
  const metric = {date,drillUnits:"mm"}, inch = {date,units:"in",drillUnits:"in",drillFormat:"2:5",origin:"absolute"};
  const footprintRows = prepared.placements(model), films = prepared.catalogue(model), tools = prepared.tools(group,metric);
  assert.equal(prepared.catalogue(model),films);
  assert.equal(prepared.placements(model),footprintRows);
  assert.equal(prepared.tools(group,{...metric,drillFormat:"3:3",origin:"absolute"}),tools);
  assert.notEqual(prepared.tools(group,inch),tools);
  assert.deepEqual(prepared.tools(group,inch),F.drillTools(group,inch));
  for (const options of [{...metric,pnpStyle:"jlc"},{...inch,pnpStyle:"altium",pnpUnits:"mil"}]) {
    const shared = F.plan(model,options,undefined,prepared), fresh = F.plan(model,options);
    assert.deepEqual(shared,fresh);
    assert.deepEqual(shared.files.map(f=>F.generate(model,shared,f,prepared)),fresh.files.map(f=>F.generate(model,fresh,f)));
  }
}

const file=suffix=>result.files.find(f=>f.name.endsWith(suffix)).content;
const parts=doc.items.filter(i=>i.kind==="part"),vias=doc.items.filter(i=>i.kind==="via");
let smd=0,th=0;for(const p of parts)for(const pad of defs.get(p.def).footprint.pads)pad.drill>0?th++:smd++;
const holes=doc.items.filter(i=>i.kind==="pad"&&i.drill>0).length;
assert.deepEqual([smd,th,vias.length,holes],[13,5,5,4]);
const gtl=readFilm(file(".GTL")),gbl=readFilm(file(".GBL")),gts=readFilm(file(".GTS")),gbs=readFilm(file(".GBS")),gtp=readFilm(file(".GTP")),gto=readFilm(file(".GTO")),gm1=readFilm(file(".GM1"));
assert.deepEqual([gtl,gbl,gts,gtp,gto,gm1].map(f=>f.attributes.file[".FileFunction"]),["Copper,L1,Top","Copper,L2,Bot","Soldermask,Top","Paste,Top","Legend,Top","Profile,NP"]);
assert.equal(gts.attributes.file[".FilePolarity"],"Negative");assert.equal(gtl.attributes.file[".FilePolarity"],"Positive");
assert.deepEqual(gtl.format.x,[4,6]);assert.equal(gtl.units,"mm");
assert.equal(gtl.flashes.length,smd+th+vias.length);
assert.equal(gbl.flashes.length,th+vias.length);
assert.equal(gts.flashes.length,smd+th+holes,"vias are tented by default; mounting holes get openings");
assert.equal(gbs.flashes.length,th+holes);
assert.equal(gtp.flashes.length,smd);
const functions=[...gtl.flashes,...gtl.draws].map(f=>f.ap?.fn);
for(const fn of ["SMDPad,CuDef","ViaPad","ComponentPad","Conductor"])assert.ok(functions.includes(fn),fn);
assert.ok(gto.drawCount>200,"designators and silk text are stroked");
assert.equal(gm1.drawCount,8);
// Coordinates: lower-left corner of the outline is the origin, Y up.
const box=A.bounds(doc.outline);
for(const v of vias)assert.ok(gtl.flashes.some(f=>f.x===Math.round((v.x-box[0])*1e6)/1e6&&f.y===Math.round((box[3]-v.y)*1e6)/1e6&&f.ap.type==="C"&&f.ap.params[0]===v.diameter));
const plated=readDrill(file("-Plated.TXT")),npth=readDrill(file("-NonPlated.TXT"));
assert.equal(plated.hits.length,th+vias.length);assert.equal(npth.hits.length,holes);
assert.deepEqual(Object.values(plated.tools).map(t=>t.d),[.4,1]);assert.deepEqual(Object.values(npth.tools).map(t=>t.d),[2.4]);
for(const v of vias)assert.ok(plated.hits.some(h=>Math.abs(h.x-(v.x-box[0]))<1e-4&&Math.abs(h.y-(box[3]-v.y))<1e-4&&h.d===v.drill));
assert.match(file("-Plated.TXT"),/TF\.FileFunction,Plated,1,2,PTH/);assert.match(file("-NonPlated.TXT"),/TF\.FileFunction,NonPlated,1,2,NPTH/);

// Drill Drawing keeps the exact profile wherever the plot grid can encode it.
{
  require(require("../support/app-source-paths.cjs").appFile("board-shape.js"));
  const S=AtriumBoardShape, p=A.project("Drill profile",[]), board=p.documents.find(d=>d.kind==="pcb");
  const shape=S.rect({x:0,y:10,width:10,height:10,corners:{bl:{style:"radius",size:1}}});
  // The full circle starts on a rounding tie. The second cutout reaches a
  // different grid coordinate between its coincident quantized endpoints.
  const c=[3.00037,.01], r=.00015, x=c[0]+r/2, dy=r*Math.sqrt(3)/2;
  shape.cutouts=[
    [{kind:"arc",c:[.0005,.0001],r:.0001,start:1530,end:1530,ccw:false}],
    [{kind:"arc",c,r,start:-60,end:60,ccw:true},{kind:"line",a:[x,c[1]-dy],b:[x,c[1]+dy]}]
  ];
  S.apply(board,shape);
  board.items=[{kind:"via",id:"hole",x:3,y:3,diameter:1,drill:.5,layer:"Multi"}];
  const drawing=format=>F.build(p,board,{date,format,origin:"absolute"}).files.find(f=>f.kind==="drillmap").content;
  const fine=drawing("4:6"), coarse=drawing("4:3");
  assert.equal(readFilm(fine).draws.filter(d=>d.arc).length,3);
  assert.match(fine,/^G02X500Y0I0J-100D01\*/m,"the tiny cutout plots as an exact 0.0001 mm arc");
  assert.equal(readFilm(coarse).draws.filter(d=>d.arc).length,1);
  const lines=coarse.split("\n"), start=lines.indexOf("X1Y0D02*");
  assert.ok(start>=0,"the grid collapse still plots the cutout");
  assert.equal(lines[start+1],"X0Y0D01*","the fallback preserves one grid edge");
  assert.notEqual(lines[start+2],"X1Y0D01*","legacy rounding adds no spurious return edge");
  assert.match(coarse,/X3000Y-10D02\*\nX3001Y-10D01\*\nX3000Y-10D01\*/,
    "the fallback retains the interior of a curve with coincident plot endpoints");
}

// The golden CSV covers the complete header. Check placement against the source board here.
const pnp=file(".csv").split("\r\n"),header=pnp.findIndex(l=>l.startsWith("\"Designator\""));
const rows=pnp.slice(header+1).filter(Boolean);
assert.equal(rows.length,parts.length);
const c1=parts.find(p=>p.ref==="C1");
assert.equal(rows.find(r=>r.startsWith('"C1"')),'"C1","10 nF","TopLayer","C_0603","'+(c1.x-box[0]).toFixed(4)+'","'+(box[3]-c1.y).toFixed(4)+'","270","Capacitor"');
// Assembly drawing and readme
const svg=file("Assembly-Top.svg");
assert.match(svg,/^<\?xml/);assert.equal((svg.match(/<text /g)||[]).length,parts.length+2);
for(const p of parts)assert.ok(svg.includes(">"+p.ref+"</text>"));
assert.match(file("Readme.txt"),/Sensor board\.GTL/);
// ZIP
const zip=F.zip(result);assert.equal(new DataView(zip.buffer).getUint16(zip.length-12,true),result.files.length);

// ---- Options --------------------------------------------------------------
{
  const r=F.build(project,doc,{date,units:"in",format:"2:5",drillUnits:"in",drillFormat:"2:4",pnpUnits:"mil",tentVias:false,maskExpansion:.2,layers:{GTO:false,GKO:true}});
  const names=r.files.map(f=>f.name);
  assert.ok(!names.includes("Sensor board.GTO")&&names.includes("Sensor board.GKO"));
  const top=readFilm(r.files.find(f=>f.name.endsWith(".GTL")).content),mask=readFilm(r.files.find(f=>f.name.endsWith(".GTS")).content);
  assert.equal(top.units,"in");assert.deepEqual(top.format.x,[2,5]);
  assert.equal(mask.flashes.length,smd+th+holes+vias.length,"untented vias have openings");
  const via=mask.flashes.find(f=>f.ap.type==="C"&&Math.abs(f.ap.params[0]-(.84+.4)/25.4)<1e-6);assert.ok(via,"via opening uses the mask expansion");
  const drill=r.files.find(f=>f.name.endsWith("-Plated.TXT")).content;
  assert.match(drill,/^INCH,LZ,00\.0000$/m);assert.match(drill,/^X\d{6}Y\d{6}$/m);
  assert.match(r.files.find(f=>f.kind==="pnp").content,/"Center-X\(mil\)","Center-Y\(mil\)"/);
  assert.throws(()=>F.build(project,doc,{maskExpansion:NaN}),/Expansions/);
  assert.throws(()=>F.build(project,project.documents[0]),/PCB layout/);
}

// ---- Synthetic board: rotated pad shapes, inner layers, blind vias, pours, bottom side ----
function region(layer,net,rings){
  const unit=.00000254,size=rings.reduce((s,r)=>s+4+16*r.length,0),v=new DataView(new ArrayBuffer(size));let o=0;
  for(const r of rings){v.setUint32(o,r.length,true);o+=4;for(const [x,y] of r){v.setFloat64(o,x/unit,true);v.setFloat64(o+8,-y/unit,true);o+=16;}}
  let s="";for(const b of new Uint8Array(v.buffer))s+=String.fromCharCode(b);
  const xs=rings[0].map(p=>p[0]),ys=rings[0].map(p=>p[1]);
  return {layer,net,bounds:[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)],count:rings.length,data:btoa(s)};
}
const sq=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
const s=A.project("Stress",[]),board=s.documents[1];board.name="Stress";board.outline=[[0,0],[40,0],[40,30],[0,30]];
const zoo=[];["rect","roundrect","octagon","round","ellipse"].forEach((shape,i)=>[0,30,90].forEach((angle,j)=>zoo.push({number:String(i*3+j+1),x:i*3,y:j*3,w:2.2,h:1.1,drill:0,shape,angle})));
s.library.push({id:"zoo",name:"Zoo",footprint:{name:"Zoo",pads:zoo,shapes:[]}});
s.library.push({id:"bot",name:"Bot",footprint:{name:"SOIC",pads:[{number:"1",x:-2,y:0,w:1.5,h:.6,drill:0,shape:"rect",angle:0}],shapes:[{kind:"path",points:[[-1,-1],[1,-1],[1,1],[-1,1]],closed:true,style:"package"}]}});
board.items.push({id:"z",kind:"part",def:"zoo",ref:"Z1",value:"Zoo",x:8,y:4,angle:15,pinNets:{}});
board.items.push({id:"b",kind:"part",def:"bot",ref:"U9",value:"Bottom",x:30,y:24,angle:90,layer:"Bottom",pinNets:{},sourceRecord:"components6/data#0"});
board.pcbDrawing={annotations:{"components6/data#0":[{field:"ref",at:[-1,-2],angle:0,size:1,layer:"Bottom silk",mirrored:true}]},
  pours:[region("Top","GND",[sq(20,20,39,29),sq(22,22,30,27)]),region("Top","GND",[sq(24,23,27,25)])]};
board.items.push({id:"t",kind:"track",layer:"Inner 1",net:"A",width:.25,points:[[25,4],[35,4]]});
board.items.push({id:"v1",kind:"via",x:25,y:4,diameter:.6,drill:.3,net:"A",fromLayer:"Top",toLayer:"Inner 1"});
board.items.push({id:"v2",kind:"via",x:25,y:6,diameter:.6,drill:.3,net:"A",fromLayer:"Inner 1",toLayer:"Inner 2"});
board.items.push({id:"l",kind:"label",text:"漢1",x:24,y:14,size:1,layer:"Silk"});
const sdefs=new Map(s.library.map(d=>[d.id,d]));board.sourcePourSignature=AtriumPCBPours.signature(board,sdefs);
assert.equal(F.pourStatus(board,sdefs),"current");
const out=F.build(s,board,{date}),get=suffix=>out.files.find(f=>f.name.endsWith(suffix))?.content;
assert.deepEqual(out.files.filter(f=>f.kind==="gerber").map(f=>f.name.split(".").pop()),["GTL","G1","G2","GBL","GTO","GBO","GTS","GBS","GTP","GBP","GM1"]);
assert.deepEqual(out.files.filter(f=>f.kind==="drill").map(f=>f.name),["Stress-Plated-TOP-IN1.TXT","Stress-Plated-IN1-IN2.TXT"]);
assert.match(get("TOP-IN1.TXT"),/Plated,1,2,Blind/);assert.match(get("IN1-IN2.TXT"),/Plated,2,3,Buried/);
const st=readFilm(get(".GTL"));
assert.equal(st.flashes.length,zoo.length+1,"pads plus the blind via");
assert.equal(st.regionCount,3);assert.deepEqual(st.regions.map(r=>r.dark),[true,false,true],"pour holes are cleared before other copper");
assert.ok(st.flashes.filter(f=>/^ATR/.test(f.ap.name)).length>=10,"rotated and rounded pads use aperture macros");
assert.equal(readFilm(get(".G1")).flashes.length,2);assert.equal(readFilm(get(".G2")).flashes.length,1);assert.equal(readFilm(get(".GBL")).flashes.length,1,"only the bottom-side SMD pad");
assert.equal(readFilm(get(".GBP")).flashes.length,1);
assert.ok(out.warnings.some(w=>/missing from the stroke font/.test(w)));
assert.ok(get("Assembly-Bottom.svg").includes(">U9</text>"));
// Mirrored bottom text runs right to left from its anchor (viewed from the top).
const mirrored=F.strokeText("AB",[10,10],0,1,"left",true).strokes.flat(),plain=F.strokeText("AB",[10,10],0,1,"left",false).strokes.flat();
assert.ok(Math.max(...mirrored.map(p=>p[0]))<=10+1e-9&&Math.min(...plain.map(p=>p[0]))>=10-1e-9);
assert.ok(Math.min(...plain.map(p=>p[1]))<10&&Math.max(...plain.map(p=>p[1]))<=10+1e-9,"glyphs rise above the baseline (model Y down)");
assert.match(get("Readme.txt"),/Imported copper: 2 regions without an editable pour, plotted as stored in the imported design \(the board is unchanged since import\)/);
// Imported artwork without an editable pour cannot be filled again: after a board edit it is still
// plotted exactly as stored (never left out), and the warnings and readme say which data was used.
board.items.find(i=>i.id==="v1").x=25.5;
const stale=F.build(s,board,{date});
assert.equal(readFilm(stale.files.find(f=>f.name.endsWith(".GTL")).content).regionCount,3,"imported regions are plotted as stored");
assert.ok(stale.warnings.some(w=>/2 imported copper regions without an editable pour are plotted as stored.*changed since import/.test(w)),stale.warnings.join("\n"));
assert.match(stale.files.find(f=>f.name.endsWith("Readme.txt")).content,/plotted as stored in the imported design \(the board has changed since import\)/);
// Expansion keeps rounded and octagonal geometry offset by the same distance.
const g=F.expandPad(F.padGeom("octagon",2,1,0),.1);assert.ok(Math.abs(g.t-(.25+.1*(2-Math.SQRT2)))<1e-12&&Math.abs(g.w-2.2)<1e-12);
assert.equal(F.expandPad(F.padGeom("rect",.1,.1,0),-.1),null);
// File names (newcomer review F16): the dialog names files after the project, not "Board layout".
{
  const one={name:"My sensör board!",documents:[{kind:"schematic",name:"Schematic"},{kind:"pcb",name:"Board layout"}]};
  assert.equal(F.defaultStem(one,one.documents[1]),"My-sensor-board");
  const two={name:"Kit",documents:[{kind:"pcb",name:"Main board"},{kind:"pcb",name:"Daughter"}]};
  assert.equal(F.defaultStem(two,two.documents[1]),"Kit-Daughter");
}
console.log("fab-outputs: ok");
