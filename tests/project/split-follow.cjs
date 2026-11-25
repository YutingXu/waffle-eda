"use strict";
// Schematic | Board split with Follow (app/project/split-follow.js), headless: counterpart resolution, the follow
// target, the in-view test and camera clamp, the eased camera (full, reduced, off) and Follow end to end
// against a fake two-pane editor host. The active pane never moves and never takes focus.
const assert=require("node:assert/strict");
require("../../app/core/model.js");require("../../app/library/parts.js");require("../../app/formats/import-link.js");require("../../app/checks/connectivity.js");
require("../../app/editor/nav-common.js");require("../../app/editor/crossprobe.js");require("../../app/editor/editor-motion.js");require("../../app/project/split-follow.js");
const A=Atrium,C=AtriumNavCommon,X=AtriumCrossProbe,F=AtriumSplitFollow,M=AtriumMotion;
const clone=o=>JSON.parse(JSON.stringify(o));
const project=AtriumParts.example(),defs=new Map(project.library.map(d=>[d.id,d]));
const sch=project.documents.find(d=>d.kind==="schematic"),pcb=project.documents.find(d=>d.kind==="pcb");
const part=(d,ref)=>d.items.find(i=>i.kind==="part"&&i.ref===ref);
const near=(a,b,eps=1e-6)=>Math.abs(a-b)<=eps*Math.max(1,Math.abs(a),Math.abs(b));

// ---------------------------------------------------------------- counterpart resolution
assert.equal(F.counterpartFor(project,defs,sch.id,[]),pcb.id,"a schematic pairs with its board");
assert.equal(F.counterpartFor(project,defs,pcb.id,[]),sch.id,"a board pairs with its schematic");
assert.equal(F.counterpartFor({documents:[sch]},defs,sch.id,[]),null,"no board: nothing to split with");
{
  // Two sheets: R1 lives on the second one. Two boards: the second is empty.
  const p=clone(project),s1=p.documents.find(d=>d.kind==="schematic"),b=p.documents.find(d=>d.kind==="pcb");
  const r1=part(s1,"R1");s1.items=s1.items.filter(i=>i!==r1);
  const s2={...clone(s1),id:"sheet-2",name:"Power",items:[r1]};p.documents.splice(1,0,s2);
  p.documents.push({...clone(b),id:"board-2",name:"Spare board",items:[],outline:[]});
  const d2=new Map(p.library.map(d=>[d.id,d]));
  assert.equal(F.counterpartFor(p,d2,b.id,[part(b,"R1").id]),"sheet-2","a board picks the sheet of the selected part");
  assert.equal(F.counterpartFor(p,d2,b.id,[part(b,"U1").id]),s1.id,"... and another part's sheet");
  assert.equal(F.counterpartFor(p,d2,b.id,[]),s1.id,"nothing selected: the first schematic");
  const vin=b.items.find(i=>i.kind==="track"&&i.net==="VIN");
  assert.equal(F.counterpartFor(p,d2,b.id,[vin.id]),s1.id,"a selected track picks a sheet that carries its net");
  assert.equal(F.counterpartFor(p,d2,s1.id,[]),b.id,"a sheet picks the board holding most of its parts, not the empty one");
  assert.equal(F.counterpartFor(p,d2,"sheet-2",[r1.id]),b.id,"a part's board");
}

