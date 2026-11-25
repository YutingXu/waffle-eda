"use strict";
// Panelization (app/pcb/panel.js): layout and profile tracing, the embedded-array behaviour (board
// edits flow into the panel), panel Gerber/drill/pick-and-place through fab-outputs.js (every
// Gerber passes gerber-check), V-score, the approximate panel check, order notes, the flat
// preview document, panel STEP and output jobs with a panel.
const assert=require("node:assert/strict");
if(!globalThis.performance)globalThis.performance={now:()=>Date.now()};
const mem=new Map();globalThis.localStorage??={getItem:k=>mem.has(k)?mem.get(k):null,setItem:(k,v)=>mem.set(k,String(v)),removeItem:k=>mem.delete(k)};
for(const m of ["model","parts","altium-rules","rules","connectivity","drc","messages","erc","spatial","stackup","pcb-pours","pcb-appearance","board-shape","rigid-flex","zip",
  "fab-outputs","fab-presets","fab-presets/jlcpcb","fab-profiles","bom","step-export","kicad-export","kicad-schematic","ipc2581","panel","output-jobs"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const {check:gerberCheck}=require("../formats/gerber-check.cjs");
const A=Atrium,P=AtriumPanel,F=AtriumFabOutputs,J=AtriumOutputJobs;
const date=new Date(Date.UTC(2026,10,18,12,0,0));
const boardOf=p=>p.documents.find(d=>d.kind==="pcb");
function withPanel(options={}){const p=AtriumParts.example(),b=boardOf(p),d=P.create(p,{board:b.id,...options});p.documents.push(d);return {p,b,d};}
const file=(r,re)=>r.files.find(f=>re.test(f.name));
const hits=t=>t.split("\n").filter(l=>/^X-?[\d.]+Y-?[\d.]+$/.test(l)).length;
const text=d=>typeof d==="string"?d:new TextDecoder().decode(d);
// The sample board has 1.5 mm chamfered corners; V-score needs a rectangle.
const rectangular=b=>{b.outline=[[0,0],[36,0],[36,22],[0,22]];delete b.boardShape;return b;};
// Profile vertices (mm, Y up from the panel's lower-left) from a Gerber profile file.
const vertices=t=>[...t.matchAll(/X(-?\d+)Y(-?\d+)D0[12]/g)].map(m=>[+m[1]/1e6,+m[2]/1e6]);

// ---- data and validation ----------------------------------------------------------
{
  const n=P.normalize({board:"b",rows:99,cols:0,separation:"vscore",rotation:95,rails:{left:true,width:-1},tabs:{perEdge:3.4},cells:{"0,0":{rotation:270},"9,9":{skip:true},"x":{}}});
  assert.equal(n.rows,30);assert.equal(n.cols,1);assert.equal(n.spacing,0,"V-score defaults to abutting boards");assert.equal(n.rotation,90);
  assert.equal(n.rails.left,true);assert.equal(n.rails.width,0);assert.equal(n.tabs.perEdge,3);assert.deepEqual(n.cells,{"0,0":{rotation:270}});
  assert.throws(()=>P.validate({rows:2}),/name its board/);assert.throws(()=>P.validate({board:"b",separation:"laser"}),/separation/);
  const {p,d}=withPanel();
  assert.equal(d.kind,"panel");assert.equal(d.name,"Sensor board panel");assert.deepEqual(d.items,[]);
  const saved=JSON.parse(JSON.stringify(p));A.validate(saved);
  saved.documents.at(-1).items.push({id:"zz",kind:"track",points:[[0,0],[1,1]],width:.2,layer:"Top"});
  assert.throws(()=>A.validate(saved),/Invalid Waffle editor model\.$/,"panels carry no items");
  assert.equal(P.create(p,{board:boardOf(p).id}).name,"Sensor board panel 2","names stay unique");
}

// ---- rectangle-union profile ---------------------------------------------------------
{
  const t=P.trace([[0,0,10,10],[2,2,4,4]]);assert.equal(t.outer.length,1);assert.equal(t.holes.length,0);assert.equal(t.outer[0].length,4);
  const frame=P.trace([[0,0,10,2],[0,8,10,10],[0,0,2,10],[8,0,10,10]]);
  assert.equal(frame.outer.length,1);assert.equal(frame.holes.length,1);
  assert.deepEqual(frame.holes[0].map(q=>q.join()).sort(),["2,2","2,8","8,2","8,8"]);
}

// ---- 2 x 3 with mouse bites --------------------------------------------------------------
{
  const {p,b,d}=withPanel({rows:2,cols:3});
  const G=P.layout(p,d,null,{date});
  // 36 x 22 mm board, 2 mm gaps, 5 mm rails top and bottom (2 mm routing gap to the boards).
  assert.deepEqual([G.W,G.H],[112,60]);assert.equal(G.instances.length,6);
  assert.deepEqual(G.instances.map(i=>i.box[0]),[0,38,76,0,38,76]);assert.deepEqual(G.instances.map(i=>i.box[1]),[7,7,7,31,31,31]);
  // Tabs: 2 per edge toward rails (top row up, bottom row down) and between neighbours, each made once.
  assert.equal(G.tabs.length,6*2+4*2+3*2);
  assert.ok(G.tabs.every(t=>t.rect[2]-t.rect[0]===3||t.rect[3]-t.rect[1]===3));
  // Mouse bites: floor((3 - .6) / .95) + 1 = 3 holes per board edge of each tab.
  assert.equal(G.bites.length,3*(12+2*(8+6)));
  assert.equal(G.fiducials.length,3);assert.equal(G.tooling.length,4);assert.equal(G.vlines.length,0);
  assert.equal(G.profile.outer.length,1,"one panel");assert.ok(G.profile.holes.length>=10,"routed channels between the tabs");
  assert.match(G.texts[0].value,/^Sensor board  2026-11-18$/);
  const r=P.build(p,d,{date});
  for(const f of r.files.filter(f=>f.kind==="gerber")){const c=gerberCheck(f.content);assert.deepEqual(c.issues,[],f.name);}
  const one=F.build(p,b.id,{date});
  const count=(res,ext,re)=>(file(res,new RegExp("\\."+ext+"$")).content.match(re)||[]).length;
  assert.ok(count(r,"GTL",/D03\*/g)>=6*count(one,"GTL",/D03\*/g)+3,"copper repeated per instance plus fiducials");
  assert.match(file(r,/\.GTL$/).content,/%TA\.AperFunction,FiducialPad,Global\*%/);
  const npth=file(r,/-NonPlated\.TXT$/).content;
  assert.match(npth,/TF\.FileFunction,NonPlated,1,2,NPTH/);
  assert.equal(hits(npth),G.bites.length+G.tooling.length+6*(hits(file(one,/-NonPlated\.TXT$/)?.content||"")));
  assert.equal(hits(file(r,/-Plated\.TXT$/).content),6*hits(file(one,/-Plated\.TXT$/).content));
  const profile=file(r,/\.GM1$/).content;assert.match(profile,/Profile,NP/);
  assert.equal((profile.match(/D02\*/g)||[]).length,1+G.profile.holes.length,"outer contour and every routed channel");
  const pnp=text(file(r,/^Pick Place/).content);
  assert.deepEqual(pnp.match(/"R1_\d"/g)?.sort(), [1,2,3,4,5,6].map(k=>"\"R1_"+k+"\""));
  assert.ok(!r.files.some(f=>/\.GM2$/.test(f.name)),"no V-cut layer for tab routing");
  assert.match(file(r,/-Panel\.txt$/).content,/Array: 2 rows x 3 columns, 6 boards/);
  // Panel check: clean (the chamfered outline is routed, see H2 below).
  const c=P.check(p,d,{date});
  assert.equal(c.approximate,true);assert.deepEqual(c.items.filter(i=>i.level!=="info"),[],JSON.stringify(c.items));
  // Embedded array: a board edit shows in the panel without touching it.
  const before=JSON.stringify(d.panel),part=b.items.find(i=>i.kind==="part"&&i.ref==="R1");
  part.x+=1;
  const moved=P.analyse(p,d,{date}).parts.filter(x=>/^R1_/.test(x.item.ref)).map(x=>x.item.x);
  assert.deepEqual(moved.map(x=>x-part.x).map(v=>Math.round(v*1e4)/1e4),G.instances.map(i=>i.box[0]),"every instance follows the board");
  assert.equal(JSON.stringify(d.panel),before);
  // Flat preview document: every board item per instance, plus the panel's holes and fiducials.
  const flat=P.flatten(p,d).doc;
  assert.equal(flat.kind,"pcb");assert.equal(flat.items.filter(i=>/^P\d+:/.test(i.id)).length,6*b.items.length);
  assert.equal(flat.items.filter(i=>i.id.startsWith("panel:")&&i.kind==="pad"&&i.drill).length,G.bites.length+G.tooling.length);
  assert.ok(AtriumBoardShape.fresh(flat),"the panel profile is a current board shape");
  assert.equal(AtriumBoardShape.holes(flat).length,G.profile.holes.length);
  // Web too thin between holes is an error; tabs that do not fit are reported.
  d.panel.tabs={...d.panel.tabs,hole:.8,pitch:.9,width:3};
  assert.ok(P.check(p,d).items.some(i=>i.code==="bite-web"&&i.level==="error"));
  d.panel.tabs={...d.panel.tabs,width:12,perEdge:3};
  assert.ok(P.check(p,d).items.some(i=>i.code==="tab-fit"));
}

// ---- V-score, rotation, mixed boards ----------------------------------------------------
{
  const {p,b:b0,d}=withPanel({rows:2,cols:2,separation:"vscore"});rectangular(b0);
  const G=P.layout(p,d,null,{date});
  assert.deepEqual([G.W,G.H],[72,54]);assert.equal(G.tabs.length,0);assert.equal(G.bites.length,0);
  assert.deepEqual(G.vlines.map(l=>l.axis+l.at),["x36","y5","y27","y49"]);
  assert.equal(G.profile.outer[0].length,4);assert.equal(G.profile.holes.length,0);
  const r=P.build(p,d,{date}),v=file(r,/\.GM2$/);
  assert.ok(v,"V-cut layer (Mechanical 2 is free on this board)");assert.match(v.content,/%TF\.FileFunction,Vcut\*%/);assert.deepEqual(gerberCheck(v.content).issues,[]);
  assert.ok(r.warnings.some(w=>/V-score lines are on Mechanical 2/.test(w)));
  const c=P.check(p,d,{date});
  assert.ok(c.items.some(i=>i.code==="vscore-panel-size"&&i.level==="error"),"54 mm is below JLC's 70 mm V-score minimum");
  // Copper near a V-score line.
  const b=boardOf(p);b.items.push({id:"edge-track",kind:"track",layer:"Top",net:"GND",width:.25,points:[[35.7,5],[35.7,15]]});
  const cc=P.check(p,d,{date}).items.find(i=>i.code==="vscore-copper");
  assert.ok(cc&&/0\.175 mm from the V-score line at X 36/.test(cc.message),JSON.stringify(cc));
  // A bigger, rotated panel passes the size check.
  d.panel=P.normalize({...d.panel,rows:3,cols:4,rotation:90});
  const R=P.layout(p,d);assert.deepEqual([R.instances[0].box[2]-R.instances[0].box[0],R.instances[0].box[3]-R.instances[0].box[1]],[22,36]);
  assert.ok(!P.check(p,d).items.some(i=>i.code==="vscore-panel-size"));
}
{
  const {p,b,d}=withPanel({rows:1,cols:2,rails:{top:false,bottom:false,left:true,right:true,width:5}});
  const other=JSON.parse(JSON.stringify(b));other.id="b2";other.name="Small";other.outline=[[0,0],[20,0],[20,10],[0,10]];
  for(const i of other.items)i.id="b2-"+i.id;
  p.documents.push(other);d.panel.cells={"0,1":{board:"b2",rotation:180}};
  const G=P.layout(p,d);
  assert.deepEqual(G.instances.map(i=>i.board.name),["Sensor board","Small"]);assert.equal(G.instances[1].rotation,180);
  assert.equal(G.fiducials.length,3);assert.equal(G.texts[0].angle,-90,"text runs along vertical rails");
  assert.match(G.texts[0].value,/Sensor board \+ Small/);
  const r=P.build(p,d,{date});for(const f of r.files.filter(f=>f.kind==="gerber"))assert.deepEqual(gerberCheck(f.content).issues,[],f.name);
  // Mechanical 15 is footprint artwork on both boards. Selecting its film includes both copies.
  assert.ok(r.model.optInMechanical.has("Mechanical 15"));
  assert.ok(!file(r,/\.GM15$/));
  const selected=P.build(p,d,{date,layers:{GM15:true}});
  assert.ok(file(selected,/\.GM15$/));
  assert.equal(selected.model.layers.get("Mechanical 15").length, r.model.layers.get("Mechanical 15").length);
  // A real board-level primitive on either constituent opts the whole layer in.
  other.items.push({id:"board-gm15",kind:"graphic",layer:"Mechanical 15",points:[[1,1],[3,1]],width:.1});
  const withBoardArt=P.build(p,d,{date});
  assert.ok(file(withBoardArt,/\.GM15$/));
  assert.equal(withBoardArt.model.layers.get("Mechanical 15").length,r.model.layers.get("Mechanical 15").length+1);
}

// ---- order notes -------------------------------------------------------------------------
{
  const {p,b,d}=withPanel({rows:2,cols:3});
  const n=P.orderNotes(p,b.id,{date,vendor:"JLCPCB"});
  assert.equal(n.facts.layers,2);assert.deepEqual(n.facts.size,[36,22]);assert.equal(n.facts.minTrack,.32);
  assert.ok(n.facts.minSpace>0&&n.facts.minSpace<5);assert.equal(n.facts.minHole,.4);assert.equal(n.facts.castellated,0);assert.equal(n.facts.impedance,false);
  assert.match(n.text,/^Order notes: Sensor board \(JLCPCB\)/);assert.match(n.text,/Castellated holes: +no/);assert.match(n.text,/Impedance control: +no/);
  assert.match(n.text,/https:\/\/jlcpcb\.com\/help\/article\/pcb-panelization/);
  assert.match(P.orderNotes(p,d,{date}).text,/panel by customer, 2 x 3 \(6 boards\), 112 x 60 mm/);
  // A plated hole on the edge reads as castellated; an impedance profile on a rule turns on impedance control.
  b.items.push({id:"cast",kind:"pad",x:36,y:11,w:1.2,h:1.2,drill:.6,shape:"round",layer:"Multi",number:"1",net:"GND"});
  assert.equal(P.orderNotes(p,b.id).facts.castellated,1);
}

// ---- output jobs with a panel, STEP --------------------------------------------------------
{
  const {p,d}=withPanel({rows:2,cols:3});
  const out=J.run(p,"JLCPCB order",{date,panel:d.id}),names=out.files.map(f=>f.name);
  assert.equal(out.report.panel,"Sensor board panel");
  const notes=text(out.files.find(f=>/Order-Notes/.test(f.name)).data);assert.match(notes,/panel by customer/);
  const cpl=text(out.files.find(f=>/CPL-/.test(f.name)).data);assert.ok(cpl.includes("\"R1_6\""),cpl);
  assert.ok(names.some(n=>/Gerber\.zip$/.test(n)));
  assert.equal(J.resolve(p,"PCBWay").name,"PCBWay order","the old preset name still resolves");
  const s=P.step(p,d,{format:"step",timestamp:"2026-11-18T12:00:00"});
  assert.equal(s.name,"Sensor board panel.step");assert.match(text(s.data),/^ISO-10303-21;/);
}
// Panel BOM designators must match the instance names in pick and place.
{
  const p = A.project("Padded panel references", []);
  const b = boardOf(p);
  rectangular(b);
  p.library.push({id: "r", name: "R", footprint: {name: "R0603", shapes: [], pads: [
    {number: "1", x: -.8, y: 0, w: .8, h: .9, shape: "rect"},
    {number: "2", x: .8, y: 0, w: .8, h: .9, shape: "rect"}
  ]}});
  const refs = ["R01", "R02", "R03", "R04"];
  refs.forEach((ref, i) => b.items.push({id: ref, kind: "part", def: "r", ref, value: "10k",
    x: 5 + i * 5, y: 10, angle: 0, pinNets: {}}));
  const d = P.create(p, {board: b.id, rows: 1, cols: 2});
  p.documents.push(d);
  const out = J.run(p, {name: "Order", panel: d.id, outputs: [
    {kind: "bom", options: {style: "default", format: "csv", source: "pcb"}},
    {kind: "pnp", options: {style: "altium"}}
  ]}, {date});
  const expected = refs.flatMap(ref => [ref + "_1", ref + "_2"]);
  const cpl = text(file(out, /Pick Place/).data);
  const placements = [...cpl.matchAll(/^"(R0[0-9]+_[0-9]+)",/gm)].map(m => m[1]).sort();
  assert.deepEqual(placements, expected);
  const bom = text(file(out, /BOM/).data);
  assert.ok(bom.includes('"' + expected.join(", ") + '"'),
    "the panel BOM preserves the exact pick-and-place designators");
}

// ---- review regressions ----------------------------------
// H1: V-score lines never cut a board; misaligned boards are refused.
{
  const {p,b,d}=withPanel({rows:2,cols:2,separation:"vscore",cells:{"0,0":{rotation:90}}});rectangular(b);
  const G=P.layout(p,d);
  for(const l of G.vlines)for(const i of G.instances){const k=l.axis==="x"?0:1;assert.ok(!(i.box[k]<l.at-1e-6&&i.box[k+2]>l.at+1e-6),"line "+l.axis+l.at+" crosses board "+i.index);}
  assert.ok(P.check(p,d).items.some(i=>i.code==="vscore-misaligned"&&i.level==="error"));
  assert.throws(()=>P.build(p,d,{date}),/cannot be fabricated.*V-score line/);
}
// H2: the real outline is routed (chamfers reach GM1) and tabs land on it; V-score refuses it.
{
  const {p,d}=withPanel({rows:1,cols:1});
  const r=P.build(p,d,{date}),G=r.model.panel,gm1=vertices(file(r,/\.GM1$/).content);
  const i=G.instances[0],x0=i.box[0],yTop=G.H-i.box[1];
  assert.ok(gm1.some(([x,y])=>Math.abs(x-(x0+1.5))<1e-6&&Math.abs(y-yTop)<1e-6),"chamfer start on the top edge");
  assert.ok(gm1.some(([x,y])=>Math.abs(x-x0)<1e-6&&Math.abs(y-(yTop-1.5))<1e-6),"chamfer end on the left edge");
  assert.ok(!gm1.some(([x,y])=>Math.abs(x-x0)<1e-6&&Math.abs(y-yTop)<1e-6),"no square corner");
  assert.deepEqual(gerberCheck(file(r,/\.GM1$/).content).issues,[]);
  // A board with a notch on its left edge: the tab and its mouse bites reach into the notch.
  const {p:q,b:nb,d:nd}=withPanel({rows:1,cols:1,rails:{left:true,right:false,top:false,bottom:false,width:5},tabs:{perEdge:1,width:3}});
  nb.outline=[[0,0],[36,0],[36,22],[0,22],[0,13],[2,13],[2,9],[0,9]];delete nb.boardShape;
  const N=P.layout(q,nd),tab=N.tabs.find(t=>t.side==="left"),bx=N.instances[0].box[0];
  assert.ok(tab.rect[2]>=bx+2,"tab reaches the notch bottom");
  assert.ok(N.bites.filter(h=>h.at[0]>bx+1).length>=3,"bites sit on the real edge in the notch");
  const sq=withPanel({rows:1,cols:2,separation:"vscore"});
  assert.ok(P.check(sq.p,sq.d).items.some(i=>i.code==="vscore-shape"&&i.level==="error"));
  assert.throws(()=>P.build(sq.p,sq.d,{date}),/not rectangular/);
}
// H3: rigid-flex boards are refused in the check, the build and an output job.
{
  const St=AtriumStackup,p=A.project("Flex"),doc=A.sheet("pcb","Flex");doc.outline=[[0,0],[60,0],[60,20],[0,20]];
  const st=St.preset(4);delete st.derived;const cu=st.layers.filter(St.isCopper);
  st.substacks=[{id:"flex",name:"Flex",flex:true,layers:St.flexLayers(["Top","Bottom"],cu)}];doc.stackup=JSON.parse(JSON.stringify(st));
  St.splitRegion(doc,{a:[20,-1],b:[20,21]});const fr=AtriumRigidFlex.regions(doc).find(g=>AtriumRigidFlex.geometry.inside([40,10],g.points));St.assignStack(doc,fr.id,"flex");
  doc.items.push({id:"t1",kind:"track",layer:"Top",net:"A",width:.2,points:[[5,5],[50,5]]});p.documents.push(doc);
  const d=P.create(p,{board:doc.id});p.documents.push(d);
  assert.ok(P.check(p,d).items.some(i=>i.code==="rigid-flex"&&i.level==="error"));
  assert.throws(()=>P.build(p,d,{date}),/rigid-flex/);
  const job=J.run(p,{name:"Flex panel",folder:"",panel:d.id,outputs:[{kind:"gerber"}]},{date}).report;
  assert.equal(job.ok,false);assert.match(job.outputs[0].message,/rigid-flex/);
}
// H4: a panel order's BOM lists the same designators as its CPL.
{
  const {p,d}=withPanel({rows:2,cols:2});
  const out=J.run(p,"JLCPCB order",{date,panel:d.id});
  const bom=text(out.files.find(f=>/BOM-/.test(f.name)).data),cpl=text(out.files.find(f=>/CPL-/.test(f.name)).data);
  const cplRefs=new Set(cpl.split("\r\n").slice(1).filter(Boolean).map(l=>l.split(",")[0].replace(/"/g,"")));
  const bomRefs=new Set();for(const line of bom.split("\r\n").slice(1).filter(Boolean)){const m=/^[^,]*,"?([^"]*)"?,/.exec(line);for(const r of m[1].split(/\s*,\s*/))bomRefs.add(r);}
  assert.deepEqual([...bomRefs].sort(),[...cplRefs].sort(),"BOM and CPL designators agree");
  assert.ok(bomRefs.has("C1_4"));assert.deepEqual(P.expandRefs("R1-R3, C2"),["R1","R2","R3","C2"]);
}
// Slots follow the same placement as the round drill hits on each board.
{
  const {p,b,d}=withPanel({rows:1,cols:2,alternate:"cols"});
  b.items.push({id:"slot",kind:"pad",number:"12",x:10,y:8,layer:"Multi",w:3,h:2,shape:"rect",drill:1,slotLength:2,slotAngle:15,plated:true});
  const source=F.analyse(p,b.id).drills.find(h=>h.endpoints), panel=P.build(p,d,{date,origin:"absolute"});
  const nc=file(panel,/-Plated\.TXT$/).content, slots=[];
  for(const match of nc.matchAll(/^X([-\d.]+)Y([-\d.]+)G85X([-\d.]+)Y([-\d.]+)/gm))
    slots.push([[+match[1],-match[2]],[+match[3],-match[4]]]);
  assert.equal(slots.length,2);
  for(const inst of panel.model.panel.instances){
    const expected=source.endpoints.map(inst.T);
    assert.ok(slots.some(line=>line.every(([x,y],i)=>Math.hypot(x-expected[i][0],y-expected[i][1])<.0001)),
      "each slot's two NC endpoints follow the instance translation and rotation");
  }
}
// H5: V-cut takes a free mechanical layer, so a board's own Mechanical 2 keeps its file; names stay unique.
{
  const {p,b,d}=withPanel({rows:3,cols:3,separation:"vscore"});rectangular(b);
  b.items.push({id:"m2",kind:"graphic",layer:"Mechanical 2",points:[[1,1],[10,1]],width:.1});
  const r=P.build(p,d,{date}),names=r.files.map(f=>f.name);
  assert.equal(new Set(names).size,names.length,"unique names");
  const vcut=r.files.find(f=>/%TF\.FileFunction,Vcut\*%/.test(f.content||""));
  assert.ok(vcut&&!/\.GM2$/.test(vcut.name),vcut?.name);
  assert.ok(r.warnings.some(w=>/V-score lines are on Mechanical \d+ \(GM\d+/.test(w)));
}
// M1: a board with another copper stack is an error and the panel is not built.
{
  const {p,b,d}=withPanel({rows:1,cols:2});
  const other=JSON.parse(JSON.stringify(b));other.id="b4";other.name="Four";for(const i of other.items)i.id="b4-"+i.id;
  other.items.push({id:"in1",kind:"track",layer:"Inner 1",points:[[2,2],[10,2]],width:.2,net:"X"});p.documents.push(other);
  d.panel.cells={"0,1":{board:"b4"}};
  assert.ok(P.check(p,d).items.some(i=>i.code==="stack-mismatch"&&i.level==="error"));
  assert.throws(()=>P.build(p,d,{date}),/same copper stack/);
}
// M2: order-notes min space uses the real pad corners.
{
  const p=A.project("Space"),doc=A.sheet("pcb","Space");doc.outline=[[0,0],[20,0],[20,20],[0,20]];
  doc.items.push({id:"p1",kind:"pad",x:5,y:5,w:1,h:1,shape:"rect",layer:"Top",net:"A",number:"1"},{id:"p2",kind:"pad",x:6.15,y:6.15,w:1,h:1,shape:"rect",layer:"Top",net:"B",number:"1"},
    {id:"t1",kind:"track",layer:"Top",net:"C",width:.2,points:[[1,15],[19,15]]},{id:"t2",kind:"track",layer:"Top",net:"D",width:.2,points:[[1,15.5],[19,15.5]]});
  p.documents.push(doc);
  assert.equal(P.orderNotes(p,doc.id).facts.minSpace,.2121);
}
// M4: a panel that falls apart is an error and is not built.
{
  const {p,d}=withPanel({rows:1,cols:2,rails:{top:false,bottom:false,left:false,right:false,width:5},tabs:{perEdge:0}});
  assert.ok(P.check(p,d).items.some(i=>i.code==="pieces"&&i.level==="error"));
  assert.throws(()=>P.build(p,d,{date}),/falls apart/);
}
// M5: a mechanical layer only the second board uses is kept.
{
  const {p,b,d}=withPanel({rows:1,cols:2});
  const other=JSON.parse(JSON.stringify(b));other.id="b5";other.name="Second";for(const i of other.items)i.id="b5-"+i.id;
  other.items.push({id:"m5",kind:"graphic",layer:"Mechanical 5",points:[[1,1],[10,1]],width:.1});p.documents.push(other);
  d.panel.cells={"0,1":{board:"b5"}};
  const m=P.analyse(p,d,{date});assert.equal(m.layers.get("Mechanical 5")?.length,1);
}
console.log("PASS panel: layout, profile, embedded array, Gerber/drill/PnP (gerber-check), V-score, mixed boards, check, order notes, jobs, STEP");
