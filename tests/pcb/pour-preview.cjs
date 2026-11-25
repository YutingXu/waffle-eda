"use strict";
// The display-only pour preview (app/pcb/pour-preview.js) against the exact core on small random
// boards (vias, tracks, parts, several pours in pour order on both layers, earlier copper):
//   - well-formed: Int32 rings of >= 3 vertices, implicitly closed (no repeated vertex, no
//     zero-length edge), tags one per edge, outers counter-clockwise and holes clockwise,
//     every hole inside its outer (exactly for the pixel staircase; within a pixel smoothed);
//   - bounded deviation: on the preview's own pixel grid the copper differs from the exact
//     copper sampled there in at most 1% of the copper pixels; the XOR area over the exact
//     boundary length (the mean boundary error) stays under 0.5 px; the "reduce" method
//     stays under 0.4 px;
//   - pure: the same task gives the same bytes twice, the task is not modified, and a copy
//     built from the source text alone (as a worker would build it) gives the same bytes;
//   - stats.preview is true; opts.view keeps the copper inside the view.
// Run: scripts/test-jsc.sh pour-preview   (ATRIUM_ENGINE=wasm|js picks the core).
const assert=require("node:assert/strict");
for(const m of ["model","parts","spatial","pcb-appearance","pcb-pours","board-shape","polygon-pour","pour-preview"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
try{require("../../app/engine-core.js");}catch{/* JS core */}
if(!globalThis.performance)globalThis.performance={now:()=>Date.now()};
const PP=AtriumPolygonPour,PV=AtriumPourPreview,A=Atrium,I=PP._internal,CORE=I.core;
const defs=new Map(AtriumParts.catalogue.map(p=>[p.id,p]));
let seed=4242;const rnd=()=>{seed=(Math.imul(seed,1103515245)+12345)>>>0;return seed/4294967296;};
const pick=a=>a[Math.floor(rnd()*a.length)];
const rect=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
let nid=0;const id=()=>"p"+(++nid);
const NETS=["GND","VCC","S1","S2"];

function board(n){
  const d=A.sheet("pcb","Preview");d.outline=rect(0,0,30,20);
  for(let k=0;k<n;k++){
    const x=1+rnd()*28,y=1+rnd()*18,net=pick(NETS),r=rnd();
    if(r<.4)d.items.push({id:id(),kind:"via",x,y,diameter:.6,drill:.3,layer:"Multi",net});
    else if(r<.75)d.items.push({id:id(),kind:"track",layer:pick(["Top","Bottom"]),width:.2+rnd()*.3,net,points:[[x,y],[x+1+rnd()*3,y+(rnd()-.5)*2],[x+2+rnd()*4,y+(rnd()-.5)*3]]});
    else d.items.push({id:id(),kind:"part",def:"std-r",x,y,angle:pick([0,90,45]),ref:"R"+k,pinNets:{"1":pick(NETS),"2":pick(NETS)}});
  }
  d.items.push(PP.make(rect(.5,.5,18,19.5),{net:"GND",layer:"Top",pourIndex:0,removeDeadCopper:true}));
  d.items.push(PP.make(rect(12,.5,29.5,19.5),{net:"VCC",layer:"Top",pourIndex:1,removeDeadCopper:false,islandAreaThreshold:.2}));
  d.items.push(PP.make([[1,1],[29,1],[29,19],[15,12],[1,19]],{net:"GND",layer:"Bottom",pourIndex:2}));
  return d;
}
// Every exact task of every pour in pour order: prepare's task, and the second-stage task that
// finish() solves when earlier copper reaches the pour (captured from the core), merged into the
// one-pass task a preview would use (stage-1 shapes plus the earlier copper, classes 6..).
function tasks(d){
  const list=d.items.filter(i=>i.kind==="polygon").sort((a,b)=>a.pourIndex-b.pourIndex),poured=[],out=[],solve=CORE.solve;
  for(const p of list){
    const job=I.prepare(d,defs,p,{poured});if(!job.task)continue;
    const s1=solve(job.task),seen=[];
    CORE.solve=t=>{const r=solve(t);seen.push({task:t,exact:r});return r;};
    let regions;try{regions=I.finish(job,s1);}finally{CORE.solve=solve;}
    poured.push(...regions);
    out.push({name:p.layer+" "+p.net,S:job.S,task:job.task,exact:s1});
    if(seen.length){const t2=seen[0].task;
      out.push({name:p.layer+" "+p.net+" +earlier",S:job.S,task:{...t2,shapes:[...job.task.shapes,...t2.shapes.filter(s=>s.cls>=6)],hasBoard:job.task.hasBoard},exact:seen[0].exact});}
  }
  return out;
}
const ringsOf=isls=>{const o=[];for(const i of isls){o.push(i.ring);for(const h of i.holes)o.push(h.ring);}return o;};
const perimeter=rs=>{let s=0;for(const r of rs){const n=r.length>>1;for(let i=0,j=n-1;i<n;j=i++)s+=Math.hypot(r[2*i]-r[2*j],r[2*i+1]-r[2*j+1]);}return s;};
function xorArea(a,b){
  const input=[...ringsOf(a).map(ring=>({cls:0,ring,sign:1})),...ringsOf(b).map(ring=>({cls:1,ring,sign:1}))];
  if(!input.length)return 0;
  let s=0;for(const o of CORE.overlayInt(input,2,w=>(w[0]>0)!==(w[1]>0))){s+=o.area;for(const h of o.holes)s-=h.area;}
  return s;
}
// Distance from (x, y) to the nearest edge of ring r.
function ringDist(r,x,y){
  let best=Infinity;const n=r.length>>1;
  for(let i=0,j=n-1;i<n;j=i++){
    const ax=r[2*j],ay=r[2*j+1],vx=r[2*i]-ax,vy=r[2*i+1]-ay,L=vx*vx+vy*vy;
    let t=L?((x-ax)*vx+(y-ay)*vy)/L:0;t=t<0?0:t>1?1:t;best=Math.min(best,Math.hypot(x-ax-t*vx,y-ay-t*vy));
  }
  return best;
}
function wellFormed(res,slack,label){
  assert.equal(res.stats.preview,true,label+": stats.preview");
  for(const isl of res.islands){
    for(const r of [isl,...isl.holes]){
      assert.ok(r.ring instanceof Int32Array&&r.ring.length%2===0&&r.ring.length>=6,label+": ring of >= 3 vertices");
      assert.ok(r.tags instanceof Int32Array&&r.tags.length===r.ring.length/2,label+": one tag per edge");
      const n=r.ring.length>>1;
      for(let i=0,j=n-1;i<n;j=i++)assert.ok(r.ring[2*i]!==r.ring[2*j]||r.ring[2*i+1]!==r.ring[2*j+1],label+": no zero-length edge (closed implicitly)");
    }
    assert.ok(CORE.area2(isl.ring)>0,label+": outer counter-clockwise");
    for(const h of isl.holes){
      assert.ok(CORE.area2(h.ring)<0,label+": hole clockwise");
      for(let i=0;i<h.ring.length;i+=2){
        const x=h.ring[i],y=h.ring[i+1];
        if(CORE.pointInRing(x,y,isl.ring)>=0)continue;
        assert.ok(slack>0&&ringDist(isl.ring,x,y)<=slack,label+": hole vertex outside its outer by "+ringDist(isl.ring,x,y).toFixed(0)+" units");
      }
    }
  }
}
// Copper pixels of an island set sampled on the preview's grid (the rasteriser itself, fed the rings).
function sample(isls,st){
  const task={shapes:ringsOf(isls).map(ring=>({cls:0,ring,sign:1})),K:1};
  return PV.rasterise(task,w=>w[0]!==0,st.origin[0],st.origin[1],st.pixel,st.width,st.height);
}
const bytes=res=>JSON.stringify(res.islands.map(i=>[Array.from(i.ring),Array.from(i.tags),i.links,i.holes.map(h=>[Array.from(h.ring),Array.from(h.tags)])]));
const fingerprint=t=>JSON.stringify(t.shapes.map(s=>[s.cls,s.sign,Array.from(s.ring)]))+JSON.stringify(t.anchors.map(a=>Array.from(a)))+t.K+t.hasBoard+t.removeDead+t.minArea+t.minSize;
// A copy of the preview built only from its source text, as a worker would build it.
const isolated=new Function(PV.source()+"return PourPreview();")();

let checked=0,worstPix=0,worstMean=0,worstReduce=0;
for(const n of [24,48]){
  for(const t of tasks(board(n))){
    const px=t.S*.05,label=t.name+" ("+n+" objects)";// 20 px/mm: a few pixels per clearance
    const before=fingerprint(t.task);
    const res=PV.solve(t.task,{core:CORE,pixel:px});
    assert.equal(fingerprint(t.task),before,label+": task unchanged");
    wellFormed(res,px,label);
    wellFormed(PV.solve(t.task,{core:CORE,pixel:px,smooth:0}),0,label+" staircase");
    assert.equal(bytes(PV.solve(t.task,{core:CORE,pixel:px})),bytes(res),label+": same bytes twice");
    assert.equal(bytes(isolated.solve(t.task,{core:CORE,pixel:px})),bytes(res),label+": same bytes from the source text");
    // Deviation on the preview's own grid, and the mean boundary error.
    const st=res.stats,a=sample(t.exact.islands,st),b=sample(res.islands,st);
    let diff=0,cu=0;for(let i=0;i<a.length;i++){if(a[i]!==b[i])diff++;if(a[i]|b[i])cu++;}
    const per=perimeter(ringsOf(t.exact.islands)),mean=per?xorArea(t.exact.islands,res.islands)/per/px:0;
    if(cu)worstPix=Math.max(worstPix,diff/cu);worstMean=Math.max(worstMean,mean);
    assert.ok(diff<=Math.max(2,cu*.01),label+": "+diff+" of "+cu+" copper pixels differ on the preview grid");
    assert.ok(mean<.5,label+": mean boundary error "+mean.toFixed(3)+" px");
    // The view limits the copper to the view (plus a pixel).
    const v=[-5*t.S,-5*t.S,4*t.S,3*t.S],rv=PV.solve(t.task,{core:CORE,pixel:px,view:v});
    for(const r of ringsOf(rv.islands))for(let i=0;i<r.length;i+=2)assert.ok(r[i]>=v[0]-px&&r[i]<=v[2]+px&&r[i+1]>=v[1]-px&&r[i+1]<=v[3]+px,label+": copper outside the view");
    // Method "reduce": exact core on the reduced task.
    const rr=PV.solve(t.task,{core:CORE,pixel:px,method:"reduce",tolPx:.5});
    wellFormed(rr,px,label+" reduce");
    const mr=per?xorArea(t.exact.islands,rr.islands)/per/px:0;worstReduce=Math.max(worstReduce,mr);
    assert.ok(mr<.4,label+" reduce: mean boundary error "+mr.toFixed(3)+" px");
    checked++;
  }
}
// The exact clip used by "reduce" changes no winding inside the box: identical copper.
{
  const t=tasks(board(30))[0];
  const clipped=PV.solve(t.task,{core:CORE,method:"reduce",tol:0,grid:1,drop:0,centre:false});
  assert.equal(xorArea(t.exact.islands,clipped.islands),0,"exact clip: same copper");
}
// worthIt: tiny tasks are not worth a preview, a large one is.
{
  const t=tasks(board(24))[0];
  assert.equal(PV.worthIt(t.task,{pixel:t.S*.05}).worth,false,"small task: no preview");
  const big={...t.task,shapes:[...t.task.shapes]};
  for(let k=0;k<10000;k++){const x=Math.round((rnd()-.5)*t.S*20),y=Math.round((rnd()-.5)*t.S*15),r=t.S*.3,ring=[];
    for(let j=0;j<16;j++)ring.push(Math.round(x+r*Math.cos(j*Math.PI/8)),Math.round(y+r*Math.sin(j*Math.PI/8)));big.shapes.push({cls:2,ring:Int32Array.from(ring),sign:1,tags:null});}
  const w=PV.worthIt(big,{pixel:t.S*.25});
  assert.equal(w.worth,true,"large task: preview ("+w.exactMs.toFixed(0)+" ms exact, "+w.previewMs.toFixed(1)+" ms preview)");
}
console.log("pour-preview: "+checked+" tasks; worst pixel difference "+(worstPix*100).toFixed(2)+"%, worst mean boundary error "+worstMean.toFixed(3)+" px (raster), "+worstReduce.toFixed(3)+" px (reduce)");
