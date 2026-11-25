"use strict";
// Vectoriser: marching-squares tracing, holes, simplification, colour layers,
// feature checks, rasterisers, keyhole bridging and a 2000 x 2000 benchmark.
const assert=require("node:assert/strict");
require("../../app/core/model.js");require("../../app/canvas/vectorize.js");require("../../app/editor/logo-creator.js");
const V=AtriumVectorize,L=AtriumLogo;
const now=()=>typeof performance!=="undefined"?performance.now():Date.now();

// RGBA image filled by a coverage function cov(x, y) in [0, 1] sampled with
// s x s supersampling; ink is black on white.
function image(w,h,cov,s=1){
  const data=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    let c=0;
    for(let j=0;j<s;j++)for(let i=0;i<s;i++)c+=cov(x+(i+.5)/s,y+(j+.5)/s)?1:0;
    const v=Math.round(255*(1-c/(s*s))),k=4*(y*w+x);
    data[k]=data[k+1]=data[k+2]=v;data[k+3]=255;
  }
  return {width:w,height:h,data};
}
const totalArea=r=>r.polygons.reduce((s,p)=>s+p.area,0);
const near=(a,b,rel,msg)=>assert.ok(Math.abs(a-b)<=rel*Math.abs(b),msg+": "+a+" vs "+b);

// ---- Circle: binary and anti-aliased -------------------------------------
{
  const R=90,cx=128.3,cy=121.7,disc=(x,y)=>(x-cx)**2+(y-cy)**2<=R*R;
  const hard=V.trace(image(256,256,disc),{tolerance:.25});
  assert.equal(hard.polygons.length,1);assert.equal(hard.polygons[0].holes.length,0);
  near(totalArea(hard),Math.PI*R*R,.01,"binary circle area");
  const soft=V.trace(image(256,256,disc,4),{tolerance:.1});
  near(totalArea(soft),Math.PI*R*R,.002,"anti-aliased circle area");
  // Every vertex of the anti-aliased trace lies close to the true circle.
  let worst=0;for(const p of soft.polygons[0].outer)worst=Math.max(worst,Math.abs(Math.hypot(p[0]-cx,p[1]-cy)-R));
  assert.ok(worst<.35,"sub-pixel contour accuracy "+worst);
  // Outer rings are positive (clockwise on screen) in the Y-down frame.
  assert.ok(V.area(soft.polygons[0].outer)>0);
  // Simplification keeps vertex counts sane.
  assert.ok(soft.stats.vertices<220,"circle vertices "+soft.stats.vertices);
}

// ---- Ring with a hole -------------------------------------------------------
{
  const cx=100,cy=100,R=80,r=45,ring=(x,y)=>{const d=(x-cx)**2+(y-cy)**2;return d<=R*R&&d>=r*r;};
  const t=V.trace(image(200,200,ring,4),{tolerance:.1});
  assert.equal(t.polygons.length,1,"one polygon");
  assert.equal(t.polygons[0].holes.length,1,"hole detected");
  assert.ok(V.area(t.polygons[0].holes[0])<0,"hole is negative");
  near(totalArea(t),Math.PI*(R*R-r*r),.005,"annulus area");
  // Invert: the hole becomes an island and the frame becomes a holed outer.
  const inv=V.trace(image(200,200,ring,4),{tolerance:.1,invert:true});
  assert.equal(inv.polygons.length,2);
  assert.equal(inv.polygons.reduce((n,p)=>n+p.holes.length,0),1);
  near(totalArea(inv),200*200-Math.PI*(R*R-r*r),.005,"inverted area");
  // Alpha mode on a transparent background.
  const img=image(200,200,ring,4);for(let i=0;i<img.data.length;i+=4){img.data[i+3]=255-img.data[i];img.data[i]=img.data[i+1]=img.data[i+2]=0;}
  const a=V.trace(img,{mode:"alpha",tolerance:.1});
  near(totalArea(a),Math.PI*(R*R-r*r),.005,"alpha annulus area");
}

