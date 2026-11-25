"use strict";
// STEP export and 3D mesh: syntax and reference check of the written file,
// closed-shell topology (each edge used twice in opposite directions,
// Euler-Poincaré genus = hole count), face orientation, vertices on curves,
// Y flip, assembly tree, embedded model merge, triangulation and mesh
// watertightness, plus timings for a synthetic 500-part, 10k-hole board.
const assert=require("node:assert/strict");
const {checkStepShell}=require("../support/step-shell.cjs");
for(const m of ["model","parts","pcb-appearance","pcb-pours","stackup","board-shape","rigid-flex","zip","polygon-pour","fab-outputs","step-export"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const A=Atrium,S=AtriumSTEP;
const now=()=>globalThis.performance?.now?performance.now():Date.now();
const log=(...a)=>(globalThis.console?.log||globalThis.print||(()=>{}))(...a);
let seed=4242;const rnd=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;

// ---- STEP checker ------------------------------------------------------------
const byType=(E,t)=>[...E.values()].filter(e=>e.type===t);

// ---- Triangulation -------------------------------------------------------------
{
  const area=(X,tri)=>{let s=0,neg=0;for(let i=0;i<tri.length;i+=3){const a=tri[i],b=tri[i+1],c=tri[i+2];const v=((X[2*b]-X[2*a])*(X[2*c+1]-X[2*a+1])-(X[2*b+1]-X[2*a+1])*(X[2*c]-X[2*a]))/2;s+=v;if(v<-1e-12)neg++;}return {s,neg};};
  const ring=(pts)=>pts.flat();
  const ringArea=r=>{let s=0;for(let i=0;i<r.length;i+=2){const j=(i+2)%r.length;s+=r[i]*r[j+1]-r[j]*r[i+1];}return s/2;};
  for(let trial=0;trial<60;trial++){
    const W=20+rnd()*30,H=10+rnd()*30;
    // outer: rectangle with a notch, axis aligned (many equal y values)
    const outer=ring([[0,0],[W,0],[W,H],[W*0.6,H],[W*0.6,H*0.7],[W*0.4,H*0.7],[W*0.4,H],[0,H]]);
    const rings=[outer],holes=[];
    for(let k=0;k<40;k++){
      const r=0.3+rnd()*1.5,x=r+0.2+rnd()*(W-2*r-0.4),y=r+0.2+rnd()*(H*0.7-2*r-0.4);
      if(holes.some(h=>Math.hypot(h[0]-x,h[1]-y)<h[2]+r+0.1))continue;holes.push([x,y,r]);
      const n=trial%3===0?4:3+Math.floor(rnd()*14),pts=[];
      for(let i=0;i<n;i++){const a=-2*Math.PI*i/n+(trial%2?0:Math.PI/4);pts.push([x+r*Math.cos(a),y+r*Math.sin(a)]);}
      rings.push(ring(pts));
    }
    const X=rings.flat(),tri=S.triangulate(rings),{s,neg}=area(X,tri);
    const want=rings.reduce((a,r)=>a+ringArea(r),0),N=X.length/2;
    assert.equal(neg,0,"clockwise triangle in trial "+trial);
    assert.ok(Math.abs(s-want)<1e-6*Math.max(1,want),"trial "+trial+": area "+s+" != "+want);
    assert.equal(tri.length/3,N+2*(rings.length-1)-2,"triangle count");
  }
}

// ---- Sample board --------------------------------------------------------------
const project=AtriumParts.example(),pcb=project.documents.find(d=>d.kind==="pcb");

// Overlapping explicit holes, a pinched boundary, and line-cut islands in
// surface artwork must keep the same filled area in the mesh and STEP.
{
  const p=AtriumParts.example(), d=p.documents.find(d=>d.kind==="pcb"), B=AtriumBoardShape;
  const loop=points=>points.map((a,i)=>B.line(a,points[(i+1)%points.length]));
  function shape(id, layer, points, holes) {
    return {id, kind:"graphic", layer, points, fill:true, closed:true, regionShape:{
      version:1, contour:loop(points), cutouts:holes.map(loop), sig:B.signature(points)
    }};
  }
  d.items=[
    shape("overlap", "Silk", [[0,0],[10,0],[10,8],[7,8],[7,5],[4,5],[4,8],[0,8]],
      [[[1,1],[4,1],[4,3],[1,3]], [[3,2],[5,2],[5,4],[3,4]]]),
    shape("touch", "Bottom silk", [[0,0],[8,0],[8,8],[0,8]],
      [[[0,0],[2,1],[1,2]]]),
    shape("bridge", "Top", [[0,0],[2,0],[2,2],[4,2],[6,2],[6,4],[4,4],[4,2],[2,2],[0,2]], []),
    shape("curve", "Bottom", [[10,0],[18,0],[18,8],[10,8]], []),
  ];
  d.items.at(-1).regionShape.cutouts=[B.circle(2,[14,4]).contour];
  const model=S.model(p,d,{copper:true,silk:true,components:false,holes:false});
  assert.deepEqual(model.layerWarnings,[]);
  assert.ok(model.layers.find(l=>l.name==="Bottom copper").prisms[0].loops[1].every(s=>s.c),"curved holes keep analytic STEP edges");
  const meshed=S.mesh(model);
  assert.deepEqual(meshed.layerWarnings,[]);
  function cap(name, area, covered, empty) {
    const mesh=meshed.parts.find(m=>m.name===name);
    const {positions:P,normals:N,indices:I}=mesh, faces=[];
    const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    for(let i=0;i<I.length;i+=3) if(N[I[i]*3+2]===1)
      faces.push([I[i],I[i+1],I[i+2]].map(k=>[P[k*3],P[k*3+1]]));
    const coveredAt=([x,y])=>faces.some(([a,b,c])=>cross(a,b,[x,-y])>=0&&cross(b,c,[x,-y])>=0&&cross(c,a,[x,-y])>=0);
    assert.ok(Math.abs(faces.reduce((sum,f)=>sum+cross(...f)/2,0)-area)<1e-5,name+" preserves filled area");
    assert.ok(covered.every(coveredAt),name+" keeps ink");
    assert.ok(empty.every(q=>!coveredAt(q)),name+" keeps voids");
  }
  cap("Top silkscreen",62,[[1,5],[8,6]],[[5,6],[1.5,1.5],[3.5,2.5],[4.5,3.5]]);
  cap("Bottom silkscreen",62.5,[[4,4]],[[1,1]]);
  cap("Top copper",8,[[1,1],[5,3]],[[3,2.1]]);
  const step=S.step(model,{deterministic:true}), parsed=checkStepShell(S.parse(step));
  assert.ok(parsed.genera.includes(1),"the merged void remains a hole in the STEP solid");
  assert.equal(parsed.solids,1+model.layers.reduce((n,l)=>n+l.prisms.length,0));

  // The mesh API is strict for export. The viewer can retain good shapes
  // around a bad cap in one film and keep the other films with a diagnostic.
  const badRing=[[10,0],[14,4],[10,4],[14,0]];
  const invalid={z0:0,z1:1,loops:[badRing.map((a,i)=>({a,b:badRing[(i+1)%badRing.length]}))]};
  const [copper,...silk]=model.layers;
  const sketch={...model,layers:[{...copper,prisms:[copper.prisms[0],invalid,...copper.prisms.slice(1)]},...silk]};
  assert.throws(()=>S.mesh(sketch),/Top copper\. Shape 2.*do not cover/);
  const partial=S.mesh(sketch,{skipInvalidLayerPrisms:true});
  assert.deepEqual(partial.parts,meshed.parts);
  assert.equal(partial.layerWarnings.length,1);
  assert.match(partial.layerWarnings[0],/Top copper\. Shape 2.*do not cover/);
}

{
  const m=S.model(project,pcb,{});
  const vias=pcb.items.filter(i=>(i.kind==="via"||i.kind==="pad")&&i.drill>0).length;
  const padHoles=pcb.items.filter(i=>i.kind==="part").reduce((s,i)=>s+(project.library.find(d=>d.id===i.def)?.footprint?.pads||[]).filter(p=>p.drill>0).length,0);
  assert.equal(m.board.holes.length,vias+padHoles,"every through hole is drilled");
  assert.equal(m.parts.length,pcb.items.filter(i=>i.kind==="part").length);
  const stack=AtriumStackup.get(pcb,new Map(project.library.map(d=>[d.id,d]))).layers;
  const dielectric=stack.map((row,i)=>row.type==="Dielectric"?i:-1).filter(i=>i!==-1);
  const substrate=stack.slice(dielectric[0],dielectric.at(-1)+1).reduce((t,row)=>t+row.thickness,0);
  assert.ok(Math.abs(m.board.thickness-substrate)<1e-9);
  const r=m.parts.find(p=>/^R/.test(p.ref));assert.equal(r.height,0.45,"0603 default height");
  const t0=now(),text=S.export(project,pcb,{deterministic:true}),ms=now()-t0;
  const {E,solids}=checkStepShell(S.parse(text),{genus:m.board.holes.length});
  assert.equal(solids,1+m.parts.length);
  assert.equal(text,S.export(project,pcb,{deterministic:true}),"deterministic output");
  assert.match(text,/FILE_NAME\('Sensor board\.step','2000-01-01T00:00:00'/);
  assert.match(text,/SI_UNIT\(\.MILLI\.,\.METRE\.\)/);
  // Products: assembly, board and one per designator, linked by NAUOs.
  const names=byType(E,"PRODUCT").map(p=>p.args[0].str);
  for(const p of m.parts)assert.ok(names.includes(p.ref),"product "+p.ref);
  assert.equal(byType(E,"NEXT_ASSEMBLY_USAGE_OCCURRENCE").length,1+m.parts.length);
  assert.equal(byType(E,"CONTEXT_DEPENDENT_SHAPE_REPRESENTATION").length,1+m.parts.length);
  // Y flip: the outline spans model y 0..22 (Y down), so STEP y spans -22..0 on the board.
  const board=byType(E,"MANIFOLD_SOLID_BREP").find(s=>/PCB/.test(s.args[0].str)||true);
  const ys=byType(E,"CARTESIAN_POINT").map(p=>p.args[1]).filter(p=>p.length===3&&Math.abs(p[2]-m.board.thickness)<1e-9).map(p=>p[1]);
  assert.ok(Math.abs(Math.min(...ys)+22)<1e-6&&Math.abs(Math.max(...ys))<1e-6,"board is Y-flipped, not mirrored");
  // Colour: the default board green is present.
  assert.ok(byType(E,"COLOUR_RGB").some(c=>Math.abs(c.args[1]-0.05)<1e-6&&Math.abs(c.args[2]-0.33)<1e-6));
  log("sample board: "+text.length+" bytes, "+E.size+" entities, "+ms.toFixed(1)+" ms");
  // Board colour option and no components
  const t2=S.export(project,pcb,{deterministic:true,components:false,boardColor:"#ff0000"});
  const c2=checkStepShell(S.parse(t2));assert.equal(c2.solids,1);assert.ok(byType(c2.E,"COLOUR_RGB").some(c=>c.args[1]===1&&c.args[2]===0));
  // Copper and silkscreen
  const t3=now(),m3=S.model(project,pcb,{copper:true,silk:true}),s3=S.step(m3,{deterministic:true}),ms3=now()-t3;
  assert.ok(m3.layers.some(l=>l.kind==="copper")&&m3.layers.some(l=>l.kind==="silk"));
  const c3=checkStepShell(S.parse(s3));
  assert.equal(c3.solids,1+m3.parts.length+m3.layers.reduce((s,l)=>s+l.prisms.length,0));
  log("sample board with copper and silk: "+s3.length+" bytes, "+ms3.toFixed(1)+" ms");
}

// ---- Exact board shape: arcs become circles and cylinders -----------------------
{
  const p=AtriumParts.example(),d=p.documents.find(x=>x.kind==="pcb");
  AtriumBoardShape.apply(d,{...AtriumBoardShape.rect({x:0,y:22,width:36,height:22,corners:{bl:{style:"radius",size:2},br:{style:"radius",size:2},tr:{style:"radius",size:2},tl:{style:"radius",size:2}}}),
    cutouts:[AtriumBoardShape.circle?AtriumBoardShape.circle(4,[18,4]).contour:[]].filter(c=>c.length)});
  const m=S.model(p,d,{components:false});
  assert.equal(m.board.exact,true);
  const text=S.export(p,d,{components:false,deterministic:true});
  const {E}=checkStepShell(S.parse(text),{genus:m.board.holes.length+m.board.cutouts});
  const cyl=byType(E,"CYLINDRICAL_SURFACE");
  assert.ok(cyl.some(c=>Math.abs(c.args[2]-2)<1e-9),"rounded corners are cylinders");
  assert.ok(byType(E,"CIRCLE").length>=2*(4+m.board.holes.length));
}

// ---- Bottom-side parts, height parameters, holes that must be dropped -------------
{
  const p=AtriumParts.example(),d=p.documents.find(x=>x.kind==="pcb"),part=d.items.find(i=>i.kind==="part"&&/^R/.test(i.ref));
  part.layer="Bottom";part.parameters={Height:"1.2mm"};part.angle=90;
  d.items.push({id:"vx",kind:"via",x:0.1,y:10,diameter:.8,drill:.4,layer:"Multi"});// crosses the left edge
  d.items.push({id:"vy",kind:"via",x:-5,y:5,diameter:.8,drill:.4,layer:"Multi"});// outside
  const m=S.model(p,d,{});
  const b=m.parts.find(q=>q.ref===part.ref);
  assert.equal(b.height,1.2);assert.equal(b.body.z0,-1.2);assert.equal(b.body.z1,0);
  assert.equal(b.placement.origin[2],-.035,"bottom part seats on the default 35 µm outer foil");
  assert.ok(Math.abs(b.placement.refDir[1]+1)<1e-12,"angle 90 on screen is -90 about +Z");
  assert.ok(m.notes.some(n=>/outside/.test(n))&&m.notes.some(n=>/edge/.test(n)));
  checkStepShell(S.parse(S.export(p,d,{deterministic:true})));
}

// ---- Embedded component model: merged with renumbered IDs ------------------------
{
  const donor=A.project("Model",[]),dd=donor.documents.find(x=>x.kind==="pcb");dd.outline=[[0,0],[2,0],[2,1],[0,1]];
  const stepText=S.export(donor,dd,{deterministic:true,boardColor:[0.1,0.1,0.1]});
  const p=AtriumParts.example(),d=p.documents.find(x=>x.kind==="pcb");
  const def=p.library.find(x=>x.id==="std-r");
  def.model3d={stepText,offset:[0,0,0.1],rotation:[0,0,90]};
  const m=S.model(p,d,{});
  const mp=m.parts.filter(q=>q.source==="model");assert.ok(mp.length>=2);
  const text=S.step(m,{deterministic:true});
  const {E}=checkStepShell(S.parse(text));
  const names=byType(E,"PRODUCT").map(x=>x.args[0].str);
  for(const q of mp)assert.ok(names.includes(q.ref));
  assert.ok(names.includes("Board layout PCB")&&names.includes("Board layout"),"model product tree is copied");
  // The donor tree is copied once even when several parts use it.
  assert.equal(names.filter(n=>n==="Board layout PCB").length,1);
  const ms=S.mesh(m);assert.ok(ms.parts.some(x=>x.boundsOnly));
}

// ---- Mesh ------------------------------------------------------------------------
function meshCheck(part,holes){
  const P=part.positions,I=part.indices,Nn=part.normals,key=new Map(),id=[];
  for(let i=0;i<P.length;i+=3){const k=Math.round(P[i]*1e5)+","+Math.round(P[i+1]*1e5)+","+Math.round(P[i+2]*1e5);let v=key.get(k);if(v==null)key.set(k,v=key.size);id.push(v);}
  const edges=new Map();let vol=0;
  for(let t=0;t<I.length;t+=3){
    const a=I[t],b=I[t+1],c=I[t+2];
    for(const [u,w] of [[a,b],[b,c],[c,a]]){const k=id[u]+">"+id[w];assert.ok(!edges.has(k),"directed edge used twice");edges.set(k,1);}
    const pa=[P[3*a],P[3*a+1],P[3*a+2]],pb=[P[3*b],P[3*b+1],P[3*b+2]],pc=[P[3*c],P[3*c+1],P[3*c+2]];
    const u=[pb[0]-pa[0],pb[1]-pa[1],pb[2]-pa[2]],w=[pc[0]-pa[0],pc[1]-pa[1],pc[2]-pa[2]],n=[u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]];
    if(Math.hypot(...n)>1e-12){const nn=[Nn[3*a]+Nn[3*b]+Nn[3*c],Nn[3*a+1]+Nn[3*b+1]+Nn[3*c+1],Nn[3*a+2]+Nn[3*b+2]+Nn[3*c+2]];assert.ok(n[0]*nn[0]+n[1]*nn[1]+n[2]*nn[2]>0,"vertex normals disagree with winding");}
    vol+=(pa[0]*(pb[1]*pc[2]-pb[2]*pc[1])-pa[1]*(pb[0]*pc[2]-pb[2]*pc[0])+pa[2]*(pb[0]*pc[1]-pb[1]*pc[0]))/6;
  }
  for(const k of edges.keys()){const [u,w]=k.split(">");assert.ok(edges.has(w+">"+u),"mesh is not watertight at "+k);}
  const V=key.size,Ecount=edges.size/2,F=I.length/3,chi=V-Ecount+F;
  assert.equal(1-chi/2,holes,"mesh genus equals the hole count");
  assert.ok(vol>0,"outward normals enclose a positive volume");
  return vol;
}
{
  const m=S.model(project,pcb,{copper:true,silk:true});
  const t0=now(),ms=S.mesh(m),dt=now()-t0;
  const board=ms.parts.find(p=>p.kind==="board");
  const vol=meshCheck(board,m.board.holes.length+m.board.cutouts);
  const area=Math.abs(pcb.outline.reduce((s,p,i,a)=>{const q=a[(i+1)%a.length];return s+p[0]*q[1]-q[0]*p[1];},0)/2);
  const holeArea=m.board.holes.reduce((s,h)=>s+Math.PI*h.d*h.d/4,0);
  assert.ok(Math.abs(vol-(area-holeArea)*m.board.thickness)<0.01*area*m.board.thickness,"board volume");
  for(const p of ms.parts.filter(p=>p.kind==="component"))meshCheck(p,0);
  assert.ok(board.positions instanceof Float32Array&&board.indices instanceof Uint32Array&&board.matrix.length===16);
  log("sample mesh: "+ms.stats.triangles+" triangles, "+dt.toFixed(1)+" ms");
}

// ---- Synthetic 500-part, 10k-hole board -------------------------------------------
{
  const lib=project.library,res=lib.find(d=>d.id==="std-r"),hdr=lib.find(d=>/header/i.test(d.name));
  const p=A.project("Big",lib),d=p.documents.find(x=>x.kind==="pcb");
  d.outline=[[0,0],[200,0],[200,150],[0,150]];
  let n=0;
  for(let i=0;i<25&&n<500;i++)for(let j=0;j<20&&n<500;j++,n++){
    const def=n%10===0?hdr:res;
    d.items.push({id:"p"+n,kind:"part",def:def.id,ref:(def===res?"R":"J")+n,x:6+i*7.6,y:5+j*7,angle:(n%4)*90,layer:n%3?"Top":"Bottom",pinNets:{}});
  }
  for(let k=0;d.items.filter(i=>i.kind==="via").length+0<10000&&k<20000;k++){
    const x=2+(k%140)*1.4,y=3.2+Math.floor(k/140)*2.07;if(y>148)break;
    d.items.push({id:"v"+k,kind:"via",x:x+0.0,y:y+0.0,diameter:.5,drill:.25,layer:"Multi"});
  }
  const t0=now(),m=S.model(p,d,{}),t1=now(),text=S.step(m,{deterministic:true}),t2=now(),ms=S.mesh(m),t3=now();
  log("synthetic: "+m.parts.length+" parts, "+m.board.holes.length+" holes kept; model "+(t1-t0).toFixed(0)+" ms, STEP "+(t2-t1).toFixed(0)+" ms ("+(text.length/1048576).toFixed(1)+" MB), mesh "+(t3-t2).toFixed(0)+" ms ("+ms.stats.triangles+" triangles); notes: "+m.notes.join(" | "));
  assert.ok(m.board.holes.length>=9000);
  const t4=now(),{solids}=checkStepShell(S.parse(text),{genus:m.board.holes.length}),t5=now();
  assert.equal(solids,1+m.parts.length);
  log("synthetic check (parse + topology): "+(t5-t4).toFixed(0)+" ms");
  meshCheck(ms.parts.find(x=>x.kind==="board"),m.board.holes.length);
  // Without vias the file is small.
  const t6=now(),small=S.export(p,d,{deterministic:true,vias:false}),t7=now();
  log("synthetic without vias: "+(small.length/1048576).toFixed(2)+" MB, "+(t7-t6).toFixed(0)+" ms");
}

// ---- Helpers -------------------------------------------------------------------------
assert.equal(S.parseLength("50mil"),1.27);assert.equal(S.parseLength("0.1 in"),2.54);assert.equal(S.parseLength("x"),null);
assert.equal(S.packageHeight({ref:"U1"},{footprint:{name:"SOIC-8_3.9x4.9mm"}}),1.75);
assert.equal(S.packageHeight({ref:"U2"},{footprint:{name:"QFN-32-1EP_5x5mm"}}),0.9);
assert.equal(S.packageHeight({ref:"C1"},{footprint:{name:"C_0402_1005Metric"}}),0.35);
assert.equal(S.packageHeight({ref:"C1"},{footprint:{name:"C_0805"}}),0.6);
assert.throws(()=>S.parse("ISO-10303-21;\nHEADER;ENDSEC;\nDATA;\n#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=VERTEX_POINT('',#3);\nENDSEC;\nEND-ISO-10303-21;\n"),/Unresolved/);
assert.throws(()=>S.parse("ISO-10303-21;\nHEADER;ENDSEC;\nDATA;\n#1=CARTESIAN_POINT('',(0.,0.,0.);\nENDSEC;\nEND-ISO-10303-21;\n"));
assert.match(S.export(project,pcb,{deterministic:true,components:false}).split("\n")[3],/^FILE_NAME/);

// ---- glTF binary ---------------------------------------------------------------------
{
  const r=S.build(project,pcb,{format:"glb"}),b=r.data,dv=new DataView(b.buffer,b.byteOffset,b.byteLength);
  assert.equal(r.name,"Sensor board.glb");
  assert.equal(dv.getUint32(0,true),0x46546C67);assert.equal(dv.getUint32(4,true),2);assert.equal(dv.getUint32(8,true),b.length);
  const jl=dv.getUint32(12,true);assert.equal(dv.getUint32(16,true),0x4E4F534A);
  const j=JSON.parse(new TextDecoder().decode(b.subarray(20,20+jl)));
  const bl=dv.getUint32(20+jl,true);assert.equal(dv.getUint32(24+jl,true),0x004E4942);assert.equal(28+jl+bl,b.length);assert.ok(bl>=j.buffers[0].byteLength);
  for(const v of j.bufferViews){assert.equal(v.byteOffset%4,0);assert.ok(v.byteOffset+v.byteLength<=j.buffers[0].byteLength);}
  for(const a of j.accessors){const v=j.bufferViews[a.bufferView];assert.equal(a.count*(a.type==="VEC3"?12:4),v.byteLength);}
  const root=j.nodes[j.scenes[0].nodes[0]];assert.equal(root.children.length,j.nodes.length-1);
  assert.equal(j.nodes.filter(n=>n.mesh!=null).length,1+S.model(project,pcb,{}).parts.length);
}

// ---- Rigid-flex: one flat body per region at its own substack height ---------------------
{
  const p=AtriumParts.example(),d=p.documents.find(x=>x.kind==="pcb"),defs=new Map(p.library.map(x=>[x.id,x])),RF=AtriumRigidFlex,ST=AtriumStackup;
  const r=RF.splitRegion(d,[[26,-1],[26,23]],{defs});assert.ok(r.ok,r.problem);
  const st=d.stackup,master=st.layers;
  const keys=master.filter(l=>ST.isCopper(l)).map(l=>l.key);
  st.substacks=[{id:"flex",name:"Flex",flex:true,layers:ST.flexLayers?ST.flexLayers(keys,master):[master.find(l=>l.key==="Top"),{type:"Dielectric",name:"PI",material:"Polyimide",thickness:0.05,dielectric:"Core"},master.find(l=>l.key==="Bottom")]}];
  RF.assignStack(d,r.created[0],"flex",defs);
  const m=S.model(p,d,{components:false});
  const bodies=m.board.bodies.filter(b=>!b.stiffener);
  assert.equal(bodies.length,2);
  const flex=bodies.find(b=>b.flex),rigid=bodies.find(b=>!b.flex);
  assert.ok(flex.prism.z1-flex.prism.z0<rigid.prism.z1-rigid.prism.z0,"flex is thinner");
  // z follows rigid-flex.js: substacks line up on their shared copper layer (z measured down from the master top).
  const R=AtriumStackup.regionsResolved(d,defs).regions.find(x=>x.flex),t=m.board.thickness;
  assert.ok(Math.abs(flex.prism.z1-(t-R.zTop))<1e-9&&Math.abs(flex.prism.z0-(t-R.zBottom))<1e-9,"flex z range from the resolved substack");
  assert.equal(bodies.reduce((s,b)=>s+b.holes,0),m.board.holes.length,"every hole is in one region");
  const c=checkStepShell(S.parse(S.step(m,{deterministic:true})));assert.equal(c.solids,m.board.bodies.length);
  for(const p2 of S.mesh(m).parts)meshCheck(p2,m.board.bodies.find(b=>b.name===p2.name)?.holes??0);
}

// ---- Pour regions: ring 0 is the outer contour and the rest are its holes, whatever their winding --
// (consolidation audit §4: an imported hole that winds like its outer used to become a second solid).
{
  const sq=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
  const area=l=>l.reduce((s,q)=>s+(q.a[0]*q.b[1]-q.b[0]*q.a[1])/2,0);
  for(const holeSameWinding of [true,false]){
    const hole=holeSameWinding?sq(4,4,6,6):sq(4,4,6,6).reverse();
    const pours=[AtriumPCBPours.region([sq(0,0,10,10),hole],"Top","GND")];
    const doc={...pcb,items:[],pcbDrawing:{pours}};
    const m=S.model(project,doc,{copper:true,components:false,fab:{pourFill:"stored"}});
    const top=m.layers.find(l=>l.name==="Top copper");
    assert.ok(top,"top copper layer");
    assert.equal(top.prisms.length,1,"one solid for the region (hole same winding: "+holeSameWinding+")");
    const [outer,inner]=top.prisms[0].loops;
    assert.equal(top.prisms[0].loops.length,2,"the hole is a hole");
    assert.ok(area(outer)>0&&area(inner)<0,"outer counter-clockwise, hole clockwise (Y up)");
    assert.ok(Math.abs(area(outer)-100)<1e-9&&Math.abs(area(inner)+4)<1e-9);
  }
}

// Read actual AP214 roof loops: add 190 mm², clear 32 mm² and restore 4 mm².
{
  const p=A.project("Signed STEP",[]), doc=p.documents.find(d=>d.kind==="pcb");
  doc.outline=[[0,0],[25,0],[25,16],[0,16]];
  doc.stackup=AtriumStackup.build(["Signal","Signal"]);
  doc.stackup.layers.find(l=>l.type==="Dielectric").thickness=1.6;
  const rect=(id,x0,y0,x1,y1,polarity)=>({id,kind:"graphic",layer:"Top",fill:true,polarity,
    points:[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]});
  doc.items=[rect("base",3,3,22,13,"add"),rect("clear",7,6,15,10,"clear"),rect("restore",10,7,12,9,"add")];
  const options={components:false,holes:false};
  const F=AtriumFabOutputs;
  let prepares=0;
  globalThis.AtriumFabOutputs={...F,stepArtwork(...args){prepares++;return F.stepArtwork(...args);}};
  let exportData;
  try {
    S.build(p,doc,options);
    assert.equal(prepares,0,"a board-only export leaves artwork cold");
    exportData=S.build(p,doc,{...options,copper:true}).data;
    assert.equal(prepares,1,"a direct STEP request prepares one artwork view");
  } finally { globalThis.AtriumFabOutputs=F; }
  const parsed=S.parse(exportData), roof=1.635;
  checkStepShell(parsed);
  const get=r=>parsed.entities.get(r.ref);
  const boundPoints=bound=>get(bound.args[1]).args[1].map(ref=>{
    const edge=get(ref), curve=get(edge.args[3]);
    const start=curve.args[edge.args[4].enum==="T"?1:2];
    return get(get(start).args[1]).args[1];
  });
  const caps=[...parsed.entities.values()].filter(e=>e.type==="MANIFOLD_SOLID_BREP"&&/ Top copper(?: \d+)?$/.test(e.args[0].str));
  const band=solid=>get(solid.args[1]).args[1].map(get).filter(f=>{
    const plane=get(f.args[2]);
    if(plane.type!=="PLANE")return false;
    const [,origin,normal]=get(plane.args[1]).args;
    return get(normal).args[1][2]*(f.args[3].enum==="T"?1:-1)>0&&Math.abs(get(origin).args[1][2]-roof)<1e-7;
  }).flatMap(f=>f.args[1].map(get)).map(bound=>{
    const points=boundPoints(bound);
    assert.ok(points.every(([x,y,z])=>x>=3-1e-6&&x<=22+1e-6&&y>=-13-1e-6&&y<=-3+1e-6&&z===roof),"exported vertices retain the authored XY and physical Z");
    const twice=points.reduce((sum,[x,y],i)=>{
      const [nx,ny]=points[(i+1)%points.length];
      return sum+x*ny-nx*y;
    },0);
    const area=Math.abs(twice)/2;
    assert.ok(Math.abs(area-Math.round(area))<1e-5,"the face area survives output precision");
    return [bound.type,Math.round(area)];
  });
  const areas=caps.flatMap(band).sort((a,b)=>a[1]-b[1]);
  assert.deepEqual(areas,[["FACE_OUTER_BOUND",4],["FACE_BOUND",32],["FACE_OUTER_BOUND",190]]);
}

{
  const p=A.project("STEP mask policy",[]), doc=p.documents.find(d=>d.kind==="pcb");
  doc.outline=[[0,0],[20,0],[20,20],[0,20]];
  doc.items=[{id:"v",kind:"via",layer:"Multi",x:6,y:8,diameter:1,drill:.3}];
  const opts={copper:true,components:false,maskOpenings:true};
  const mask=(fab)=>S.model(p,doc,{...opts,fab}).layers.find(l=>l.key==="Top mask");
  assert.equal(mask({tentVias:true}),undefined,"a tented via contributes no mask opening");
  const opening=mask({tentVias:false,maskExpansion:.2,overrideExpansions:true}).prisms[0].loops[0];
  assert.ok(opening.every(edge=>Math.abs(edge.r-.7)<1e-8),"mask expansion has the physical radius");
  const invalid=S.model(p,doc,{...opts,fab:{maskExpansion:3}});
  assert.ok(invalid.notes.some(n=>/Expansions must be between -2 and 2 mm/.test(n)));
  assert.deepEqual(invalid.layers,[]);
}

// The writer keeps source comments out of copied bodies and preserves complex part order.
{
  const source = "ISO-10303-21;HEADER;ENDSEC;DATA;#1=FI/* comment */RST('O''Brien;()',*,\"0A\");#2=(A()A(1));endsec;END-ISO-10303-21;";
  const {entities} = S.parse(source);
  assert.deepEqual(entities.get(1), {type:"FIRST",args:[{str:"O'Brien;()"},{omit:"*"},{bin:true}]});
  assert.deepEqual(entities.get(2).complex, [{type:"A",args:[]},{type:"A",args:[1]}]);
}
