"use strict";
// 3D layout view: camera maths, scene building (instancing), picking, layer
// compaction, the build cache, GL resource lifetime against a recording mock
// context, the WebGL fallback decision, and the editor's lazy loading.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
for(const m of ["model","parts","pcb-appearance","pcb-pours","stackup","board-shape","rigid-flex","zip","bom","variants","fab-outputs","step-export","step-import","undo-store","nav-common","view3d"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
require("../support/3d-geometry.cjs");
const A=Atrium,S=AtriumSTEP,V=Atrium3D,M=V.math;
const log=(...a)=>(globalThis.console?.log||globalThis.print||(()=>{}))(...a);
const near=(a,b,e=1e-6,msg)=>assert.ok(Math.abs(a-b)<=e,(msg||"")+" "+a+" ≉ "+b);
const vnear=(a,b,e=1e-6,msg)=>a.forEach((v,i)=>near(v,b[i],e,msg));
const now=()=>globalThis.performance?.now?performance.now():Date.now();

// ---- camera maths --------------------------------------------------------------
{
  const cam={target:[10,-5,1],dist:50,yaw:-90,pitch:90,fov:30};
  const f=M.frame(cam);
  vnear(f.fwd,[0,0,-1],1e-9,"top view looks down");vnear(f.up,[0,1,0],1e-9,"top view: +y is up");vnear(f.right,[1,0,0],1e-9,"top view: +x is right");
  const b=M.frame({...cam,...M.BOTTOM});
  vnear(b.fwd,[0,0,1],1e-9,"bottom view looks up");vnear(b.right,[-1,0,0],1e-9,"bottom view mirrors x");
  // Flip turns the board over about the screen's vertical axis; twice is the identity.
  const iso={...cam,yaw:-115,pitch:38},fl=M.flipped(iso),ff=M.frame(fl),fi=M.frame(iso);
  vnear(ff.up,fi.up,1e-9,"flip keeps screen up");vnear(ff.back,fi.back.map(v=>-v),1e-9,"flip views from the other side");
  const fl2=M.flipped(fl);near(((fl2.yaw-iso.yaw)%360+360)%360,0,1e-9);near(fl2.pitch,iso.pitch);
  vnear(M.frame(M.flipped({...cam,...M.TOP})).fwd,[0,0,1],1e-9,"flip of top is bottom");
  // Matrices: the target projects to the centre; the inverse round-trips.
  const m=M.matrices(iso,1.5,{c:iso.target,r:20});
  vnear(M.project(m.vp,iso.target,300,200),[150,100],1e-4,"target at centre");
  const I=M.mul(m.vp,M.invert(m.vp));for(let i=0;i<16;i++)near(I[i],i%5===0?1:0,1e-5,"vp·vp⁻¹");
  assert.ok(m.near>0&&m.far>m.near&&m.far/m.near<=4000.0001,"depth range hugs the scene");
  // A ray through a pixel passes through the points that project there.
  for(const [nx,ny] of [[0,0],[0.5,-0.3],[-0.9,0.8]]){
    const r=M.ray(iso,1.5,nx,ny),p=[r.o[0]+r.d[0]*40,r.o[1]+r.d[1]*40,r.o[2]+r.d[2]*40],s=M.project(m.vp,p,300,200);
    vnear(s,[(nx+1)/2*300,(1-ny)/2*200],1e-3,"ray/projection agree");
  }
  // Orbit clamps the pitch; pan moves the target in the view plane; zoom keeps its anchor still.
  assert.equal(M.orbit(iso,0,1000).pitch,90);assert.equal(M.orbit(iso,0,-1000).pitch,-90);near(M.orbit(iso,10,0).yaw,iso.yaw-3.5);
  const pn=M.pan(iso,30,-20,200),moved=[pn.target[0]-iso.target[0],pn.target[1]-iso.target[1],pn.target[2]-iso.target[2]];
  near(moved[0]*fi.back[0]+moved[1]*fi.back[1]+moved[2]*fi.back[2],0,1e-9,"pan stays in the view plane");
  const anchor=[14,-2,1.6],before=M.project(m.vp,anchor,300,200),z=M.zoomAt(iso,anchor,0.5),after=M.project(M.matrices(z,1.5,{c:iso.target,r:20}).vp,anchor,300,200);
  vnear(after,before,1e-4,"zoom to cursor keeps the point under the cursor");near(z.dist,25);
  assert.equal(M.zoomAt(iso,null,1e-9,2,100).dist,2,"zoom clamps");
  // Camera animation: endpoints, shortest yaw path, monotone ease.
  const a={...iso,yaw:170},c={...iso,yaw:-170,dist:10};
  near(M.lerpCam(a,c,0).yaw,170);near(M.lerpCam(a,c,1).yaw,190);near(M.lerpCam(a,c,0.5).yaw,180,1e-9,"short way round");
  near(M.lerpCam(a,c,1).dist,10);near(M.ease(0),0);near(M.ease(1),1);near(M.ease(0.5),0.5);
  // Fit: every corner of the box lands inside the viewport.
  const box=[0,-30,-1,80,0,6];
  for(const asp of [0.5,1,2.5])for(const ang of [M.HOME,M.TOP,M.BOTTOM]){
    const fc=M.cameraFor(box,asp,ang),mm=M.matrices(fc,asp,{c:fc.target,r:60});
    for(let k=0;k<8;k++){const s=M.project(mm.vp,[box[k&1?3:0],box[k&2?4:1],box[k&4?5:2]],100,100);assert.ok(s[0]>=0&&s[0]<=100&&s[1]>=0&&s[1]<=100,"fit keeps corner "+k+" visible at aspect "+asp);}
  }
  // Ray-box and ray-triangle.
  assert.equal(M.rayBox([0,0,10],[0,0,-1],[-1,-1,0,1,1,2]),8);assert.equal(M.rayBox([5,0,10],[0,0,-1],[-1,-1,0,1,1,2]),Infinity);
  assert.equal(M.rayBox([0,0,1],[0,0,-1],[-1,-1,0,1,1,2]),0,"inside the box");
  const P=new Float32Array([0,0,0,1,0,0,0,1,0]);
  near(M.rayTri([0.2,0.2,5],[0,0,-1],P,0,1,2),5);near(M.rayTri([0.2,0.2,-5],[0,0,1],P,0,1,2),5,1e-9,"double-sided");
  assert.equal(M.rayTri([0.8,0.8,5],[0,0,-1],P,0,1,2),Infinity);
}

// ---- scene, instancing, picking on the sample board ------------------------------
const project=AtriumParts.example(),proj=project,board=project.documents.find(d=>d.kind==="pcb");

{
  const model=S.model(proj,board,{}),meshed=S.mesh(model),scene=V.buildScene(meshed);
  const comps=meshed.parts.filter(x=>x.kind==="component");
  assert.equal(scene.parts.length,comps.length,"one pickable instance per component");
  const unique=new Set(comps.map(c=>c.positions)).size;
  assert.equal(scene.batches.filter(b=>b.kind==="component").length,unique,"one batch per shared body");
  assert.ok(scene.batches.some(b=>b.instances.length>1),"repeated bodies are instanced");
  assert.ok(scene.box[3]>scene.box[0]&&scene.box[5]>model.board.thickness,"scene box covers board and bodies");
  // Pick from straight above each part: it hits that part, at its top.
  for(const inst of scene.parts){
    const c=[(inst.box[0]+inst.box[3])/2,(inst.box[1]+inst.box[4])/2],side=inst.side==="Bottom"?-1:1;
    const o=[c[0],c[1],side*100],d=[0,0,-side];
    const h=V.pick(scene,o,d,{});
    assert.equal(h.inst?.ref,inst.ref,"pick "+inst.ref);
    near(h.point[2],side>0?inst.box[5]:inst.box[2],1e-4,"hit on the body's top");
    assert.equal(V.pick(scene,o,d,{visible:x=>x!==inst}).inst?.ref===inst.ref,false,"hidden parts are not picked");
  }
  // Away from parts: components miss, surfaces hit the board's top.
  const ob=[scene.box[0]+(scene.box[3]-scene.box[0])*0.3,scene.box[1]+(scene.box[4]-scene.box[1])*0.5,100],db=[0,0,-1];
  assert.equal(V.pick(scene,ob,db,{}).inst,null,"no part at the probe point");
  const hb=V.pick(scene,ob,db,{surfaces:true});
  assert.equal(hb.inst?.kind,"board");near(hb.point[2],model.board.thickness,1e-4);
  assert.equal(V.pick(scene,[scene.box[0]+0.2,scene.box[1]+0.2,100],db,{surfaces:true}).inst,null,"the chamfered corner is empty");
  // A section plane hides what lies beyond it.
  const u=scene.parts[0],cx=(u.box[0]+u.box[3])/2,cy=(u.box[1]+u.box[4])/2,sd=u.side==="Bottom"?-1:1;
  assert.equal(V.pick(scene,[cx,cy,sd*100],[0,0,-sd],{clip:{n:[1,0,0],d:u.box[0]-0.01}}).inst===u,false,"clipped part is not picked");
  log("sample: "+scene.parts.length+" parts in "+scene.batches.length+" batches, "+scene.triangles+" triangles");
}

// ---- copper/silk compaction --------------------------------------------------------
{
  const m=S.model(proj,board,{copper:true,silk:true,components:false,holes:false});
  const layers=S.mesh(m).parts.filter(p=>p.kind==="copper"||p.kind==="silk");
  assert.ok(layers.length>0,"the sample has copper or silk");
  const direct=S.mesh(m,{flatLayerCaps:true}).parts.filter(p=>p.kind==="copper"||p.kind==="silk");
  assert.deepEqual(direct,layers.map(V.outerCaps),"the direct viewer caps preserve exact GPU geometry and picking order");
  for(const l of layers){
    const c=V.outerCaps(l),sign=l.side==="Bottom"?-1:1;
    assert.ok(c.indices.length<l.indices.length&&c.positions.length<l.positions.length,"compaction shrinks "+l.name);
    for(let i=0;i<c.indices.length;i++)assert.ok(c.indices[i]<c.positions.length/3);
    for(let v=0;v<c.normals.length;v+=3)assert.ok(c.normals[v+2]*sign>0.5,"only outward caps");
    // Every kept triangle faces outward.
    const P=c.positions,I=c.indices;
    for(let i=0;i<I.length;i+=3){const a=I[i]*3,b=I[i+1]*3,d=I[i+2]*3;
      const nz=(P[b]-P[a])*(P[d+1]-P[a+1])-(P[b+1]-P[a+1])*(P[d]-P[a]);assert.ok(nz*sign>=-1e-9,"winding of "+l.name);}
  }
}

// ---- build cache ---------------------------------------------------------------------
{
  const p=A.project("Numeric revision"), doc=p.documents.find(d=>d.kind==="pcb");
  doc.outline=[[0,0],[20,0],[20,15],[0,15]];
  const track={id:"track",kind:"track",layer:"Top",width:.8,points:[[3,3],[7,3]]};
  doc.items.push(track);
  const a=V.meshFor(p,doc,7,false), b=V.meshFor(p,doc,7,false);
  assert.equal(a,b,"same revision reuses the mesh");
  assert.equal(a.layers,null,"layers are built only when shown");
  const copper=V.meshFor(p,doc,7,true).layers;
  assert.ok(copper.some(l=>l.kind==="copper"),"the detached view supplies physical tracks");
  track.points=[[10,10],[16,10]];
  assert.equal(V.meshFor(p,doc,7,true).layers,copper,"the same numeric revision holds its snapshot");
  const next=V.meshFor(p,doc,8,true);
  assert.notDeepEqual(next.layers,copper,"the next numeric revision contains the moved track");
  const inputRevision={kind:"snapshot",projectId:p.id,rootId:doc.id,generation:"reference"};
  const geometryView=AtriumResolvedGeometry.read({kind:"snapshot",project:p,root:doc,revision:inputRevision});
  const {layers}=S.layersFor(p,doc,S.model(p,doc,{geometryView}),{copper:true,silk:true,maskOpenings:true,geometryView});
  const fresh=S.mesh({board:{bodies:[]},parts:[],layers},{tolerance:.02,flatLayerCaps:true,skipInvalidLayerPrisms:true});
  assert.deepEqual(next.layers,fresh.parts,"numeric input uses the same material as a full detached view");
}

// A fresh STEP build is the reference for both the reusable and invalidating paths.
{
  const U=AtriumUndoStore, P=AtriumPCBPours;
  const p=JSON.parse(JSON.stringify(AtriumParts.example())), [sheet,layout]=p.documents;
  const part=layout.items.find(i=>i.kind==="part"&&i.ref==="R1"), mate=sheet.items.find(i=>i.link===part.link);
  const wire=sheet.items.find(i=>i.kind==="wire"), def=p.library.find(i=>i.id===part.def);
  const hist=[],future=[];let revision=1;
  const fill=x=>P.region([[[1,1],[x,1],[x,6],[1,6]]],"Top","GND");
  layout.stackup=AtriumStackup.build(["Signal","Signal"]);
  layout.pcbDrawing={pours:[fill(5)]};
  layout.sourcePourSignature=P.signature(layout,new Map(p.library.map(d=>[d.id,d])));
  U.record(p);
  function assertFresh(c, project, message) {
    const geometryView=AtriumResolvedGeometry.read({kind:"editor", project, root:layout});
    const body=S.model(project,layout,{geometryView});
    const full=S.mesh(body,{tolerance:0.02,modelMesh:text=>AtriumSTEPImport.cached(text)});
    const {layers:artwork}=S.layersFor(project,layout,body,{copper:true,silk:true,maskOpenings:true,geometryView});
    const layers=S.mesh({board:{bodies:[]},parts:[],layers:artwork},{tolerance:0.02,flatLayerCaps:true,skipInvalidLayerPrisms:true}).parts;
    assert.deepEqual(c.meshed.parts,full.parts,message+" body, placements and materials agree");
    assert.deepEqual(c.layers,layers,message+" copper and silkscreen agree");
    assert.deepEqual(c.model.notes,body.notes,message+" notes agree");
  }
  let c=V.meshFor(p,layout,revision,true);
  assertFresh(c,p,"initial build");
  function check(reuse,message) {
    const next=V.meshFor(p,layout,++revision,true);
    assert.equal(next===c,reuse,message);
    assertFresh(next,p,message);
    return c=next;
  }
  function change(fn,reuse,message) {
    const mark=U.mark(p);fn();U.checkpoint(hist,future,mark,message);U.record(p);
    return check(reuse,message);
  }
  function jump(dir,reuse,message) {
    assert.ok(U.jump(hist,future,U.mark(p),dir));
    return check(reuse,message);
  }
  change(()=>{wire.points[0][0]-=2;},true,"a wire on another sheet retains the mesh");
  change(()=>{sheet.name="Renamed sheet";},true,"an unrelated document outer edit retains the mesh");
  change(()=>{mate.x+=4;},true,"moving a linked symbol without changing fitted state retains the mesh");
  change(()=>{p.componentFamilies=[{id:"passives",name:"Passives",members:[{defId:def.id}]}];},true,"library organization retains the mesh");
  jump(-1,true,"undoing library organization retains the mesh");
  jump(1,true,"redoing library organization retains the mesh");
  const beforeCopper=c.layers;
  change(()=>{layout.pcbDrawing.pours=[fill(8)];},true,"same-count replacement copper retains the body cache");
  assert.notDeepEqual(c.layers,beforeCopper,"new copper has different cap geometry");
  jump(-1,true,"undoing derived copper retains the body cache");
  assert.deepEqual(c.layers,beforeCopper,"undo restores copper geometry");
  jump(1,true,"redoing derived copper retains the body cache");
  change(()=>{mate.dnp=true;},false,"changing linked fitted state removes the board component");
  assert.ok(!c.meshed.parts.some(i=>i.id===part.id),"unfitted body is absent");
  jump(-1,false,"undoing a fitted-state change restores the board component");
  assert.ok(c.meshed.parts.some(i=>i.id===part.id),"restored body is present");
  const bom=globalThis.AtriumBOM;
  try {
    globalThis.AtriumBOM=undefined;
    check(true,"switching to equivalent fitted-state rules keeps the mesh");
    change(()=>{mate.value="Optional (DNP)";},true,"fallback fitted-state rules still include the part");
    globalThis.AtriumBOM=bom;
    const ready=V.meshFor(p,layout,revision,true);
    assert.notEqual(ready,c,"newly available fitted-state rules can invalidate without a new edit");
    assert.ok(!ready.meshed.parts.some(i=>i.id===part.id),"the fitted-state reader excludes marked components");
    assertFresh(ready,p,"late fitted-state reader");c=ready;
    jump(-1,false,"undoing a fitted-state comment restores the part");
  } finally {globalThis.AtriumBOM=bom;}
  const bodyOf=mesh=>mesh.meshed.parts.find(i=>i.id===part.id);
  const x=bodyOf(c).matrix[12], color=bodyOf(c).color;
  change(()=>{part.x+=1;part.ref="D1";},false,"a board placement and material change rebuilds");
  assert.equal(bodyOf(c).matrix[12],x+1,"placement changed");
  assert.notDeepEqual(bodyOf(c).color,color,"component material changed");
  jump(-1,false,"undo a placement change");assert.equal(bodyOf(c).matrix[12],x);
  jump(1,false,"redo a placement change");assert.equal(bodyOf(c).matrix[12],x+1);
  const thickness=c.model.board.thickness;
  change(()=>{layout.stackup.layers.find(x=>x.type==="Dielectric").thickness+=.2;},false,"same-identity board stack edit rebuilds");
  assert.ok(c.model.board.thickness>thickness,"stack changed board thickness");
  change(()=>{layout.outline[0][0]+=.3;},false,"same-length board outline edit rebuilds");
  const height=c.model.parts.find(i=>i.id===part.id).height;
  change(()=>{def.footprint.height=height+1;},false,"nested same-identity footprint edit rebuilds");
  assert.equal(c.model.parts.find(i=>i.id===part.id).height,height+1,"footprint edit changed body height");
  change(()=>{p.variants=[{id:"no-part",name:"No part",parts:{[part.link]:{fitted:false}}}];p.activeVariant="no-part";},false,"project variant change rebuilds");
  assert.ok(!bodyOf(c),"active variant excludes the part");
  jump(-1,false,"undo the project variant change");assert.ok(bodyOf(c));
  const solid=A.sheet("pcb","Model body");solid.outline=[[0,0],[5,0],[5,2],[0,2]];
  solid.items.push({id:"drill",kind:"via",x:1,y:1,diameter:1,drill:.6,layer:"Multi"});
  const stepText=S.export({name:solid.name,documents:[solid],library:[]},solid,{deterministic:true});
  change(()=>{part.model3d={stepText};},false,"an embedded STEP model replaces the generated body");
  assert.ok(bodyOf(c).boundsOnly,"a bounding box represents the model before tessellation");
  assert.ok(AtriumSTEPImport.ensure(stepText).parts.length,"the embedded model tessellates");
  const detailed=V.meshFor(p,layout,revision,true);
  assert.notEqual(detailed,c,"ready STEP geometry invalidates a placeholder at the same revision");
  assert.ok(!bodyOf(detailed).boundsOnly,"the mesh now uses the actual STEP geometry");
  assertFresh(detailed,p,"tessellated component model");c=detailed;
  change(()=>{p.documents.reverse();},false,"document ordering changes leave a conservative journal gap");
  const sameDocumentNewProject={...p,name:"Replacement project"};U.record(sameDocumentNewProject);
  const replacement=V.meshFor(sameDocumentNewProject,layout,++revision,true);
  assert.notEqual(replacement,c,"project identity invalidates even with the same board object");
  assertFresh(replacement,sameDocumentNewProject,"project replacement");
  U.reset();
}

// ---- GL lifetime against a recording mock -------------------------------------------
function mockGL(version,{exts={},samples=4,allocateVertexArray=()=>true}={}){
  const live=new Map(),log={created:0,deleted:0,lost:false,draws:0,instanced:0};let id=0;
  const obj=k=>{const o={k,id:++id};live.set(o,k);log.created++;return o;};
  const del=o=>{if(o&&live.delete(o))log.deleted++;};
  const consts=new Proxy({},{get:(_,k)=>typeof k==="string"?k:undefined});
  const vertexState=()=>({attributes:[],enabled:[],divisor:[],element:null});
  const defaultVAO=vertexState();
  let activeVAO=defaultVAO,arrayBuffer=null;
  Object.assign(log,{drawStates:[],vertexPointers:0,vertexArrayBinds:0,bufferBinds:0,updates:0});
  const gl={
    createBuffer:()=>obj("buffer"),deleteBuffer:del,createShader:()=>obj("shader"),deleteShader:del,createProgram:()=>obj("program"),deleteProgram:del,
    getShaderParameter:()=>true,getProgramParameter:()=>true,isContextLost:()=>false,getShaderInfoLog:()=>"",getProgramInfoLog:()=>"",
    getUniformLocation:(p,n)=>n,getParameter:k=>k==="SAMPLES"?samples:k==="RENDERER"?"mock":0,
    getExtension:n=>n==="WEBGL_lose_context"?{loseContext:()=>{log.lost=true;}}:exts[n]||null,
    createVertexArray:()=>allocateVertexArray()?Object.assign(obj("vao"),vertexState()):null,deleteVertexArray:del,
    bindVertexArray:vao=>{activeVAO=vao||defaultVAO;log.vertexArrayBinds++;},
    bindBuffer:(target,b)=>{if(target==="ARRAY_BUFFER")arrayBuffer=b;else activeVAO.element=b;log.bufferBinds++;},
    enableVertexAttribArray:i=>{activeVAO.enabled[i]=true;},
    vertexAttribDivisor:(i,n)=>{activeVAO.divisor[i]=n;},
    vertexAttribPointer:(i,...args)=>{activeVAO.attributes[i]=[arrayBuffer,...args];log.vertexPointers++;},
    bufferSubData:()=>{log.updates++;},
    drawElementsInstanced:(...args)=>{
      log.draws++;
      const {id,attributes,enabled,divisor,element}=activeVAO;
      log.drawStates.push({id,attributes:[...attributes],enabled:[...enabled],divisor:[...divisor],element,args});
    },
  };
  return {log,live,gl:new Proxy(gl,{get:(t,k)=>k in t?t[k]:typeof k==="string"&&/^[A-Z_0-9]+$/.test(k)?consts[k]:()=>{}})};
}
{
  const mk=mockGL(2),canvas={getContext:k=>k==="webgl2"?mk.gl:null};
  const R=V.createRenderer(canvas);
  assert.equal(R.version,2);assert.equal(R.samples,4);
  const meshed=S.mesh(S.model(proj,board,{})),scene=V.buildScene(meshed);
  R.upload(scene);
  for(const b of scene.batches){for(const x of b.instances)x.rgba=[1,1,1,1];R.instances(b,b.instances);}
  const expected=scene.batches.reduce((n,b)=>n+b.positions.byteLength+b.normals.byteLength+b.indices.byteLength+b.instances.length*80,0);
  assert.equal(R.bytes(),expected,"GPU budget counts every buffer once (shared bodies once)");
  assert.equal(R.live(),scene.batches.length*4,"position, normal, index and instance buffers per batch");
  const frame=()=>({w:10,h:10,bg:[0,0,0],m:M.matrices({target:[0,0,0],dist:10,yaw:0,pitch:30,fov:30},1,null),light:[0,0,1],hemi:[0,0,1],clip:null,edge:0.3,core:[1,1,1,1],opaque:scene.batches,blend:[]});
  const calls=R.draw(frame());
  assert.equal(calls,scene.batches.length,"one instanced draw per body");assert.equal(mk.log.draws,calls);
  const cold=mk.log.drawStates.slice();
  for(const [i,b] of scene.batches.entries()){
    assert.equal(cold[i].element,b.gl.idx);
    assert.deepEqual(cold[i].attributes.map(a=>a[0]),[b.gl.pos,b.gl.nor,b.gl.inst,b.gl.inst,b.gl.inst,b.gl.inst,b.gl.inst]);
    assert.deepEqual(cold[i].enabled,Array(7).fill(true));
    assert.deepEqual(cold[i].divisor,[0,0,1,1,1,1,1]);
  }
  const binds=mk.log.bufferBinds,pointers=mk.log.vertexPointers,vaos=mk.log.vertexArrayBinds;
  R.draw({...frame(),clip:[1,0,0,2]});
  assert.deepEqual(mk.log.drawStates.slice(calls),cold,"a new frame retains the same vertex/index inputs and ordering");
  assert.equal(mk.log.vertexPointers,pointers,"a warm frame does not restate attribute pointers");
  assert.equal(mk.log.bufferBinds,binds,"a warm frame does not rebind geometry buffers");
  assert.equal(mk.log.vertexArrayBinds-vaos,calls+1,"one VAO bind per draw and a final reset");
  const original=scene.batches[0],state=original.gl,oldVAO=state.vao,oldInstance=state.inst;
  original.instances[0].rgba=[0,1,0,1];
  R.instances(original,original.instances);
  assert.equal(mk.log.updates,1,"color changes update instance data");
  assert.equal(state.vao,oldVAO,"subdata writes retain the vertex array");
  R.instances(original,[...original.instances,original.instances[0]]);
  assert.notEqual(state.inst,oldInstance,"growing past capacity replaces the instance buffer");
  assert.ok(!mk.live.has(oldVAO),"instance replacement deletes the captured VAO");
  R.draw(frame());
  assert.equal(mk.log.drawStates[calls*2].attributes[6][0],state.inst,"the replacement draw uses the new instance buffer");
  const replacement={...scene,batches:scene.batches.map(b=>({...b}))};
  const retainedVAO=state.vao;
  R.upload(replacement,true);
  assert.equal(replacement.batches[0].gl.vao,retainedVAO,"incremental upload transfers preserved mesh and instance bindings");
  R.instances(replacement.batches[0],[]);
  assert.equal(R.draw({...frame(),opaque:replacement.batches}),calls-1,"an empty batch does not submit its cached VAO");
  R.instances(replacement.batches[0],original.instances);
  assert.equal(R.draw({...frame(),opaque:replacement.batches}),calls,"restored visibility resumes the same batch");
  assert.equal(replacement.batches[0].gl.vao,retainedVAO,"hide/show inside capacity preserves the binding");
  R.upload(scene);assert.equal(R.live(),scene.batches.length*3,"re-upload releases the old buffers first");
  R.dispose();
  assert.equal(R.live(),0);assert.equal(mk.live.size,0,"every GL object is deleted on close");assert.equal(mk.log.created,mk.log.deleted);assert.ok(mk.log.lost,"the context is released");
}
{
  let allocations=0;
  const mk=mockGL(2,{allocateVertexArray:()=>++allocations!==2});
  const R=V.createRenderer({getContext:k=>k==="webgl2"?mk.gl:null});
  const scene=V.buildScene(S.mesh(S.model(proj,board,{})));
  assert.ok(scene.batches.length>=2);
  R.upload(scene);
  for(const b of scene.batches){for(const x of b.instances)x.rgba=[1,1,1,1];R.instances(b,b.instances);}
  const args={w:1,h:1,bg:[0,0,0],m:M.matrices({target:[0,0,0],dist:10,yaw:0,pitch:30,fov:30},1,null),light:[0,0,1],hemi:[0,0,1],clip:null,edge:0,core:null,opaque:scene.batches,blend:[]};
  R.draw(args);
  assert.notEqual(mk.log.drawStates[0].id,undefined,"a successful allocation binds a VAO");
  assert.equal(mk.log.drawStates[1].id,undefined,"allocation failure uses the default vertex array");
  assert.equal(mk.log.drawStates[1].element,scene.batches[1].gl.idx);
  R.draw(args);
  assert.deepEqual(mk.log.drawStates[scene.batches.length],mk.log.drawStates[0],"fallback did not overwrite the previous VAO");
  R.dispose();
  assert.equal(mk.live.size,0);
}
// Fallbacks: WebGL1 needs instancing and 32-bit indices; nothing at all returns null.
{
  assert.equal(V.createRenderer({getContext:()=>null}),null);
  const bare=mockGL(1);assert.equal(V.createRenderer({getContext:k=>k==="webgl"?bare.gl:null}),null,"WebGL1 without extensions falls back");
  assert.ok(bare.log.lost,"a rejected context is released");
  let divisors=0,inst=0;
  const ok=mockGL(1,{exts:{ANGLE_instanced_arrays:{vertexAttribDivisorANGLE:()=>divisors++,drawElementsInstancedANGLE:()=>inst++},OES_element_index_uint:{}}});
  const R=V.createRenderer({getContext:k=>k==="webgl"?ok.gl:null});
  assert.equal(R.version,1);assert.equal(divisors,7);
  const scene=V.buildScene(S.mesh(S.model(proj,board,{})));R.upload(scene);for(const b of scene.batches){for(const x of b.instances)x.rgba=[1,1,1,1];R.instances(b,b.instances);}
  R.draw({w:1,h:1,bg:[0,0,0],m:M.matrices({target:[0,0,0],dist:10,yaw:0,pitch:30,fov:30},1,null),light:[0,0,1],hemi:[0,0,1],clip:[1,0,0,5],edge:0,core:null,opaque:scene.batches,blend:[]});
  assert.equal(inst,scene.batches.length,"WebGL1 draws through ANGLE_instanced_arrays");
  R.dispose();assert.equal(ok.live.size,0);
}
// Options and reduced motion work without a DOM.
assert.equal(V.isOpen(),false);assert.equal(V.command("fit"),false);assert.equal(V.stats(),null);
assert.ok(V.MASKS.some(([n,c])=>n==="Green"&&c===V.DEFAULTS.mask),"green solder mask by default");
assert.equal(typeof V.reducedMotion(),"boolean");

// A real viewer using a minimal surface and recording GL context. A hidden edit
// must leave both the CPU mesh and the uploaded scene at the last painted revision.
{
  const restored=new Map(), frames=new Map(), timers=new Map(), powerListeners=new Set(), mk=mockGL(2), U=AtriumUndoStore;
  const install=(name,value)=>{restored.set(name,Object.getOwnPropertyDescriptor(globalThis,name));globalThis[name]=value;};
  let seq=0, shown=true, builds=0;
  const elt=()=>({style:{},children:[],isConnected:true,clientWidth:500,clientHeight:360,
    append(...children){this.children.push(...children);},insertBefore(){},setAttribute(){},querySelector(){return null;},
    addEventListener(){},removeEventListener(){},remove(){},focus(){},contains(){return false;},
    getContext:k=>k==="webgl2"?mk.gl:null});
  // Copper and silk build in time slices (one timer each): drain the timers a slice schedules.
  const run=jobs=>{for(let n=0;n<200&&jobs.size;n++)for(const [id,fn] of [...jobs])if(jobs.delete(id))fn();};
  const setVisible=value=>{shown=value;for(const f of powerListeners)f({visible:value});};
  install("document",{createElement:elt,createElementNS:elt,querySelector:()=>null,head:elt(),visibilityState:"visible"});
  install("requestAnimationFrame",fn=>{frames.set(++seq,fn);return seq;});
  install("cancelAnimationFrame",id=>frames.delete(id));
  install("setTimeout",fn=>{timers.set(++seq,fn);return seq;});
  install("clearTimeout",id=>timers.delete(id));
  install("AtriumPower",{visible:()=>shown,onChange(fn){powerListeners.add(fn);return ()=>powerListeners.delete(fn);}});
  // One model per build: the board and bodies, or the copper and silk overlay (meshed in chunks).
  install("AtriumSTEP",{...S,model(...args){builds++;return S.model(...args);},
    layerStepsFor(...args){builds++;return S.layerStepsFor(...args);}});
  const project=AtriumParts.example(),[sheet,doc]=project.documents,stage=elt();let revision=1;
  const part=doc.items.find(i=>i.kind==="part"), wire=sheet.items.find(i=>i.kind==="wire");
  project.parameters={...project.parameters,Revision:"A"};
  doc.items.push({id:"revision-silk",kind:"label",layer:"Silk",x:6,y:8,text:".Revision",size:2});
  let v;
  try {
    U.record(project);v=V.open({doc,stage,project,revision:()=>revision});run(timers);run(frames);
    assert.equal(builds,2,"first visible view computes body and overlay once");
    const first=v.scene(), draws=mk.log.draws;
    v.camera({yaw:35});run(frames);
    assert.equal(v.scene(),first,"moving the camera reuses the uploaded scene");
    assert.ok(mk.log.draws>draws,"the new camera still draws");
    wire.points[0][0]-=1;U.touch(project);revision++;v.refresh();
    assert.equal(U.documentVersions(doc,project),null,"painting does not sync pending history");
    run(timers);run(frames);
    assert.equal(v.scene(),first,"settling an unrelated sheet edit retains the uploaded scene");
    project.parameters={...project.parameters,Revision:"Board B"};U.record(project);revision++;v.refresh();run(timers);run(frames);
    const parameterScene=v.scene(), parameterBuilds=builds;
    const silkPositions=scene=>scene.batches.filter(b=>b.kind==="silk").map(b=>b.positions);
    assert.notDeepEqual(silkPositions(parameterScene),silkPositions(first),"a project parameter changes the uploaded board inscription");
    setVisible(false);
    const hiddenDraws=mk.log.draws;
    part.x+=1;U.record(project);revision++;v.refresh();v.camera({yaw:45});v.renderNow();v.refold();
    run(timers);run(frames);
    assert.equal(builds,parameterBuilds,"hidden changes leave the mesh untouched");
    assert.equal(mk.log.draws,hiddenDraws,"hidden camera and refold requests do not draw");
    assert.equal(v.scene(),parameterScene,"no scene is uploaded while hidden");
    setVisible(true);run(timers);run(frames);
    assert.equal(builds,parameterBuilds+2,"one current body and overlay build after reveal");
    near(v.scene().parts.find(i=>i.id===part.id).matrix[12],part.x,1e-5,"the revealed mesh uses the current placement");
    v.close();run(timers);

    // The first 3D camera looks straight down (-Z) over what the 2D view framed; the last 3D camera
    // is kept per document (editor.js camera3d) and comes back on the next 3.
    let stored=null;const view2d={cx:40,cy:-25,scale:6,flipped:false};
    const ctx3={doc,stage,project,revision:()=>revision,view2d:()=>view2d,camera3d:c=>c===undefined?stored:(stored=c)};
    v=V.open(ctx3);run(timers);run(frames);
    let cam=v.camera(),f=M.frame(cam);
    vnear(f.fwd,[0,0,-1],1e-9,"the first 3D view looks straight down");
    vnear(f.right,[1,0,0],1e-9,"x runs right as in 2D");vnear(f.up,[0,1,0],1e-9,"design y up the screen as in 2D");
    vnear(cam.target.slice(0,2),[40,25],1e-9,"centred where the 2D view was");
    near(2*cam.dist*Math.tan(cam.fov*Math.PI/360),360/6,1e-6,"the board plane shows the 2D view's height");
    assert.equal(stored,null,"an untouched first camera is not stored");
    const turned={target:[12,-3,1],dist:140,yaw:-60,pitch:35,fov:30};
    v.camera(turned);run(frames);v.close();run(timers);
    assert.deepEqual(stored,turned,"leaving 3D stores the last camera");
    view2d.cx=0;v=V.open(ctx3);run(timers);run(frames);
    assert.deepEqual(v.camera(),turned,"pressing 3 again returns to it, not to the 2D framing");
    v.close();run(timers);
    // A bottom (flipped) 2D view starts from below, mirrored as the 2D view is.
    stored=null;view2d.flipped=true;v=V.open(ctx3);run(timers);run(frames);
    f=M.frame(v.camera());vnear(f.fwd,[0,0,1],1e-9,"a flipped board opens looking up");vnear(f.right,[-1,0,0],1e-9,"mirrored in x like the flipped 2D view");
    // Malformed stored state falls back to the 2D framing.
    v.close();run(timers);stored={target:[NaN,0,0],dist:1,yaw:0,pitch:0};view2d.flipped=false;
    v=V.open(ctx3);run(timers);run(frames);vnear(M.frame(v.camera()).fwd,[0,0,-1],1e-9,"bad stored cameras are ignored");
    v.close();run(timers);
    // Without ctx.camera3d: in memory for the document, and in a folder project's local workspace
    // state (setView merges, as folder-project.js), so a reopen of the folder restores it.
    const session={localState:{cameras:{x:1}},setView(x){this.localState={...this.localState,...x};return Promise.resolve();}};
    v=V.open({doc,stage,project,revision:()=>revision,view2d:()=>view2d,folder:()=>session});run(timers);run(frames);
    v.camera(turned);run(frames);v.close();run(timers);
    assert.deepEqual(session.localState.cameras3d[doc.id],turned,"the folder's workspace state holds the 3D camera");
    assert.deepEqual(session.localState.cameras,{x:1},"beside the 2D cameras, which it leaves alone");
    v=V.open({doc,stage,project,revision:()=>revision,view2d:()=>view2d});run(timers);run(frames);
    assert.deepEqual(v.camera(),turned,"2 then 3 returns to the last camera");v.close();run(timers);
    const reopened={...doc},project2={...project,documents:project.documents.map(d=>d===doc?reopened:d)};
    const disk={localState:JSON.parse(JSON.stringify(session.localState)),setView(){}};
    v=V.open({doc:reopened,stage,project:project2,revision:()=>revision,view2d:()=>view2d,folder:()=>disk});run(timers);run(frames);
    assert.deepEqual(v.camera(),turned,"and so does reopening the folder");
    v.close();run(timers);
    {
      // C4: exercise the actual visible receiver, with the editor's committed
      // view and an independently seeded snapshot for every full comparison.
      const R=AtriumResolvedGeometry, p=A.project("Physical redraw"), d=p.documents.find(d=>d.kind==="pcb");
      d.outline=[[0,0],[40,0],[40,24],[0,24]];
      const track={id:"window-track",kind:"track",layer:"Top",width:.8,points:[[3,3],[7,3]]};
      const resistor=proj.library.find(def=>def.id==="std-r");
      p.library.push(resistor);
      const part=(id,x)=>({id,kind:"part",def:resistor.id,ref:id,x,y:18,angle:0,layer:"Top",pinNets:{}});
      const firstPart=part("R001",10), secondPart=part("R002",25);
      d.items.push(track,firstPart,secondPart,{id:"untouched-silk",kind:"graphic",shape:"line",layer:"Silk",width:.2,points:[[3,9],[7,9]]});
      const second=A.sheet("pcb","Other PCB");
      second.outline=[[0,0],[6,0],[6,6],[0,6]];
      p.documents.push(second);
      let active=d, selected=[], physical=0;
      const layerReads=[], views=new WeakMap();
      const layerOptions={copper:true,silk:true,maskOpenings:true};
      const current=d=>R.read({kind:"editor",project:p,root:d});
      function observe(view){
        if(!views.has(view))views.set(view,{
          get revision(){return view.revision;},get layers(){return view.layers;},
          assertCurrent:()=>view.assertCurrent(),changes:since=>view.changes(since),
          ...Object.fromEntries(["owner","bores","features","area","layerArea","diagnostics"].map(name=>
            [name,(...args)=>{physical++;return view[name](...args);}]))
        });
        return views.get(view);
      }
      globalThis.AtriumSTEP={...S,layerStepsFor(...args){layerReads.push(...args[3].layerKeys);return S.layerStepsFor(...args);}};
      install("AtriumNavHost",{project:()=>p,boardGeometry:doc=>observe(current(doc)),
        prepareBoardGeometry(){throw Error("ready shared input must not be loaded again");}});
      U.record(p);
      v=V.open({doc:d,stage,project:p,document:()=>active,selection:()=>selected,revision:()=>revision});
      const settle=()=>{run(timers);run(frames);};
      const batches=scene=>scene.batches.flatMap(b=>b.kind==="component" ? [] :
        b.instances.map(i=>[b.kind,b.side,b.positions,b.normals,b.indices,i.matrix]));
      const parts=scene=>scene.parts.map(p=>[p.id,p.matrix,p.batch.positions,p.batch.normals,p.batch.indices]);
      function fresh(){
        const view=R.read({kind:"snapshot",project:p,root:active,revision:current(active).revision});
        const model=S.model(p,active,{geometryView:view});
        const {layers}=S.layersFor(p,active,model,{...layerOptions,geometryView:view});
        const mesh=S.mesh({...model,layers},{tolerance:.02,flatLayerCaps:true,skipInvalidLayerPrisms:true});
        return V.buildScene(mesh);
      }
      const compare=label=>{
        const reference=fresh();
        assert.deepEqual(batches(v.scene()),batches(reference),label);
        assert.deepEqual(parts(v.scene()),parts(reference),label);
      };
      settle();compare("first shared publication");
      const first=v.scene(), silk=first.batches.find(b=>b.kind==="silk"), solids=first.batches.find(b=>b.kind==="board");
      assert.ok(silk && solids,"both an unchanged film and substrate are visible");
      physical=0;layerReads.length=0;selected=[track.id];v.refresh();v.camera({yaw:47});settle();
      assert.equal(physical,0,"selection and the camera do not read physical geometry");
      assert.deepEqual(layerReads,[]);
      const undo=[],redo=[];
      function edit(fn, flush=true){
        const mark=U.mark(p);fn();U.checkpoint(undo,redo,mark,"physical edit");U.record(p);
        revision++;v.refresh();if(flush)settle();
      }
      edit(()=>p.library.push({id:"unused-definition",name:"Unused"}));
      assert.equal(physical,0,"an unrelated definition does not read physical geometry");
      assert.deepEqual(layerReads,[]);
      const prev=current(d), token=prev.revision;
      const silkKey={kind:"item",documentId:d.id,instancePath:[],id:"untouched-silk"}, silkOwner=prev.owner(silkKey);
      edit(()=>{track.points=[[23,12],[28,12]];track.layer="Bottom";});
      const next=current(d), change=next.changes(token);
      assert.ok(change.layers.includes("Top") && change.layers.includes("Bottom"));
      assert.deepEqual(change.bounds,[[2.6,2.6,7.4,3.4],[22.6,11.6,28.4,12.4]],"both disjoint swept extents reach the receiver");
      assert.equal(next.owner(silkKey),silkOwner);
      assert.deepEqual(layerReads,["Top","Bottom"],"only the two changed films are encoded");
      assert.equal(v.scene().batches.find(b=>b.kind==="silk").positions,silk.positions,"the unaffected GPU mesh retains its arrays");
      assert.equal(v.scene().batches.find(b=>b.kind==="board").positions,solids.positions,"a track edit reuses the substrate mesh");
      compare("move agrees with a full detached mesh");
      edit(()=>{d.items.splice(d.items.findIndex(i=>i.id===track.id),1);});
      compare("deleted old-layer mesh is absent");
      for(const [direction,label] of [[-1,"Undo delete"],[-1,"Undo move"],[1,"Redo move"],[1,"Redo delete"]]){
        assert.ok(U.jump(undo,redo,U.mark(p),direction));U.record(p);revision++;v.refresh();settle();compare(label);
      }
      edit(()=>{d.items.push({...track,layer:"Top",points:[[8,8],[10,8]]});},false);
      const late=[...timers.values()];
      edit(()=>{d.items.find(i=>i.id===track.id).points=[[12,15],[16,15]];});
      for(const callback of late)callback();
      compare("a delayed publication cannot replace a newer film");
      const secondBody=v.scene().parts.find(part=>part.id===secondPart.id).batch.positions;
      edit(()=>{firstPart.x+=2;});
      compare("a local component edit retains the correct board and placements");
      assert.equal(v.scene().parts.find(part=>part.id===secondPart.id).batch.positions,secondBody);
      edit(()=>{d.items.push({id:"bore",kind:"via",x:6,y:7,diameter:1,drill:.5,layer:"Multi"});});
      compare("a new bore changes the affected substrate");
      assert.equal(v.scene().parts.find(part=>part.id===secondPart.id).batch.positions,secondBody,"redoing the drilled board retains unrelated bodies");
      const beforeSwitch=v.scene().batches.find(b=>b.kind==="silk").positions;
      active=second;v.refresh();settle();compare("other document reads its own root");
      active=d;v.refresh();settle();compare("first document keeps its current mesh");
      assert.equal(v.scene().batches.find(b=>b.kind==="silk").positions,beforeSwitch);
    }
  } finally {
    v?.close();run(timers);U.reset();
    for(const [name,descriptor] of restored)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
  }
}

// ---- lazy loading ---------------------------------------------------------------------
{
  const html=fs.readFileSync(path.join(__dirname,"../../app/index.html"),"utf8"),editor=fs.readFileSync(path.join(__dirname,"../../app/editor/editor.js"),"utf8");
  assert.ok(!/<script[^>]+view3d\.js/.test(html),"view3d.js is not loaded at startup");
  assert.ok(!/<link[^>]+view3d\.css/.test(html),"view3d.css is not loaded at startup");
  const at=editor.indexOf("function load3D(then){");
  if(at<0)log("SKIP lazy-load check: the view3d integration patch is not applied to editor.js");
  else{
    // Run the editor's loader against a fake document.
    let end=at,depth=0;for(let i=editor.indexOf("{",at);i<editor.length;i++){if(editor[i]==="{")depth++;else if(editor[i]==="}"&&--depth===0){end=i+1;break;}}
    const src=editor.slice(at,end),scripts=[],notes=[];
    const doc={createElement:t=>({tag:t,remove(){this.removed=true;}}),head:{append:s=>scripts.push(s)}};
    const make=new Function("document","info","globalThis","let load3DBusy=false;"+src+";return load3D;");
    const G={};const load=make(doc,t=>notes.push(t),G);
    let opened=0;
    load(()=>opened++);load(()=>opened++);
    assert.equal(scripts.length,1,"one script tag while loading");assert.equal(scripts[0].src,"canvas/view3d.js","relative src works under file://");
    assert.equal(opened,0);
    G.Atrium3D={};scripts[0].onload();assert.equal(opened,1,"opens once the module is defined");
    load(()=>opened++);assert.equal(opened,2);assert.equal(scripts.length,1,"never injected twice");
    // A failed load reports and can be retried.
    const G2={},s2=[],n2=[];const load2=new Function("document","info","globalThis","let load3DBusy=false;"+src+";return load3D;")({createElement:()=>({remove(){this.removed=true;}}),head:{append:s=>s2.push(s)}},t=>n2.push(t),G2);
    load2(()=>{throw Error("must not open");});s2[0].onerror();assert.ok(s2[0].removed&&/STEP/.test(n2.at(-1)),"failure offers STEP export");
    load2(()=>{});assert.equal(s2.length,2,"retry after a failure");
    log("lazy load: one relative <script> on the first 3, none at startup");
  }
}

// ---- synthetic 500-part, 10k-hole board: CPU side of opening and picking -------------
{
  const lib=project.library,res=lib.find(d=>d.id==="std-r"),hdr=lib.find(d=>/header/i.test(d.name));
  const p=A.project("Big",lib),d=p.documents.find(x=>x.kind==="pcb");
  d.outline=[[0,0],[200,0],[200,150],[0,150]];
  let n=0;
  for(let i=0;i<25&&n<500;i++)for(let j=0;j<20&&n<500;j++,n++){const def=n%10===0?hdr:res;
    d.items.push({id:"p"+n,kind:"part",def:def.id,ref:(def===res?"R":"J")+n,x:6+i*7.6,y:5+j*7,angle:(n%4)*90,layer:n%3?"Top":"Bottom",pinNets:{}});}
  for(let k=0;k<20000;k++){const x=2+(k%140)*1.4,y=3.2+Math.floor(k/140)*2.07;if(y>148)break;d.items.push({id:"v"+k,kind:"via",x,y,diameter:.5,drill:.25,layer:"Multi"});}
  const t0=now(),c=V.meshFor(p,d,1,false),t1=now(),scene=V.buildScene({parts:c.meshed.parts}),t2=now();
  assert.equal(scene.parts.length,500);
  assert.ok(scene.batches.filter(b=>b.kind==="component").length<=8,"500 parts share a handful of bodies");
  const cam=M.cameraFor(scene.box,1.6,M.HOME);let hits=0;const t3=now();
  for(let i=0;i<200;i++){const r=M.ray(cam,1.6,(i%20)/10-0.95,Math.floor(i/20)/5-0.95);if(V.pick(scene,r.o,r.d,{}).inst)hits++;}
  const t4=now();
  const r=M.ray({...cam,yaw:-90,pitch:90},1.6,0.01,0.02),t5=now(),hb=V.pick(scene,r.o,r.d,{surfaces:true}),t6=now();
  assert.equal(hb.inst?.kind,"board","surface pick reaches the board");
  log("synthetic: model+mesh "+(t1-t0).toFixed(0)+" ms, scene "+(t2-t1).toFixed(1)+" ms, "+scene.triangles+" triangles (no copper/silk), "+(scene.cpuBytes/1048576).toFixed(1)+" MB; hover pick "+((t4-t3)/200).toFixed(3)+" ms ("+hits+"/200 hits); board surface pick "+(t6-t5).toFixed(1)+" ms");
}
log("PASS view3d: camera maths, instanced scene, picking, layer compaction, cache, GL lifetime, fallback and lazy loading.");
