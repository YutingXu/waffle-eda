"use strict";

// Polygon pour engine: geometry, clearance, relief, dead copper, priority,
// stored-region compatibility and performance. Run with Node 18+.
const assert=require("node:assert/strict");
const {segSeg} = require("../support/segment-distance.cjs");
for(const m of ["model","spatial","pcb-appearance","pcb-pours","pcb-import","polygon-pour"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
if(!globalThis.performance)globalThis.performance=require("node:perf_hooks").performance;
const PP=AtriumPolygonPour;
const ok=(c,msg)=>assert.ok(c,msg);
function near(a,b,eps,msg){ok(Math.abs(a-b)<=eps,msg+" (got "+a+", want "+b+" ±"+eps+")");}
function ringArea(r){let s=0;const n=r.length>>1;for(let i=0,j=n-1;i<n;j=i++)s+=r[2*j]*r[2*i+1]-r[2*i]*r[2*j+1];return s/2;}
function regionArea(reg){const rs=PP.rings(reg);return Math.abs(ringArea(rs[0]))-rs.slice(1).reduce((s,r)=>s+Math.abs(ringArea(r)),0);}
const totalArea=regs=>regs.reduce((s,r)=>s+regionArea(r),0);
function pip(x,y,r){let ins=false;const n=r.length>>1;for(let i=0,j=n-1;i<n;j=i++){const x1=r[2*j],y1=r[2*j+1],x2=r[2*i],y2=r[2*i+1];if((y1>y)!==(y2>y)&&x<x1+(y-y1)*(x2-x1)/(y2-y1))ins=!ins;}return ins;}
function inRegions(x,y,regs){for(const g of regs){const rs=PP.rings(g);if(pip(x,y,rs[0])&&!rs.slice(1).some(h=>pip(x,y,h)))return true;}return false;}
// minimum distance between region boundaries and a set of segments (centre lines / polygon edges)
function minDist(regs,segs){
  let m=Infinity;
  for(const g of regs)for(const r of PP.rings(g)){const n=r.length>>1;for(let i=0,j=n-1;i<n;j=i++){const a=[r[2*j],r[2*j+1]],b=[r[2*i],r[2*i+1]];for(const [c,d] of segs)m=Math.min(m,segSeg(a,b,c,d));}}
  return m;
}
const rect=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
function board(items,outline=rect(0,0,50,40),extra={}){return {kind:"pcb",items,outline,rules:{format:"atrium-rules",version:1,units:"mm",defaults:{clearance:.2,trackWidth:.15,viaDrill:.3},nets:{}},...extra};}
let nid=0;const id=()=>"i"+(++nid);
const via=(x,y,net,d=.6)=>({id:id(),kind:"via",x,y,diameter:d,drill:.3,layer:"Multi",net});
const track=(pts,net,width=.25,layer="Top")=>({id:id(),kind:"track",points:pts,width,layer,net});

// ---- cases
// 1. simple full-board pour, one anchor
{
  const p=PP.make(rect(-5,-5,55,45),{net:"GND",layer:"Top"});
  const doc=board([via(25,20,"GND"),p]);
  const regs=PP.pour(doc,null,p,{});
  ok(regs.length===1,"simple: one region");
  near(totalArea(regs),2000,1e-6,"simple: clipped to board outline area");
  ok(regs[0].links.length===1&&regs[0].links[0][0]===doc.items[0].id,"simple: link to via");
  ok(regs[0].polygon===p.id&&regs[0].layer==="Top"&&regs[0].net==="GND","simple: tags");
  const c=AtriumPCBPours.contours(regs[0]);ok(c.length===1&&c[0].length===8,"simple: pcb-pours decodes 4-vertex outline");
}
// 2. other-net track crossing the pour splits it
{
  const t=track([[-5,20],[55,20]],"SIG",.25);
  const p=PP.make(rect(0,0,50,40),{net:"GND"});
  const doc=board([t,via(10,10,"GND"),via(10,30,"GND"),p]);
  const regs=PP.pour(doc,null,p,{});
  ok(regs.length===2,"track: two halves, got "+regs.length);
  near(totalArea(regs),2000-50*(.25+.4),.003,"track: area minus clearance band");
  const d=minDist(regs,[[[-5,20],[55,20]]]);
  near(d,.125+.2,1e-4,"track: boundary-to-centreline distance = w/2+clearance");
  // diagonal track: clearance >= w/2+c and close to it
  const t2=track([[3,3],[47,36]],"SIG",.3);
  const doc2=board([t2,via(40,5,"GND"),via(5,35,"GND"),p]);
  const r2=PP.pour(doc2,null,p,{});
  const d2=minDist(r2,[[[3,3],[47,36]]]);
  ok(d2>=.15+.2-1e-5&&d2<=.15+.2+.0127+1e-4,"diagonal track clearance "+d2);
  // stadium caps: track end inside pour
  const t3=track([[20,20],[30,20]],"SIG",.4);
  const r3=PP.pour(board([t3,via(5,5,"GND"),p]),null,p,{});
  const d3=minDist(r3,[[[20,20],[30,20]]]);
  ok(d3>=.2+.2-1e-5&&d3<=.4+.0127+1e-4,"stadium cap clearance "+d3);
  near(totalArea(r3),2000-(10*.8+Math.PI*.4*.4),.02,"stadium hole area");
}
// 3. same-net pad with thermal relief
{
  const pad={id:id(),kind:"pad",x:10,y:10,w:1.5,h:1.5,drill:.8,shape:"round",layer:"Multi",net:"GND",number:"1"};
  const p=PP.make(rect(0,0,50,40),{net:"GND",reliefAirGap:.3,reliefConductorWidth:.25});
  const doc=board([pad,p]);
  const regs=PP.pour(doc,null,p,{});
  ok(regs.length===1,"relief: one region");
  ok(inRegions(10+.75+.15,10,regs),"relief: spoke +x present");
  ok(inRegions(10,10-.75-.15,regs),"relief: spoke -y present");
  ok(!inRegions(10+.75+.15,10+.4,regs),"relief: air gap between spokes");
  ok(!inRegions(10,10,regs),"relief: pad centre not poured");
  ok(inRegions(10+.75+.35,10+.6,regs),"relief: copper beyond gap");
  ok(regs[0].links.length===1,"relief: island linked to pad via spokes");
  // expected area: board - (annulus gap r=0.75..1.05 minus 4 spokes) - pad itself(minus nothing) 
  const rg=1.05,rp=.75,annulus=Math.PI*(rg*rg-rp*rp),spokes=4*.25*(rg-rp);
  const holeArea=Math.PI*rp*rp+annulus-spokes;
  near(totalArea(regs),2000-holeArea,.03,"relief: area");
  // 45 degree, 2 entries
  const p2=PP.make(rect(0,0,50,40),{net:"GND",reliefEntries:2,reliefAngle:45});
  const r2=PP.pour(board([pad,p2]),null,p2,{});
  const s=Math.SQRT1_2*(.75+.2);
  ok(inRegions(10+s,10+s,r2)&&inRegions(10-s,10-s,r2)&&!inRegions(10+s,10-s,r2),"relief: two 45° spokes");
  // direct connect
  const p3=PP.make(rect(0,0,50,40),{net:"GND",connectStyle:"direct"});
  const r3=PP.pour(board([pad,p3]),null,p3,{});
  near(totalArea(r3),2000,1e-6,"direct: no hole");
  // other-net pad: clearance to rotated rect pad
  const sp={id:id(),kind:"pad",x:25,y:20,w:2,h:1,angle:30,shape:"rect",layer:"Top",net:"SIG"};
  const r4=PP.pour(board([sp,via(5,5,"GND"),p]),null,p,{});
  const c=Math.cos(Math.PI/6),sn=Math.sin(Math.PI/6),corners=[[-1,-.5],[1,-.5],[1,.5],[-1,.5]].map(([x,y])=>[25+x*c-y*sn,20+x*sn+y*c]);
  const d=minDist(r4,corners.map((q,i)=>[q,corners[(i+1)%4]]));
  ok(d>=.2-1e-5&&d<=.2+.0127+1e-4,"rect pad clearance "+d);
  near(totalArea(r4),2000-(2*1+2*(2+1)*.2+Math.PI*.04),.01,"rect pad cut area");
}
// 4. nested islands and dead copper
{
  const loop=track([[15,10],[35,10],[35,30],[15,30],[15,10]],"SIG",.3);
  const inner=track([[22,17],[28,17],[28,23],[22,23],[22,17]],"SIG2",.3);
  const p=PP.make(rect(0,0,50,40),{net:"GND"});
  const anchors=[via(5,5,"GND"),via(25,13,"GND"),via(25,20,"GND")];
  const regs=PP.pour(board([loop,inner,...anchors,p]),null,p,{});
  ok(regs.length===3,"nested: three islands (outer, ring, centre) got "+regs.length);
  ok(regs.some(r=>PP.rings(r).length===2),"nested: ring island has a hole");
  const outer=regs.find(r=>r.bounds[0]<1);ok(outer&&PP.rings(outer).length===2,"nested: outer island has the loop hole");
  // remove centre anchor: centre island is dead
  const st={};
  const r2=PP.pour(board([loop,inner,anchors[0],anchors[1],p]),null,p,{stats:st});
  ok(r2.length===2&&st.deadIslands===1,"dead copper: centre removed ("+r2.length+","+st.deadIslands+")");
  const st3={};const p3={...p,removeDeadCopper:false};
  const r3=PP.pour(board([loop,inner,anchors[0],p3]),null,p3,{stats:st3});
  ok(r3.length===3,"dead copper off keeps all islands");
}
// 5. board clipping non-convex board, priority between polygons
{
  const outline=[[0,0],[40,0],[40,30],[20,30],[20,15],[0,15]];
  const gnd=PP.make(rect(-1,-1,41,31),{net:"GND",pourIndex:0});
  const vcc=PP.make(rect(10,5,30,25),{net:"VCC",pourIndex:1});
  const doc=board([via(5,5,"GND"),via(30,25,"GND"),via(15,8,"VCC"),gnd,vcc],outline);
  const res=PP.repourAll(doc,null,{});
  const g=res.regions.filter(r=>r.net==="GND"),v=res.regions.filter(r=>r.net==="VCC");
  near(totalArea(g),40*15+20*15-Math.PI*.25,.02,"board clip: gnd fills non-convex board minus VCC via clearance");
  ok(v.length===1&&Math.abs(totalArea(v)-Math.PI*.09)<.005,"priority: vcc only fills the clearance hole around its via (got "+v.length+")");
  // reverse priority: VCC first then GND avoids VCC with clearance
  vcc.pourIndex=0;gnd.pourIndex=1;
  const res2=PP.repourAll(doc,null,{});
  const g2=res2.regions.filter(r=>r.net==="GND"),v2=res2.regions.filter(r=>r.net==="VCC");
  const vArea=totalArea(v2);
  ok(v2.length>=1&&vArea>100,"priority: vcc poured first ("+vArea+")");
  const vsegs=[];for(const r of v2)for(const ring of PP.rings(r)){const n=ring.length>>1;for(let i=0,j=n-1;i<n;j=i++)vsegs.push([[ring[2*j],ring[2*j+1]],[ring[2*i],ring[2*i+1]]]);}
  const d=minDist(g2,vsegs);
  ok(d>=.2-1e-5&&d<.2+.0127+1e-4,"priority: gnd keeps clearance from vcc pour "+d);
  ok(PP.polygons(doc)[0]===vcc,"pour order by pourIndex");
}
// 6. apply / signature / stale
{
  const p=PP.make(rect(0,0,50,40),{net:"GND"});
  const t=track([[5,20],[45,20]],"SIG");
  const doc=board([t,via(10,10,"GND"),via(10,30,"GND"),p],undefined,{name:"b",id:"d",grid:.25,notes:[]});
  const defs=new Map();
  PP.apply(doc,defs);
  ok(doc.pcbDrawing.pours.length===1,"apply stores regions");
  ok(/^[0-9a-f]{16}$/.test(doc.sourcePourSignature),"apply stores signature");
  ok(doc.sourcePourSignature===AtriumPCBPours.signature(doc,defs),"canvas pourState would read source");
  ok(PP.state(doc,defs)==="source"&&PP.stale(doc,defs).length===0,"fresh");
  t.points[1][0]=40;
  ok(PP.state(doc,defs)==="stale"&&PP.stale(doc,defs)[0]===p.id,"track edit marks stale");
  t.points[1][0]=45;p.reliefAirGap=.5;
  ok(PP.stale(doc,defs)[0]===p.id,"setting change marks polygon stale");
  PP.apply(doc,defs);ok(PP.state(doc,defs)==="source","repoured");
  // model validation of stored regions (polygon item removed: model.js does not know the kind yet)
  // (the scratch board's own rules are not a project field: boards read the project rule book)
  const proj={format:"atrium",version:1,name:"x",library:[],documents:[{...doc,rules:undefined,items:doc.items.filter(i=>i.kind!=="polygon")}]};
  let valid=true;try{Atrium.validate(JSON.parse(JSON.stringify(proj)));}catch(e){valid=e.message;}
  ok(valid===true,"stored regions pass Atrium.validate: "+valid);
  // imported pours kept while board unchanged
  const imp={layer:"Bottom",net:"GND",bounds:[0,0,1,1],count:1,data:PP.encode([[0,0,1,0,1,1]],"Bottom","GND").data};
  const d2=board([via(10,10,"GND")],undefined,{});d2.pcbDrawing={annotations:{},pours:[imp]};d2.sourcePourSignature=AtriumPCBPours.signature(d2,defs);
  const p2=PP.make(rect(0,0,50,40),{net:"GND"});d2.items.push(p2);
  PP.apply(d2,defs);ok(d2.pcbDrawing.pours.length===2&&d2.pcbDrawing.pours[0]===imp,"imported region kept when only polygons changed");
  d2.items[0].x=11;PP.apply(d2,defs);ok(d2.pcbDrawing.pours.length===1,"stale imported region dropped");
  ok(PP.validate(p2)===p2,"validate");
}
// 7. booleans
{
  const u=PP.union([rect(0,0,2,2),rect(1,1,3,3)]);ok(u.length===1&&u[0].outline.length===8,"union L-shape");
  const d=PP.difference([rect(0,0,4,4)],[rect(1,1,3,3)]);ok(d.length===1&&d[0].holes.length===1,"difference hole");
  const t=PP.difference([rect(0,0,2,2),rect(2,2,4,4)],[]);ok(t.length===2,"touching squares stay separate rings: "+t.length);
  const x=PP.intersection([rect(0,0,2,2)],[rect(1,1,3,3)]);ok(x.length===1&&Math.abs(Math.abs(ringArea(x[0].outline.flat()))-1)<1e-9,"intersection");
  const s=PP.union([rect(0,0,2,2),rect(0,0,2,2),rect(2,0,4,2)]);ok(s.length===1&&s[0].outline.length===4,"coincident edges merge: "+s[0]?.outline.length);
}
// 8. footprint pads, part rotation, SMD on other side ignored
{
  const fp={pads:[{number:"1",x:-1,y:0,w:.8,h:1.2,shape:"rect",layer:"Top"},{number:"2",x:1,y:0,w:.8,h:1.2,shape:"rect",layer:"Top"},{number:"3",x:0,y:3,w:1,h:1,shape:"rect",layer:"Bottom"}],shapes:[]};
  const defs=new Map([["fp",{id:"fp",footprint:fp}]]);
  const part={id:id(),kind:"part",def:"fp",x:20,y:20,angle:90,pinNets:{"1":"GND","2":"SIG","3":"SIG"}};
  const p=PP.make(rect(0,0,50,40),{net:"GND"});
  const regs=PP.pour(board([part,p]),defs,p,{});
  ok(regs.length===1&&regs[0].links.some(l=>l[1]==="pad0"),"part: relief to pad 1 links "+JSON.stringify(regs[0]?.links));
  ok(!inRegions(20,21,regs)&&!inRegions(20.75,21,regs)&&inRegions(20,21.7,regs),"part: pad 2 at rotated position is cleared");
  ok(inRegions(17,20,regs),"part: bottom pad ignored on Top");
}

// ---- conversion, selective repour, cutouts, keep-outs, rules
{
const rec={LAYER:"TOP",NET:"0",POLYGONTYPE:"Polygon",POUROVER:"TRUE",REMOVEDEAD:"TRUE",POURINDEX:"2",MINPRIMLENGTH:"3mil",ARCRESOLUTION:"0.5mil",
  KIND0:"0",VX0:"0mil",VY0:"0mil",KIND1:"1",VX1:"1000mil",VY1:"0mil",CX1:"1000mil",CY1:"-500mil",SA1:"90",EA1:"270",VX2:"1000mil",VY2:"-1000mil",KIND2:"0",VX3:"0mil",VY3:"-1000mil"};
const p=PP.fromAltium(rec,{toLayer:l=>l==="TOP"?"Top":l,netName:i=>["GND"][i]});
ok(p.layer==="Top"&&p.net==="GND"&&p.pourIndex===2&&Math.abs(p.minPrimLength-.0762)<1e-9&&Math.abs(p.arcApproximation-.0127)<1e-9,"fromAltium settings");
const xs=p.points.map(q=>q[0]);ok(Math.max(...xs)<=25.4+1e-9&&Math.min(...p.points.filter(q=>q[1]>1&&q[1]<24).map(q=>q[0]))<13,"fromAltium arc bulges inward (CCW y-up sweep)");
ok(PP.validate(p)===p,"fromAltium validates");
// repour only one polygon keeps the other's regions
const a=PP.make(rect(0,0,20,40),{net:"GND"}),b=PP.make(rect(30,0,50,40),{net:"VCC",pourIndex:1});
const doc=board([via(5,5,"GND"),via(35,5,"VCC"),a,b]);
PP.apply(doc,null);const before=doc.pcbDrawing.pours.filter(r=>r.polygon===a.id);
b.points[0][0]=31;const res=PP.repourAll(doc,null,{only:[b.id]});
ok(res.regions.filter(r=>r.polygon===a.id)[0]===before[0]&&res.stats.polygons[b.id]&&!res.stats.polygons[a.id],"repour selected");
PP.strip(doc,[a.id]);ok(doc.pcbDrawing.pours.every(r=>r.polygon===b.id),"strip");
PP.strip(doc,[b.id]);ok(!doc.pcbDrawing.pours&&!doc.sourcePourSignature,"strip all clears");
// cutout and keepout
const c=PP.make(rect(5,5,10,10),{cutout:true});const k={id:"k",kind:"track",points:[[12,0],[12,40]],width:.2,layer:"Keepout"};
const g=PP.make(rect(0,0,50,40),{net:"GND"});
const r=PP.pour(board([via(2,2,"GND"),via(45,2,"GND"),c,k,g]),null,g,{});
ok(!inRegions(7,7,r)&&inRegions(4,4,r)&&!inRegions(12.25,20,r)&&inRegions(12.5,20,r),"cutout and keepout");
// no-net polygon keeps all islands, other copper all obstacles
const n=PP.make(rect(0,0,50,40),{});const rn=PP.pour(board([track([[-1,20],[51,20]],"GND"),n]),null,n,{});ok(rn.length===2,"no-net polygon floating islands kept");
// pourOverSameNet false clears same-net tracks
const s=PP.make(rect(0,0,50,40),{net:"GND",pourOverSameNet:false});const rs=PP.pour(board([via(2,2,"GND"),track([[10,10],[20,10]],"GND",.3),s]),null,s,{});
ok(!inRegions(15,10.3,rs)&&inRegions(15,10.5,rs),"don't pour over same net");
// rule overrides: net-specific clearance
const rd=board([track([[-1,20],[51,20]],"HV",.2),via(2,2,"GND"),via(2,38,"GND"),g]);rd.rules.nets.HV={clearance:1};
const rr=PP.pour(rd,null,g,{});const dd=minDist(rr,[[[-1,20],[51,20]]]);ok(dd>=1.1&&dd<1.1+.014,"per-net rule clearance "+dd);
}
// ---- boolean fuzzing against point sampling
let s2=777;const r2=()=>((s2=Math.imul(s2,1103515245)+12345>>>0)/4294967296);
const R=PP._internal.rounded;
function shapeSet(n,grid){
  const out=[];
  for(let i=0;i<n;i++){
    const k=r2();
    if(grid){const x=Math.floor(r2()*20),y=Math.floor(r2()*20),w=1+Math.floor(r2()*4),h=1+Math.floor(r2()*4);out.push(rect(x,y,x+w,y+h).flat());continue;}
    const cx=r2()*20,cy=r2()*20;
    if(k<.3)out.push(R([[cx,cy]],.3+r2()*2,.01,"outer"));
    else if(k<.6){const a=r2()*6.28,l=r2()*8;out.push(R([[cx,cy],[cx+l*Math.cos(a),cy+l*Math.sin(a)]],.1+r2(),.01,"outer"));}
    else {const a=r2()*90,w=r2()*4+.2,h=r2()*4+.2,c=Math.cos(a),s=Math.sin(a);out.push([[-w,-h],[w,-h],[w,h],[-w,h]].flatMap(([x,y])=>[cx+x*c-y*s,cy+x*s+y*c]));}
  }
  return out;
}
const pipFlat=(x,y,f)=>pip(x,y,f);
function inIsl(x,y,res){for(const o of res){if(pip(x,y,o.outline.flat())&&!o.holes.some(h=>pip(x,y,h.flat())))return true;}return false;}
for(const [label,grid] of [["random",false],["grid-aligned",true]]){
  for(let trial=0;trial<4;trial++){
    const A1=shapeSet(150,grid),B1=shapeSet(60,grid);
    const t=performance.now();
    const U=PP.union(A1),D=PP.difference(A1,B1);
    const ms=performance.now()-t;
    let bad=0,N=20000;
    for(let i=0;i<N;i++){
      const x=r2()*24-1,y=r2()*24-1;
      const inA=A1.some(f=>pipFlat(x,y,f)),inB=B1.some(f=>pipFlat(x,y,f));
      if(inIsl(x,y,U)!==inA)bad++;
      if(inIsl(x,y,D)!==(inA&&!inB))bad++;
    }
    ok(bad===0,label+" fuzz trial "+trial+": "+bad+" mismatches");
  }
}

// ---- dense board performance and clearance
let seed=12345;const rnd=()=>((seed=Math.imul(seed,1103515245)+12345>>>0)/4294967296);
function dense(){
  const items=[];nid=0;
  const fp={pads:[{number:"1",x:-.8,y:0,w:.9,h:1,shape:"roundrect"},{number:"2",x:.8,y:0,w:.9,h:1,shape:"roundrect"}],shapes:[]};
  const th={pads:[{number:"1",x:0,y:0,w:1.6,h:1.6,drill:.9,shape:"rect"},{number:"2",x:2.54,y:0,w:1.6,h:1.6,drill:.9,shape:"round"},{number:"3",x:5.08,y:0,w:1.6,h:1.6,drill:.9,shape:"round"}],shapes:[]};
  const defs=new Map([["r",{id:"r",footprint:fp}],["h",{id:"h",footprint:th}]]);
  const nets=["GND","SIG1","SIG2","SIG3","VCC","SIG4"];
  let count=0;
  for(let i=0;i<220;i++){ // 440 pads
    const net=()=>nets[Math.floor(rnd()*nets.length)];
    items.push({id:id(),kind:"part",def:"r",x:4+rnd()*92,y:4+rnd()*72,angle:Math.floor(rnd()*4)*90+ (rnd()<.2?30:0),layer:"Top",pinNets:{"1":net(),"2":net()}});count+=2;
  }
  for(let i=0;i<30;i++){items.push({id:id(),kind:"part",def:"h",x:4+rnd()*88,y:4+rnd()*72,angle:0,pinNets:{"1":"GND","2":"SIG1","3":"VCC"}});count+=3;}
  for(let i=0;i<250;i++){items.push(via(2+rnd()*96,2+rnd()*76,nets[Math.floor(rnd()*nets.length)]));count++;}
  for(let i=0;i<120;i++){ // tracks with 3 segments
    let x=2+rnd()*96,y=2+rnd()*76;const pts=[[x,y]];
    for(let k=0;k<3;k++){const a=Math.floor(rnd()*8)*Math.PI/4,l=3+rnd()*10;x=Math.max(1,Math.min(99,x+l*Math.cos(a)));y=Math.max(1,Math.min(79,y+l*Math.sin(a)));pts.push([x,y]);}
    items.push(track(pts,nets[Math.floor(rnd()*nets.length)],.2+rnd()*.3));count+=3;
  }
  const p=PP.make(rect(0,0,100,80),{net:"GND"});items.push(p);
  return {doc:board(items,rect(0,0,100,80)),defs,p,count};
}
const {doc,defs,p,count}=dense();
let regs,st;
for(let k=0;k<3;k++){st={};const t=performance.now();regs=PP.pour(doc,defs,p,{stats:st});st.wall=performance.now()-t;}
// verify clearance numerically against every other-net track segment and via
const segs=[];for(const i of doc.items){if(i.kind==="track"&&i.net!=="GND")for(let k=1;k<i.points.length;k++)segs.push([i.points[k-1],i.points[k],i.width/2]);}
let worst=Infinity;
for(const [a,b,h] of segs){const d=minDist(regs,[[a,b]])-h;worst=Math.min(worst,d);}
for(const i of doc.items)if(i.kind==="via"&&i.net!=="GND"){const d=minDist(regs,[[[i.x,i.y],[i.x,i.y]]])-i.diameter/2;worst=Math.min(worst,d);}
ok(worst>=.2-1e-5,"dense: min clearance to other-net tracks/vias "+worst.toFixed(6));
ok(st.wall<300||process.env.SLOW,"dense: "+count+" obstacles poured in "+st.wall.toFixed(1)+" ms (target 300)");
ok(!st.brokenRings&&!st.unresolved,"dense: clean arrangement");

// Hatched fill: openings at the pitch, copper fraction 1 - ((p - w) / p)^2.
// A pour needing more openings than a region can hold (65535 holes) is poured
// solid, never silently: stats, every region and the warning say so.
{
  const rect=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
  const run=(L,ang)=>{
    const p=PP.make(rect(0,0,L,L),{net:"GND",layer:"Top"});Object.assign(p,{fillMode:"hatched",hatchAngle:ang,hatchPitch:.5,hatchWidth:.15});
    const doc={kind:"pcb",outline:rect(-1,-1,L+1,L+1),items:[{id:"v",kind:"via",x:L/2+.01,y:L/2+.01,diameter:.6,drill:.3,layer:"Multi",net:"GND"},p],
      rules:{format:"atrium-rules",version:1,units:"mm",defaults:{clearance:.2,trackWidth:.15,viaDrill:.3},nets:{}}};
    const stats={},regs=PP.pour(doc,null,p,{stats});return {regs,stats,frac:totalArea(regs)/(L*L)};
  };
  for(const ang of [45,0]){
    const h=run(20,ang);ok(!h.stats.hatchSkipped&&!h.regs[0].hatchSkipped,"20 mm hatches");near(h.frac,1-(.35/.5)**2,.02,"hatch copper fraction "+ang);
    ok(PP.rings(h.regs[0]).length>1000,"openings are holes");
  }
  const big=run(140,45);
  ok(big.stats.hatchSkipped&&/poured SOLID/.test(big.stats.warning),"over the hole limit: warned");
  ok(big.regs.length&&big.regs.every(r=>r.hatchSkipped===true),"regions carry hatchSkipped");
  ok(big.regs.every(r=>r.count<=65536),"no region over the stored hole limit");
}
// A new pour's default net (newcomer review F7): ground first, else the net with the most pads.
{
  const fp={footprint:{pads:[{number:"1"},{number:"2"}]}},defs=new Map([["r",fp]]);
  const part=(id,a,b)=>({id,kind:"part",def:"r",pinNets:{1:a,2:b}});
  ok(PP.defaultNet({items:[part("a","VCC","Net-1"),part("b","GND","VCC")]},defs)==="GND","GND when there is one");
  ok(PP.defaultNet({items:[part("a","VCC","AGND"),part("b","VCC","SIG")]},defs)==="AGND","another ground");
  ok(PP.defaultNet({items:[part("a","VCC","SIG"),part("b","VCC","OUT")]},defs)==="VCC","otherwise the most-connected net");
  ok(PP.defaultNet({items:[]},defs)==="","no nets: No Net");
}
// One forward close matches a full prerequisite traversal: chain, fan-in, unrelated pour.
{
  const ids=["chain0","chain1","chain2","pre0","pre1","fan","sibling","clearChild"];
  const deps=[[],[0],[1],[],[],[3,4],[],[4]],list=ids.map(id=>({id})),seed=["chain0","pre0"];
  const full=new Set(seed);
  for(let pass=0;pass<ids.length;pass++)for(let j=0;j<ids.length;j++)if(!full.has(ids[j])&&deps[j].some(i=>full.has(ids[i])))full.add(ids[j]);
  const closed=new Set(seed);
  PP._internal.forwardMarkPrerequisites(list,deps,()=>true,i=>closed.has(ids[i]),p=>closed.add(p.id));
  ok([...closed].join(",")===[...full].join(",")&&closed.has("chain2")&&closed.has("fan")&&!closed.has("sibling")&&!closed.has("clearChild"),"chain, fan-in and unrelated pour match the full traversal");
}
console.log("polygon-pour: ok");
