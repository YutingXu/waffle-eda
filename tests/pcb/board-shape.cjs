"use strict";
// Board shape geometry: chaining, flattening tolerance, exact area/bounds,
// parametric rectangles, wizard presets, vertex edits, offset and origin.
const assert=require("node:assert/strict");
for(const m of ["model","board-shape","board-shape-editing","board-shape-sources"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const S=AtriumBoardShape,A=Atrium;
const close=(a,b,eps=1e-6,m)=>assert.ok(Math.abs(a-b)<=eps,(m?m+": ":"")+a+" differs from "+b);
const D=Math.PI/180;

// Seeded shuffle so failures reproduce.
let seed=12345;const rnd=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
const shuffle=a=>{for(let i=a.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};

// Exact area of a rounded rectangle: w*h - (4 - pi) r^2.
{
  const w=60,h=40,r=5,c={style:"radius",size:r};
  const s=S.rect({x:10,y:50,width:w,height:h,corners:{bl:c,br:c,tr:c,tl:c}});
  close(S.area(s),w*h-(4-Math.PI)*r*r,1e-9,"rounded rect area");
  close(S.perimeter(s),2*(w+h)-8*r+2*Math.PI*r,1e-9,"rounded rect perimeter");
  assert.deepEqual(S.bounds(s).map(v=>+v.toFixed(9)),[10,10,70,50]);
  assert.equal(S.contains(s,[11,11]),false,"rounded corner excludes the corner point");
  assert.equal(S.contains(s,[40,30]),true);
  assert.equal(S.contains(s,[15,15]),true,"inside near the arc");
  // Analysis round-trips the parameters.
  const p=S.analyze(s);
  assert.deepEqual(p,{x:10,y:50,width:60,height:40,corners:{bl:c,br:c,tr:c,tl:c}});
  // Mixed corners.
  const m=S.rect({x:0,y:0,width:30,height:20,corners:{bl:{style:"chamfer",size:2},tr:{style:"radius",size:3}}});
  close(S.area(m),600-2-(4-Math.PI)*9/4,1e-9,"mixed corners area");
  assert.deepEqual(S.analyze(m).corners,{bl:{style:"chamfer",size:2},br:{style:"sharp",size:0},tr:{style:"radius",size:3},tl:{style:"sharp",size:0}});
}

// Flatten tolerance: every chord deviates at most 0.005 mm from its arc.
{
  for(const r of [.3,2,25,400]){
    const s=S.circle(2*r,[1,2]),f=S.flatten(s,.005).outline;
    let worst=0;
    for(let i=0;i<f.length;i++){
      const a=f[i],b=f[(i+1)%f.length],m=[(a[0]+b[0])/2,(a[1]+b[1])/2];
      worst=Math.max(worst,r-Math.hypot(m[0]-1,m[1]-2));
      close(Math.hypot(a[0]-1,a[1]-2),r,2e-6,"vertex on circle");
    }
    assert.ok(worst<=.005+1e-6,"chord error "+worst+" at r="+r);
    assert.ok(worst>.0015||r<1,"not grossly over-tessellated at r="+r+" ("+worst+")");
    close(S.area(s),Math.PI*r*r,1e-9,"circle area");
  }
}

// Chaining: shuffled, reversed segments of a rounded board with a slot cutout,
// expressed as polylines like imported tracks and arcs, with one gap.
{
  const c={style:"radius",size:4},outer=S.rect({x:0,y:0,width:50,height:30,corners:{bl:c,br:c,tr:c,tl:c}});
  const slot=S.rect({x:20,y:-10,width:10,height:4,corners:{bl:{style:"radius",size:2},br:{style:"radius",size:2},tr:{style:"radius",size:2},tl:{style:"radius",size:2}}});
  const items=[];let n=0;
  // Arcs as 6 degree tessellated polylines (as pcb-import produces), lines as two-point tracks.
  const add=(g,flip)=>{
    let pts=g.kind==="arc"?(()=>{const w=S.sweep(g),k=Math.max(2,Math.ceil(Math.abs(w)/6));return Array.from({length:k+1},(_,i)=>S.pointAt(g.c,g.r,g.start+w*i/k));})():[g.a,g.b];
    if(flip)pts=pts.slice().reverse();
    // 3 um endpoint noise, within the 10 um tolerance.
    pts=pts.map((p,i)=>i===0||i===pts.length-1?[p[0]+.003*(rnd()-.5),p[1]+.003*(rnd()-.5)]:p);
    items.push({id:"g"+(++n),kind:n%2?"graphic":"track",layer:"Mechanical 1",width:.1,points:pts});
  };
  for(const g of [...outer.contour,...slot.contour])add(g,rnd()<.5);
  shuffle(items);
  const doc=A.sheet("pcb","B");doc.items=items;
  const ids=items.map(i=>i.id);
  const r=S.fromItems(doc,ids);
  assert.equal(r.loops,2);assert.equal(r.gaps.length,0);
  assert.ok(r.shape);assert.equal(r.shape.cutouts.length,1);
  close(S.area(r.shape),S.area(outer)-S.area(slot),.01,"chained area");
  // Arcs were recognised rather than kept as chords.
  assert.equal(r.shape.contour.filter(g=>g.kind==="arc").length,4,"outer arcs recognised");
  assert.equal(r.shape.cutouts[0].filter(g=>g.kind==="arc").length,4,"slot corner arcs recognised");
  // Outer is counter-clockwise on screen (negative model area), cutouts clockwise.
  assert.ok(S.signedArea(r.shape.contour)<0);assert.ok(S.signedArea(r.shape.cutouts[0])>0);
  // Remove one straight edge: one gap with a location, no closed outer loop.
  const edge=items.find(i=>i.points.length===2&&Math.abs(i.points[0][1]-i.points[1][1])<.01&&Math.abs(i.points[0][1])<.01);
  const r2=S.fromItems(doc,ids.filter(id=>id!==edge.id));
  assert.equal(r2.loops,1,"only the slot closes");
  assert.equal(r2.gaps.length,1);
  close(r2.gaps[0].distance,42,.01,"gap length");
  close(r2.gaps[0].at[0],25,.01);close(r2.gaps[0].at[1],0,.01);
  assert.equal(r2.gaps[0].ids.length,2);
  // The slot is the only closed loop, but the open outline reaches beyond it: no board.
  assert.equal(r2.shape,null);assert.ok(r2.warnings.some(w=>/does not close/.test(w)));assert.equal(r2.openSegments.length,1);
  const r3=S.fromItems(doc,ids.filter(id=>id!==edge.id),{closeGaps:50});
  assert.equal(r3.bridged,1);assert.equal(r3.shape.cutouts.length,1);
  close(S.area(r3.shape),S.area(outer)-S.area(slot),.01,"bridged area");
  // The same outline selected on two layers (and drawn reversed) chains once.
  const twice=A.sheet("pcb","T");twice.items=[...items,...items.map(i=>({...i,id:i.id+"b",layer:"Keep-Out",points:i.points.slice().reverse()}))];
  const r5=S.fromItems(twice,twice.items.map(i=>i.id));
  assert.equal(r5.loops,2);close(S.area(r5.shape),S.area(outer)-S.area(slot),.01,"duplicates ignored");
  assert.ok(r5.warnings.some(w=>/duplicate/.test(w)));
  // Tolerance below the endpoint noise breaks the chain.
  const r4=S.fromItems(doc,ids,{tolerance:.0001});
  assert.ok(r4.gaps.length>0);
  // Applying stores the exact shape and a flattened outline.
  const d2=A.sheet("pcb","C");S.apply(d2,r.shape,"primitives");
  assert.equal(S.current(d2),d2.boardShape);assert.equal(S.holes(d2).length,1);
  assert.ok(A.validOutline(d2.outline));
  // Editing doc.outline elsewhere makes the stored shape stale.
  d2.outline=[[0,0],[10,0],[10,10]];
  assert.notEqual(S.current(d2),d2.boardShape);assert.equal(S.holes(d2).length,0);
}

// Closed region and polygon pour outlines.
{
  const doc=A.sheet("pcb","R");
  doc.items.push({id:"r",kind:"graphic",closed:true,fill:true,layer:"Mechanical 1",width:0,points:[[0,0],[20,0],[20,-10],[0,-10]]});
  const r=S.fromItems(doc,["r"]);close(S.area(r.shape),200,1e-9);
  assert.deepEqual(S.analyze(r.shape),{x:0,y:0,width:20,height:10,corners:{bl:{style:"sharp",size:0},br:{style:"sharp",size:0},tr:{style:"sharp",size:0},tl:{style:"sharp",size:0}}});
}

// Component courtyard and body.
{
  const defs=new Map([["fp",{id:"fp",name:"Module",footprint:{pads:[{x:0,y:0,w:1,h:1,number:"1"}],shapes:[
    {kind:"path",layer:"Mechanical 15",closed:true,points:[[-10,-5],[10,-5],[10,5],[-10,5]]},
    {kind:"path",layer:"Mechanical 13",closed:true,points:[[-8,-4],[8,-4],[8,4],[-8,4]]}]}}]]);
  const doc=A.sheet("pcb","C");doc.items.push({id:"u1",kind:"part",def:"fp",x:50,y:20,angle:90,ref:"U1",value:"M"});
  const c=S.fromComponent(doc,defs,"u1");assert.equal(c.from,"courtyard");close(S.area(c.shape),200,1e-9);
  const b=S.bounds(c.shape);close(b[2]-b[0],10,1e-9,"rotated width");
  const body=S.fromComponent(doc,defs,"u1",{from:"body"});close(S.area(body.shape),128,1e-9);
}

// Dimension edits keep cutouts and move with the board.
{
  const c={style:"radius",size:3};
  let s=S.rect({x:0,y:0,width:40,height:30,corners:{bl:c,br:c,tr:c,tl:c}});
  s=S.addCutout(s,S.circle(4,[20,-15]).contour);
  const r=S.resize(s,{width:60,height:35,corners:{bl:{style:"chamfer",size:1},br:c,tr:c,tl:c}});
  close(S.area(r),60*35-3*(4-Math.PI)*9/4-.5-Math.PI*4,1e-9,"resized area");
  assert.equal(r.cutouts.length,1);
  const moved=S.resize(r,{x:5,y:7});assert.deepEqual(S.bounds(moved).map(v=>+v.toFixed(6)),[5,-28,65,7]);
  close(S.contourBounds(moved.cutouts[0])[0],23,1e-9,"cutout moved with the board");
  // Non-rectangular boards scale.
  const tri={version:1,contour:[S.line([0,0],[10,0]),S.line([10,0],[0,-10]),S.line([0,-10],[0,0])],cutouts:[]};
  close(S.area(S.resize(tri,{width:20})),100,1e-9);
  assert.throws(()=>S.resize(tri,{corners:{bl:{style:"radius",size:1}}}),/rectangular/);
}

// Dimension edits keep a cutout's material island, on rectangular and scaled boards alike.
{
  const sq=(x0,y0,x1,y1)=>S.orient(S.fromPolygon([[x0,y0],[x1,y0],[x1,y1],[x0,y1]]).contour,false);
  const islands=s=>[...S.profileCutouts(s)].map(r=>r.cutouts.length);
  for(const base of [S.rect({x:0,y:40,width:50,height:40}),S.fromPolygon([[0,40],[50,40],[50,0],[25,-5],[0,0]])]){
    const hole=sq(10,10,20,20),s={...base,cutouts:[hole],cutoutRegions:{0:{version:1,contour:hole,cutouts:[sq(13,13,17,17)],sig:S.signature(S.flattenContour(hole))}}};
    assert.deepEqual(islands(s),[1]);
    assert.deepEqual(islands(S.resize(s,{width:60})),[1],"a width change keeps the island");
    assert.deepEqual(islands(S.resize(s,{height:30})),[1],"a height change keeps the island");
    const moved=S.resize(s,{x:5});
    assert.deepEqual(islands(moved),[1],"a move keeps the island");
    close(S.contourBounds([...S.profileCutouts(moved)][0].cutouts[0])[0],18,1e-9,"the island moves with the board");
  }
}

// Wizard presets.
{
  const hat=S.wizard({type:"preset",preset:"rpi-hat",x:0,y:0});
  close(S.area(hat.shape),65*56.5-(4-Math.PI)*9,1e-9,"HAT area");
  assert.equal(hat.holes.length,4);assert.deepEqual(hat.holes[0],{x:3.5,y:-3.5,d:2.75});
  const m2=S.wizard({type:"preset",preset:"m2-2280"});
  close(S.area(m2.shape),22*80-Math.PI*1.75*1.75/2,1e-9,"M.2 notch area");
  const circ=S.wizard({type:"circle",diameter:50,holes:true,holeInset:5,holeCount:3});
  close(S.area(circ.shape),Math.PI*625,1e-9);assert.equal(circ.holes.length,3);
  const pads=S.holeItems(hat.holes);assert.equal(pads[0].plated,false);assert.equal(pads[0].drill,2.75);
  const plated=S.holeItems(hat.holes,{pad:5});assert.equal(plated[0].w,5);assert.equal(plated[0].plated,undefined);
  for(const p of S.PRESETS){const w=S.wizard({type:"preset",preset:p.id});assert.ok(S.area(w.shape)>0,p.id);S.validate(w.shape);}
}

// Vertex editing.
{
  let s=S.rect({x:0,y:0,width:10,height:10});
  s=S.moveVertex(s,{contour:-1,index:2},[12,-12]);
  close(S.area(s),100+10+10,1e-9,"moved vertex");
  s=S.insertVertex(s,{contour:-1,index:0},[5,0]);assert.equal(s.contour.length,5);
  s=S.moveVertex(s,{contour:-1,index:1},[5,2]);close(S.area(s),120+10,1e-9,"inserted vertex moved");
  s=S.deleteVertex(s,{contour:-1,index:1});close(S.area(s),120,1e-9,"deleted vertex");
  // Bottom edge becomes a semicircle bulging down (outside).
  const a=S.convertToArc(s,{contour:-1,index:0},{through:[5,5]});
  close(S.area(a),120+Math.PI*25/2,1e-9,"edge to semicircle");
  const back=S.convertToLine(a,{contour:-1,index:0});close(S.area(back),120,1e-9);
  // Moving an arc's end keeps its bulge.
  const m=S.moveVertex(a,{contour:-1,index:1},[20,0]);
  close(S.bulgeOf(m.contour[0]),S.bulgeOf(a.contour[0]),1e-9,"bulge kept");
  assert.equal(S.vertices(a).length,8);
  assert.throws(()=>S.deleteVertex(S.fromPolygon([[0,0],[1,0],[0,1]]),{contour:-1,index:0}),/three vertices/);
}

// Bulge arcs and three-point arcs.
{
  const g=S.fromBulge([1,0],[0,-1],Math.tan(Math.PI/8));
  close(g.r,1,1e-9);close(g.c[0],0,1e-9);close(g.c[1],0,1e-9);assert.equal(g.ccw,true);close(S.sweep(g),90,1e-9);
  const h=S.arcThrough([1,0],[Math.SQRT1_2,-Math.SQRT1_2],[0,-1]);close(S.sweep(h),90,1e-9);
}

// Offset: a square grown by 1 has area (10+2)^2 - (4 - pi); shrunk, 8^2.
{
  const sq=[[0,0],[10,0],[10,10],[0,10]];
  close(Math.abs(S.polyArea(S.offset(sq,1,.0005))),144-(4-Math.PI),.01,"outward offset");
  close(Math.abs(S.polyArea(S.offset(sq,-1))),64,1e-9,"inward offset");
  const radius=.01, tie=radius*(1-Math.SQRT1_2);
  assert.equal(S.offset(sq,radius,tie).length,8,"each round join keeps one chord at the exact tolerance boundary");
  // L-shape: reflex corner mitres outward.
  const L=[[0,0],[10,0],[10,5],[5,5],[5,10],[0,10]];
  // Inset L: 24 + 15 + the corner square minus a quarter disc at the reflex vertex.
  close(Math.abs(S.polyArea(S.offset(L,-1))),39+1-Math.PI/4,.01,"L inward offset");
  const ring=S.keepoutRing(S.rect({x:0,y:0,width:10,height:10}),.5);close(Math.abs(S.polyArea(ring[1])),81,1e-9);
}

// Origin: lower-left, centre and user coordinates with Y up.
{
  const doc=A.sheet("pcb","O");S.apply(doc,S.rect({x:10,y:40,width:30,height:20}));
  assert.deepEqual(S.originPoint(doc,"lower-left"),[10,40]);assert.deepEqual(S.originPoint(doc,"centre"),[25,30]);
  S.setOrigin(doc,[10,40]);assert.deepEqual(S.toUser(doc,[40,20]),[30,20]);assert.deepEqual(S.fromUser(doc,[30,20]),[40,20]);
  S.setOrigin(doc,null);assert.equal(doc.origin,undefined);assert.deepEqual(S.toUser(doc,[1,2]),[1,2]);
}

// Large chains stay fast: 20k segments in a single loop.
{
  const N=20000,pts=Array.from({length:N},(_,i)=>{const a=2*Math.PI*i/N;return [100*Math.cos(a)+50*Math.cos(7*a),100*Math.sin(a)];});
  const input=shuffle(pts.map((p,i)=>({seg:S.line(p,pts[(i+1)%N]),id:"s"+i})));
  const t=Date.now(),r=S.chain(input);const ms=Date.now()-t;
  // Near the cusps consecutive vertices sit closer than the tolerance and collapse.
  assert.equal(r.loops.length,1);assert.ok(r.loops[0].contour.length>N*.95);assert.equal(r.gaps.length,0);
  assert.ok(ms<2000,"chain 20k in "+ms+"ms");
}

// Validation rejects malformed shapes.
assert.throws(()=>S.validate({version:1,contour:[{kind:"arc",c:[0,0],r:-1,start:0,end:1,ccw:true}]}),/Invalid board shape/);
assert.throws(()=>S.validate({version:2,contour:[]}),/Invalid board shape/);

// A drag from one captured mark and a one-shot move share item translation.
{
  const paths=require("../support/app-source-paths.cjs");
  require(paths.appFile("edit-selection.js"));
  require(paths.appFile("undo-store.js"));
  const E=AtriumEditSelection,U=AtriumUndoStore;
  const outer=S.rect({x:0,y:16,width:30,height:16,corners:{tl:{style:"radius",size:6}}});
  const hole=S.rect({x:20,y:9,width:6,height:6});
  const points=S.flattenContour(outer.contour);
  const region={id:"region",kind:"graphic",layer:"Top",fill:true,closed:true,points,arc:{kind:"arc",c:[15,4],r:6},
    regionShape:{...outer,cutouts:[hole.contour],sig:S.signature(points)}};
  const part={id:"U1",kind:"part",ref:"U1",x:100,y:40};
  const bend={id:"bend",kind:"track",layer:"Top",width:.2,points:[[1,2],[8,2]],arc:{kind:"bend"}};
  assert.equal(S.regionOf(region),region.regionShape);
  const project=A.project("Authored move"),doc=project.documents[1];
  doc.items=[region,part,bend];
  const mark={points:region.points,arc:region.arc,shape:region.regionShape,bend:bend.points,bendArc:bend.arc};
  const shot=doc.items.map(item=>A.clone(item));
  for(const item of shot)A.moveItem(item,6,-3);
  const drag=E.translation(doc,new Map(),doc.items);
  drag.apply(6,-3);drag.apply(2,1);
  assert.deepEqual(bend.points[0],[3,3],"a later drag sample replaces the captured mark");
  drag.apply(0,0);
  assert.equal(region.points,mark.points);assert.equal(region.arc,mark.arc);assert.equal(region.regionShape,mark.shape);
  assert.equal(bend.points,mark.bend);assert.equal(bend.arc,mark.bendArc);
  assert.deepEqual([part.x,part.y],[100,40]);
  const before=JSON.stringify(doc.items),history=[],future=[],marked=U.mark(project);
  drag.apply(6,-3);
  assert.deepEqual(doc.items,shot);
  assert.equal(S.regionOf(region),region.regionShape);
  assert.equal(bend.arc,mark.bendArc);assert.deepEqual(region.arc.c,[21,1]);
  const vertex=hole.contour[0].a;
  assert.deepEqual(region.regionShape.cutouts[0][0].a,[vertex[0]+6,vertex[1]-3]);
  U.checkpoint(history,future,marked);U.record(project,{doc,items:drag.affected});
  assert.ok(U.jump(history,future,U.mark(project),-1));
  assert.equal(JSON.stringify(doc.items),before);
  const acc={kind:"track",points:[[1,2],[8,2]]};A.moveItem(acc,6,-3);A.moveItem(acc,0,0);
  assert.deepEqual(acc.points,[[7,-1],[14,-1]],"a one-shot move keeps its first delta");
}
console.log("board-shape tests passed");
