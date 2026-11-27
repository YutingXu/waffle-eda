"use strict";
// Library core: pin tables, symbol quick-create, validation, footprint checks, pad arrays,
// renumbering, usage guards, search and "Update parts from library".
const assert=require("node:assert/strict");
for(const m of ["model","parts","library-store","library-panel","footprint-wizard","footprint-editor","symbol-editor"])require(require("../support/app-source-paths.cjs").appFile(m));
const L=AtriumLibrary,F=AtriumFootprintEditor,A=Atrium;
{
  // The wizard's preview and the editor selection read the real land, including outside the rectangle.
  const {F5,landContacts}=require("../support/a1-geometry.cjs");
  for(const {shape,poly,point,inside} of landContacts){
    const p={x:-2,y:3,angle:90,w:F5.w,h:F5.h,shape,poly,roundrectRadiusRatio:F5.radiusRatio};
    const [x,y]=point;
    assert.equal(F.padContains(p,[-2-y,3+x]),inside,shape+" authoring hit");
  }
}

{
  // Spreadsheet paste with a header, multi-number cells and type words.
  const rows=L.pinsFromTable("Pin\tName\tType\n1\tVDD\tPower\n2\tPA0\tI/O\n3\tPA1\tio\n4\tNRST\tinput\n5, 10\tGND\tpower\n6\tTX\toutput\n7\tSDA\topen drain");
  assert.deepEqual(rows.map(r=>r.number),["1","2","3","4","5","10","6","7"]);
  assert.deepEqual(rows.map(r=>r.electrical),[7,1,1,0,7,7,2,3]);
  // Header-less CSV with quotes; name-first lists; single column numbers itself.
  const csv=L.pinsFromTable('1,"OUT, A",out\n2,IN-,in\n3,IN+,in');assert.equal(csv[0].name,"OUT, A");assert.equal(csv[1].electrical,0);
  assert.deepEqual(L.pinsFromTable("VDD,1\nGND,2").map(r=>[r.number,r.name]),[["1","VDD"],["2","GND"]]);
  assert.deepEqual(L.pinsFromTable("EN\nFB\nSW").map(r=>r.number),["1","2","3"]);
  assert.equal(L.pinsFromTable("Number;Name;Side\n1;CLK;right")[0].side,"right");
  // Inference without a type column.
  assert.deepEqual(["VCC","AGND","RESET","INT","PB3","NC"].map(n=>L.inferElectrical(n)),[7,7,0,2,1,4]);
  console.log("PASS pin tables: TSV/CSV/semicolon, headers, multi-pin cells, type words and inference");
}
{
  // Quick-create: power top, ground bottom, inputs left, outputs right, buses in order, on grid.
  const text=["1\tVDD\tpower","2\tGND\tpower","3\tD3\tio","4\tD0\tio","5\tD1\tio","6\tD2\tio","7\tCLK\tinput","8\tEN\tinput","9\tOUT\toutput","10\tINT\toutput","11\tNC\tpassive"].join("\n");
  const model=L.symbolFromPins(L.pinsFromTable(text)),by=n=>model.pins.find(p=>p.name===n);
  assert.equal(by("VDD").orientation,"up");assert.equal(by("GND").orientation,"down");
  assert.equal(by("CLK").orientation,"left");assert.equal(by("OUT").orientation,"right");
  const bus=["D0","D1","D2","D3"].map(by);assert.ok(bus.every(p=>p.orientation===bus[0].orientation),"bus on one side");
  assert.ok(bus.every((p,i)=>!i||p.y>bus[i-1].y),"bus in index order");
  for(const p of model.pins)for(const v of [p.x,p.y])assert.ok(Math.abs(v/2.54-Math.round(v/2.54))<1e-6,"pin "+p.name+" on 2.54 grid");
  const {symbol,schDrawing}=L.buildSymbol(model);
  assert.equal(symbol.pins.length,11);assert.equal(schDrawing.pins.length,11);
  assert.ok(symbol.shapes.filter(s=>s.style==="pin").every(s=>symbol.pins.some(p=>A.same(s.points[0],[p.x,p.y]))),"pin lines start at the tips");
  const def={id:"u",name:"MCU",prefix:"U",symbol,schDrawing};assert.ok(L.validateDef(def).ok);
  // Round trip through the editor model keeps orientation and length.
  const back=L.symbolModel(symbol);assert.deepEqual(back.pins.map(p=>p.orientation),model.pins.map(p=>p.orientation));
  assert.equal(back.shapes.filter(s=>s.style==="pin").length,0);
  // Hidden, inverted and clock pins.
  const deco=L.buildSymbol({pins:[{number:"1",name:"CK",x:-7.62,y:0,orientation:"left",length:5.08,clock:true,inverted:true},{number:"2",name:"VCC",x:0,y:0,orientation:"up",length:2.54,hidden:true}],shapes:[]});
  assert.ok(deco.symbol.shapes.some(s=>s.kind==="circle"));assert.equal(deco.schDrawing.pins.length,1);assert.ok(deco.symbol.pins[1].hidden);
  // Imported/catalogue symbols without orientation infer it from their pin lines.
  const op=AtriumParts.catalogue.find(d=>d.id==="std-opamp"),m=L.symbolModel(op.symbol);
  assert.equal(m.pins.find(p=>p.number==="1").orientation,"right");assert.equal(m.pins.find(p=>p.number==="5").orientation,"up");
  console.log("PASS symbol quick-create: power/ground/inputs/outputs/buses grouped on grid; decorations; model round-trip");
}
{
  // Multi-gate symbols and De Morgan: the gate filter (Atrium.gate when patched, else the editor's).
  const model={parts:2,alternate:true,pins:[{number:"1",name:"A",x:-7.62,y:0,orientation:"left",part:1},{number:"2",name:"B",x:-7.62,y:0,orientation:"left",part:2},{number:"8",name:"VCC",x:0,y:-7.62,orientation:"up",part:0}],
    shapes:[{kind:"path",points:[[-5,-5],[5,-5],[5,5]],part:1,alt:false},{kind:"circle",x:0,y:0,r:1,part:1,alt:true},{kind:"path",points:[[0,0],[1,1]],part:2}]};
  const {symbol,schDrawing}=L.buildSymbol(model);assert.equal(symbol.parts,2);assert.equal(schDrawing,null);
  const g1=AtriumSymbolEditor.filterGate(symbol,1,false),g2=AtriumSymbolEditor.filterGate(symbol,2,false),g1alt=AtriumSymbolEditor.filterGate(symbol,1,true);
  assert.deepEqual(g1.pins.map(p=>p.number),["1","8"]);assert.deepEqual(g2.pins.map(p=>p.number),["2","8"]);
  assert.ok(g1.shapes.some(s=>s.kind==="path"&&s.points.length===3)&&!g1.shapes.some(s=>s.kind==="circle"));
  assert.ok(g1alt.shapes.some(s=>s.kind==="circle")&&!g1alt.shapes.some(s=>s.points?.length===3));
  assert.ok(g1.shapes.some(s=>s.kind==="text"&&s.text==="A")&&!g1.shapes.some(s=>s.kind==="text"&&s.text==="B"),"gate-tagged pin text");
  if(A.gate){const item={x:0,y:0,part:2};assert.deepEqual(A.pins(item,{symbol},"schematic").map(p=>p.number),["2","8"]);assert.deepEqual(A.pins({x:0,y:0},{symbol},"schematic").map(p=>p.number),["1","8"]);}
  assert.ok(L.validateDef({id:"g",name:"Dual",symbol}).ok);
  console.log("PASS gates and De Morgan: per-gate pins, shared power pins, view-specific body art"+(A.gate?" (Atrium.gate active)":""));
}
{
  // Footprint DRC-lite.
  const pad=(n,x,y,o={})=>({number:String(n),x,y,w:1,h:.6,shape:"rect",drill:0,...o});
  const fp={pads:[pad(1,-2,0),pad(2,0,0),pad(4,2,0),pad(4,2,3)],shapes:[{kind:"path",style:"silk",points:[[-3,0],[3,0]]}]};
  const codes=L.checkFootprint(fp).map(x=>x.code);
  for(const c of ["gap","duplicate","silk-pad","courtyard"])assert.ok(codes.includes(c),c+" in "+codes);
  fp.pads[1].pasteExpansion=-.5;fp.pads[2].maskExpansion=.5;fp.pads.push(pad(5,-2,.3));
  const more=L.checkFootprint(fp).map(x=>x.code);for(const c of ["paste","mask","short"])assert.ok(more.includes(c),c);
  const th=L.checkFootprint({pads:[pad(1,0,0,{drill:.6,w:.6,h:.6})],shapes:[]});assert.ok(th.some(x=>x.code==="annular"&&x.level==="error"));
  // Overlapping pads that share a number (a split land) are not duplicates.
  assert.ok(!L.checkFootprint({pads:[pad(1,0,0),pad(1,.5,0)],shapes:[]}).some(x=>x.code==="duplicate"));
  console.log("PASS footprint checks: numbering gaps/duplicates, silk over pad, courtyard, paste, mask, shorts, annular ring");
}
{
  // Pad arrays and numbering.
  const t={number:"1",x:0,y:0,w:1,h:.5,shape:"roundrect",drill:0};
  const lin=F.padArray(t,{type:"linear",count:5,dx:0,dy:1.27,start:"3"});assert.deepEqual(lin.map(p=>p.number),["3","4","5","6","7"]);assert.equal(lin[4].y,5.08);
  const circ=F.padArray(t,{type:"circular",count:8,radius:2,cx:0,cy:0,startAngle:0});assert.equal(circ.length,8);assert.ok(Math.abs(Math.hypot(circ[3].x,circ[3].y)-2)<1e-6);assert.equal(circ[2].angle,90);
  const grid=F.padArray(t,{type:"grid",rows:3,cols:2,pitchX:1,pitchY:1,order:"alpha"});assert.deepEqual(grid.map(p=>p.number),["A1","A2","B1","B2","C1","C2"]);
  const snake=F.padArray(t,{type:"grid",rows:2,cols:3,pitchX:1,order:"snake"});assert.deepEqual(snake.map(p=>[p.number,p.x,p.y]),[["1",0,0],["2",1,0],["3",2,0],["4",2,1],["5",1,1],["6",0,1]]);
  assert.equal(F.incrementNumber("A9"),"A10");assert.equal(F.incrementNumber("09"),"10");assert.equal(F.incrementNumber("7",2),"9");
  assert.equal(F.nextNumber([{number:"1"},{number:"7"}]),"8");assert.equal(F.nextNumber([{number:"A1"},{number:"A2"}]),"A3");
  const pads=[{number:"x"},{number:"y"},{number:"z"}];F.renumber(pads,[2,0,1],{start:"1"});assert.deepEqual(pads.map(p=>p.number),["2","3","1"]);
  assert.deepEqual(F.layerShape("courtyard"),{width:.05,style:"courtyard",layer:"Mechanical 15"});assert.equal(F.layerKey({layer:"Mechanical 13"}),"assembly");
  console.log("PASS pad arrays (linear, circular with rotation, grid rows/snake/BGA), numbering and click-order renumber");
}
{
  // Project operations: usage guard, duplicate, update parts (wires follow pins), search.
  const p=A.project("Lib",AtriumParts.catalogue),sch=p.documents[0],r=p.library.find(d=>d.id==="std-r");
  const part=A.instantiate(p,r,[10,10]);sch.items.push(part);
  const pins=A.pins(part,r,"schematic");
  sch.items.push({id:"w1",kind:"wire",points:[pins[1].at,[pins[1].at[0]+10,pins[1].at[1]]]});
  assert.throws(()=>L.remove(p,"std-r"),/placed 1 time.*R1/);
  const copy=L.duplicate(p,r);assert.equal(copy.name,"Resistor copy");assert.notEqual(copy.id,r.id);L.remove(p,copy.id);assert.ok(!p.library.includes(copy));
  // Lengthen pin 2 by 2.54 mm: the wire end follows with an orthogonal elbow.
  const edited=JSON.parse(JSON.stringify(r));edited.symbol.pins[1].x+=2.54;edited.value="22 kΩ";part.value=r.value;
  const report=L.replaceDef(p,edited);assert.equal(report.parts,1);assert.equal(report.rewired,1);assert.equal(report.values,1);
  const w=sch.items.find(i=>i.id==="w1"),tip=A.pins(part,edited,"schematic")[1].at;assert.ok(A.same(w.points[0],tip));assert.equal(part.value,"22 kΩ");
  // An older copy's parts are retargeted, stale pin nets dropped.
  const old=L.duplicate(p,edited);old.name="Resistor";old.sourceName=edited.sourceName="Resistor.SchLib";const q=A.instantiate(p,old,[30,10]);q.pinNets={"1":"A","9":"B"};p.documents[1].items.push({...q,id:"b1",x:5,y:5});
  const sim=L.similar(p,edited);assert.deepEqual(sim.map(d=>d.id),[old.id]);
  const rr=L.updateParts(p,edited,{sources:[old.id]});assert.equal(rr.retargeted,1);assert.equal(rr.dropped,1);assert.equal(p.documents[1].items.find(i=>i.id==="b1").def,edited.id);
  assert.deepEqual(A.validate(JSON.parse(JSON.stringify(p))),JSON.parse(JSON.stringify(p)));
  // Search syntax.
  const names=q=>L.search(p.library,q).map(d=>d.id).sort();
  assert.deepEqual(names("prefix:J"),["std-j2","std-j3"]);assert.deepEqual(names("pins>4 has:footprint"),["std-opamp"]);assert.deepEqual(names("sot-23"),["std-opamp"]);
  assert.ok(names("pkg:0603").includes("std-r"));
  // Without the catalogue loaded, pkg: also reads def.package and a Package parameter (the catalogue's package), value: a Value parameter.
  assert.equal(globalThis.AtriumCatalogue,undefined,"this block tests the fallback matcher");
  const qfnFp={name:"MCU_FP",pads:[{number:"1",x:0,y:0,w:.3,h:.8}],shapes:[]};
  const pk=[{id:"q",name:"MCU",prefix:"U",value:"",package:"QFN-32",footprint:qfnFp},{id:"s",name:"Reg",prefix:"U",value:"",parameters:{Package:"SOT-223",Value:"3.3 V"},footprint:qfnFp}];
  const pkn=q=>L.search(pk,q).map(d=>d.id);
  assert.deepEqual(pkn("pkg:qfn"),["q"]);assert.deepEqual(pkn("package:qfn-32"),["q"]);assert.deepEqual(pkn("fp:sot-223"),["s"]);
  assert.deepEqual(pkn("footprint:mcu_fp"),["q","s"],"the footprint name still counts");assert.deepEqual(pkn("value:3.3"),["s"]);assert.deepEqual(pkn("val:3.3"),["s"]);
  // validateDef catches model errors and pin/pad mismatches.
  assert.ok(!L.validateDef({id:"x",name:"",symbol:{pins:[],shapes:[]}}).ok);
  assert.ok(!L.validateDef({id:"x",name:"Bad",footprint:{pads:[{number:"1",x:0,y:0,w:0,h:1}],shapes:[]}}).ok);
  const mis=L.validateDef({id:"x",name:"M",symbol:{pins:[{number:"1",x:0,y:0},{number:"2",x:2.54,y:0}],shapes:[]},footprint:{pads:[{number:"1",x:0,y:0,w:1,h:1}],shapes:[]}});
  assert.ok(mis.warnings.some(w=>/Pins without a pad: 2/.test(w)));
  console.log("PASS library operations: delete guard, duplicate, update parts (wires follow, values, retarget, stale nets), search, validation");
}
{
  // Special strings and gates on placed parts (active once model.js carries the library patch).
  if(A.special){
    const t={kind:"text",text:".Designator",x:0,y:0};assert.equal(A.special(t,{ref:"U7"}).text,"U7");assert.equal(A.special({...t,text:".Comment"},{value:"10k"}).text,"10k");
    assert.equal(A.special(t,{ref:""}),t);assert.equal(A.special({kind:"path",points:[[0,0]]},{ref:"U1"}).kind,"path");
    console.log("PASS .Designator / .Comment special strings resolve on placed parts");
  }
}
{
  // MCP entry points: create_footprint / create_symbol run headlessly on a project.
  const p=A.project("Mcp",AtriumParts.catalogue);
  const fp=L.createFootprint(p,{family:"gullwing",preset:"SOIC-8",density:"B",prefix:"U",value:"LM358"});
  assert.equal(fp.def.footprint.name,"SOIC127P600X175-8N");assert.ok(p.library.includes(fp.def));assert.ok(fp.report.added);
  assert.equal(fp.def.symbol.pins.length,8,"box symbol from pads");
  const raw=L.createFootprint(p,{name:"Pad pair",footprint:{pads:[{number:1,x:-1,y:0,w:1,h:1},{number:2,x:1,y:0,w:1,h:1}]}});
  assert.deepEqual(raw.def.footprint.pads.map(p=>p.number),["1","2"]);assert.ok(raw.issues.some(i=>i.code==="courtyard"));
  assert.throws(()=>L.createFootprint(p,{footprint:{pads:[{number:"1",x:0,y:0,w:0,h:1}]}}),/size|model/);
  const dims=L.createFootprint(p,{family:"chip",preset:"0805",dims:{kind:"CAP"}});assert.equal(dims.def.footprint.name,"CAPC2012X70N");assert.equal(dims.def.prefix,"C");
  // A dual op amp: two gates plus shared supply pins, with the SOIC-8 footprint.
  const sym=L.createSymbol(p,{name:"Dual op amp",prefix:"U",value:"LM358",gates:2,footprint_def_id:fp.def.id,pins:[
    {number:"1",name:"OUTA",type:"output",part:1},{number:"2",name:"-INA",type:"input",part:1},{number:"3",name:"+INA",type:"input",part:1},
    {number:"7",name:"OUTB",type:"output",part:2},{number:"6",name:"-INB",type:"input",part:2},{number:"5",name:"+INB",type:"input",part:2},
    {number:"8",name:"V+",type:"power",part:0},{number:"4",name:"V-",type:"power",part:0}]});
  const s=sym.def.symbol;assert.equal(s.parts,2);assert.equal(s.pins.filter(x=>x.number==="8").length,1);assert.ok(!(s.pins.find(x=>x.number==="8").part>0),"shared pin");
  assert.ok(L.validateDef(sym.def).ok);assert.deepEqual(L.validateDef(sym.def).warnings,[]);
  const viaText=L.createSymbol(p,{name:"Reg",pins:"1\tVIN\tpower\n2\tGND\tpower\n3\tVOUT\toutput"});assert.equal(viaText.def.symbol.pins.length,3);
  // Re-create over an existing def keeps its id and re-syncs placed parts.
  const placed=A.instantiate(p,viaText.def,[20,20]);p.documents[0].items.push(placed);
  const again=L.createSymbol(p,{def_id:viaText.def.id,pins:"1\tVIN\tpower\n2\tGND\tpower\n3\tVOUT\toutput\n4\tEN\tinput"});
  assert.equal(again.def.id,viaText.def.id);assert.equal(again.report.parts,1);
  console.log("PASS create_footprint / create_symbol (wizard, raw pads, gates with shared power, re-create in place)");
}
{
  // .atrlib library files: round trip, credential scrubbing, diffs, provenance and updates.
  const p=A.project("Libs",[]);const made=L.createFootprint(p,{family:"chip",preset:"0603"}).def;
  made.parameters={MPN:"RC0603",apiKey:"sk-live-123",Supplier:{token:"abc",sku:"311"}};
  const step=require("node:fs").readFileSync(__dirname+"/../fixtures/mcad/tray.step","utf8");
  made.footprint.model3d={file:"/fixture/authoring/tray.step",stepText:step};
  AtriumLibraryStore.hoist(p,made);
  const original=JSON.stringify(made.footprint.model3d);
  const lib={id:"lib1",name:"Passives",description:"Shared parts",defs:[]};
  const first=L.saveToLibrary(lib,made,p);assert.equal(made.libraryRef.library,"lib1");
  assert.deepEqual(first.footprint.model3d,{file:"tray.step",stepText:step});
  assert.equal(JSON.stringify(made.footprint.model3d),original);
  assert.equal(L.libraryStatus(made,[lib],p).state,"current");
  const again=L.saveToLibrary(lib,made,p);
  assert.deepEqual([again.id,again.rev],[first.id,1]);
  assert.deepEqual(again,first);
  const file=L.libraryFile(lib);assert.ok(!/sk-live|apiKey|"token"/.test(file.text),"no secrets written");assert.deepEqual(L.libraryFile({name:"x",defs:[{...made,parameters:{apiKey:"k",S:{token:"t"}}}]},p).removed.sort(),["apiKey","token"]);
  const back=L.readLibraryFile(file.text,"Passives.atrlib");assert.equal(back.name,"Passives");assert.equal(back.defs.length,1);assert.equal(back.defs[0].parameters.Supplier.sku,"311");
  assert.ok(!L.readLibraryFile(JSON.stringify({format:"atrium-library",version:1,defs:[{id:"x",name:"Bad",footprint:{pads:[{number:"1",x:0,y:0,w:-1,h:1}],shapes:[]}}]})).defs.length);
  assert.throws(()=>L.readLibraryFile("{}"),/not a Waffle library/);
  const hostile=L.readLibraryFile(JSON.stringify({format:"atrium-library",version:1,name:"H",defs:[{id:"a",name:"A",password:"x",symbol:{pins:[],shapes:[]}}]}));
  assert.ok(!("password" in hostile.defs[0]));assert.ok(hostile.warnings.some(w=>/credential/.test(w)));
  // Library side changes: status, diff and update keep the project id and re-sync parts.
  const libs=[{...lib,defs:back.defs}];const src=libs[0].defs[0];
  assert.ok(L.libraryStatus(made,libs,p).same);
  src.footprint.pads[0].w=1.1;src.value="10k";
  const st=L.libraryStatus(made,libs,p);assert.ok(st.libraryChanged&&!st.projectChanged&&!st.same);
  const changes=L.diffDefs(made,src);assert.ok(changes.some(c=>/pad 1 size/.test(c))&&changes.some(c=>/^value/.test(c)),changes.join("; "));
  const r=L.updateFromLibrary(p,made,libs[0],src),now=p.library.find(d=>d.id===made.id);assert.equal(now.value,"10k");assert.equal(now.footprint.pads[0].w,1.1);assert.ok(L.libraryStatus(now,libs,p).same);
  void r;
  const copy=L.fromLibrary(libs[0],src,p);assert.notEqual(copy.id,src.id,"ids stay unique in the project");assert.equal(copy.libraryRef.id,src.id);
  assert.equal(L.defHash({...src,id:"other",libraryRef:{x:1}}),L.defHash(src));
  console.log("PASS .atrlib libraries: round trip, no credentials written or read, diffs, provenance, update from library");
}
{
  // One ordered pin-to-pad difference. Import, health, validation and the wizard keep their own
  // collectors: blanks, thermal vias, same-gate duplicates and case are checked on each diagnosis.
  const app = require("../support/app-source-paths.cjs").appFile;
  for (const m of ["sha256", "library-store", "library-import-altium", "library-import-kicad", "symbol-wizard"]) require(app(m));
  const P = AtriumLibraryPairing, S = AtriumLibraryStore, W = AtriumSymbolWizard, Alt = AtriumLibraryImportAltium, Ki = AtriumLibraryImportKiCad;
  assert.deepEqual(P.difference(["1", "2"], ["2", "1"]), {noPad: [], noPin: []}, "positive sibling comparison");
  assert.deepEqual(P.difference(["1", "1", "A1"], ["a1"]), {noPad: ["1", "1", "A1"], noPin: ["a1"]}, "authored duplicate and case stay visible");
  assert.deepEqual(P.difference(["", "1"], ["1"]), {noPad: [""], noPin: []}, "a blank pin stays in noPad");
  assert.deepEqual(P.difference(["1"], ["", "1"]), {noPad: [], noPin: []}, "a blank pad is omitted from noPin");
  function component(name, pins, pads) {
    return {id: "pair-" + name, name,
      symbol: {pins: pins.map((p, n) => ({number: p.number, x: n * 2.54, y: 0, ...(p.part != null ? {part: p.part} : {})})), shapes: []},
      footprint: {pads: pads.map((p, n) => ({number: p.number, x: n * 3, y: 0, w: 1, h: 1, ...(p.extra || {})})), shapes: []}};
  }
  function mismatches(d) {
    const altium = Alt.pair([
      {name: "T.SchLib", library: [{name: d.name, symbol: d.symbol, footprintName: "FP"}]},
      {name: "T.PcbLib", library: [{name: "FP", footprint: {name: "FP", pads: d.footprint.pads}}]}
    ]).report.mismatches;
    const kicad = Ki.join(
      [{def: {id: "s", name: d.name, symbol: d.symbol, source: {}}, footprint: "FP", file: {name: "T.kicad_sym"}}],
      [{def: {id: "f", name: "FP", footprint: {name: "FP", pads: d.footprint.pads}, source: {kind: "kicad-footprint", file: "FP.kicad_mod", entry: "FP"}}, file: {name: "FP.kicad_mod"}}]
    ).report.mismatches;
    assert.deepEqual(kicad, altium, d.name);
    return altium;
  }
  const codes = ["unmapped-pin", "unmapped-pad", "duplicate-pin", "count"];
  const issues = d => S.health([d]).issues.filter(x => codes.includes(x.code)).map(x => x.message);
  function shown(d, o = {footprintWarnings: false}) {
    const r = L.validateDef(d, o);
    return {ok: r.ok, duplicate: r.errors.filter(m => m.includes("appears twice")),
      pairing: r.warnings.filter(m => m.startsWith("Pins without a pad") || m.startsWith("Pads without a pin")),
      footprint: r.warnings.filter(m => m.includes("no number") || m.includes("separate pads"))};
  }
  function wizard(d) {
    const rows = d.symbol.pins.map((p, n) => ({number: String(p.number), base: "N" + p.number, key: "k" + n, row: n, include: true, electrical: 4, nc: false}));
    return W.check(rows, {footprint: {name: "FP", pads: d.footprint.pads}}).filter(x => ["no-pad", "no-pin", "duplicate", "number"].includes(x.code)).map(x => x.code + ":" + x.message);
  }
  const positive = component("positive", [{number: "1"}, {number: "2"}], [{number: "1"}, {number: "2"}]);
  assert.deepEqual(mismatches(positive), [], "positive sibling importers");
  assert.deepEqual(issues(positive), [], "positive sibling health");
  assert.deepEqual(shown(positive), {ok: true, duplicate: [], pairing: [], footprint: []}, "positive sibling validation");
  assert.deepEqual(wizard(positive), [], "positive sibling wizard");
  const dup = component("dup", [{number: "1", part: 1}, {number: "1", part: 1}], [{number: "1"}]);
  assert.deepEqual(mismatches(dup), []);
  assert.deepEqual(issues(dup), ["Pin number 1 appears twice in gate 1."]);
  assert.deepEqual(shown(dup).duplicate, ["Pin number 1 appears twice in gate 1."]);
  assert.deepEqual(shown(dup).pairing, []);
  assert.deepEqual(wizard(dup), ["duplicate:Pin 1 appears 2 times (N1, N1)."]);
  const across = component("across", [{number: "1", part: 1}, {number: "1", part: 2}], [{number: "1"}]);
  assert.deepEqual(mismatches(across), []);
  assert.deepEqual(issues(across), []);
  assert.deepEqual(shown(across), {ok: true, duplicate: [], pairing: [], footprint: []});
  assert.ok(wizard(across).some(x => x.startsWith("duplicate:Pin 1 appears 2 times")), "wizard reports the repeated pin number");
  assert.ok(wizard(across).every(x => !x.startsWith("no-")));
  const authored = component("authored", [{number: "1", part: 1}, {number: "1", part: 1}, {number: "A1"}], [{number: "a1"}]);
  assert.deepEqual(mismatches(authored), [{name: "authored", noPad: ["1", "A1"], noPin: ["a1"]}]);
  assert.deepEqual(issues(authored), ["Pins without a pad: 1, A1.", "Pads without a pin: a1.", "Pin number 1 appears twice in gate 1.", "2 pins but 1 pads."]);
  assert.deepEqual(shown(authored).duplicate, ["Pin number 1 appears twice in gate 1."]);
  assert.deepEqual(shown(authored).pairing, ["Pins without a pad: 1, A1.", "Pads without a pin: a1."]);
  assert.deepEqual(wizard(authored).filter(x => x.startsWith("no-")), ["no-pad:Pins without a pad in FP: 1."]);
  const blankPin = component("blankPin", [{number: ""}, {number: "1"}], [{number: "1"}]);
  assert.deepEqual(mismatches(blankPin), []);
  assert.deepEqual(issues(blankPin), []);
  assert.deepEqual(shown(blankPin).pairing, ["Pins without a pad: ."]);
  assert.ok(wizard(blankPin).some(x => x.startsWith("number:")) && wizard(blankPin).every(x => !x.startsWith("no-")));
  const blankPad = component("blankPad", [{number: "1"}], [{number: ""}, {number: "1"}]);
  assert.deepEqual(mismatches(blankPad), []);
  assert.deepEqual(issues(blankPad), []);
  assert.deepEqual(shown(blankPad).pairing, []);
  assert.deepEqual(wizard(blankPad).filter(x => x.startsWith("no-")), []);
  const exposed = component("exposed", [{number: "1"}], [{number: "1"}, {number: "2"}, {number: "3", extra: {thermalVia: true}}]);
  assert.deepEqual(mismatches(exposed), [{name: "exposed", noPad: [], noPin: ["2"]}]);
  assert.deepEqual(issues(exposed), ["Pads without a pin: 2.", "1 pins but 2 pads."]);
  assert.deepEqual(shown(exposed).pairing, ["Pads without a pin: 2, 3."]);
  assert.deepEqual(wizard(exposed).filter(x => x.startsWith("no-")), ["no-pin:Pads without a pin: 2."]);
  assert.deepEqual(shown(component("separate", [{number: "1"}], [{number: "1"}, {number: "1"}]), {}).footprint, ["Pad number 1 is used by 2 separate pads."]);
  assert.deepEqual(shown(component("copper", [{number: "1"}], [{number: ""}, {number: "1"}]), {}).footprint, ["1 pad(s) have no number."]);
  assert.deepEqual(shown(component("npth", [{number: "1"}], [{number: "1"}, {number: "", extra: {plated: false, drill: 0.5}}]), {}).footprint, []);
  {
  const rows=[
    {number:"1",name:"OUTA",electrical:2,part:1},{number:"2",name:"INA",electrical:0,part:1},
    {number:"7",name:"OUTB",electrical:2,part:2},{number:"6",name:"INB",electrical:0,part:2},
    {number:"8",name:"V+",electrical:7,part:0},{number:"4",name:"V-",electrical:7,part:0}];
  const stored=L.buildSymbol(L.symbolFromGates(rows,2)).symbol;
  const again=L.buildSymbol(L.symbolFromGates(L.pinsFromTable(L.tableFromPins(L.symbolModel(stored).pins,stored.parts)),2)).symbol;
  const nums=unit=>A.pins({x:0,y:0,unit},{symbol:again},"schematic").map(p=>p.number).sort();
  assert.deepEqual(nums(2),["4","6","7","8"]);
  assert.equal(L.pinsFromTable(L.tableFromPins([{...rows[4],part:0}]))[0].part,0);
  assert.equal(L.pinsFromTable("Number\tName\tPart\n1\tIN\t")[0].part,undefined);
}

{
  const symbol={pins:[{number:"1",name:"A",x:0,y:0,orientation:"left",length:2.54,electrical:4}],
    shapes:[{kind:"path",style:"body",points:[[0,0],[0,5.08]]},{kind:"path",style:"body",closed:true,points:[[-2.54,-2.54],[2.54,-2.54],[2.54,2.54],[-2.54,2.54]]}]};
  assert.equal(L.validateDef({id:"g",name:"G",prefix:"U",value:"G",symbol}).ok,true);
  const back=L.buildSymbol(L.symbolModel(symbol)).symbol;
  assert.ok(back.shapes.some(s=>!s.pinArt&&s.points&&s.points.length===2&&s.points[1][1]===5.08));
  const legacy=L.symbolModel({pins:[{number:"1",name:"A",x:0,y:0}],shapes:[
    {kind:"path",style:"body",points:[[0,0],[2.54,0]],closed:false,fill:false,width:0}
  ]});
  assert.equal(legacy.pins[0].orientation,"left");
  assert.equal(legacy.pins[0].length,2.54);
  assert.equal(legacy.shapes.length,0);
}

{
  const proj=A.project("Authors",[]);
  const def={id:"r1",name:"Resistor",prefix:"R",value:"10k",
    parameters:{"Author Email":"ada@lab.example","Author Name":"Ada Lovelace","Authored By":"Ada",MPN:"RC0603",apiKey:"test-secret"},
    symbol:{pins:[{number:"1",name:"1",x:-5,y:0},{number:"2",name:"2",x:5,y:0}],shapes:[]}};
  proj.library.push(def);
  const lib={id:"lab",name:"Lab",defs:[]};
  L.saveToLibrary(lib,def,proj);
  const back=L.readLibraryFile(L.libraryFile(lib).text);
  assert.equal(back.defs[0].parameters["Author Email"],"ada@lab.example");
  assert.equal(back.defs[0].parameters["Author Name"],"Ada Lovelace");
  assert.equal(back.defs[0].parameters["Authored By"],"Ada");
  assert.equal(back.defs[0].parameters.MPN,"RC0603");
  assert.ok(!("apiKey" in back.defs[0].parameters));
}

{
  const old={id:"d",name:"D",prefix:"U",value:"D",symbol:{parts:2,pins:[
    {number:"1",name:"SHARED",x:-10,y:0,orientation:"left",length:2.54,electrical:4,part:0},
    {number:"1",name:"UNIT",x:10,y:0,orientation:"right",length:2.54,electrical:4,part:1}],shapes:[]}};
  assert.equal(L.validateDef(old).ok,true);
  const p=A.project("Dup",[JSON.parse(JSON.stringify(old))]);
  const sch=p.documents[0],item=A.instantiate(p,p.library[0],[0,0]);
  item.unit=1;sch.items.push(item);
  const shared=A.pins(item,p.library[0],"schematic").find(q=>q.name==="SHARED");
  sch.items.push({id:"w",kind:"wire",points:[shared.at.slice(),[shared.at[0]-5,shared.at[1]]]});
  sch.items.push({id:"unit",kind:"wire",points:[[10,0],[20,0]]});
  const next=JSON.parse(JSON.stringify(old));
  next.symbol.pins[0].x=-15.24;next.symbol.pins[1].x=15.24;
  L.replaceDef(p,next);
  const at=A.pins(item,p.library[0],"schematic").find(q=>q.name==="SHARED").at;
  assert.ok(sch.items.find(i=>i.id==="w").points.some(q=>A.same(q,at)));
  assert.ok(sch.items.find(i=>i.id==="unit").points.some(q=>A.same(q,[15.24,0])));
}

{
  const old={id:"gate-move",name:"Gate move",prefix:"U",symbol:{parts:2,pins:[
    {number:"1",name:"INPUT",x:0,y:0,electrical:0,part:0},
    {number:"2",name:"OUTPUT",x:12,y:0,electrical:2,part:2}],shapes:[]}};
  const p=A.project("Gate reassignment",[old]), doc=p.documents[0];
  const part=A.instantiate(p,old,[0,0]);part.unit=2;
  const wire={id:"gate-wire",kind:"wire",points:[[-10,0],[0,0]],net:"INPUT"};
  doc.items.push(part,wire);
  const replacement=A.clone(old);
  Object.assign(replacement.symbol.pins[0],{part:2,x:4,y:2});
  const report=L.replaceDef(p,replacement);
  assert.deepEqual(wire.points.at(-1),[4,2]);
  assert.deepEqual(report.lostNets,[]);
  const nets=A.connectivity(doc,new Map([[replacement.id,replacement]]));
  assert.equal(nets.byPin.get(part.id+"/1"),"INPUT");
}

console.log("PASS pin-to-pad pairing: matched sibling, authored duplicate and case, blanks, exposed pads");
}
