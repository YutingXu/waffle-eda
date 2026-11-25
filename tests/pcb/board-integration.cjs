"use strict";
// Integration of the board shape with the patched shared modules (run from a
// patched copy of app/): Altium Board6 arcs, Gerber profile arcs and cutouts,
// KiCad Edge.Cuts arcs, project validation and canvas even-odd board fill.
const assert=require("node:assert/strict");
for(const m of ["model","eco","source-file","io","pcb-pours","altium-rules","pcb-import","pcb-appearance","spatial","canvas","connectivity","kicad-export","parts","zip","fab-outputs","board-shape","board-shape-editing","dxf"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const A=Atrium,S=AtriumBoardShape,F=AtriumFabOutputs,K=AtriumKiCad;
const close=(a,b,eps=1e-6,m)=>assert.ok(Math.abs(a-b)<=eps,(m?m+": ":"")+a+" differs from "+b);
function props(text){const raw=Buffer.from("|"+text+"\0","latin1"),length=Buffer.alloc(4);length.writeUInt32LE(raw.length);return Buffer.concat([length,raw]);}

// Altium Board6 perimeter with two corner arcs, listed both ways round.
const area=1200-2*25*(1-Math.PI/4);
for(const reversed of [false,true]){
  // Altium coordinates, Y up. Vertices (5,0) (35,0)~arc~(40,5) (40,30) (0,30) (0,5)~arc~(5,0).
  let v=[{p:[5,0]},{p:[35,0],arc:[35,5,270,360]},{p:[40,5]},{p:[40,30]},{p:[0,30]},{p:[0,5],arc:[5,5,180,270]}];
  if(reversed){
    // Clockwise listing: each arc moves to the vertex that now starts its edge.
    const n=v.length,out=[];
    for(let i=0;i<n;i++){const cur=v[(n-i)%n],prev=v[(2*n-i-1)%n];out.push({p:cur.p,arc:prev.arc});}
    v=out;
  }
  const text=v.map((x,i)=>"VX"+i+"="+x.p[0]+"mm|VY"+i+"="+x.p[1]+"mm|KIND"+i+"="+(x.arc?1:0)+(x.arc?"|CX"+i+"="+x.arc[0]+"mm|CY"+i+"="+x.arc[1]+"mm|SA"+i+"="+x.arc[2]+"|EA"+i+"="+x.arc[3]:"")).join("|");
  const doc=AtriumPCB.read("Arc.PcbDoc",new Map([["board6/data",props(text)],["nets6/data",props("NAME=GND")]]),null,{}).documents[0];
  assert.ok(doc.boardShape,"exact shape kept");assert.equal(doc.boardShape.sig,undefined);
  assert.equal(S.fresh(doc),doc.boardShape,"importer shape accepted without a signature");
  close(S.area(doc.boardShape),area,1e-6,"Board6 exact area");
  assert.equal(doc.boardShape.contour.filter(g=>g.kind==="arc").length,2);
  // Flattened outline: vertices on the arcs, chord error within 0.005 mm.
  let worst=0;const pts=doc.outline;
  for(let i=0;i<pts.length;i++){const a=pts[i],b=pts[(i+1)%pts.length],m=[(a[0]+b[0])/2,(a[1]+b[1])/2];
    for(const c of [[35,-5],[5,-5]])if(Math.hypot(a[0]-c[0],a[1]-c[1])<5.0001&&Math.hypot(b[0]-c[0],b[1]-c[1])<5.0001&&Math.hypot(m[0]-c[0],m[1]-c[1])<5)worst=Math.max(worst,5-Math.hypot(m[0]-c[0],m[1]-c[1]));}
  assert.ok(worst>0&&worst<=.005+1e-9,"importer chord error "+worst);
  close(Math.abs(S.polyArea(pts)),area,40*.005,"flattened area");
}

// A board with arcs and two cutouts through fabrication and KiCad outputs.
const project=A.project("Shape",[]),doc=project.documents[1];doc.name="Shape";
const c={style:"radius",size:4};
let shape=S.rect({x:0,y:0,width:50,height:30,corners:{bl:c,br:c,tr:c,tl:c}});
shape=S.addCutout(shape,S.circle(6,[15,-15]).contour);
shape=S.addCutout(shape,S.rect({x:30,y:-10,width:10,height:10,corners:{}}).contour);
S.apply(doc,shape);S.setOrigin(doc,[0,0]);
A.validate(project);
{
  const bad=JSON.parse(JSON.stringify(project));bad.documents[1].boardShape.contour[0]={kind:"arc",c:[0,0],r:-1};
  assert.throws(()=>A.validate(bad),/Invalid Waffle editor model\.$/);
  const badOrigin=JSON.parse(JSON.stringify(project));badOrigin.documents[1].origin=[1];
  assert.throws(()=>A.validate(badOrigin),/Invalid Waffle editor model\.$/);
}
{
  const r=F.build(project,doc,{date:new Date(2026,10,18)}),gm1=r.files.find(f=>/\.GM1$/.test(f.name)).content;
  const body=gm1.split("\n");
  assert.equal(body.filter(l=>/D02\*$/.test(l)).length,3,"one stroke per contour");
  const arcs=body.filter(l=>/^G0[23]X/.test(l));assert.equal(arcs.length,4+2,"four corners and a circle cutout (two halves)");
  assert.ok(arcs.slice(0,4).every(l=>l.startsWith("G03")),"outer corners counter-clockwise");
  // Each arc's centre is equidistant from its start and end (integer units, 4:4 mm).
  let cur=null;
  for(const l of body){
    const m=/X(-?\d+)Y(-?\d+)(?:I(-?\d+)J(-?\d+))?D0([12])\*$/.exec(l);if(!m)continue;
    const p=[+m[1],+m[2]];
    if(m[3]!=null){const k=[cur[0]+ +m[3],cur[1]+ +m[4]];assert.ok(Math.abs(Math.hypot(p[0]-k[0],p[1]-k[1])-Math.hypot(cur[0]-k[0],cur[1]-k[1]))<=2,"arc radius consistent: "+l);}
    cur=p;
  }
  assert.ok(gm1.includes("G01*"),"returns to linear mode");
}
{
  const out=K.exportBoard(project,doc.id).content;
  const edge=out.split("\n").filter(l=>/Edge\.Cuts/.test(l));
  assert.equal(edge.filter(l=>l.includes("(gr_arc")).length,4+2,"four corners and the two halves of the circular cutout");
  assert.equal(edge.filter(l=>l.includes("(gr_circle")).length,0,"circle cutout stays two arcs");
  assert.equal(edge.filter(l=>l.includes("(gr_line")).length,4+4);
  const arc=edge.find(l=>l.includes("(gr_arc"));assert.ok(/\(start [\d.-]+ [\d.-]+\) \(mid [\d.-]+ [\d.-]+\) \(end/.test(arc));
  // A full-circle single segment exports as gr_circle.
  const p2=JSON.parse(JSON.stringify(project)),d2=p2.documents[1];
  S.apply(d2,{version:1,contour:S.rect({x:0,y:0,width:50,height:30}).contour,cutouts:[[S.arc([10,-10],2,0,0,true)]]});
  const c2=K.exportBoard(p2,d2.id).content;assert.equal((c2.match(/\(gr_circle \(center 10 -10\) \(end 12 -10\)/g)||[]).length,1);
  // Without a board shape the old polygon export is unchanged.
  const p3=JSON.parse(JSON.stringify(project)),d3=p3.documents[1];delete d3.boardShape;
  assert.ok(!K.exportBoard(p3,d3.id).content.includes("gr_arc"));
}

// Canvas: cutouts use the even-odd rule for the board fill and grid clip;
// the origin marker follows doc.origin; handles draw when requested.
{
  const calls=[];
  const ctx=new Proxy({fill(...a){calls.push(["fill",...a]);},clip(...a){calls.push(["clip",...a]);},rect(...a){calls.push(["rect",...a]);},arc(...a){calls.push(["arc",...a]);}},{get:(o,k)=>o[k]??(()=>{})});
  const view=AtriumCanvas.create({getContext:()=>ctx,getBoundingClientRect:()=>({width:800,height:600})});
  view.fit(doc,new Map(),"board");
  view.render(doc,new Map(),{});
  assert.ok(calls.some(c=>c[0]==="fill"&&c[1]==="evenodd"),"board fill even-odd");
  assert.ok(calls.some(c=>c[0]==="clip"&&c[1]==="evenodd"),"grid clip even-odd");
  calls.length=0;S.setOrigin(doc,[50,-30]);
  view.render(doc,new Map(),{boardHandles:S.vertices(doc.boardShape)});
  const at=view.worldToScreen([50,-30]),marker=calls.find(c=>c[0]==="arc"&&c[3]===5);
  assert.ok(marker&&Math.abs(marker[1]-(Math.round(at[0])+.5))<1e-9&&Math.abs(marker[2]-(Math.round(at[1])+.5))<1e-9,"origin marker at doc.origin");
  assert.equal(calls.filter(c=>c[0]==="rect").length,S.vertices(doc.boardShape).filter(h=>h.type==="vertex").length,"vertex handles");
  // No cutouts: unchanged non-zero fill.
  calls.length=0;const plain=A.sheet("pcb","P");plain.outline=[[0,0],[10,0],[10,10]];view.render(plain,new Map(),{});
  assert.ok(!calls.some(c=>c[1]==="evenodd"));
}
console.log("board integration passed");
