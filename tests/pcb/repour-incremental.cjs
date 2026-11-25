"use strict";
// Exact reuse in Repour All (polygon-pour.js REUSE): a repour that hands back the stored copper of
// unchanged pours gives byte-identical copper to a full serial repour, on random boards and random
// edit sequences:
//   - moves, deletions and additions of vias, tracks, pads and parts; net, pin-net and designator
//     changes (smart connect reads the parts of a net anywhere on the board); cutouts; pour
//     settings, outline and pour-order changes; rule and board-outline changes; in-place edits;
//   - reuse by the input key (the change journal; here a journal that records every edited item,
//     sometimes with gaps) and by the task key (no journal);
//   - the serial path (repourAll / apply) and the parallel path (repourParallel on a pool that
//     answers in random order);
//   - the real undo store (app/history/undo-store.js) through edits, undo and redo.
// Run: scripts/test-jsc.sh repour-incremental   (ATRIUM_ENGINE=wasm|js picks the core) or node.
const assert=require("node:assert/strict");
for(const m of ["model","parts","spatial","pcb-appearance","pcb-pours","board-shape","rules","polygon-pour","undo-store"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
try{require("../../app/engine-core.js");}catch{/* JS core */}
if(!globalThis.performance)globalThis.performance={now:()=>Date.now()};
const PP=AtriumPolygonPour,A=Atrium,U=AtriumUndoStore;
const defs=new Map(AtriumParts.catalogue.map(p=>[p.id,p]));
let seed=4242;const rnd=()=>{seed=(Math.imul(seed,1103515245)+12345)>>>0;return seed/4294967296;};
const pick=a=>a[Math.floor(rnd()*a.length)];
const rect=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
let nid=0;const id=()=>"q"+(++nid);
const NETS=["GND","VCC","S1","S2","+5V"];
const J=x=>JSON.stringify(x);

function board(variant){
  const d=A.sheet("pcb","Reuse "+variant);d.outline=rect(0,0,40,26);
  d.rules={format:"atrium-rules",version:1,units:"mm",defaults:{clearance:.2,trackWidth:.15,viaDrill:.3},nets:{VCC:{clearance:.3}}};
  for(let k=0;k<34;k++){
    const x=1+rnd()*38,y=1+rnd()*24,net=pick(NETS),r=rnd();
    if(r<.35)d.items.push({id:id(),kind:"via",x,y,diameter:.6,drill:.3,layer:"Multi",net});
    else if(r<.65)d.items.push({id:id(),kind:"track",layer:pick(["Top","Top","Bottom"]),width:.25,net,points:[[x,y],[x+1+rnd()*3,y+(rnd()-.5)*2],[x+2+rnd()*4,y+(rnd()-.5)*3]]});
    else if(r<.75)d.items.push({id:id(),kind:"pad",x,y,w:1.2,h:.8,shape:pick(["rect","round","roundrect"]),layer:pick(["Top","Bottom"]),net});
    else d.items.push({id:id(),kind:"part",def:pick(["std-r","std-c"]),x,y,angle:pick([0,90,45]),ref:pick(["R","C","Q","U"])+k,pinNets:{"1":pick(NETS),"2":pick(NETS)}});
  }
  const ps=[
    PP.make(rect(.5,.5,22,25.5),{net:"GND",layer:"Top",pourIndex:0,connectStyle:variant===1?"auto":"relief"}),
    PP.make(rect(16,.5,39.5,25.5),{net:"VCC",layer:"Top",pourIndex:1,removeDeadCopper:variant!==2,islandAreaThreshold:variant===2?.4:0}),
    PP.make([[1,1],[39,1],[39,25],[20,15],[1,25]],{net:"GND",layer:"Bottom",pourIndex:2,connectStyle:"direct"}),
    PP.make(rect(3,3,11,9),{net:"S1",layer:"Top",pourIndex:3,removeDeadCopper:false}),
    PP.make(rect(25,14,37,24),{net:"+5V",layer:"Bottom",pourIndex:4,connectStyle:"auto",viaConnectStyle:"auto"}),
    PP.make(rect(28,3,36,10),{net:"",layer:"Top",pourIndex:5}),
  ];
  // Smart connect on S2: whether its pads connect direct depends on every part of S2, also R91/Q91 far away.
  ps.push(PP.make(rect(2,13,13,24),{net:"S2",layer:"Top",pourIndex:-1,connectStyle:"auto"}));
  d.items.push({id:id(),kind:"part",def:"std-opamp",x:6,y:19,angle:0,ref:"U90",pinNets:{"1":"S2","2":"S1","3":"S1","4":"S1","5":"S1"}},
    {id:"far-part",kind:"part",def:"std-r",x:37,y:3,angle:0,ref:"R91",pinNets:{"1":"S2","2":"S1"}});
  if(variant===2)ps.push(PP.make(rect(5,5,8,8),{net:"S2",layer:"Top",pourIndex:6,fillMode:"hatched",hatchPitch:.8,hatchWidth:.3}));
  d.items.push(...ps);
  if(variant!==0)d.items.push(PP.make(rect(30,16,33,19),{layer:"Top",cutout:true}));
  return d;
}

// A journal like the undo store's: every edited item (by reference), complete from `floor`.
function fakeJournal(){
  const log=[];let floor=0,outer=0;
  return {log,touch(i){log.push(i);},gap(){floor=log.length+1;log.push(null);outer++;},outerBump(){outer++;},
    changed(doc,since){const seq=log.length;if(since==null||since<floor||since>seq)return {seq,ids:null,items:null};
      const ids=new Set(),last=new Map();for(let k=since;k<seq;k++){const i=log[k];if(!i)continue;ids.add(i.id);last.set(i.id,i);}
      const items=new Map();for(const [k,i] of last)if(doc.items.includes(i))items.set(k,i);return {seq,ids,items};},
    outer:()=>outer};
}

// One random edit; every edited object is reported to `touch` (also the old object of a replacement).
function edit(d,touch,journal){
  const items=d.items.filter(i=>i.kind!=="polygon"),pours=d.items.filter(i=>i.kind==="polygon"),r=rnd(),it=pick(items),dx=(rnd()-.5)*3,dy=(rnd()-.5)*3;
  if(r<.32){
    if(rnd()<.5){touch(it);if(it.points)it.points=it.points.map(q=>[q[0]+dx,q[1]+dy]);else{it.x+=dx;it.y+=dy;}}
    else{ // replaced by a new object with the same id (as an undo record does)
      const k=d.items.indexOf(it),n=JSON.parse(J(it));if(n.points)n.points=n.points.map(q=>[q[0]+dx,q[1]+dy]);else{n.x+=dx;n.y+=dy;}
      touch(it);d.items[k]=n;touch(n);
    }
    if(it.kind==="part"&&rnd()<.3)it.angle=(it.angle+90)%360;
    return "move";
  }
  if(r<.42){touch(it);d.items.splice(d.items.indexOf(it),1);return "delete";}
  if(r<.54){const x=1+rnd()*38,y=1+rnd()*24,v={id:id(),kind:"via",x,y,diameter:.7,drill:.3,layer:"Multi",net:pick(NETS)};d.items.splice(Math.floor(rnd()*d.items.length),0,v);touch(v);return "add";}
  if(r<.64){touch(it);it.net=pick(NETS);if(it.pinNets)it.pinNets={"1":pick(NETS),"2":pick(NETS)};return "net";}
  if(r<.69){const p=rnd()<.5?d.items.find(i=>i.id==="far-part"):pick(items.filter(i=>i.kind==="part"));if(!p)return "none";touch(p);p.ref=pick(["R","U","L","J","Q"])+(1+Math.floor(rnd()*9));return "ref";}
  if(r<.73){const t=items.find(i=>i.points);if(!t)return "none";touch(t);t.points[1][0]+=.4;return "in-place";}
  if(r<.80){const p=pick(pours);touch(p);
    const w=rnd();
    if(w<.3)p.points=p.points.map(q=>[q[0]+dx*.3,q[1]]);
    else if(w<.55)p.pourIndex=Math.floor(rnd()*7);
    else if(w<.8)p.connectStyle=pick(["relief","direct","auto","none"]);
    else p.reliefAirGap=.2+rnd()*.3;
    return "pour";}
  if(r<.84){const c=d.items.find(i=>i.kind==="polygon"&&i.cutout);if(!c)return "none";touch(c);c.points=c.points.map(q=>[q[0]+dx,q[1]+dy]);return "cutout";}
  if(r<.88){d.rules={...d.rules,nets:{...d.rules.nets,S1:{clearance:.25+rnd()*.2}}};journal?.outerBump();return "rules";}
  if(r<.90){d.outline=d.outline.map(q=>[q[0]*(1+(rnd()-.5)*.02),q[1]]);journal?.outerBump();return "outline";}
  if(r<.93){journal?.gap();return "gap";}
  // Far from any pour (outside the board): touches no copper.
  const v={id:id(),kind:"via",x:80+rnd()*10,y:60,diameter:.6,drill:.3,layer:"Multi",net:"GND"};d.items.push(v);touch(v);return "far";
}

const full=d=>J(PP.repourAll(d,defs,{reuse:false}).regions);
// A pool that answers in random order, with the main-thread core.
const randomPool={size:2,available:true,run:t=>new Promise(ok=>setTimeout(()=>ok(PP._internal.core.solve(t)),Math.floor(rnd()*3)))};

async function main(){
  let steps=0;const kinds={};
  PP.reuse.clear();
  for(const variant of [0,1,2]){
    const d=board(variant),journal=fakeJournal();
    PP.reuse.journal(journal);
    PP.apply(d,defs,{});
    for(let k=0;k<26;k++){
      const what=edit(d,i=>journal.touch(i),journal);kinds[what]=(kinds[what]||0)+1;
      const ref=full(d);
      const mode=k%3;
      let got;
      if(mode===0)got=J(PP.repourAll(d,defs,{}).regions);
      else if(mode===1)got=J((await PP.repourParallel(d,defs,{},randomPool)).regions);
      else{const before=J(d.pcbDrawing||null);PP.apply(d,defs,{});got=J(d.pcbDrawing.pours.filter(r=>r.polygon!=null));assert.notEqual(before,undefined);}
      assert.equal(got,ref,"v"+variant+" step "+k+" ("+what+", mode "+mode+"): reused copper equals a full repour");
      // Stored copper stays as a full apply would store it.
      if(mode!==2&&rnd()<.5)PP.apply(d,defs,{});
      steps++;
    }
  }
  const s1=PP.reuse.stats;
  assert.ok(s1.inputHits>0,"the input key is used: "+J(s1));
  assert.ok(s1.taskHits>0,"the task key is used: "+J(s1));
  // Two-stage pours: an edit that changes only earlier copper reuses a later pour's stage 1 and solves stage 2 alone.
  assert.ok(s1.stage1Hits>0,"stage 1 is reused while stage 2 pours again: "+J(s1));

  // A designator far from a smart-connect pour changes its net's power class (transistor Q91 on S2):
  // the pad under the pour turns from relief to direct although nothing near the pour changed.
  {
    const journal=fakeJournal();PP.reuse.journal(journal);PP.reuse.clear();
    const d=board(0);PP.apply(d,defs,{});
    const far=d.items.find(i=>i.id==="far-part"),s2=d.items.find(i=>i.kind==="polygon"&&i.net==="S2");
    PP.repourAll(d,defs,{});
    for(const ref of ["Q91","R91","Q92"]){
      journal.touch(far);far.ref=ref;
      const ref0=full(d),got=PP.repourAll(d,defs,{});
      assert.equal(J(got.regions),ref0,"far designator "+ref);
      assert.equal(J(got.stats.polygons[s2.id].connections.map(c=>c.style)),J(PP.repourAll(d,defs,{reuse:false}).stats.polygons[s2.id].connections.map(c=>c.style)),"S2 connect styles "+ref);
      steps++;
    }
  }
  // An earlier pour changes next to a later one with nothing else edited: only the earlier copper
  // the later pour clears tells (the input key hashes it by content).
  {
    const journal=fakeJournal();PP.reuse.journal(journal);PP.reuse.clear();
    const d=board(0);PP.apply(d,defs,{});PP.repourAll(d,defs,{});
    const gnd=d.items.find(i=>i.kind==="polygon"&&i.net==="GND"&&i.layer==="Top");
    for(const dx of [2,-1.5,.7]){
      journal.touch(gnd);gnd.points=gnd.points.map(q=>[q[0]>10?q[0]+dx:q[0],q[1]]);
      const before=PP.reuse.stats.inputHits;
      assert.equal(J(PP.repourAll(d,defs,{}).regions),full(d),"earlier pour moved by "+dx);
      assert.ok(PP.reuse.stats.inputHits>before,"pours away from it still hit the input key");
      steps++;
    }
  }
  // Without a journal: the task key alone, still exact.
  PP.reuse.journal({changed:()=>({seq:null,ids:null,items:null}),outer:()=>0});PP.reuse.clear();
  {
    const d=board(1);PP.apply(d,defs,{});
    for(let k=0;k<10;k++){edit(d,()=>{},null);assert.equal(J(PP.repourAll(d,defs,{}).regions),full(d),"no journal, step "+k);steps++;}
  }
  // Stored regions changed in place are never handed out.
  {
    PP.reuse.journal(null);PP.reuse.clear();
    const d=board(0);PP.apply(d,defs,{});const r0=d.pcbDrawing.pours[0],ref=full(d);
    const keep=r0.data;r0.data=r0.data.slice(0,-4)+"AAAA";
    assert.equal(J(PP.repourAll(d,defs,{}).regions),ref,"a region edited in place is repoured");
    r0.data=keep;
  }

  // The global book covers at most 256 entries, including when boards share the renderer.
  {
    PP.reuse.journal(fakeJournal());PP.reuse.clear();
    const first=A.sheet("pcb","Old repour cache entry"),later=A.sheet("pcb","New repour cache entries");
    const polygon=(id,outline=rect(0,0,2,2))=>PP.make(outline,{id,net:"GND",layer:"Top",removeDeadCopper:false});
    first.items=[polygon("old-active-pour")];
    const expected=full(first);
    assert.equal(J(PP.repourAll(first,defs,{}).regions),expected);
    const initialHits=PP.reuse.stats.inputHits;
    assert.equal(J(PP.repourAll(first,defs,{}).regions),expected);
    assert.equal(PP.reuse.stats.inputHits,initialHits+1,"a live board still owns its reusable solved copper");
    later.outline=rect(0,0,1,1);
    later.items=Array.from({length:256},(_,i)=>polygon("new-outside-pour-"+i,rect(3,3,4,4)));
    PP.repourAll(later,defs,{});
    assert.equal(PP.reuse.stats.entries,256,"the entry cap is shared across boards");
    const before=PP.reuse.stats;
    assert.equal(J(PP.repourAll(first,defs,{}).regions),expected);
    assert.equal(PP.reuse.stats.inputHits,before.inputHits,"the oldest entry was evicted from its board's cache");
    assert.ok(PP.reuse.stats.solved>before.solved,"the evicted copper was solved again");
    assert.equal(PP.reuse.stats.entries,256);
    PP.reuse.clear();
    assert.equal(PP.reuse.stats.entries,0);
  }

  // In Manual Pours, an empty replacement does not call state() deeply enough
  // to replace its previous board memo or exact live-staleness answer.
  {
    PP.reuse.journal(null);
    const filled=A.sheet("pcb","Filled"),empty=A.sheet("pcb","Empty"),tab=A.sheet("pcb","Other tab");
    filled.items=[PP.make(rect(0,0,2,2),{id:"owner-pour",net:"GND",layer:"Top",removeDeadCopper:false})];
    let reads=0;
    const points=[[.2,.5],[1,.5]];
    filled.items.push({id:"track",kind:"track",layer:"Top",net:"OTHER",width:.2,get points(){reads++;return points;}});
    const previous={documents:[filled,tab]},next={documents:[empty]},events=new Map();
    let project=previous,current=filled;
    PP.apply(filled,defs,{project,reuse:false});
    reads=0;
    PP.live.attach({project:()=>project,doc:()=>current,defs:()=>defs,revision:()=>4,derive(){},invalidate(){},
      on(name,fn){events.set(name,fn);}});
    PP.live.setMode("manual");
    assert.equal(PP.state(filled,defs),"source");
    const firstReads=reads;
    assert.ok(firstReads>0,"the first read verifies the real geometry");
    current=tab; assert.equal(PP.state(tab,defs),"none");
    current=filled; assert.equal(PP.state(filled,defs),"source");
    assert.equal(reads,firstReads,"same-project navigation keeps the filled board's memo");
    project=next;current=empty;events.get("replace")();
    assert.equal(PP.state(empty,defs),"none");
    project=previous;current=filled;events.get("replace")();
    assert.equal(PP.state(filled,defs),"source");
    assert.ok(reads>firstReads,"returning to a retired project recomputes its staleness");
    PP.live.reset();
  }

  // The real undo store: edits, undo and redo keep the documents, and the journal drives the input key.
  {
    PP.reuse.journal(null);PP.reuse.clear();
    const d=board(1);let project={format:"atrium",name:"P",library:[],documents:[d]};
    U.reset();U.touch(project);U.sync();
    const history=[],future=[];
    const doc=()=>project.documents[0];
    const step=fn=>{const before=U.mark(project,{current:doc().id});fn(doc());U.checkpoint(history,future,before,"");U.touch(project);};
    const derive=fn=>{fn(doc());U.touch(project);};
    derive(x=>PP.apply(x,defs,{}));
    const before=PP.reuse.stats.inputHits;
    for(let k=0;k<14;k++){
      const r=rnd();
      if(r<.6||!history.length)step(x=>edit(x,()=>{},null));
      else{const here=U.mark(project,{current:doc().id});U.jump(history,future,here,r<.85?-1:1);project=U.root();U.touch(project);}
      const ref=full(doc());let got=null;
      derive(x=>{PP.apply(x,defs,{});got=J(x.pcbDrawing.pours.filter(g=>g.polygon!=null));});
      assert.equal(got,ref,"undo store step "+k);steps++;
    }
    assert.ok(PP.reuse.stats.inputHits>before,"the undo journal gives input-key hits: "+J(PP.reuse.stats));
    U.reset();
  }
  PP.reuse.journal(null);
  console.log("repour-incremental: "+steps+" steps byte-identical to a full repour; edits "+J(kinds)+"; reuse "+J(PP.reuse.stats));
}
globalThis.__testDone=main();
globalThis.__testDone.catch(e=>{console.error(e);if(typeof process!=="undefined")process.exitCode=1;});
