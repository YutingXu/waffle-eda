"use strict";
// Normal edits, saved source copper, actual plotted layer lands, and copper on a split plane.
const assert = require("node:assert/strict");
const {F2} = require("../support/a1-geometry.cjs");
for (const name of ["model", "parts", "spatial", "pcb-appearance", "pcb-pours", "pcb-text-rich", "pcb-text", "vectorize",
  "stackup", "net-intent", "signals", "query", "rules", "project-rules", "viastack", "board-shape", "pcb-import",
  "polygon-pour", "pcb-draw", "zip", "fab-outputs", "ipc2581", "drc-pours", "import-link", "eco", "io"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const P = AtriumPolygonPour, D = AtriumDRCPours, R = AtriumRules, F = AtriumFabOutputs;
const box = (x,y,u,v) => [[x,y],[u,y],[u,v],[x,v]];
const plane = (id,points,o={}) => P.make(points,{id,net:"GND",layer:"Top",removeDeadCopper:false,...o});
const track = (id,y) => ({id,kind:"track",points:[[10,y],[20,y]],net:"SIG",layer:"Top",width:.25});
const defs = p => new Map(p.library.map(x=>[x.id,x]));
const board = p => p.documents.find(d=>d.kind==="pcb");
const gerber = (p,ext) => F.build(p,board(p),{date:new Date("2025-01-01T12:00:00Z")}).files.find(f=>f.name.endsWith(ext)).content;
const ink = (regions,x,y) => regions.some(r=>D.inside(x,y,P.rings(r)));
function example(items){
  const p=Atrium.project("Copper"),b=board(p);
  b.outline=box(0,0,50,50);b.items=items;return {p,b,o:{project:p},lib:defs(p)};
}
function exact(p){
  const copy=Atrium.clone(p),b=board(copy);P.apply(b,defs(copy),{project:copy,reuse:false});return copy;
}

{
  const outline=box(-8,-8,8,8), pour=plane("plane",outline,{clearance:.2});
  const curve={...F2.track,id:"trace",net:"SIG",layer:"Top",arc:{...F2.track.arc}};
  const {b,o,lib}=example([pour,curve]);b.outline=outline;
  P.apply(b,lib,o);
  const published=b.pcbDrawing.pourSignatures[pour.id];
  for(const [curved,at] of [[true,F2.inside],[false,F2.outside]]){
    curve.arc.end=curved?180:F2.staleEnd;
    assert.deepEqual(P.stale(b,lib,o),curved?[]:[pour.id]);
    const {regions}=P.apply(b,lib,o);
    assert.deepEqual([ink(regions,...F2.inside),ink(regions,...F2.outside)],[!curved,curved]);
    assert.deepEqual(D.verify(b,lib,null,o).violations,[]);
    const near=([x,y])=>box(x-.04,y-.04,x+.04,y+.04);
    const islands=[F2.inside,F2.outside].map(p=>AtriumPCBPours.region([near(p)],"Top","SIG"));
    P.linkStored(b,lib,islands);
    assert.deepEqual(islands.map(r=>r.links),curved?[[["trace",0]],[]]:[[],[["trace",0]]],String(at));
  }
  assert.notEqual(b.pcbDrawing.pourSignatures[pour.id],published);
}
{
  const radius=1e6,q=radius/Math.SQRT2,half=radius+1;
  const trace={...F2.track,id:"long-arc",net:"SIG",layer:"Top",points:[[radius,0],[0,-radius],[-radius,0]],arc:{...F2.track.arc,r:radius}};
  const pour=plane("local",box(q-1,-q-1,q+1,-q+1),{clearance:.2}),later=plane("later",box(q-1,-q-1,q+1,-q+1),{pourIndex:1,net:"LATER"});
  const {p,b,o,lib}=example([trace,pour,later]);b.outline=box(-half,-half,half,half);
  assert.equal(Atrium.validate(Atrium.clone(p)).documents.find(d=>d.kind==="pcb").items[0].arc.r,radius);
  const local=P.apply(b,lib,o),first=local.regions.filter(r=>r.polygon===pour.id);
  assert.deepEqual(local.failed,[]);
  assert.deepEqual([ink(first,q,-q),ink(first,q+.8,-q-.8)],[false,true],"the local solve clears the actual large-radius trace");
  const islands=[[q,-q],[radius/2,-radius/2]].map(([x,y])=>AtriumPCBPours.region([box(x-.04,y-.04,x+.04,y+.04)],"Top","SIG"));
  P.linkStored(b,lib,islands);
  assert.deepEqual(islands.map(r=>r.links),[[[trace.id,0]],[]],"stored contact is scoped per island and misses the authored chord");
  const historical=AtriumPCBPours.region([b.outline],"Top","SIG");historical.links=[["historical",0]];
  const stockLinks=Atrium.clone([...islands,historical].map(r=>r.links));
  assert.throws(()=>P.linkStored(b,lib,[...islands,historical]),/Curve point budget exceeded/);
  assert.deepEqual([...islands,historical].map(r=>r.links),stockLinks,"a failed link calculation leaves every saved link intact");
  const saved=Atrium.clone(b.pcbDrawing.pours);pour.points=b.outline;
  const result=P.apply(b,lib,o);
  assert.deepEqual(result.failed.map(r=>r.id),[pour.id]);assert.match(result.failed[0].reason,/Curve point budget exceeded/);
  assert.deepEqual(result.blocked,[later.id]);
  assert.deepEqual(b.pcbDrawing.pours,saved,"the failed and blocked pours keep their previous copper");
}
{
  const pour=plane("gnd",box(10,10,20,20)),t=track("moved",27),{p,b,o,lib}=example([pour,t]);
  AtriumProjectRules.edit(p,set=>{set.list.find(r=>r.type==="clearance").objects={"track-poly":6};});
  P.apply(b,lib,o);
  for(const y of [24,27,24]){
    t.points=[[10,y],[20,y]];
    assert.deepEqual(P.stale(b,lib,o),["gnd"]);
    const ref=exact(p),out=P.outputCopper(b,lib,o);
    assert.deepEqual(out.regions,board(ref).pcbDrawing.pours);
    assert.equal(gerber(p,".GTL"),gerber(ref,".GTL"));
    let edits=0;P.repour(b,lib,o,fn=>{edits++;fn();},()=>{});assert.equal(edits,1);
    assert.deepEqual(P.stale(b,lib,o),[]);
  }
  const saved=Atrium.clone(p);
  assert.deepEqual(P.stale(board(saved),defs(saved),{project:saved}),[]);
  b.pcbDrawing.pourSignatureVersion=3;
  assert.deepEqual(P.stale(b,lib,o),["gnd"],"old solver geometry must be regenerated");
}
{
  const surround=plane("earlier",box(0,0,50,50)),later=plane("later",box(25,25,30,30),{net:"VCC",pourIndex:1});
  const bottom=plane("bottom",box(20,20,40,40),{layer:"Bottom"});
  const {p,b,o,lib}=example([surround,later,bottom]);P.apply(b,lib,o);
  const untouched=b.pcbDrawing.pours.find(r=>r.polygon===bottom.id);
  const l=[[0,0],[50,0],[50,8],[8,8],[8,50],[0,50]];
  surround.points=l;P.apply(b,lib,{...o,only:["earlier"]});
  assert.deepEqual(P.stale(b,lib,o),["later"],"a partly repoured earlier outline exposes the previously empty area");
  assert.deepEqual(P.outputCopper(b,lib,o).regions,board(exact(p)).pcbDrawing.pours);
  for(const outline of [l,box(0,0,50,50),l]){
    const edit=AtriumPCBDraw.modifyOutline(b,lib,surround,outline,o);
    assert.deepEqual(edit.repoured,["earlier","later"]);assert.deepEqual(P.stale(b,lib,o),[]);
    assert.equal(ink(b.pcbDrawing.pours.filter(r=>r.polygon==="later"),27,27),outline===l);
    assert.equal(b.pcbDrawing.pours.find(r=>r.polygon==="bottom"),untouched);
  }
}
{
  const t=track("arc",18);t.arc=true;
  const g=plane("g",box(1,1,25,25),{name:"Ground fill"}),b=plane("b",box(26,1,49,25),{name:"Other fill"});
  const plain=track("straight",10),rect={kind:"graphic",id:"rect",layer:"Top",net:"SIG",closed:true,fill:true,fillRect:true,width:0,points:box(5,3,9,5)};
  const {p,b:doc,o,lib}=example([g,b,t,plain,rect]);
  AtriumProjectRules.edit(p,set=>{
    const base=set.list.find(r=>r.type==="clearance");base.priority=5;base.objects={"arc-poly":.8,"fill-poly":.6};
    set.list.push({...base,id:"named",name:"Named copper",priority:1,scope:{kind:"query",value:"InNamedPolygon('Ground fill')"},scope2:{kind:"query",value:"IsTrack"},gap:1,objects:{}});
  });
  P.apply(doc,lib,o);const regions=doc.pcbDrawing.pours;
  for(const [x,y,expected] of [[14,18.8,false],[14,19,true],[14,11,false],[14,11.2,true],[7,5.5,false],[7,5.7,true]])assert.equal(ink(regions,x,y),expected,[x,y].join(","));
  assert.deepEqual(D.verify(doc,lib,null,o).violations,[]);
  g.name="Another";assert.deepEqual(P.stale(doc,lib,o),["g"]);
}
{
  const top=plane("top",box(1,1,19,19)),bottom=plane("bottom",box(1,1,19,19),{layer:"Bottom"});
  const via={kind:"via",id:"v",layer:"Multi",net:"SIG",x:10,y:10,diameter:.6,drill:.2,
    stackMode:"full",padStack:{Top:{diameter:2,shape:"rect"},Bottom:{diameter:.4,shape:"octagon"}}};
  const {p,b,o,lib}=example([top,bottom,via]);P.apply(b,lib,o);
  const model=F.analyse(p,b),topCopper=b.pcbDrawing.pours.filter(r=>r.layer==="Top"),botCopper=b.pcbDrawing.pours.filter(r=>r.layer==="Bottom");
  assert.ok(!ink(topCopper,10.95,10.95));assert.ok(!ink(topCopper,11.12,11.12));
  // The square land's clearance keeps square corners (Altium's cut): clear to 11.2 on the diagonal.
  assert.ok(!ink(topCopper,11.18,11.18));assert.ok(ink(topCopper,11.22,11.22));
  assert.ok(ink(botCopper,10.43,10));assert.ok(!ink(botCopper,10.37,10));assert.deepEqual(model.pourClearance,[]);
  assert.equal(model.layers.get("Top").find(f=>f.use==="via").pad.shape,"rect");
  assert.equal(model.layers.get("Bottom").find(f=>f.use==="via").pad.shape,"octagon");
  const broken=AtriumPCBPours.region([box(10.87,10.87,11.02,11.02)],"Top","GND",{polygon:"top"});
  assert.ok(D.verify(b,lib,null,{...o,regions:[broken]}).violations.some(v=>v.actual===0&&v.otherId==="v"));
  // A read-only earlier island completely contains the land, with no boundary near its centre.
  const legacy=AtriumPCBPours.region([box(1,1,19,19)],"Top","GND");
  const joined=AtriumPCBPours.region([box(9.9,9.9,10.1,10.1)],"Top","SIG");
  const fixed=P.protectStoredLands(b,[legacy,joined],[{v:via,layer:"Top",at:[10,10],land:AtriumViaStack.padOn(via,"Top")}],o);
  assert.equal(fixed.at(-1),joined);assert.ok(!ink(fixed.filter(r=>r.net==="GND"),10.95,10.95));
  assert.ok(ink(fixed.filter(r=>r.net==="GND"),11.2,11.2));assert.ok(ink([legacy],10.95,10.95));
  via.backdrill={from:"top",toLayer:"Bottom",diameter:.7,stubMax:.1};P.apply(b,lib,o);
  assert.ok(!F.analyse(p,b).layers.get("Top").some(f=>f.use==="via"));
  assert.ok(!ink(b.pcbDrawing.pours.filter(r=>r.layer==="Top"),10.48,10),"back-drill void");
}
console.log("PASS fabrication copper freshness, scoped clearance and physical layer lands");

{
  const zone=plane("land",box(1,1,19,19)),slot={id:"mount",kind:"pad",layer:"Multi",number:"H",net:"GND",x:10,y:10,
    w:3,h:3,shape:"round",drill:.5,slotLength:4,slotAngle:90,holeOnly:true,plated:false};
  const {p,b,o,lib}=example([zone,slot]);
  AtriumProjectRules.edit(p,set=>{set.list.find(r=>r.type==="clearance").objects={"poly-hole":.6};});
  P.apply(b,lib,o);
  assert.deepEqual(P.connections(b,lib,zone,o),[],"a hole has no thermal or land");
  assert.ok(!ink(b.pcbDrawing.pours,10,12.57)&&ink(b.pcbDrawing.pours,10,12.62));
  assert.ok(!ink(b.pcbDrawing.pours,10.82,10)&&ink(b.pcbDrawing.pours,10.88,10));
  slot.slotAngle=0;assert.deepEqual(P.stale(b,lib,o),[zone.id]);
  const pad={...slot,net:"SIG",drill:0,shape:"roundrect",roundrectRadiusRatio:.25};
  delete pad.holeOnly;delete pad.slotLength;delete pad.slotAngle;b.items[1]=pad;
  P.apply(b,lib,o);pad.roundrectRadiusRatio=.45;
  assert.deepEqual(P.stale(b,lib,o),[zone.id],"the source pad corner radius enters the zone signature");
}
{
  const zone=plane("override",box(10,10,20,20),{clearance:.2}),line=track("far",27);
  const {p,b,lib}=example([zone,line]),o={project:p,clearance:6};
  P.apply(b,lib,o);line.points=[[10,24],[20,24]];
  assert.deepEqual(P.stale(b,lib,o),[zone.id]);
  P.apply(b,lib,o);assert.deepEqual(P.stale(b,lib,{project:p}),[zone.id]);
}

{
  const records = [
    "RECORD=Board|LAYER1NAME=Top|LAYER1NEXT=39|LAYER39NAME=Internal plane|LAYER39NEXT=32|LAYER32NAME=Bottom|VX0=0mm|VY0=0mm|VX1=20mm|VY1=0mm|VX2=20mm|VY2=20mm|VX3=0mm|VY3=20mm",
    "RECORD=Net|ID=0|NAME=GND","RECORD=Net|ID=1|NAME=SIG",
    "RECORD=Polygon|POLYGONTYPE=Split Plane|LAYER=PLANE1|NET=0|VX0=1mm|VY0=1mm|VX1=19mm|VY1=1mm|VX2=19mm|VY2=19mm|VX3=1mm|VY3=19mm",
    "RECORD=Track|LAYER=PLANE1|X1=2mm|Y1=2mm|X2=18mm|Y2=2mm|WIDTH=0.4mm",
    "RECORD=Via|X=4mm|Y=6mm|NET=1|DIAMETER=1.2mm|HOLESIZE=0.4mm|STARTLAYER=TOP|ENDLAYER=BOTTOM",
    "RECORD=Via|X=4mm|Y=12mm|NET=0|DIAMETER=1.2mm|HOLESIZE=0.4mm|STARTLAYER=TOP|ENDLAYER=BOTTOM",
    "RECORD=Pad|LAYER=MULTILAYER|NAME=1|X=10mm|Y=8mm|NET=0|XSIZE=2.5mm|YSIZE=1mm|SHAPE=ROUND|HOLESIZE=0.5mm|HOLETYPE=Slot|HOLELENGTH=2mm",
    "RECORD=Rule|RULEKIND=PlaneClearance|PRIORITY=1|SCOPE1EXPRESSION=All|SCOPE2EXPRESSION=All|CLEARANCE=0.5mm",
    "RECORD=Rule|RULEKIND=PlaneConnect|PRIORITY=1|SCOPE1EXPRESSION=All|SCOPE2EXPRESSION=All|VIA.PLANECONNECTSTYLE=Direct|PAD.PLANECONNECTSTYLE=Relief|PAD.RELIEFEXPANSION=0.5mm|PAD.RELIEFAIRGAP=0.25mm|PAD.RELIEFCONDUCTORWIDTH=0.25mm|PAD.RELIEFENTRIES=4"
  ];
  const {p}=example([]),b=AtriumPCB.read("Planes.PcbDoc",null,records.join("\r\n")).documents[0];
  p.documents[p.documents.indexOf(board(p))]=b;
  const lib=defs(p),o={project:p},zone=b.items.find(i=>i.kind==="polygon"),voidTrack=b.items.find(i=>i.planeVoid);
  assert.equal(zone.layer,"Inner 1");assert.equal(zone.powerPlane.sourceLayer,"PLANE1");assert.equal(zone.clearance,.5);
  assert.ok(voidTrack.keepout&&voidTrack.layer===zone.layer);
  assert.deepEqual(P.pendingPlanes(b),[zone.id]);
  const model=F.analyse(p,b),target=model.copper.regions;
  assert.ok(!ink(target,4.68,-6)&&ink(target,4.72,-6),"antipad starts at the 0.2 mm drill radius");
  assert.ok(ink(target,4,-12),"direct same-net barrel");assert.ok(!ink(target,12,-2)&&ink(target,12,-2.22),"finished negative aperture has no extra clearance");
  assert.ok(ink(target,10,-8),"the positive plane includes its relief land");assert.ok(!ink(target,10,-8.90),"air gap above the slot");
  assert.ok(model.layers.get("Inner 1").every(f=>f.t==="pour"),"the negative plane model does not add standalone flashes or positive voids");
  const files=F.build(p,b,{date:new Date("2025-01-01T12:00:00Z"),origin:"absolute"}).files;
  const exc=require("../formats/gerber-compare.cjs").parseExcellon(files.find(f=>f.name.endsWith("-Plated.TXT")).content);
  assert.equal(exc.slots.length,1);assert.deepEqual(exc.slots[0].a,[9.25,8]);assert.deepEqual(exc.slots[0].b,[10.75,8]);assert.equal(exc.slots[0].d,.5);
  const ipc=AtriumIPC2581.build(p,b,{origin:"absolute"}),check=AtriumIPC2581.check(ipc.content);
  assert.ok(check.ok,JSON.stringify(check.errors));assert.equal(check.counts.byLayer.SLOT_PTH_TOP_BOTTOM.holes,1);
  const slot=ipc.content.match(/<SlotCavity\b[\s\S]*?<\/SlotCavity>/)[0];
  assert.ok(slot.includes('platingStatus="PLATED"')&&slot.includes('centerX="9.25" centerY="8"')&&slot.includes('centerX="10.75" centerY="8"'));
  assert.ok(slot.includes('x="10.75" y="8.25"')&&slot.includes('x="9.25" y="7.75"'));
  P.apply(b,lib,o);
  assert.ok(P.thermals(b,lib,o).every(t=>t.connected===4));
  assert.deepEqual(P.pendingPlanes(b),[]);
  const scoped=records.map(r=>r.includes("RULEKIND=PlaneClearance")?r.replace("PRIORITY=1","PRIORITY=2"):r).concat(
    "RECORD=Rule|RULEKIND=PlaneClearance|PRIORITY=1|SCOPE1EXPRESSION=InNet('SIG')|SCOPE2EXPRESSION=All|CLEARANCE=1mm");
  const partial=AtriumPCB.read("Scoped.PcbDoc",null,scoped.join("\r\n")).documents[0];
  assert.equal(partial.items.find(i=>i.powerPlane).clearance,.5);
  assert.ok(partial.notes.some(n=>n.includes("scoped overrides")));
}
{
  // ASCII authored hatch strokes can precede their polygon record, and carry
  // valid source artwork on boards with no Regions6 copper at all.
  const lines=["RECORD=Board|VX0=0mm|VY0=0mm|VX1=12mm|VY1=0mm|VX2=12mm|VY2=12mm|VX3=0mm|VY3=12mm",
    "RECORD=Net|ID=0|NAME=GND","RECORD=Track|POLYGON=0|LAYER=TOP|NET=0|X1=2mm|Y1=2mm|X2=9mm|Y2=2mm|WIDTH=0.2mm",
    "RECORD=Polygon|LAYER=TOP|NET=0|HATCHSTYLE=90Degree|REMOVEDEAD=FALSE|VX0=1mm|VY0=1mm|VX1=10mm|VY1=1mm|VX2=10mm|VY2=10mm|VX3=1mm|VY3=10mm"];
  const {p}=example([]),b=AtriumPCB.read("Hatch.PcbDoc",null,lines.join("\r\n")).documents[0];
  p.documents[p.documents.indexOf(board(p))]=b;
  assert.equal(b.sourcePourSignature,undefined,"the 1.4 signature still requires a contour table");
  assert.match(b.pcbDrawing.sourceHatchSignature,/^[0-9a-f]{16}$/);
  b.rules=R.defaults();
  AtriumPCBPours.storeSignature(b,defs(p));
  AtriumImportLink.reconcile(p,p.documents);
  assert.ok(AtriumPCBPours.matchesSignature(b,defs(p)),"source hatches are re-signed when rules enter the rule book");
  const {nativeRoundTrip}=require("../support/native-cad.cjs"), reloaded=nativeRoundTrip(p);
  const q=board(reloaded),zone=q.items.find(i=>i.kind==="polygon"),t=q.items.find(i=>i.kind==="track");
  const invalid=Atrium.clone(p);board(invalid).pcbDrawing.sourceHatchSignature="malformed";
  assert.throws(()=>Atrium.validate(invalid),/Invalid Waffle editor model/);
  const edited=nativeRoundTrip(p);
  board(edited).items.find(i=>i.kind==="track").width+=.05;
  assert.deepEqual(P.stale(board(edited),defs(edited)),[zone.id],"changed geometry cannot authenticate the source hatch");
  assert.equal(t.sourcePour,zone.id);
  assert.deepEqual(P.stale(q,defs(reloaded)),[],"verified source hatch is already filled");
  assert.equal(q.pcbDrawing.sourceHatchSignature,undefined,"adoption stores normal per-pour signatures");
  assert.ok(q.items.includes(t));zone.hatchPitch=2;
  assert.deepEqual(P.stale(q,defs(reloaded)),[zone.id]);P.apply(q,defs(reloaded));
  assert.ok(!q.items.includes(t));assert.deepEqual(P.stale(q,defs(reloaded)),[]);
}
{
  // An internal plane keeps its Plane Clearance from a foreign barrel; the Clearance rule's
  // Via-Poly cell governs positive pours, not planes. Plane voids (tracks on a plane layer)
  // are cut with the rounding margin, so no plane copper lies inside one.
  const ring=[];for(let k=0;k<12;k++){const a=k*Math.PI/6,b=(k+1)*Math.PI/6;ring.push([10+.6*Math.cos(a),14+.6*Math.sin(a),10+.6*Math.cos(b),14+.6*Math.sin(b)]);}
  const records=[
    "RECORD=Board|LAYER1NAME=Top|LAYER1NEXT=39|LAYER39NAME=Internal plane|LAYER39NEXT=32|LAYER32NAME=Bottom|VX0=0mm|VY0=0mm|VX1=20mm|VY1=0mm|VX2=20mm|VY2=20mm|VX3=0mm|VY3=20mm",
    "RECORD=Net|ID=0|NAME=GND","RECORD=Net|ID=1|NAME=SIG",
    "RECORD=Polygon|POLYGONTYPE=Split Plane|LAYER=PLANE1|NET=0|VX0=1mm|VY0=1mm|VX1=19mm|VY1=1mm|VX2=19mm|VY2=19mm|VX3=1mm|VY3=19mm",
    ...ring.map(([x1,y1,x2,y2])=>"RECORD=Track|LAYER=PLANE1|X1="+x1+"mm|Y1="+y1+"mm|X2="+x2+"mm|Y2="+y2+"mm|WIDTH=1.016mm"),
    "RECORD=Via|X=6.123mm|Y=7.071mm|NET=1|DIAMETER=0.3mm|HOLESIZE=0.2mm|STARTLAYER=TOP|ENDLAYER=BOTTOM",
    "RECORD=Rule|RULEKIND=PlaneClearance|PRIORITY=1|SCOPE1EXPRESSION=All|SCOPE2EXPRESSION=All|CLEARANCE=0.0889mm"
  ];
  const {p}=example([]),b=AtriumPCB.read("Plane rules.PcbDoc",null,records.join("\r\n")).documents[0];
  p.documents[p.documents.indexOf(board(p))]=b;
  AtriumProjectRules.edit(p,set=>{const c=set.list.find(r=>r.type==="clearance");c.gap=.0889;c.objects={"via-poly":.127,"poly-hole":.25};});
  const lib=defs(p),o={project:p},zone=b.items.find(i=>i.kind==="polygon");
  assert.equal(zone.clearance,.0889);
  P.apply(b,lib,o);
  const regions=b.pcbDrawing.pours,via=b.items.find(i=>i.kind==="via"),at=r=>[via.x+r,via.y];
  assert.ok(!ink(regions,...at(.18))&&ink(regions,...at(.2)),"the antipad is the plane clearance from the 0.1 mm barrel");
  assert.deepEqual(D.verify(b,lib,null,o).violations.map(v=>v.title+" "+v.actual),[],"the plane is not held to the Via-Poly or Poly-Hole cells");
  const voids=b.items.filter(i=>i.planeVoid);
  assert.equal(voids.length,12);
  assert.deepEqual(AtriumPCBDraw.keepoutViolations(b,lib).filter(v=>v.id===zone.id),[],"no plane copper rounds into its voids");
}
{
  // A positive pour keeps the Poly-Hole cell from a foreign plated barrel as well as the
  // Via-Poly cell from its land, as Altium pours; DRC reports fill that does not.
  const zone=plane("holes",box(2,2,28,18),{removeDeadCopper:false}),via={id:"v",kind:"via",net:"SIG",layer:"Multi",x:15.0123,y:10.0071,diameter:.3,drill:.2};
  const {p,b,o,lib}=example([zone,via]);
  const cells=objects=>AtriumProjectRules.edit(p,set=>{const c=set.list.find(r=>r.type==="clearance");c.gap=.0889;c.objects=objects;});
  cells({"via-poly":.127});
  P.apply(b,lib,o);
  const at=r=>[via.x+r,via.y];
  assert.ok(ink(b.pcbDrawing.pours,...at(.3)),"without a hole cell the land's 0.127 mm governs");
  assert.deepEqual(D.verify(b,lib,null,o).violations,[]);
  cells({"via-poly":.127,"poly-hole":.25});
  const stale=D.verify(b,lib,null,o).violations;
  assert.equal(stale.length,1,JSON.stringify(stale));
  assert.equal(stale[0].what,"Hole clearance");assert.equal(stale[0].required,.25);assert.ok(Math.abs(stale[0].actual-.177)<.002,String(stale[0].actual));
  P.apply(b,lib,o);
  assert.ok(!ink(b.pcbDrawing.pours,...at(.34))&&ink(b.pcbDrawing.pours,...at(.36)),"0.25 mm from the 0.1 mm barrel");
  assert.deepEqual(D.verify(b,lib,null,o).violations,[]);
  // No Hole cell, no hole clearance (rules.js clearanceLimit): a general gap wider than the
  // Via-Poly cell does not reach past the land from the barrel, in the pour or in DRC.
  AtriumProjectRules.edit(p,set=>{const c=set.list.find(r=>r.type==="clearance");c.gap=.2;c.objects={"via-poly":.127};});
  assert.deepEqual(D.verify(b,lib,null,o).violations.filter(v=>v.what==="Hole clearance"),[],"no hole clearance without a Hole cell");
  P.apply(b,lib,o);
  assert.ok(!ink(b.pcbDrawing.pours,...at(.27))&&ink(b.pcbDrawing.pours,...at(.29)),"the land's 0.127 mm governs without a Hole cell");
  assert.deepEqual(D.verify(b,lib,null,o).violations,[]);
}
{
  // The hole cut follows the land's real outline: a custom land whose drill sits 0.2 mm from its
  // edge (its box is 2 × 1 mm) still keeps the Poly-Hole cell there, and DRC agrees with the fill.
  const zone=plane("custom",box(2,2,28,18),{removeDeadCopper:false});
  const land={id:"c",kind:"pad",net:"SIG",layer:"Multi",x:15,y:10,w:2,h:1,drill:.3,shape:"custom",number:"1",
    poly:[[-.2,-.5],[1.8,-.5],[1.8,.5],[-.2,.5]]};
  const {p,b,o,lib}=example([zone,land]);
  AtriumProjectRules.edit(p,set=>{const c=set.list.find(r=>r.type==="clearance");c.gap=.127;c.objects={"th-poly":.127,"poly-hole":.3};});
  P.apply(b,lib,o);
  assert.ok(!ink(b.pcbDrawing.pours,14.57,10)&&ink(b.pcbDrawing.pours,14.53,10),"0.3 mm from the 0.15 mm barrel, past the land's 0.127 mm");
  assert.deepEqual(D.verify(b,lib,null,o).violations,[]);
}
console.log("PASS authored hatch and negative split plane copper, slots and thermals");