// ---------------------------------------------------------------- follow target
const u1s=part(sch,"U1"),u1b=part(pcb,"U1");
{
  const t=F.followTarget(project,defs,sch.id,[u1s.id],{toId:pcb.id});
  assert.equal(t.docId,pcb.id);assert.deepEqual(t.ids,[u1b.id],"a part maps to its footprint");
  {const ib=C.itemBox(pcb,defs,u1b);assert.ok(t.box[0]<=ib[0]&&t.box[1]<=ib[1]&&t.box[2]>=ib[2]&&t.box[3]>=ib[3],"the box covers the body");for(const p of A.pins(u1b,defs.get(u1b.def),"pcb"))assert.ok(C.inside(p.at,t.box),"and every pad");}assert.equal(t.label,"U1");
  const back=F.followTarget(project,defs,pcb.id,[u1b.id],{toId:sch.id});
  assert.equal(back.docId,sch.id);assert.deepEqual(back.ids,[u1s.id],"and back");
  // A click on a pin: the pad on the board, not the whole part.
  const pin=A.pins(u1s,defs.get(u1s.def),"schematic").find(p=>!p.hidden);
  const tp=F.followTarget(project,defs,sch.id,[u1s.id],{toId:pcb.id,point:pin.at});
  assert.equal(tp.kind,"pin");assert.equal(tp.label,"U1-"+pin.number);
  const pb=C.itemBox(pcb,defs,u1b);
  assert.ok(tp.box[2]-tp.box[0]<pb[2]-pb[0]+8,"the pin box is pad-sized");
  // Copper selection: the net's wires on the sheet.
  const vin=pcb.items.find(i=>i.kind==="track"&&i.net==="VIN");
  const tn=F.followTarget(project,defs,pcb.id,[vin.id],{toId:sch.id});
  assert.equal(tn.docId,sch.id);assert.equal(tn.kind,"net");assert.ok(tn.ids.length>0&&tn.box);
  // Nothing selected but a highlighted net (Ctrl/⌘+click): the net in the other document.
  const th=F.followTarget(project,defs,pcb.id,[],{toId:sch.id,highlight:"VIN"});
  assert.equal(th.label,"net VIN");assert.ok(th.box);
  assert.equal(F.followTarget(project,defs,pcb.id,[],{toId:sch.id}),null,"nothing selected, nothing to follow");
  // Several parts: one camera over all of them.
  const rs=part(sch,"R1"),cs=part(sch,"C1");
  const tm=F.followTarget(project,defs,sch.id,[rs.id,cs.id],{toId:pcb.id});
  assert.equal(tm.ids.length,2);assert.equal(tm.label,"2 parts");
  assert.ok(C.inside(C.itemBox(pcb,defs,part(pcb,"R1")).slice(0,2),tm.box)&&C.inside(C.itemBox(pcb,defs,part(pcb,"C1")).slice(2),tm.box),"one box over both");
}

// ---------------------------------------------------------------- in view, camera clamp
{
  const W=800,H=600,box=[10,10,14,13];
  const fit=F.cameraFor(box,W,H,{cx:0,cy:0,scale:4,referenceScale:4,flipped:true},"pcb");
  assert.equal(fit.flipped,true,"a flipped board stays flipped");
  assert.ok(Math.min(W,H)/fit.scale>=F.MIN_SPAN.pcb-1e-9,"a small part is not zoomed in absurdly far");
  assert.ok(near(fit.cx,12)&&near(fit.cy,11.5),"centred on the part");
  const big=[0,0,400,300],fb=F.cameraFor(big,W,H,{cx:0,cy:0,scale:1,referenceScale:1},"pcb");
  assert.ok(400*fb.scale<=W*(1-.3)+1e-6,"a big target fits with margin");
  assert.ok(F.inView(box,fit,W,H,"pcb"),"the fitted camera has it in view");
  assert.ok(!F.inView(box,{cx:100,cy:100,scale:10},W,H,"pcb"),"off screen: move");
  assert.ok(!F.inView([79,10,83,13],{cx:12,cy:11.5,scale:10},W,H,"pcb"),"at the edge (inside the comfort inset): move");
  assert.ok(!F.inView(box,{cx:12,cy:11.5,scale:.5},W,H,"pcb"),"in view but a speck on a zoomed-out board: zoom in");
  assert.ok(F.inView([12,11.4,12.2,11.6],{cx:12,cy:11.5,scale:Math.min(W,H)/F.MIN_SPAN.pcb},W,H,"pcb"),"a speck already at the closest Follow zoom: stay");
  const sf=F.cameraFor([0,0,2,2],W,H,{cx:0,cy:0,scale:1},"schematic");
  assert.ok(Math.min(W,H)/sf.scale>=F.MIN_SPAN.schematic-1e-9,"schematic minimum span");
}