// ---- Letter "A" (polygon with a counter) rasterised and traced ----------------
{
  // Outer A and its triangular counter, Y down, in a 400 x 400 frame.
  const outer=[[40,380],[170,20],[230,20],[360,380],[290,380],[262,300],[138,300],[110,380]];
  const counter=[[160,240],[240,240],[200,120]];
  const exact=V.area(outer)-Math.abs(V.area(counter));
  const f=new Uint8Array(400*400);
  V.rasterPolygons(f,400,400,[outer,counter],{scale:1,ox:0,oy:0});
  // Winding: the counter must be clear.
  assert.equal(f[200*400+200],0);assert.equal(f[340*400+100],255);
  const t=V.traceField(f,400,400,127.5,{tolerance:.2});
  assert.equal(t.polygons.length,1);assert.equal(t.polygons[0].holes.length,1,"A counter detected");
  near(totalArea(t),exact,.002,"letter A area");
  assert.ok(t.stats.vertices<=40,"A vertices "+t.stats.vertices);
  // Keyhole bridge: one ring with the same area, no hole needed.
  const ring=V.bridge(t.polygons[0]);
  near(V.area(ring),exact,.002,"bridged area");
  assert.ok(ring.length===t.polygons[0].outer.length+t.polygons[0].holes[0].length+2);
  // The bridge is a zero-width cut: the counter centre is outside the ring
  // (even-odd) while the stroke is inside.
  assert.equal(V.contains(ring,200,215),false);assert.equal(V.contains(ring,100,340),true);
}

// ---- Bridge with several holes, nested islands ----------------------------
{
  const sq=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
  const poly={outer:sq(0,0,100,60),holes:[sq(10,10,30,50).reverse(),sq(40,10,60,50).reverse(),sq(70,25,90,35).reverse()]};
  const ring=V.bridge(poly);
  near(V.area(ring),6000-800-800-200,1e-9,"multi-hole bridge area");
  for(const [x,y,inside] of [[20,30,false],[50,30,false],[80,30,false],[35,30,true],[65,30,true],[80,15,true]])assert.equal(V.contains(ring,x,y),inside,"point "+x+","+y);
  // Proper intersections (excluding shared or collinear bridge edges) must not exist.
  const segs=ring.map((p,i)=>[p,ring[(i+1)%ring.length]]);
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  let bad=0;
  for(let i=0;i<segs.length;i++)for(let j=i+1;j<segs.length;j++){
    const [a,b]=segs[i],[c,d]=segs[j],d1=cross(a,b,c),d2=cross(a,b,d),d3=cross(c,d,a),d4=cross(c,d,b);
    if(((d1>0&&d2<0)||(d1<0&&d2>0))&&((d3>0&&d4<0)||(d3<0&&d4>0)))bad++;
  }
  assert.equal(bad,0,"bridged ring does not self-intersect");
}

// ---- Smoothing and speckle removal ------------------------------------------
{
  const noisy=image(120,120,(x,y)=>(x>20&&x<100&&y>20&&y<100)||((x|0)%17===3&&(y|0)%19===5));
  const raw=V.trace(noisy,{tolerance:.3});
  const clean=V.trace(noisy,{tolerance:.3,turdSize:4});
  assert.ok(raw.polygons.length>1);assert.equal(clean.polygons.length,1,"specks removed");
  const smooth=V.trace(noisy,{tolerance:.3,turdSize:4,smoothing:3});
  assert.equal(smooth.polygons.length,1);
  near(totalArea(smooth),80*80,.03,"smoothed square area");
}

// ---- Colour layers ----------------------------------------------------------
{
  const w=160,h=100,data=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const k=4*(y*w+x),c=x>=20&&x<70&&y>=20&&y<80?[220,30,30]:x>=90&&x<140&&y>=20&&y<80?[20,40,200]:[250,250,250];
    data[k]=c[0];data[k+1]=c[1];data[k+2]=c[2];data[k+3]=255;
  }
  const t=V.trace({width:w,height:h,data},{mode:"color",colors:3,tolerance:.2});
  assert.equal(t.layers.length,3);
  const bg=t.layers.filter(l=>l.background);assert.equal(bg.length,1);assert.equal(bg[0].hex,"#fafafa");
  const red=t.layers.find(l=>l.color[0]>200&&l.color[2]<60),blue=t.layers.find(l=>l.color[2]>180&&l.color[0]<100);
  assert.ok(red&&blue);near(totalArea({polygons:red.polygons}),50*60,.001,"red square");near(totalArea({polygons:blue.polygons}),50*60,.001,"blue square");
}

// ---- Minimum feature check ---------------------------------------------------
{
  // A 3 px line and a 20 px bar; radius 3 px flags only the thin line.
  const f=new Uint8Array(100*60);
  for(let y=10;y<13;y++)for(let x=10;x<90;x++)f[y*100+x]=1;
  for(let y=25;y<45;y++)for(let x=10;x<90;x++)f[y*100+x]=1;
  const r=V.features(f,100,60,3);
  assert.equal(r.thinCount,240,"thin line flagged");
  assert.ok(r.gapCount===0,"no narrow gaps (12 px apart): "+r.gapCount);
  const g=V.features(f,100,60,7);assert.ok(g.gapCount>0,"12 px gap below 14 px flagged");
}

