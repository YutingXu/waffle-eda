"use strict";
// True-arc polygon pours: clearance cut-outs and reliefs around round pads
// and vias keep true arcs (region.arcs) next to their polyline, the Gerber
// writer plots them as G02/G03 inside regions, and gerber-check accepts them.
const assert=require("node:assert/strict");
if(!globalThis.performance)globalThis.performance={now:()=>Date.now()};
for(const m of ["model","parts","spatial","pcb-pours","pcb-appearance","zip","vectorize","pcb-text-rich","pcb-text","stackup","rules","viastack","board-shape","polygon-pour","bom","fab-outputs"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const {check}=require("../formats/gerber-check.cjs");
const PP=AtriumPolygonPour,A=Atrium,F=AtriumFabOutputs;
const rect=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
const rules={format:"atrium-rules",version:1,units:"mm",defaults:{clearance:.2,trackWidth:.15,viaDrill:.3},nets:{}};
let nid=0;const id=()=>"a"+(++nid);
const via=(x,y,net,d=.6)=>({id:id(),kind:"via",x,y,diameter:d,drill:.3,layer:"Multi",net});
function arcsOf(regs){const out=[];for(const r of regs)if(r.arcs)for(let k=0;k<r.arcs.length;k+=5)out.push({region:r,ring:r.arcs[k],i0:r.arcs[k+1],i1:r.arcs[k+2],c:[r.arcs[k+3],r.arcs[k+4]]});return out;}
function arcRadii(a){const ring=PP.rings(a.region)[a.ring],n=ring.length>>1,out=[];for(let v=a.i0;v<=a.i1;v++){const w=v%n;out.push(Math.hypot(ring[2*w]-a.c[0],ring[2*w+1]-a.c[1]));}return out;}

{
  const {pointSeg} = require("../support/segment-distance.cjs");
  const {rounded, offsetRing} = PP._internal, radius = .5, tolerance = .0127;
  const points = flat => Array.from({length: flat.length / 2}, (_, i) => flat.slice(2 * i, 2 * i + 2));
  const chord = flat => {
    const ring = points(flat);
    return Math.min(...ring.map((a, i) => pointSeg([0, 0], a, ring[(i + 1) % ring.length])));
  };
  const outside = rounded([[0, 0]], radius, tolerance, "outer", []);
  const inside = rounded([[0, 0]], radius, tolerance, "inner");
  assert.ok(chord(outside) >= radius - 1e-10, "round clearance chords stay outside the true cutter");
  assert.ok(chord(inside) >= radius - tolerance && chord(inside) < radius, "relief chords remain inscribed within tolerance");

  const corners = [0, 0, 3, 0, 3, 2, 0, 2], arcs = [];
  const offset = offsetRing(corners, radius, tolerance, arcs);
  assert.ok(chord(offset) >= radius - 1e-10, "offset corner chords stay outside the true cutter");
  assert.ok(arcs.length > 0 && offset.av.some(id => id >= 0), "offset keeps arc provenance");
  const workerOffset = Function("const TAU=Math.PI*2;const {step:roundStep,envelope:roundEnvelope}="
    + AtriumGeometryCurves.roundProjectionSource() + ";return " + offsetRing.toString())();
  const workerArcs = [];
  assert.deepEqual(workerOffset(corners, radius, tolerance, workerArcs), offset, "serialized tile offset");
  assert.deepEqual(workerArcs, arcs, "serialized tile arc provenance");
}

// 1. An isolated foreign via: one hole, a full circle stored as two arcs.
{
  const p=PP.make(rect(0,0,20,20),{net:"GND",layer:"Top",removeDeadCopper:false});
  const d={kind:"pcb",items:[via(10,10,"SIG"),p],outline:rect(-1,-1,21,21),rules};
  const regs=PP.pour(d,null,p,{}),arcs=arcsOf(regs);
  assert.equal(regs.length,1);
  assert.equal(arcs.length,2,"the via hole is two arcs");
  for(const a of arcs){
    assert.ok(Math.hypot(a.c[0]-10,a.c[1]-10)<1e-4,"centred on the via");
    const rs=arcRadii(a);
    for(const r of rs){assert.ok(r>=.3+.2-1e-6,"never inside the clearance ("+r+")");assert.ok(r<=.5+.0127+1e-4,"within the arc approximation");}
    assert.ok(Math.max(...rs)-Math.min(...rs)<2e-5,"every run vertex is on one circle");
  }
  const rs=PP.rings(regs[0]),n=rs[1].length>>1;
  assert.deepEqual(arcs.map(a=>[a.ring,a.i0,a.i1]).sort((x,y)=>x[1]-y[1]),[[1,0,n>>1],[1,n>>1,n]]);
  // Polyline fallback.
  assert.equal(arcsOf(PP.pour(d,null,p,{arcs:false})).length,0,"arcs:false keeps polylines only");
}
// 2. Overlapping clearances: runs end where the circles meet; relief annuli are arcs too.
{
  const p=PP.make(rect(0,0,20,20),{net:"GND",layer:"Top",connectStyle:"relief",viaConnectStyle:"relief"});
  const d={kind:"pcb",items:[via(10,10,"SIG"),via(10.7,10,"SIG"),via(5,5,"GND",2),p],outline:rect(-1,-1,21,21),rules};
  const regs=PP.pour(d,null,p,{}),arcs=arcsOf(regs);
  assert.ok(arcs.length>=4,"merged via holes and the relief gap between spokes ("+arcs.length+")");
  assert.ok(arcs.some(a=>Math.hypot(a.c[0]-5,a.c[1]-5)<1e-4),"relief annulus arcs");
  for(const a of arcs){const rs=arcRadii(a);assert.ok(Math.max(...rs)-Math.min(...rs)<2e-5);}
}
// 3. Gerber: arcs inside regions, the checker accepts them, and the arcs
// match the polyline within the arc approximation.
{
  const p=A.project("Arcs",AtriumParts.catalogue),pcb=p.documents.find(d=>d.kind==="pcb");
  pcb.items=[];pcb.outline=rect(0,0,30,20);AtriumRules.store(pcb,p,AtriumRules.migrate(rules));
  for(let k=0;k<12;k++)pcb.items.push(via(3+k*2,6+(k%3)*.45,k%2?"SIG":"GND"));
  pcb.items.push({id:id(),kind:"track",layer:"Top",net:"SIG",width:.25,points:[[2,14],[28,14]]});
  pcb.items.push(PP.make(rect(1,1,29,19),{net:"GND",layer:"Top"}),PP.make(rect(1,1,29,19),{net:"GND",layer:"Bottom"}));
  PP.apply(pcb,new Map(p.library.map(x=>[x.id,x])),{project:p});
  assert.ok(arcsOf(pcb.pcbDrawing.pours).length>10);
  const out=F.build(p,pcb,{date:new Date(2026,10,18)});
  const top=out.files.find(f=>f.kind==="gerber"&&/Copper,L1,Top/.test(f.content));
  assert.ok(top,"top copper Gerber");
  const region=top.content.slice(top.content.indexOf("G36*"));
  assert.ok(/G0[23]X-?\d+Y-?\d+I-?\d+J-?\d+D01\*/.test(region),"G02/G03 arcs inside pour regions");
  for(const f of out.files.filter(f=>f.kind==="gerber"))assert.deepEqual(check(f.content,{x2:true}).issues,[],f.name);
  // Every arc keeps a radius consistent to 2 nm (the checker's tolerance).
  // Plotting without arc metadata still works (polyline fallback).
  const plain=JSON.parse(JSON.stringify(pcb));
  const p2={...p,documents:p.documents.map(d=>d.id===pcb.id?plain:d)};
  const defs=new Map(p2.library.map(d=>[d.id,d]));
  PP.apply(plain,defs,{project:p2,arcs:false});
  assert.equal(arcsOf(plain.pcbDrawing.pours).length,0,"the committed fallback contains only polylines");
  assert.deepEqual(PP.stale(plain,defs,{project:p2}),[]);
  const flat=F.build(p2,plain,{date:new Date(2026,10,18)}).files.find(f=>f.kind==="gerber"&&/Copper,L1,Top/.test(f.content));
  assert.ok(!/G0[23]X/.test(flat.content.slice(flat.content.indexOf("G36*"))),"no arcs without metadata");
  assert.deepEqual(check(flat.content,{x2:true}).issues,[]);
  assert.ok(top.content.length<flat.content.length,"arcs make the file smaller ("+top.content.length+" vs "+flat.content.length+")");
}
// A sample close to the start rounds onto a neighbouring horizontal tick.
// The stored circle still determines the centre and the direction of the pour arc.
{
  const project = A.project("Arc centre"), pcb = project.documents.find(doc => doc.kind === "pcb");
  pcb.outline = rect(10, 2, 25, 18);
  const radius = 4, angle = Math.PI / 4, sweep = Math.PI / 3, tick = 1e-6;
  const start = [20 + .51 * tick, 10 + .9 * tick];
  const center = [start[0] - radius * Math.cos(angle), start[1] + radius * Math.sin(angle)];
  const at = t => [center[0] + radius * Math.cos(t), center[1] - radius * Math.sin(t)];
  const ring = [start, at(angle + 5e-8), at(angle + .5), at(angle + sweep), center];
  const ticks = ([x, y]) => [Math.round(x / tick), Math.round(-y / tick)];
  const [x, y] = ticks(start);
  assert.deepEqual(ticks(ring[1]), [x - 1, y]);
  pcb.pcbDrawing = {pours: [AtriumPCBPours.region([ring], "Top", "GND", {arcs: [0, 0, 3, ...center]})]};
  AtriumPCBPours.storeSignature(pcb, new Map(), project);
  const output = F.build(project, pcb, {date: new Date("2025-01-01T12:00:00Z"), origin: "absolute", format: "4:6"});
  const film = output.files.find(file => file.name.endsWith(".GTL")).content;
  const arc = /G36\*[\r\n]+X(-?\d+)Y(-?\d+)D02\*[\r\n]+(G0[23])X(-?\d+)Y(-?\d+)I(-?\d+)J(-?\d+)D01\*/.exec(film);
  assert.ok(arc, "the stored run plots as one arc inside a region");
  const [, x0, y0, mode, x1, y1, i, j] = arc;
  assert.deepEqual([+x0, +y0], [x, y]);
  assert.deepEqual([+x1, +y1], ticks(ring[3]));
  assert.equal(mode, "G03");
  assert.deepEqual([+x0 + +i, +y0 + +j], ticks(center));
}
// 4. Dense random clutter: every arc run is safe (gerber-check finds no
// crossing or touching contour anywhere).
{
  const p=A.project("Clutter",AtriumParts.catalogue),pcb=p.documents.find(d=>d.kind==="pcb");
  pcb.items=[];pcb.outline=rect(0,0,24,24);pcb.rules=rules;
  let seed=11;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let k=0;k<160;k++)pcb.items.push(via(1+rnd()*22,1+rnd()*22,["GND","A","B"][k%3],.45+rnd()*.4));
  for(let k=0;k<40;k++){const x=1+rnd()*20,y=1+rnd()*20;pcb.items.push({id:id(),kind:"track",layer:"Top",net:k%2?"A":"B",width:.15+rnd()*.2,points:[[x,y],[x+rnd()*3,y+rnd()*3]]});}
  pcb.items.push(PP.make(rect(.5,.5,23.5,23.5),{net:"GND",layer:"Top",connectStyle:"relief",viaConnectStyle:"relief"}));
  PP.apply(pcb,new Map(p.library.map(x=>[x.id,x])),{project:p});
  const n=arcsOf(pcb.pcbDrawing.pours).length;assert.ok(n>50,"many arcs ("+n+")");
  const out=F.build(p,pcb,{date:new Date(2026,10,18)});
  for(const f of out.files.filter(f=>f.kind==="gerber"))assert.deepEqual(check(f.content,{x2:true}).issues,[],f.name);
}
console.log("pour-arcs ok");