// ---------------------------------------------------------------- glide: full motion, reduced, off
let frames=[];
globalThis.requestAnimationFrame=f=>{frames.push(f);return frames.length;};
function pump(ms=1000,step=16){let t=0;for(let i=0;i<500&&frames.length;i++){const q=frames;frames=[];t+=step;for(const f of q)f(t);if(t>ms)break;}}
function fakePane(cam,{w=800,h=600}={}){
  const log={restores:0,moving:0,settle:0,focus:0,cams:[]};
  let c={...cam};
  return {log,active:false,docId:null,canvas:{clientWidth:w,clientHeight:h,focus(){log.focus++;},getBoundingClientRect:()=>({left:0,top:0}),parentElement:null},
    view:{camera:()=>({...c}),restoreCamera(n){c={...n};log.restores++;log.cams.push({...n});},moving(){log.moving++;},settle(){log.settle++;},
      worldToScreen:([x,y])=>[(x-c.cx)*c.scale+w/2,(y-c.cy)*c.scale+h/2]}};
}
{
  const box=C.itemBox(pcb,defs,u1b),start={cx:-200,cy:-200,scale:2,referenceScale:2};
  let paints=0;
  const p=fakePane(start),r=F.glide(p,box,{kind:"pcb",level:"full",repaint:()=>paints++});
  assert.equal(r,"moved");
  assert.equal(p.log.restores,0,"nothing moves before the first frame");
  pump();
  const want=F.cameraFor(box,800,600,start,"pcb"),got=p.view.camera();
  assert.ok(p.log.restores>=5,"the camera eases over several frames ("+p.log.restores+")");
  assert.ok(near(got.cx,want.cx)&&near(got.cy,want.cy)&&near(got.scale,want.scale),"and lands on the target camera");
  assert.ok(p.log.moving>0&&p.log.settle>=1,"gesture frames, then an exact frame");
  assert.equal(paints,p.log.restores,"one repaint per camera step");
  const d=p.log.cams.map(c=>Math.hypot(c.cx-want.cx,c.cy-want.cy));
  for(let i=1;i<d.length;i++)assert.ok(d[i]<=d[i-1]+1e-9,"the camera only ever gets closer");
  assert.ok(p.log.cams.every(c=>c.scale>0&&c.referenceScale===2),"scales stay positive; the reference scale is kept");
  // Already comfortably in view: no move at all.
  const q=fakePane(want),r2=F.glide(q,box,{kind:"pcb",level:"full"});
  assert.equal(r2,"in-view");assert.equal(q.log.restores,0);assert.equal(frames.length,0,"no frames requested");
  // force (the explicit Ctrl/⌘+double-click probe) moves even then.
  assert.equal(F.glide(q,box,{kind:"pcb",level:"reduced",force:true}),"jumped");
  // Reduced motion: no travel; the camera lands in one step, no animation frames.
  const rp=fakePane(start),r3=F.glide(rp,box,{kind:"pcb",level:"reduced"});
  assert.equal(r3,"jumped");assert.equal(rp.log.restores,1);assert.equal(frames.length,0,"reduced motion requests no frames");
  assert.ok(near(rp.view.camera().scale,want.scale));
  // Off: the same.
  const op=fakePane(start);assert.equal(F.glide(op,box,{kind:"pcb",level:"off"}),"jumped");assert.equal(frames.length,0);
  // The system setting, read by AtriumMotion: data-motion=reduce on the root.
  const was=globalThis.document;globalThis.document={documentElement:{getAttribute:k=>k==="data-motion"?"reduce":null}};
  try{assert.equal(M.level(),"reduced");const sp=fakePane(start);assert.equal(F.glide(sp,box,{kind:"pcb"}),"jumped");assert.equal(frames.length,0);}
  finally{if(was===undefined)delete globalThis.document;else globalThis.document=was;}
  // A new glide interrupts the one in flight and starts from wherever the camera is.
  const ip=fakePane(start);F.glide(ip,box,{kind:"pcb",level:"full"});pump(48);
  const mid=ip.view.camera(),other=C.itemBox(pcb,defs,part(pcb,"J1"));
  F.glide(ip,other,{kind:"pcb",level:"full"});pump();
  const w2=F.cameraFor(other,800,600,mid,"pcb");
  assert.ok(near(ip.view.camera().cx,w2.cx)&&near(ip.view.camera().cy,w2.cy),"the second target wins");
}

