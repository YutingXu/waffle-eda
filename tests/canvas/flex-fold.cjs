"use strict";
// Rigid-flex folding for the 3D view (flex-fold.js): the fold tree from the fixed region,
// the cylinder mapping of a bend zone (arc length kept), rigid motion past the zone, fold
// order, mesh slicing, and folding a real STEP mesh with components.
const assert=require("node:assert/strict");
for(const m of ["model","parts","pcb-appearance","pcb-pours","rules","stackup","board-shape","rigid-flex","zip","fab-outputs","step-export","flex-fold"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const S=AtriumStackup,RF=AtriumRigidFlex,F=AtriumFlexFold,A=Atrium;
const near=(a,b,e=1e-6,m)=>assert.ok(Math.abs(a-b)<=e,(m?m+": ":"")+a+" vs "+b);
const dist=(p,q)=>Math.hypot(p[0]-q[0],p[1]-q[1],p[2]-q[2]);

// The template layout: rigid | flex | rigid, a bend across the middle of the flex.
function board(bends){
  const doc=A.sheet("pcb","Flex");doc.outline=[[0,0],[100,0],[100,30],[0,30]];
  const st=S.preset(4);delete st.derived;
  const cu=st.layers.filter(S.isCopper);
  st.substacks=[{id:"flex",name:"Flex",flex:true,layers:S.flexLayers(["Top","Bottom"],cu)}];
  doc.stackup=JSON.parse(JSON.stringify(st));
  S.splitRegion(doc,{a:[35,-1],b:[35,31]});S.splitRegion(doc,{a:[65,-1],b:[65,31]});
  S.assignStack(doc,RF.regions(doc).find(g=>RF.geometry.inside([50,15],g.points)).id,"flex");
  // Make the left end the bigger rigid region, so it is the fixed one.
  for(const b of bends)RF.addBend(doc,b);
  return doc;
}
{
  const doc=board([{a:[50,0],b:[50,30],angle:90,radius:3,name:"B1"}]),T=S.thickness(doc,new Map());
  const P=F.plan(doc,new Map(),{thickness:T});
  assert.deepEqual(P.notes,[]);
  assert.equal(P.bends[0].folds,true);assert.equal(P.groups,1);
  // The fixed piece is a rigid end; the far end's chain holds the bend.
  const left=P.piece([10,15]),right=P.piece([90,15]);
  assert.ok(left.rigid&&right.rigid);
  const fixedLeft=P.fixed===left;
  assert.equal((fixedLeft?left:right).chain.length,0);assert.deepEqual((fixedLeft?right:left).chain.map(b=>b.name),["B1"]);
  const far=fixedLeft?90:10,sgn=fixedLeft?1:-1,b=P.bends[0],hw=b.width/2,z0=b.zUp;
  near(b.width,3*Math.PI/2,1e-12,"zone = arc length");
  // t = 0 is flat; t = 1 folds the far end straight up (90°), centre of curvature at the zone start.
  const flat=F.pointAt(P,[far,-15,z0],0).p;near(flat[0],far);near(flat[2],z0);
  const up=F.pointAt(P,[far,-15,z0],1).p,s=Math.abs(far-50);
  near(up[0],50+sgn*(-hw+3),1e-6,"x after a 90° fold");near(up[2],z0+3+s-hw,1e-6,"z after a 90° fold");near(up[1],-15);
  // Rigid past the zone: distances between far-end points are kept.
  const q1=[far,-5,z0+.1],q2=[far-sgn*10,-25,z0-.1];
  near(dist(F.pointAt(P,q1,1).p,F.pointAt(P,q2,1).p),dist(q1,q2),1e-6,"rigid motion");
  // The neutral axis keeps its length through the zone.
  let L=0,prev=null;for(let k=0;k<=200;k++){const x=50-sgn*hw+sgn*b.width*k/200,p=F.pointAt(P,[x,-15,z0],1).p;if(prev)L+=dist(prev,p);prev=p;}
  near(L,b.width,1e-3,"arc length kept");
  // The fixed side does not move; the near half of the zone starts curving.
  const fixedPt=[100-far,-15,z0+.2];assert.deepEqual(F.pointAt(P,fixedPt,1).p.map(v=>+v.toFixed(9)),fixedPt.map(v=>+v.toFixed(9)));
  assert.ok(F.pointAt(P,[50-sgn*hw*.5,-15,z0],1).p[2]>z0+1e-4,"root half of the zone bends");
  // A negative angle folds toward the bottom.
  doc.stackup.bends[0].angle=-90;S.touch(doc);
  const P2=F.plan(doc,new Map(),{thickness:T});near(F.pointAt(P2,[far,-15,z0],1).p[2],z0-3-s+hw,1e-6,"fold down");
  // Component matrix: the fold at the part origin.
  doc.stackup.bends[0].angle=90;S.touch(doc);
  const M=F.matrixAt(F.plan(doc,new Map(),{thickness:T}),[far,15],1);
  near(M[2]*far+M[6]*-15+M[14],F.pointAt(P,[far,-15,0],1).p[2],1e-6,"matrix moves the part origin with the board");
  near(M[8]*M[8]+M[9]*M[9]+M[10]*M[10],1,1e-9,"rotation");
}
// Two bends with fold order: the second group waits for the first.
{
  const doc=board([{a:[45,0],b:[45,30],angle:90,radius:2,name:"B1"},{a:[56,0],b:[56,30],angle:-90,radius:2,name:"B2"}]);
  doc.stackup.bends[0].order=1;doc.stackup.bends[1].order=2;
  doc.stackup=S.normalize(doc.stackup);
  assert.deepEqual(doc.stackup.bends.map(b=>b.order),[1,2],"fold order is stored");
  const P=F.plan(doc,new Map(),{});
  assert.equal(P.groups,2);
  const st=F.stateOf(P,.5);assert.ok(st[P.bends.findIndex(b=>b.name==="B1")],"first group folded at t=.5");assert.equal(st[P.bends.findIndex(b=>b.name==="B2")],null,"second waits");
  const far=P.fixed===P.piece([10,15])?95:5,pc=P.piece([far,15]);
  assert.equal(pc.chain.length,2,"far end moves with both bends");
  // B1 up 90° then B2 down 90°: the far end ends parallel to the base, raised.
  const a=F.pointAt(P,[far,-10,1],1).p,c=F.pointAt(P,[far+(far>50?-5:5),-10,1],1).p;
  near(a[2],c[2],1e-6,"far end level again");
  assert.ok(Math.abs(a[2]-1)>5,"far end offset by the S-fold: "+a[2]);
}
// Bend lines that do not cut across cannot fold.
{
  const doc=board([{a:[50,5],b:[50,25],angle:90,radius:3,name:"Short"}]);
  const P=F.plan(doc,new Map(),{});
  assert.equal(P.bends[0].folds,false);assert.match(P.notes.join(" "),/does not cut across|not on a path/);
  assert.equal(F.stateOf(P,1)[0],null);
}
// Slicing keeps area and adds vertices in the zone.
{
  const mesh={positions:new Float32Array([0,0,0,10,0,0,10,10,0,0,10,0]),normals:new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]),indices:new Uint32Array([0,1,2,0,2,3])};
  const out=F.slice(mesh,[{nx:1,ny:0,d:3},{nx:1,ny:0,d:6}]);
  let area=0;for(let i=0;i<out.indices.length;i+=3){const P=k=>[out.positions[k*3],out.positions[k*3+1]],[a,b,c]=[P(out.indices[i]),P(out.indices[i+1]),P(out.indices[i+2])];area+=Math.abs((b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1]))/2;}
  near(area,100,1e-4,"slicing keeps area");assert.ok(out.indices.length/3>=6);
  for(let i=0;i<out.indices.length;i+=3){const xs=[0,1,2].map(k=>out.positions[out.indices[i+k]*3]);assert.ok(!(Math.min(...xs)<3-1e-5&&Math.max(...xs)>3+1e-5),"no triangle straddles a cut");}
}
// Folding a real mesh: board bodies curve, components follow.
{
  const project=A.project("Fold"),doc=board([{a:[50,0],b:[50,30],angle:90,radius:3,name:"B1"}]);
  const fp={id:"fp",name:"R",footprint:{shapes:[],pads:[{x:-1,y:0,w:.8,h:.8,number:"1",shape:"rect",layer:"Top"},{x:1,y:0,w:.8,h:.8,number:"2",shape:"rect",layer:"Top"}]}};
  project.library.push(fp);project.documents.push(doc);
  doc.items.push({id:"R1",kind:"part",def:"fp",ref:"R1",value:"",x:10,y:15,angle:0,pinNets:{}},{id:"R2",kind:"part",def:"fp",ref:"R2",value:"",x:90,y:15,angle:0,pinNets:{}});
  const model=AtriumSTEP.model(project,doc,{copper:true,silk:false}),meshed=AtriumSTEP.mesh(model,{tolerance:.02});
  const t0=Date.now(),folded=F.fold(meshed.parts,{doc,project,thickness:model.board.thickness,t:1}),ms=Date.now()-t0;
  assert.equal(folded.length,meshed.parts.length);
  const zmax=parts=>Math.max(...parts.filter(p=>p.kind==="board").map(p=>{let m=-Infinity;for(let i=2;i<p.positions.length;i+=3)m=Math.max(m,p.positions[i]);return m;}));
  assert.ok(zmax(meshed.parts)<model.board.thickness+.1,"flat board");
  assert.ok(zmax(folded)>40,"folded end stands up: "+zmax(folded));
  const flexBody=folded.find((p,i)=>p.kind==="board"&&p.positions.length>meshed.parts[i].positions.length);
  assert.ok(flexBody,"the flex body was sliced across the zone");
  const comps=folded.filter(p=>p.kind==="component"),moved=comps.filter((c,i)=>Math.abs(c.matrix[14]-meshed.parts.filter(p=>p.kind==="component")[i].matrix[14])>1);
  assert.equal(moved.length,1,"one component rides the folded end");
  assert.equal(F.fold(meshed.parts,{doc,project,thickness:model.board.thickness,t:0}),meshed.parts,"t=0 returns the flat parts");
  // A second fold reuses the sliced geometry.
  const t1=Date.now();F.fold(meshed.parts,{doc,project,thickness:model.board.thickness,t:.5});
  console.log("fold "+ms+" ms first, "+(Date.now()-t1)+" ms again");
}
console.log("flex-fold ok");
