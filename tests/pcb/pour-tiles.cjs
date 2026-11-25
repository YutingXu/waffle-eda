"use strict";
// Tiled incremental repour (polygon-pour.js PourTiles) against a full repour.
// Random boards and random edits (move, delete and add vias, tracks and parts,
// cutouts, pours in pour order on one layer and dead-copper / minimum-area
// rules). After every edit only the changed items are prepared and diffed into
// the tile sessions; the union of the kept tile pieces is then compared with a
// fresh full repour of the same board:
//   - XOR area by the exact integer overlay: every XOR sliver is thinner than
//     EPS units (1 unit = 10 nm at full resolution), i.e. XOR area <= EPS x
//     XOR half-perimeter;
//   - a fine raster (2 um pitch around each edit, 20 um over the board, with
//     sample points off the integer grid): 0 differing samples;
//   - the same islands kept (count).
// Run: scripts/test-jsc.sh pour-tiles   (ATRIUM_ENGINE=wasm|js picks the core).
const assert=require("node:assert/strict");
for(const m of ["model","parts","spatial","pcb-appearance","pcb-pours","board-shape","polygon-pour"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
try{require("../../app/engine-core.js");}catch{/* JS core */}
if(!globalThis.performance)globalThis.performance={now:()=>Date.now()};
const PP=AtriumPolygonPour,A=Atrium,I=PP._internal,CORE=I.core,EPS=1;
const defs=new Map(AtriumParts.catalogue.map(p=>[p.id,p]));
let seed=12345;const rnd=()=>{seed=(Math.imul(seed,1103515245)+12345)>>>0;return seed/4294967296;};
const pick=a=>a[Math.floor(rnd()*a.length)];
const rect=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
let nid=0;const id=()=>"t"+(++nid);
const NETS=["GND","VCC","S1","S2","S3"];

function board(variant){
  const d=A.sheet("pcb","Tiles");d.outline=rect(0,0,30,20);
  d.rules={format:"atrium-rules",version:1,units:"mm",defaults:{clearance:.2,trackWidth:.15,viaDrill:.3},nets:{VCC:{clearance:.3}}};
  for(let k=0;k<26;k++){
    const x=1+rnd()*28,y=1+rnd()*18,net=pick(NETS);
    const r=rnd();
    if(r<.4)d.items.push({id:id(),kind:"via",x,y,diameter:.6,drill:.3,layer:"Multi",net});
    else if(r<.75)d.items.push({id:id(),kind:"track",layer:pick(["Top","Top","Bottom"]),width:.25,net,points:[[x,y],[x+1+rnd()*3,y+(rnd()-.5)*2],[x+2+rnd()*4,y+(rnd()-.5)*3]]});
    else d.items.push({id:id(),kind:"part",def:"std-r",x,y,angle:pick([0,90,45]),ref:"R"+k,pinNets:{"1":pick(NETS),"2":pick(NETS)}});
  }
  d.items.push({id:id(),kind:"pad",x:15,y:10,w:1.2,h:.8,shape:"rect",layer:"Top",net:"GND"});
  const p0=PP.make(rect(.5,.5,18,19.5),{net:"GND",layer:"Top",pourIndex:0,removeDeadCopper:true});
  const p1=PP.make(rect(12,.5,29.5,19.5),{net:"VCC",layer:"Top",pourIndex:1,removeDeadCopper:variant%2===0,islandAreaThreshold:variant%2?.5:0});
  const p2=PP.make([[1,1],[29,1],[29,19],[15,12],[1,19]],{net:"GND",layer:"Bottom",pourIndex:2,connectStyle:"direct"});
  const p3=PP.make(rect(3,3,9,8),{net:"S1",layer:"Top",pourIndex:3,removeDeadCopper:false});
  d.items.push(p0,p1,p2,p3);
  if(variant===2)d.items.push(PP.make(rect(20,5,23,9),{layer:"Top",cutout:true}));
  return d;
}
function edit(d){
  const items=d.items.filter(i=>i.kind!=="polygon"),r=rnd(),it=pick(items),dx=(rnd()-.5)*2,dy=(rnd()-.5)*2;
  let box=null;
  const at=i=>i.points?i.points[0]:[i.x,i.y];
  if(r<.55){
    const p=at(it);box=[p[0]-3,p[1]-3,p[0]+5,p[1]+5];
    if(it.points)it.points=it.points.map(q=>[q[0]+dx,q[1]+dy]);else{it.x+=dx;it.y+=dy;}
    if(it.kind==="part"&&rnd()<.3)it.angle=(it.angle+90)%360;
  }else if(r<.7){const p=at(it);box=[p[0]-3,p[1]-3,p[0]+5,p[1]+5];d.items.splice(d.items.indexOf(it),1);}
  else if(r<.85){const x=1+rnd()*28,y=1+rnd()*18;box=[x-2,y-2,x+2,y+2];d.items.push({id:id(),kind:"via",x,y,diameter:.7,drill:.3,layer:"Multi",net:pick(NETS)});}
  else{it.net=pick(NETS);if(it.pinNets)it.pinNets={"1":pick(NETS),"2":pick(NETS)};const p=at(it);box=[p[0]-3,p[1]-3,p[0]+5,p[1]+5];}
  return box;
}
// Full repour islands per polygon in the spec's integer frame, and the tile engine's kept pieces.
function toInt(spec,f){const r=new Int32Array(f.length);for(let i=0;i<f.length;i+=2){r[i]=Math.round((f[i]-spec.ox)*spec.S);r[i+1]=Math.round((f[i+1]-spec.oy)*spec.S);}return r;}
function fullRings(doc,spec,full){
  const out=[];for(const r of full.regions)if(r.polygon===spec.id)for(const f of PP.rings(r))out.push(toInt(spec,f));
  return out;
}
function xor(a,b){
  const input=[...a.map(ring=>({cls:0,ring,sign:1})),...b.map(ring=>({cls:1,ring,sign:1}))];
  if(!input.length)return {area:0,per:0};
  const isl=CORE.overlayInt(input,2,w=>(w[0]>0)!==(w[1]>0));
  let area=0,per=0;
  const perim=r=>{let s=0;const n=r.length>>1;for(let i=0,j=n-1;i<n;j=i++)s+=Math.hypot(r[2*i]-r[2*j],r[2*i+1]-r[2*j+1]);return s;};
  for(const o of isl){area+=CORE.area2(o.ring)/2;per+=perim(o.ring);for(const h of o.holes){area+=CORE.area2(h.ring)/2;per+=perim(h.ring);}}
  return {area,per};
}
// Even-odd coverage of rings at sample points of a row (integer frame).
function cover(rings,y,xs){
  const cross=[];
  for(const r of rings){const n=r.length>>1;for(let i=0,j=n-1;i<n;j=i++){const y1=r[2*j+1],y2=r[2*i+1];if((y1>y)!==(y2>y)){const x1=r[2*j],x2=r[2*i];cross.push(x1+(y-y1)*(x2-x1)/(y2-y1));}}}
  cross.sort((a,b)=>a-b);
  const out=new Uint8Array(xs.length);let k=0,inside=false;
  for(let i=0;i<xs.length;i++){while(k<cross.length&&cross[k]<xs[i]){inside=!inside;k++;}out[i]=inside?1:0;}
  return out;
}
// A sample counts as different only when the two coverages differ there and 1.5 units away in
// all four directions: a sliver thinner than EPS (the documented tolerance) is never counted.
function raster(spec,a,b,box,pitch){
  let bad=0;const S=spec.S,off=.37*pitch,R=1.5*EPS;
  for(let y=box[1]+off;y<box[3];y+=pitch){
    const yi=(y-spec.oy)*S,xs=[];for(let x=box[0]+off*1.3;x<box[2];x+=pitch)xs.push((x-spec.ox)*S);
    const ca=cover(a,yi,xs),cb=cover(b,yi,xs);
    const cand=[];for(let i=0;i<xs.length;i++)if(ca[i]!==cb[i])cand.push(i);
    if(!cand.length)continue;
    const differs=(yy,xx)=>{const p=[xx];return cover(a,yy,p)[0]!==cover(b,yy,p)[0];};
    for(const i of cand)if(differs(yi,xs[i]-R)&&differs(yi,xs[i]+R)&&differs(yi-R,xs[i])&&differs(yi+R,xs[i]))bad++;
  }
  return bad;
}
function compare(doc,state,E,box,label){
  const full=PP.repourAll(doc,defs,{});
  let worst=0,checked=0;
  for(const spec of state.specs){
    const a=fullRings(doc,spec,full),pieces=E.kept(spec.id),b=[];
    for(const p of pieces){b.push(p.ring);for(const h of p.holes)b.push(h);}
    const x=xor(a,b),width=x.per>0?x.area/(x.per/2):0;
    worst=Math.max(worst,width);
    assert.ok(x.area<=EPS*x.per/2+1e-9,label+" "+spec.id+": XOR is thicker than "+EPS+" unit (area "+x.area+", half perimeter "+x.per/2+")");
    const coarse=raster(spec,a,b,[0,0,30,20],.02);
    assert.equal(coarse,0,label+" "+spec.id+": coarse raster differs at "+coarse+" samples");
    if(box){const fine=raster(spec,a,b,box,.002);assert.equal(fine,0,label+" "+spec.id+": fine raster differs at "+fine+" samples");}
    // Island counts agree up to slivers under one grid unit wide (below 1e-5 mm²): the committed copper
    // is solved in two stages (earlier copper cleared from stage 1), where snapping can make or drop a
    // sliver the single-stage tiles keep. The XOR and raster checks above bound the geometry.
    const own=full.regions.filter(r=>r.polygon===spec.id),islandsFull=own.length,islandsTiles=E.session(spec.id).stats.kept;
    const tiny=r=>Math.abs(PP._internal.area2(r))/2/spec.S/spec.S<1e-5;
    const slivers=pieces.filter(p=>tiny(p.ring)).length+own.filter(r=>{const k=PP.rings(r)[0];return tiny(Array.from(k,(v,i)=>(v-(i&1?spec.oy:spec.ox))*spec.S));}).length;
    assert.ok(Math.abs(islandsTiles-islandsFull)<=slivers,label+" "+spec.id+": kept islands "+islandsTiles+" vs "+islandsFull+" ("+slivers+" slivers)");
    checked++;
  }
  return {worst,checked};
}

let worst=0,edits=0,tilesSolved=0,fullMs=0,tileMs=0;
for(const variant of [0,1,2]){
  const doc=board(variant);
  const st=PP.tiles.build(doc,defs,{});
  const E=PP.tiles.engine();
  E.init(st.specs,st.ord);E.run();E.takeChanged();
  assert.ok(st.specs.length>=4,"sessions for every pour");
  assert.ok(st.specs.every(s=>s.cols*s.rows>4),"several tiles per pour");
  worst=Math.max(worst,compare(doc,st,E,null,"v"+variant+" init").worst);
  for(let k=0;k<14;k++){
    const box=edit(doc);
    const d=PP.tiles.diff(doc,defs,st,{});
    assert.ok(d,"diff in the fixed frame");
    E.update(d.diffs,st.ord);
    const t=performance.now(),s=E.run();tileMs+=performance.now()-t;tilesSolved+=s.tiles;E.takeChanged();
    const t1=performance.now();
    worst=Math.max(worst,compare(doc,st,E,box,"v"+variant+" edit "+k).worst);fullMs+=performance.now()-t1;
    edits++;
  }
  // A full rebuild of the same board gives the same pieces as the incremental sessions.
  const again=PP.tiles.build(doc,defs,{}),E2=PP.tiles.engine();E2.init(again.specs,again.ord);E2.run();
  for(const s of again.specs){
    // Rings compared from their lowest vertex (the overlay's start vertex follows the input order).
    const canon=r=>{const n=r.length>>1;let m=0;for(let i=1;i<n;i++)if(r[2*i]<r[2*m]||(r[2*i]===r[2*m]&&r[2*i+1]<r[2*m+1]))m=i;const o=[];for(let i=0;i<n;i++)o.push(r[2*((m+i)%n)],r[2*((m+i)%n)+1]);return o.join(",");};
    const key=E=>E.kept(s.id).map(p=>canon(p.ring)+"|"+p.holes.map(canon).sort().join("|")).sort().join("\n");
    assert.equal(key(E2),key(E),"v"+variant+" "+s.id+": incremental pieces equal a fresh tiling");
  }
}
// The diff only touches what changed: a move far from a small pour leaves its tiles alone.
{
  const doc=board(0),st=PP.tiles.build(doc,defs,{}),E=PP.tiles.engine();E.init(st.specs,st.ord);E.run();E.takeChanged();
  const v=doc.items.find(i=>i.kind==="via"&&i.x>20);
  if(v){v.x+=.3;const d=PP.tiles.diff(doc,defs,st,{});E.update(d.diffs,st.ord);const s=E.run();
    const total=st.specs.reduce((n,x)=>n+x.cols*x.rows,0);
    assert.ok(s.tiles<total/4,"a via move re-solves a few tiles ("+s.tiles+" of "+total+")");}
}
// Worker message round trip (in-process): init quiet, update reports changed tiles with rings in mm.
{
  const doc=board(1),st=PP.tiles.build(doc,defs,{}),E=PP.tiles.engine();
  PP.tiles.message(E,{op:"init",list:st.specs,order:st.ord,run:true,quiet:true});
  const v=doc.items.find(i=>i.kind==="via");v.y+=.4;
  const d=PP.tiles.diff(doc,defs,st,{}),r=PP.tiles.message(E,{op:"update",diffs:d.diffs,order:st.ord,run:true}).msg;
  const ids=Object.keys(r.out);assert.ok(ids.length>=1,"changed pours reported");
  for(const id of ids){const o=r.out[id];assert.ok(o.changed.length&&o.tiles.length>=o.changed.length);assert.ok(o.tiles.every(t=>t.rings.every(f=>f instanceof Float64Array)));}
}
console.log("pour-tiles: "+edits+" edits on 3 boards, worst XOR sliver "+worst.toFixed(3)+" unit(s), "+tilesSolved+" tiles re-solved in "+tileMs.toFixed(0)+" ms (full repour + compare "+fullMs.toFixed(0)+" ms)");
// Per-item signature cache: after in-place changes (a point of a track, a pin net), the signatures
// equal those of a deep copy (new objects: no cache), so the cache never hides an edit.
{
  const doc=board(1);PP.apply(doc,defs,{});
  const fresh=()=>PP.polygonSignatures(JSON.parse(JSON.stringify(doc)),defs,{});
  assert.deepEqual(PP.polygonSignatures(doc,defs,{}),fresh());
  const t=doc.items.find(i=>i.kind==="track"),p=doc.items.find(i=>i.kind==="part");
  const before=PP.polygonSignatures(doc,defs,{});
  t.points[1][0]+=.5;if(p)p.pinNets["1"]=p.pinNets["1"]==="GND"?"VCC":"GND";
  const after=PP.polygonSignatures(doc,defs,{});
  assert.notDeepEqual(after,before,"an in-place edit changes the signatures");
  assert.deepEqual(after,fresh(),"cached signatures equal fresh ones");
}