// ---------------------------------------------------------------- Follow end to end (fake two-pane host)
{
  const actions=new Map(),listeners=new Map(),infos=[];
  let current=sch.id,selection=[],highlight="",split=true,opened=[];
  const active=fakePane({cx:0,cy:0,scale:4,referenceScale:4});active.active=true;
  const other=fakePane({cx:-300,cy:-300,scale:1,referenceScale:1});
  const shown=[];
  const host={
    project:()=>project,defs:()=>defs,doc:()=>project.documents.find(d=>d.id===current),currentId:()=>current,
    docById:id=>project.documents.find(d=>d.id===id),selection:()=>[...selection],highlight:()=>highlight,drag:()=>null,
    panes:()=>split?[{...active,docId:current,active:true},{...other,docId:other.docId,active:false}]:[{...active,docId:current,active:true}],
    showInOther(id){if(!split)return false;shown.push(id);other.docId=id;return true;},
    openSplit(o,id,f){opened.push([o,id,f]);split=true;other.docId=id;},
    hit:()=>null,info:t=>infos.push(t),act:()=>{},
    registerAction:(id,f)=>actions.set(id,f),on:(t,f)=>{(listeners.get(t)||listeners.set(t,[]).get(t)).push(f);}
  };
  other.docId=pcb.id;
  F.attach(host);
  assert.ok(actions.has("split-counterpart")&&actions.has("split-follow"),"actions registered");
  assert.equal(F.follow(),true,"Follow is on by default");
  assert.ok(F.enabled(),"a schematic | board split enables it");
  // A selection in the active (schematic) pane moves the board pane to the footprint.
  selection=[u1s.id];F._run();pump();
  const box=C.itemBox(pcb,defs,u1b),cam=other.view.camera();
  assert.ok(F.inView(box,cam,800,600,"pcb"),"the board pane shows U1");
  assert.equal(active.log.restores,0,"the active pane's camera never moves");
  assert.equal(active.log.focus+other.log.focus,0,"no pane takes focus");
  assert.ok(shown.every(id=>id===pcb.id),"the other pane keeps the board");
  // The same selection again: no new camera work.
  const n=other.log.restores;F._run();pump();assert.equal(other.log.restores,n,"an unchanged selection does nothing");
  // A target already in view: Follow leaves the camera alone.
  selection=[part(sch,"R1").id];
  const near1=F.cameraFor(C.itemBox(pcb,defs,part(pcb,"R1")),800,600,other.view.camera(),"pcb");other.view.restoreCamera(near1);
  const m=other.log.restores;F._run();pump();assert.equal(other.log.restores,m,"no-op when the target is in view");
  // Follow off: nothing moves; back on: it catches up with the selection.
  F.setFollow(false,true);assert.equal(F.enabled(),false);
  selection=[part(sch,"J1").id];other.view.restoreCamera({cx:-500,cy:-500,scale:1,referenceScale:1});
  const k=other.log.restores;F._run();pump();assert.equal(other.log.restores,k,"Follow off: the other pane stays");
  F.setFollow(true,true);F._run();pump();
  assert.ok(F.inView(C.itemBox(pcb,defs,part(pcb,"J1")),other.view.camera(),800,600,"pcb"),"Follow on again: J1 on the board");
  // A highlighted net with nothing selected (Ctrl/⌘+click) follows the net.
  selection=[];highlight="VIN";other.view.restoreCamera({cx:-500,cy:-500,scale:1,referenceScale:1});
  F._run();pump();
  assert.ok(F.inView(X.netObjects(pcb,defs,"VIN").box,other.view.camera(),800,600,"pcb"),"the net follows");
  highlight="";
  // Two panes of the same kind: Follow does not apply.
  other.docId=sch.id;assert.equal(F.enabled(),false,"same kind in both panes: no Follow");
  // split-counterpart with the split open swaps the other pane to the counterpart and turns Follow on.
  F.setFollow(false,true);shown.length=0;
  actions.get("split-counterpart")();
  assert.deepEqual(shown.slice(0,1),[pcb.id],"the other pane swaps to the board");assert.equal(F.follow(),true,"Follow on");
  // Without a split it opens one without taking focus.
  split=false;opened.length=0;
  actions.get("split-counterpart")();
  assert.deepEqual(opened[0].slice(0,2),["right",pcb.id]);assert.equal(opened[0][2].focus,false,"the active pane keeps focus");
  assert.ok(infos.some(t=>/Follow on/.test(t)),"status says Follow is on");
  // From the board: the sheet.
  current=pcb.id;split=true;other.docId=pcb.id;shown.length=0;
  actions.get("split-counterpart")();assert.equal(shown[0],sch.id);
}
console.log("PASS split-follow: counterpart, follow target, in-view no-op, clamp, eased camera, reduced motion, Follow end to end");
