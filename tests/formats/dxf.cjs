"use strict";
// DXF reader/writer: bulge polylines, nested and mirrored block inserts,
// units, OCS, ellipses, splines, round trip through the board shape, and a
// 100k-entity file.
const assert=require("node:assert/strict");
for(const m of ["model","board-shape","board-shape-editing","board-shape-sources","dxf"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const X=AtriumDXF,S=AtriumBoardShape,A=Atrium;
const close=(a,b,eps=1e-6,m)=>assert.ok(Math.abs(a-b)<=eps,(m?m+": ":"")+a+" differs from "+b);
// Build DXF text from [code, value] pairs.
const dxf=(...sections)=>sections.flat().map(([c,v])=>c+"\n"+v).join("\n")+"\n0\nEOF\n";
const sec=(name,...pairs)=>[[0,"SECTION"],[2,name],...pairs.flat(),[0,"ENDSEC"]];
const header=units=>sec("HEADER",[[9,"$ACADVER"],[1,"AC1027"],[9,"$INSUNITS"],[70,units]]);

// Bulge LWPOLYLINE: a 20 x 10 slot with semicircular ends (stadium), mm.
{
  const b=1; // semicircle
  const text=dxf(header(4),sec("ENTITIES",[[0,"LWPOLYLINE"],[8,"Outline"],[90,4],[70,1],
    [10,5],[20,0],[42,0],[10,15],[20,0],[42,b],[10,15],[20,10],[42,0],[10,5],[20,10],[42,b]]));
  const r=X.read(text);
  assert.equal(r.units.name,"mm");assert.equal(r.units.assumed,false);
  assert.equal(r.layers[0].name,"Outline");assert.equal(r.layers[0].count,1);assert.equal(r.layers[0].types.LWPOLYLINE,1);
  const res=S.fromSegments(X.segments(r));
  assert.equal(res.loops,1);
  close(S.area(res.shape),10*10+Math.PI*25,1e-9,"stadium area");
  // Y is flipped: DXF y 0..10 becomes model -10..0.
  assert.deepEqual(S.bounds(res.shape).map(v=>+v.toFixed(9)),[0,-10,20,0]);
  assert.equal(res.shape.contour.filter(g=>g.kind==="arc").length,2);
}

// Inches and $MEASUREMENT fallback; units override.
{
  const ent=sec("ENTITIES",[[0,"LINE"],[8,"0"],[10,0],[20,0],[30,0],[11,1],[21,0],[31,0]]);
  const r=X.read(dxf(header(1),ent));assert.equal(r.units.name,"in");
  const s=X.segments(r);close(s[0].seg.b[0],25.4,1e-9,"inches to mm");
  const mils=X.segments(r,{mm:X.UNITS.mil});close(mils[0].seg.b[0],.0254,1e-12,"override");
  const imperial=X.read(dxf(sec("HEADER",[[9,"$MEASUREMENT"],[70,0]]),ent));
  assert.equal(imperial.units.name,"in");assert.equal(imperial.units.assumed,true);
  const bare=X.read(dxf(ent));assert.equal(bare.units.name,"mm");assert.equal(bare.units.assumed,true);
}

// Nested blocks: INNER holds a line on layer 0 and an arc on "Fixed". OUTER
// inserts INNER rotated 90 degrees, scaled 2. The drawing inserts OUTER
// mirrored (X scale -1) at (100, 0) on layer "Mech", as a 2 x 1 array.
{
  const blocks=sec("BLOCKS",
    [[0,"BLOCK"],[8,"0"],[2,"INNER"],[70,0],[10,1],[20,0],[30,0],
     [0,"LINE"],[8,"0"],[10,1],[20,0],[11,4],[21,0],
     [0,"ARC"],[8,"Fixed"],[10,1],[20,0],[40,1],[50,0],[51,90],
     [0,"ENDBLK"],[8,"0"]],
    [[0,"BLOCK"],[8,"0"],[2,"OUTER"],[70,0],[10,0],[20,0],[30,0],
     [0,"INSERT"],[8,"0"],[2,"INNER"],[10,0],[20,0],[41,2],[42,2],[50,90],
     [0,"ENDBLK"],[8,"0"]]);
  const ents=sec("ENTITIES",[[0,"INSERT"],[8,"Mech"],[2,"OUTER"],[10,100],[20,0],[41,-1],[42,1],[70,2],[71,1],[44,50],[45,0]]);
  const r=X.read(dxf(header(4),blocks,ents));
  const names=r.layers.map(l=>l.name).sort();assert.deepEqual(names,["Fixed","Mech"]);
  const lines=r.entities.filter(e=>e.type==="LINE"),arcs=r.entities.filter(e=>e.type==="ARC");
  assert.equal(lines.length,2);assert.equal(arcs.length,2);
  assert.ok(lines.every(e=>e.layer==="Mech"),"layer 0 inherits the insert layer");
  // INNER line (1,0)-(4,0) relative to base (1,0) -> (0,0)-(3,0); x2, rot 90 -> (0,0)-(0,6);
  // mirror X -> (0,0)-(0,6); +100 -> (100,0)-(100,6); model Y flipped.
  const l0=lines[0].segs[0];
  close(l0.a[0],100,1e-9);close(l0.a[1],0,1e-9);close(l0.b[0],100,1e-9);close(l0.b[1],-6,1e-9);
  // Array spacing follows the insert rotation but not its scale or mirror.
  close(lines[1].segs[0].a[0],150,1e-9,"array column");
  // Arc: centre at base -> origin, radius 2; quarter from 0..90 rotated to 90..180, mirrored to 0..90 clockwise.
  const a=arcs[0].segs[0];close(a.r,2,1e-9);close(a.c[0],100,1e-9);close(a.c[1],0,1e-9);
  close(Math.abs(S.sweep(a)),90,1e-9);
  const e=S.ends(a);close(e[0][0],100,1e-9);close(e[0][1],-2,1e-9);close(e[1][0],102,1e-9);close(e[1][1],0,1e-9);
}

// Recursive blocks stop with a warning instead of overflowing.
{
  const blocks=sec("BLOCKS",[[0,"BLOCK"],[2,"LOOP"],[10,0],[20,0],[0,"INSERT"],[8,"0"],[2,"LOOP"],[10,1],[20,0],[0,"LINE"],[8,"0"],[10,0],[20,0],[11,1],[21,0],[0,"ENDBLK"]]);
  const r=X.read(dxf(blocks,sec("ENTITIES",[[0,"INSERT"],[8,"L"],[2,"LOOP"],[10,0],[20,0]])));
  assert.ok(r.warnings.some(w=>/Recursive/.test(w)));assert.ok(r.entities.length>=1);
}

// OCS: an ARC with extrusion (0, 0, -1) is mirrored in X.
{
  const r=X.read(dxf(sec("ENTITIES",[[0,"ARC"],[8,"0"],[10,10],[20,0],[40,5],[50,0],[51,90],[210,0],[220,0],[230,-1]])));
  const g=r.entities[0].segs[0],[p0,p1]=S.ends(g);
  close(g.c[0],-10,1e-9);close(p0[0],-15,1e-9);close(p0[1],0,1e-9);close(p1[0],-10,1e-9);close(p1[1],-5,1e-9);
}

// Circles, ellipses (full and partial) and splines.
{
  const text=dxf(sec("ENTITIES",
    [[0,"CIRCLE"],[8,"C"],[10,0],[20,0],[40,3]],
    [[0,"ELLIPSE"],[8,"E"],[10,0],[20,0],[11,10],[21,0],[40,.5],[41,0],[42,2*Math.PI]],
    [[0,"ELLIPSE"],[8,"R"],[10,0],[20,0],[11,0],[21,4],[40,1],[41,0],[42,Math.PI]],
    // Quadratic B-spline equal to a Bezier through (0,0),(5,10),(10,0).
    [[0,"SPLINE"],[8,"S"],[70,8],[71,2],[72,6],[73,3],[40,0],[40,0],[40,0],[40,1],[40,1],[40,1],[10,0],[20,0],[10,5],[20,10],[10,10],[20,0]]));
  const r=X.read(text);
  const by=l=>r.entities.find(e=>e.layer===l);
  const circ=S.fromSegments(X.segments(r,{layers:["C"]}));close(S.area(circ.shape),9*Math.PI,1e-9,"circle");
  const ell=S.fromSegments(X.segments(r,{layers:["E"]}));// Chords sit inside the curve by at most 0.005 mm: area loss <= perimeter * 0.005.
  close(S.area(ell.shape),Math.PI*10*5,48.5*.005,"ellipse area");
  const half=by("R").segs[0];assert.equal(half.kind,"arc");close(Math.abs(S.sweep(half)),180,1e-9);close(half.r,4,1e-9);
  const sp=by("S").segs;assert.ok(sp.length>=8);
  // Bezier midpoint (t = 0.5) is (5, 5) -> model (5, -5).
  const mid=sp.map(g=>g.a).find(p=>Math.abs(p[0]-5)<1e-9);assert.ok(mid,"sampled at the middle");close(mid[1],-5,1e-9);
  assert.ok(r.warnings.some(w=>/Splines/.test(w))&&r.warnings.some(w=>/Ellipses/.test(w)));
}

// Anisotropic scale and rotation are applied before measuring chord error.
{
  const {pointSeg} = require("../support/segment-distance.cjs");
  const radius = 6, a = Math.PI / 6, tolerance = .001;
  const blocks = sec("BLOCKS", [[0,"BLOCK"],[2,"C"],[10,0],[20,0],
    [0,"ARC"],[10,0],[20,0],[40,radius],[50,0],[51,180],[0,"ENDBLK"]]);
  const entities = sec("ENTITIES", [[0,"INSERT"],[2,"C"],[10,3],[20,5],[41,8],[42,.25],[50,30]]);
  const [ellipse] = X.read(dxf(header(4), blocks, entities), {tolerance}).entities;
  assert.ok(ellipse.segs.every(seg => seg.kind === "line"));
  for (let i = 0; i <= 1024; i++) {
    const t = i * Math.PI / 1024, x = 8 * radius * Math.cos(t), y = .25 * radius * Math.sin(t);
    const at = [3 + x * Math.cos(a) - y * Math.sin(a), -5 - x * Math.sin(a) - y * Math.cos(a)];
    let error = Infinity;
    for (const seg of ellipse.segs) error = Math.min(error, pointSeg(at, seg.a, seg.b));
    assert.ok(error <= tolerance, "rotated DXF ellipse chord error " + error);
  }
}

// POLYLINE (R12) with VERTEX/SEQEND and bulge, plus skipped TEXT.
{
  const text=dxf(sec("ENTITIES",[[0,"POLYLINE"],[8,"P"],[66,1],[70,1],[10,0],[20,0],[30,0],
    [0,"VERTEX"],[8,"P"],[10,0],[20,0],[0,"VERTEX"],[8,"P"],[10,10],[20,0],[42,-1],[0,"VERTEX"],[8,"P"],[10,10],[20,10],[0,"VERTEX"],[8,"P"],[10,0],[20,10],[0,"SEQEND"],[8,"P"]],
    [[0,"TEXT"],[8,"P"],[10,0],[20,0],[40,1],[1,"hello"]]));
  const r=X.read(text);
  assert.equal(r.entities.length,1);assert.ok(r.warnings.some(w=>/TEXT/.test(w)));
  const res=S.fromSegments(X.segments(r));
  // Square 10 x 10 with the right side bulging inward (clockwise semicircle).
  close(S.area(res.shape),100-Math.PI*25/2,1e-9,"inward bulge");
}

// Malformed input.
assert.throws(()=>X.read("AutoCAD Binary DXF\r\n\x1a\0"),/Binary DXF/);
assert.throws(()=>X.read("hello\nworld\n"),/Malformed DXF|not an ASCII DXF/);
assert.throws(()=>X.read("999\ncomment\n"),/not an ASCII DXF/);

// Round trip: a rounded board with a slot and a circular cutout, plus a
// mechanical layer and holes, exported and read back.
for(const mode of ["polyline","primitives"])for(const units of ["mm","in"]){
  const doc=A.sheet("pcb","RT"),c={style:"radius",size:3};
  let s=S.rect({x:5,y:45,width:60,height:40,corners:{bl:c,br:{style:"chamfer",size:2},tr:c,tl:c}});
  s=S.addCutout(s,S.circle(6,[20,25]).contour);
  s=S.addCutout(s,S.rect({x:35,y:35,width:15,height:6,corners:{bl:{style:"radius",size:3},br:{style:"radius",size:3},tr:{style:"radius",size:3},tl:{style:"radius",size:3}}}).contour);
  S.apply(doc,s);
  doc.items.push({id:"m",kind:"graphic",layer:"Mechanical 2",width:.1,points:[[0,0],[70,0],[70,50]]});
  doc.items.push({id:"h",kind:"pad",x:10,y:10,w:3,h:3,drill:3,shape:"round",layer:"Multi",number:"",plated:false});
  const out=X.exportBoard(doc,new Map(),{layers:["Mechanical 2"],holes:true,units,mode});
  assert.ok(out.text.startsWith("0\nSECTION\n2\nHEADER"));
  const r=X.read(out.text);
  assert.equal(r.units.name,units);
  assert.deepEqual(r.layers.filter(l=>l.count).map(l=>l.name).sort(),["BOARD_OUTLINE","HOLES","MECHANICAL_2"]);
  assert.ok(r.layers.some(l=>l.name==="0"&&!l.count),"empty table layers are listed");
  const back=S.fromSegments(X.segments(r,{layers:["BOARD_OUTLINE"]}),{source:"dxf"});
  assert.equal(back.shape.cutouts.length,2);
  close(S.area(back.shape),S.area(doc.boardShape),units==="mm"?1e-6:1e-5,"round trip area "+mode+" "+units);
  close(S.perimeter(back.shape),S.perimeter(doc.boardShape),1e-5,"round trip perimeter");
  assert.deepEqual(S.bounds(back.shape).map(v=>+v.toFixed(5)),S.bounds(doc.boardShape).map(v=>+v.toFixed(5)));
  assert.equal(back.shape.contour.filter(g=>g.kind==="arc").length,3,"arcs survive");
  const hole=r.entities.find(e=>e.layer==="HOLES");close(hole.segs[0].r*r.units.mm,1.5,1e-6);
  // Board-relative origin puts the lower-left corner at (0, 0).
  const rel=X.read(X.exportBoard(doc,new Map(),{origin:"board",units}).text);
  const b=X.preview(rel).bounds;close(b[0],0,1e-9);close(b[3],0,1e-9);
}

// Preview paths use SVG arcs and cap the segment count.
{
  const r=X.read(dxf(sec("ENTITIES",[[0,"CIRCLE"],[8,"C"],[10,0],[20,0],[40,3]],[[0,"LINE"],[8,"L"],[10,0],[20,0],[11,1],[21,1]])));
  const p=X.preview(r);assert.equal(p.paths.length,2);assert.ok(/A3 3 0 0 0/.test(p.paths.find(x=>x.layer==="C").d));
  assert.equal(X.preview(r,{maxSegments:1}).truncated,true);
}

// 100k entities: streaming read stays fast.
{
  const parts=["0\nSECTION\n2\nENTITIES\n"];
  for(let i=0;i<100000;i++){const x=i%1000,y=(i/1000)|0;parts.push("0\nLINE\n8\nGRID\n10\n"+x+"\n20\n"+y+"\n30\n0\n11\n"+(x+.5)+"\n21\n"+y+"\n31\n0\n");}
  parts.push("0\nENDSEC\n0\nEOF\n");
  const text=parts.join("");
  const t=Date.now(),r=X.read(text),ms=Date.now()-t;
  assert.equal(r.entities.length,100000);assert.equal(r.layers[0].count,100000);
  console.log("100k LINE entities ("+(text.length/1e6).toFixed(1)+" MB) read in "+ms+" ms");
  assert.ok(ms<5000);
}
// A malformed DXF line must not acquire a vertex on the origin axes.
{
  const text = dxf(header(4), sec("ENTITIES", [
    [0,"LINE"],[8,"Bad"],[10,"oops"],[20,5],[11,10],[21,5],
    [0,"LINE"],[8,"Good"],[10,0],[20,5],[11,10],[21,5]
  ]));
  const drawing = X.read(text);
  assert.deepEqual(drawing.entities.map(entity => entity.layer), ["Good"]);
  assert.deepEqual(drawing.entities[0].segs[0].a, [0, -5]);
  assert.ok(drawing.warnings.some(warning => /malformed coordinates/.test(warning)));
}
// Every entity reads its geometry like LINE: a malformed value skips the entity (with a warning)
// instead of becoming NaN or 0.
{
  const good = [[0,"LINE"],[8,"Good"],[10,0],[20,5],[11,10],[21,5]];
  const cases = {
    "polylines": [[0,"LWPOLYLINE"],[8,"Bad"],[90,2],[70,0],[10,0],[20,0],[10,"oops"],[20,5]],
    "polylines bulge": [[0,"LWPOLYLINE"],[8,"Bad"],[90,2],[70,0],[10,0],[20,0],[42,"x"],[10,5],[20,5]],
    "arcs": [[0,"ARC"],[8,"Bad"],[10,"nope"],[20,1],[40,2],[50,0],[51,90]],
    "arcs angle": [[0,"ARC"],[8,"Bad"],[10,0],[20,1],[40,2],[50,"?"],[51,90]],
    "circles": [[0,"CIRCLE"],[8,"Bad"],[10,0],[20,"y"],[40,2]],
    "ellipses": [[0,"ELLIPSE"],[8,"Bad"],[10,0],[20,0],[11,"a"],[21,0],[40,.5]],
    "splines": [[0,"SPLINE"],[8,"Bad"],[70,0],[71,1],[11,0],[21,0],[11,"b"],[21,1]],
    "polylines vertex": [[0,"POLYLINE"],[8,"Bad"],[66,1],[70,0],[0,"VERTEX"],[8,"Bad"],[10,0],[20,0],[0,"VERTEX"],[8,"Bad"],[10,"c"],[20,4],[0,"SEQEND"]],
    "block inserts": [[0,"INSERT"],[8,"Bad"],[2,"B"],[10,"d"],[20,0]],
  };
  const block = sec("BLOCKS",[[0,"BLOCK"],[8,"0"],[2,"B"],[10,0],[20,0],[0,"LINE"],[8,"0"],[10,0],[20,0],[11,1],[21,0],[0,"ENDBLK"]]);
  for (const [name, entity] of Object.entries(cases)) {
    const drawing = X.read(dxf(header(4), block, sec("ENTITIES", entity, good)));
    assert.deepEqual(drawing.entities.map(e => e.layer), ["Good"], name);
    assert.ok(drawing.entities.every(e => e.segs.every(g => JSON.stringify(g).indexOf("null") < 0)), name);
    assert.ok(drawing.warnings.some(w => w.startsWith("DXF " + name.split(" ")[0]) && /malformed coordinates were skipped/.test(w)), name + ": " + drawing.warnings);
  }
  // A block whose base point is malformed is not defined, so its inserts are skipped.
  const badBase = X.read(dxf(header(4), sec("BLOCKS",[[0,"BLOCK"],[8,"0"],[2,"B"],[10,"e"],[20,0],[0,"LINE"],[8,"0"],[10,0],[20,0],[11,1],[21,0],[0,"ENDBLK"]]),
    sec("ENTITIES",[[0,"INSERT"],[8,"Ins"],[2,"B"],[10,0],[20,0]], good)));
  assert.deepEqual(badBase.entities.map(e => e.layer), ["Good"]);
  assert.ok(badBase.warnings.some(w => /malformed base point/.test(w)));
}

console.log("dxf tests passed");