// ---- Stroke raster ----------------------------------------------------------
{
  const f=new Uint8Array(200*100);
  V.rasterStrokes(f,200,100,[{points:[[2,5],[18,5]],width:2}],{scale:10,ox:0,oy:0});
  const t=V.traceField(f,200,100,127.5,{tolerance:.1});
  near(totalArea(t)/100,16*2+Math.PI,.01,"capsule area");
}

// ---- Logo Creator pipeline: scale, layers, mirroring, grouping, checks ------
{
  // Annulus (R 80, r 45 px) plus a 1 px hairline.
  const img=image(240,200,(x,y)=>{const d=(x-100)**2+(y-100)**2;return (d<=80*80&&d>=45*45)||(x>=200&&x<201&&y>=40&&y<160);},4);
  const r=L.process(img,{width:24,minFeature:.15,tolerance:.3});
  // Ink spans x 20..201 = 181 px -> 24 mm, so the hairline is 0.13 mm.
  near(r.scale[0],24/181,.001,"mm per pixel");near(r.size[0],24,1e-9,"target width");
  assert.equal(r.trace.polygons.length,2);
  assert.ok(r.thinCount>0&&r.warnings.some(w=>/thinner than 0.15 mm/.test(w)),"hairline flagged: "+r.warnings.join("|"));
  const top=L.build(r,{layer:"Top+mask",groupId:"g1"});
  assert.equal(top.items.length,4,"copper and mask opening for each polygon");
  assert.deepEqual([...new Set(top.items.map(i=>i.layer))],["Top","Top mask"]);
  assert.ok(top.items.every(i=>i.groupId==="g1"&&i.kind==="graphic"&&i.fill&&i.closed&&i.width===0));
  const annulus=top.items.find(i=>i.points.length>20);
  near(Math.abs(V.area(annulus.points)),Math.PI*(80*80-45*45)*r.scale[0]**2,.01,"annulus area in mm²");
  // Centred on the origin; bottom layers mirror automatically.
  const xsTop=top.items.flatMap(i=>i.points.map(p=>p[0])),bot=L.build(r,{layer:"Bottom silk",groupId:"g2"});
  near(Math.max(...xsTop),12,.01,"centred right edge");
  const xsBot=bot.items.flatMap(i=>i.points.map(p=>p[0]));near(Math.min(...xsBot),-12,.01,"mirrored");
  assert.ok(bot.items.every(i=>V.area(i.points)>0),"mirrored rings keep their orientation");
  // Removing thin features drops the hairline.
  const clean=L.process(img,{width:24,minFeature:.15,tolerance:.3,enforce:true});
  assert.equal(clean.trace.polygons.length,1);
  // Model validation accepts the grouped graphics.
  const p=Atrium.project("Logo",[]),pcb=p.documents.find(d=>d.kind==="pcb");pcb.items.push(...top.items);Atrium.validate(p);
}

// ---- Benchmark: 2000 x 2000 --------------------------------------------------
{
  const w=2000,h=2000,data=new Uint8ClampedArray(w*h*4);
  // Concentric rings and a grid of dots: many contours plus large shapes.
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const d=Math.hypot(x-1000,y-1000),ring=Math.floor(d/60)%2===0&&d<900,dot=((x%50)-25)**2+((y%50)-25)**2<64&&d>=900;
    const k=4*(y*w+x),v=ring||dot?0:255;data[k]=data[k+1]=data[k+2]=v;data[k+3]=255;
  }
  const img={width:w,height:h,data};
  V.trace({width:200,height:200,data:data.subarray(0,200*200*4)},{});
  const t0=now(),r=V.trace(img,{tolerance:.5,turdSize:4});const t1=now();
  const t2=now(),rs=V.trace(img,{tolerance:.5,turdSize:4,smoothing:2});const t3=now();
  console.log("vectorize 2000x2000: "+(t1-t0).toFixed(0)+" ms, "+r.stats.polygons+" polygons, "+r.stats.rings+" rings, "+r.stats.vertices+" vertices; smoothed "+(t3-t2).toFixed(0)+" ms");
  assert.ok(r.stats.rings>500);
  assert.ok(t1-t0<2500,"trace time "+(t1-t0));
}
console.log("vectorize tests passed");
