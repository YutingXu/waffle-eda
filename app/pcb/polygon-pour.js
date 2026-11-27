"use strict";

if (!globalThis.AtriumResolvedLand && typeof require === "function") require("./pcb-appearance.js");
if (!globalThis.AtriumGeometryCurves && typeof require === "function") require("./resolved-geometry-curves.js");
if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");
if (!globalThis.AtriumPCBPours && typeof require === "function") require("./pcb-pours.js");
if (!globalThis.AtriumRuleScopeDemand && typeof require === "function") require("../checks/rule-scope-demand.js");
if (!globalThis.AtriumPourMarker && typeof require === "function") require("./pour-marker.js");
if (!globalThis.AtriumPourMarker && typeof importScripts === "function") importScripts("../pcb/pour-marker.js");

// Altium-style polygon pours. A polygon is an editable board item; pouring it
// produces copper regions in the AtriumPCBPours format (one outline plus its
// holes, float64 contours in Altium units, base64), so the board renderer and
// the Gerber writer treat poured and imported copper identically.
//
// The boolean core is an exact integer overlay: every boundary of every input
// class is split at all crossings, coincident edges are merged, each edge is
// classified by the winding numbers on its two sides, and the edges where the
// pour predicate changes are linked into rings. Coordinates are integers of at
// most 2^24, so every orientation product is exact in a double.
globalThis.AtriumPolygonPour=(()=>{
  const ALTIUM_UNIT=.00000254,TAU=Math.PI*2,LIMIT=1.6e7,SAFE=2e-5,TRACK_CHORD_ERROR=.001;
  const ARC_STAMP="resolved arc centerline";
  const COPPER=/^(?:Top|Bottom|Inner (?:[1-9]\d?|1[01]\d|12[0-6]))$/;
  const now=()=>globalThis.performance?.now?.()??Date.now();
  const own=(o,k)=>o!=null&&Object.prototype.hasOwnProperty.call(o,k);
  const finite=Number.isFinite;

  // ---------------------------------------------------------------- layers
  const appearance=()=>globalThis.AtriumPCBAppearance;
  // Same transform as Atrium.world: rotate about the origin, then translate.
  function world(x,y,frame){
    if(!frame)return [x,y];
    const q=frame.angle?Atrium.rotate([x,y],frame.angle):[x,y];return [q[0]+frame.x,q[1]+frame.y];
  }
  const curves=AtriumGeometryCurves;
  const pathArc=item=>!item.fill&&Atrium.pathArc(item);
  const placedArc=(edge,part)=>part?curves.placeEdge(edge,{at:([x,y])=>world(x,y,part),turn:part.angle||0,mirror:false}):edge;
  function* pathRuns(item,parent,arc,box){
    const edge=arc&&curves.arcEdge(arc),runs=edge?curves.arcRuns(placedArc(edge,parent),TRACK_CHORD_ERROR,box,edge):[item.points||[]];
    for(const points of runs){
      const pts=(parent?points.map(p=>world(p[0],p[1],parent)):points).filter(p=>finite(p?.[0])&&finite(p?.[1]));
      if(pts.length>1)yield pts;
    }
  }

  // -------------------------------------------------------------- settings
  const DEFAULTS=Object.freeze({
    name:"",layer:"Top",net:"",clearance:null,pourOverSameNet:true,removeDeadCopper:true,
    connectStyle:"relief",viaConnectStyle:"direct",reliefConductorWidth:.254,reliefEntries:4,
    reliefAirGap:.254,reliefAngle:90,minPrimLength:.0762,arcApproximation:.0127,
    islandAreaThreshold:0,boardClearance:0,pourIndex:0,cutout:false,shelved:false,
    fillMode:"solid",hatchPitch:.5,hatchWidth:.15,hatchAngle:45
  });
  const SETTINGS=Object.keys(DEFAULTS);
  const STYLES=["relief","direct","none","auto"],FIXED=["relief","direct","none"];
  const outlineOf=p=>Array.isArray(p?.points)?p.points:Array.isArray(p?.outline)?p.outline:[];
  function settings(p){
    const s={id:p.id,kind:"polygon"};
    for(const k of SETTINGS)s[k]=p[k]??DEFAULTS[k];
    s.pourIndex=finite(+p.pourIndex)?+p.pourIndex:finite(+p.priority)?+p.priority:0;
    s.net=typeof s.net==="string"?s.net:"";
    s.connectStyle=STYLES.includes(s.connectStyle)?s.connectStyle:"relief";
    s.viaConnectStyle=STYLES.includes(s.viaConnectStyle)?s.viaConnectStyle:"direct";
    s.connectOverrides={};
    if(p.connectOverrides&&typeof p.connectOverrides==="object")for(const [k,v] of Object.entries(p.connectOverrides))if(FIXED.includes(v))s.connectOverrides[k]=v;
    s.reliefEntries=+s.reliefEntries===2?2:4;
    s.reliefAngle=+s.reliefAngle===45?45:90;
    s.fillMode=s.fillMode==="hatched"||s.fillMode==="outline"?s.fillMode:"solid";
    // Remove Necks When Copper Width Less Than (Altium): mm, absent when off. Only set values enter
    // the settings (and so the pour signature), so pours without it keep their signatures.
    if(finite(+p.neckWidth)&&+p.neckWidth>0)s.neckWidth=Math.min(5,+p.neckWidth);
    s.hatchPitch=finite(+s.hatchPitch)&&+s.hatchPitch>0?+s.hatchPitch:DEFAULTS.hatchPitch;
    s.hatchWidth=finite(+s.hatchWidth)&&+s.hatchWidth>0&&+s.hatchWidth<s.hatchPitch?+s.hatchWidth:Math.min(DEFAULTS.hatchWidth,s.hatchPitch/2);
    s.hatchAngle=+s.hatchAngle===0?0:+s.hatchAngle===90?90:45;
    for(const k of ["reliefConductorWidth","reliefAirGap","minPrimLength","islandAreaThreshold","boardClearance"])
      s[k]=finite(+s[k])&&+s[k]>=0?+s[k]:DEFAULTS[k];
    s.arcApproximation=finite(+s.arcApproximation)&&+s.arcApproximation>0?Math.max(.0005,+s.arcApproximation):DEFAULTS.arcApproximation;
    s.clearance=s.clearance!=null&&finite(+s.clearance)&&+s.clearance>=0?+s.clearance:null;
    if(p.powerPlane)s.powerPlane=p.powerPlane;
    s.outline=outlineOf(p);
    return s;
  }
  // A new polygon item. The outline lives in `points` with `closed:true`, like
  // other editable path items, so moving, bounds, hit testing, vertex handles
  // and the pcb-pours geometry fingerprint all work without special cases.
  function make(outline,fields={}){
    const id=globalThis.Atrium?.id?.()||("p"+Date.now().toString(36)+Math.random().toString(36).slice(2));
    const item={id,kind:"polygon"};
    for(const k of SETTINGS){
      if(k==="clearance"||k==="boardClearance"||k==="cutout"||k==="shelved")continue;
      item[k]=DEFAULTS[k];
    }
    Object.assign(item,fields);
    delete item.outline;
    item.points=(fields.points||outline||fields.outline||[]).map(p=>[+p[0],+p[1]]);
    item.closed=true;
    return item;
  }
  function validate(item){
    const bad=m=>{throw Error("Invalid polygon pour: "+m);};
    if(!item||item.kind!=="polygon")bad("kind");
    const pts=outlineOf(item);
    if(pts.length<3||!pts.every(p=>Array.isArray(p)&&p.length===2&&p.every(v=>finite(v)&&Math.abs(v)<1e8)))bad("outline");
    if(typeof item.layer!=="string"||!(COPPER.test(item.layer)))bad("layer");
    if(item.net!=null&&typeof item.net!=="string")bad("net");
    for(const k of ["clearance","reliefConductorWidth","reliefAirGap","minPrimLength","arcApproximation","islandAreaThreshold","boardClearance"])
      if(item[k]!=null&&(!finite(item[k])||item[k]<0||item[k]>1000))bad(k);
    if(item.connectStyle!=null&&!STYLES.includes(item.connectStyle))bad("connectStyle");
    if(item.viaConnectStyle!=null&&!STYLES.includes(item.viaConnectStyle))bad("viaConnectStyle");
    if(item.powerPlane){
      if(!/^PLANE(?:[1-9]|1[0-6])$/.test(item.powerPlane.sourceLayer)||!/^Inner /.test(item.layer))bad("power plane");
      for(const g of [item.powerPlane.pad,item.powerPlane.via])if(g&&(![g.expansion,g.airGap,g.width].every(n=>finite(n)&&n>=0&&n<=1000)||![2,4].includes(g.entries)))bad("plane relief");
    }
    if(item.connectOverrides!=null){
      const o=item.connectOverrides;
      if(typeof o!=="object"||Array.isArray(o)||Object.keys(o).length>100000||Object.entries(o).some(([k,v])=>!k||k.length>300||!FIXED.includes(v)))bad("connectOverrides");
    }
    if(item.reliefEntries!=null&&![2,4].includes(item.reliefEntries))bad("reliefEntries");
    if(item.reliefAngle!=null&&![45,90].includes(item.reliefAngle))bad("reliefAngle");
    for(const k of ["pourOverSameNet","removeDeadCopper","cutout","shelved"])if(item[k]!=null&&typeof item[k]!=="boolean")bad(k);
    if(item.sourcePourOver!=null&&(![0,1,2].includes(item.sourcePourOver.style)||typeof item.sourcePourOver.sameNet!=="boolean"))bad("sourcePourOver");
    if(item.fillMode!=null&&!["solid","hatched","outline"].includes(item.fillMode))bad("fillMode");
    if(item.neckWidth!=null&&(!finite(item.neckWidth)||item.neckWidth<0||item.neckWidth>5))bad("neckWidth");
    for(const k of ["hatchPitch","hatchWidth"])if(item[k]!=null&&(!finite(item[k])||item[k]<=0||item[k]>100))bad(k);
    if(item.hatchAngle!=null&&![0,45,90].includes(item.hatchAngle))bad("hatchAngle");
    if(item.pourIndex!=null&&!finite(item.pourIndex))bad("pourIndex");
    return item;
  }

  // ------------------------------------------------------- exact overlay
  // PourCore holds the exact integer overlay and the island post-processing.
  // It refers to no outer binding, so the live-pour worker is built from its
  // source text (PourCore.toString()) and runs the same code as the editor.
  function PourCore(){
    const now=()=>globalThis.performance?.now?.()??Date.now();
    const orient=(ax,ay,bx,by,cx,cy)=>(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
    function strictlyOn(ax,ay,bx,by,px,py){
      if((px===ax&&py===ay)||(px===bx&&py===by))return false;
      return (px-ax)*(bx-ax)+(py-ay)*(by-ay)>0&&(px-bx)*(ax-bx)+(py-by)*(ay-by)>0;
    }
    // input: [{cls, ring:int[], sign, tags?}]; tags[i] labels edge i (vertex i
    // to i+1) with the true arc it approximates, or -1.
    function edgeList(input){
      const E={X1:[],Y1:[],X2:[],Y2:[],C:[],S:[],T:[]};
      for(const {cls,ring,sign,tags} of input){
        const n=ring.length>>1;if(n<3)continue;
        for(let i=0;i<n;i++){
          const j=i+1===n?0:i+1,ax=ring[2*i],ay=ring[2*i+1],bx=ring[2*j],by=ring[2*j+1];
          if(ax===bx&&ay===by)continue;
          E.X1.push(ax);E.Y1.push(ay);E.X2.push(bx);E.Y2.push(by);E.C.push(cls);E.S.push(sign);E.T.push(tags?tags[i]:-1);
        }
      }
      return E;
    }
    // Uniform-grid candidate search. Each edge registers in the cells its
    // supercover crosses; only pairs with at least one changed edge are tested.
    function intersections(E,dirty){
      const {X1,Y1,X2,Y2}=E,n=X1.length,found={edge:[],x:[],y:[]};
      if(n<2)return found;
      let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
      for(let i=0;i<n;i++){
        const a=X1[i],b=X2[i],c=Y1[i],d=Y2[i];
        if(a<minX)minX=a;if(b<minX)minX=b;if(a>maxX)maxX=a;if(b>maxX)maxX=b;
        if(c<minY)minY=c;if(d<minY)minY=d;if(c>maxY)maxY=c;if(d>maxY)maxY=d;
      }
      const W=maxX-minX+1,H=maxY-minY+1,lo=Math.max(W/2048,H/2048);
      let cs=Math.max(1,Math.sqrt(W*H/n)*1.5);cs=Math.max(cs,W/2048,H/2048);
      let cols,rows,cells,cellCount,edgeStart;
      function visit(i,fn){
        const x1=X1[i],y1=Y1[i],x2=X2[i],y2=Y2[i];
        const lx=x1<x2?x1:x2,hx=x1<x2?x2:x1,ly=y1<y2?y1:y2,hy=y1<y2?y2:y1;
        const c0=Math.floor((lx-minX)/cs),c1=Math.floor((hx-minX)/cs),r0=Math.floor((ly-minY)/cs),r1=Math.floor((hy-minY)/cs);
        if(c0===c1||r0===r1){for(let r=r0;r<=r1;r++)for(let c=c0;c<=c1;c++)fn(r*cols+c);return;}
        const slope=(y2-y1)/(x2-x1);
        for(let c=c0;c<=c1;c++){
          const xa=Math.max(lx,minX+c*cs),xb=Math.min(hx,minX+(c+1)*cs);
          const ya=y1+(xa-x1)*slope,yb=y1+(xb-x1)*slope;
          const ra=Math.max(r0,Math.floor(((ya<yb?ya:yb)-1-minY)/cs)),rb=Math.min(r1,Math.floor(((ya<yb?yb:ya)+1-minY)/cs));
          for(let r=ra;r<=rb;r++)fn(r*cols+c);
        }
      }
      // The candidate loop costs about the sum over cells of their item count squared. Where
      // short edges crowd a few cells (the fans of detours an offset ring has along fine
      // concave boundaries when the clearance is large), that is quadratic: smaller
      // cells, down to 2048 a side, then a grid of its own in each cell still crowded.
      let work=0;
      for(;;){
        cols=Math.floor(W/cs)+1;rows=Math.floor(H/cs)+1;cells=cols*rows;
        cellCount=new Int32Array(cells+1);edgeStart=new Int32Array(n+1);
        for(let i=0;i<n;i++){let k=0;visit(i,c=>{cellCount[c+1]++;k++;});edgeStart[i+1]=edgeStart[i]+k;}
        work=0;for(let c=1;c<=cells;c++)work+=cellCount[c]*cellCount[c];
        if(work<=48*n+1048576||cs<=lo)break;
        cs=Math.max(lo,cs/4);
      }
      for(let c=0;c<cells;c++)cellCount[c+1]+=cellCount[c];
      const cellItems=new Int32Array(cellCount[cells]),fill=cellCount.slice(0,cells),edgeCells=new Int32Array(edgeStart[n]);
      for(let i=0;i<n;i++){let k=edgeStart[i];visit(i,c=>{cellItems[fill[c]++]=i;edgeCells[k++]=c;});}
      // Sub-grids: a cell of m > 256 items gets ceil(sqrt(m/4)) (at most 256) cells a side; an edge
      // visits the sub-cells its part in the cell crosses (clamped: a superset), as above.
      const subOf=new Int32Array(work>48*n+1048576?cells:0).fill(-1),subs=[];
      function visitSub(i,g,fn){
        const x1=X1[i],y1=Y1[i],x2=X2[i],y2=Y2[i];
        const lx=x1<x2?x1:x2,hx=x1<x2?x2:x1,ly=y1<y2?y1:y2,hy=y1<y2?y2:y1,k=g.k;
        const cl=v=>v<0?0:v>=k?k-1:v;
        const c0=cl(Math.floor((lx-g.x0)/g.s)),c1=cl(Math.floor((hx-g.x0)/g.s)),r0=cl(Math.floor((ly-g.y0)/g.s)),r1=cl(Math.floor((hy-g.y0)/g.s));
        if(c0===c1||r0===r1){for(let r=r0;r<=r1;r++)for(let c=c0;c<=c1;c++)fn(r*k+c);return;}
        const slope=(y2-y1)/(x2-x1);
        for(let c=c0;c<=c1;c++){
          const xa=Math.min(hx,Math.max(lx,g.x0+c*g.s)),xb=Math.max(lx,Math.min(hx,g.x0+(c+1)*g.s));
          const ya=y1+(xa-x1)*slope,yb=y1+(xb-x1)*slope;
          const ra=cl(Math.floor(((ya<yb?ya:yb)-1-g.y0)/g.s)),rb=cl(Math.floor(((ya<yb?yb:ya)+1-g.y0)/g.s));
          for(let r=ra;r<=rb;r++)fn(r*k+c);
        }
      }
      for(let cell=0;cell<subOf.length;cell++){
        const a=cellCount[cell],m=cellCount[cell+1]-a;if(m<=256)continue;
        const k=Math.min(256,Math.ceil(Math.sqrt(m/4))),g={x0:minX+(cell%cols)*cs,y0:minY+Math.floor(cell/cols)*cs,s:cs/k,k,start:new Int32Array(k*k+1),items:null};
        for(let q=a;q<a+m;q++)visitSub(cellItems[q],g,c=>{g.start[c+1]++;});
        for(let c=0;c<k*k;c++)g.start[c+1]+=g.start[c];
        g.items=new Int32Array(g.start[k*k]);const f=g.start.slice(0,k*k);
        for(let q=a;q<a+m;q++){const j=cellItems[q];visitSub(j,g,c=>{g.items[f[c]++]=j;});}
        subOf[cell]=subs.length;subs.push(g);
      }
      const mark=new Int32Array(n).fill(-1);
      const add=(e,x,y)=>{found.edge.push(e);found.x.push(x);found.y.push(y);};
      for(let i=0;i<n;i++){
        if(!dirty[i])continue;
        const ax=X1[i],ay=Y1[i],bx=X2[i],by=Y2[i];
        const alx=ax<bx?ax:bx,ahx=ax<bx?bx:ax,aly=ay<by?ay:by,ahy=ay<by?by:ay;
        const test=j=>{
            if(j===i||mark[j]===i)return;mark[j]=i;
            if(dirty[j]&&j<i)return;
            const cx=X1[j],cy=Y1[j],dx=X2[j],dy=Y2[j];
            if((cx<dx?dx:cx)<alx||(cx<dx?cx:dx)>ahx||(cy<dy?dy:cy)<aly||(cy<dy?cy:dy)>ahy)return;
            const d1=orient(ax,ay,bx,by,cx,cy),d2=orient(ax,ay,bx,by,dx,dy);
            if((d1>0&&d2>0)||(d1<0&&d2<0))return;
            const d3=orient(cx,cy,dx,dy,ax,ay),d4=orient(cx,cy,dx,dy,bx,by);
            if((d3>0&&d4>0)||(d3<0&&d4<0))return;
            if(d1!==0&&d2!==0&&d3!==0&&d4!==0){
              const t=d3/(d3-d4),px=Math.round(ax+t*(bx-ax)),py=Math.round(ay+t*(by-ay));
              add(i,px,py);add(j,px,py);return;
            }
            if(d1===0&&strictlyOn(ax,ay,bx,by,cx,cy))add(i,cx,cy);
            if(d2===0&&strictlyOn(ax,ay,bx,by,dx,dy))add(i,dx,dy);
            if(d3===0&&strictlyOn(cx,cy,dx,dy,ax,ay))add(j,ax,ay);
            if(d4===0&&strictlyOn(cx,cy,dx,dy,bx,by))add(j,bx,by);
        };
        for(let k=edgeStart[i];k<edgeStart[i+1];k++){
          const cell=edgeCells[k],sb=subs.length?subOf[cell]:-1;
          if(sb<0)for(let q=cellCount[cell];q<cellCount[cell+1];q++)test(cellItems[q]);
          else{const g=subs[sb];visitSub(i,g,c=>{for(let q=g.start[c];q<g.start[c+1];q++)test(g.items[q]);});}
        }
      }
      return found;
    }
    // Split at every crossing and T-junction, at the crossing rounded to the
    // grid (under one unit away). When that leaves the arrangement planar (the
    // second pass finds nothing) it is done: the usual case. Otherwise the
    // rounding made new crossings, and rounding those again could move copper
    // by more than a grid unit or never settle (near-parallel edges), so the
    // input edges are snap rounded instead (snapRound).
    function planarize(E,stats){
      const E0=E;let dirty=new Uint8Array(E.X1.length).fill(1);
      for(let pass=0;pass<2;pass++){
        const found=intersections(E,dirty);
        stats.passes=pass+1;
        if(!found.edge.length)return E;
        if(pass)return snapRound(E0,stats);
        const at=new Map();
        for(let k=0;k<found.edge.length;k++){
          const e=found.edge[k];let list=at.get(e);if(!list)at.set(e,list=[]);list.push(found.x[k],found.y[k]);
        }
        const R={X1:[],Y1:[],X2:[],Y2:[],C:[],S:[],T:[]},nd=[];
        const push=(ax,ay,bx,by,c,s,g,d)=>{R.X1.push(ax);R.Y1.push(ay);R.X2.push(bx);R.Y2.push(by);R.C.push(c);R.S.push(s);R.T.push(g);nd.push(d);};
        for(let i=0;i<E.X1.length;i++){
          const ax=E.X1[i],ay=E.Y1[i],bx=E.X2[i],by=E.Y2[i],c=E.C[i],s=E.S[i],g=E.T[i],list=at.get(i);
          if(!list){push(ax,ay,bx,by,c,s,g,0);continue;}
          const vx=bx-ax,vy=by-ay,len=vx*vx+vy*vy,pts=[];
          for(let k=0;k<list.length;k+=2){
            const t=(list[k]-ax)*vx+(list[k+1]-ay)*vy;
            if(t>0&&t<len)pts.push([t,list[k],list[k+1]]);
          }
          pts.sort((p,q)=>p[0]-q[0]);
          let px=ax,py=ay;
          for(const [,x,y] of pts){
            if((x===px&&y===py)||(x===bx&&y===by))continue;
            push(px,py,x,y,c,s,g,1);px=x;py=y;
          }
          push(px,py,bx,by,c,s,g,1);
        }
        E=R;dirty=Uint8Array.from(nd);
      }
    }
    // Snap rounding (Hobby), for the inputs whose rounded crossings make new ones. Starting
    // again from the input edges: every endpoint and every crossing rounded to the grid is a hot
    // pixel, and each edge is routed through the centre of every hot pixel it meets (half-open
    // unit squares, so they partition the plane), in the order it meets them. Every rounded edge stays within half a diagonal
    // of a grid unit of its input edge, and rounded edges meet only at shared vertices; each
    // round is checked, and rounded again if a crossing remains. stats.passes is 12 plus the
    // rounds checked (13..16); unresolved only when 4 rounds leave a crossing.
    function snapRound(E,stats){
      const OFF=33554432,SPAN=67108864;
      for(let round=0;round<4;round++){
        const n=E.X1.length,found=intersections(E,new Uint8Array(n).fill(1));
        if(round){stats.passes=12+round;if(!found.edge.length)return E;}
        const {X1,Y1,X2,Y2}=E,hmap=new Map(),HX=[],HY=[];
        const hot=(x,y)=>{const k=(x+OFF)*SPAN+(y+OFF);if(!hmap.has(k)){hmap.set(k,HX.length);HX.push(x);HY.push(y);}};
        for(let i=0;i<n;i++){hot(X1[i],Y1[i]);hot(X2[i],Y2[i]);}
        for(let k=0;k<found.x.length;k++)hot(found.x[k],found.y[k]);
        const h=HX.length;
        let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
        for(let q=0;q<h;q++){const x=HX[q],y=HY[q];if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;}
        const W=maxX-minX+1,H=maxY-minY+1;
        let cs=Math.max(1,Math.sqrt(W*H/h)*1.5);cs=Math.max(cs,W/2048,H/2048);
        const cols=Math.floor(W/cs)+1,rows=Math.floor(H/cs)+1,cells=cols*rows;
        const colOf=x=>{const c=Math.floor((x-minX)/cs);return c<0?0:c>=cols?cols-1:c;},rowOf=y=>{const r=Math.floor((y-minY)/cs);return r<0?0:r>=rows?rows-1:r;};
        const start=new Int32Array(cells+1);
        for(let q=0;q<h;q++)start[rowOf(HY[q])*cols+colOf(HX[q])+1]++;
        for(let c=0;c<cells;c++)start[c+1]+=start[c];
        const items=new Int32Array(h),fill=start.slice(0,cells);
        for(let q=0;q<h;q++)items[fill[rowOf(HY[q])*cols+colOf(HX[q])]++]=q;
        const mark=new Int32Array(h).fill(-1),R={X1:[],Y1:[],X2:[],Y2:[],C:[],S:[],T:[]},pts=[];
        for(let i=0;i<n;i++){
          const ax=X1[i],ay=Y1[i],bx=X2[i],by=Y2[i],vx=bx-ax,vy=by-ay;
          const lx=ax<bx?ax:bx,hx=ax<bx?bx:ax,ly=ay<by?ay:by,hy=ay<by?by:ay;
          pts.length=0;
          for(let c=colOf(lx-1),c1=colOf(hx+1);c<=c1;c++){
            let ra,rb;
            if(vx===0){ra=rowOf(ly-1);rb=rowOf(hy+1);}
            else{
              const xa=Math.max(lx,minX+c*cs-1),xb=Math.min(hx,minX+(c+1)*cs+1);
              if(xa>xb)continue;
              const ya=ay+(xa-ax)*vy/vx,yb=ay+(xb-ax)*vy/vx;
              ra=rowOf((ya<yb?ya:yb)-1);rb=rowOf((ya<yb?yb:ya)+1);
            }
            for(let r=ra;r<=rb;r++){
              const cell=r*cols+c;
              for(let k=start[cell];k<start[cell+1];k++){
                const q=items[k];if(mark[q]===i)continue;mark[q]=i;
                const px=HX[q],py=HY[q];
                if((px===ax&&py===ay)||(px===bx&&py===by))continue;
                // The half-open pixel [L, L+1) x [B, B+1): the edge enters its interior
                // (separating axes, strict), or passes through its corner (L, B). Ends are
                // integers, so it can touch no other boundary point without entering.
                const L=px-.5,B=py-.5;
                if(hx<L||lx>L+1||hy<B||ly>B+1)continue;
                const s1=orient(ax,ay,bx,by,L,B),s2=orient(ax,ay,bx,by,L+1,B),s3=orient(ax,ay,bx,by,L+1,B+1),s4=orient(ax,ay,bx,by,L,B+1);
                const open=lx<L+1&&hx>L&&ly<B+1&&hy>B&&(s1<0||s2<0||s3<0||s4<0)&&(s1>0||s2>0||s3>0||s4>0);
                if(!open&&!(s1===0&&lx<=L&&ly<=B))continue;
                pts.push([(px-ax)*vx+(py-ay)*vy,px,py]);
              }
            }
          }
          pts.sort((p,q)=>p[0]-q[0]||p[1]-q[1]||p[2]-q[2]);
          let px=ax,py=ay;
          const c=E.C[i],s=E.S[i],g=E.T[i];
          for(const [,x,y] of pts){if(x===px&&y===py)continue;R.X1.push(px);R.Y1.push(py);R.X2.push(x);R.Y2.push(y);R.C.push(c);R.S.push(s);R.T.push(g);px=x;py=y;}
          if(px!==bx||py!==by){R.X1.push(px);R.Y1.push(py);R.X2.push(bx);R.Y2.push(by);R.C.push(c);R.S.push(s);R.T.push(g);}
        }
        E=R;
      }
      stats.passes=16;
      if(intersections(E,new Uint8Array(E.X1.length).fill(1)).edge.length)stats.unresolved=true;
      return E;
    }
    // Coincident edges become one undirected edge carrying a winding change per
    // class. Its orientation is normalized so the start is the lower x (then y).
    // Vertices get dense ids, so edge keys are numbers (no string building).
    function merge(E,K){
      const OFF=33554432,SPAN=67108864,vmap=new Map(),VX=[],VY=[];
      const vid=(x,y)=>{const k=(x+OFF)*SPAN+(y+OFF);let v=vmap.get(k);if(v===undefined){v=VX.length;vmap.set(k,v);VX.push(x);VY.push(y);}return v;};
      const emap=new Map(),A=[],B=[],T=[],D=[];
      for(let i=0;i<E.X1.length;i++){
        let ax=E.X1[i],ay=E.Y1[i],bx=E.X2[i],by=E.Y2[i],s=E.S[i];
        if(ax>bx||(ax===bx&&ay>by)){let t=ax;ax=bx;bx=t;t=ay;ay=by;by=t;s=-s;}
        const a=vid(ax,ay),b=vid(bx,by),key=a*SPAN+b;
        let k=emap.get(key);
        if(k===undefined){k=A.length;emap.set(key,k);A.push(a);B.push(b);T.push(E.T[i]);for(let c=0;c<K;c++)D.push(0);}
        else if(T[k]!==E.T[i])T[k]=-1;
        D[k*K+E.C[i]]+=s;
      }
      let m=0;const keep=[];
      for(let k=0;k<A.length;k++){let any=false;for(let c=0;c<K;c++)if(D[k*K+c]){any=true;break;}if(any){keep.push(k);m++;}}
      const out={X1:new Int32Array(m),Y1:new Int32Array(m),X2:new Int32Array(m),Y2:new Int32Array(m),A:new Int32Array(m),B:new Int32Array(m),T:new Int32Array(m),D:new Int32Array(m*K),K,
        VX:Int32Array.from(VX),VY:Int32Array.from(VY)};
      keep.forEach((k,e)=>{
        const a=A[k],b=B[k];out.A[e]=a;out.B[e]=b;out.X1[e]=VX[a];out.Y1[e]=VY[a];out.X2[e]=VX[b];out.Y2[e]=VY[b];out.T[e]=T[k];
        for(let c=0;c<K;c++)out.D[e*K+c]=D[k*K+c];
      });
      return out;
    }
    // Winding numbers by an upward ray from an edge midpoint, using doubled
    // coordinates so the midpoint stays integral. Column buckets bound the scan.
    function rayCaster(M){
      const {X1,Y1,X2,Y2,D,K}=M,m=X1.length;
      let minX=Infinity,maxX=-Infinity,nonVertical=0;
      for(let e=0;e<m;e++){if(X1[e]<minX)minX=X1[e];if(X2[e]>maxX)maxX=X2[e];if(X1[e]!==X2[e])nonVertical++;}
      const cols=Math.max(1,Math.min(8192,Math.ceil(nonVertical/4))),bw=Math.max(1,(maxX-minX+1)/cols);
      const colOf=x=>{const c=Math.floor((x-minX)/bw);return c<0?0:c>=cols?cols-1:c;};
      const start=new Int32Array(cols+1);
      for(let e=0;e<m;e++)if(X1[e]!==X2[e])for(let c=colOf(X1[e]),z=colOf(X2[e]-.5);c<=z;c++)start[c+1]++;
      for(let c=0;c<cols;c++)start[c+1]+=start[c];
      const items=new Int32Array(start[cols]),fill=start.slice(0,cols);
      for(let e=0;e<m;e++)if(X1[e]!==X2[e])for(let c=colOf(X1[e]),z=colOf(X2[e]-.5);c<=z;c++)items[fill[c]++]=e;
      // W receives the winding just above edge e's midpoint, ignoring e.
      return (e,W)=>{
        const mx=X1[e]+X2[e],my=Y1[e]+Y2[e],col=colOf(mx/2);
        W.fill(0);
        for(let q=start[col];q<start[col+1];q++){
          const f=items[q];if(f===e)continue;
          const fx1=X1[f],fx2=X2[f];
          if(!(2*fx1<=mx&&mx<2*fx2))continue;
          const fy1=Y1[f];
          if((fx2-fx1)*(my-2*fy1)-(Y2[f]-fy1)*(mx-2*fx1)<0){const o=f*K;for(let c=0;c<K;c++)W[c]-=D[o+c];}
        }
      };
    }
    function emit(out,M,e,forward){
      if(forward){out.X1.push(M.X1[e]);out.Y1.push(M.Y1[e]);out.X2.push(M.X2[e]);out.Y2.push(M.Y2[e]);}
      else{out.X1.push(M.X2[e]);out.Y1.push(M.Y2[e]);out.X2.push(M.X1[e]);out.Y2.push(M.Y1[e]);}
      out.T.push(M.T[e]);
    }
    // Reference classifier: one ray per edge. Used when the arrangement is not
    // planar (unresolved snapping) or the face walk is inconsistent.
    function classifyRays(M,inside){
      const {X1,X2,D,K}=M,m=X1.length,out={X1:[],Y1:[],X2:[],Y2:[],T:[]};
      if(!m)return out;
      const ray=rayCaster(M),W=new Int32Array(K),L=new Int32Array(K),R=new Int32Array(K);
      for(let e=0;e<m;e++){
        ray(e,W);const o=e*K;
        if(X1[e]===X2[e]){for(let c=0;c<K;c++){R[c]=W[c];L[c]=W[c]+D[o+c];}}
        else{for(let c=0;c<K;c++){L[c]=W[c];R[c]=W[c]-D[o+c];}}
        const fl=inside(L),fr=inside(R);
        if(fl!==fr)emit(out,M,e,fl);
      }
      return out;
    }
    // Face walk: half-edge 2e runs A->B (the normalized direction), 2e+1 runs
    // back. Around each vertex the outgoing half-edges are sorted
    // counter-clockwise (exact integer comparisons); next(h) is the outgoing
    // edge just clockwise of h's twin, so each cycle bounds one face on its
    // left. Crossing edge e from its left face to its right face changes the
    // winding by -D[e]. One ray per connected component fixes the absolute
    // winding; every other face follows by propagation, so the cost is linear
    // in the edges instead of one ray scan per edge.
    function classify(M,inside,stats={}){
      const {X1,Y1,X2,Y2,A,B,D,K,VX}=M,m=X1.length,nv=VX.length,out={X1:[],Y1:[],X2:[],Y2:[],T:[]};
      if(!m)return out;
      if(stats.unresolved)return classifyRays(M,inside);
      const start=new Int32Array(nv+1);
      for(let e=0;e<m;e++){start[A[e]+1]++;start[B[e]+1]++;}
      for(let v=0;v<nv;v++)start[v+1]+=start[v];
      const list=new Int32Array(2*m),fill=start.slice(0,nv);
      for(let e=0;e<m;e++){list[fill[A[e]]++]=2*e;list[fill[B[e]]++]=2*e+1;}
      const hx=h=>{const e=h>>1;return h&1?X1[e]-X2[e]:X2[e]-X1[e];},hy=h=>{const e=h>>1;return h&1?Y1[e]-Y2[e]:Y2[e]-Y1[e];};
      const cmp=(a,b)=>{
        const ax=hx(a),ay=hy(a),bx=hx(b),by=hy(b),ha=ay>0||(ay===0&&ax>0)?0:1,hb=by>0||(by===0&&bx>0)?0:1;
        if(ha!==hb)return ha-hb;const cr=ax*by-ay*bx;return cr>0?-1:cr<0?1:0;
      };
      const pos=new Int32Array(2*m);
      for(let v=0;v<nv;v++){
        const s=start[v],t=start[v+1];
        if(t-s>2){const sorted=Array.from(list.subarray(s,t)).sort(cmp);for(let j=0;j<sorted.length;j++)list[s+j]=sorted[j];}
        for(let j=s;j<t;j++)pos[list[j]]=j-s;
      }
      const nxt=new Int32Array(2*m);
      for(let h=0;h<2*m;h++){
        const t=h^1,e=t>>1,v=t&1?B[e]:A[e],s=start[v],d=start[v+1]-s;
        nxt[h]=list[s+(pos[t]+d-1)%d];
      }
      const face=new Int32Array(2*m).fill(-1),first=[];
      for(let h=0;h<2*m;h++){
        if(face[h]>=0)continue;
        const f=first.length;first.push(h);
        let g=h,guard=0;
        do{face[g]=f;g=nxt[g];if(++guard>2*m)return classifyRays(M,inside);}while(g!==h);
      }
      const F=first.length,FW=new Int32Array(F*K),known=new Uint8Array(F),queue=new Int32Array(F),W=new Int32Array(K);
      let ray=null,rays=0;
      for(let f0=0;f0<F;f0++){
        if(known[f0])continue;
        const h0=first[f0],e0=h0>>1,o0=e0*K;
        if(!ray)ray=rayCaster(M);
        ray(e0,W);rays++;
        const vertical=X1[e0]===X2[e0];
        for(let c=0;c<K;c++){const L=vertical?W[c]+D[o0+c]:W[c];FW[f0*K+c]=h0&1?L-D[o0+c]:L;}
        known[f0]=1;let qh=0,qt=0;queue[qt++]=f0;
        while(qh<qt){
          const g=queue[qh++],gh=first[g];let h=gh;
          do{
            const e=h>>1,g2=face[h^1],o=e*K,sg=h&1?1:-1;
            if(!known[g2]){for(let c=0;c<K;c++)FW[g2*K+c]=FW[g*K+c]+sg*D[o+c];known[g2]=1;queue[qt++]=g2;}
            else for(let c=0;c<K;c++)if(FW[g2*K+c]!==FW[g*K+c]+sg*D[o+c]){stats.faceFallback=true;return classifyRays(M,inside);}
            h=nxt[h];
          }while(h!==gh);
        }
      }
      stats.faces=F;stats.rays=rays;
      const fin=new Uint8Array(F);
      for(let f=0;f<F;f++){for(let c=0;c<K;c++)W[c]=FW[f*K+c];fin[f]=inside(W)?1:0;}
      for(let e=0;e<m;e++){const fl=fin[face[2*e]],fr=fin[face[2*e+1]];if(fl!==fr)emit(out,M,e,fl===1);}
      return out;
    }
    // Link directed boundary edges (interior on the left) into rings. Where
    // rings touch at a vertex, take the first outgoing edge clockwise from the
    // reverse of the incoming edge (the sharpest left turn): the copper on the
    // incoming edge's left lies just clockwise of that reverse, so each ring
    // hugs its own face. Groups order the half-planes; within one, an edge
    // counter-clockwise of the best so far is less far round.
    function trace(O,stats){
      const {X1,Y1,X2,Y2,T}=O,m=X1.length,OFF=33554432,SPAN=67108864;
      const key=(x,y)=>(x+OFF)*SPAN+(y+OFF);
      const head=new Map(),next=new Int32Array(m).fill(-1),used=new Uint8Array(m),rings=[];
      for(let e=0;e<m;e++){const k=key(X1[e],Y1[e]),h=head.get(k);if(h!==undefined)next[e]=h;head.set(k,e);}
      const group=(rx,ry,ox,oy)=>{const cr=rx*oy-ry*ox;if(cr<0)return 0;if(cr===0)return rx*ox+ry*oy<0?1:3;return 2;};
      for(let s=0;s<m;s++){
        if(used[s])continue;
        const ring=[],tags=[];let e=s,ok=true,guard=0;
        for(;;){
          used[e]=1;ring.push(X1[e],Y1[e]);tags.push(T?T[e]:-1);
          const vx=X2[e],vy=Y2[e],first=head.get(key(vx,vy));
          if(first===undefined){ok=false;break;}
          let best=first;
          if(next[first]!==-1){
            const rx=X1[e]-vx,ry=Y1[e]-vy;
            let bg=9,bx=0,by=0;
            for(let f=first;f!==-1;f=next[f]){
              const ox=X2[f]-vx,oy=Y2[f]-vy,g=group(rx,ry,ox,oy);
              if(g<bg||(g===bg&&(g===0||g===2)&&bx*oy-by*ox>0)){bg=g;bx=ox;by=oy;best=f;}
            }
          }
          if(best===s)break;
          if(used[best]||++guard>m){ok=false;break;}
          e=best;
        }
        if(!ok){stats.brokenRings=(stats.brokenRings||0)+1;continue;}
        const clean=simplify(ring,tags);
        if(clean)rings.push(clean);
      }
      return rings;
    }
    // Drop repeated and collinear vertices. Edge tags follow: a merged edge
    // keeps a tag only when both halves carry it.
    function simplify(ring,tags){
      let pts=ring,tg=tags,changed=true;
      while(changed&&pts.length>=6){
        changed=false;const n=pts.length>>1,out=[],ot=[];let lead=null;
        for(let i=0;i<n;i++){
          const p=(i+n-1)%n,q=(i+1)%n,ax=pts[2*p],ay=pts[2*p+1],bx=pts[2*i],by=pts[2*i+1],cx=pts[2*q],cy=pts[2*q+1];
          if((ax===bx&&ay===by)||(orient(ax,ay,bx,by,cx,cy)===0&&(bx-ax)*(cx-bx)+(by-ay)*(cy-by)>=0)){
            changed=true;
            if(ot.length)ot[ot.length-1]=ot[ot.length-1]===tg[i]?tg[i]:-1;else lead=lead===null?tg[i]:lead===tg[i]?lead:-1;
            continue;
          }
          out.push(bx,by);ot.push(tg[i]);
        }
        if(lead!==null&&ot.length)ot[ot.length-1]=ot[ot.length-1]===lead?lead:-1;
        pts=out;tg=ot;
      }
      return pts.length>=6&&area2(pts)!==0?{ring:pts,tags:tg}:null;
    }
    function area2(r){
      let s=0;const n=r.length>>1;
      for(let i=0,j=n-1;i<n;j=i++)s+=r[2*j]*r[2*i+1]-r[2*i]*r[2*j+1];
      return s;
    }
    function boxOf(r){
      let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity;
      for(let i=0;i<r.length;i+=2){const x=r[i],y=r[i+1];if(x<a)a=x;if(x>c)c=x;if(y<b)b=y;if(y>d)d=y;}
      return [a,b,c,d];
    }
    // 1 inside, -1 outside, 0 on the boundary. Exact for integer input.
    function pointInRing(px,py,r){
      let inside=false;const n=r.length>>1;
      for(let i=0,j=n-1;i<n;j=i++){
        const x1=r[2*j],y1=r[2*j+1],x2=r[2*i],y2=r[2*i+1];
        const cr=(x2-x1)*(py-y1)-(y2-y1)*(px-x1);
        if(cr===0&&px>=Math.min(x1,x2)&&px<=Math.max(x1,x2)&&py>=Math.min(y1,y2)&&py<=Math.max(y1,y2))return 0;
        if((y1>py)!==(y2>py)&&(cr>0)===(y2>y1))inside=!inside;
      }
      return inside?1:-1;
    }
    const contains=(a,b)=>a[0]<=b[0]&&a[1]<=b[1]&&a[2]>=b[2]&&a[3]>=b[3];
    function islands(rings){
      const outers=[],holes=[];
      for(const {ring:r,tags} of rings){const a=area2(r)/2,e={ring:r,tags,area:Math.abs(a),box:boxOf(r)};(a>0?outers:holes).push(e);}
      for(const o of outers)o.holes=[];
      for(const h of holes){
        let best=null;
        for(const o of outers){
          if(o.area<=h.area||!contains(o.box,h.box)||(best&&o.area>=best.area))continue;
          let side=0;
          for(let i=0;i<h.ring.length&&!side;i+=2)side=pointInRing(h.ring[i],h.ring[i+1],o.ring);
          if(side>=0)best=o;
        }
        if(best)best.holes.push(h);
      }
      return outers;
    }
    // Generic multi-class boolean. `input` holds {cls, ring:int[], sign, tags?};
    // the predicate receives the winding number of every class.
    function overlayRings(input,K,inside,stats){
      let t=now();const E=planarize(edgeList(input),stats);
      stats.edges=E.X1.length;stats.tPlanar=now()-t;t=now();
      const M=merge(E,K);stats.merged=M.X1.length;stats.tMerge=now()-t;t=now();
      const C=classify(M,inside,stats);stats.tClassify=now()-t;t=now();
      const rings=trace(C,stats);stats.tTrace=now()-t;t=now();
      return rings;
    }
    function overlayInt(input,K,inside,stats={}){
      const rings=overlayRings(input,K,inside,stats),t=now();
      const out=islands(rings);stats.tIslands=now()-t;
      return out;
    }
    function segmentsTouch(ax,ay,bx,by,cx,cy,dx,dy){
      const d1=orient(ax,ay,bx,by,cx,cy),d2=orient(ax,ay,bx,by,dx,dy),d3=orient(cx,cy,dx,dy,ax,ay),d4=orient(cx,cy,dx,dy,bx,by);
      if(((d1>0&&d2<0)||(d1<0&&d2>0))&&((d3>0&&d4<0)||(d3<0&&d4>0)))return true;
      const on=(px,py,qx,qy,rx,ry)=>rx>=Math.min(px,qx)&&rx<=Math.max(px,qx)&&ry>=Math.min(py,qy)&&ry<=Math.max(py,qy);
      return (d1===0&&on(ax,ay,bx,by,cx,cy))||(d2===0&&on(ax,ay,bx,by,dx,dy))||(d3===0&&on(cx,cy,dx,dy,ax,ay))||(d4===0&&on(cx,cy,dx,dy,bx,by));
    }
    function inIsland(x,y,isl){
      const o=pointInRing(x,y,isl.ring);if(o<0)return false;if(o===0)return true;
      for(const h of isl.holes)if(x>=h.box[0]&&x<=h.box[2]&&y>=h.box[1]&&y<=h.box[3]&&pointInRing(x,y,h.ring)>0)return false;
      return true;
    }
    function touches(a,isl){
      const b=a.box,ib=isl.box;
      if(b[0]>ib[2]||b[2]<ib[0]||b[1]>ib[3]||b[3]<ib[1])return false;
      const r=a.ring,n=r.length>>1;
      for(let i=0;i<n;i++)if(inIsland(r[2*i],r[2*i+1],isl))return true;
      if(pointInRing(isl.ring[0],isl.ring[1],r)>=0)return true;
      for(const ring of [isl.ring,...isl.holes.map(h=>h.ring)]){
        const m=ring.length>>1;
        for(let i=0,j=m-1;i<m;j=i++){
          const x1=ring[2*j],y1=ring[2*j+1],x2=ring[2*i],y2=ring[2*i+1];
          if(Math.max(x1,x2)<b[0]||Math.min(x1,x2)>b[2]||Math.max(y1,y2)<b[1]||Math.min(y1,y2)>b[3])continue;
          for(let k=0,l=n-1;k<n;l=k++)if(segmentsTouch(x1,y1,x2,y2,r[2*l],r[2*l+1],r[2*k],r[2*k+1]))return true;
        }
      }
      return false;
    }
    // The pour predicate. Classes: 0 polygon, 1 board, 2 obstacle, 3 relief
    // annulus, 4 spoke, 5 relief pad, 6.. earlier pours.
    function pourInside(K,hasBoard){
      return w=>{
        if(w[0]===0||(hasBoard&&w[1]===0)||w[2]>0)return false;
        for(let c=6;c<K;c++)if(w[c]>0)return false;
        return w[3]===0||(w[4]!==0&&w[5]===0);
      };
    }
    // solve(task): the transferable part of a pour. task = {shapes:[{cls,
    // ring:Int32Array, sign, tags}], K, hasBoard, anchors:[Int32Array],
    // removeDead, minArea, minSize}. Returns the kept islands (integer rings,
    // edge tags and the indices of the anchors each touches) and stats.
    function solve(task){
      if(task.packed)task=unpack(task);
      // The Rust/WebAssembly port of this core (engine-core.js; absent in the pour worker) gives identical islands.
      const fast=globalThis.AtriumEngine?.pourSolve?.(task);if(fast)return fast;
      const stats={},t0=now();
      const found=overlayInt(task.shapes,task.K,pourInside(task.K,task.hasBoard),stats);
      return keep(shapeIslands(found,task,stats),task,stats,t0);
    }
    // solve() in steps, for a solve on the editor's thread (no worker): yields "atomic" before the
    // Rust/WebAssembly call (one step that cannot be cut), else once after each phase of the JS core.
    // The result is solve()'s.
    function* solveSteps(task){
      if(task.packed)task=unpack(task);
      if(globalThis.AtriumEngine?.pourSolve){yield "atomic";const fast=globalThis.AtriumEngine.pourSolve(task);if(fast)return fast;}
      const stats={},t0=now(),K=task.K,inside=pourInside(K,task.hasBoard);
      let t=now();const E=planarize(edgeList(task.shapes),stats);stats.edges=E.X1.length;stats.tPlanar=now()-t;yield;
      t=now();const M=merge(E,K);stats.merged=M.X1.length;stats.tMerge=now()-t;yield;
      t=now();const C=classify(M,inside,stats);stats.tClassify=now()-t;yield;
      t=now();const rings=trace(C,stats);stats.tTrace=now()-t;t=now();
      const found=islands(rings);stats.tIslands=now()-t;yield;
      const shaped=shapeIslands(found,task,stats);if(task.morph)yield;
      return keep(shaped,task,stats,t0);
    }
    // ---- Remove Necks and Outlines Only (task.morph, the last stage of a pour; engine/src/pour.rs
    // ports it line for line). The copper P is changed by integer booleans only, so every core and
    // the pooled run give the same rings. T (task.morph.t) is a convex polygon, symmetric about the
    // origin, whose narrowest width is the neck width (Outlines Only: twice the band width).
    //   Erosion E = P ⊖ T = P less (P's complement ⊕ T). Near an island's outer ring that is the
    //     union of capsules (each edge swept by T: the hull of T at both ends); a hole H is a region
    //     the copper never covers and H ⊕ T = H ∪ (∂H ⊕ T), one shape: its convolution cycle with T
    //     (Guibas, Ramshaw and Stolfi: each edge moved by T's vertex farthest along its outward normal,
    //     T's vertices walked between edges; the points of H ⊕ T are where it winds positively). A
    //     hole costs about its edges plus T's vertices instead of a capsule per edge.
    //   mode 1 (Remove Necks): the opening E ⊕ U ∩ P, plus `keep`. U is T grown by 3 grid units (same
    //     vertex count), so where the opening gives back an edge of P it reaches past it and P's own
    //     edge (and its arc tag) is the boundary. Each island S of E dilates on its own: S ⊕ U is its
    //     outer ring's convolution cycle with U less, inside each hole H' of S, what lies farther than
    //     U from H' (H' less the capsules of its edges). A hole of E that is exactly one convex hole of
    //     P grown by T (it holds that hole's first vertex and no other, and has its area) is skipped:
    //     closing a convex hole gives it back, so the opening there is P. Opening a half plane gives it
    //     back exactly; only necks and peninsulas narrower than T and the tips of convex corners
    //     (rounded to T) go. The result lies inside P, so it never comes nearer anything P clears;
    //     `keep` (the relief spokes, counter-clockwise) is never removed, so thermals stay.
    //   mode 2 (Outlines Only): P less E, plus `keep`: a band of T's half width inside every boundary.
    // The islands that come out go through keep() (dead copper, area, size) like any others.
    // morph: {mode, t: Int32Array (CCW template), u: Int32Array (mode 1), keep: [Int32Array]}.
    // The convolution cycle of a ring (interior on its left; `reverse` walks it backwards) with T:
    // each edge moved by the vertex of T farthest along its outward (right-hand) normal (ties: the
    // lowest index), T's vertices walked between edges (forward at a left turn, backward at a right).
    function convolution(r,T,reverse){
      const n=r.length>>1,k=T.length>>1,X=new Float64Array(n),Y=new Float64Array(n);
      for(let i=0;i<n;i++){const j=reverse?n-1-i:i;X[i]=r[2*j];Y[i]=r[2*j+1];}
      const s=new Int32Array(n);
      for(let i=0;i<n;i++){
        const q=i+1===n?0:i+1,nx=Y[q]-Y[i],ny=X[i]-X[q];let best=0,bd=-Infinity;
        for(let j=0;j<k;j++){const d=T[2*j]*nx+T[2*j+1]*ny;if(d>bd){bd=d;best=j;}}
        s[i]=best;
      }
      const out=[];
      for(let i=0;i<n;i++){
        const q=i+1===n?0:i+1,w=q+1===n?0:q+1,a=s[i],b=s[q];
        out.push(X[i]+T[2*a],Y[i]+T[2*a+1],X[q]+T[2*a],Y[q]+T[2*a+1]);
        if(a===b)continue;
        const ex=X[q]-X[i],ey=Y[q]-Y[i],fx=X[w]-X[q],fy=Y[w]-Y[q],c=ex*fy-ey*fx;
        if(c>0||(c===0&&ex*fx+ey*fy<0)){for(let j=(a+1)%k;j!==b;j=(j+1)%k)out.push(X[q]+T[2*j],Y[q]+T[2*j+1]);}
        else{for(let j=(a+k-1)%k;j!==b;j=(j+k-1)%k)out.push(X[q]+T[2*j],Y[q]+T[2*j+1]);}
      }
      return Int32Array.from(out);
    }
    const ringsOf=found=>{const out=[];for(const isl of found){out.push(isl.ring);for(const h of isl.holes)out.push(h.ring);}return out;};
    function convexRing(r){
      const n=r.length>>1;if(n<3)return false;let sg=0;
      for(let i=0;i<n;i++){const p=i?i-1:n-1,q=i+1===n?0:i+1,o=orient(r[2*p],r[2*p+1],r[2*i],r[2*i+1],r[2*q],r[2*q+1]);if(o===0)return false;const t=o>0?1:-1;if(sg&&t!==sg)return false;sg=t;}
      return true;
    }
    // The complement of a ring's region inside a box around it, as one ring: the box (counter-
    // clockwise), a slit from its lower left corner to the ring's lowest vertex (x, then y: every slit
    // point but that vertex lies left of the ring), and the ring as given (interior of the complement
    // on its left). Its convolution with T dilates that complement; the slit only reaches into the
    // region where the ring's own boundary does.
    function boxSlit(r,margin){
      const n=r.length>>1,b=boxOf(r);let v=0;
      for(let i=1;i<n;i++)if(r[2*i]<r[2*v]||(r[2*i]===r[2*v]&&r[2*i+1]<r[2*v+1]))v=i;
      const x0=b[0]-margin,y0=b[1]-margin,x1=b[2]+margin,y1=b[3]+margin,out=[x0,y0,x1,y0,x1,y1,x0,y1,x0,y0];
      for(let i=0;i<=n;i++){const j=(v+i)%n;out.push(r[2*j],r[2*j+1]);}
      return Int32Array.from(out);
    }
    const reversedRing=r=>{const n=r.length>>1,o=new Int32Array(r.length);for(let i=0;i<n;i++){o[2*i]=r[2*(n-1-i)];o[2*i+1]=r[2*(n-1-i)+1];}return o;};
    // Which hole of E holds each point (px, py): E's holes in a uniform grid of their boxes, then exact point in ring.
    function holeOf(E,px,py){
      const holes=[];
      E.forEach((isl,s)=>isl.holes.forEach((h,j)=>holes.push({s,j,ring:h.ring,box:h.box||boxOf(h.ring)})));
      const out=new Int32Array(px.length).fill(-1);
      if(!holes.length)return {out,holes};
      let w=1;for(const h of holes)w=Math.max(w,h.box[2]-h.box[0],h.box[3]-h.box[1]);
      const c=Math.max(16,Math.min(w,4194304)),cells=new Map(),key=(x,y)=>(x+4194304)*8388608+(y+4194304);
      holes.forEach((h,id)=>{for(let cx=Math.floor(h.box[0]/c),ex=Math.floor(h.box[2]/c);cx<=ex;cx++)for(let cy=Math.floor(h.box[1]/c),ey=Math.floor(h.box[3]/c);cy<=ey;cy++){const k=key(cx,cy);let l=cells.get(k);if(!l)cells.set(k,l=[]);l.push(id);}});
      for(let i=0;i<px.length;i++){
        const l=cells.get(key(Math.floor(px[i]/c),Math.floor(py[i]/c)));if(!l)continue;
        for(const id of l){const b=holes[id].box;if(px[i]>=b[0]&&px[i]<=b[2]&&py[i]>=b[1]&&py[i]<=b[3]&&pointInRing(px[i],py[i],holes[id].ring)>0){out[i]=id;break;}}
      }
      return {out,holes};
    }
    const reachOf=T=>{let x=0;for(let i=0;i<T.length;i++){const v=Math.abs(T[i]);if(v>x)x=v;}return x;};
    function shapeIslands(found,task,stats){
      const m=task.morph;
      if(!m||!(m.mode===1||m.mode===2)||!found.length)return found;
      const t0=now(),P=[],E=[],reps=[],marginT=2*reachOf(m.t)+4;
      for(const isl of found){P.push({cls:0,ring:isl.ring,sign:1,tags:isl.tags||null});for(const h of isl.holes)P.push({cls:0,ring:h.ring,sign:1,tags:h.tags||null});}
      // Erosion, island by island (T cannot fit across two islands): the island less its complement
      // grown by T, i.e. the box-and-slit ring round its outer ring and each of its holes, grown by T.
      for(const isl of found){
        const sh=[{cls:0,ring:isl.ring,sign:1,tags:null}];
        for(const h of isl.holes)sh.push({cls:0,ring:h.ring,sign:1,tags:null});
        sh.push({cls:1,ring:convolution(boxSlit(reversedRing(isl.ring),marginT),m.t,false),sign:1,tags:null});
        for(const h of isl.holes){
          const c=convolution(h.ring,m.t,true);sh.push({cls:1,ring:c,sign:1,tags:null});
          if(convexRing(h.ring))reps.push({x:h.ring[0],y:h.ring[1],area:area2(c)});
        }
        for(const e of overlayInt(sh,2,w=>w[0]>0&&w[1]===0,{}))E.push(e);
      }
      
      const fin=P.slice();
      if(m.mode===2){
        for(const r of ringsOf(E))fin.push({cls:1,ring:r,sign:1,tags:null});
        for(const ring of m.keep||[])fin.push({cls:2,ring,sign:1,tags:null});
        const out=overlayInt(fin,3,w=>w[0]>0&&(w[1]===0||w[2]>0),{});
        stats.tShape=now()-t0;
        return out;
      }
      // A hole of E that holds exactly one convex hole of P, with that hole grown by T's area, is that hole grown by T.
      const {out:at,holes}=holeOf(E,reps.map(r=>r.x),reps.map(r=>r.y)),count=new Int32Array(holes.length),area=new Float64Array(holes.length);
      for(let i=0;i<reps.length;i++)if(at[i]>=0){count[at[i]]++;area[at[i]]=reps[i].area;}
      const skip=holes.map((h,id)=>count[id]===1&&-area2(h.ring)===area[id]);
      const margin=2*reachOf(m.u)+4;let hid=0;
      for(const isl of E){
        const outer=convolution(isl.ring,m.u,false),keepHoles=[];
        for(const h of isl.holes){if(!skip[hid])keepHoles.push(h.ring);hid++;}
        if(!keepHoles.length){fin.push({cls:1,ring:outer,sign:1,tags:null});continue;}
        // Each kept hole on its own: what of it lies farther than U from its boundary (H' ⊖ U).
        const D=[{cls:0,ring:outer,sign:1,tags:null}];
        for(const h of keepHoles){
          const deep=overlayInt([{cls:0,ring:reversedRing(h),sign:1,tags:null},{cls:1,ring:convolution(boxSlit(h,margin),m.u,false),sign:1,tags:null}],2,w=>w[0]>0&&w[1]===0,{});
          for(const r of ringsOf(deep))D.push({cls:1,ring:r,sign:1,tags:null});
        }
        for(const r of ringsOf(overlayInt(D,2,w=>w[0]>0&&w[1]===0,{})))fin.push({cls:1,ring:r,sign:1,tags:null});
      }
      for(const ring of m.keep||[])fin.push({cls:2,ring,sign:1,tags:null});
      const out=overlayInt(fin,3,w=>w[0]>0&&(w[1]>0||w[2]>0),{});
      stats.tShape=now()-t0;
      return out;
    }
    // The island tests of solve(): anchors each island touches, dead copper, area and size limits.
    // found: islands as islands() gives them (ring, tags, area, box, holes with area and box).
    function keep(found,task,stats,t0,reuseRings=false){
      const t1=now();
      const anchors=task.anchors.map(ring=>({ring,box:boxOf(ring)}));
      for(const isl of found){isl.links=[];anchors.forEach((a,k)=>{if(touches(a,isl))isl.links.push(k);});}
      const before=found.length;
      if(task.removeDead)found=found.filter(isl=>isl.links.length);
      stats.deadIslands=before-found.length;
      found=found.filter(isl=>{
        const area=isl.area-isl.holes.reduce((s,h)=>s+h.area,0);
        if(task.minArea>0&&area<task.minArea)return false;
        return !(isl.box[2]-isl.box[0]<task.minSize&&isl.box[3]-isl.box[1]<task.minSize);
      });
      stats.tDead=now()-t1;stats.tSolve=now()-t0;
      const ints=r=>reuseRings&&r instanceof Int32Array?r:Int32Array.from(r||[]);
      const pack=r=>({ring:ints(r.ring),tags:ints(r.tags)});
      return {islands:found.map(isl=>({...pack(isl),links:isl.links,holes:isl.holes.map(pack)})),stats};
    }
    // Stage 2 without earlier copper to clear (two-stage pours): the island tests alone, on the
    // islands stage 1 solved (packed as solve() returns them). The same answer solve() gives for
    // that copper, without a second overlay.
    function keepSolved(solved,task,reuseRings){
      const t0=now(),measure=r=>({ring:r.ring,tags:r.tags,area:Math.abs(area2(r.ring))/2,box:boxOf(r.ring)});
      const found=solved.islands.map(isl=>({...measure(isl),holes:isl.holes.map(measure)}));
      const stats={edges:0,merged:0,passes:0,faces:0,rays:0,tPlanar:0,tMerge:0,tClassify:0,tTrace:0,tIslands:0};
      return keep(shapeIslands(found,task,stats),task,stats,t0,reuseRings);
    }
    // Canonical form of a solution (in place): every ring starts at its lowest vertex (x, then y),
    // the edge tags rotated with it; the holes of an island and the islands themselves sorted by
    // their rings. Rings come out of trace() with repeated and collinear vertices already dropped.
    // So the stored copper depends only on the point set, never on the order edges or tasks came in.
    // islands (optional): input island -> its canonical island, for islands that are the same objects
    // as in an earlier solution (the area patch keeps them). Input islands are never changed.
    function canonical(solved,rotations,islands){
      const rot=r=>{
        const ring=r.ring,n=ring.length>>1,memo=rotations?.get(ring);
        if(memo&&memo.sourceTags===r.tags)return {...r,ring:memo.ring,tags:memo.tags};
        let m=memo?.start??0;
        if(!memo)for(let i=1;i<n;i++){const x=ring[2*i],y=ring[2*i+1],mx=ring[2*m];if(x<mx||(x===mx&&y<ring[2*m+1]))m=i;}
        if(!m)return r;
        const out=memo?.ring||new Int32Array(ring.length);
        if(!memo){out.set(ring.subarray(2*m));out.set(ring.subarray(0,2*m),ring.length-2*m);}
        let tags=r.tags;
        if(tags&&tags.length===n){const t=new Int32Array(n);t.set(tags.subarray(m));t.set(tags.subarray(0,m),n-m);tags=t;}
        rotations?.set(ring,{sourceTags:r.tags,start:m,ring:out,tags});
        return {...r,ring:out,tags};
      };
      const cmp=(a,b)=>{
        const p=a.ring,q=b.ring,n=Math.min(p.length,q.length);
        for(let i=0;i<n;i++)if(p[i]!==q[i])return p[i]-q[i];
        if(p.length!==q.length)return p.length-q.length;
        const s=a.tags||[],t=b.tags||[],k=Math.min(s.length,t.length);
        for(let i=0;i<k;i++)if(s[i]!==t[i])return s[i]-t[i];
        return s.length-t.length;
      };
      solved.islands=solved.islands.map(isl=>{
        const m=islands?.get(isl);if(m)return m;
        const r=rot(isl),o=r===isl?{...isl}:r;o.holes=isl.holes.map(rot).sort(cmp);
        islands?.set(isl,o);return o;
      }).sort(cmp);
      return solved;
    }
    // A task for postMessage: its shapes and anchors packed into two Int32Arrays whose buffers are
    // transferred, so posting a large pour costs a copy, not a structured clone of thousands of
    // small arrays; unpack() gives readonly views into the transferred data. head: per shape cls, sign,
    // ring length, tags length (-1: none); per anchor its length. The other fields are copied.
    function pack(task){
      const sh=task.shapes,an=task.anchors||[];let n=0;
      for(const s of sh)n+=s.ring.length+(s.tags?s.tags.length:0);
      for(const r of an)n+=r.length;
      const head=new Int32Array(4*sh.length+an.length),data=new Int32Array(n);let o=0,h=0;
      for(const s of sh){head[h++]=s.cls;head[h++]=s.sign;head[h++]=s.ring.length;head[h++]=s.tags?s.tags.length:-1;data.set(s.ring,o);o+=s.ring.length;if(s.tags){data.set(s.tags,o);o+=s.tags.length;}}
      for(const r of an){head[h++]=r.length;data.set(r,o);o+=r.length;}
      const {shapes,anchors,...rest}=task;
      return {task:{...rest,packed:1,nShapes:sh.length,nAnchors:an.length,head,data},transfer:[head.buffer,data.buffer]};
    }
    function unpack(p){
      const {packed,nShapes,nAnchors,head,data,...rest}=p,shapes=new Array(nShapes),anchors=new Array(nAnchors);let o=0,h=0;
      for(let k=0;k<nShapes;k++){
        const cls=head[h++],sign=head[h++],nr=head[h++],nt=head[h++],ring=data.subarray(o,o+nr);o+=nr;
        let tags=null;if(nt>=0){tags=data.subarray(o,o+nt);o+=nt;}
        shapes[k]={cls,ring,sign,tags};
      }
      for(let k=0;k<nAnchors;k++){const n=head[h++];anchors[k]=data.subarray(o,o+n);o+=n;}
      return {...rest,shapes,anchors};
    }
    // Union-find over 0..n-1 (path halving; the smaller index is the root): the tile stitch's seams
    // (PourTiles) and the area patch's components (areaRegion, areaChanges) share it.
    function unionFind(n){
      const parent=new Int32Array(n);for(let i=0;i<n;i++)parent[i]=i;
      const find=x=>{while(parent[x]!==x){parent[x]=parent[parent[x]];x=parent[x];}return x;};
      const join=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[a<b?b:a]=a<b?a:b;};
      return {find,join};
    }
    return {orient,edgeList,planarize,merge,classify,classifyRays,trace,simplify,area2,boxOf,pointInRing,islands,overlayRings,overlayInt,segmentsTouch,touches,pourInside,solve,solveSteps,keep,keepSolved,canonical,pack,unpack,convolution,boxSlit,shapeIslands,unionFind};
  }
  // ------------------------------------------------------- tiled repour
  // PourTiles keeps each pour as a grid of square tiles in the pour's integer
  // frame (the same frame as a full pour). A tile holds the copper of the
  // overlay of the shapes that reach it, clipped to the tile by an obstacle
  // frame, solved with the same core (CORE.solve, so the WebAssembly core when
  // it is loaded). An edit dirties the tiles that the old or new shapes of the
  // changed items reach; only those are solved again. Islands are global, so
  // the pieces are stitched with a union-find over the tile seams: two pieces
  // in neighbouring tiles are one island when their boundaries share a seam
  // interval of positive length. Each island then gets the full pour's tests
  // (dead copper, minimum area, minimum size). Earlier pours on the layer
  // enter a tile as the offset of their copper near it (the union of their
  // kept pieces in the tiles around), so a later pour follows an earlier one.
  //
  // Geometry matches a full pour within one integer unit (10 nm at full
  // resolution): a tile seam splits edges at points rounded to the grid, as
  // the overlay rounds every crossing. tests/pour-tiles.cjs measures the XOR.
  // Like PourCore it refers to no outer binding: the tile worker is built from
  // its source text, with PourCore and offsetRing passed in.
  function PourTiles(core,offsetRing){
    const SAFE=2e-5,now=()=>globalThis.performance?.now?.()??Date.now();
    const sessions=new Map();let order=[];
    const area2=core.area2,boxOf=core.boxOf;
    const meets=(a,b)=>a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];
    // pack: {keys:[string], shapes:Int32Array [key,cls,sign,off,len]*, anchors:Int32Array [key,off,len]*, data:Int32Array}
    function* unpack(pack){
      const {keys,shapes,anchors,data}=pack;
      for(let i=0;i<shapes.length;i+=5){const o=shapes[i+3],n=shapes[i+4];yield {anchor:false,key:keys[shapes[i]],cls:shapes[i+1],sign:shapes[i+2],ring:data.subarray(o,o+n)};}
      for(let i=0;i<anchors.length;i+=3){const o=anchors[i+1],n=anchors[i+2];yield {anchor:true,key:keys[anchors[i]],ring:data.subarray(o,o+n)};}
    }
    function tileBox(s,t){const c=t%s.cols,r=(t-c)/s.cols,x=s.gx0+c*s.TS,y=s.gy0+r*s.TS;return [x,y,x+s.TS,y+s.TS];}
    function range(s,b){
      const c0=Math.max(0,Math.floor((b[0]-s.gx0)/s.TS)),c1=Math.min(s.cols-1,Math.floor((b[2]-s.gx0)/s.TS));
      const r0=Math.max(0,Math.floor((b[1]-s.gy0)/s.TS)),r1=Math.min(s.rows-1,Math.floor((b[3]-s.gy0)/s.TS));
      return c0>c1||r0>r1?null:[c0,c1,r0,r1];
    }
    function eachTile(s,b,fn){const q=range(s,b);if(!q)return;for(let r=q[2];r<=q[3];r++)for(let c=q[0];c<=q[1];c++)fn(r*s.cols+c);}
    const BIG=64;
    function addObject(s,o){
      const ring=Int32Array.from(o.ring),box=boxOf(ring),e={cls:o.cls,sign:o.sign,ring,box,dead:false};
      let k=s.byKey.get(o.key);if(!k)s.byKey.set(o.key,k=[]);k.push(e);
      const q=range(s,[box[0]-1,box[1]-1,box[2]+1,box[3]+1]);if(!q)return;
      const list=o.anchor?s.cellAnchors:s.cellShapes;
      if(!o.anchor&&(q[1]-q[0]+1)*(q[3]-q[2]+1)>BIG){s.global.add(e);e.global=true;}
      else for(let r=q[2];r<=q[3];r++)for(let c=q[0];c<=q[1];c++){const t=r*s.cols+c;(list[t]||(list[t]=[])).push(e);}
      for(let r=q[2];r<=q[3];r++)for(let c=q[0];c<=q[1];c++)s.dirty.add(r*s.cols+c);
    }
    function removeKey(s,key){
      const k=s.byKey.get(key);if(!k)return;s.byKey.delete(key);
      for(const e of k){e.dead=true;if(e.global)s.global.delete(e);eachTile(s,[e.box[0]-1,e.box[1]-1,e.box[2]+1,e.box[3]+1],t=>s.dirty.add(t));}
    }
    // init: a pour's full keyed shape set and its frame and settings.
    function init(p){
      const s={id:p.id,layer:p.layer,net:p.net,S:p.S,ox:p.ox,oy:p.oy,tol:p.tol,K:p.K,hasBoard:p.hasBoard,removeDead:p.removeDead,
        minArea:p.minArea,minSize:p.minSize,earlier:p.earlier||[],gx0:p.gx0,gy0:p.gy0,TS:p.TS,cols:p.cols,rows:p.rows,
        byKey:new Map(),global:new Set(),cellShapes:[],cellAnchors:[],tiles:new Array(p.cols*p.rows).fill(null),dirty:new Set(),changed:new Set(),kept:null,stats:{},epoch:0,offsetCache:new Map()};
      sessions.set(s.id,s);
      for(const o of unpack(p.pack))addObject(s,o);
      for(let t=0;t<s.cols*s.rows;t++)s.dirty.add(t);
      return s;
    }
    // Rings of an earlier pour's copper near box (mm), offset by its clearance, in s's frame.
    function earlierRings(s,A,e,bmm){
      const reach=e.c+SAFE+2*s.tol+2/s.S,q=[bmm[0]-reach,bmm[1]-reach,bmm[2]+reach,bmm[3]+reach];
      const qa=[Math.floor((q[0]-A.ox)*A.S)-1,Math.floor((q[1]-A.oy)*A.S)-1,Math.ceil((q[2]-A.ox)*A.S)+1,Math.ceil((q[3]-A.oy)*A.S)+1];
      // The offset copper of a range of A's tiles is shared by every tile of s (and of other
      // later pours) that asks for the same range while A is unchanged (A.epoch).
      const rq=range(A,qa);if(!rq)return [];
      const ck=A.epoch+":"+qa.join(",")+":"+e.c+":"+s.tol;
      let mm=A.offsetCache.get(ck);
      if(!mm){const t0=now();mm=offsetUnion(A,qa,e.c,s.tol);s.stats.tUnion=(s.stats.tUnion||0)+now()-t0;s.stats.unions=(s.stats.unions||0)+1;if(A.offsetCache.size>4096)A.offsetCache.clear();A.offsetCache.set(ck,mm);}
      const out=[];
      for(const f of mm){
        const rb=f.box;if(rb[0]>bmm[2]||rb[2]<bmm[0]||rb[1]>bmm[3]||rb[3]<bmm[1])continue;
        const ring=[];
        for(let i=0;i<f.length;i+=2){const x=Math.round((f[i]-s.ox)*s.S),y=Math.round((f[i+1]-s.oy)*s.S),k=ring.length;if(k&&ring[k-2]===x&&ring[k-1]===y)continue;ring.push(x,y);}
        while(ring.length>=4&&ring[0]===ring[ring.length-2]&&ring[1]===ring[ring.length-1])ring.length-=2;
        if(ring.length<6||!area2(ring))continue;
        out.push(Int32Array.from(ring));
      }
      return out;
    }
    // A's kept copper over a range of its tiles, unioned, offset by c (+SAFE) in mm.
    function offsetUnion(A,qa,c,tol){
      const input=[];
      eachTile(A,qa,t=>{const T=A.tiles[t];if(!T)return;for(const p of T.pieces){if(!p.kept)continue;input.push({cls:0,ring:p.ring,sign:1});for(const h of p.holes)input.push({cls:0,ring:h,sign:1});}});
      if(!input.length)return [];
      // Clipped to the query box first: a boundary made by the clip is at least the reach away
      // from the tile, and an offset only grows outwards, so it never reaches the tile.
      let bx0=qa[0],by0=qa[1],bx1=qa[2],by1=qa[3];
      for(const x of input){const b=boxOf(x.ring);if(b[0]<bx0)bx0=b[0];if(b[1]<by0)by0=b[1];if(b[2]>bx1)bx1=b[2];if(b[3]>by1)by1=b[3];}
      input.push({cls:2,ring:Int32Array.of(bx0-2,by0-2,bx1+2,by0-2,bx1+2,by1+2,bx0-2,by1+2),sign:1},{cls:2,ring:Int32Array.of(qa[0],qa[1],qa[2],qa[1],qa[2],qa[3],qa[0],qa[3]),sign:-1});
      const union=core.solve({shapes:input,K:6,hasBoard:false,anchors:[],removeDead:false,minArea:0,minSize:0}).islands;
      const d=c+(c>0?Math.max(SAFE,1.5/A.S):0),out=[],toMm=r=>{const f=new Array(r.length);for(let i=0;i<r.length;i+=2){f[i]=r[i]/A.S+A.ox;f[i+1]=r[i+1]/A.S+A.oy;}return f;};
      for(const isl of union)for(const r of [isl.ring,...isl.holes.map(h=>h.ring)]){
        const off=offsetRing(toMm(r),d,tol,null);if(!off)continue;
        off.box=boxOf(off);out.push(off);
      }
      return out;
    }
    // The seam intervals of a ring on the tile border: [L, R, B, T] flat [a, b, ...].
    function sides(ring,b){
      const out=[[],[],[],[]],n=ring.length>>1;
      for(let i=0,j=n-1;i<n;j=i++){
        const x1=ring[2*j],y1=ring[2*j+1],x2=ring[2*i],y2=ring[2*i+1];
        if(x1===x2&&y1!==y2){const k=x1===b[0]?0:x1===b[2]?1:-1;if(k>=0)out[k].push(Math.min(y1,y2),Math.max(y1,y2));}
        else if(y1===y2&&x1!==x2){const k=y1===b[1]?2:y1===b[3]?3:-1;if(k>=0)out[k].push(Math.min(x1,x2),Math.max(x1,x2));}
      }
      return out;
    }
    function solveTile(s,t){
      const b=tileBox(s,t),shapes=[];let bx0=b[0],by0=b[1],bx1=b[2],by1=b[3],outline=false;
      const take=e=>{
        const q=e.box;if(e.dead||q[2]<b[0]||q[0]>b[2]||q[3]<b[1]||q[1]>b[3])return;
        shapes.push({cls:e.cls,ring:e.ring,sign:e.sign});if(e.cls===0)outline=true;
        if(q[0]<bx0)bx0=q[0];if(q[1]<by0)by0=q[1];if(q[2]>bx1)bx1=q[2];if(q[3]>by1)by1=q[3];
      };
      for(const e of s.global)take(e);
      const cell=s.cellShapes[t];
      if(cell){let w=0;for(const e of cell)if(!e.dead)cell[w++]=e;cell.length=w;for(const e of cell)take(e);}
      if(!outline)return {pieces:[]};
      const bmm=[b[0]/s.S+s.ox,b[1]/s.S+s.oy,b[2]/s.S+s.ox,b[3]/s.S+s.oy];
      s.earlier.forEach((e,k)=>{
        const A=sessions.get(e.id);if(!A)return;
        for(const ring of earlierRings(s,A,e,bmm)){
          const q=boxOf(ring);if(q[2]<b[0]||q[0]>b[2]||q[3]<b[1]||q[1]>b[3])continue;
          shapes.push({cls:6+k,ring,sign:1});
          if(q[0]<bx0)bx0=q[0];if(q[1]<by0)by0=q[1];if(q[2]>bx1)bx1=q[2];if(q[3]>by1)by1=q[3];
        }
      });
      // The clip frame comes last, so every crossing on a seam is computed on the shape's edge
      // (the same point for both tiles of the seam).
      shapes.push({cls:2,ring:Int32Array.of(bx0-2,by0-2,bx1+2,by0-2,bx1+2,by1+2,bx0-2,by1+2),sign:1});
      shapes.push({cls:2,ring:Int32Array.of(b[0],b[1],b[2],b[1],b[2],b[3],b[0],b[3]),sign:-1});
      const anchors=[],ac=s.cellAnchors[t];
      if(ac){let w=0;for(const e of ac)if(!e.dead)ac[w++]=e;ac.length=w;for(const e of ac)if(meets(e.box,b))anchors.push(e.ring);}
      const r=core.solve({shapes,K:s.K,hasBoard:s.hasBoard,anchors,removeDead:false,minArea:0,minSize:0});
      s.stats.edges=(s.stats.edges||0)+(r.stats.edges||0);s.stats.shapes=(s.stats.shapes||0)+shapes.length;
      const pieces=r.islands.map(i=>{
        let a=area2(i.ring);const holes=i.holes.map(h=>{a+=area2(h.ring);return h.ring;});
        return {ring:i.ring,holes,linked:i.links.length>0,area:a/2,box:boxOf(i.ring),sides:sides(i.ring,b),kept:true};
      });
      return {pieces};
    }
    function overlaps(a,b){
      for(let i=0;i<a.length;i+=2)for(let j=0;j<b.length;j+=2)if(Math.min(a[i+1],b[j+1])>Math.max(a[i],b[j]))return true;
      return false;
    }
    // Islands: union-find over the pieces, joined across seams; then the full pour's island tests.
    function stitch(s){
      const all=[];
      for(let t=0;t<s.tiles.length;t++){const T=s.tiles[t];if(T)for(const p of T.pieces){p.uid=all.length;p.tile=t;all.push(p);}}
      const {find,join}=core.unionFind(all.length);
      for(let t=0;t<s.tiles.length;t++){
        const T=s.tiles[t];if(!T||!T.pieces.length)continue;
        const c=t%s.cols;
        const right=c+1<s.cols?s.tiles[t+1]:null,up=t+s.cols<s.tiles.length?s.tiles[t+s.cols]:null;
        for(const p of T.pieces){
          if(right&&p.sides[1].length)for(const q of right.pieces)if(q.sides[0].length&&overlaps(p.sides[1],q.sides[0]))join(p.uid,q.uid);
          if(up&&p.sides[3].length)for(const q of up.pieces)if(q.sides[2].length&&overlaps(p.sides[3],q.sides[2]))join(p.uid,q.uid);
        }
      }
      const n=all.length,area=new Float64Array(n),box=new Float64Array(4*n).fill(NaN),linked=new Uint8Array(n);
      for(const p of all){
        const r=find(p.uid);area[r]+=p.area;if(p.linked)linked[r]=1;
        if(Number.isNaN(box[4*r])){box[4*r]=p.box[0];box[4*r+1]=p.box[1];box[4*r+2]=p.box[2];box[4*r+3]=p.box[3];}
        else{box[4*r]=Math.min(box[4*r],p.box[0]);box[4*r+1]=Math.min(box[4*r+1],p.box[1]);box[4*r+2]=Math.max(box[4*r+2],p.box[2]);box[4*r+3]=Math.max(box[4*r+3],p.box[3]);}
      }
      let islands=0,keptCount=0;
      for(const p of all){
        const r=find(p.uid);if(r===p.uid)islands++;
        const keep=(!s.removeDead||linked[r]===1)&&!(s.minArea>0&&area[r]<s.minArea)&&!(box[4*r+2]-box[4*r]<s.minSize&&box[4*r+3]-box[4*r+1]<s.minSize);
        if(r===p.uid&&keep)keptCount++;
        if(p.kept!==keep){p.kept=keep;s.changed.add(p.tile);}
        p.island=r;
      }
      s.stats.islands=islands;s.stats.kept=keptCount;s.stats.pieces=n;
    }
    // Recompute the dirty tiles of every session, in pour order. A changed tile of an earlier
    // pour dirties the tiles of later pours on its layer within its clearance.
    function run(){
      const t0=now(),stats={tiles:0,pours:{}};
      for(const id of order){
        const s=sessions.get(id);if(!s)continue;
        for(const e of s.earlier){
          const A=sessions.get(e.id);if(!A||!A.changed.size)continue;
          const reach=e.c+SAFE+2*s.tol+2/s.S;
          for(const t of A.changed){
            const b=tileBox(A,t),m=[b[0]/A.S+A.ox-reach,b[1]/A.S+A.oy-reach,b[2]/A.S+A.ox+reach,b[3]/A.S+A.oy+reach];
            eachTile(s,[Math.floor((m[0]-s.ox)*s.S)-1,Math.floor((m[1]-s.oy)*s.S)-1,Math.ceil((m[2]-s.ox)*s.S)+1,Math.ceil((m[3]-s.oy)*s.S)+1],u=>s.dirty.add(u));
          }
        }
        const ts=now(),n=s.dirty.size;s.stats.tUnion=0;s.stats.unions=0;s.stats.edges=0;s.stats.shapes=0;
        for(const t of s.dirty){const r=solveTile(s,t);s.tiles[t]=r.pieces.length?r:null;s.changed.add(t);}
        s.dirty.clear();
        const tt=now();stitch(s);
        if(s.changed.size){s.epoch++;s.offsetCache.clear();}
        stats.tiles+=n;stats.pours[id]={tiles:n,solve:now()-ts-(now()-tt),stitch:now()-tt,...s.stats};
      }
      stats.ms=now()-t0;
      return stats;
    }
    // The kept copper of tiles, as integer rings (outline, then holes, per piece).
    function tileRings(s,t){const T=s.tiles[t],out=[];if(T)for(const p of T.pieces)if(p.kept){out.push(p.ring);for(const h of p.holes)out.push(h);}return out;}
    // What changed since the last call: per session, the tiles whose kept copper changed.
    function takeChanged(){
      const out={};
      for(const [id,s] of sessions){if(s.changed.size){out[id]=[...s.changed].sort((a,b)=>a-b);s.changed.clear();}}
      return out;
    }
    return {
      init(list,ord){for(const p of list){sessions.delete(p.id);init(p);}if(ord)order=ord;},
      update(diffs,ord){
        if(ord)order=ord;
        for(const d of diffs){const s=sessions.get(d.id);if(!s)continue;for(const k of d.remove)removeKey(s,k);for(const o of unpack(d.pack))addObject(s,o);}
      },
      drop(ids){for(const id of ids)sessions.delete(id);order=order.filter(id=>sessions.has(id));},
      clear(){sessions.clear();order=[];},
      run,takeChanged,tileRings,tileBox,
      session:id=>sessions.get(id),
      ids:()=>[...sessions.keys()],
      // Every kept piece of a pour (tests).
      kept(id){const s=sessions.get(id),out=[];if(s)for(const T of s.tiles)if(T)for(const p of T.pieces)if(p.kept)out.push(p);return out;}
    };
  }
  const CORE=PourCore();
  const {area2,boxOf,pointInRing,overlayInt}=CORE;

  // ------------------------------------------------------ shape builders
  // Minkowski sum of a convex core (point, segment or CCW polygon, model mm)
  // with a disk. "outer" arcs are tangent polygons that contain the true
  // disk; "inner" arcs are inscribed. Clearance cuts use outer arcs so the
  // approximation never violates the clearance.
  // With `sink` (a flat [cx,cy,R,...] list) the outer arc vertices are
  // registered: out.av[i] is the arc id of vertex i (or -1), so edges between
  // two vertices of one arc can be carried through the overlay as true arcs.
  const {step: roundStep, envelope: roundEnvelope} = AtriumGeometryCurves.roundProjection;
  /** @typedef {number[] & {av?: number[]}} TaggedRing */
  function rounded(core,r,tol,mode,sink){
    const n=core.length;
    /** @type {TaggedRing} */
    const out=[];
    if(!(r>1e-9)){if(n<3)return null;for(const p of core)out.push(p[0],p[1]);return out;}
    const outer=mode==="outer",av=sink&&outer?[]:null,step=roundStep(r,tol,outer);
    function arc(cx,cy,a0,sweep){
      const full=sweep>=TAU-1e-9;
      if(!full){out.push(cx+r*Math.cos(a0),cy+r*Math.sin(a0));if(av)av.push(-1);}
      if(sweep<1e-9)return;
      const before=out.length,R=roundEnvelope(out,cx,cy,r,a0,sweep,step,outer,full,full?256:128);
      if(av){
        const k=(out.length-before)>>1,id=full||k>=2?sink.length/3:-1;
        if(id>=0)sink.push(cx,cy,R);
        for(let j=0;j<k;j++)av.push(id);
      }
      if(!full){out.push(cx+r*Math.cos(a0+sweep),cy+r*Math.sin(a0+sweep));if(av)av.push(-1);}
    }
    if(n===1)arc(core[0][0],core[0][1],0,TAU);
    else for(let i=0;i<n;i++){
      const p=core[(i+n-1)%n],v=core[i],q=core[(i+1)%n];
      const a0=Math.atan2(-(v[0]-p[0]),v[1]-p[1]),a1=Math.atan2(-(q[0]-v[0]),q[1]-v[1]);
      let sweep=a1-a0;while(sweep<0)sweep+=TAU;while(sweep>=TAU)sweep-=TAU;
      if(n===2)sweep=Math.PI;
      arc(v[0],v[1],a0,sweep);
    }
    if(av)out.av=av;
    return out;
  }
  function padOnLayer(p,parent,layer){
    const L=AtriumResolvedLand,source=L.geometry(p,layer),via=p.kind==="via";
    const nominal=p.drill>0?L.place(p,parent):null;
    let land=source;
    if(!land){
      const drill=via?globalThis.AtriumViaStack?.drillSpans(p).find(d=>d.role==="backdrill")?.drill:p.drill;
      if(!(drill>0))return null;
      land={...L.profile("circle",drill,drill,p.angle),x:p.x,y:p.y,drill};
    }
    const {at:center,angle,mirror}=L.place(land,parent),{core,r:radius}=L.core(land,center,angle,mirror);
    return {center,angle,core,radius,w:land.w,h:land.h,drill:land.drill||0,nominal};
  }
  // On an internal negative plane the drill's envelope defines the antipad. For
  // a thermal the plane's copper land starts at the source relief expansion.
  function drilledShape(p,pc,expansion=0){
    const drill=pc.drill,length=Math.max(drill,+p.slotLength||0),center=pc.nominal?.at??pc.center;
    const angle=(pc.nominal?.angle??pc.angle)+(pc.nominal?.mirror?-1:1)*(+p.slotAngle||0);
    const core=Atrium.drillCore({...p,drill,slotAngle:0},center,angle);
    return {...pc,center,core,radius:drill/2+expansion,w:length+2*expansion,h:drill+2*expansion,angle,slot:core.length>1};
  }
  function signedArea(flat){let s=0;const n=flat.length>>1;for(let i=0,j=n-1;i<n;j=i++)s+=flat[2*j]*flat[2*i+1]-flat[2*i]*flat[2*j+1];return s/2;}
  function reversed(flat){const out=[];for(let i=flat.length-2;i>=0;i-=2)out.push(flat[i],flat[i+1]);return out;}
  // Raw offset of a ring with the filled side on its left (positive outer
  // rings, negative holes), outward by d with round joins, as in Clipper's
  // offsetter: convex corners get a tangent arc, reflex corners route through
  // the vertex. Under the positive-winding rule the union of a region's raw
  // offsets is its Minkowski sum with a disk of radius d.
  // A reflex corner whose two offset edges cross within the first and last
  // half of their edges is mitred instead: the crossing is the true corner
  // of the offset, and the detour through the vertex only adds a loop that
  // the union discards. Along a fine concave arc the detours cross each other
  // by the thousand; mitred, they do not cross at all.
  /** @returns {TaggedRing | null} */
  function offsetRing(flat,d,tol,sink){
    const pts=[];
    for(let i=0;i<flat.length;i+=2){
      const x=+flat[i],y=+flat[i+1],k=pts.length;
      if(k&&Math.abs(pts[k-2]-x)<1e-9&&Math.abs(pts[k-1]-y)<1e-9)continue;
      pts.push(x,y);
    }
    while(pts.length>=4&&Math.abs(pts[0]-pts[pts.length-2])<1e-9&&Math.abs(pts[1]-pts[pts.length-1])<1e-9)pts.length-=2;
    const n=pts.length>>1;if(n<3)return null;
    if(!(d>0))return pts;
    /** @type {TaggedRing} */
    const out=[];
    const step=roundStep(d,tol,true),av=sink?[]:null,mark=(id,c)=>{if(av)for(let j=0;j<c;j++)av.push(id);};
    const len=new Float64Array(n);
    for(let i=0;i<n;i++){const q=(i+1)%n;len[i]=Math.hypot(pts[2*q]-pts[2*i],pts[2*q+1]-pts[2*i+1]);}
    for(let i=0;i<n;i++){
      const p=(i+n-1)%n,q=(i+1)%n,vx=pts[2*i],vy=pts[2*i+1];
      const e1x=vx-pts[2*p],e1y=vy-pts[2*p+1],e2x=pts[2*q]-vx,e2y=pts[2*q+1]-vy;
      const l1=len[p],l2=len[i],n1x=e1y/l1,n1y=-e1x/l1,n2x=e2y/l2,n2y=-e2x/l2;
      const cr=(e1x*e2y-e1y*e2x)/(l1*l2),dot=(e1x*e2x+e1y*e2y)/(l1*l2);
      if(cr< -1e-12){
        // The offset edges cross d*tan(turn/2) before the corner: mitre when that is within half of both edges.
        const t=dot>0?-cr*d/(1+dot):Infinity;
        if(t<=len[p]/2&&t<=len[i]/2){const k=d/(1+dot);out.push(vx+(n1x+n2x)*k,vy+(n1y+n2y)*k);mark(-1,1);}
        else{out.push(vx+n1x*d,vy+n1y*d,vx,vy,vx+n2x*d,vy+n2y*d);mark(-1,3);}
        continue;
      }
      out.push(vx+n1x*d,vy+n1y*d);mark(-1,1);
      if(cr<=1e-12&&dot>0)continue;
      const a0=Math.atan2(n1y,n1x);let sweep=Math.atan2(n2y,n2x)-a0;
      while(sweep<0)sweep+=TAU;while(sweep>=TAU)sweep-=TAU;
      if(cr<=1e-12)sweep=Math.PI;
      const before=out.length,R=roundEnvelope(out,vx,vy,d,a0,sweep,step,true,false,64);
      if(av){
        const k=(out.length-before)>>1,id=k>=2?sink.length/3:-1;
        if(id>=0)sink.push(vx,vy,R);
        mark(id,k);
      }
      out.push(vx+n2x*d,vy+n2y*d);mark(-1,1);
    }
    if(av)out.av=av;
    return out;
  }
  // ------------------------------------------------------------- clearance
  function ruleValue(rules,net){
    if(!rules||typeof rules!=="object")return null;
    const o=net&&rules.nets&&own(rules.nets,net)&&rules.nets[net];
    const v=o&&finite(o.clearance)?o.clearance:rules.defaults?.clearance;
    return finite(v)?v:null;
  }
  function pourRules(doc,options){
    const project=copperProject(doc,options);
    return options?.rules??(globalThis.AtriumRules?.stored?AtriumRules.stored(doc,project):doc.rules)??null;
  }
  function scopeDependencies(hash,doc,rules,options){
    const G=globalThis,selected=new Map();
    for(const rule of rules?.list||[]){
      if(rule.type!=="clearance"||rule.enabled===false)continue;
      for(const scope of [rule.scope,rule.scope2]){
        if(!scope)continue;
        const selector=G.AtriumDesignQueryRecord?.toSelector(scope);
        if(!["all","net","layer","component"].includes(selector?.kind))
          selected.set(selector?selector.kind+"\u0000"+selector.value:"",selector);
      }
    }
    if(!selected.size)return;
    const scopes=[...selected.values()];
    hash.value(doc.componentClasses);hash.value(doc.rooms);
    const p=options.project||G.AtriumSignals?.projectOf?.(doc);
    const legacy=AtriumPCBPours.signalScope(doc,p);
    hash.value(legacy);
    // A simple selector does not need a shape trace; sign the derived part
    // of its membership that the stored board records do not describe.
    const classes=new Set(scopes.filter(s=>s?.kind==="componentclass").map(s=>s.value));
    // Older class-scoped stamps cannot prove that an empty membership was empty
    // when the retained copper was filled.
    if(classes.size)hash.value("component class memberships");
    if(classes.size&&G.AtriumComponentClasses){
      const rooms=new Set((doc.rooms||[]).filter(r=>r.componentClass||r.channel).map(r=>r.name));
      const derived=new Map();
      for(const group of G.AtriumComponentClasses.list(doc,p,{order:false})){
        if(!classes.has(group.name)||group.source==="user"||group.source==="room"&&!rooms.has(group.name))continue;
        let members=derived.get(group.name);
        if(!members)derived.set(group.name,members=new Set());
        for(const ref of group.members)members.add(ref);
      }
      for(const name of [...derived.keys()].sort()){
        const declared=new Set(doc.componentClasses?.[name]||[]);
        const members=[...derived.get(name)].filter(ref=>!declared.has(ref)).sort();
        if(members.length)hash.value(["derived component class",name,members]);
      }
    }
    // Single-ended signals and tags without a net-class alias are absent from
    // the legacy signal mirror, but can still select a clearance rule.
    const signalScopes=scopes.filter(s=>s?.kind==="signal"||s?.kind==="tag");
    let env;
    if(signalScopes.length)try{env=G.AtriumSignals?.scopeEnv?.(doc,p);}catch{/* unavailable signal declarations */}
    if(env)for(const {kind,value} of signalScopes){
      const members=kind==="tag"?env.netsOfTag(value):env.netsOfSignal(value);
      const mirrored=kind==="tag"?legacy?.netClasses?.[value]:null;
      if(members.size&&!(Array.isArray(mirrored)&&mirrored.length===members.size&&mirrored.every(net=>members.has(net))))
        hash.value([kind,value,[...members].sort()]);
    }
  }
  function needsScopeTrace(rules, type) {
    return rules?.list?.some(rule => {
      if(rule.enabled===false || (type ? rule.type!==type : rule.type!=="clearance"&&rule.type!=="polygonConnect"))return false;
      return [rule.scope,rule.scope2].some(s=>s?.languageVersion===1&&!globalThis.AtriumDesignQueryRecord?.toSelector(s));
    });
  }
  function scopedBoardView(doc,defs,options){
    // The drawing copy has no entry in the editor journal. Spatial anchors and
    // parameter declarations belong to the actual board used for this solve.
    return !options.connect&&needsScopeTrace(pourRules(doc,options))?
      {...options,connect:connectContext(doc,defs,options)}:options;
  }
  // A broad-phase bound only. Actual gaps use the highest-priority matching object pair below.
  function ruleReach(rules,options={}){
    let gap=Math.max(.2,rules?.defaults?.clearance||0),relief=0;
    for(const r of Object.values(rules?.nets||{}))gap=Math.max(gap,r?.clearance||0);
    for(const r of rules?.list||[]){
      if(r.enabled===false)continue;
      if(r.type==="clearance"){
        gap=Math.max(gap,r.gap||0);
        for(const [key,value] of Object.entries(r.objects||{}))if(key.split("-").includes("poly"))gap=Math.max(gap,value);
      }else if(r.type==="polygonConnect"){
        for(const g of [r,...Object.values(r.kinds||{})])relief=Math.max(relief,(g.airGap||0)+(g.conductorWidth||0));
      }
    }
    return {gap:typeof options.clearanceFor==="function"?Infinity:gap,override:finite(options.clearance)?options.clearance:null,relief};
  }
  function reliefReach(p,reach){
    let m=Math.max(reach.relief,p.reliefAirGap+p.reliefConductorWidth);
    for(const g of Object.values(p.powerPlane||{}))if(g&&typeof g==="object")
      m=Math.max(m,(g.expansion||0)+(g.airGap||0)+(g.width||0));
    return m;
  }
  function clearanceFor(doc,poly,options){
    if(finite(options.clearance))return ()=>options.clearance;
    if(poly.clearance!=null)return ()=>poly.clearance;
    if(typeof options.clearanceFor==="function")return (net,kind)=>{const v=options.clearanceFor(net,poly.net,poly,kind);return finite(v)?v:.2;};
    const rules=pourRules(doc,options);
    const R=globalThis.AtriumRules,K=R?.kit,native=Array.isArray(rules?.list);
    const compiled=options.connect?.compiled||(K&&(!rules||rules.version===1||native)&&R.compiled(doc,{rules,defs:options.defs,project:options.project}));
    if(!compiled?.clearanceReady&&!native){
      const base=ruleValue(rules,poly.net)??.2;
      return net=>Math.max(base,ruleValue(rules,net)??base);
    }
    const list=compiled?.clearanceReady?compiled.byType.clearance:[];
    if(!list.length)return ()=>.2;
    const subject=K.copperSubject(options.owner||poly,null,"polygon");
    let owners;
    const unscoped=list.length===1&&K.allScope(list[0].scope)&&K.allScope(list[0].scope2)?list[0]:null;
    return (net,kind,item,parent,at,core,radius=0)=>{
      if(unscoped)return K.clearanceGap(unscoped,"poly",kind);
      const ck=kind||"track";
      if(ck==="poly"&&item?.polygon!=null){owners??=new Map(polygons(doc).map(p=>[p.id,p]));item=owners.get(item.polygon)||item;}
      if(!item&&ck==="poly")item={kind:"polygon",layer:poly.layer,net};
      const physicalKind=ck==="poly"?"polygon":ck==="hole"?item?.kind||"pad":ck==="th"||ck==="smd"?"pad":ck;
      const other=K.copperSubject(item||{kind:ck,layer:poly.layer,net},parent,physicalKind,at);
      other.ck=ck;
      other.net=net;
      if(ck==="via"&&item&&(item.stackMode&&item.stackMode!=="simple"||item.backdrill||item.shape&&item.shape!=="round"))other.span=subject.span;
      if(core?.length)Object.assign(other,K.feature({},core,radius));
      const rule=compiled.clearanceRule(subject,other);
      // A polygon still cuts around mechanical holes using its normal gap when no hole cell is authored.
      return rule?K.clearanceGap(rule,"poly",ck):.2;
    };
  }

  // Some legacy, read-only artwork has no editable polygon to repour. Cut the
  // actual land from that one foreign-net island on the manufacturing copy.
  function protectStoredLands(doc,regions,lands,options={}){
    if(!lands.length)return regions;
    const K=globalThis.AtriumRules?.kit,D=globalThis.AtriumDRCPours;
    if(!K||!D)return regions;
    const owners=new Map(polygons(doc).map(p=>[p.id,p])),out=[];
    const compiled=globalThis.AtriumRules.compiled(doc,{rules:pourRules(doc,options),defs:options.defs,project:options.project});
    let changed=false;
    for(const r of regions){
      if(r.polygon!=null&&!r.source){out.push(r);continue;}
      const owner=owners.get(r.polygon)||{kind:"polygon",net:r.net,layer:r.layer},P=settings(owner),gaps=clearanceFor(doc,P,{...options,owner,connect:{compiled}});
      const rs=rings(r),cuts=[];
      let grid;
      for(const {v,parent,at,layer,land} of lands){
        if(layer!==r.layer||v.net&&r.net===v.net)continue;
        const pc=K.padCore({w:land.diameter,h:land.diameter,shape:land.shape},at,0);
        if(!pc)continue;
        const gap=gaps(v.net||"","via",v,parent,at,pc.core,pc.radius);
        const f=K.feature({},pc.core,pc.radius),b=r.bounds,t=Math.max(.000001,gap);
        if(f.box[0]>b[2]+t||f.box[2]<b[0]-t||f.box[1]>b[3]+t||f.box[3]<b[1]-t)continue;
        grid??=D.edgeGrid(rs,Math.max(.5,t*2));
        const actual=D.gapTo(f,rs,grid,t).d;
        if(actual!==0&&actual+1e-6>=gap)continue;
        cuts.push(rounded(pc.core,pc.radius+gap+(gap>0?SAFE:0),P.arcApproximation,"outer"));
      }
      if(!cuts.length){out.push(r);continue;}
      const material=rs.map((ring,k)=>(signedArea(ring)>0)===(k===0)?ring:reversed(ring));
      for(const island of difference(material,cuts))out.push(encode([island.outline,...island.holes].map(a=>a.flat()),r.layer,r.net,{polygon:r.polygon}));
      changed=true;
    }
    return changed?out:regions;
  }

  // --------------------------------------------------------------- regions
  const {contours:rings,region:encode}=AtriumPCBPours;

  // ------------------------------------------------------------------ pour
  // ------------------------------------------------- smart connect styles
  // Per pad and via of the polygon's own net, decide relief, direct or no
  // connect and explain why. Order: a per-pad override stored on the polygon
  // (connectOverrides {"partId:pad"|"itemId": style}), then the highest
  // priority Polygon Connect Style rule (AtriumRules.query "polygonConnect"),
  // then the polygon's Connect Style. "auto" runs the smart classifier.
  // net-intent.js rails when loaded (isRail), plus the output and generic supply names this hint always took
  // (VOUT, VDC, VS, VSUPPLY; anchored, so DAC_VOUT stays a signal); the regex is the fallback for one release.
  const POWER_NAME_RE=/^(?:\+?\d+V\d*|\d+V\d+|[+-]\d+(?:\.\d+)?V\w*|V(?:CC|DD|IN|BUS|BAT|SYS|MAIN|PP|DC|CORE|IO|OUT|SUPPLY|S)\w*|\w*_(?:VCC|VDD|PWR|POWER|VIN|VBUS)\w*|PWR\w*|POWER\w*|\+\w+)$/i,POWER_EXTRA=/^V(?:OUT|DC|S|SUPPLY)(?:\d\w*|_\w*)?$/i;
  const POWER_NAME={test:n=>{const N=globalThis.AtriumNetIntent;return N?.isRail?N.isRail(String(n??""))||POWER_EXTRA.test(n):POWER_NAME_RE.test(n);}};
  // net-intent.js (isGround) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const GROUND_NAME_RE = /^(?:[ADPSCE]?GND\w*|\w*_GND\w*|VSS\w*|0V|GROUND\w*|EARTH|CHASSIS)$/i;
  const GROUND_NAME = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isGround ? N.isGround(String(n ?? "")) : GROUND_NAME_RE.test(n); }};
  const EXPOSED_NAME=/^(?:EP\d*|EPAD|E-PAD|PAD|TAB|THERMAL\w*|EXP\w*|GND_?PAD|SLUG)$/i;
  const SMALL=new Set(["0201","0402","0603","0805"]);
  const POWER_PARTS={L:"inductor",F:"fuse",Q:"transistor",FB:null};
  // IPC-2221 form, I = k·ΔT^0.44·A^0.725 (I in A, ΔT in °C, A in mil²), with
  // k = 0.048 for outer and 0.024 for inner layers. IPC-2152 finds inner
  // conductors closer to outer ones, so inner widths here are conservative.
  // Returns the total conductor width in mm for copper `thickness` mm.
  function ipcWidth(amps,thickness=.035,external=true,rise=10){
    if(!(amps>0))return 0;
    const k=external?.048:.024,area=Math.pow(amps/(k*Math.pow(rise,.44)),1/.725);
    return area/(Math.max(1e-4,thickness)/.0254)*.0254;
  }
  function sizeCode(def,fp){
    const text=[def?.name,fp?.name,def?.value,def?.footprintName].filter(Boolean).join(" ");
    const m=/(?:^|[^\d])(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)(?:[^\d]|$)/.exec(text);
    if(m)return m[1];
    const pads=fp?.pads||[];if(pads.length!==2||pads.some(p=>p.drill>0))return null;
    const [a,b]=pads,dx=Math.abs(a.x-b.x),dy=Math.abs(a.y-b.y),along=dx>=dy;
    const span=(along?dx:dy)+(along?(+a.w+ +b.w)/2:(+a.h+ +b.h)/2);
    return span<1.1?"0201":span<1.9?"0402":span<2.75?"0603":span<3.5?"0805":span<4.8?"1206":"large";
  }
  function connectContext(doc,defs,options={}){
    const RU=globalThis.AtriumRules;let set=null,resolve=null,compiled=null;
    try{if(RU?.compiled){compiled=RU.compiled(doc,{rules:pourRules(doc,options),defs,project:options.project});set=compiled.set;resolve=RU.resolver(doc,{compiled});}}catch{set=null;resolve=null;}
    const classes=Object.entries(set?.netClasses||{}),netCurrents=set?.netCurrents||{},classCurrents=set?.classCurrents||{};
    const fpInfo=new Map(),partInfo=new Map(),netPower=new Map(),onNet=new Map(),thick=new Map();
    function footprint(fp,def){
      if(fpInfo.has(fp))return fpInfo.get(fp);
      const pads=fp?.pads||[],areas=pads.map(p=>(+p.w||+p.diameter||0)*(+p.h||+p.diameter||0));
      let exposed=pads.findIndex(p=>EXPOSED_NAME.test(String(p.number??"")));
      if(exposed<0&&pads.length>=3){
        const order=areas.map((a,i)=>[a,i]).sort((x,y)=>y[0]-x[0]),sorted=[...areas].sort((x,y)=>x-y),median=sorted[sorted.length>>1];
        if(order[0][0]>=1&&order[0][0]>=3*median&&order[0][0]>=1.8*order[1][0])exposed=order[0][1];
      }
      const info={pads,areas,exposed,size:sizeCode(def,fp)};fpInfo.set(fp,info);return info;
    }
    for(const i of doc.items||[]){
      if(i.kind!=="part")continue;
      const def=defs?.get?.(i.def),fp=def?.footprint;if(!fp)continue;
      const counts=new Map();
      for(const p of fp.pads||[]){const n=own(i.pinNets,p.number)?i.pinNets[p.number]:p.net||"";if(n)counts.set(n,(counts.get(n)||0)+1);}
      for(const [n,c] of counts){let l=onNet.get(n);if(!l)onNet.set(n,l=[]);l.push({part:i,def,fp,count:c,net:n});}
      partInfo.set(i,{counts});
    }
    const prefix=part=>(/^[A-Za-z]+/.exec(part?.ref||"")?.[0]||"").toUpperCase();
    // Why a component makes its net a power path, or null.
    function powerPart(e){
      const pre=prefix(e.part),f=footprint(e.fp,e.def);
      if(pre==="L"&&!SMALL.has(f.size))return "inductor "+e.part.ref;
      if(pre==="F")return "fuse "+e.part.ref;
      if(pre==="Q")return "transistor "+e.part.ref;
      if(/^(U|IC|VR|PS)$/.test(pre)){
        if(e.count>=3)return e.part.ref+" ("+e.count+" pins on this net)";
        const ep=f.pads[f.exposed];
        if(ep&&(own(e.part.pinNets,ep.number)?e.part.pinNets[ep.number]:ep.net)===e.net)return "exposed pad of "+e.part.ref;
      }
      if(pre==="R"&&(/\d\s*m(?!eg)\s*(?:Ω|ohm|r)?\b/i.test(String(e.part.value||""))||/^(1206|1210|1812|2010|2512|large)$/.test(f.size||"")))return "shunt "+e.part.ref;
      if(/^(J|P|CN|X|CON|USB|BAT|BT)$/.test(pre)&&e.count>=2)return e.count+" paralleled pins of "+e.part.ref;
      return null;
    }
    function currentOf(net){
      if(own(netCurrents,net))return netCurrents[net];
      let a=0;for(const [c,members] of classes)if(own(classCurrents,c)&&members.includes(net))a=Math.max(a,classCurrents[c]);
      return a;
    }
    function connectRule(o){try{return resolve?resolve("polygonConnect",o):null;}catch{return null;}}
    function power(net){
      if(netPower.has(net))return netPower.get(net);
      let why=null;const ground=GROUND_NAME.test(net),cls=classes.find(([c,m])=>/power|pwr|supply/i.test(c)&&m.includes(net));
      const amps=currentOf(net),threshold=connectRule({net})?.powerWidth??.5;
      let width=null;try{width=resolve?resolve("width",{net}):null;}catch{width=null;}
      if(cls)why="net class "+cls[0];
      else if(amps>=.5)why=amps+" A";
      else if(width?.preferred!=null&&width.preferred>=threshold-1e-9)why="Width rule "+width.ruleName+" prefers "+width.preferred+" mm";
      else if(!ground&&POWER_NAME.test(net))why="power net name";
      else if(!ground){const parts=[];for(const e of onNet.get(net)||[]){const w=powerPart(e);if(w)parts.push(w);if(parts.length>=3)break;}if(parts.length)why=parts.join(", ");}
      const out={power:!!why,reason:why,ground};netPower.set(net,out);return out;
    }
    function thickness(layer){
      if(!thick.has(layer)){let t=.035;try{const info=globalThis.AtriumStackup?.layerInfo?.(doc,layer,defs);if(info?.thickness>0)t=info.thickness;}catch{/* default 1 oz */}thick.set(layer,t);}
      return thick.get(layer);
    }
    function smart(o,f){
      if(o.kind==="via")return {style:"direct",reason:"Via: direct connect. Vias are not soldered and a direct joint has the lowest impedance."};
      if(o.parent&&f&&f.exposed===o.index){
        const w=+o.pad.w||0,h=+o.pad.h||0,n=Math.max(1,Math.floor((w-.3)/1+1))*Math.max(1,Math.floor((h-.3)/1+1));
        return {style:"direct",reason:"Exposed/thermal pad of "+o.parent.ref+": direct for heat transfer.",hint:"Add a via array under the pad: about "+n+" vias of 0.3 mm at 1.0 mm pitch."};
      }
      const pre=prefix(o.parent);
      if(o.kind==="smd"&&f&&SMALL.has(f.size)&&f.pads.length===2&&/^(R|C|L|FB|D|LED)$/.test(pre))
        return {style:"relief",reason:f.size+" passive "+o.parent.ref+": relief so both ends heat evenly and it does not tombstone."};
      const pw=power(o.net);
      if(o.kind==="th")return {style:"relief",reason:"Through-hole pad: relief for hand soldering"+(pw.power?" (power net: "+pw.reason+")":"")+"."};
      if(pw.power)return {style:"direct",reason:"Power or high-current net ("+pw.reason+"): direct connect."};
      return {style:"relief",reason:pw.ground?"Ground pad not flagged as a current return (no Power class, current or wide Width rule): relief.":"Signal pad: relief (default)."};
    }
    // o: {P, kind:"th"|"smd"|"via", net, layer, parent?, pad, index?, pc, key, label, id, slot}
    function decide(o){
      const P=o.P,parent=o.parent,f=parent?footprint(o.fp,o.def):null;
      const rule=P.powerPlane||!resolve?null:connectRule({id:o.id, item:o.pad, part:parent, definition:o.def,
        kind:o.kind==="via"?"via":"pad", net:o.net, layer:o.layer, component:parent?.ref, pin:o.pad.number==null?undefined:String(o.pad.number),
        at:o.pc.center, padKind:o.kind});
      const fromRule=rule&&rule.style!=="polygon";
      let style=fromRule?rule.style:o.kind==="via"?P.viaConnectStyle:P.connectStyle;
      const geom=fromRule?{width:rule.conductorWidth,entries:+rule.entries===2?2:4,angle:+rule.angle===45?45:90,airGap:rule.airGap}
        :{width:P.reliefConductorWidth,entries:P.reliefEntries,angle:P.reliefAngle,airGap:P.reliefAirGap};
      const plane=P.powerPlane?.[o.kind==="via"?"via":"pad"];
      if(plane)Object.assign(geom,{width:plane.width,entries:plane.entries,angle:45,airGap:plane.airGap});
      let source=fromRule?"rule":"polygon",reason=fromRule?"Rule "+rule.ruleName+".":"Polygon connect style.",hint=null;
      const override=P.connectOverrides?.[o.key];
      if(override){style=override;source="override";reason="Override on this polygon.";}
      else if(style==="auto"){const d=smart(o,f);style=d.style;reason=d.reason;hint=d.hint||null;source="auto";}
      let spokeWidth=geom.width;const current=currentOf(o.net);
      if(style==="relief"&&source==="auto"&&current>0){
        const t=thickness(o.layer),need=ipcWidth(current,t,o.layer==="Top"||o.layer==="Bottom",rule?.tempRise??10),per=need/geom.entries;
        if(per>spokeWidth){spokeWidth=per;reason+=" Spokes widened to "+per.toFixed(3)+" mm so "+geom.entries+" carry "+current+" A.";}
        const cap=Math.min(+o.pad.w||+o.pad.diameter||Infinity,+o.pad.h||+o.pad.diameter||Infinity);
        if(spokeWidth>cap){spokeWidth=cap;reason+=" Clamped to the pad width; consider a direct connect.";}
      }
      return {key:o.key,id:o.id,slot:o.slot,label:o.label,net:o.net,layer:o.layer,kind:o.kind,component:parent?.ref,
        style,reason,source,hint,spokeWidth,entries:geom.entries,angle:geom.angle,airGap:geom.airGap,minEntries:rule?.minEntries??2,current,at:o.pc?.center};
    }
    return {decide,power,currentOf,ipcWidth,footprint,set,compiled};
  }
  // Same-net pads and vias of a polygon on its layer, as decide() inputs.
  function connectTargets(doc,defs,P,visit,items){
    const layer=P.layer,net=P.net;if(!net)return;
    const {padLayer,onLayer}=appearance();
    const outline=P.outline.flatMap(q=>[+q[0],+q[1]]);if(outline.length<6)return;
    // Only pads the polygon outline reaches (centre or a corner of the pad box).
    const reaches=pc=>{const r=Math.max(pc.w,pc.h)/2,[x,y]=pc.center;
      return ringHas(outline,x,y)||ringHas(outline,x-r,y-r)||ringHas(outline,x+r,y-r)||ringHas(outline,x+r,y+r)||ringHas(outline,x-r,y+r);};
    const take=(p,parent,id,slot,index,fp,def)=>{
      const l=padLayer(parent,p);if(!onLayer(l,layer,p))return;
      const itemNet=parent&&own(parent.pinNets,p.number)?parent.pinNets[p.number]:p.net||"";if(itemNet!==net)return;
      let pc=padOnLayer(p,parent,layer);if(!pc||p.holeOnly||pc.drill>=Math.min(pc.w,pc.h)-1e-9||(pc.drill>0&&p.plated===false))return;
      const kind=p.kind==="via"?"via":pc.drill>0?"th":"smd";
      if(P.powerPlane&&pc.drill>0)pc=drilledShape(p,pc,P.powerPlane[kind==="via"?"via":"pad"]?.expansion||0);
      if(!reaches(pc))return;
      const key=parent?parent.id+":"+(p.number!=null&&p.number!==""?p.number:"#"+index):id;
      const label=parent?parent.ref+"-"+(p.number||"#"+index):kind==="via"?"Via":"Pad "+(p.number||"");
      visit({P,kind,net,layer,parent,pad:p,index,fp,def,pc,key,label,id,slot});
    };
    for(const i of items||doc.items||[]){
      if(i.kind==="via")take(i,null,i.id,0);
      else if(i.kind==="pad")take(i,null,i.id,0);
      else if(i.kind==="part"){
        const def=defs?.get?.(i.def),fp=def?.footprint;if(!fp)continue;
        (fp.pads||[]).forEach((p,j)=>take({...p,kind:p.kind==="via"?"via":"pad",w:p.w||p.diameter,h:p.h||p.diameter},i,i.id,"pad"+j,j,fp,def));
      }
    }
  }
  // Connect decisions for one polygon without pouring (dialog preview table).
  function connections(doc,defs,polygon,options={}){
    const P=settings(polygon),cx=options.connect||connectContext(doc,defs,options),out=[];
    connectTargets(doc,defs,P,o=>out.push(cx.decide(o)));
    return out;
  }
  function hasConnectRules(rules){
    return (rules?.list||[]).some(r=>r.enabled!==false&&r.type==="polygonConnect"&&
      (r.style&&r.style!=="polygon"||Object.values(r.kinds||{}).some(k=>k.style&&k.style!=="polygon")));
  }
  function variableConnections(s,connectRules){
    return !!s.net&&(s.connectStyle==="auto"||s.viaConnectStyle==="auto"||connectRules);
  }
  // Split-plane slot thermals grow from the two ends of the barrel.
  function spokeOrigin(pc,dir){
    if(!pc.slot)return pc.center;
    return pc.core.reduce((a,b)=>a[0]*dir[0]+a[1]*dir[1]>b[0]*dir[0]+b[1]*dir[1]?a:b);
  }
  // Relief spokes that reach the stored pour, per relief pad (starved thermals).
  function thermals(doc,defs,options={}){
    const pours=doc.pcbDrawing?.pours||[],byPolygon=new Map(),out=[];
    for(const r of pours)if(r.polygon!=null){let l=byPolygon.get(r.polygon);if(!l)byPolygon.set(r.polygon,l=[]);l.push(r);}
    if(!byPolygon.size)return out;
    const cx=options.connect||connectContext(doc,defs,options);
    const inside=(x,y,regs)=>regs.some(g=>{const b=g.bounds;if(x<b[0]||x>b[2]||y<b[1]||y>b[3])return false;
      const rs=rings(g);if(!ringHas(rs[0],x,y))return false;for(let k=1;k<rs.length;k++)if(ringHas(rs[k],x,y))return false;return true;});
    for(const polygon of polygons(doc)){
      const regs=byPolygon.get(polygon.id);if(!regs)continue;
      const P=settings(polygon);
      connectTargets(doc,defs,P,o=>{
        const d=cx.decide(o);if(d.style!=="relief")return;
        const pc=o.pc,base=pc.angle+(d.angle===45?45:0);let connected=0;
        for(let k=0;k<4;k+=d.entries===2?2:1){
          const a=(base+k*90)*Math.PI/180,u=[Math.cos(a),Math.sin(a)];
          const origin=spokeOrigin(pc,u);
          let e=0;for(const q of pc.core)e=Math.max(e,(q[0]-origin[0])*u[0]+(q[1]-origin[1])*u[1]);e+=pc.radius;
          const at=t=>[origin[0]+u[0]*t,origin[1]+u[1]*t];
          const gap=at(e+d.airGap/2),beyond=at(e+d.airGap+Math.max(.05,d.spokeWidth/2));
          if(inside(gap[0],gap[1],regs)&&inside(beyond[0],beyond[1],regs))connected++;
        }
        out.push({polygon:polygon.id,id:o.id,key:o.key,label:o.label,net:o.net,layer:o.layer,component:o.parent?.ref,entries:d.entries,connected,minEntries:d.minEntries,at:pc.center});
      });
    }
    return out;
  }
  function ringHas(r,x,y){
    let ins=false;const n=r.length>>1;
    for(let i=0,j=n-1;i<n;j=i++){const x1=r[2*j],y1=r[2*j+1],x2=r[2*i],y2=r[2*i+1];if((y1>y)!==(y2>y)&&x<x1+(y-y1)*(x2-x1)/(y2-y1))ins=!ins;}
    return ins;
  }

  const CLS={A:0,B:1,O:2,R:3,S:4,P:5};
  const HATCH_MAX=60000,HATCH_SCAN=2000000;
  // pour(doc, defs, polygon, options) -> regions in AtriumPCBPours format,
  // each tagged with `polygon` (the source item id) and `links` (the
  // connectivity keys [id, slot] of same-net copper the island touches).
  // options: {poured:[regions of polygons poured before this one], rules,
  //   clearance, clearanceFor(net, polygonNet, polygon), stats:{}}
  // options.arcs:false keeps polylines only (no true-arc metadata).
  function pour(doc,defs,polygon,options={}){
    const job=prepare(doc,defs,polygon,options);
    if(!job.task)return job.regions;
    return finish(job,CORE.solve(job.task));
  }
  // prepare() gathers the shapes on the main thread (it reads the document,
  // rules and footprints); CORE.solve(job.task) is the pure integer part that
  // the live-pour worker runs; finish() encodes the regions.
  // prepareSteps yields (undefined) every SLICE_CHUNK items when options.slices is set, so live
  // pours can gather a large pour's shapes over several idle slices; prepare() drains it.
  // The polygon outline, the board outline (flat mm) and the box a pour works in (their intersection).
  function workBox(doc,outline){
    const poly=outline.flatMap(p=>[+p[0],+p[1]]);
    const board=Array.isArray(doc.outline)&&doc.outline.length>=3?doc.outline.flatMap(p=>[+p[0],+p[1]]):null;
    let work=boxOf(poly);
    if(board){const b=boxOf(board);work=[Math.max(work[0],b[0]),Math.max(work[1],b[1]),Math.min(work[2],b[2]),Math.min(work[3],b[3])];}
    return {poly,board,work};
  }
  // Journaled item deltas can also reuse the preparation of unaffected
  // objects in an unchanged integer frame. Scoped clearance rules can read other
  // objects, so those rules always evaluate on the complete board.
  function areaPreparationKey(doc,P,options,connect){
    if(!options.area?.sessions||options.keyed||options.items||options.frame||options.traceClearance||
      typeof options.clearanceFor==="function")return null;
    const rules=pourRules(doc,options),K=globalThis.AtriumRules?.kit;
    if(P.clearance==null&&!finite(options.clearance)){
      const scoped=(connect?.compiled?.byType.clearance||rules?.list||[]).some(r=>
        (r.type==null||r.type==="clearance")&&r.enabled!==false&&(!K?.allScope(r.scope)||!K?.allScope(r.scope2)));
      if(scoped)return null;
    }
    return JSON.stringify([P,doc.outline,doc.stackup,rules,options.clearance,options.arcs===false]);
  }
  function prepare(doc,defs,polygon,options={}){const g=prepareSteps(doc,defs,polygon,options);let r=g.next();while(!r.done)r=g.next();return r.value;}
  function* prepareSteps(doc,defs,polygon,options={}){
    const t0=now(),P=settings(polygon),stats=options.stats||{};
    /** @type {ReturnType<typeof encode>[] & {stats?: typeof stats}} */
    const regions=[];regions.stats=stats;
    stats.polygon=P.id;stats.regions=0;
    const done={regions,stats};
    if(P.cutout||P.shelved||!COPPER.test(P.layer))return done;
    const outline=P.outline.filter(p=>Array.isArray(p)&&finite(p[0])&&finite(p[1]));
    if(outline.length<3)return done;
    const net=P.net,tol=P.arcApproximation,layer=P.layer;
    const connect=options.connect||(net?connectContext(doc,defs,options):null);
    const gapFor=clearanceFor(doc,P,{...options,connect,defs,owner:polygon}), trace=options.traceClearance;
    const clearance=trace?(...args)=>{const gap=gapFor(...args);trace(gap);return gap;}:gapFor;
    const shapes=[],anchors=[],uClass=new Map();
    // options.keyed (tile repour): every shape and anchor records the item it comes from
    // ("*" for the polygon, board and hatch); options.items pours only those items and
    // options.noGlobals leaves the polygon-wide shapes out; options.frame fixes the integer frame.
    const keyed=!!options.keyed,subset=options.items||null,globals=!options.noGlobals;let cur="*";
    // options.contrib (exact reuse): collects the ids of the items that gave this pour a shape, an anchor or a connect decision.
    const contrib=options.contrib||null;
    const put=s=>{if(keyed)s.key=cur;if(contrib&&cur!=="*")contrib.add(cur);shapes.push(s);};
    const areaKey=areaPreparationKey(doc,P,options,connect),area=options.area;
    const candidate=options.areaPrevious;
    const sourceRecords=areaKey!=null?new Map():null,sourceDecisions=sourceRecords?new Map():null;
    let reusedItems=0,preparedItems=0;
    const decided=new Map();
    if(connect)connectTargets(doc,defs,P,o=>{
      const id=o.parent?o.parent.id:o.id,d=connect.decide(o);
      if(contrib)contrib.add(id);
      if(sourceDecisions){
        let values=sourceDecisions.get(id);
        if(!values)sourceDecisions.set(id,values=[]);
        values.push(d.key,d.style,d.spokeWidth,d.entries,d.angle,d.airGap);
      }
      decided.set(o.key,d);
    },subset);
    stats.connections=[...decided.values()];
    const {poly,board,work}=workBox(doc,outline);
    if(!(work[0]<work[2]&&work[1]<work[3]))return done;
    // The clearance margin: SAFE, or 1.5 grid units where the frame is coarser than 13 nm (work
    // boxes over about 400 mm), so rounding (under 0.71 units a stage) never eats into a clearance.
    // The frame's scale is estimated from the polygon, the board and the work box; when the shapes
    // reach further, the pour is prepared again with the margin of the frame they need.
    const safe=(()=>{
      if(options.frame)return Math.max(SAFE,1.5/options.frame.S);
      const cx=(work[0]+work[2])/2,cy=(work[1]+work[3])/2;let e=1;
      for(const f of board?[poly,board]:[poly]){const b=boxOf(f);e=Math.max(e,Math.abs(b[0]-cx),Math.abs(b[2]-cx),Math.abs(b[1]-cy),Math.abs(b[3]-cy));}
      if(!keyed)e=Math.max(e,(work[2]-work[0])/2+CLIP_MM,(work[3]-work[1])/2+CLIP_MM);
      return Math.max(SAFE,options.safeMm||0,1.5/Math.min(1e5,LIMIT/e));
    })();
    const ox=options.frame?options.frame.ox:(work[0]+work[2])/2,oy=options.frame?options.frame.oy:(work[1]+work[3])/2;
    // A coarse grid can also retain the prepared copper. Its margin and
    // origin must match, and the resulting scale is checked before using any integer shapes.
    const previous=areaKey!=null&&candidate?.key===areaKey&&candidate.safe===safe&&candidate.ox===ox&&candidate.oy===oy&&
      Array.isArray(area.dirtyBoxes)&&area.changedItems instanceof Set&&
      (!candidate.arcs||candidate.arcs.length<=2*(candidate.initialArcLength+192))?candidate:null;
    // Keeping the previous catalog numbers preserves arc identity between
    // cached shapes. Freshly gathered objects append distinct arcs.
    const arcSink=options.arcs===false?null:previous?.arcs?.slice()||[];
    const near=b=>areaOverlaps(b,work);
    const add=(cls,flat)=>{if(flat&&flat.length>=6)put({cls,flat,av:flat.av});};
    if(globals){put({cls:CLS.A,flat:poly});if(board)put({cls:CLS.B,flat:board});}
    const reach=options.ruleReach||ruleReach(pourRules(doc,options),options);
    const maxRule=finite(options.clearance)?options.clearance:P.clearance??reach.gap;
    const maxRelief=reliefReach(P,reach);
    const samePolygonNet=n=>!!net&&n===net;
    // SAFE (20 nm) covers rounding to the 10 nm integer grid, so measured
    // clearance is never below the rule.
    function obstacle(core,radius,c){
      if(trace)return;
      const flat=rounded(core,radius+c+(c>0?safe:0),tol,"outer",arcSink);
      if(flat&&near(boxOf(flat)))add(CLS.O,flat);
    }
    function anchor(core,radius,link,raw){
      if(trace)return;
      const flat=raw||rounded(core,radius+.002,tol,"outer");
      if(flat&&near(boxOf(flat))){if(contrib&&cur!=="*")contrib.add(cur);anchors.push({flat,link,key:cur});}
    }
    function path(item,itemNet,link,keepout,parent){
      const arc=pathArc(item),{fill}=item,closed=!!item.closed&&!arc,w=Math.max(0,+item.width||0);
      if(!w&&!(fill&&closed))return;
      const same=!keepout&&samePolygonNet(itemNet),radius=w/2+(arc?TRACK_CHORD_ERROR:0);
      const kind=fill&&closed?item?.fillRect?"fill":"region":item?.arc?"arc":"track";
      const gap=core=>item?.planeVoid?0:clearance(keepout?"":itemNet||"",kind,item,parent,core[0],core,w/2);
      const reach=arc?(radius+safe+TOUCH+Math.max(0,finite(maxRule)?maxRule:gap(item.points)))/Math.cos(Math.PI/256)+tol+TRACK_CHORD_ERROR:w+maxRule*2+1;
      for(const pts of pathRuns(item,parent,arc,clipBox(work,reach))){
        if(!arc&&!near(clipBox(Atrium.bounds(pts),reach)))continue;
        const close=closed&&pts.length>2,filled=fill&&close,avoid=!same||!P.pourOverSameNet;
        const c=filled&&avoid?gap(pts):0;
        for(let i=1;i<pts.length+Number(close);i++){
          const s=[pts[i-1],pts[i%pts.length]];
          if(same&&w>0)anchor(s,w/2,link);
          if(avoid&&(w>0||filled))obstacle(s,radius,filled?c:gap(s));
        }
        if(!filled)continue;
        let flat=pts.flat();if(same)anchor(null,0,link,flat);
        if(!avoid)continue;
        if(signedArea(flat)<0)flat=reversed(flat);
        const ring=offsetRing(flat,radius+c+(c>0?safe:0),tol,arcSink);
        if(ring&&near(boxOf(ring)))put({cls:CLS.O,flat:ring,av:ring.av,oriented:true});
      }
    }
    function relief(pc,d,link){
      const airGap=d.airGap,reach=Math.hypot(pc.w,pc.h)/2+airGap+Math.max(d.spokeWidth,airGap)+.05;
      add(CLS.R,rounded(pc.core,pc.radius+airGap,tol,"outer",arcSink));
      const pad=rounded(pc.core,pc.radius,tol,"inner");
      if(pad){
        if(P.powerPlane){
          // A negative plane has no separate land flash. The inner contour of
          // its thermal aperture is copper, including the mouth of the barrel.
          put({cls:CLS.R,flat:signedArea(pad)>0?reversed(pad):pad,oriented:true});
        }else add(CLS.P,pad);
      }
      const cw=d.spokeWidth/2,base=pc.angle+(d.angle===45?45:0);
      for(let k=0;k<4;k+=d.entries===2?2:1){
        const angle=base+k*90,dir=angle?Atrium.rotate([1,0],angle):[1,0],origin=spokeOrigin(pc,dir);
        const frame={x:origin[0],y:origin[1],angle};
        add(CLS.S,[[0,-cw],[reach,-cw],[reach,cw],[0,cw]].flatMap(q=>world(q[0],q[1],frame)));
      }
      anchor(pc.core,pc.radius,link);
    }
    function pad(p,parent,link,index){
      const {padLayer,onLayer}=appearance(),layerName=padLayer(parent,p);
      if(!onLayer(layerName,layer,p))return;
      let pc=padOnLayer(p,parent,layer);if(!pc)return;
      const extent=Math.max(pc.w,pc.h,+p.slotLength||0)+maxRule*2+maxRelief+2;
      if(!near(clipBox([...pc.center,...pc.center],extent)))return;
      const itemNet=parent&&own(parent.pinNets,p.number)?parent.pinNets[p.number]:p.net||"";
      const hole=p.holeOnly||pc.drill>=Math.min(pc.w,pc.h)-1e-9;
      if(P.powerPlane&&pc.drill>0){
        const joined=!hole&&p.plated!==false&&samePolygonNet(itemNet);
        pc=drilledShape(p,pc,joined?P.powerPlane[p.kind==="via"?"via":"pad"]?.expansion||0:0);
        if(!joined){obstacle(pc.core,pc.radius,clearance(itemNet||"","hole",p,parent,pc.center,pc.core,pc.radius));return;}
      }
      if(hole||(pc.drill>0&&p.plated===false)){
        const drill=drilledShape(p,pc),c=clearance("","hole",p,parent,pc.center,drill.core,drill.radius);
        obstacle(drill.core,drill.radius,c);
        if(!hole)obstacle(pc.core,pc.radius,clearance(""));
        return;
      }
      const isVia=p.kind==="via";
      if(samePolygonNet(itemNet)){
        const key=parent?parent.id+":"+(p.number!=null&&p.number!==""?p.number:"#"+index):link[0];
        const d=decided.get(key)||{style:isVia?"direct":"relief",spokeWidth:P.reliefConductorWidth,entries:P.reliefEntries,angle:P.reliefAngle,airGap:P.reliefAirGap};
        if(d.style==="relief")relief(pc,d,link);
        else if(d.style==="none")obstacle(pc.core,pc.radius,clearance(itemNet,isVia?"via":pc.drill>0?"th":"smd",p,parent,pc.center,pc.core,pc.radius));
        else anchor(pc.core,pc.radius,link);
        return;
      }
      obstacle(pc.core,pc.radius,clearance(itemNet,isVia?"via":pc.drill>0?"th":"smd",p,parent,pc.center,pc.core,pc.radius));
    }
    function text(x,y,angle,size,str,itemNet,item,frame){
      const s=+size||.75,w=String(str||"").length*s*.65;if(!(w>0))return;
      const f={x,y,angle:angle||0},local=[[0,-s],[w,-s],[w,.2*s],[0,.2*s]].map(q=>world(q[0],q[1],f));
      const core=frame?local.map(q=>world(q[0],q[1],frame)):local;
      obstacle(core,0,clearance(itemNet||"","text",item,frame,core[0],core));
    }
    const isKeepout=l=>/^keep-?out/i.test(l||"");
    let tick=0;
    for(const i of subset||doc.items||[]){
      if(options.slices&&++tick%SLICE_CHUNK===0)yield;
      const id=i.id;cur=id;
      const old=previous?.sources.get(id),def=sourceRecords&&i.kind==="part"?defs?.get?.(i.def):null;
      const footprint=def?.footprint,decision=sourceDecisions?.has(id)?JSON.stringify(sourceDecisions.get(id)):null;
      if(old&&!sourceRecords.has(id)&&old.item===i&&old.def===def&&old.footprint===footprint&&old.decision===decision&&!area.changedItems.has(id)){
        for(const s of old.shapes)shapes.push(s);
        for(const a of old.anchors)anchors.push(a);
        sourceRecords.set(id,old);reusedItems++;
        continue;
      }
      const shapeStart=shapes.length,anchorStart=anchors.length;
      switch(i.kind){
        case "track":case "graphic":{
          if(i.sourcePour!=null&&i.sourcePour===P.id||((i.keepout||isKeepout(i.layer))&&!Atrium.keepoutBlocks(i,"copper")))break;
          if(i.layer===layer)path(i,i.net||"",[id,0],!!i.keepout);
          else if(isKeepout(i.layer))path(i,"",null,true);
          break;
        }
        case "via":pad(i,null,[id,0]);break;
        case "pad":pad(i,null,[id,0]);break;
        case "label":if(i.layer===layer)text(i.x,i.y,i.angle,i.size,i.text,"",i);break;
        case "polygon":{
          if(i.id!==P.id&&i.cutout&&(i.layer===layer||i.layer==="Multi")){
            const pts=outlineOf(i);if(pts.length>=3)add(CLS.O,pts.flatMap(p=>[+p[0],+p[1]]));
          }
          break;
        }
        case "part":{
          const fp=defs?.get?.(i.def)?.footprint;if(!fp)break;
          (fp.pads||[]).forEach((p,j)=>pad({...p,kind:p.kind==="via"?"via":"pad",w:p.w||p.diameter,h:p.h||p.diameter},i,[id,"pad"+j],j));
          (fp.shapes||[]).forEach((s,j)=>{
            const l=s.layer||(s.style==="package"?"Mechanical":s.style==="silk"?"Silk":i.layer||"Top");
            const allKeep=isKeepout(l),keep=allKeep||s.keepout===true;
            if(l!==layer&&!allKeep&&!(s.cutout&&l==="Multi"))return;
            if(s.cutout){
              if(s.points?.length>=3)add(CLS.O,s.points.flatMap(p=>world(p[0],p[1],i)));
              return;
            }
            if(keep&&!Atrium.keepoutBlocks(s,"copper"))return;
            const link=[id,"shape"+j],sNet=keep?"":s.net||"";
            if(s.kind==="path")path(s,sNet,link,keep,i);
            else if(s.kind==="circle"){
              const c=world(s.x,s.y,i),r=(+s.r||0)+(+s.width||0)/2;
              if(samePolygonNet(sNet)){anchor([c],r,link);if(P.pourOverSameNet)return;}
              obstacle([c],r,keep?clearance(""):clearance(sNet,s.fill?"region":"track",s,i,c));
            }else if(s.kind==="text"&&!keep)text(s.x,s.y,s.angle,s.size,s.text,sNet,s,i);
          });
          break;
        }
      }
      if(sourceRecords){
        sourceRecords.set(id,{item:i,def,footprint,decision,shapeStart,shapeEnd:shapes.length,anchorStart,anchorEnd:anchors.length});
        preparedItems++;
      }
    }
    if(trace)return done; // Only the actual clearance decisions were requested.
    cur="*";
    // Polygons poured earlier (lower pour index) on this layer and another net.
    // Keyed (tile) pours list them instead: the tile engine clears them from their tiles.
    const earlier=[];
    if(keyed)for(const q of options.earlier||[]){
      if(q.layer!==layer||q.id===P.id||(net&&(q.net||"")===net))continue;
      earlier.push({id:q.id,c:clearance(q.net||"","poly",q)});
    }
    // Untiled pours clear the earlier copper in a second stage (earlierSteps, stage2Steps): the
    // task built here is stage 1, the pour less every object, which reads no other pour.
    // Hatched fill (flex regions): a grid of square openings leaves copper
    // lines of hatchWidth at hatchPitch, rotated by hatchAngle. Only cells
    // over the work box are visited, and only cells whose opening can reach
    // the pour are added. Every opening is a hole of the poured region, and a
    // region holds at most 65535 holes (pcbDrawing.pours), so a pour needing
    // more than HATCH_MAX openings is poured solid with a loud warning: the
    // stats and every region carry hatchSkipped, the pour dialog and the
    // Flex Copper Hatching DRC report it.
    if(globals&&P.fillMode==="hatched"){
      const p=P.hatchPitch,h=(p-P.hatchWidth)/2,a=P.hatchAngle*Math.PI/180,c=Math.cos(a),sn=Math.sin(a);
      const cx=(work[0]+work[2])/2,cy=(work[1]+work[3])/2;
      const U=(x,y)=>(x-cx)*c+(y-cy)*sn,V=(x,y)=>-(x-cx)*sn+(y-cy)*c;
      const cs=[[work[0],work[1]],[work[2],work[1]],[work[2],work[3]],[work[0],work[3]]];
      const us=cs.map(q=>U(q[0],q[1])),vs=cs.map(q=>V(q[0],q[1]));
      const i0=Math.floor((Math.min(...us)-p)/p)-1,i1=Math.ceil((Math.max(...us)+p)/p),j0=Math.floor((Math.min(...vs)-p)/p)-1,j1=Math.ceil((Math.max(...vs)+p)/p);
      const r=h*Math.SQRT2,pb=boxOf(poly);
      const cells=[];let over=false;
      for(let i=i0;i<=i1&&!over;i++)for(let j=j0;j<=j1;j++){
        const u=i*p+p/2,v=j*p+p/2,x=cx+u*c-v*sn,y=cy+u*sn+v*c;
        if(x<work[0]-r||x>work[2]+r||y<work[1]-r||y>work[3]+r||x<pb[0]-r||x>pb[2]+r||y<pb[1]-r||y>pb[3]+r)continue;
        cells.push(x,y);
        if(cells.length>2*HATCH_SCAN){over=true;break;}
      }
      // Openings wholly outside the outline are no holes: count the inside
      // ones before giving up on a large or irregular pour.
      let holes=cells.length/2;
      if(holes>HATCH_MAX&&!over){holes=0;for(let k=0;k<cells.length;k+=2)if(ringHas(poly,cells[k],cells[k+1]))holes++;}
      if(over||holes>HATCH_MAX){
        stats.hatchSkipped=true;stats.hatchOpenings=over?Infinity:holes;
        stats.warning="Hatched pour needs "+(over?"over "+HATCH_SCAN:holes)+" openings, above the "+HATCH_MAX+" a poured region can hold: poured SOLID. Split the polygon or use a larger grid size.";
      }else for(let k=0;k<cells.length;k+=2){
        const x=cells[k],y=cells[k+1],q=[];
        for(const [du,dv] of [[-h,-h],[h,-h],[h,h],[-h,h]])q.push(x+du*c-dv*sn,y+du*sn+dv*c);
        add(CLS.O,q);
      }
    }
    if(globals&&board&&P.boardClearance>0){
      const n=board.length>>1;
      for(let i=0;i<n;i++){const j=(i+1)%n;obstacle([[board[2*i],board[2*i+1]],[board[2*j],board[2*j+1]]],0,P.boardClearance);}
    }
    // Board cutouts (AtriumBoardShape.holes) are removed from the pour, with the board clearance around them.
    for(const h of globals?(()=>{try{return globalThis.AtriumBoardShape?.holes?.(doc)||[];}catch{return [];}})():[]){
      if(h.length<3)continue;const flat=h.flatMap(p=>[+p[0],+p[1]]);if(!near(boxOf(flat)))continue;add(CLS.O,flat);
      if(P.boardClearance>0)for(let i=0;i<h.length;i++)obstacle([h[i],h[(i+1)%h.length]],0,P.boardClearance);
    }
    // Integer frame: 10 nm resolution unless the geometry is too large
    // for exact 2^24 coordinates.
    let extent=1;
    // The frame and the integer shapes: in chunks too (a large pour has tens of thousands of shapes).
    for(const s of shapes){
      if(options.slices&&++tick%SLICE_CHUNK===0)yield;
      const b=s.areaBox||boxOf(s.flat);
      if(sourceRecords)s.areaBox=b;
      extent=Math.max(extent,Math.abs(b[0]-ox),Math.abs(b[2]-ox),Math.abs(b[1]-oy),Math.abs(b[3]-oy));
    }
    // Stage 2 clears earlier copper clipped to the work box plus CLIP_MM (clipBox): the frame holds that
    // box too, so it is fixed before any earlier pour is known.
    if(!keyed)extent=Math.max(extent,(work[2]-work[0])/2+CLIP_MM,(work[3]-work[1])/2+CLIP_MM);
    // A fixed frame (tile updates) holds only while the new shapes fit it.
    if(options.frame&&extent>options.frame.extent)return {...done,frameOverflow:true};
    const S=options.frame?options.frame.S:Math.min(1e5,LIMIT/extent),toInt=v=>Math.round(v*S);
    if(previous&&S!==previous.S)return yield* prepareSteps(doc,defs,polygon,{...options,areaPrevious:null});
    if(1.5/S>safe*(1+1e-9)){const again=yield* prepareSteps(doc,defs,polygon,{...options,safeMm:1.5/S*1.01});return again;}
    const input=[];
    for(const s of shapes){
      if(options.slices&&++tick%SLICE_CHUNK===0)yield;
      const e="areaInteger" in s?s.areaInteger:intShape(s,S,ox,oy);
      if(sourceRecords)s.areaInteger=e;
      if(!e)continue;if(keyed)e.key=s.key;input.push(e);
    }
    const K=6+uClass.size,hasBoard=!!board;
    // Dead copper: islands must touch a same-net object on this layer.
    const final={removeDead:!!(P.removeDeadCopper&&net),minArea:P.islandAreaThreshold*S*S,minSize:P.minPrimLength*S,
      anchors:anchors.map(a=>{
        if(a.areaRing)return a.areaRing;
        const ring=new Int32Array(a.flat.length);
        for(let i=0;i<a.flat.length;i+=2){ring[i]=toInt(a.flat[i]-ox);ring[i+1]=toInt(a.flat[i+1]-oy);}
        if(sourceRecords)a.areaRing=ring;
        return ring;
      })};
    // Remove Necks / Outlines Only (PourCore shapeIslands) on the final copper of an untiled pour.
    if(!keyed){const m=morphOf(P,S,input);if(m)final.morph=m;}
    // Tiled pours solve in one stage; untiled ones in two: this task leaves the island tests to stage 2.
    const task=keyed?{shapes:input,K,hasBoard,...final}:{shapes:input,K,hasBoard,removeDead:false,minArea:0,minSize:0,anchors:[]};
    const job={regions,stats,task,P,layer,net,S,ox,oy,arcs:arcSink,links:anchors.map(a=>a.link),tPrepare:now()-t0};
    if(area?.sessions)job.areaExact=true;
    if(sourceRecords){
      for(const r of sourceRecords.values()){
        if(r.shapes)continue;
        r.shapes=shapes.slice(r.shapeStart,r.shapeEnd).map(s=>({areaBox:s.areaBox,areaInteger:s.areaInteger}));
        r.anchors=anchors.slice(r.anchorStart,r.anchorEnd).map(a=>({link:a.link,areaRing:a.areaRing}));
      }
      job.areaPrepared={key:areaKey,S,ox,oy,safe,sources:sourceRecords,arcs:arcSink,initialArcLength:previous?.initialArcLength??arcSink?.length??0};
      stats.preparedItems={rebuilt:preparedItems,reused:reusedItems};
    }
    if(keyed){job.anchorKeys=anchors.map(a=>a.key);job.earlier=earlier;job.work=work;job.extent=extent;job.tol=tol;}
    else{job.final=final;job.clear={clearance,tol,work};if(options.poured?.length)job.poured=options.poured;}
    return job;
  }
  // The template of Remove Necks and Outlines Only (PourCore shapeIslands): a regular polygon of k
  // vertices (k a multiple of 4, so two of its sides face each axis) whose narrowest width is 2r
  // grid units, k from the arc approximation tol. Symmetric about the origin by construction (the
  // second half is the first negated), counter-clockwise. Made here, with Math.cos, and passed in the
  // task as integers: every core reads the same template.
  function discTemplate(r,tol,k=0){
    if(!k){k=8;while(k<64&&r/Math.cos(Math.PI/k)*(1-Math.cos(Math.PI/k))>tol)k+=4;}
    const R=r/Math.cos(Math.PI/k),t=new Int32Array(2*k),h=k/2;
    for(let i=0;i<h;i++){const a=Math.PI/k+TAU*i/k,x=Math.round(R*Math.cos(a)),y=Math.round(R*Math.sin(a));t[2*i]=x;t[2*i+1]=y;t[2*(i+h)]=-x;t[2*(i+h)+1]=-y;}
    return {t,k};
  }
  // NECK_MIN: narrower neck widths (mm) are ignored. The relief spokes are kept (counter-clockwise).
  const NECK_MIN=.01,NECK_MAX=5;
  function morphOf(P,S,input){
    const outline=P.fillMode==="outline",neck=P.fillMode==="solid"&&P.neckWidth>=NECK_MIN;
    if(!outline&&!neck)return null;
    const r=(outline?P.hatchWidth:P.neckWidth/2)*S,tol=Math.max(1,P.arcApproximation*S);
    if(!(r>=4))return null;
    const keep=[];
    for(const s of input){
      if(s.cls!==4)continue;
      const a=area2(s.ring)*s.sign;if(!(a>0))continue;
      keep.push(area2(s.ring)>0?s.ring:Int32Array.from(reversed(Array.from(s.ring))));
    }
    const {t,k}=discTemplate(r,tol);
    return outline?{mode:2,t,keep}:{mode:1,t,u:discTemplate(r+3,tol,k).t,keep};
  }
  // A shape in the integer frame (S units per mm, origin ox, oy): repeated vertices dropped, edge
  // tags from the arc ids of its vertices (s.av), null when it has no area left.
  function intShape(s,S,ox,oy){
    const n=s.flat.length>>1,ring=[],av=s.av,tags=av?[]:null;
    for(let i=0;i<n;i++){
      const x=Math.round((s.flat[2*i]-ox)*S),y=Math.round((s.flat[2*i+1]-oy)*S),k=ring.length;
      const tag=av?(av[i]>=0&&av[i]===av[i+1===n?0:i+1]?av[i]:-1):-1;
      if(k&&ring[k-2]===x&&ring[k-1]===y){if(tags)tags[tags.length-1]=tag;continue;}
      ring.push(x,y);if(tags)tags.push(tag);
    }
    while(ring.length>=4&&ring[0]===ring[ring.length-2]&&ring[1]===ring[ring.length-1]){ring.length-=2;if(tags)tags.pop();}
    if(ring.length<6)return null;
    const a=area2(ring);if(!a)return null;
    // Shapes are normalized so their interior winds +1. Offset rings keep
    // their orientation: holes and reflex loops must keep their winding.
    return {cls:s.cls,ring:Int32Array.from(ring),sign:s.oriented?1:a>0?1:-1,tags:tags&&tags.some(t=>t>=0)?Int32Array.from(tags):null};
  }
  // ------------------------------------------------------- two-stage pours
  // Stage 1 (prepare's task) is the pour less every object; it reads no other pour, so every
  // pour's stage 1 can solve at once. Stage 2 clears the copper of earlier pours (same layer,
  // another net, near) from stage 1's islands and runs the island tests (dead copper, area, size).
  // Earlier copper is offset by its clearance and clipped to the work box plus CLIP_MM: the pour
  // lies inside the work box, so the clip changes nothing there but where grid snapping of the
  // overlay lands (nanometres), and a large earlier pour stops costing its whole outline.
  const CLIP_MM=.05;
  const clipBox=(w,margin=CLIP_MM)=>[w[0]-margin,w[1]-margin,w[2]+margin,w[3]+margin];
  // Sutherland-Hodgman against a box: the part of ring `flat` (mm) inside box b, with the arc ids
  // of its vertices (new vertices on the box: -1). Winding inside the box is kept ring by ring.
  function clipRing(flat,av,b){
    const fb=boxOf(flat);
    if(fb[0]>=b[0]&&fb[1]>=b[1]&&fb[2]<=b[2]&&fb[3]<=b[3])return {flat,av};
    if(fb[0]>b[2]||fb[2]<b[0]||fb[1]>b[3]||fb[3]<b[1])return null;
    let P=flat,A=av||null;
    for(let side=0;side<4;side++){
      const n=P.length>>1;if(n<3)return null;
      // side 0: x >= b[0], 1: y >= b[1], 2: x <= b[2], 3: y <= b[3].
      const axis=side&1,lim=b[side],lower=side<2,out=[],oa=A?[]:null;
      const inside=k=>lower?P[2*k+axis]>=lim:P[2*k+axis]<=lim;
      for(let i=0;i<n;i++){
        const h=(i+n-1)%n,ci=inside(i),hi=inside(h);
        if(ci!==hi){
          const ax=P[2*h],ay=P[2*h+1],bx=P[2*i],by=P[2*i+1],t=((axis?ay:ax)-lim)/((axis?ay:ax)-(axis?by:bx));
          if(axis)out.push(ax+t*(bx-ax),lim);else out.push(lim,ay+t*(by-ay));
          if(oa)oa.push(-1);
        }
        if(ci){out.push(P[2*i],P[2*i+1]);if(oa)oa.push(A[i]);}
      }
      P=out;A=oa;
    }
    return P.length>=6?{flat:P,av:A}:null;
  }
  // The earlier copper stage 2 clears, as integer shapes in the job's frame (classes 6.. per
  // earlier pour), and the arc list extended by its offsets. Yields between earlier regions.
  function* earlierSteps(job,poured,offsets){
    const {P,layer,net}=job,{clearance,tol,work}=job.clear,box=clipBox(work),uClass=new Map(),shapes=[];
    const near=b=>b[0]<=work[2]&&b[2]>=work[0]&&b[1]<=work[3]&&b[3]>=work[1];
    const arcs=job.arcs?job.arcs.slice():null;
    const offsetKey=offsets?[...box,job.S,job.ox,job.oy,tol,!!arcs].join(","):"";
    let rebuilt=0,reused=0;
    const offsetShape=(ring,k,c,cls,sink)=>{
      let flat=Array.from(ring);
      if((signedArea(flat)<0)!==(k>0))flat=reversed(flat);
      const out=offsetRing(flat,c+(c>0?Math.max(SAFE,1.5/job.S):0),tol,sink);
      const cut=out&&clipRing(out,out.av,box);
      return cut&&intShape({cls,flat:cut.flat,av:cut.av,oriented:true},job.S,job.ox,job.oy);
    };
    for(const r of poured||[]){
      yield;
      earlierRingsOf(r,P,layer,net,near,clearance,tol,(tag,ring,k,c)=>{
        if(!uClass.has(tag))uClass.set(tag,6+uClass.size);
        const cls=uClass.get(tag);
        // A hole no wider than 2c is filled by the offset (each of its points is within half its
        // box's smaller side of its boundary): skip it, and the fan its offset ring would make.
        if(k>0){const b=offsets?areaRingInfo(ring).box:boxOf(ring);if(Math.min(b[2]-b[0],b[3]-b[1])/2<=c)return;}
        if(!offsets){
          const shape=offsetShape(ring,k,c,cls,arcs);
          if(shape)shapes.push(shape);
          return;
        }
        const key=offsetKey+","+c+","+(k>0),old=offsets?.get(ring);
        let entry=old?.key===key?old:null;
        if(entry)reused++;
        else{
          const localArcs=arcs?[]:null,shape=offsetShape(ring,k,c,cls,localArcs);
          entry={key,shape,arcs:localArcs};rebuilt++;
          offsets.set(ring,entry);
        }
        const base=arcs?arcs.length/3:0;
        if(arcs)for(const x of entry.arcs)arcs.push(x);
        if(!entry.shape)return;
        if(!entry.present||entry.present.cls!==cls||entry.base!==base){
          const {shape}=entry,tags=shape.tags&&Int32Array.from(shape.tags,t=>t<0?t:t+base);
          if(tags){const {ids,pattern}=areaTagInfo(shape.tags);areaTagMemo.set(tags,{ids:ids.map(id=>id+base),pattern});}
          entry.present={...shape,cls,tags};entry.base=base;
        }
        shapes.push(entry.present);
      });
    }
    return {shapes,K:6+uClass.size,arcs,preparedOffsets:offsets?{rebuilt,reused}:null};
  }
  // Stage 2 of `job` given stage 1's solution and the earlier regions it may read (in pour order):
  // {job, task} to solve (job: the job finish() encodes with), or {job, solved} at once when no
  // earlier copper reaches the pour. Yields between earlier regions.
  // kept (area sessions): {cache} of areaKeep, read and replaced.
  function* stage2Steps(job,solved1,poured,own=false,offsets,kept){
    const t0=now(),e=yield* earlierSteps(job,poured,offsets),stats=own?job.stats:{...job.stats},regions=own?job.regions:[];regions.stats=stats;
    if(e.preparedOffsets)stats.preparedOffsets=e.preparedOffsets;
    const job2={...job,regions,stats,arcs:e.arcs,tPrepare:(job.tPrepare||0)+(now()-t0)};
    // Remove Necks / Outlines Only go through solve() (the Rust core where it is loaded; the overlay of the islands alone gives them back).
    if(!e.shapes.length&&!job.final.morph){
      const r=kept&&job.areaExact?areaKeep({islands:solved1.islands,stats:{edges:0,merged:0,passes:0,faces:0,rays:0,tPlanar:0,tMerge:0,tClassify:0,tTrace:0,tIslands:0}},job.final,kept.cache):null;
      if(kept)kept.cache=r?.cache||null;
      return {job:job2,solved:r?r.solved:CORE.keepSolved(solved1,job.final,!!job.areaExact),stage1:solved1.stats};
    }
    if(kept)kept.cache=null;
    const shapes=[];
    for(const isl of solved1.islands){shapes.push({cls:0,ring:isl.ring,sign:1,tags:isl.tags});for(const h of isl.holes)shapes.push({cls:0,ring:h.ring,sign:1,tags:h.tags});}
    for(const s of e.shapes)shapes.push(s);
    return {job:job2,task:{shapes,K:e.K,hasBoard:false,...job.final},stage1:solved1.stats};
  }

  // Exact local overlay for settled copper. Complete rings enter the existing
  // integer solver, so there are no tile seams or clipped arc edges in the fill.
  // The widest ordinary split moves an input edge by less than one grid unit.
  // Four units between the patch and an omitted edge also separate the split
  // edges in the second planarity check. Global snap rounding needs a full solve.
  // Why a patch equals a full solve (byte for byte, after canonical()): the region (areaRegion) holds
  // every changed input, old and new, and every input whose boundary comes within AREA_GUARD of it, so
  // no input inside meets one outside and the arrangement splits in two. Outside the region the inputs
  // and their winding are the old ones (a changed ring has no winding outside its own box, which the
  // region holds), so the old rings made of outside inputs are still right; inside, the overlay of the
  // inside inputs with the constant winding of the outside ones gives the new rings. Edge order within
  // the inside inputs is the task's, so every crossing is rounded as the full solve rounds it. Islands,
  // links and the island tests are then decided by the rules of CORE.islands and keep(), asked only
  // where their answer can have changed (areaPatch, areaKeep). tests/pcb/pour-area-random.cjs checks it.
  const AREA_GUARD=4,AREA_LIMIT=.5,areaRingMemo=new WeakMap(),areaTagMemo=new WeakMap();
  const areaCanonical=new WeakMap(),areaCanonicalIslands=new WeakMap(),areaArcRotation=new WeakMap(),areaConverted=new WeakMap(),areaRegionContours=new WeakMap();
  function areaRingInfo(ring){
    let info=areaRingMemo.get(ring);
    if(!info){info={box:boxOf(ring)};areaRingMemo.set(ring,info);}
    return info;
  }
  const areaOf=b=>(b[2]-b[0])*(b[3]-b[1]);
  const areaOverlaps=(a,b)=>a[0]<=b[2]&&a[1]<=b[3]&&a[2]>=b[0]&&a[3]>=b[1];
  const areaEncloses=(a,b,g)=>a[0]+g<b[0]&&a[1]+g<b[1]&&a[2]-g>b[2]&&a[3]-g>b[3];
  const areaJoin=(a,b)=>a?[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])]:b.slice();
  function areaFrameBox(b,job){
    const {ox,oy,S}=job;
    return [Math.floor((b[0]-ox)*S),Math.floor((b[1]-oy)*S),Math.ceil((b[2]-ox)*S),Math.ceil((b[3]-oy)*S)];
  }
  function ordinaryOverlay(stats){
    return stats?.passes<=2&&!stats.unresolved&&!stats.brokenRings&&!stats.faceFallback;
  }
  // Compare full input geometry and the authored arc identities. Local ordinals
  // preserve distinct arcs even if they describe coincident circles. The mapping
  // between two runs' arc tables must be one-to-one for the retained inputs.
  function areaTagInfo(tags){
    if(!tags)return {ids:[],pattern:""};
    let info=areaTagMemo.get(tags);
    if(info)return info;
    const ids=[],ordinals=new Map();let pattern="";
    for(const tag of tags){
      if(tag<0){pattern+="-,";continue;}
      if(!ordinals.has(tag)){ordinals.set(tag,ids.length);ids.push(tag);}
      pattern+=ordinals.get(tag)+",";
    }
    info={ids,pattern:ids.length?pattern:""};
    areaTagMemo.set(tags,info);
    return info;
  }
  function areaInputs(task,arcs){
    const groups=new Map(),records=[];let primitives=0,indexedPrimitives=0;
    for(const shape of task.shapes){
      const info=areaRingInfo(shape.ring),{ids:arcIds,pattern}=areaTagInfo(shape.tags);
      if(info.key==null){info.key=shape.ring.join(",");indexedPrimitives+=shape.ring.length/2;}
      // The key is built again only when the class, sign, tags or the values of their arcs differ
      // from the ones it was built with (the same values give the same text).
      const v=info.arcValues;
      let same=!!v&&info.tags===shape.tags&&info.cls===shape.cls&&info.sign===shape.sign&&v.length===3*arcIds.length;
      for(let i=0;same&&i<arcIds.length;i++){const t=3*arcIds[i];same=v[3*i]===arcs[t]&&v[3*i+1]===arcs[t+1]&&v[3*i+2]===arcs[t+2];}
      if(!same){
        let arcKey=pattern+";";const values=new Array(3*arcIds.length);
        arcIds.forEach((tag,i)=>{arcKey+=arcs[3*tag]+","+arcs[3*tag+1]+","+arcs[3*tag+2]+";";values[3*i]=arcs[3*tag];values[3*i+1]=arcs[3*tag+1];values[3*i+2]=arcs[3*tag+2];});
        const variant=shape.cls+":"+shape.sign+":"+arcKey;
        if(info.variant!==variant){info.variant=variant;info.shapeKey=variant+":"+info.key;}
        Object.assign(info,{arcValues:values,tags:shape.tags,cls:shape.cls,sign:shape.sign});
      }
      const key=info.shapeKey;
      const record={shape,arcIds,box:info.box,k:records.length};
      let group=groups.get(key);
      if(!group)groups.set(key,group=[]);
      group.push(record);records.push(record);primitives+=shape.ring.length/2;
    }
    return {groups,records,primitives,indexedPrimitives};
  }
  // The changed records (old ones gone, new ones added) and, when any kept input's arcs moved to other
  // ids (shifted), the map from old to new ids. Without a shift every kept ring keeps its tags.
  function areaDifference(old,next){
    const changed=[];let shifted=false;
    const sameIds=(a,b)=>{if(a===b)return true;if(a.length!==b.length)return false;for(let k=0;k<a.length;k++)if(a[k]!==b[k])return false;return true;};
    for(const [key,records] of old.groups){
      const newer=next.groups.get(key),n=newer?Math.min(records.length,newer.length):0;
      for(let i=0;!shifted&&i<n;i++)if(!sameIds(records[i].arcIds,newer[i].arcIds))shifted=true;
      for(let i=n;i<records.length;i++)changed.push(records[i]);
    }
    for(const [key,records] of next.groups){
      const n=old.groups.get(key)?.length||0;
      for(let i=n;i<records.length;i++)changed.push(records[i]);
    }
    if(!shifted)return {changed,arcMap:null,reverse:null,shifted};
    const maps=areaArcMaps(old,next);
    return maps&&{changed,...maps,shifted};
  }
  // The map from old to new arc ids over the inputs both runs have, one to one (null if it is not).
  function areaArcMaps(old,next){
    const arcMap=new Map(),reverse=new Map();
    for(const [key,records] of old.groups){
      const newer=next.groups.get(key)||[],n=Math.min(records.length,newer.length);
      for(let i=0;i<n;i++){
        const a=records[i].arcIds,b=newer[i].arcIds;
        for(let k=0;k<a.length;k++){
          if(arcMap.has(a[k])&&arcMap.get(a[k])!==b[k]||reverse.has(b[k])&&reverse.get(b[k])!==a[k])return null;
          arcMap.set(a[k],b[k]);reverse.set(b[k],a[k]);
        }
      }
    }
    return {arcMap,reverse};
  }
  // Exact segment tests after a bounding-box check. A ring enclosing the
  // patch contributes its winding at one patch corner. No boundary of that
  // ring enters the patch, so its winding is constant throughout.
  function areaBoundary(ring,b,stats){
    const [x,y,X,Y]=b,{segmentsTouch,orient}=CORE;
    let winding=0,touches=false;
    for(let i=0,j=ring.length-2;i<ring.length;j=i,i+=2){
      const ax=ring[j],ay=ring[j+1],bx=ring[i],by=ring[i+1];
      stats.checkedPrimitives++;
      if(Math.min(ax,bx)<=X&&Math.max(ax,bx)>=x&&Math.min(ay,by)<=Y&&Math.max(ay,by)>=y&&
        (ax>=x&&ax<=X&&ay>=y&&ay<=Y||bx>=x&&bx<=X&&by>=y&&by<=Y||
        segmentsTouch(ax,ay,bx,by,x,y,X,y)||segmentsTouch(ax,ay,bx,by,X,y,X,Y)||
        segmentsTouch(ax,ay,bx,by,X,Y,x,Y)||segmentsTouch(ax,ay,bx,by,x,Y,x,y)))touches=true;
      if(ay<=y&&by>y&&orient(ax,ay,bx,by,x,y)>0)winding++;
      else if(ay>y&&by<=y&&orient(ax,ay,bx,by,x,y)<0)winding--;
    }
    return {touches,winding};
  }
  function areaRetag(ring,arcMap){
    if(!ring.tags?.length)return ring;
    const {ids,pattern}=areaTagInfo(ring.tags);
    let shifted=false;
    for(const old of ids){
      if(!arcMap.has(old))return null;
      if(arcMap.get(old)!==old)shifted=true;
    }
    if(!shifted)return ring;
    const tags=Int32Array.from(ring.tags,tag=>tag<0?tag:arcMap.get(tag));
    areaTagMemo.set(tags,{ids:ids.map(id=>arcMap.get(id)),pattern});
    return {...ring,tags};
  }
  // ---- The region a patch solves, and the indexes that keep it proportional to the edit.
  // A uniform grid over boxes in the integer frame. A box over more than AREA_BIG cells either way
  // (the polygon, the board, a large island) goes on a list that every query visits.
  const AREA_BIG=48,AREA_LONG=256;
  function areaCells(x0,y0,x1,y1,n){
    const W=Math.max(1,x1-x0),H=Math.max(1,y1-y0);
    let cs=Math.max(1,Math.sqrt(W*H/Math.max(1,n))*1.5);cs=Math.max(cs,W/1023,H/1023);
    return {x0,y0,cs,cols:Math.floor(W/cs)+1,rows:Math.floor(H/cs)+1};
  }
  // The cells of box b in grid g, clamped: [c0, c1, r0, r1].
  function areaSpan(g,b){
    let c0=Math.floor((b[0]-g.x0)/g.cs),c1=Math.floor((b[2]-g.x0)/g.cs),r0=Math.floor((b[1]-g.y0)/g.cs),r1=Math.floor((b[3]-g.y0)/g.cs);
    const C=g.cols-1,R=g.rows-1;
    c0=c0<0?0:c0>C?C:c0;c1=c1<0?0:c1>C?C:c1;r0=r0<0?0:r0>R?R:r0;r1=r1<0?0:r1>R?R:r1;
    return [c0,c1,r0,r1];
  }
  const areaWide=s=>s[1]-s[0]>=AREA_BIG||s[3]-s[2]>=AREA_BIG;
  // A static grid over a list of boxes (or count boxes that boxAt(k, out) writes); areaVisit calls
  // fn(k) once for each box whose cells meet b. Spans are kept in one typed array (no box arrays).
  function areaBoxGrid(boxes,count,boxAt){
    const n=boxes?boxes.length:count,tmp=[0,0,0,0],get=boxes?k=>boxes[k]:k=>{boxAt(k,tmp);return tmp;};
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(let k=0;k<n;k++){const b=get(k);if(b[0]<x0)x0=b[0];if(b[1]<y0)y0=b[1];if(b[2]>x1)x1=b[2];if(b[3]>y1)y1=b[3];}
    if(!n){x0=y0=0;x1=y1=1;}
    const g=areaCells(x0,y0,x1,y1,n),cells=g.cols*g.rows,start=new Int32Array(cells+1),spans=new Int32Array(4*n),big=[],C=g.cols-1,Rw=g.rows-1;
    const cl=(v,m)=>v<0?0:v>m?m:v;
    for(let k=0;k<n;k++){
      const b=get(k),c0=cl(Math.floor((b[0]-g.x0)/g.cs),C),c1=cl(Math.floor((b[2]-g.x0)/g.cs),C),r0=cl(Math.floor((b[1]-g.y0)/g.cs),Rw),r1=cl(Math.floor((b[3]-g.y0)/g.cs),Rw);
      if(c1-c0>=AREA_BIG||r1-r0>=AREA_BIG){big.push(k);spans[4*k]=-1;continue;}
      spans[4*k]=c0;spans[4*k+1]=c1;spans[4*k+2]=r0;spans[4*k+3]=r1;
      for(let r=r0;r<=r1;r++)for(let c=c0;c<=c1;c++)start[r*g.cols+c+1]++;
    }
    for(let c=0;c<cells;c++)start[c+1]+=start[c];
    const items=new Int32Array(start[cells]),fill=start.slice(0,cells);
    for(let k=0;k<n;k++){if(spans[4*k]<0)continue;for(let r=spans[4*k+2];r<=spans[4*k+3];r++)for(let c=spans[4*k];c<=spans[4*k+1];c++)items[fill[r*g.cols+c]++]=k;}
    return {...g,start,items,big,stamp:new Int32Array(n),tick:0};
  }
  function areaVisit(g,b,fn){
    const t=++g.tick,s=areaSpan(g,b),{start,items,stamp}=g;
    for(let r=s[2];r<=s[3];r++)for(let c=s[0];c<=s[1];c++){
      const id=r*g.cols+c;
      for(let q=start[id];q<start[id+1];q++){const k=items[q];if(stamp[k]!==t){stamp[k]=t;fn(k);}}
    }
    for(const k of g.big)if(stamp[k]!==t){stamp[k]=t;fn(k);}
  }
  const areaRecordGrid=inputs=>inputs.grid||(inputs.grid=areaBoxGrid(null,inputs.records.length,(k,o)=>{const b=inputs.records[k].box;o[0]=b[0];o[1]=b[1];o[2]=b[2];o[3]=b[3];}));
  // Exact: edge a-b meets the closed box [x, y, X, Y].
  function areaEdgeTouches(ax,ay,bx,by,x,y,X,Y){
    if(Math.min(ax,bx)>X||Math.max(ax,bx)<x||Math.min(ay,by)>Y||Math.max(ay,by)<y)return false;
    if(ax>=x&&ax<=X&&ay>=y&&ay<=Y||bx>=x&&bx<=X&&by>=y&&by<=Y)return true;
    const T=CORE.segmentsTouch;
    return T(ax,ay,bx,by,x,y,X,y)||T(ax,ay,bx,by,X,y,X,Y)||T(ax,ay,bx,by,X,Y,x,Y)||T(ax,ay,bx,by,x,Y,x,y);
  }
  // Whether a ring's boundary meets box b. A long ring keeps a grid of its edges (by ring array).
  const areaEdgeGrids=new WeakMap();
  function areaRingTouches(ring,b,stats){
    const n=ring.length>>1,[x,y,X,Y]=b;
    if(n<=AREA_LONG){
      for(let i=0,j=ring.length-2;i<ring.length;j=i,i+=2){stats.checkedPrimitives++;if(areaEdgeTouches(ring[j],ring[j+1],ring[i],ring[i+1],x,y,X,Y))return true;}
      return false;
    }
    const g=areaEdgeGrid(ring);
    let hit=false;
    areaVisit(g,b,k=>{
      if(hit)return;stats.checkedPrimitives++;
      const i=2*k,j=k?i-2:ring.length-2;
      if(areaEdgeTouches(ring[j],ring[j+1],ring[i],ring[i+1],x,y,X,Y))hit=true;
    });
    return hit;
  }
  // Edge k of a ring runs from vertex k-1 to vertex k.
  function areaEdgeGrid(ring){
    let g=areaEdgeGrids.get(ring);
    if(!g){
      g=areaBoxGrid(null,ring.length>>1,(k,o)=>{const i=2*k,j=k?i-2:ring.length-2,ax=ring[j],ay=ring[j+1],bx=ring[i],by=ring[i+1];o[0]=ax<bx?ax:bx;o[1]=ay<by?ay:by;o[2]=ax<bx?bx:ax;o[3]=ay<by?by:ay;});
      areaEdgeGrids.set(ring,g);
    }
    return g;
  }
  // CORE.pointInRing (1 inside, -1 outside, 0 on the boundary); a long ring reads only the edges whose
  // boxes meet the ray from the point to the right, the only ones that can cross it or hold the point.
  function areaPointInRing(x,y,ring){
    const n=ring.length>>1;
    if(n<=AREA_LONG)return CORE.pointInRing(x,y,ring);
    const g=areaEdgeGrid(ring),b=areaRingInfo(ring).box;
    if(x>b[2]||y<b[1]||y>b[3])return x>=b[0]&&x<=b[2]&&y>=b[1]&&y<=b[3]?CORE.pointInRing(x,y,ring):-1;
    let inside=false,on=false;
    areaVisit(g,[x,y,b[2],y],k=>{
      if(on)return;
      const i=2*k,j=k?i-2:ring.length-2,x1=ring[j],y1=ring[j+1],x2=ring[i],y2=ring[i+1];
      const cr=(x2-x1)*(y-y1)-(y2-y1)*(x-x1);
      if(cr===0&&x>=Math.min(x1,x2)&&x<=Math.max(x1,x2)&&y>=Math.min(y1,y2)&&y<=Math.max(y1,y2)){on=true;return;}
      if((y1>y)!==(y2>y)&&(cr>0)===(y2>y1))inside=!inside;
    });
    return on?0:inside?1:-1;
  }
  // The winding number of a ring at a point off its boundary.
  function areaWinding(ring,x,y){
    const orient=CORE.orient;let w=0;
    for(let i=0,j=ring.length-2;i<ring.length;j=i,i+=2){
      const ax=ring[j],ay=ring[j+1],bx=ring[i],by=ring[i+1];
      if(ay<=y&&by>y&&orient(ax,ay,bx,by,x,y)>0)w++;
      else if(ay>y&&by<=y&&orient(ax,ay,bx,by,x,y)<0)w--;
    }
    return w;
  }
  const areaRingArea=ring=>{const info=areaRingInfo(ring);if(info.area==null)info.area=Math.abs(area2(ring))/2;return info.area;};
  // The edges of a ring that meet box b, as start vertex indices (edge i runs from vertex i to i+1;
  // a long ring's edge grid lists edge k as running from vertex k-1 to k).
  function areaEdgesIn(ring,b,stats,fn){
    const n=ring.length>>1,[x,y,X,Y]=b;
    if(n<=AREA_LONG){
      for(let i=0;i<n;i++){const j=i+1===n?0:i+1;stats.checkedPrimitives++;if(areaEdgeTouches(ring[2*i],ring[2*i+1],ring[2*j],ring[2*j+1],x,y,X,Y))fn(i);}
      return;
    }
    areaVisit(areaEdgeGrid(ring),b,k=>{
      const i=k?k-1:n-1,j=k;stats.checkedPrimitives++;
      if(areaEdgeTouches(ring[2*i],ring[2*i+1],ring[2*j],ring[2*j+1],x,y,X,Y))fn(i);
    });
  }
  // Long rings that changed, old and new paired by the edges they share (same class and sign, the
  // most shared edges): a stage-1 island outline seen by stage 2, an earlier pour's copper, a moved
  // polygon outline. A pair enters the region by where it differs: the boxes of the connected sets of
  // edges only one of the two has. Those edges form the cycles that bound where the two rings' winding
  // differs, and a cycle's box holds what it bounds, so outside these boxes both give the same winding
  // and have the same edges. Returns {pairs: [[new record, boxes]], rest: the other changed records}.
  const vertexKey=(x,y)=>(x+33554432)*67108864+(y+33554432);
  function areaPairs(changed,R,isLong){
    const olds=[],news=[],rest=[];
    for(const c of changed)(isLong(c.box)?(R[c.k]===c?news:olds):rest).push(c);
    const pairs=[],taken=new Set();
    // Edges by start vertex: start -> [end, edge index, ...].
    const edgesOf=ring=>{const m=new Map(),n=ring.length>>1;for(let i=0;i<n;i++){const j=i+1===n?0:i+1,a=vertexKey(ring[2*i],ring[2*i+1]),b=vertexKey(ring[2*j],ring[2*j+1]);const l=m.get(a);if(l)l.push(b,i);else m.set(a,[b,i]);}return m;};
    const find=(m,a,b)=>{const l=m.get(a);if(l)for(let q=0;q<l.length;q+=2)if(l[q]===b)return l[q+1];return -1;};
    const has=(m,a,b)=>find(m,a,b)>=0;
    for(const c of news){
      let best=null,bestShared=0,bestEdges=null;
      for(const o of olds){
        if(taken.has(o)||o.shape.cls!==c.shape.cls||o.shape.sign!==c.shape.sign||!areaOverlaps(o.box,c.box))continue;
        const m=edgesOf(o.shape.ring),r=c.shape.ring,n=r.length>>1;let shared=0;
        for(let i=0;i<n;i++){const j=i+1===n?0:i+1;if(has(m,vertexKey(r[2*i],r[2*i+1]),vertexKey(r[2*j],r[2*j+1])))shared++;}
        if(shared>bestShared){best=o;bestShared=shared;bestEdges=m;}
      }
      const n=c.shape.ring.length>>1;
      if(!best||bestShared<n/2){rest.push(c);continue;}
      taken.add(best);
      // The edges only one ring has, joined where they share a vertex; one box per connected set.
      // An edge is shared when the other ring has it too and both or neither carry an arc there (a
      // merged run can lose its arc while keeping its ends).
      const mine=edgesOf(c.shape.ring),diff=[];
      const collect=(ring,tags,other,otherTags)=>{const k=ring.length>>1;for(let i=0;i<k;i++){
        const j=i+1===k?0:i+1,a=vertexKey(ring[2*i],ring[2*i+1]),b=vertexKey(ring[2*j],ring[2*j+1]),o=find(other,a,b);
        if(o<0||((tags?tags[i]:-1)<0)!==((otherTags?otherTags[o]:-1)<0))diff.push([a,b,ring[2*i],ring[2*i+1],ring[2*j],ring[2*j+1]]);
      }};
      collect(c.shape.ring,c.shape.tags,bestEdges,best.shape.tags);collect(best.shape.ring,best.shape.tags,mine,c.shape.tags);
      const ids=new Map();for(const [a,b] of diff){if(!ids.has(a))ids.set(a,ids.size);if(!ids.has(b))ids.set(b,ids.size);}
      const uf=CORE.unionFind(ids.size);for(const [a,b] of diff)uf.join(ids.get(a),ids.get(b));
      const boxes=new Map();
      for(const [a,,x1,y1,x2,y2] of diff){const r=uf.find(ids.get(a)),e=[Math.min(x1,x2),Math.min(y1,y2),Math.max(x1,x2),Math.max(y1,y2)];boxes.set(r,areaJoin(boxes.get(r),e));}
      // The arc ids of the edges both have (old -> new): the kept pieces of rings made of these edges
      // take the new ids, as with any other kept input (areaArcMaps).
      const ids2=[],ot=best.shape.tags,nt=c.shape.tags,r=c.shape.ring;
      if(ot||nt)for(let i=0;i<n;i++){
        const j=i+1===n?0:i+1,o=find(bestEdges,vertexKey(r[2*i],r[2*i+1]),vertexKey(r[2*j],r[2*j+1]));
        if(o>=0&&(ot?ot[o]:-1)>=0&&(nt?nt[i]:-1)>=0)ids2.push(ot[o],nt[i]);
      }
      pairs.push([c,[...boxes.values()],ids2]);
    }
    for(const o of olds)if(!taken.has(o))rest.push(o);
    return {pairs,rest};
  }
  // The region of a patch: a set of boxes, one round each changed input (old and new) and each input
  // whose boundary comes within AREA_GUARD of a box, grown by 2 AREA_GUARD; closed under that rule.
  // So every input outside the region keeps its boundary more than AREA_GUARD from every box, and every
  // input inside lies, with its interior, in its own box. A box that an input's grown box fits in
  // already is not added again. Connected boxes (within 2 AREA_GUARD) form one component; an input
  // outside the region has one winding number over a component, taken at its first box's corner.
  // A long input (its box longer than an eighth of the pour's either way: the polygon and board
  // outlines, a large island's outline in stage 2, an earlier pour's copper) does not bring its box.
  // It enters edge by edge: an edge that comes within AREA_GUARD of a box brings its own box, unless it
  // is parallel to an axis and carries no arc (a "straddler": it may cross the region's boundary, see
  // areaSplice); and a changed long input that pairs with its old version (areaPairs) brings only the
  // boxes of where the two differ. A long input that meets a component is solved with it in full (its
  // winding is not constant over the component), so the component's overlay is exact inside it.
  // Returns {boxes, grid, components: [{shapes (in task order), winding, boxes, grid}], shapes, longs,
  // area}, or the reason the region is too wide for a patch: its inputs hold more than `limit`
  // vertices, where a full solve costs about as much (exactness does not depend on the limit).
  const areaLongTest=frame=>{const longLen=Math.max(frame[2]-frame[0],frame[3]-frame[1])/8;return b=>Math.max(b[2]-b[0],b[3]-b[1])>longLen;};
  function areaRegion(inputs,{pairs,rest},K,limit,stats,frame){
    const g=areaRecordGrid(inputs),R=inputs.records,N=R.length,inL=new Uint8Array(N),inX=new Uint8Array(N),boxes=[],L=[],X=[],of=new Int32Array(N);
    const isLong=areaLongTest(frame);
    const meets=new Map(),seen=new Map();
    let total=0,vertices=0,straddlers=0;
    const grow=b=>{boxes.push(clipBox(b,2*AREA_GUARD));total+=areaOf(boxes[boxes.length-1]);return boxes.length-1;};
    const widest=(rec,changed)=>{const a=areaOf(rec.box);if(!stats.widest||a>stats.widest.a)stats.widest={a,cls:rec.shape.cls,w:rec.box[2]-rec.box[0],h:rec.box[3]-rec.box[1],n:rec.shape.ring.length>>1,...(changed?{changed}:{})};};
    const long=k=>{inX[k]=1;X.push(k);meets.set(k,new Set());seen.set(k,new Set());vertices+=R[k].shape.ring.length>>1;};
    for(const [c,diff] of pairs){long(c.k);for(const b of diff)grow(b);}
    for(const c of rest){
      const own=R[c.k]===c;
      if(own&&inL[c.k])continue;
      const q=grow(c.box);widest(c,true);
      if(own){inL[c.k]=1;L.push(c.k);of[c.k]=q;vertices+=c.shape.ring.length>>1;}
    }
    for(let q=0;q<boxes.length;q++){
      if(vertices>limit)return "wide-neighbourhood";
      const b=boxes[q],near=clipBox(b,AREA_GUARD);
      areaVisit(g,near,k=>{
        if(inL[k])return;
        const rec=R[k];
        if(!areaOverlaps(rec.box,near))return;
        if(!inX[k]){
          if(!areaRingTouches(rec.shape.ring,near,stats))return;
          if(isLong(rec.box))long(k);
          else{
            inL[k]=1;L.push(k);vertices+=rec.shape.ring.length>>1;widest(rec);
            const gb=clipBox(rec.box,2*AREA_GUARD);
            of[k]=gb[0]>=b[0]&&gb[1]>=b[1]&&gb[2]<=b[2]&&gb[3]<=b[3]?q:grow(rec.box);
            return;
          }
        }
        // A long input: each of its edges near this box straddles or brings its own box.
        const ring=rec.shape.ring,tags=rec.shape.tags,n=ring.length>>1,met=meets.get(k),done=seen.get(k);
        met.add(q);
        areaEdgesIn(ring,near,stats,i=>{
          if(done.has(i))return;done.add(i);
          const j=i+1===n?0:i+1,ax=ring[2*i],ay=ring[2*i+1],bx=ring[2*j],by=ring[2*j+1];
          if((ax===bx||ay===by)&&!(tags&&tags[i]>=0)){straddlers++;return;}
          const e=[Math.min(ax,bx),Math.min(ay,by),Math.max(ax,bx),Math.max(ay,by)],ge=clipBox(e,2*AREA_GUARD);
          if(!(ge[0]>=b[0]&&ge[1]>=b[1]&&ge[2]<=b[2]&&ge[3]<=b[3]))met.add(grow(e));
        });
      });
    }
    if(vertices>limit)return "wide-neighbourhood";
    // Components: boxes whose AREA_GUARD neighbourhoods meet, by a sweep in x.
    const B=boxes.length,uf=CORE.unionFind(B),order=[...boxes.keys()].sort((a,b)=>boxes[a][0]-boxes[b][0]);
    for(let i=0;i<B;i++){
      const a=boxes[order[i]];
      for(let j=i+1;j<B;j++){
        const b=boxes[order[j]];if(b[0]>a[2]+2*AREA_GUARD)break;
        if(b[1]<=a[3]+2*AREA_GUARD&&b[3]>=a[1]-2*AREA_GUARD&&b[2]>=a[0]-2*AREA_GUARD)uf.join(order[i],order[j]);
      }
    }
    const comp=new Map(),components=[];
    for(let q=0;q<B;q++){const r=uf.find(q);if(!comp.has(r)){comp.set(r,components.length);components.push({ref:boxes[q],keys:[],boxes:[]});}components[comp.get(r)].boxes.push(boxes[q]);}
    for(const k of L)components[comp.get(uf.find(of[k]))].keys.push(k);
    for(const k of X){const cs=new Set();for(const q of meets.get(k))cs.add(comp.get(uf.find(q)));for(const c of cs)components[c].keys.push(k);}
    for(const c of components){
      c.keys.sort((a,b)=>a-b);
      // Every input not in the component's overlay winds constantly over it: a long input that meets
      // another component only is one of them.
      const x=c.ref[0],y=c.ref[1],w=new Int32Array(K),mine=new Set(c.keys);
      areaVisit(g,[x,y,x,y],k=>{
        if(inL[k]||inX[k]&&mine.has(k))return;const {shape,box:b}=R[k];
        if(b[0]<=x&&b[2]>=x&&b[1]<=y&&b[3]>=y)w[shape.cls]+=areaWinding(shape.ring,x,y)*shape.sign;
      });
      c.winding=w;c.shapes=c.keys.map(k=>R[k].shape);c.grid=areaBoxGrid(c.boxes);
    }
    return {boxes,components,shapes:L.length+X.length,longs:X.length,straddlers,pairs:pairs.length,area:total,grid:areaBoxGrid(boxes)};
  }
  // ---- Splicing rings across the region's boundary (long inputs that straddle it).
  // Why a ring rebuilt from old and new pieces equals the full solve's ring, byte for byte:
  //  - Only straddlers cross the region's boundary: every other input lies in its box inside the region
  //    or keeps more than AREA_GUARD out of it. A straddler is parallel to an axis, so every point the
  //    overlay splits it at lies exactly on it (its crossings are rounded to the grid, and on a line
  //    x = const or y = const that rounding moves nothing across the line), and its pieces are
  //    collinear. A full solve's ring therefore runs along a straddler straight through the point where
  //    the straddler crosses the boundary (a "cut point", integer: a box side meets the axis line at
  //    right angles), and has no vertex there: simplify() keeps exactly the vertices where the direction
  //    changes, and on either side of a cut point that is decided by the edges at that vertex alone.
  //  - Outside the region the inputs and their winding are the old ones, so the old ring's vertices
  //    between two cut points are the new ring's. Inside, the component's overlay (every input meeting
  //    the component, long ones in full) gives the new ring's vertices between two cut points: edge
  //    order is the task's, so crossings are rounded as the full solve rounds them, and the overlay's
  //    winding is exact inside the component. Which side of the straddler is copper at a cut point is
  //    read just outside the region, so the old and the new solution both run along it there, in the
  //    same direction (checked).
  //  - So the new ring is: old vertices up to a cut point, new vertices from it to the next cut point,
  //    and so on. The edge across a cut point runs along a straddler, whose pieces carry no arc (tag -1,
  //    checked on both sides), so the tags of the simplified edge are those a full solve gives, and arc
  //    identities elsewhere are the old ring's (renumbered with the patch's arc map) or the overlay's.
  //  - canonical() then rotates every ring to its lowest vertex and sorts rings and holes by content,
  //    so the start a ring was rebuilt from does not matter.
  // Anything this cannot show exactly (a vertex on a box side, an edge along one, a slanted edge that
  // leaves the region, an unmatched cut point) returns null and the caller solves in full.
  function areaPointStatus(region,x,y){
    let st=0;
    areaVisit(region.grid,[x,y,x,y],q=>{const b=region.boxes[q];if(x>b[0]&&x<b[2]&&y>b[1]&&y<b[3])st=2;else if(st<1&&x>=b[0]&&x<=b[2]&&y>=b[1]&&y<=b[3])st=1;});
    return st; // 0 outside, 1 on a box side only, 2 inside
  }
  // How a ring meets a region ({boxes, grid}): "outside" (no point of it in a box), "inside" (every
  // vertex strictly inside a box, no edge leaving), or {events} where it crosses the boundary (in ring
  // order: {i (edge from vertex i to i+1), d (distance along it), x, y, into}); null if undecidable.
  function areaCut(ring,region,stats){
    const n=ring.length>>1,edges=new Set();
    if(n<=AREA_LONG)for(let i=0;i<n;i++)edges.add(i);
    else for(const b of region.boxes)areaEdgesIn(ring,b,stats,i=>edges.add(i));
    if(!edges.size)return "outside";
    const status=new Map(),at=v=>{let s=status.get(v);if(s===undefined){s=areaPointStatus(region,ring[2*v],ring[2*v+1]);status.set(v,s);}return s;};
    const events=[];let inner=0,outer=0;
    for(const i of edges){
      const j=i+1===n?0:i+1,ax=ring[2*i],ay=ring[2*i+1],bx=ring[2*j],by=ring[2*j+1],sa=at(i),sb=at(j);
      if(sa===1||sb===1)return null;
      sa===2?inner++:outer++;
      const hit=[];
      areaVisit(region.grid,[Math.min(ax,bx),Math.min(ay,by),Math.max(ax,bx),Math.max(ay,by)],q=>{const b=region.boxes[q];if(areaEdgeTouches(ax,ay,bx,by,b[0],b[1],b[2],b[3]))hit.push(b);});
      if(!hit.length){if(sa===2||sb===2)return null;continue;}
      if(ax!==bx&&ay!==by){
        // A slanted edge lies inside one box (its own, or its input's) or the cut is not exact.
        if(sa===2&&sb===2&&hit.some(b=>ax>b[0]&&ax<b[2]&&ay>b[1]&&ay<b[3]&&bx>b[0]&&bx<b[2]&&by>b[1]&&by<b[3]))continue;
        return null;
      }
      // Along the edge: the union of the boxes' intervals; its ends between the vertices are cut points.
      const vertical=ax===bx,c=vertical?ax:ay,s0=vertical?ay:ax,s1=vertical?by:bx,up=s1>s0,lo=Math.min(s0,s1),hi=Math.max(s0,s1),iv=[];
      for(const b of hit){
        const c0=vertical?b[0]:b[1],c1=vertical?b[2]:b[3];
        if(c===c0||c===c1)return null;
        iv.push([Math.max(lo,vertical?b[1]:b[0]),Math.min(hi,vertical?b[3]:b[2])]);
      }
      iv.sort((p,q)=>p[0]-q[0]);
      const merged=[];for(const p of iv){const m=merged[merged.length-1];if(m&&p[0]<=m[1])m[1]=Math.max(m[1],p[1]);else merged.push(p.slice());}
      for(const [p,q] of merged)for(const [v,into] of [[p,up],[q,!up]]){
        if(v===lo||v===hi)continue; // a vertex: its status says which side it is on
        events.push({i,d:Math.abs(v-s0),x:vertical?c:v,y:vertical?v:c,into,dx:Math.sign(bx-ax),dy:Math.sign(by-ay)});
      }
    }
    if(!events.length){if(inner&&outer)return null;return inner?(edges.size===n?"inside":null):"outside";}
    events.sort((p,q)=>p.i-q.i||p.d-q.d);
    for(let k=0;k<events.length;k++)if(events[k].into===events[(k+1)%events.length].into)return null;
    return {events};
  }
  // The pieces of a crossing ring between consecutive cut points, on one side (inside: true, the
  // pieces in the region; false, those outside): {from, to (cut point keys), ring and tags (its vertices
  // strictly between, and the tags of the edges between them), din, dout (directions at the two cut
  // points)}; null if a cut edge carries an arc.
  const areaPut=(dst,at,src,from,len)=>{if(src.subarray)dst.set(src.subarray(from,from+len),at);else for(let q=0;q<len;q++)dst[at+q]=src[from+q];};
  function areaChains(ring,tags,events,inside){
    const n=ring.length>>1,out=[],E=events.length;
    for(let k=0;k<E;k++){
      const a=events[k],b=events[(k+1)%E];
      if(a.into!==inside)continue;
      if(tags&&(tags[a.i]>=0||tags[b.i]>=0))return null;
      // Vertices strictly between: none when b follows a on the same edge, all of them when the last
      // piece wraps round to the edge it started on.
      const count=k<E-1?b.i-a.i:b.i===a.i?n:(b.i-a.i+n)%n,s=(a.i+1)%n,first=Math.min(count,n-s);
      const r=new Int32Array(2*count),t=new Int32Array(count);
      areaPut(r,0,ring,2*s,2*first);areaPut(r,2*first,ring,0,2*(count-first));
      if(tags){areaPut(t,0,tags,s,first);areaPut(t,first,tags,0,count-first);}else t.fill(-1);
      if(count)t[count-1]=-1; // the edge out to the next cut point lies on a straddler
      out.push({from:vertexKey(a.x,a.y),to:vertexKey(b.x,b.y),inside,ring:r,tags:t,din:a.dx+","+a.dy,dout:b.dx+","+b.dy});
    }
    return out;
  }
  // Joins the old rings' outside pieces with the overlay's inside pieces at their cut points. Returns
  // [{ring, tags, from (old ring entry -> how many of its pieces the ring reuses)}], or null if a piece
  // has no partner or a partner runs the other way.
  function areaSplice(outside,inside){
    const byStart=new Map(),inByStart=new Map(),used=new Set(),rings=[];
    for(const c of outside){if(byStart.has(c.from))return null;byStart.set(c.from,c);}
    for(const c of inside){if(inByStart.has(c.from))return null;inByStart.set(c.from,c);}
    for(const start of outside){
      if(used.has(start))continue;
      const parts=[],from=new Map();let c=start,guard=0;
      for(;;){
        used.add(c);from.set(c.owner,(from.get(c.owner)||0)+1);parts.push(c);
        const piece=inByStart.get(c.to);
        if(!piece||used.has(piece)||piece.din!==c.dout)return null;
        used.add(piece);parts.push(piece);
        c=byStart.get(piece.to);
        if(!c||c.din!==piece.dout)return null;
        if(c===start)break;
        if(used.has(c)||++guard>outside.length)return null;
      }
      let len=0;for(const q of parts)len+=q.tags.length;
      const ring=new Int32Array(2*len),tags=new Int32Array(len);let at=0;
      for(const q of parts){ring.set(q.ring,2*at);tags.set(q.tags,at);at+=q.tags.length;}
      if(len<3||!area2(ring))return null;
      rings.push({ring,tags,from});
    }
    for(const c of inside)if(!used.has(c))return null;
    return rings;
  }
  // ---- The previous solution's rings by box: one entry per ring array {ring, tags, box, area, outer};
  // islands maps an outer entry to its island. A patch copies the cell lists it changes and the island
  // map, so the previous layout stays valid for the solution it describes.
  const areaEntries=new WeakMap(),areaDerived=new WeakMap();
  function areaEntry(r,outer){
    let e=areaEntries.get(r.ring);
    if(!e||e.tags!==r.tags){e={ring:r.ring,tags:r.tags,box:areaRingInfo(r.ring).box,area:areaRingArea(r.ring),outer};areaEntries.set(r.ring,e);}
    return e;
  }
  function areaLayout(islands,frame){
    let n=0;for(const isl of islands)n+=1+isl.holes.length;
    const L={...areaCells(frame[0],frame[1],frame[2],frame[3],n),big:[],islands:new Map(),own:null};
    L.cells=Array.from({length:L.cols*L.rows},()=>[]);
    for(const isl of islands){const o=areaEntry(isl,true);areaPlace(L,o,false);L.islands.set(o,isl);for(const h of isl.holes)areaPlace(L,areaEntry(h,false),false);}
    return L;
  }
  const areaLayoutCopy=L=>({...L,cells:L.cells.slice(),big:L.big.slice(),islands:new Map(L.islands),own:new Set()});
  function areaPlace(L,e,remove){
    const s=areaSpan(L,e.box);
    if(areaWide(s)){if(remove){const i=L.big.indexOf(e);if(i>=0)L.big.splice(i,1);}else L.big.push(e);return;}
    for(let r=s[2];r<=s[3];r++)for(let c=s[0];c<=s[1];c++){
      const id=r*L.cols+c;
      if(L.own&&!L.own.has(id)){L.cells[id]=L.cells[id].slice();L.own.add(id);}
      const list=L.cells[id];
      if(remove){const i=list.indexOf(e);if(i>=0)list.splice(i,1);}else list.push(e);
    }
  }
  function areaLayoutVisit(L,b,fn){
    const s=areaSpan(L,b),seen=new Set();
    for(let r=s[2];r<=s[3];r++)for(let c=s[0];c<=s[1];c++)for(const e of L.cells[r*L.cols+c])if(!seen.has(e)){seen.add(e);fn(e);}
    for(const e of L.big)if(!seen.has(e)){seen.add(e);fn(e);}
  }
  // The island a hole belongs to, by the rule of CORE.islands: the outer ring of least area, larger
  // than the hole, whose box holds the hole's box and which holds the hole's first vertex off its
  // boundary (or all of them on it). Outers that hold the hole's box are listed in the cell of its
  // lower left corner.
  function areaParent(L,h){
    let best=null;const b=h.box,s=areaSpan(L,b),list=L.cells[s[2]*L.cols+s[0]];
    const test=o=>{
      if(!o.outer||o.area<=h.area||o.box[0]>b[0]||o.box[1]>b[1]||o.box[2]<b[2]||o.box[3]<b[3]||(best&&o.area>=best.area))return;
      let side=0;for(let i=0;i<h.ring.length&&!side;i+=2)side=areaPointInRing(h.ring[i],h.ring[i+1],o.ring);
      if(side>=0)best=o;
    };
    for(const o of list)test(o);for(const o of L.big)test(o);
    return best;
  }
  function areaPatch(job,task,prior,inputs,dirtyBoxes,stats){
    if(!prior)return "first-solve";
    if(!Array.isArray(dirtyBoxes))return "global-change";
    if(prior.S!==job.S||prior.ox!==job.ox||prior.oy!==job.oy||prior.hasBoard!==task.hasBoard||prior.K!==task.K)return "frame-or-classes";
    if(!ordinaryOverlay(prior.solved.stats))return "previous-overlay";
    let tq=now();const diff=areaDifference(prior.inputs,inputs);stats.tDiff=now()-tq;
    if(!diff)return "arc-identities";
    const {changed}=diff,frame=areaFrameBox(job.clear.work,job),limit=inputs.primitives*AREA_LIMIT;
    const overlayStats={...prior.solved.stats,edges:0,merged:0,tPlanar:0,tMerge:0,tClassify:0,tTrace:0,tIslands:0,tSolve:0};
    // Changed long inputs paired with their old versions; the arcs on the edges a pair shares follow
    // the same one-to-one map as the arcs of unchanged inputs.
    const paired=changed.length?areaPairs(changed,inputs.records,areaLongTest(frame)):{pairs:[],rest:[]};
    let {arcMap,reverse,shifted}=diff;
    const pairIds=paired.pairs.flatMap(p=>p[2]);
    let pairShift=false;for(let q=0;q<pairIds.length;q+=2)if(pairIds[q]!==pairIds[q+1])pairShift=true;
    if(pairShift&&!arcMap){const m=areaArcMaps(prior.inputs,inputs);if(!m)return "arc-identities";({arcMap,reverse}=m);shifted=true;}
    if(arcMap)for(let q=0;q<pairIds.length;q+=2){
      const a=pairIds[q],b=pairIds[q+1];if(a<0&&b<0)continue;if(a<0||b<0)return "arc-identities";
      if(arcMap.has(a)&&arcMap.get(a)!==b||reverse.has(b)&&reverse.get(b)!==a)return "arc-identities";
      arcMap.set(a,b);reverse.set(b,a);
    }
    if(!changed.length&&!shifted){
      Object.assign(stats,{mode:"unchanged",bounds:null,mm2:0,shapes:0,primitives:0});
      return {...prior.solved,stats:overlayStats};
    }
    // Arc ids that moved: the kept rings take the new ids (a new ring array where any tag changed).
    // A ring whose arcs are not all mapped can only be one the patch replaces (its inputs changed).
    let islands0=prior.solved.islands,L0=prior.solved.layout;const retagged=new Set(),unmapped=new Set();
    if(shifted){
      const retag=r=>{const k=areaRetag(r,arcMap);if(k)return k;unmapped.add(r.ring);return r;};
      islands0=[];
      for(const isl of prior.solved.islands){
        const o=retag(isl);
        const holes=[];let moved=o!==isl;
        for(const h of isl.holes){const k=retag(h);if(k!==h)moved=true;holes.push(k);}
        if(!moved){islands0.push(isl);continue;}
        const next={ring:o.ring,tags:o.tags,links:[],holes};
        areaDerived.set(next,{from:isl,lost:[],gained:[]});retagged.add(next);
        islands0.push(next);
      }
      L0=null;
    }
    if(!L0)L0=areaLayout(islands0,frame);
    const t0=now();
    let region=null;
    const added=[],insidePieces=[];
    if(changed.length){
      tq=now();areaRecordGrid(inputs);stats.tGrid=now()-tq;
      stats.frameArea=areaOf(frame);
      region=areaRegion(inputs,paired,task.K,limit,stats,frame);
      stats.tRegion=now()-tq;
      if(typeof region==="string")return region;
      const inside=CORE.pourInside(task.K,task.hasBoard),w=new Int32Array(task.K);
      for(const c of region.components){
        const rings=CORE.overlayRings(c.shapes,task.K,v=>{for(let i=0;i<v.length;i++)w[i]=v[i]+c.winding[i];return inside(w);},overlayStats);
        if(!ordinaryOverlay(overlayStats))return "local-overlay";
        // Only what lies inside the component is the new solution's: a ring inside it is new, a ring
        // that crosses its boundary gives its pieces between cut points (areaSplice), and the rest (long
        // inputs far from the component, solved there without the other inputs) is dropped.
        for(const r of rings){
          const cut=areaCut(r.ring,c,stats);
          if(!cut)return "local-splice";
          if(cut==="inside")added.push(r);
          else if(cut!=="outside"){const ch=areaChains(r.ring,r.tags,cut.events,true);if(!ch)return "local-splice";for(const q of ch)insidePieces.push(q);}
        }
      }
    }
    overlayStats.tSolve=now()-t0;
    const t1=now();
    // The previous rings: made of inputs inside the region (replaced), outside it (kept), or across its
    // boundary on straddlers (their outside pieces are kept and spliced with the new inside pieces).
    const removed=new Set(),outsidePieces=[],crossing=new Map();
    const regionBox=region?region.boxes.reduce((u,q)=>areaJoin(u,q),null):null;
    if(region){
      const near=new Set();for(const b of region.boxes)areaLayoutVisit(L0,b,e=>near.add(e));
      for(const e of near){
        const cut=areaCut(e.ring,region,stats);
        if(!cut)return "contour-crosses-boundary";
        if(cut==="outside")continue;
        removed.add(e);
        if(cut==="inside")continue;
        const ch=areaChains(e.ring,e.tags,cut.events,false);if(!ch)return "contour-crosses-boundary";
        let count=0;
        for(const q of ch){
          // A ring whose arcs were not all renumbered (some came from inputs the patch replaces) keeps
          // its outside pieces only if every arc on them is renumbered.
          if(unmapped.has(e.ring))for(let m=0;m<q.tags.length;m++){const t=q.tags[m];if(t<0)continue;if(!arcMap.has(t))return "contour-arc-identity";q.tags[m]=arcMap.get(t);}
          q.owner=e;outsidePieces.push(q);count++;
        }
        crossing.set(e,count);
      }
    }
    if(unmapped.size){for(const e of removed)unmapped.delete(e.ring);if(unmapped.size)return "contour-arc-identity";}
    const tCut=now()-t1;
    // An old outer whose pieces all go into one new outer is that outer, changed inside the region: its
    // holes away from the region keep it (containment of a point outside the region's box cannot change
    // when a ring changes only inside it), the others find their outer again.
    const replacedBy=new Map(),replaces=new Map();let spliced=0;
    if(outsidePieces.length||insidePieces.length){
      const joined=areaSplice(outsidePieces,insidePieces);
      if(!joined)return "splice-unmatched";
      for(const j of joined){
        added.push(j);spliced++;
        if(j.from.size!==1)continue;
        const [[o,count]]=j.from;
        if(o.outer&&count===crossing.get(o)&&area2(j.ring)>0){const e=areaEntry(j,true);replacedBy.set(o,e);replaces.set(e,o);}
      }
    }
    const tSplice=now()-t1-tCut;
    // Islands: holes of removed outers, holes the new outers may now hold, and new holes find their
    // outer again; every other hole keeps it.
    const E=areaLayoutCopy(L0),lost=new Map(),gained=new Map(),orphans=[],touched=new Set(),carried=new Map();
    const note=(m,o,e)=>{let l=m.get(o);if(!l)m.set(o,l=[]);l.push(e);touched.add(o);};
    for(const e of removed){
      if(e.outer){
        const to=replacedBy.get(e);
        for(const h of L0.islands.get(e)?.holes||[]){
          const he=areaEntry(h,false);if(removed.has(he))continue;
          if(to&&!areaOverlaps(he.box,regionBox)){let m=carried.get(to);if(!m)carried.set(to,m=new Map());m.set(he,h);}
          else orphans.push(he);
        }
      }
      else{const p=areaParent(L0,e);if(p&&!removed.has(p))note(lost,replacedBy.get(p)||p,e);}
    }
    for(const e of removed){areaPlace(E,e,true);if(e.outer)E.islands.delete(e);}
    const outers=[],holes=[];
    for(const r of added){
      const obj={ring:r.ring instanceof Int32Array?r.ring:Int32Array.from(r.ring),tags:r.tags instanceof Int32Array?r.tags:Int32Array.from(r.tags)};
      const e=areaEntry(obj,area2(obj.ring)>0);(e.outer?outers:holes).push(e);areaPlace(E,e,false);
    }
    for(const o of outers)touched.add(o);
    const pending=new Set([...holes,...orphans]),checked=new Set();
    // A rebuilt outer N holds a point outside the region's box exactly when the outer O it replaces did.
    // A hole there with another outer P (so P is less than O) moves to N only if N is now less than P:
    // unless some outer lies between N and O in area, only holes near the region need asking. Any other
    // new outer lies in the region.
    const near=o=>{
      const was=replaces.get(o);if(!was)return o.box;
      for(const p of E.islands.keys())if(p!==o&&p.area>o.area&&p.area<was.area)return o.box;
      return regionBox;
    };
    for(const o of outers)areaLayoutVisit(E,near(o),h=>{
      if(h.outer||pending.has(h)||checked.has(h)||h.area>=o.area||h.box[0]<o.box[0]||h.box[1]<o.box[1]||h.box[2]>o.box[2]||h.box[3]>o.box[3])return;
      checked.add(h);
      const before=areaParent(L0,h),was=replacedBy.get(before)||before,next=areaParent(E,h);
      if(next===was)return;
      if(carried.get(was)?.delete(h));else if(was)note(lost,was,h);
      if(next)note(gained,next,h);else areaPlace(E,h,true);
    });
    for(const h of pending){const p=areaParent(E,h);if(p)note(gained,p,h);else areaPlace(E,h,true);}
    for(const o of touched){
      if(removed.has(o))continue;
      const from=replaces.get(o),old=E.islands.get(o)||(from?L0.islands.get(from):null),drop=new Set(lost.get(o)||[]),add=gained.get(o)||[],list=[];
      if(from)for(const h of carried.get(o)?.values()||[])list.push(h);
      else if(old)for(const h of old.holes)if(!drop.has(areaEntry(h,false)))list.push(h);
      for(const e of add)list.push({ring:e.ring,tags:e.tags});
      const isl={ring:o.ring,tags:o.tags,links:[],holes:list};
      if(old){
        const base=retagged.has(old)?areaDerived.get(old).from:old;
        if(from){
          // Holes it did not carry over count as lost (a hole lost and found again is tested again).
          const carry=carried.get(o),lostHoles=[];
          for(const h of old.holes){const he=areaEntry(h,false);if(!carry?.has(he))lostHoles.push(he);}
          areaDerived.set(isl,{from:base,lost:lostHoles,gained:add,outerBox:regionBox});
        }else areaDerived.set(isl,{from:base,lost:[...drop],gained:add});
      }
      E.islands.set(o,isl);
    }
    E.own=null;
    overlayStats.tIslands=now()-t1;overlayStats.tSolve+=overlayStats.tIslands;
    Object.assign(stats,{mode:region?"local":"unchanged",bounds:region?areaBoundsMm(region.boxes,job):null,mm2:region?region.area/(job.S*job.S):0,
      shapes:region?region.shapes:0,primitives:region?region.components.reduce((n,c)=>n+c.shapes.reduce((m,s)=>m+s.ring.length/2,0),0):0,
      boxes:region?region.boxes.length:0,longs:region?region.longs:0,straddlers:region?region.straddlers:0,splicedRings:spliced,
      removedRings:removed.size,addedRings:added.length,rehomedHoles:orphans.length,tCut,tSplice,layout:prior.solved.layout&&!shifted?"kept":"built",arcsMoved:shifted,tIslands:overlayStats.tIslands,tOverlay:overlayStats.tSolve-overlayStats.tIslands});
    return {islands:[...E.islands.values()],stats:overlayStats,layout:E};
  }
  // keep() of a patched solution: the anchors each island touches (links), dead copper, area and size,
  // with the answers of the previous keep (cache) where they still hold, the same as keep() gives.
  // An island the patch left alone is the same object: its links follow its anchors to their new
  // index (the same anchor arrays: prepare reuses them for an unchanged item) and only new anchors are
  // tested. An island the patch changed keeps the answers of the island it came from (areaDerived)
  // except for anchors whose box meets a hole it lost or gained. Any other island, or a change of the
  // tests, is tested in full. Touch tests read only the island's holes near the anchor (a grid of its
  // holes), which gives the answer of CORE.touches over all of them. Returns {solved, cache} or null.
  const areaHoleGrids=new WeakMap();
  function areaTouches(anchor,isl){
    const ib=areaRingInfo(isl.ring).box,b=anchor.box;
    if(b[0]>ib[2]||b[2]<ib[0]||b[1]>ib[3]||b[3]<ib[1])return false;
    const holes=[];
    if(isl.holes.length){
      let g=areaHoleGrids.get(isl);
      if(!g)areaHoleGrids.set(isl,g=areaBoxGrid(null,isl.holes.length,(k,o)=>{const b=areaRingInfo(isl.holes[k].ring).box;o[0]=b[0];o[1]=b[1];o[2]=b[2];o[3]=b[3];}));
      areaVisit(g,b,k=>{const h=isl.holes[k],hb=areaRingInfo(h.ring).box;if(areaOverlaps(hb,b))holes.push({ring:h.ring,box:hb});});
    }
    // CORE.touches, step for step: an anchor vertex in the island, the island's first vertex in the
    // anchor, or an island edge (outer or hole) touching an anchor edge. A long outer ring is read
    // through its edge grid (point in ring, and only the edges whose boxes meet the anchor's).
    const r=anchor.ring,n=r.length>>1,P=CORE.pointInRing,T=CORE.segmentsTouch,ring=isl.ring,m=ring.length>>1;
    const inIsland=(x,y)=>{
      const o=areaPointInRing(x,y,ring);if(o<0)return false;if(o===0)return true;
      for(const h of holes)if(x>=h.box[0]&&x<=h.box[2]&&y>=h.box[1]&&y<=h.box[3]&&P(x,y,h.ring)>0)return false;
      return true;
    };
    for(let i=0;i<n;i++)if(inIsland(r[2*i],r[2*i+1]))return true;
    if(P(ring[0],ring[1],r)>=0)return true;
    const cross=(x1,y1,x2,y2)=>{
      if(Math.max(x1,x2)<b[0]||Math.min(x1,x2)>b[2]||Math.max(y1,y2)<b[1]||Math.min(y1,y2)>b[3])return false;
      for(let k=0,l=n-1;k<n;l=k++)if(T(x1,y1,x2,y2,r[2*l],r[2*l+1],r[2*k],r[2*k+1]))return true;
      return false;
    };
    if(m<=AREA_LONG){for(let i=0,j=m-1;i<m;j=i++)if(cross(ring[2*j],ring[2*j+1],ring[2*i],ring[2*i+1]))return true;}
    else{let hit=false;areaVisit(areaEdgeGrid(ring),b,k=>{if(!hit){const j=k?k-1:m-1;hit=cross(ring[2*j],ring[2*j+1],ring[2*k],ring[2*k+1]);}});if(hit)return true;}
    for(const h of holes){const g=h.ring,q=g.length>>1;for(let i=0,j=q-1;i<q;j=i++)if(cross(g[2*j],g[2*j+1],g[2*i],g[2*i+1]))return true;}
    return false;
  }
  function areaKeep(solved,task,cache){
    const t0=now(),A=task.anchors,n=A.length,index=new Map();
    for(let k=0;k<n;k++){if(index.has(A[k]))return null;index.set(A[k],k);}
    const same=!!cache&&cache.removeDead===task.removeDead&&cache.minArea===task.minArea&&cache.minSize===task.minSize;
    const anchor=k=>({ring:A[k],box:areaRingInfo(A[k]).box});
    let to=null;const fresh=[];
    if(same){
      const seen=new Uint8Array(n);to=new Int32Array(cache.anchors.length);
      for(let k=0;k<to.length;k++){const j=index.get(cache.anchors[k]);to[k]=j??-1;if(j!=null)seen[j]=1;}
      for(let k=0;k<n;k++)if(!seen[k])fresh.push(k);
    }
    const byIsland=new WeakMap(),out=[];let dead=0,local=0;
    for(const isl of solved.islands){
      const c=same?cache.byIsland.get(isl):null,d=!c&&same?areaDerived.get(isl):null,c0=d?cache.byIsland.get(d.from):null;
      let links,area;
      if(c||c0){
        const base=c||c0,retest=new Set(fresh);
        if(c0){
          // An outer ring rebuilt across the region (d.outerBox) changed only inside the region's box.
          const changedBoxes=[...d.lost,...d.gained].map(e=>e.box);if(d.outerBox)changedBoxes.push(d.outerBox);
          let u=null;for(const b of changedBoxes)u=areaJoin(u,b);
          if(u)for(let k=0;k<n;k++){const b=areaRingInfo(A[k]).box;if(areaOverlaps(b,u)&&changedBoxes.some(h=>areaOverlaps(b,h)))retest.add(k);}
        }
        links=[];
        for(const k of base.links){const j=to[k];if(j>=0&&!retest.has(j))links.push(j);}
        for(const k of retest)if(areaTouches(anchor(k),isl))links.push(k);
        links.sort((a,b)=>a-b);
        area=c?c.area:d.outerBox?areaRingArea(isl.ring)-isl.holes.reduce((s,h)=>s+areaRingArea(h.ring),0):c0.area+d.lost.reduce((s,e)=>s+e.area,0)-d.gained.reduce((s,e)=>s+e.area,0);
        local++;
      }else{
        links=[];for(let k=0;k<n;k++)if(areaTouches(anchor(k),isl))links.push(k);
        area=areaRingArea(isl.ring)-isl.holes.reduce((s,h)=>s+areaRingArea(h.ring),0);
      }
      const prev=c?.out,o=prev&&prev.links.length===links.length&&prev.links.every((k,i)=>k===links[i])?prev:{ring:isl.ring,tags:isl.tags,links,holes:isl.holes};
      byIsland.set(isl,{links,area,out:o});
      if(task.removeDead&&!links.length){dead++;continue;}
      const b=areaRingInfo(isl.ring).box;
      if(task.minArea>0&&area<task.minArea)continue;
      if(b[2]-b[0]<task.minSize&&b[3]-b[1]<task.minSize)continue;
      out.push(o);
    }
    const stats={...solved.stats,deadIslands:dead,tDead:now()-t0,keep:same?"local":"full",keptIslands:local};
    stats.tSolve=(solved.stats?.tSolve||0)+stats.tDead;
    return {solved:{islands:out,stats},cache:{anchors:A,removeDead:task.removeDead,minArea:task.minArea,minSize:task.minSize,byIsland}};
  }
  function areaBoundsMm(boxes,job){
    let b=null;for(const q of boxes)b=areaJoin(b,q);
    // No box: a long ring changed only where its vertex list starts (the same edges).
    return b&&b.map((v,k)=>v/job.S+(k%2?job.oy:job.ox));
  }
  function* areaSolveSteps({job,task,prior,area,hash,stage,j}){
    const t0=now(),inputs=areaInputs(task,job.arcs),stats={fullMm2:areaOf(job.clear.work),fullShapes:inputs.records.length,
      fullPrimitives:inputs.primitives,indexedPrimitives:inputs.indexedPrimitives,checkedPrimitives:0,tInputs:now()-t0};
    let solved=areaPatch(job,task,prior,inputs,area.dirtyBoxes,stats);    if(typeof solved==="string"){
      Object.assign(stats,{mode:"full",reason:solved,mm2:stats.fullMm2,shapes:stats.fullShapes,primitives:stats.fullPrimitives});
      solved=yield {task,hash,stage,j,job};
    }
    stats.milliseconds=now()-t0;
    return {S:job.S,ox:job.ox,oy:job.oy,K:task.K,hasBoard:task.hasBoard,inputs,solved,stats};
  }
  // The final solution, canonical (every path stores the same bytes). stage1: stage 1's stats.
  function finalize(solved,stage1,area=false){
    CORE.canonical(solved,area?areaCanonical:null,area?areaCanonicalIslands:null);solved.final=true;
    if(stage1&&solved.stats&&!solved.stats.stage1){solved.stats.stage1=stage1;solved.stats.tSolve=(solved.stats.tSolve||0)+(stage1.tSolve||0);}
    return solved;
  }
  // Both stages here (pour(), and finish() of a stage-1 solution): job.poured holds the earlier regions.
  function solveStages(job,solved1){
    const g=stage2Steps(job,solved1,job.poured||[],true);let r=g.next();while(!r.done)r=g.next();
    const s=r.value;
    return {job:s.job,solved:finalize(s.task?CORE.solve(s.task):s.solved,s.stage1)};
  }
  // The rings of an earlier pour's region r that pour P clears (prepare above; the exact reuse key
  // reads the same rings): same layer, another net, within the clearance of the work box.
  // Rings (holes) wholly outside the work box cannot change the winding inside it; skipping them
  // keeps a large earlier pour cheap to clear. visit(tag, ring, k, c).
  function earlierRingsOf(r,P,layer,net,near,clearance,tol,visit){
    if(r.layer!==layer||r.polygon===P.id||(net&&r.net===net)||!Array.isArray(r.bounds))return;
    const c=clearance(r.net||"","poly",r),b=r.bounds;
    if(!near([b[0]-c,b[1]-c,b[2]+c,b[3]+c]))return;
    const tag=r.polygon??"imported",reach=c+Math.max(SAFE,2e-4)+tol;
    const cached=areaRegionContours.get(r),prepared=cached&&cached.data===r.data&&cached.count===r.count?cached.rings:null;
    (prepared||rings(r)).forEach((ring,k)=>{
      const rb=prepared?areaRingInfo(ring).box:boxOf(ring);
      if(!near([rb[0]-reach,rb[1]-reach,rb[2]+reach,rb[3]+reach]))return;
      visit(tag,ring,k,c);
    });
  }
  function finish(job,solved){const g=finishSteps(job,solved);let r=g.next();while(!r.done)r=g.next();return r.value;}
  // finish() as steps: yields after each island's arcs and after its encoding (live pours).
  function* finishSteps(job,solved){
    // A stage-1 solution of an untiled pour (prepare's task, solved by the caller): stage 2 first.
    if(job.final&&!solved.final)({job,solved}=solveStages(job,solved));
    else if(!solved.final)finalize(solved);
    const t0=now(),{regions,stats,P,S,ox,oy,layer,net}=job,e=solved.stats;
    Object.assign(stats,{shapes:job.nShapes??job.task.shapes.length,edges:e.edges,merged:e.merged,passes:e.passes,
      brokenRings:e.brokenRings||0,unresolved:!!e.unresolved,scale:S,deadIslands:e.deadIslands,faces:e.faces,rays:e.rays,
      tPrepare:job.tPrepare,tPlanar:e.tPlanar,tMerge:e.tMerge,tClassify:e.tClassify,tTrace:e.tTrace,tIslands:e.tIslands,tDead:e.tDead,tSolve:e.tSolve});
    const toMm=r=>{const out=new Float64Array(r.length);for(let i=0;i<r.length;i+=2){out[i]=r[i]/S+ox;out[i+1]=r[i+1]/S+oy;}return out;};
    const areaToMm=r=>{
      let entry=areaConverted.get(r);
      if(entry&&entry.S===S&&entry.ox===ox&&entry.oy===oy)return entry;
      // Later pours read the same model coordinates as a freshly decoded
      // stored contour, including the floating-point unit conversion.
      const mm=toMm(r),stored=Float64Array.from(mm,v=>v/ALTIUM_UNIT*ALTIUM_UNIT);
      entry={S,ox,oy,mm,stored};areaConverted.set(r,entry);
      return entry;
    };
    let arcCount=0;
    for(const isl of solved.islands){
      const links=[],seen=new Set();
      for(const k of isl.links){const l=job.links[k];if(!l)continue;const key=JSON.stringify(l);if(!seen.has(key)){seen.add(key);links.push(l);}}
      const rs=[{ring:isl.ring,tags:isl.tags},...isl.holes.map(h=>({ring:h.ring,tags:h.tags}))];
      const arcs=job.arcs?.length?yield* trueArcSteps(rs,job):null;
      yield;
      /** @type {{polygon: typeof P.id, links: typeof links, hatchSkipped?: boolean, arcs?: NonNullable<typeof arcs>}} */
      const extra={polygon:P.id,links,...(stats.hatchSkipped?{hatchSkipped:true}:{})};
      if(arcs){extra.arcs=arcs;arcCount+=arcs.length/5;}
      if(job.areaExact){
        const mm=rs.map(r=>areaToMm(r.ring)),region=encode(mm.map(e=>e.mm),layer,net,extra);
        areaRegionContours.set(region,{data:region.data,count:region.count,rings:mm.map(e=>e.stored)});
        regions.push(region);
      }else regions.push(encode(rs.map(r=>toMm(r.ring)),layer,net,extra));
      yield;
    }
    stats.arcs=arcCount;stats.regions=regions.length;stats.tFinish=now()-t0;
    stats.ms=(job.tPrepare||0)+(e.tSolve||0)+stats.tFinish;
    return regions;
  }

  // ------------------------------------------------------------ true arcs
  // A run of two or more consecutive edges tagged with one registered arc,
  // whose vertices all lie on it (within 1.5 grid units), is kept as a true
  // arc through those vertices: region.arcs = [ring, i0, i1, cx, cy, ...]
  // with vertex indices (i1 may equal the ring length: vertex 0) and the
  // centre in mm. The polyline stays the region's geometry (rendering, DRC,
  // fallback). The arc has the vertices' radius, so against the polyline it
  // only removes copper (by less than the arc approximation); a run is
  // dropped when any other edge of the region reaches into that sliver, so
  // the arc contour can never touch or cross another edge.
  function trueArcs(rs,job){const g=trueArcSteps(rs,job);let r=g.next();while(!r.done)r=g.next();return r.value;}
  // trueArcs as steps: yields every 500 rings and every 2000 candidate runs (live pours).
  function* trueArcSteps(rs,job){
    const A=job.arcs,S=job.S,ox=job.ox,oy=job.oy,cand=[];
    const on=(ring,v,t)=>{const n=ring.length>>1,w=v%n;return Math.abs(Math.hypot(ring[2*w]-(A[3*t]-ox)*S,ring[2*w+1]-(A[3*t+1]-oy)*S)-A[3*t+2]*S)<=1.5;};
    const onArc=(ring,i0,i1,t)=>{for(let v=i0;v<=i1;v++)if(!on(ring,v,t))return false;return true;};
    // Split edges keep their arc's tag, so a run can start or end at a
    // crossing: keep the stretches whose vertices are on the circle.
    const runs=(k,ring,i,j,t)=>{
      let a=-1;
      for(let v=i;v<=j+1;v++){
        const ok=v<=j&&on(ring,v,t);
        if(ok&&a<0)a=v;
        if(!ok&&a>=0){if(v-1-a>=2)cand.push([k,a,v-1,t]);a=-1;}
      }
    };
    const scan=(r,k)=>{
      const n=r.ring.length>>1;
      if(!r.tags||r.tags.length!==n||n<3)return;
      let s=-1;for(let i=0;i<n;i++)if(r.tags[i]!==r.tags[(i+n-1)%n]){s=i;break;}
      if(s<0){
        const t=r.tags[0];if(t<0||n<4||!onArc(r.ring,0,n,t))return;
        cand.push([k,0,n>>1,t],[k,n>>1,n,t]);return;
      }
      if(s>0){
        const memo=job.areaExact?areaArcRotation.get(r.ring):null;
        const sameStart=memo?.start===s,sameTags=sameStart&&memo.sourceTags===r.tags;
        const ring=sameStart?memo.ring:new Int32Array(2*n),tags=sameTags?memo.tags:new Int32Array(n);
        if(!sameStart){ring.set(r.ring.subarray(2*s));ring.set(r.ring.subarray(0,2*s),2*(n-s));}
        if(!sameTags){tags.set(r.tags.subarray(s));tags.set(r.tags.subarray(0,s),n-s);}
        if(job.areaExact&&!sameTags)areaArcRotation.set(r.ring,{start:s,sourceTags:r.tags,ring,tags});
        r.ring=ring;r.tags=tags;
      }
      for(let i=0;i<n;){
        let j=i;const t=r.tags[i];while(j<n&&r.tags[j]===t)j++;
        if(t>=0&&j-i>=2)runs(k,r.ring,i,j,t);
        i=j;
      }
    };
    for(let k=0;k<rs.length;k++){scan(rs[k],k);if(k%500===499)yield;}
    if(!cand.length)return null;
    // Uniform grid over every edge of the region.
    let maxR=1,bx0=Infinity,by0=Infinity,bx1=-Infinity,by1=-Infinity;
    for(const c of cand)maxR=Math.max(maxR,A[3*c[3]+2]*S);
    for(const r of rs)for(let i=0;i<r.ring.length;i+=2){const x=r.ring[i],y=r.ring[i+1];if(x<bx0)bx0=x;if(x>bx1)bx1=x;if(y<by0)by0=y;if(y>by1)by1=y;}
    const cs=Math.max(2*maxR+4,(bx1-bx0)/1024,(by1-by0)/1024),cols=Math.floor((bx1-bx0)/cs)+1,rows=Math.floor((by1-by0)/cs)+1;
    const cell=(x,y)=>Math.min(rows-1,Math.max(0,Math.floor((y-by0)/cs)))*cols+Math.min(cols-1,Math.max(0,Math.floor((x-bx0)/cs)));
    // The grid as flat arrays (counts, prefix sums, then the edges of each cell as global edge ids;
    // first[k] is ring k's first id): no per-cell arrays, and the candidate scan dedupes by a stamp.
    const first=new Int32Array(rs.length+1);for(let k=0;k<rs.length;k++)first[k+1]=first[k]+(rs[k].ring.length>>1);
    const ringOf=new Int32Array(first[rs.length]);for(let k=0;k<rs.length;k++)ringOf.fill(k,first[k],first[k+1]);
    const start=new Int32Array(rows*cols+1);
    const index=(r,k,put)=>{
      const g=r.ring,n=g.length>>1,e0=first[k];
      for(let j=0;j<n;j++){
        const q=(j+1)%n,c0=cell(Math.min(g[2*j],g[2*q]),Math.min(g[2*j+1],g[2*q+1])),c1=cell(Math.max(g[2*j],g[2*q]),Math.max(g[2*j+1],g[2*q+1]));
        const r0=Math.floor(c0/cols),r1=Math.floor(c1/cols),k0=c0%cols,k1=c1%cols;
        for(let a=r0;a<=r1;a++)for(let b=k0;b<=k1;b++){const id=a*cols+b;if(put)put[fill[id]++]=e0+j;else start[id+1]++;}
      }
    };
    for(let k=0;k<rs.length;k++){index(rs[k],k,null);if(k%500===499)yield;}
    for(let c=0;c<rows*cols;c++)start[c+1]+=start[c];
    const fill=start.slice(0,rows*cols),items=new Int32Array(start[rows*cols]),stamp=new Int32Array(first[rs.length]);
    for(let k=0;k<rs.length;k++){index(rs[k],k,items);if(k%500===499)yield;}
    const out=[],TWO=2*Math.PI,wrap=a=>{a%=TWO;return a<0?a+TWO:a;};
    let done=0;
    for(const [k,i0,i1,t] of cand){
      if(++done%2000===0)yield;
      const g=rs[k].ring,n=g.length>>1,cx=(A[3*t]-ox)*S,cy=(A[3*t+1]-oy)*S,R=A[3*t+2]*S+1;
      const ang=v=>Math.atan2(g[2*(v%n)+1]-cy,g[2*(v%n)]-cx);
      let sweep=0;for(let v=i0;v<i1;v++){let d=ang(v+1)-ang(v);while(d>Math.PI)d-=TWO;while(d< -Math.PI)d+=TWO;sweep+=d;}
      const dir=sweep<0?-1:1,a0=ang(i0);sweep=Math.abs(sweep);
      if(!(sweep>1e-9&&sweep<TWO-1e-9))continue;
      const rel=a=>wrap(dir*(a-a0));
      let clear=true;
      const cA=cell(cx-R,cy-R),cB=cell(cx+R,cy+R);
      for(let a=Math.floor(cA/cols);a<=Math.floor(cB/cols)&&clear;a++)for(let b=cA%cols;b<=cB%cols&&clear;b++){
        const id=a*cols+b,q1=start[id+1];
        for(let q=start[id];q<q1&&clear;q++){
          const e=items[q];if(stamp[e]===done)continue;stamp[e]=done;
          const rk=ringOf[e],j=e-first[rk];
          // Edges incident to the run's vertices are the arc's own neighbours.
          if(rk===k&&((j-(i0-1)+n)%n)<=i1-i0+1)continue;
          const h=rs[rk].ring,m=h.length>>1,jq=(j+1)%m,px=h[2*j]-cx,py=h[2*j+1]-cy,dx=h[2*jq]-h[2*j],dy=h[2*jq+1]-h[2*j+1];
          const qa=dx*dx+dy*dy,qb=2*(px*dx+py*dy),qc=px*px+py*py-R*R,disc=qb*qb-4*qa*qc;
          if(!(qa>0)||disc<0)continue;
          const sq=Math.sqrt(disc),t1=Math.max(0,(-qb-sq)/(2*qa)),t2=Math.min(1,(-qb+sq)/(2*qa));
          if(t1>t2)continue;
          const x1=px+t1*dx,y1=py+t1*dy,x2=px+t2*dx,y2=py+t2*dy;
          const u=rel(Math.atan2(y1,x1)),dl=dir*Math.atan2(x1*y2-y1*x2,x1*x2+y1*y2);
          let lo=Math.min(u,u+dl),hi=Math.max(u,u+dl);
          const eps=1e-7;
          if((hi>eps&&lo<sweep-eps)||(hi-TWO>eps&&lo-TWO<sweep-eps)||(hi+TWO>eps&&lo+TWO<sweep-eps))clear=false;
        }
      }
      if(!clear)continue;
      // Centre on the bisector of the end points: both radii are then equal.
      const sxm=g[2*(i0%n)]/S+ox,sym=g[2*(i0%n)+1]/S+oy,exm=g[2*(i1%n)]/S+ox,eym=g[2*(i1%n)+1]/S+oy;
      let ccx=A[3*t],ccy=A[3*t+1];
      const ux=exm-sxm,uy=eym-sym,ul=Math.hypot(ux,uy);
      if(ul>1e-9){const nx=-uy/ul,ny=ux/ul,mx=(sxm+exm)/2,my=(sym+eym)/2,d=(ccx-mx)*nx+(ccy-my)*ny;ccx=mx+nx*d;ccy=my+ny*d;}
      out.push(k,i0,i1,Math.round(ccx*1e6)/1e6,Math.round(ccy*1e6)/1e6);
    }
    return out.length?out:null;
  }
  // ------------------------------------------------- public boolean helpers
  // Rings in model mm (arrays of [x,y] or flat arrays). Returns islands as
  // [{outline:[[x,y]...], holes:[[[x,y]...]...]}].
  function booleanMm(groups,predicate,resolution=1e5,minResolution=0){
    const flat=r=>Array.isArray(r[0])?r.flatMap(p=>[+p[0],+p[1]]):Array.from(r);
    const all=groups.map(g=>g.map(flat));
    let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity;
    for(const g of all)for(const r of g){const q=boxOf(r);a=Math.min(a,q[0]);b=Math.min(b,q[1]);c=Math.max(c,q[2]);d=Math.max(d,q[3]);}
    if(a===Infinity)return [];
    const ox=(a+c)/2,oy=(b+d)/2,S=Math.min(resolution,LIMIT/Math.max(1e-9,(c-a)/2,(d-b)/2));
    if(S<minResolution)throw new RangeError("Polygon extent exceeds the requested physical precision.");
    const input=[];
    all.forEach((g,cls)=>g.forEach(r=>{
      const ring=[];for(let i=0;i<r.length;i+=2)ring.push(Math.round((r[i]-ox)*S),Math.round((r[i+1]-oy)*S));
      if(ring.length>=6)input.push({cls,ring,sign:1});
    }));
    const back=r=>{const out=[];for(let i=0;i<r.length;i+=2)out.push([r[i]/S+ox,r[i+1]/S+oy]);return out;};
    return overlayInt(input,groups.length,predicate).map(o=>({outline:back(o.ring),holes:o.holes.map(h=>back(h.ring))}));
  }
  const union=rs=>booleanMm([rs],w=>w[0]!==0);
  const difference=(a,b)=>booleanMm([a,b],w=>w[0]!==0&&w[1]===0);
  const intersection=(a,b)=>booleanMm([a,b],w=>w[0]!==0&&w[1]!==0);

  // ----------------------------------------------- repour, order, staleness
  function polygons(doc){
    return (doc.items||[]).map((item,index)=>({item,index}))
      .filter(e=>e.item.kind==="polygon"&&!e.item.cutout&&!e.item.shelved)
      .sort((a,b)=>settings(a.item).pourIndex-settings(b.item).pourIndex||a.index-b.index).map(e=>e.item);
  }
  function hasher(){
    let h1=2166136261,h2=5381;
    function text(s){for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);h1=Math.imul(h1^c,16777619);h2=Math.imul(h2,33)^c;}}
    function value(v){
      if(Array.isArray(v)){text("[");for(const x of v)value(x);text("]");}
      else if(v!==null&&typeof v==="object"){text("{");for(const k of Object.keys(v).sort()){value(k);value(v[k]);}text("}");}
      else if(typeof v==="string"){text("s"+v.length+":");text(v);}
      else text(String(v)+",");
    }
    return {text,value,hex:()=>(h1>>>0).toString(16).padStart(8,"0")+(h2>>>0).toString(16).padStart(8,"0")};
  }
  // Signature hashing, version 2: numbers enter as their IEEE-754 bits (no
  // string conversion), each object is hashed once per call and polygons mix
  // in the two-word hashes of the objects near them.
  const F64=new Float64Array(1),U32=new Uint32Array(F64.buffer);
  function fastHasher(projectPrecision=false){
    let h1=2166136261,h2=5381;
    const mix=x=>{h1=Math.imul(h1^x,16777619);h2=(Math.imul(h2,33)^x)|0;};
    function value(v){
      if(typeof v==="number"){F64[0]=projectPrecision&&globalThis.Atrium?.projectNumber?(Atrium.projectNumber(v)||0):v;mix(U32[0]);mix(U32[1]);}
      else if(typeof v==="string"){mix(0x73000000|v.length);for(let i=0;i<v.length;i++)mix(v.charCodeAt(i));}
      else if(Array.isArray(v)){mix(0x5b5b5b5b);for(const x of v)value(x);mix(0x5d5d5d5d);}
      else if(v!==null&&typeof v==="object"){mix(0x7b7b7b7b);for(const k of Object.keys(v).sort())if(k!=="sourceDrillTool"){value(k);value(v[k]);}mix(0x7d7d7d7d);}
      else mix(v===true?1:v===false?2:v===null?3:4);
    }
    return {mix,value,words:()=>[h1>>>0,h2>>>0],hex:()=>(h1>>>0).toString(16).padStart(8,"0")+(h2>>>0).toString(16).padStart(8,"0")};
  }
  const geometryFields=["kind","id","x","y","angle","points","outline","arc","fillRect","sourcePour","number","ref","slotLength","slotAngle","holeOnly","roundrectRadiusRatio","w","h","width","diameter","drill","shape","layer","fromLayer","toLayer","plated","net","pinNets","closed","fill","size","text","keepout","cutout","planeVoid","keepoutRestrictions","stackMode","padStack","backdrill","tent","ipc4761"];
  function landExtent(p){
    let size=Math.max(+p.w||0,+p.h||0,+p.diameter||0,+p.drill||0,+p.slotLength||0,+p.backdrill?.diameter||0);
    for(const row of Object.values(p.padStack||{}))size=Math.max(size,+row?.diameter||0,+row?.w||0,+row?.h||0);
    return size;
  }
  function pathBox(item,points,margin,parent){
    const arc=pathArc(item);
    if(!arc){const b=Atrium.bounds(parent?points.map(([x,y])=>world(+x||0,+y||0,parent)):points);return b&&clipBox(b,margin);}
    const b=[Infinity,Infinity,-Infinity,-Infinity];
    curves.edgeBounds(placedArc(curves.arcEdge(arc),parent),b);
    return clipBox(b,margin+TRACK_CHORD_ERROR);
  }
  function itemBox(i,defs){
    const points=i.kind==="polygon"?outlineOf(i):i.points;
    if(Array.isArray(points)&&points.length)return pathBox(i,points,(+i.width||0)/2)||[Infinity,Infinity,-Infinity,-Infinity];
    if(i.kind==="part"){
      const fp=defs?.get?.(i.def)?.footprint,pts=[];
      for(const p of fp?.pads||[]){const s=landExtent(p)*.75;const c=world(+p.x||0,+p.y||0,i);pts.push(c[0]-s,c[1]-s,c[0]+s,c[1]+s);}
      for(const s of fp?.shapes||[]){
        const q=s.points||(finite(s.x)?[[s.x,s.y]]:[]),m=(+s.r||0)+(+s.width||0)+(s.kind==="text"?(String(s.text||"").length+1)*(+s.size||1):0);
        const b=pathBox(s,q,m,i);if(b)pts.push(...b);
      }
      return pts.length?boxOf(pts):[i.x,i.y,i.x,i.y];
    }
    const s=Math.max(landExtent(i),i.kind==="label"?(String(i.text||"").length+1)*(+i.size||1):0)*.75+.1;
    return [(+i.x||0)-s,(+i.y||0)-s,(+i.x||0)+s,(+i.y||0)+s];
  }
  // The area whose objects a polygon's pour depends on.
  function signatureArea(s,reach){
    const pb=boxOf(s.outline.flatMap(q=>[+q[0]||0,+q[1]||0]));
    const margin=Math.max(1,(reach.override??s.clearance??reach.gap)*2+reliefReach(s,reach)+s.boardClearance+s.arcApproximation+1);
    return [pb[0]-margin,pb[1]-margin,pb[2]+margin,pb[3]+margin];
  }
  const SIGNATURE_VERSION=4,regionHashes=new WeakMap();
  // Per-item signature cache (object -> its hash words, box and layer), checked against a content
  // print of every geometry field (arrays and objects by content hash), so a hit always equals a
  // fresh hash, also after an in-place change. Undo's new objects simply miss.
  const itemSigs=new WeakMap();
  function fpWords(fps,defs,i,projectPrecision){
    const g=defs?.get?.(i.def)?.footprint;
    if (!fps.has(g)) {
      const q = fastHasher(projectPrecision);
      // Native row identities are for record links and do not change copper geometry.
      const pads = g?.pads || [];
      const geometry = globalThis.Atrium?.terminalGeometry;
      q.value(geometry ? pads.map(geometry) : pads);

      q.value(g?.shapes || []);
      if(g?.shapes?.some(s=>s.kind==="path"&&!s.fill&&s.arc?.kind==="arc"&&Atrium.pathArc(s)))q.value(ARC_STAMP);
      fps.set(g,q.words());
    }
    return fps.get(g);
  }
  function sigEntry(i,fpw,box,layer,w){
    const v=new Array(geometryFields.length),t=new Uint8Array(geometryFields.length);
    for(let k=0;k<geometryFields.length;k++){const x=i[geometryFields[k]];if(x!==null&&typeof x==="object"){t[k]=1;v[k]=contentWord(x);}else v[k]=x;}
    return {v,t,f0:fpw?fpw[0]:0,f1:fpw?fpw[1]:0,box:Float64Array.from(box),layer,w0:w[0],w1:w[1]};
  }
  function sigValid(e,i,fpw){
    if((fpw?fpw[0]:0)!==e.f0||(fpw?fpw[1]:0)!==e.f1)return false;
    const v=e.v,t=e.t;
    for(let k=0;k<geometryFields.length;k++){
      const x=i[geometryFields[k]];
      if(t[k]){if(x===null||typeof x!=="object"||contentWord(x)!==v[k])return false;}
      else if(x!==v[k]&&!(x!==x&&v[k]!==v[k]))return false;
    }
    return true;
  }
  // Hash of a region's edges that reach into `area` (both end points).
  function regionWords(r,area){
    let entry=regionHashes.get(r);
    if(!entry||entry.data!==r.data||entry.count!==r.count||entry.layer!==r.layer||entry.net!==r.net){
      entry={data:r.data,count:r.count,layer:r.layer,net:r.net,areas:new Map()};regionHashes.set(r,entry);
    }
    const m=entry.areas;
    const key=area.join(",");let w=m.get(key);
    if(!w){
      const h=fastHasher();h.value(r.layer||"");h.value(r.net||"");
      let rs;try{rs=rings(r);}catch{rs=[];h.value(r.data||"");}
      // Order-free sum of per-edge hashes: ring start and ring order vary
      // between pours of the same copper.
      let s1=0,s2=0,occupied=false;
      for(const g of rs){
        const n=g.length>>1;
        for(let i=0,j=n-1;i<n;j=i++){
          const x1=g[2*j],y1=g[2*j+1],x2=g[2*i],y2=g[2*i+1];
          // Local edges alone cannot distinguish a surrounding island from a surrounding hole.
          if((y1>area[1])!==(y2>area[1])&&area[0]<x1+(area[1]-y1)*(x2-x1)/(y2-y1))occupied=!occupied;
          if((x1<x2?x2:x1)<area[0]||(x1<x2?x1:x2)>area[2]||(y1<y2?y2:y1)<area[1]||(y1<y2?y1:y2)>area[3])continue;
          let a=2166136261,c=5381;
          for(const v of [x1,y1,x2,y2]){F64[0]=v;a=Math.imul(a^U32[0],16777619);a=Math.imul(a^U32[1],16777619);c=(Math.imul(c,33)^U32[0])|0;c=(Math.imul(c,33)^U32[1])|0;}
          s1=(s1+(a>>>0))>>>0;s2=(s2+(c>>>0))>>>0;
        }
      }
      h.mix(s1);h.mix(s2);h.value(occupied);w=h.words();if(m.size>16)m.clear();m.set(key,w);
    }
    return w;
  }
  // Fingerprints of board inputs at the precision of a saved project (version 4; packed copper edges keep
  // their exact doubles). Stamps of another version are stale: pre-release pour history is not kept.
  // polygonSignatureSteps yields every `chunk` items and after each polygon (live pours run it in
  // idle slices); polygonSignatures drains it, so both give the same signatures.
  function polygonSignatures(doc,defs,options={}){const g=polygonSignatureSteps(doc,defs,options);let r=g.next();while(!r.done)r=g.next();return r.value;}
  function* polygonSignatureSteps(doc,defs,options={},chunk=Infinity){
    const list=polygons(doc),out={};if(!list.length)return out;
    const version=SIGNATURE_VERSION,projectPrecision=true;
    // options.itemHashes: the per-item part of an earlier pass over exactly these items (live
    // pours: the stale check's pass, reused by the commit plan of the same revision).
    const reuse=options.itemHashes&&options.itemHashes.source===doc.items&&options.itemHashes.length===doc.items.length?options.itemHashes:null;
    const items=reuse?reuse.items:(doc.items||[]).filter(i=>i.kind!=="netlabel"&&!(i.kind==="polygon"&&!i.cutout));
    const fps=new Map(),boxes=reuse?reuse.boxes:new Float64Array(items.length*4),words=reuse?reuse.words:new Uint32Array(items.length*2),layerOf=reuse?reuse.layerOf:new Array(items.length);
    const mirrored=options.mirrorSignatures;
    if(options.keepItemHashes)options.keepItemHashes({source:doc.items,length:(doc.items||[]).length,items,boxes,words,layerOf});
    for(let k=reuse?items.length:0;k<items.length;k++){
      if(k&&k%chunk===0)yield;
      const i=items[k];
      let entry=mirrored?.get(i);
      if(!entry){
        const fpw=i.kind==="part"?fpWords(fps,defs,i,projectPrecision):null,old=mirrored?null:itemSigs.get(i);
        // Ordinary editor rows can be mutated in place; mirror rows are replaced by journal messages.
        if(old&&sigValid(old,i,fpw))entry=old;
        else{
          const box=itemBox(i,defs);
          // Single-layer copper only reaches pours on its layer.
          const layer=(i.kind==="track"||i.kind==="graphic"||i.kind==="label")&&!i.keepout&&COPPER.test(i.layer||"")?i.layer:null;
          const h=fastHasher(projectPrecision);
          for(const f of geometryFields)if(i[f]!==undefined){h.value(f);h.value(i[f]);}
          if(!i.fill&&i.arc?.kind==="arc"&&Atrium.pathArc(i))h.value(ARC_STAMP);
          if(fpw){h.mix(fpw[0]);h.mix(fpw[1]);}
          const w=h.words();
          if(mirrored){entry={box,layer,w0:w[0],w1:w[1]};mirrored.set(i,entry);}
          else{entry=sigEntry(i,fpw,box,layer,w);itemSigs.set(i,entry);}
        }
      }
      boxes.set(entry.box,4*k);layerOf[k]=entry.layer;words[2*k]=entry.w0;words[2*k+1]=entry.w1;
    }
    const rules=pourRules(doc,options);
    const base=fastHasher(projectPrecision);base.value(doc.outline||null);{const ch=globalThis.AtriumBoardShape?.holes?.(doc);if(ch?.length)base.value(ch);}base.value(rules);
    const reach=ruleReach(rules,options);
    if(reach.override!=null)base.value(["clearance",reach.override]);
    scopeDependencies(base,doc,rules,options);
    const queryClearance=needsScopeTrace(rules,"clearance")&&!finite(options.clearance)&&!options.clearanceFor;
    const common=base.words(),byPolygon=new Map(),connectRules=projectPrecision&&hasConnectRules(rules);
    // Older fills could use a native rule list's serialized mirror after a scoped miss.
    // Only invalidate inherited fills whose old fallback could differ from the normal gap.
    const R=globalThis.AtriumRules;
    const changedFallback=R&&Array.isArray(rules?.list)&&
      [rules.defaults?.clearance,...Object.values(rules.nets||{}).map(r=>r?.clearance)].some(gap=>finite(gap)&&gap!==.2)&&
      !rules.list.some(r=>r.type==="clearance"&&R.kit.allScope(r.scope)&&R.kit.allScope(r.scope2)&&R.ruleActive(rules,r));
    let connect=options.connect;
    if(!options.sourceInputs)for(const r of doc.pcbDrawing?.pours||[])if(r.polygon!=null){let l=byPolygon.get(r.polygon);if(!l)byPolygon.set(r.polygon,l=[]);l.push(r);}
    for(const p of list){
      const s=settings(p),h=fastHasher(projectPrecision),area=signatureArea(s,reach);
      const targets=projectPrecision&&variableConnections(s,connectRules)?[]:null;
      const nearby=queryClearance&&s.clearance==null?[]:null;
      h.mix(version);h.mix(common[0]);h.mix(common[1]);
      if(changedFallback&&s.clearance==null&&!finite(options.clearance)&&!options.clearanceFor)h.value("native clearance fallback");
      const {id,...rest}=s;h.value(rest);
      for(let k=0;k<items.length;k++){
        if(boxes[4*k]>area[2]||boxes[4*k+2]<area[0]||boxes[4*k+1]>area[3]||boxes[4*k+3]<area[1]||(layerOf[k]&&layerOf[k]!==p.layer))continue;
        h.mix(words[2*k]);h.mix(words[2*k+1]);
        if(nearby)nearby.push(items[k]);
        if(targets&&(items[k].kind==="part"||items[k].kind==="pad"||items[k].kind==="via"))targets.push(items[k]);
      }
      // A transistor elsewhere on the net, copper thickness or a component-scoped rule can
      // change a local pad's connection. Fingerprint the copper-making decisions, not labels.
      if(targets?.length){
        connect||=connectContext(doc,defs,options);
        connectTargets(doc,defs,s,o=>{
          const d=connect.decide(o);h.value(d.key);h.value(d.style);
          if(d.style==="relief")h.value([d.spokeWidth,d.entries,d.angle,d.airGap]);
        },targets);
      }
      // A typed clearance scope can read comments, custom fields, or geometry
      // elsewhere on the board. Sign the gaps the physical solver selected for
      // this polygon. The trace skips clipping, hatching and integer tasks.
      let regionGap;
      if(nearby){
        connect||=connectContext(doc,defs,options);
        h.value("scoped-clearance");
        yield* prepareSteps(doc,defs,p,{...options,connect,items:nearby,noGlobals:true,arcs:false,
          slices:chunk!==Infinity,stats:{},traceClearance:gap=>h.value(gap)});
        regionGap=clearanceFor(doc,s,{...options,connect,defs,owner:p});
      }
      // Earlier pours on this layer enter through their stored copper near
      // this polygon, so an edit far from the shared border leaves it fresh.
      for(const q of list){
        if(q===p)break;if(q.layer!==p.layer||s.net&&q.net===s.net)continue;
        if(options.sourceInputs){if(regionGap)h.value(regionGap(q.net||"","poly",q));continue;}
        for(const r of byPolygon.get(q.id)||[]){
          const b=r.bounds;if(!Array.isArray(b)||b[0]>area[2]||b[2]<area[0]||b[1]>area[3]||b[3]<area[1])continue;
          if(regionGap)h.value(regionGap(r.net||"","poly",q));
          const w=regionWords(r,area);h.mix(w[0]);h.mix(w[1]);
        }
      }
      out[p.id]=version+":"+h.hex();
      if(chunk!==Infinity)yield;
    }
    return out;
  }
  // ------------------------------------------------- exact reuse (incremental Repour All)
  // A pour's copper is a pure function of its task (the integer shapes and anchors prepare()
  // builds) plus what finish() reads (links, arcs, frame). Each pour keeps the last copper it
  // computed with two keys, and a repour hands that copper back instead of solving again:
  //  - input key (no prepare at all): the pour's settings, the board outline, holes, rules,
  //    stackup thickness and its net's power class are unchanged; the earlier copper it clears (the
  //    rings earlierRingsOf gives prepare(), by content) is the same; and since the entry was made, the
  //    undo store's change journal names no item that contributed to the pour, and none of the
  //    changed items contributes now (prepare() over just those items finds nothing). Needs the
  //    journal; without it (scripts, MCP, a gap) this key is skipped.
  //  - task key: prepare() ran and its task hashes the same (96 bits over every integer).
  // Both give byte-identical copper to a full serial repour (tests/repour-incremental.cjs).
  // Entries are kept per polygon id (bounded); regions are handed out by reference, and an entry is
  // used only while its regions' data, links, arcs and bounds are the same objects.
  const EntryRef=globalThis.WeakRef;
  // A board owns its entries, including the saved clearance closure. The shared
  // LRU only indexes them, so it cannot keep a board or its project alive.
  const REUSE={on:!!EntryRef,max:256,book:new Map(),byDocument:new WeakMap(),journal:null,inflight:new Map(),
    stats:{runs:0,pours:0,inputHits:0,taskHits:0,stage1Hits:0,solved:0,probed:0,joined:0,msSaved:0}};
  const reuseEntry=(doc,id)=>REUSE.byDocument.get(doc)?.get(id);
  function dropReuseEntry(id){
    const e=REUSE.book.get(id)?.deref();
    REUSE.book.delete(id);
    if(e)REUSE.byDocument.get(e.doc)?.delete(id);
    return e;
  }
  function* reuseEntries(){
    for(const [id,ref] of REUSE.book){const e=ref.deref();if(e)yield e;else REUSE.book.delete(id);}
  }
  function clearReuse(){REUSE.book.clear();REUSE.byDocument=new WeakMap();}
  const journalOf=()=>REUSE.journal||globalThis.AtriumUndoStore||null;
  function reuseRun(doc,defs,options,connect){
    if(!REUSE.on||options.reuse===false||options.keyed||options.items||typeof options.clearanceFor==="function")return null;
    const J=journalOf();let seq=null,outer=null;
    try{if(J?.changed){seq=J.changed(doc).seq;outer=J.outer?.()??null;}}catch{seq=null;}
    const h=fastHasher();
    h.value(doc.outline||null);
    try{const ch=globalThis.AtriumBoardShape?.holes?.(doc);h.value(ch?.length?ch:null);}catch{h.value("holes?");}
    const rules=pourRules(doc,options);h.value(rules);scopeDependencies(h,doc,rules,options);
    // A changed query operand can live outside this polygon's item journal.
    // The prepared task still proves exact reuse after evaluating the rule.
    if(needsScopeTrace(rules))seq=null;
    h.value(finite(options.clearance)?options.clearance:null);h.value(options.arcs===false);
    REUSE.stats.runs++;
    return {doc,defs,options,connect,J,seq,outer,common:h.words(),changes:new Map()};
  }
  function reuseKey(rc,P){
    const h=fastHasher(),{id,...rest}=P;
    h.mix(rc.common[0]);h.mix(rc.common[1]);h.value(rest);
    if(P.net&&rc.connect){
      try{h.value(rc.connect.power(P.net));h.value(rc.connect.currentOf(P.net));}catch{h.value("power?");}
      try{h.value(globalThis.AtriumStackup?.layerInfo?.(rc.doc,P.layer,rc.defs)?.thickness??null);}catch{h.value("stack?");}
    }
    return h.hex();
  }
  function intact(e){
    const R=e.regions;
    for(let k=0;k<R.length;k++){const r=R[k],s=e.saved[k];if(r.data!==s[0]||r.links!==s[1]||r.arcs!==s[2]||r.bounds!==s[3]||r.polygon!==e.id)return false;}
    return true;
  }
  // 96-bit hash of everything solve() and finish() read.
  function jobWords(job){const g=jobWordsSteps(job);let r=g.next();while(!r.done)r=g.next();return r.value;}
  // jobWords as steps: yields every `chunk` shapes (the pooled Repour All hashes in slices).
  function* jobWordsSteps(job,chunk=Infinity){
    let a=2166136261,b=5381,c=0x9e3779b9;
    const m=x=>{a=Math.imul(a^x,16777619);b=(Math.imul(b,33)^x)|0;c=Math.imul(c^(x>>>15|x<<17),0x85ebca6b)+0x632be59b|0;};
    const ints=r=>{m(r.length);for(let i=0;i<r.length;i++){const x=r[i];a=Math.imul(a^x,16777619);b=(Math.imul(b,33)^x)|0;c=Math.imul(c^(x>>>15|x<<17),0x85ebca6b)+0x632be59b|0;}};
    const num=v=>{F64[0]=v;m(U32[0]);m(U32[1]);};
    const t=job.task;
    m(t.shapes.length);let n=0;for(const s of t.shapes){if(++n%chunk===0)yield;m(s.cls);m(s.sign);ints(s.ring);if(s.tags)ints(s.tags);else m(-7);}
    m(t.K);m(t.hasBoard?1:0);m(t.removeDead?1:0);num(t.minArea);num(t.minSize);
    m(t.anchors.length);for(const r of t.anchors)ints(r);
    const q=fastHasher();q.value(job.links);q.value(job.P.id);q.value(job.layer);q.value(job.net||"");q.value(!!job.stats.hatchSkipped);
    const w=q.words();m(w[0]);m(w[1]);num(job.S);num(job.ox);num(job.oy);
    if(job.arcs){m(job.arcs.length);for(const v of job.arcs)num(v);}else m(-9);
    // Stage 2's island tests (two-stage pours): the anchors, dead copper, area and size limits.
    const f=job.final;
    if(f){m(f.removeDead?1:0);num(f.minArea);num(f.minSize);m(f.anchors.length);for(const r of f.anchors)ints(r);}else m(-11);
    // Remove Necks / Outlines Only on the final copper.
    const mo=f?.morph;
    if(mo){m(mo.mode);ints(mo.t);if(mo.u)ints(mo.u);else m(-13);m(mo.keep.length);for(const r of mo.keep)ints(r);}else m(-12);
    return (a>>>0).toString(16)+"."+(b>>>0).toString(16)+"."+(c>>>0).toString(16);
  }
  function changesSince(rc,seq){
    let ch=rc.changes.get(seq);
    if(!ch){try{ch=rc.J.changed(rc.doc,seq);}catch{ch={ids:null};}rc.changes.set(seq,ch);}
    return ch;
  }
  // The entry of `p` when its stage-1 inputs are unchanged (input key), else null. Stage 1 reads no
  // other pour; whether its copper is still right also depends on the earlier copper (stage 2).
  function reuseInput(rc,p,P,key){
    const e=reuseEntry(rc.doc,p.id);
    if(!e||e.key!==key||rc.seq==null||e.seq==null||e.outer!==rc.outer)return null;
    for(let k=0;k<e.lib.length;k+=3){const def=rc.defs?.get?.(e.lib[k]);if(def!==e.lib[k+1]||def?.footprint!==e.lib[k+2])return null;}
    const ch=changesSince(rc,e.seq);if(!ch.ids)return null;
    const probe=[];
    for(const id of ch.ids){
      if(e.contrib.has(id))return null;
      const i=ch.items.get(id);
      // Pours enter through the key (this one) and the earlier regions (the others).
      if(i&&!(i.kind==="polygon"&&!i.cutout))probe.push(i);
    }
    if(probe.length){
      const found=new Set();REUSE.stats.probed+=probe.length;
      prepare(rc.doc,rc.defs,p,{...rc.options,connect:rc.connect,items:probe,noGlobals:true,contrib:found,arcs:false});
      if(found.size)return null;
    }
    e.seq=ch.seq;
    return e;
  }
  // e: {key, seq, contrib, hash1 (stage-1 task hash, "none": no task), job (stage 1's job without its
  // shapes), solved1 (stage 1's solution), earlier (earlierKey), regions, stats, solved (solved now)}.
  function reuseStore(rc,p,x){
    const book=REUSE.book,old=dropReuseEntry(p.id),spec=!!rc.options.speculative;
    // Speculative copper (specUse below) that is replaced before any Repour used it was wasted work.
    if(old?.spec&&old.regions!==x.regions)specWaste(old);
    // The library entries of contributing parts, by reference (a library swapped outside the undo store).
    if(!rc.byId||rc.byId.n!==rc.doc.items.length){rc.byId=new Map();rc.byId.n=rc.doc.items.length;for(const i of rc.doc.items)rc.byId.set(i.id,i);}
    const lib=[];for(const cid of x.contrib){const i=rc.byId.get(cid);if(i?.kind==="part"){const def=rc.defs?.get?.(i.def);lib.push(i.def,def,def?.footprint);}}
    const e={id:p.id,doc:rc.doc,key:x.key,seq:x.seq,outer:rc.outer,contrib:x.contrib,hash1:x.hash1,job:x.job,solved1:x.solved1,earlier:x.earlier,
      regions:x.regions,stats:x.stats,lib,saved:x.regions.map(r=>[r.data,r.links,r.arcs,r.bounds]),
      spec:spec&&x.solved?true:old?.spec&&old.regions===x.regions?old.spec:false};
    if(e.spec===true&&x.solved)SPEC.stats.poursSolved++,SPEC.stats.cpuMs+=x.stats.ms||0;
    let entries=REUSE.byDocument.get(rc.doc);
    if(!entries)REUSE.byDocument.set(rc.doc,entries=new Map());
    entries.set(p.id,e);
    book.set(p.id,new EntryRef(e));
    while(book.size>REUSE.max){const y=dropReuseEntry(book.keys().next().value);if(y?.spec)specWaste(y);}
  }
  // A Repour (not a speculative one) handed out this entry's copper.
  function reuseUsed(rc,e){if(e.spec&&!rc.options.speculative){e.spec=false;SPEC.stats.used++;SPEC.stats.usedMs+=e.stats.ms||0;}}
  const reusedStats=(e,how)=>({...e.stats,reused:how});
  // After a repour's own commit (an edit or derive that stores only copper; the undo store counts it
  // as an "outer" change), the entries made since `seq` move past the commit's journal records, so
  // the commit does not void their input key. Nothing moves when any item changed since `seq`.
  // The undo store's touched set for a live commit: apply() edits no item in place (it writes the pours and
  // signatures and drops replaced imported pour tracks from the list); adopting an imported fill can.
  const hintFor=doc=>doc.pcbDrawing?.sourceFill?undefined:{doc,items:[]};
  function restamp(doc,seq){
    const J=journalOf();if(seq==null||!J?.changed)return;
    let ch;try{ch=J.recordedChanges?.(doc,seq)??J.changed(doc,seq);}catch{return;}
    if(!ch.ids||ch.ids.size)return;
    const outer=J.outer?.()??null;
    for(const e of REUSE.byDocument.get(doc)?.values()||[])if(e.seq!=null&&e.seq>=seq){e.seq=ch.seq;e.outer=outer;}
  }
  // The earlier regions a pour may read, in pour order (its pourDependencies).
  function depRegions(deps,j,regionsOf){const out=[];for(const i of deps[j])for(const r of regionsOf[i]||[])out.push(r);return out;}
  // What prepare() reads of earlier copper, by content: the rings it clears (earlierRingsOf) with
  // their pour, index and clearance, hashed. An earlier pour repoured far away keeps this key.
  const ringHashes=new WeakMap();
  function ringWords(ring){
    let w=ringHashes.get(ring);
    if(!w){let a=2166136261,b=5381;for(let i=0;i<ring.length;i++){F64[0]=ring[i];const x=U32[0],y=U32[1];a=Math.imul(a^x,16777619);a=Math.imul(a^y,16777619);b=(Math.imul(b,33)^x)|0;b=(Math.imul(b,33)^y)|0;}w=[a>>>0,b>>>0,ring.length];ringHashes.set(ring,w);}
    return w;
  }
  function earlierKey(rc,P,earlier){
    if(P.cutout||P.shelved||!COPPER.test(P.layer))return "-";
    const outline=P.outline.filter(p=>Array.isArray(p)&&finite(p[0])&&finite(p[1]));if(outline.length<3)return "-";
    const {work}=workBox(rc.doc,outline);if(!(work[0]<work[2]&&work[1]<work[3]))return "-";
    const near=b=>b[0]<=work[2]&&b[2]>=work[0]&&b[1]<=work[3]&&b[3]>=work[1];
    const clearance=clearanceFor(rc.doc,P,rc.options),h=fastHasher();
    for(const r of earlier)earlierRingsOf(r,P,P.layer,P.net,near,clearance,P.arcApproximation,(tag,ring,k,c)=>{h.value(tag);h.mix(k);h.value(c);const w=ringWords(ring);h.mix(w[0]);h.mix(w[1]);h.mix(w[2]);});
    return h.hex();
  }
  // Pour in pour-index order, one polygon per step. Each step yields the
  // pure task of a polygon to solve and receives its solution, so the same
  // code repours synchronously (repourAll), in the background (live pours) and on the worker pool
  // (repourParallel). A yielded solve is {task, hash, stage, j}: hash (with reuse) names the task
  // for joining a solve already in flight; stage 1 or 2; j the pour's index in pour order.
  // options.slices (live pours, the pool): also yields PAUSE between the main-thread steps, answered
  // with undefined, so a caller can give the browser a frame between them. Other callers never see it.
  // WAIT (the pool only): stage 2 needs the earlier pours this one depends on; resumed once they are done.
  const PAUSE=Object.freeze({pause:true}),WAIT=Object.freeze({wait:true});
  // Re-yield a step generator's pauses as PAUSE and return its value.
  function* pauses(g){let r=g.next();while(!r.done){yield PAUSE;r=g.next();}return r.value;}
  function drain(g){let r=g.next();while(!r.done)r=g.next();return r.value;}
  // One pour: stage 1 (reused by the input key or the task hash, else solved), then once the pours
  // it depends on are done, stage 2 (reused when stage 1 and the earlier copper it clears are the
  // same, else solved), canonical, encoded. Returns {regions, stats}.
  // ctx: {doc, defs, rc (reuse run or null), list, deps, regionsOf, options}.
  function* pourSteps(ctx,j){
    const {doc,defs,rc,list,deps,regionsOf}=ctx,o=ctx.options,p=list[j],slices=!!o.slices;
    const area=o.area?.sessions?o.area:null,previousArea=area?.sessions.get(p.id);
    const P=rc?settings(p):null,key=rc?reuseKey(rc,P):null;
    if(rc)REUSE.stats.pours++;
    let job,solved1,area1,area2,hash1=null,contrib=null,seq=null,how=null,solvedHere=false;
    const e=rc?reuseInput(rc,p,P,key):null;
    if(e&&e.hash1==="none"){REUSE.stats.inputHits++;reuseUsed(rc,e);return {regions:e.regions,stats:reusedStats(e,"input")};}
    if(e&&e.solved1){({job,solved1,hash1,contrib,seq}=e);how="input";reuseUsed(rc,e);}
    else{
      if(rc&&rc.seq!=null){try{seq=rc.J.changed(rc.doc).seq;}catch{seq=null;}}
      if(rc)contrib=new Set();
      const po={...o,stats:{}};if(contrib)po.contrib=contrib;delete po.poured;
      if(area)po.areaPrevious=previousArea?.prepared;
      job=slices?yield* pauses(prepareSteps(doc,defs,p,po)):prepare(doc,defs,p,po);
      if(!job.task){
        area?.sessions.delete(p.id);
        if(rc)reuseStore(rc,p,{key,seq,contrib,hash1:"none",job:null,solved1:null,earlier:"-",regions:job.regions,stats:job.stats});
        return {regions:job.regions,stats:job.stats};
      }
      job.nShapes=job.task.shapes.length;
      if(rc){
        hash1=slices?yield* pauses(jobWordsSteps(job,SLICE_CHUNK)):jobWords(job);
        const old=reuseEntry(doc,p.id);
        if(old&&old.hash1===hash1&&old.solved1){solved1=old.solved1;how="task";reuseUsed(rc,old);}
      }
      if(area){
        area1=yield* areaSolveSteps({job,task:job.task,prior:previousArea?.stage1,area,hash:hash1,stage:1,j});
        solved1=area1.solved;
      }else if(!solved1){solved1=yield {task:job.task,hash:hash1,stage:1,j,job};solvedHere=true;}
    }
    while(!deps[j].every(i=>regionsOf[i]!==undefined))yield WAIT;
    if(prerequisiteUnavailable(ctx,j))return deferredPour(ctx,j);
    const earlier=depRegions(deps,j,regionsOf),ek=rc?earlierKey(rc,P,earlier):null;
    const old=rc?reuseEntry(doc,p.id):null;
    if(how&&old&&old.hash1===hash1&&old.earlier===ek&&old.regions&&intact(old)){
      REUSE.stats[how==="input"?"inputHits":"taskHits"]++;REUSE.stats.msSaved+=old.stats.ms||0;
      if(how==="task")reuseStore(rc,p,{key,seq,contrib,hash1,job:old.job,solved1,earlier:ek,regions:old.regions,stats:old.stats});
      return {regions:old.regions,stats:reusedStats(old,how)};
    }
    if(how)REUSE.stats.stage1Hits++;
    const offsets=area&&earlier.length?(previousArea?.offsets||new WeakMap()):null;
    // The island tests of the last solve (areaKeep), for an island the patch left alone or changed.
    const kept=area?{cache:previousArea?.kept||null}:null;
    const s2=slices?yield* pauses(stage2Steps(job,solved1,earlier,false,offsets,kept)):drain(stage2Steps(job,solved1,earlier,false,offsets,kept));
    let solved=s2.solved;
    if(s2.task){
      if(area&&!s2.task.morph){
        const rawTask={...s2.task,anchors:[],removeDead:false,minArea:0,minSize:0};
        area2=yield* areaSolveSteps({job:s2.job,task:rawTask,prior:previousArea?.stage2,area,hash:null,stage:2,j});
        const r=areaKeep(area2.solved,s2.task,previousArea?.kept||null);
        if(r){solved=r.solved;kept.cache=r.cache;}
        else{
          solved=CORE.keepSolved(area2.solved,s2.task,true);
          solved.stats={...area2.solved.stats,deadIslands:solved.stats.deadIslands,tDead:solved.stats.tDead,
            tSolve:(area2.solved.stats.tSolve||0)+solved.stats.tSolve};
        }
      }else{
        solved=yield {task:s2.task,hash:rc?hash1+"/"+ek:null,stage:2,j};solvedHere=true;
      }
    }
    finalize(solved,s2.stage1,!!area);
    const regions=slices?yield* pauses(finishSteps(s2.job,solved)):finish(s2.job,solved);
    if(area){
      s2.job.stats.area={stage1:area1.stats,stage2:area2?.stats||(s2.task?.morph?{mode:"full",reason:"island-shaping"}:null)};
      area.sessions.set(p.id,{stage1:area1,stage2:area2,prepared:job.areaPrepared,offsets,kept:kept.cache});
    }
    if(rc){
      if(solvedHere)REUSE.stats.solved++;
      reuseStore(rc,p,{key,seq,contrib,hash1,job:job.task?{...job,task:null,regions:null}:job,solved1,earlier:ek,regions,stats:s2.job.stats,solved:solvedHere});
    }
    return {regions,stats:s2.job.stats};
  }
  // A pour whose solve fails (an error in the core, a worker that crashes or hangs, the time
  // budget) keeps its previous copper: pourSteps under guard returns the regions the pour had
  // before the run, and the run goes on with the others. apply() keeps that pour's old signature,
  // and marks its result and dependent copper unverified. failures(doc) names the failed solve for Design Insights
  // (pourFailed) until it repours.
  const FAILED=new WeakMap();
  const failures=doc=>FAILED.get(doc)||{};
  // The last refill of each pour this session ({id: {at (epoch ms), ms (solve and encode)}}), for the
  // Pours panel. Not stored in the document: a save or undo never changes because of it.
  const REFILLS=new WeakMap();
  const refills=doc=>REFILLS.get(doc)||{};
  function noteRefills(doc,result,repoured){
    if(!doc||!result)return;
    const book={...refills(doc)},at=Date.now();
    for(const id of repoured){const st=result.stats?.polygons?.[id];if(st&&!st.failed)book[id]={at,ms:+(st.ms||0)};}
    REFILLS.set(doc,book);
  }
  function noteFailures(doc,result){
    if(!doc||!result)return;
    const book={...failures(doc)};
    for(const id of Object.keys(result.stats?.polygons||{}))if(!result.stats.polygons[id]?.failed)delete book[id];
    for(const f of result.failed||[])book[f.id]={reason:f.reason,at:Date.now(),sig:result.signatures?.[f.id]??null};
    if(Object.keys(book).length)FAILED.set(doc,book);else FAILED.delete(doc);
  }
  // The editor's message after a run that committed with failed pours (else the given text).
  function repouredText(result,text){
    const f=result?.failed||[];
    if(!f.length)return result?.blocked?.length?"Dependent pours kept their previous copper while an earlier pour needs a refill.":text;
    const name=x=>x.name||((x.net||"no net")+" on "+x.layer);
    return (f.length===1?"The "+name(f[0])+" pour":f.length+" pours ("+f.slice(0,3).map(name).join(", ")+(f.length>3?", …":"")+")")+
      " kept "+(f.length===1?"its":"their")+" previous copper and stay"+(f.length===1?"s":"")+" stale: "+f[0].reason+
      (result.blocked?.length?". Dependent pours kept their previous copper too.":". The other pours were repoured.");
  }
  const seconds=ms=>ms>=1000?Math.round(ms/1000)+" s":Math.round(ms)+" ms";
  const failureText=e=>e?.predicted?"no background worker is available and its solve would take about "+seconds(e.predicted)+" on the editor's thread (the limit is "+seconds(e.budget)+")"
    :e?.budget?"its solve took longer than "+seconds(e.budget)+(e.main?" on the editor's thread (no background worker)":"")
    :e?.hung?"its worker stopped responding":e?.crashed?"its worker crashed (twice)":"the solve failed ("+String(e?.message||e).slice(0,160)+")";
  const prerequisiteUnavailable=(ctx,j)=>ctx.deps[j].some(i=>ctx.unavailable[i]);
  function deferredPour(ctx,j){
    ctx.unavailable[j]=1;
    return {regions:ctx.previous.filter(r=>r.polygon===ctx.list[j].id),blocked:true};
  }
  function* guardedPourSteps(ctx,j){
    if(prerequisiteUnavailable(ctx,j))return deferredPour(ctx,j);
    try{
      const result=yield* pourSteps(ctx,j);
      // A cached or empty stage can finish before its prerequisites have finished.
      while(!ctx.deps[j].every(i=>ctx.regionsOf[i]!==undefined))yield WAIT;
      return prerequisiteUnavailable(ctx,j)?deferredPour(ctx,j):result;
    }
    catch(e){
      const id=ctx.list[j].id,reason=failureText(e);
      try{globalThis.AtriumDiagnostics?.record?.("pour-failed",reason);}catch{/* no log */}
      ctx.unavailable[j]=1;
      return {regions:ctx.previous.filter(r=>r.polygon===id),stats:{polygon:id,failed:reason},failed:reason};
    }
  }
  // The run's shared state: pours in order, their dependencies, the copper of each as it is done.
  function runContext(doc,defs,options){
    const list=polygons(doc),connect=options.connect||(list.length?connectContext(doc,defs,options):null);
    options={...options,connect,ruleReach:ruleReach(pourRules(doc,options),options)};
    for(const k of ["active","onProgress","concurrency","onSolving","onDone"])delete options[k];
    const rc=list.length&&!options.area?.sessions?reuseRun(doc,defs,options,connect):null;
    const unavailable=new Uint8Array(list.length),previous=doc.pcbDrawing?.pours||[],unverified=globalThis.AtriumPourMarker.read(doc.pcbDrawing);
    if(options.only&&unverified?.length){
      const pending=new Set(unverified),selected=new Set(options.only);
      list.forEach((p,j)=>{if(pending.has(p.id)&&!selected.has(p.id))unavailable[j]=1;});
    }
    const deps=pourDependencies(doc,defs,list,options,unverified?.length?previous:null);
    return {doc,defs,rc,list,deps,regionsOf:new Array(list.length),options,unavailable,previous};
  }
  // A failed root can leave a later pour's old signature unchanged (it still hashes the
  // retained copper). Carry this evidence even for dependents not selected in this run.
  function unverifiedPours(ctx,stats,blocked){
    if(!ctx.unavailable.some(Boolean))return [];
    // A moved upstream outline can lose a current dependency while its retained copper still
    // occupies the old site. A result calculated against its intended position is unverified too.
    const deps=pourDependencies(ctx.doc,ctx.defs,ctx.list,ctx.options,ctx.previous);
    const eligible=evaluatedPours(ctx.doc),selected=ctx.options.only?new Set(ctx.options.only):null,ids=[];
    forwardMarkPrerequisites(ctx.list,deps,(p,j)=>!ctx.unavailable[j]&&(!selected||eligible.has(p.id)||selected.has(p.id)),i=>ctx.unavailable[i],(p,j)=>{
      ctx.unavailable[j]=1;
      if(stats[p.id]){
        ctx.regionsOf[j]=ctx.previous.filter(r=>r.polygon===p.id);
        delete stats[p.id];blocked.push(p.id);
      }
    });
    ctx.list.forEach((p,j)=>{if(ctx.unavailable[j])ids.push(p.id);});
    return ids;
  }
  function* repourSteps(doc,defs,options={}){
    const t0=now(),only=options.only?new Set(options.only):null,previous=doc.pcbDrawing?.pours||[];
    const ctx=runContext(doc,defs,options),{list,regionsOf,rc}=ctx,perPolygon={},failed=[],blocked=[];
    let paused=!options.slices;
    for(let j=0;j<list.length;j++){
      const p=list[j];
      if(only&&!only.has(p.id)){regionsOf[j]=previous.filter(r=>r.polygon===p.id);continue;}
      if(!paused)yield PAUSE;
      paused=!options.slices;
      const r=yield* guardedPourSteps(ctx,j);
      regionsOf[j]=r.regions;if(r.blocked)blocked.push(p.id);else perPolygon[p.id]=r.stats;
      if(r.failed)failed.push({id:p.id,name:p.name||"",layer:p.layer,net:p.net||"",reason:r.failed});
    }
    const unverified=unverifiedPours(ctx,perPolygon,blocked);
    const poured=[];for(const r of regionsOf)poured.push(...r);
    return {regions:poured,failed,blocked,unverified,stats:{ms:now()-t0,polygons:perPolygon,reuseSeq:rc?rc.seq:null}};
  }
  // Solves here; a solve that throws is thrown into the pour's steps (guardedPourSteps).
  function runSync(gen){
    let r=gen.next();
    while(!r.done){
      if(r.value===PAUSE||r.value===WAIT){r=gen.next();continue;}
      let v;try{v=CORE.solve(r.value.task);}catch(e){r=gen.throw(e);continue;}
      r=gen.next(v);
    }
    return r.value;
  }
  // Repour all polygons in pour-index order (Altium Tools » Polygon Pours »
  // Repour All). Returns the regions without touching the document.
  function repourAll(doc,defs,options={}){
    if(doc?.pcbDrawing?.sourceFill)adopt(doc,defs,options,false);
    const result=runSync(repourSteps(doc,defs,options));
    // Signatures as they will read once these regions are stored.
    const pours=[...(doc.pcbDrawing?.pours||[]).filter(r=>r.polygon==null),...result.regions];
    result.signatures=polygonSignatures({...doc,pcbDrawing:{...(doc.pcbDrawing||{}),pours}},defs,{...options,rules:pourRules(doc,options)});
    return result;
  }
  // ------------------------------------------------------------ parallel repour
  // The exact solves of pours that do not read each other's copper run at the same time on the
  // shared worker pool (worker-pool.js). A pour reads the copper of earlier pours on its layer,
  // of another net, near its outline (prepare); every other earlier pour is left out of its
  // shapes, so it may pour before, after or beside them. Each pour gets exactly the earlier copper
  // the serial loop would hand it (its dependencies' regions, in pour order) and the result is
  // assembled in pour order, so the copper is identical to repourAll's
  // (tests/parallel-equivalence.cjs). Shape gathering (prepare) and encoding (finish) stay on
  // this thread between the solves; other pours solve meanwhile.
  // The pour worker gets the Rust/WebAssembly core too when engine-core.js has loaded (else the JS core).
  // A task with previewOpts (Repour All with the progress display) first posts the display-only
  // preview (pour-preview.js, when it was loaded before the workers started) as a progress message.
  const solveSource=()=>'"use strict";'+(globalThis.AtriumEngine?.workerSource?.()||"")+(globalThis.AtriumPourPreview?.source?.()||"")+'const PourCore='+PourCore.toString()+';const C=PourCore();\n'+
    'const bufs=r=>{const tr=[];for(const i of r.islands){tr.push(i.ring.buffer,i.tags.buffer);for(const h of i.holes)tr.push(h.ring.buffer,h.tags.buffer);}return tr;};\n'+
    'onmessage=e=>{const id=e.data.id;try{const task=e.data.task.packed?C.unpack(e.data.task):e.data.task;if(task.previewOpts&&typeof PourPreview==="function"){try{const p=PourPreview().solve(task,{...task.previewOpts,core:C});postMessage({id,progress:p},bufs(p));}catch{/* no preview */}}'+
    'const r=C.solve(task);postMessage({id,result:r},bufs(r));}catch(err){postMessage({id,error:String(err&&err.message||err)});}};';
  // POOL_WORKERS workers (POOL_SIZE.n when set: poolSize() for measurements). With two stages every
  // pour's stage 1 solves at once, so more than the two single-stage chains of the 25.6k board pay
  // off. worker-pool.js caps it at 2 while
  // AtriumPower.efficient() (Efficiency mode, battery, Low Power Mode).
  const POOL_WORKERS=4,POOL_SIZE={n:0};
  // A solve's time budget on a worker (repourParallel options.budgetMs), and the pool's watchdog
  // behind it (worker-pool.js watchdogMs, where the pool has one: a worker that posts nothing).
  const POUR_BUDGET_MS=60000,FAIL=Symbol("failed");
  const solveVersion=()=>(globalThis.AtriumEngine?.variant||"js")+(globalThis.AtriumPourPreview?.source?":preview":":plain");
  // A crashed solve is retried once in a fresh worker, then fails (the pour keeps its copper); only
  // where no worker can start does a solve run here, in idle time with its budget (mainSolve).
  const solvePool=()=>{const n=POOL_SIZE.n||POOL_WORKERS;return globalThis.AtriumWorkerPool?.get?.(n===POOL_WORKERS?"pour-solve":"pour-solve-"+n,solveSource,{size:n,local:t=>mainSolve(t),crash:"fail",sourceVersion:solveVersion,watchdogMs:2*POUR_BUDGET_MS})||null;};
  // ---- a pour solve on the editor's thread (no worker can run it)
  // It runs only in idle time, through the cooperative check scheduler (checks.js, client "pour-solve")
  // when that is attached, else through idle callbacks of its own: the JS core in steps (one per
  // phase), the Rust/WebAssembly core as one step that cannot be cut. No step starts while the user
  // drags or types (interacting()). The budget counts the time of the steps: past it the solve stops
  // and is answered with error.budget (the pour keeps its copper, the pourFailed path). A solve
  // whose predicted time (its edges × the measured rate) is past the budget is not started at all.
  // mainSolve(task, {budgetMs, interacting}) -> Promise with cancel() (rejects {cancelled}).
  const MAIN={rate:.002,runs:0,failed:0,seq:0,input:null,client:null,last:null};
  function inputWatch(){
    if(MAIN.input||typeof globalThis.addEventListener!=="function")return;
    const st=MAIN.input={key:-Infinity,down:false},o={capture:true,passive:true};
    globalThis.addEventListener("keydown",()=>{st.key=now();},o);
    globalThis.addEventListener("pointerdown",()=>{st.down=true;},o);
    for(const t of ["pointerup","pointercancel","blur"])globalThis.addEventListener(t,()=>{st.down=false;},o);
  }
  // A drag (the editor's, or any pointer held down) or typing (a key in the last 800 ms).
  function interacting(){
    const H=live.host||globalThis.AtriumNavHost;
    try{if(H?.drag?.())return true;}catch{/* no editor */}
    const st=MAIN.input;return !!st&&(st.down||now()-st.key<800);
  }
  function taskEdges(task){
    if(task.packed){let n=0;for(let k=0;k<task.nShapes;k++)n+=task.head[4*k+2]>>1;return n;}
    let n=0;for(const s of task.shapes||[])n+=s.ring.length>>1;return n;
  }
  function mainSolve(task,o={}){
    const budget=o.budgetMs??POUR_BUDGET_MS,busy=o.interacting||interacting,edges=taskEdges(task);
    inputWatch();
    let cancelled=false,reject=null;
    const S=globalThis.AtriumChecks?.scheduler,useScheduler=!o.own&&!!S?.host?.()&&typeof S.queue==="function";
    const WAITV=useScheduler&&S.WAIT||MAIN;
    const promise=new Promise((ok,no)=>{
      reject=no;
      const predicted=edges*MAIN.rate;
      if(predicted>budget){MAIN.failed++;no(Object.assign(Error("budget"),{budget,predicted:Math.round(predicted),main:true}));return;}
      const g=CORE.solveSteps(task);let active=0;
      function* driver(){
        for(;;){
          if(cancelled)return;
          if(busy()){yield WAITV;continue;}
          const t=now();let r;
          try{r=g.next();}catch(e){no(e);return;}
          active+=now()-t;
          if(r.done){MAIN.runs++;MAIN.last={edges,ms:active};if(edges>1000)MAIN.rate=Math.max(MAIN.rate*.5,.7*MAIN.rate+.3*active/edges);ok(r.value);return;}
          if(active>budget){try{g.return(undefined);}catch{/* stopped */}MAIN.failed++;no(Object.assign(Error("budget"),{budget,main:true}));return;}
          // Before an uncut step the slice ends, so that step starts a fresh idle slice.
          yield r.value==="atomic"?WAITV:undefined;
        }
      }
      if(useScheduler){
        if(MAIN.client!==S||!S.clients?.().includes("pour-solve")){
          S.client({id:"pour-solve",manual:true,key:d=>d.key,due:()=>false,docs:()=>[],phase:()=>"idle",start:d=>d.run()});MAIN.client=S;
        }
        S.queue("pour-solve",{id:"pour-solve",kind:"pcb",key:"pour-solve:"+(++MAIN.seq),run:driver},"idle");
        return;
      }
      // Without the scheduler: idle callbacks (AtriumIdle, requestIdleCallback, else timers).
      const it=driver(),I=globalThis.AtriumIdle;
      const later=(fn,wait)=>wait||!(I?.idle||globalThis.requestIdleCallback)?setTimeout(()=>fn(null),wait?50:0):I?.idle?I.idle(fn,{timeout:3000}):globalThis.requestIdleCallback(fn,{timeout:3000});
      const pump=dl=>{
        const t0=now(),cap=Math.max(4,Math.min(8,dl?.timeRemaining?.()??8));
        for(;;){const r=it.next();if(r.done)return;if(r.value===WAITV){later(pump,busy());return;}if(now()-t0>=cap)break;}
        later(pump,false);
      };
      later(pump,false);
    });
    return Object.assign(promise,{cancel(){
      if(cancelled)return;
      cancelled=true;reject?.(Object.assign(Error("cancelled"),{cancelled:true}));
    }});
  }
  // The pool module is small and lazy: fetched once this module loads, so Repour All finds it.
  try{if(!globalThis.AtriumWorkerPool&&typeof Worker==="function")globalThis.AtriumLazy?.need?.("AtriumWorkerPool")?.catch?.(()=>{});}catch{/* serial repour */}
  // The Repour All progress display and its display-only preview (worker source reads the preview: fetched before the first worker starts).
  try{if(typeof Worker==="function"){if(!globalThis.AtriumPourAnim)globalThis.AtriumLazy?.need?.("AtriumPourAnim")?.catch?.(()=>{});if(!globalThis.AtriumPourPreview)globalThis.AtriumLazy?.need?.("AtriumPourPreview")?.catch?.(()=>{});}}catch{/* no animation */}
  // One forward pass over pourDependencies' ordered list. A pour closes when any earlier prerequisite is already closed.
  function forwardMarkPrerequisites(list,deps,accept,prerequisiteMarked,mark){
    list.forEach((p,j)=>{if(accept(p,j)&&deps[j].some(prerequisiteMarked))mark(p,j);});
  }
  // For each pour in list order, the earlier pours whose copper it may read (indices, ascending).
  // Conservative: same layer, not both of one net, outline boxes within the clearance plus 1 mm.
  function pourDependencies(doc,defs,list,options={},retained){
    const S=list.map(settings),boxes=S.map(s=>{const o=(s.outline||[]).filter(p=>Array.isArray(p)&&finite(p[0])&&finite(p[1]));return o.length?boxOf(o.flatMap(p=>[+p[0],+p[1]])):null;});
    const previous=retained?.length?new Map():null;
    for(const r of retained||[])if(r.polygon!=null&&Array.isArray(r.bounds)){
      if(!previous.has(r.polygon))previous.set(r.polygon,[]);
      previous.get(r.polygon).push(r);
    }
    return S.map((P,j)=>{
      const deps=[],w=boxes[j];
      if(P.cutout||P.shelved||!COPPER.test(P.layer)||!w)return deps;
      let c=null;
      const applicable=(layer,net)=>layer===P.layer&&(!P.net||net!==P.net);
      const near=(bounds,net,upstream)=>{
        c??=clearanceFor(doc,P,{...options,defs,owner:list[j]});
        const m=(+c(net||"","poly",upstream)||0)+1;
        return bounds[0]-m<=w[2]&&bounds[2]+m>=w[0]&&bounds[1]-m<=w[3]&&bounds[3]+m>=w[1];
      };
      for(let i=0;i<j;i++){
        const Q=S[i],b=boxes[i],owner=list[i],old=previous?.get(owner.id);
        if((b&&!Q.cutout&&!Q.shelved&&applicable(Q.layer,Q.net)&&near(b,Q.net,owner))||
            old?.some(r=>applicable(r.layer,r.net)&&near(r.bounds,r.net,owner)))deps.push(i);
      }
      return deps;
    });
  }
  // What the canvas shows (noteView, called by the renderers after a board frame): pours in view
  // are prepared and solved first. Only the order of work changes, never the copper.
  const VIEW={box:null,px:0,doc:null};
  function noteView(box,pxPerMm,doc){if(Array.isArray(box)&&box.length===4){VIEW.box=box;VIEW.px=+pxPerMm||0;VIEW.doc=doc||null;}}
  // Main-thread slices of a pooled run: about SLICE_MS of work, then the browser gets a turn.
  const POOL_SLICE_MS=6;
  function stopRun(run){if(run){run.stopped=true;run.cancel?.();}}
  const yieldTurn=(()=>{
    let channel=null;
    const pending=[];
    return ()=>new Promise(resolve=>{
      if(typeof MessageChannel!=="function"){setTimeout(resolve,0);return;}
      if(!channel){
        channel=new MessageChannel();
        channel.port1.onmessage=()=>{
          const next=pending.shift();
          if(!pending.length)channel.port1.unref?.();
          next?.();
        };
        channel.port2.unref?.();
      }
      if(!pending.length)channel.port1.ref?.();
      pending.push(resolve);
      channel.port2.postMessage(0);
    });
  })();
  // repourAll's result (without signatures), the solves on `pool` (default: the shared pour pool;
  // without one, each solve runs here after a macrotask). Every pour runs pourSteps: stage 1 of every
  // pour goes to the pool at once, stage 2 as soon as the pours it reads are done. The main-thread
  // steps (shape gathering, earlier copper, encoding) run in slices of about POOL_SLICE_MS between
  // turns of the browser, pours in view first, then in pour order. The copper is that of
  // repourAll whatever the order solves come back in (tests/parallel-equivalence.cjs).
  // options.active(): false stops the run (resolves null). options.onProgress({done, total}),
  // options.onSolving(id, stage), options.onDone(id, regions): for the editor's progress display.
  // options.concurrency: at most this many solves at once (speculation: 1).
  // options.idle(ms): work for the caller while every pour waits on a solve (Repour All: the commit
  // plan's board pass, the paths of pours already done); runs about ms, true while more is left.
  async function repourParallel(doc,defs,options={},pool=solvePool()){
    const t0=now(),only=options.only?new Set(options.only):null,previous=doc.pcbDrawing?.pours||[],control=options.control;
    const active=()=>!control?.stopped&&(!options.active||options.active());
    const ctx=runContext(doc,defs,{...options,slices:true}),{list,regionsOf,rc}=ctx,n=list.length;
    const statsOf=new Array(n),gens=new Array(n),send=new Array(n),state=new Uint8Array(n),failed=[],blocked=[];// 0 runnable, 1 solving, 2 waiting, 3 done
    const budget=options.budgetMs??POUR_BUDGET_MS;
    // To a worker, tasks go packed (CORE.pack: two transferred buffers instead of a structured clone).
    const run=(task,progress)=>{
      // Without a pool: on this thread, in idle time, within the budget (mainSolve).
      if(!pool)return mainSolve(task,{budgetMs:budget>0?budget:Infinity});
      const pk=CORE.pack(task);return pool.run(pk.task,pk.transfer,progress,task);
    };
    const requested=Math.max(1,options.concurrency||Infinity),concurrency=()=>Math.max(1,Math.min(requested,pool?.size||1,options.limit?.()??Infinity));
    const inflight=REUSE.inflight,held=new Set();
    const solve=(task,hash,pv)=>{
      let entry=hash&&inflight.get(hash);
      if(entry)REUSE.stats.joined++;
      else{
        if(pv)task.previewOpts=pv.opts;
        const answer=run(task,pv?.done);
        entry={answer,hash,owners:0,done:false};
        if(hash)inflight.set(hash,entry);
        const done=()=>{entry.done=true;if(hash&&inflight.get(hash)===entry)inflight.delete(hash);};
        answer.then(done,done);
      }
      if(!held.has(entry)){held.add(entry);entry.owners++;}
      return entry;
    };
    function release(entry){
      if(!held.delete(entry)||--entry.owners||entry.done)return;
      if(entry.hash&&inflight.get(entry.hash)===entry)inflight.delete(entry.hash);
      entry.answer.cancel?.();
    }
    // Pours in view first (VIEW), then pour order.
    const vb=VIEW.doc===doc||VIEW.doc==null?VIEW.box:null;
    const order=list.map((p,j)=>j);
    if(vb){
      const inView=list.map(p=>{const o=(settings(p).outline||[]).filter(q=>Array.isArray(q)&&finite(q[0])&&finite(q[1]));if(o.length<3)return false;const b=boxOf(o.flatMap(q=>[+q[0],+q[1]]));return b[0]<=vb[2]&&b[2]>=vb[0]&&b[1]<=vb[3]&&b[3]>=vb[1];});
      order.sort((a,b)=>(inView[b]?1:0)-(inView[a]?1:0)||a-b);
    }
    let left=n,error=null,wake=null,main=0,longest=0;
    for(let j=0;j<n;j++){
      if(only&&!only.has(list[j].id)){regionsOf[j]=previous.filter(r=>r.polygon===list[j].id);state[j]=3;left--;}
      else gens[j]=guardedPourSteps(ctx,j);
    }
    // Solves waiting for a free slot (conc), best first: in view, then pour order, stage 2 before stage 1.
    const queued=[];let flying=0;
    const cancel=()=>{queued.length=0;for(const entry of held)release(entry);wake?.();};
    if(control)control.cancel=cancel;
    const rank=new Int32Array(n);order.forEach((j,k)=>rank[j]=k);
    const pump=()=>{
      while(!error&&active()&&flying<concurrency()&&queued.length){
        let b=0;for(let k=1;k<queued.length;k++){const x=queued[k],y=queued[b];if(rank[x.j]<rank[y.j]||rank[x.j]===rank[y.j]&&x.stage>y.stage)b=k;}
        const q=queued.splice(b,1)[0];
        let entry;
        try{
          options.onSolving?.(list[q.j].id,q.stage);
          const preview=q.stage===1&&q.job&&options.preview?options.preview(list[q.j].id,q.job,q.task):null;
          entry=solve(q.task,q.hash,preview&&{...preview,done:value=>{if(active())preview.done(value);}});
        }catch(e){error=e;break;}
        flying++;
        // The time budget: a solve still running after budgetMs is cancelled (its worker is stopped)
        // and the pour keeps its previous copper. Without workers mainSolve keeps the budget itself.
        let timedOut=false;
        const timer=pool&&budget>0?setTimeout(()=>{timedOut=true;entry.answer.cancel?.();},budget):0;
        entry.answer.then(v=>{clearTimeout(timer);release(entry);flying--;if(!error&&active()){send[q.j]=v;state[q.j]=0;pump();}wake?.();},e=>{
          clearTimeout(timer);release(entry);flying--;
          if(!error&&active()){
            // A pour's own failure (error, crash, hang, budget) fails that pour only; a cancel from elsewhere stops the run.
            if(e?.cancelled&&!e.hung&&!timedOut)error=e;
            else{send[q.j]={[FAIL]:timedOut?Object.assign(Error("budget"),{budget}):e};state[q.j]=0;pump();}
          }
          wake?.();
        });
      }
    };
    const ready=j=>state[j]===0||state[j]===2&&ctx.deps[j].every(i=>regionsOf[i]!==undefined);
    try{while(left>0){
      if(!active()||error)break;
      const t=now();let ran=false;
      // Keep at most one prepared task per worker waiting in memory.
      while(queued.length<concurrency()){
        let j=-1;for(const k of order)if(gens[k]&&state[k]!==1&&state[k]!==3&&ready(k)){j=k;break;}
        if(j<0)break;
        ran=true;
        const v=send[j];send[j]=undefined;
        let r;
        try{r=v&&v[FAIL]?gens[j].throw(v[FAIL]):gens[j].next(v);}catch(e){error=e;break;}
        if(r.done){
          regionsOf[j]=r.value.regions;statsOf[j]=r.value.stats;state[j]=3;gens[j]=null;left--;
          if(r.value.blocked)blocked.push(list[j].id);
          else if(r.value.failed)failed.push({id:list[j].id,name:list[j].name||"",layer:list[j].layer,net:list[j].net||"",reason:r.value.failed});
          options.onDone?.(list[j].id,r.value.regions);options.onProgress?.({done:n-left,total:n});
        }
        else if(r.value===WAIT)state[j]=2;
        else if(r.value===PAUSE)state[j]=0;
        else{state[j]=1;queued.push(r.value);pump();}
        if(now()-t>=POOL_SLICE_MS)break;
      }
      main+=now()-t;longest=Math.max(longest,now()-t);
      if(left<=0||error||!active())break;
      const more=queued.length<concurrency()&&order.some(k=>gens[k]&&state[k]!==1&&ready(k));
      if(more||ran&&now()-t>=POOL_SLICE_MS)await yieldTurn();
      else if(options.idle&&flying){const ti=now(),go=options.idle(POOL_SLICE_MS);main+=now()-ti;if(go)await yieldTurn();else await new Promise(r=>{wake=()=>{wake=null;r();};});}
      else if(flying)await new Promise(r=>{wake=()=>{wake=null;r();};});
      else throw Error("The polygon pour could not continue.");
    }}finally{if(control?.cancel===cancel)control.cancel=null;cancel();}
    if(error){if(!active())return null;throw error;}
    if(!active())return null;
    const perPolygon={};
    for(let j=0;j<n;j++)if(statsOf[j])perPolygon[list[j].id]=statsOf[j];
    const unverified=unverifiedPours(ctx,perPolygon,blocked),poured=[];
    for(const r of regionsOf)poured.push(...r);
    // main: this thread's time in the run (prepare, reuse checks, finish), for the energy figures.
    return {regions:poured,failed,blocked,unverified,stats:{ms:now()-t0,main,longest,polygons:perPolygon,parallel:pool?pool.size:0,reuseSeq:rc?rc.seq:null}};
  }
  // A step generator run in slices of about POOL_SLICE_MS (signatures, path warming before a commit).
  async function driveSlices(gen,still){
    let main=0;
    for(;;){
      const t=now();let r;do r=gen.next();while(!r.done&&now()-t<POOL_SLICE_MS);
      main+=now()-t;
      if(r.done)return {value:r.value,main};
      await yieldTurn();if(!still())return null;
    }
  }
  // Repour All in the editor: the solves on the pool, then one edit that stores the copper (one
  // undo step). The main thread only runs short slices, so the board pans, zooms and selects at
  // frame rate meanwhile, and editing goes on: an edit that lands meanwhile starts the run again on
  // the new board, where the pours it did not reach are handed back by the reuse book (and solves
  // still in flight are joined), so only the affected pours pour again.
  // While it runs, AtriumPourAnim (pour-anim.js, when loaded) shows progress on the pours' outlines
  // and reveals each pour's copper as it is done; the commit stores exactly that copper.
  let pooled=null;
  // Expected wall time of a Repour All: the last run's, else the pours' last solve times.
  function expectMs(doc){
    if(REUSE.last?.ms&&REUSE.last.doc===doc?.id)return REUSE.last.ms;
    let ms=0;for(const p of polygons(doc)){const e=reuseEntry(doc,p.id);ms+=e?.stats?.ms||0;}
    return ms||Infinity;
  }
  // The fast, approximate copper of a pour (pour-preview.js: the pour predicate sampled on the screen's
  // pixel grid, under a pixel off at the current zoom) for the progress display only: the worker
  // posts it before the exact solve of the same task (no second copy of the task). It is stage 1's
  // copper (earlier pours not yet cleared), encoded here and handed to AtriumPourAnim.preview; it
  // never reaches the document, Gerber, DRC, connectivity or a save, and the exact copper replaces it.
  // Only while the animation shows (its begin() said so) and when the preview is worth it (worthIt).
  function previewFor(A,showing,doc,id,job,task,token){
    const PV=globalThis.AtriumPourPreview;
    if(!showing||!PV?.worthIt||typeof A?.preview!=="function")return null;
    const mine=VIEW.box&&(VIEW.doc==null||VIEW.doc===doc),px=mine&&VIEW.px>0?VIEW.px:4,pixel=job.S/px;
    const view=mine?[(VIEW.box[0]-job.ox)*job.S,(VIEW.box[1]-job.oy)*job.S,(VIEW.box[2]-job.ox)*job.S,(VIEW.box[3]-job.oy)*job.S]:undefined;
    let w;try{w=PV.worthIt(task,{pixel,view,engine:globalThis.AtriumEngine?"wasm":"js"});}catch{return null;}
    if(!w.worth)return null;
    return {opts:{pixel,view},done:pv=>{
      try{
        const stats={};
        /** @type {ReturnType<typeof encode>[] & {stats?: typeof stats}} */
        const regions=[];regions.stats=stats;
        const out=finish({...job,final:undefined,arcs:null,regions,stats},{...pv,final:true});
        for(const r of out)r.preview=true;
        A.preview(token,id,out);
      }catch{/* display only */}
    }};
  }
  // current() as steps: the signatures hashed in chunks.
  function* currentSteps(doc,defs,options){
    const d=doc?.pcbDrawing;
    if(!d||d.sourceFill||!(d.pours||[]).every(r=>r.polygon!=null))return false;
    if(d.pourSignatures&&d.pourSignatureVersion!==SIGNATURE_VERSION)return false;
    const sigs=yield* polygonSignatureSteps(doc,defs,options,SLICE_CHUNK);
    return !staleFromSignatures(doc,sigs).length;
  }
  // The commit plan's work that needs no new copper, done while the solves run (the main thread
  // waits on the workers then): the per-item hashes of the pour signatures (itemHashes, unless the
  // up-to-date check left them) and the board signature, then, as each pour is done, its regions'
  // canvas paths and the earlier-copper hashes the later pours' signatures read (regionWords, cached
  // by region). The plan then reuses them and gives the same signatures. step(ms) runs about ms of it,
  // true while more is left; rest() is the remainder as steps; out holds the results.
  function planAhead(doc,defs,options,itemHashes){
    const P=globalThis.AtriumPCBPours,list=polygons(doc),out={itemHashes,sig:null},queue=[];
    const base=(function*(){
      if(!out.itemHashes){let h=null;yield* polygonSignatureSteps(doc,defs,{...options,keepItemHashes:x=>{h=x;}},SLICE_CHUNK);out.itemHashes=h;}
      if(P?.signatureSteps)out.sig=yield* P.signatureSteps(doc,defs,SLICE_CHUNK);
    })();
    let baseDone=false;
    function* doneSteps(id,regions){
      const at=list.findIndex(p=>p.id===id);if(at<0)return;
      const reach=ruleReach(pourRules(doc,options),options);
      const later=list.slice(at+1).filter(q=>q.layer===list[at].layer).map(q=>signatureArea(settings(q),reach));
      for(const r of regions){
        if(P?.warm){P.warm(r);yield;}
        const b=r.bounds;if(!Array.isArray(b))continue;
        for(const area of later)if(!(b[0]>area[2]||b[2]<area[0]||b[1]>area[3]||b[3]<area[1])){regionWords(r,area);yield;}
      }
    }
    function* rest(){
      if(!baseDone){yield* base;baseDone=true;}
      while(queue.length){const g=queue[0];let x=g.next();while(!x.done){yield;x=g.next();}queue.shift();}
    }
    let g=null;
    return {out,rest,done:(id,regions)=>{queue.push(doneSteps(id,regions));},
      step:ms=>{const t=now();g=g||rest();let x;do x=g.next();while(!x.done&&now()-t<ms);if(x.done){g=null;return queue.length>0;}return true;}};
  }
  async function repourPooled(doc,defs,options,edit,info,pool){
    const H=live.host,A=globalThis.AtriumPourAnim,token={};
    // options.signal (settle(): fabrication outputs waiting for the fill): an abort stops the run, nothing is committed.
    const signal=options.signal,stop=()=>stopRun(token.control);
    let rev=H.revision();const still=()=>H.doc?.()===doc&&H.revision()===rev&&!signal?.aborted;
    pooled=token;signal?.addEventListener?.("abort",stop,{once:true});
    const t0=now(),w0=pool?.stats?.().workerMs||0,s0={...REUSE.stats};let main=0,restarts=0;
    try{
      // Up to date (current(), in slices): no run, no undo step. Its per-item hashes serve the commit
      // plan when no edit lands in between.
      await yieldTurn();
      const rev0=H.revision();let hashes=null;
      const up=await driveSlices(currentSteps(doc,defs,{...options,keepItemHashes:h=>{hashes=h;}}),()=>H.doc?.()===doc);
      if(!up)return;
      if(up.value&&rev0===H.revision()){info("Polygon pours are up to date");return;}
      main+=up.main;rev=H.revision();if(rev!==rev0)hashes=null;
      info("Repouring polygon pours…");
      let showing=false;try{showing=!!pool&&!!A?.begin?.({doc,ids:options.only||polygons(doc).map(p=>p.id),estimateMs:expectMs(doc),token});}catch{/* display only */}
      for(;;){
        if(H.doc?.()!==doc||signal?.aborted)return;
        const currentDefs=H.defs?.()||defs,opts={...options,project:H.project?.()||options.project};delete opts.signal;
        const ahead=planAhead(doc,currentDefs,opts,hashes);hashes=null;
        token.control={};
        const result=await repourParallel(doc,currentDefs,{...opts,active:still,control:token.control,
          onSolving:(id,stage)=>{try{A?.solving?.(token,id,stage);}catch{/* display only */}},
          onDone:(id,regions)=>{ahead.done(id,regions);try{A?.done?.(token,id,regions);}catch{/* display only */}},
          onProgress:p=>fillProgress(doc,p),idle:ms=>still()&&ahead.step(ms),
          preview:(id,job,task)=>previewFor(A,showing,doc,id,job,task,token)},pool);
        if(H.doc?.()!==doc)return;
        if(result)main+=result.stats.main;
        if(!result||!still()){rev=H.revision();restarts++;continue;}
        // What planAhead has not done yet, the signatures of the new copper, then the commit. The
        // canvas paths of pours done last are built by the first frame that shows them (pours in
        // view; others when they come into view).
        const pre=await driveSlices(ahead.rest(),still);
        if(!pre){rev=H.revision();restarts++;continue;}
        main+=pre.main;
        const plan=await driveSlices(commitPlanSteps(doc,currentDefs,{...opts,result,itemHashes:ahead.out.itemHashes,boardSig:ahead.out.sig},SLICE_CHUNK),still);
        if(!plan){rev=H.revision();restarts++;continue;}
        main+=plan.main;
        const ta=now();let applied=null;
        edit(()=>{applied=apply(doc,currentDefs,{...opts,result,plan:plan.value});});
        if(!applied)return;
        restamp(doc,result.stats.reuseSeq);
        const commit=now()-ta,ms=now()-t0;main+=commit;
        // The last Repour All's wall time and CPU (this thread: prepare, reuse checks, finish, signatures, the commit; workers: the solves).
        REUSE.last={doc:doc.id,ms,main,commit,restarts,worker:(pool?.stats?.().workerMs||0)-w0,solved:REUSE.stats.solved-s0.solved,
          inputHits:REUSE.stats.inputHits-s0.inputHits,taskHits:REUSE.stats.taskHits-s0.taskHits,stage1Hits:REUSE.stats.stage1Hits-s0.stage1Hits,joined:REUSE.stats.joined-s0.joined,at:Date.now()};
        try{A?.end?.(token,{committed:true});}catch{/* display only */}
        info(repouredText(applied,"Polygon pours repoured"));
        return applied;
      }
    }catch(e){
      if(H.doc?.()!==doc)return;
      info("Couldn’t repour polygon pours. " + (e?.message || e));
    }finally{
      if(pooled===token)pooled=null;
      signal?.removeEventListener?.("abort",stop);
      try{A?.end?.(token,{committed:false});}catch{/* display only */}
      wakeSettle();
    }
  }
  // --------------------------------------------- speculative repour (energy-aware)
  // On a strong sign that Repour All is coming (the Polygon Pours submenu or the pour context menu
  // opens, the palette query names it, or the T G chord prefix), the stale pours are solved ahead into the exact
  // reuse book (above), one solve at a time on the shared pour pool. Repour All then finds them by
  // their input key, and joins a solve still in flight. Nothing is stored in the document, so no undo
  // step and no repaint. An edit cancels unfinished work. Only in manual pour mode and while the window
  // is visible with Efficiency mode off.
  // Mode: pcb.speculativeRepour preference or speculation.setMode(): "auto" (default), "always", "off".
  const SPEC={mode:null,run:null,listening:false,
    stats:{intents:{},started:0,completed:0,stopped:0,skippedPower:0,skippedFresh:0,poursSolved:0,used:0,wasted:0,cpuMs:0,usedMs:0,wastedMs:0}};
  function specWaste(e){e.spec=false;SPEC.stats.wasted++;SPEC.stats.wastedMs+=e.stats?.ms||0;}
  function specMode(){
    if(SPEC.mode)return SPEC.mode;
    let v=null;try{v=(globalThis.AtriumPref||globalThis.AtriumPrefs)?.get?.("pcb.speculativeRepour");}catch{v=null;}
    return v==="off"||v==="always"?v:"auto";
  }
  function specAllowed(){
    const m=specMode();if(m==="off")return false;
    if(liveMode()==="live")return false;
    if(!editorVisible())return false;
    if(globalThis.AtriumPower?.efficient?.()){SPEC.stats.skippedPower++;return false;}
    return true;
  }
  // Only clear intent starts work.
  function intent(kind,strong){
    const H=live.host;if(!H||!REUSE.on)return;
    SPEC.stats.intents[kind]=(SPEC.stats.intents[kind]||0)+1;
    if(!strong||SPEC.run||pooled!=null)return;
    const d=H.doc?.();if(!d||d.kind!=="pcb"||!(d.items||[]).some(i=>i.kind==="polygon"))return;
    if(!specAllowed())return;
    speculate(kind);
  }
  async function speculate(reason){
    const H=live.host,doc=H?.doc?.();
    if(!doc||SPEC.run||pooled!=null||doc.pcbDrawing?.sourceFill||(doc.pcbDrawing?.pours||[]).some(r=>r.polygon==null)||!specAllowed())return false;
    const defs=H.defs(),rev=H.revision(),pool=solvePool();
    const run={doc,rev,reason};SPEC.run=run;
    const still=()=>!run.stopped&&editorVisible()&&!globalThis.AtriumPower?.efficient?.()&&H.doc?.()===doc&&H.revision()===rev&&pooled==null;
    try{
      await yieldTurn();
      if(!still()){SPEC.stats.stopped++;return false;}
      const up=await driveSlices(currentSteps(doc,defs,{project:H.project?.()}),still);
      if(!up||!still()){SPEC.stats.stopped++;return false;}
      if(up.value){SPEC.stats.skippedFresh++;return false;}
      SPEC.stats.started++;
      const r=await repourParallel(doc,defs,{project:H.project?.(),active:still,control:run,concurrency:1,speculative:true},pool);
      if(r)SPEC.stats.completed++;else SPEC.stats.stopped++;
      return !!r;
    }catch{SPEC.stats.stopped++;return false;}
    finally{if(SPEC.run===run)SPEC.run=null;}
  }
  // DOM intent signals (the menu bar, the palette, the pour context menu, key chords).
  function specListen(){
    const D=globalThis.document;if(!D?.addEventListener||SPEC.listening)return;SPEC.listening=true;
    const hasRepour=el=>!!el?.querySelector?.('[data-action="repour"]');
    const editable=t=>!!t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName||""));
    try{
      // Opening the Polygon Pours submenu shows intent. Closing its menu abandons the job.
      D.addEventListener("toggle",e=>{
        const t=/** @type {HTMLDetailsElement | null} */(e.target);
        if(t?.matches?.("details.work-menu")&&!t.open&&hasRepour(t))specOnChange();
      },true);
      const sub=e=>{const s=e.target?.closest?.(".submenu");if(s&&hasRepour(s))intent("submenu",true);};
      D.addEventListener("pointerover",sub,{capture:true,passive:true});D.addEventListener("focusin",sub,true);
      // The command palette's query names the command (repour, refill, fill zones, pour).
      D.addEventListener("input",e=>{
        const t=/** @type {HTMLInputElement | null} */(e.target);
        if(t?.tagName!=="INPUT"||!t.closest?.(".nav-palette"))return;
        if(/repou|refill|fill zone|^pour|polygon pour/i.test(String(t.value||"").trim()))intent("palette",true);
        else if(SPEC.run?.reason==="palette")specOnChange();
      },true);
      D.addEventListener("close",e=>{
        const t=/** @type {Element | null} */(e.target);
        if(t?.matches?.(".nav-palette")&&SPEC.run?.reason==="palette")specOnChange();
      },true);
      // The pour context menu (it lists Repour All) once it is shown.
      D.addEventListener("contextmenu",()=>{
        const f=()=>{
          for(const m of D.querySelectorAll(".context-menu, [role=menu]")){
            if(m instanceof HTMLElement&&m.offsetParent!==null&&hasRepour(m)){intent("context",true);return;}
          }
        };
        (globalThis.requestAnimationFrame||setTimeout)(f);
      },true);
      // T then G is the Altium Tools » Polygon Pours chord prefix of T G A.
      let tAt=0;
      D.addEventListener("keydown",e=>{
        if(e.ctrlKey||e.metaKey||e.altKey||editable(e.target))return;
        const k=String(e.key||"").toLowerCase(),t=Date.now();
        if(k==="t")tAt=t;
        else if(k==="g"&&t-tAt<1500){tAt=0;intent("chord-tg",true);}
        else{tAt=0;if(k!=="shift"&&k!=="a")specOnChange();}
      },true);
    }catch{/* no DOM events */}
  }
  function specOnChange(){stopRun(SPEC.run);}
  // Repour and store in place: doc.pcbDrawing.pours holds imported regions
  // (no `polygon` tag) still valid for the unchanged board plus the poured
  // regions; doc.sourcePourSignature is refreshed so canvas.pourState() reads
  // "source". Call inside ctx.edit() for undo. options.result: a repourAll
  // result computed earlier for this exact document state (live pours).
  function apply(doc,defs,options={}){
    if(!rulesReadyForEdit(doc,options))throw Error("Load the design rules before repouring polygons.");
    if(doc?.pcbDrawing?.sourceFill)adopt(doc,defs,options,false);
    const result=options.result||runSync(repourSteps(doc,defs,options)),drawing=doc.pcbDrawing||{annotations:{}};
    const previous=drawing.pours||[],imported=previous.filter(r=>r.polygon==null);
    let kept=[];
    if(imported.length){
      const base={...doc,items:(doc.items||[]).filter(i=>i.kind!=="polygon")};
      const stamp=drawing.importedPourSignature??doc.sourcePourSignature,baseSig=AtriumPCBPours.signature(base,defs,copperProject(doc,options),false,options.rules);
      const owned=new Set(polygons(doc).map(p=>p.layer+"\u0000"+(p.net||"")));
      if(stamp&&baseSig===stamp){
        kept=imported.filter(r=>!owned.has(r.layer+"\u0000"+(r.net||"")));
        if(kept.length)drawing.importedPourSignature=baseSig;
      }
      result.droppedImported=imported.length-kept.length;
    }
    if(!kept.length)delete drawing.importedPourSignature;
    // Imported pour tracks (sourcePour: hatched or pre-region Altium pours) are replaced by the new copper.
    const repoured=new Set(options.only||polygons(doc).map(p=>p.id));
    // Failed and skipped dependent pours keep their old copper and stamps for display and undo.
    for(const f of result.failed||[])repoured.delete(f.id);
    for(const id of result.blocked||[])repoured.delete(id);
    if(result.unverified)globalThis.AtriumPourMarker.write(drawing,result.unverified);
    if((doc.items||[]).some(i=>i.sourcePour!=null&&repoured.has(i.sourcePour))){
      let w=0;for(const i of doc.items)if(!(i.sourcePour!=null&&repoured.has(i.sourcePour)))doc.items[w++]=i;
      result.removedTracks=doc.items.length-w;doc.items.length=w;
    }
    const all=[...kept,...result.regions];
    if(!doc.pcbDrawing)doc.pcbDrawing=drawing;
    delete drawing.sourceFill;
    delete drawing.sourceHatchSignature;
    // options.plan (live pours): the signatures commitPlan() computed for exactly this result.
    const plan=options.plan&&options.plan.result===result&&!imported.length&&!result.removedTracks?options.plan:null;
    if(all.length){
      drawing.pours=all;
      const sig=plan?plan.sig:AtriumPCBPours.signature(doc,defs,copperProject(doc,options),false,options.rules);
      if(sig)doc.sourcePourSignature=sig;
    }else{
      delete drawing.pours;delete doc.sourcePourSignature;
    }
    // An evaluated pour can have zero islands. Keep its signature through save and undo so a
    // subsequent edit can bring the copper back. A never-poured or shelved polygon has no signature.
    result.signatures=plan?plan.signatures:polygonSignatures(doc,defs,options);
    const old=drawing.pourSignatureVersion===SIGNATURE_VERSION?drawing.pourSignatures||{}:{},next={};
    for(const [id,signature] of Object.entries(result.signatures)){
      const value=repoured.has(id)?signature:old[id];
      if(value!=null)next[id]=value;
    }
    if(Object.keys(next).length){
      drawing.pourSignatures=next;drawing.pourSignatureVersion=SIGNATURE_VERSION;
    }else{
      delete drawing.pourSignatures;delete drawing.pourSignatureVersion;
    }
    if (!options.detached && !options.derived) {
      const bases = copperBases(doc, result.signatures, repoured);
      for (const p of doc.items) if (bases.has(p.id)) p.copperBasis = bases.get(p.id);
    }
    // options.detached (outputCopper): a copy for outputs; the document's regions keep their canvas caches.
    if(!options.detached){noteFailures(doc,result);noteRefills(doc,result,repoured);}
    if(!options.detached){globalThis.AtriumPCBPours?.release?.(previous,all);globalThis.AtriumCanvasFast?.releasePours?.(previous,all);}
    return result;
  }
  // What apply(doc, defs, {...options, result}) will store, computed without touching the
  // document: the signatures over the new copper and the board signature. Only for a result
  // that keeps no imported regions and removes no imported pour tracks (else null).
  function commitPlan(doc,defs,options={}){const g=commitPlanSteps(doc,defs,options);let r=g.next();while(!r.done)r=g.next();return r.value;}
  function* commitPlanSteps(doc,defs,options={},chunk=Infinity){
    const result=options.result,drawing=doc.pcbDrawing||{annotations:{}};
    if(!result||doc?.pcbDrawing?.sourceFill||(drawing.pours||[]).some(r=>r.polygon==null))return null;
    const repoured=new Set(options.only||polygons(doc).map(p=>p.id));
    if((doc.items||[]).some(i=>i.sourcePour!=null&&repoured.has(i.sourcePour)))return null;
    const d={...drawing,pours:[...result.regions]};delete d.importedPourSignature;
    const view={...doc,pcbDrawing:d};
    const viewOptions=scopedBoardView(doc,defs,{...options,rules:pourRules(doc,options)});
    const signatures=yield* polygonSignatureSteps(view,defs,viewOptions,chunk);
    // options.boardSig: P.signatureSteps of this board, computed ahead (it reads no pour).
    const sig=options.boardSig??(yield* AtriumPCBPours.signatureSteps(view,defs,chunk,copperProject(doc,options),false,options.rules));
    return {result,signatures,sig};
  }
  // A stored contour is authored by a verified import or a committed repour. Bind its
  // exact packed rings and arcs to this polygon and the physical inputs of that fill.
  const packedCopperHashes = new WeakMap();
  function packedCopperHash(region) {
    let cached = packedCopperHashes.get(region);
    if (!cached || cached.data !== region.data) {
      const hash = hasher();
      hash.value(region.data);
      cached = {data:region.data, digest:hash.hex()};
      packedCopperHashes.set(region, cached);
    }
    return cached.digest;
  }
  function copperBases(doc, inputs, ids) {
    const hashes = new Map();
    for (const id of ids) {
      if (!inputs[id]) continue;
      const hash = hasher();
      hash.value([doc.id, id]);
      hashes.set(id, hash);
    }
    if (!hashes.size) return hashes;
    for (const r of doc.pcbDrawing?.pours || []) {
      const hash = hashes.get(r.polygon);
      if (hash) hash.value([r.layer, r.net, r.count, packedCopperHash(r), r.arcs || null]);
    }
    return new Map(Array.from(hashes, ([id, hash]) => [id, {inputs:inputs[id], contours:hash.hex()}]));
  }
  function storedInputs(doc, now) {
    const drawing = doc.pcbDrawing;
    const stored = drawing?.pourSignatureVersion === SIGNATURE_VERSION ? drawing.pourSignatures || {} : {};
    const candidates = (doc.items || []).filter(p => p.kind === "polygon" && typeof p.copperBasis?.contours === "string" &&
      p.copperBasis.inputs === now[p.id]);
    if (!candidates.length) return stored;
    const result = {...stored}, bases = copperBases(doc, now, candidates.map(p => p.id));
    for (const p of candidates) {
      if (bases.get(p.id)?.contours === p.copperBasis.contours) result[p.id] = now[p.id];
      else delete result[p.id];
    }
    return result;
  }
  function adoptSourceCopper(project) {
    let defs;
    for (const doc of project.documents) {
      if (doc.pcbDrawing?.sourceFill === true) {
        defs ||= new Map(project.library.map(d => [d.id, d]));
        adopt(doc, defs, {project}, false);
      }
    }
  }
  // Includes never-poured active polygons. History and save use the report's
  // verified ids when they need evidence about existing stored copper.
  function stale(doc,defs,options){
    return inspectCopper(doc,defs,options).stale.slice();
  }
  function staleFromSignatures(doc,now){
    const d=doc.pcbDrawing,stored=storedInputs(doc,now);
    if(d?.pourSignatures&&d.pourSignatureVersion!==SIGNATURE_VERSION)return Object.keys(now);
    const owners=globalThis.AtriumPourMarker.read(d),unverified=owners?.length?new Set(owners):null;
    return Object.keys(now).filter(id=>stored[id]!==now[id]||unverified?.has(id));
  }
  function current(doc,defs,options){
    const d=doc?.pcbDrawing, report=inspectCopper(doc,defs,options);
    return !!d&&!report.source&&(report.state==="none"||report.state==="current")&&
      !report.stale.length&&!report.imported;
  }
  // The editor's Repour All (Tools › Polygon Pours): one undo step, none when nothing would change.
  function repour(doc,defs,options={},edit,info){
    if(!(doc.items||[]).some(i=>i.kind==="polygon"))return info("This board has no polygon pours.");
    if(queryPending(doc,options)){
      const H=live.host,rev=H?.revision?.(),active=H?.doc?.()===doc;
      return queryReady(doc,options).then(()=>{
        if(!active||H===live.host&&H.doc()===doc&&H.revision()===rev)
          return repour(doc,defs,options,edit,info);
      });
    }
    // The editor checks signatures in slices and uses the worker pool even for a single large pour.
    const H=live.host;
    if(H?.doc?.()===doc&&!doc.pcbDrawing?.sourceFill&&typeof H.revision==="function"){
      specOnChange();
      const start=()=>{
        if(H.doc?.()!==doc)return;
        if(pooled!=null)return info("Repouring polygon pours…");
        const pool=solvePool();
        return repourPooled(doc,H.defs?.()||defs,{...options,project:H.project?.()||options.project},edit,info,pool?.available?pool:null);
      };
      if(!globalThis.AtriumWorkerPool&&typeof Worker==="function"&&globalThis.AtriumLazy?.need){
        info("Repouring polygon pours…");
        return AtriumLazy.need("AtriumWorkerPool").then(start,start);
      }
      return start();
    }
    if(current(doc,defs,options))return info("Polygon pours are up to date");
    specOnChange();
    const t0=now(),s0={...REUSE.stats};let res=null;
    edit(()=>{res=apply(doc,defs,options);});restamp(doc,res?.stats?.reuseSeq);
    const ms=now()-t0;REUSE.last={ms,main:ms,worker:0,solved:REUSE.stats.solved-s0.solved,inputHits:REUSE.stats.inputHits-s0.inputHits,taskHits:REUSE.stats.taskHits-s0.taskHits,joined:0,at:Date.now()};
    info(repouredText(res,"Polygon pours repoured"));
    return res;
  }
  // The physical verdict is a read. It never starts a load, adopts source
  // contours or promotes a preview into the drawing. Callers own those effects.
  let stateMemo=null;
  const ruleLoads=new Map(),ruleLoadFailures=new Set();
  function copperProject(doc,options){
    const G=globalThis,H=live.host,active=H?.doc?.()===doc?H.project?.():G.AtriumNavHost?.project?.();
    return options?.project??G.AtriumSignals?.projectOf?.(doc)??(active?.documents?.includes(doc)?active:undefined);
  }
  function ruleDependency(doc,options){
    const G=globalThis,project=copperProject(doc,options);
    if((!G.AtriumRules?.stored||!G.AtriumProjectRules)&&(project?.rules!=null||options?.rules?.list||doc.rules?.list))
      return "AtriumRules";
    if(G.AtriumDesignQuery)return null;
    const book=pourRules(doc,{...options,project}),lazy=G.AtriumLazy?.needsRuleQuery;
    const needs=lazy || G.AtriumRuleScopeDemand;
    const copper=book?.version===1?book:book?.list?{...book,list:book.list.filter(r=>copperRuleTypes.has(r.type))}:null;
    return copper && needs(copper,"pcb",{detached:!lazy})?"AtriumDesignQuery":null;
  }
  function loadRuleDependency(name){
    const L=globalThis.AtriumLazy;
    if(typeof L?.need!=="function")return null;
    let load=ruleLoads.get(name);
    if(!load){
      load=Promise.resolve().then(()=>L.need(name)).then(()=>{
        ruleLoadFailures.delete(name);
      },error=>{ruleLoadFailures.add(name);throw error;}).finally(()=>{
        ruleLoads.delete(name);stateMemo=null;live.cache=null;
        if(!ruleLoadFailures.has(name))schedule();
        live.host?.redraw?.();wakeSettle();
      });
      ruleLoads.set(name,load);
    }
    return load;
  }
  function queryPending(doc,options){return !!ruleDependency(doc,options);}
  function loadCommonJSRules(name){
    if(typeof globalThis.AtriumLazy?.need==="function"||typeof module==="undefined"||typeof require!=="function")return false;
    if(name==="AtriumRules")require("../checks/rules.js");
    else require("../checks/design-query.js");
    return !!globalThis[name];
  }
  function rulesReadyForEdit(doc,options){
    const dependency=ruleDependency(doc,options);
    if(!dependency)return true;
    if(!loadCommonJSRules(dependency))return false;
    const next=ruleDependency(doc,options);
    return !next||next!==dependency&&loadCommonJSRules(next)&&!queryPending(doc,options);
  }
  async function queryReady(doc,options){
    const seen=new Set();
    for(let name; (name=ruleDependency(doc,options));){
      if(seen.has(name))throw Error("The design rules' scope compiler could not be loaded.");
      seen.add(name);
      const load=loadRuleDependency(name);
      if(load)await load;
      else if(!loadCommonJSRules(name))throw Error("The design rules' scope compiler is unavailable.");
    }
  }
  function sourceMode(doc){
    const d=doc.pcbDrawing;
    if(d?.sourceFill)return d.sourceFill==="pour"?"fill":"adopt";
    if(d?.pourSignatureVersion===3&&d.pours?.length&&d.pours.every(r=>r.polygon!=null&&r.source==="altium"))return "legacy";
    return null;
  }
  function ownerState(report,id){
    return report.owners[id]??(report.state==="pending"?"pending":"unknown");
  }
  function inspectCopper(doc,defs,options={}){
    const G=globalThis,H=live.host,project=copperProject(doc,options);
    const d=doc.pcbDrawing,pours=d?.pours,unverified=G.AtriumPourMarker.read(d);
    const rev=project&&H?.doc?.()===doc&&H.project?.()===project&&
      Object.keys(options).every(k=>k==="project")&&!H.drag?.()?.before?H.revision?.():null;
    const undo=G.AtriumUndoStore,tracked=rev!=null&&undo?.root?.()===project;
    const version=tracked?undo.documentVersions?.(doc,project,true):null;
    const outer=version?undo.outer():null;
    const environment=rev!=null&&(!tracked||version)?[H,project,undo,G.AtriumLazy,G.AtriumPCBPours,G.AtriumBoardShape,
      G.AtriumStackup,G.AtriumRules,G.AtriumProjectRules,G.AtriumSignals,G.AtriumDesignQueryRecord,
      G.AtriumDesignQuery,G.AtriumQuery,G.AtriumHierarchy,G.AtriumAltiumRules,G.AtriumPCBAppearance,
      G.AtriumComponentClasses,G.AtriumRooms,G.AtriumDFA,G.AtriumLength]:null;
    const m=stateMemo;
    const sameEnvironment=environment&&m?.environment&&environment.every((v,k)=>v===m.environment[k]);
    const sameVersion=!!m&&m.outer===outer&&m.seq===version?.seq&&m.pourVersion===version?.pours;
    const sameInputs=sameEnvironment&&sameVersion&&m.doc===doc&&m.drawing===d&&m.pours===pours&&m.sigs===d?.pourSignatures&&
      m.unverified===unverified&&m.stamp===doc.sourcePourSignature&&m.sourceFill===d?.sourceFill&&
      m.importedStamp===d?.importedPourSignature&&m.hatchStamp===d?.sourceHatchSignature&&m.items===doc.items&&m.n===doc.items.length&&m.defs===defs;
    if(sameInputs&&(m.rev===rev||version&&H===G.AtriumNavHost&&H.defs?.()===defs))return m.report;

    const context=project===options.project?options:{...options,project};
    const source=sourceMode(doc),evaluated=evaluatedPours(doc);
    const active=polygons(doc);
    const unpoured=active.filter(p=>!evaluated.has(p.id)).map(p=>p.id);
    const owners=Object.create(null);
    const report={state:"none",reason:null,regions:pours||[],source,stale:[],verified:[],unpoured,imported:null,owners};
    const imported=report.regions.filter(r=>r.polygon==null).length;
    const dependency=evaluated.size||unpoured.length||imported||source?ruleDependency(doc,context):null;
    if(dependency){
      report.state=typeof G.AtriumLazy?.need==="function"&&!ruleLoadFailures.has(dependency)?"pending":"unknown";
      report.reason=dependency;
    }else if((evaluated.size||source)&&H?.project?.()===project&&folderPourDependencies(H,doc,project)){
      report.state="pending";
      report.reason="project-members";
    }else if(source==="fill"){
      report.state="unknown";
      report.reason="source-fill";
    }else{
      let matched;
      const boardMatch=()=>matched??=!!G.AtriumPCBPours?.matchesSignature?.(doc,defs,project,options.rules);
      if(imported)report.imported={count:imported,fresh:importedFresh(doc,defs,context,boardMatch)};
      const rawVerified=source&&boardMatch();
      if(rawVerified){
        if(evaluated.size||d.sourceHatchSignature){
          report.state="unknown";
          report.reason="source-adoption";
        }else if(report.regions.length)report.state="current";
      }else if(evaluated.size||unpoured.length){
        const c=live.cache;
        // A matching live result is valid for the implicit editor inputs only.
        const fromLive=environment&&c?.doc===doc&&c.rev===rev&&c.defs===defs&&c.all&&
          !(m?.doc===doc&&m.rev===rev&&!sameInputs);
        const all=fromLive?c.all:staleFromSignatures(doc,polygonSignatures(doc,defs,context));
        const eligible=eligibleStale(doc,all,evaluated);
        report.stale=all.slice();
        const staleIds=new Set(all);
        if(!source)report.verified=active.filter(p=>evaluated.has(p.id)&&!staleIds.has(p.id)).map(p=>p.id);
        if(environment&&!source&&!fromLive)live.cache={doc,rev,defs,all,ids:eligible};
        if(source||eligible.length||report.imported?.fresh===false)report.state="stale";
        else if(report.regions.length)report.state="current";
      }else if(source||report.imported?.fresh===false)report.state="stale";
      else if(report.regions.length)report.state="current";
    }
    for(const id of report.stale)owners[id]="stale";
    for(const id of unpoured)owners[id]="unpoured";
    for(const id of report.verified)owners[id]="poured";
    for(const value of [report.stale,report.verified,report.unpoured,report.imported,owners])if(value)Object.freeze(value);
    Object.freeze(report);
    if(environment&&report.reason!=="project-members"&&(source||evaluated.size||imported))stateMemo={doc,rev,drawing:d,pours,sigs:d?.pourSignatures,unverified,stamp:doc.sourcePourSignature,
      sourceFill:d?.sourceFill,importedStamp:d?.importedPourSignature,hatchStamp:d?.sourceHatchSignature,
      items:doc.items,n:doc.items.length,defs,report,environment,outer,seq:version?.seq,pourVersion:version?.pours};
    return report;
  }
  // Compatibility projection for the display and command paths.
  function state(doc,defs,options){
    const report=inspectCopper(doc,defs,options);
    return report.state==="current"?"source":report.state==="none"?"none":"stale";
  }
  function contactRegions(doc,defs,options){
    const regions=doc.pcbDrawing?.pours;
    if(!regions?.some(r=>r.links?.length>1))return [];
    const context=options?.rules!==undefined?{project:options.project,rules:options.rules}:
      options?.project?{project:options.project}:undefined;
    const report=inspectCopper(doc,defs,context);
    return report.state==="current"?report.regions:[];
  }
  // Remove a polygon's regions (Altium "Shelve"/delete) without repouring.
  function strip(doc,ids){
    const set=new Set(ids),d=doc.pcbDrawing;if(!d)return;
    for(const p of doc.items||[])if(set.has(p.id)&&p.copperBasis)delete p.copperBasis;
    if(d.pours)d.pours=d.pours.filter(r=>!set.has(r.polygon));
    if(d.pourSignatures)for(const id of set)delete d.pourSignatures[id];
    const unverified=globalThis.AtriumPourMarker.read(d);
    if(unverified)globalThis.AtriumPourMarker.write(d,unverified.filter(id=>!set.has(id)));
    if(!d.pours?.length){delete d.pours;delete doc.sourcePourSignature;}
    if(!Object.keys(d.pourSignatures||{}).length){delete d.pourSignatures;delete d.pourSignatureVersion;}
  }
  // A new pour from a drawn outline, poured at once with every pour it
  // affects: the placement and its copper are one edit (call inside edit()).
  function place(doc,defs,outline,fields={},options={}){
    const item=validate(make(outline,{pourIndex:polygons(doc).length,...fields}));
    doc.items.push(item);
    const result=apply(doc,defs,{...options,only:affected(doc,[item.id],defs)});
    return {item,result,regions:result.regions.filter(r=>r.polygon===item.id)};
  }
  // Repour one pour (context menu Repour, MCP): the pour and the poured pours
  // after it on its layer, which clear around its new copper; every other pour
  // keeps its copper. Call inside edit() for undo. Returns apply()'s result
  // plus `repoured` (ids in pour order).
  function repourOne(doc,defs,id,options={}){
    const want=[].concat(id),byId=new Map((doc.items||[]).map(i=>[i.id,i]));
    for(const k of want){
      const p=byId.get(k);
      if(!p||p.kind!=="polygon")throw Error("That object is not a polygon pour.");
      if(p.shelved)throw Error("This pour is shelved. Restore it in the Polygon Manager to pour it.");
    }
    if(doc?.pcbDrawing?.sourceFill)adopt(doc,defs,options,false);
    const ids=affected(doc,want,defs);
    const result=apply(doc,defs,{...options,only:ids});
    result.repoured=ids;
    return result;
  }
  // Pours to repour when the objects `ids` change, in pour order. A polygon
  // id brings itself and every poured polygon after it on its layer (a cutout:
  // every poured polygon on its layer, any layer for Multi); any other object
  // brings the poured polygons whose area its box reaches, and the poured
  // polygons after those on their layers. (The live engine also catches the
  // old position of a moved object through the pour signatures.)
  function affected(doc,ids,defs,options={}){
    const reach=ruleReach(pourRules(doc,options),options);
    const list=polygons(doc),poured=evaluatedPours(doc);
    const byId=new Map((doc.items||[]).map(i=>[i.id,i])),hit=new Set();
    const after=p=>{const k=list.indexOf(p);for(const q of list.slice(k))if(q===p||q.layer===p.layer&&poured.has(q.id))hit.add(q.id);};
    for(const id of ids||[]){
      const i=byId.get(id);if(!i)continue;
      if(i.kind==="polygon"){
        if(i.cutout){for(const p of list)if((i.layer==="Multi"||p.layer===i.layer)&&poured.has(p.id))hit.add(p.id);}
        else if(list.includes(i))after(i);
        continue;
      }
      const b=itemBox(i,defs),only=(i.kind==="track"||i.kind==="graphic"||i.kind==="label")&&COPPER.test(i.layer||"")?i.layer:null;
      for(const p of list){
        if(!poured.has(p.id)||(only&&p.layer!==only))continue;
        const a=signatureArea(settings(p),reach);
        if(b[0]<=a[2]&&b[2]>=a[0]&&b[1]<=a[3]&&b[3]>=a[1])after(p);
      }
    }
    return list.filter(p=>hit.has(p.id)).map(p=>p.id);
  }

  // ------------------------------------------- stored fill from imports
  // Imported pours (Altium Regions6, KiCad filled_polygon) arrive as regions
  // tagged with their polygon, with empty `links` and no signature, and the
  // drawing carries `sourceFill`. (Empty links rather than none: connectivity
  // asks state() only when some region has links, and state() adopts.) adopt() links each island to the same-net copper it touches
  // (as a pour would) and records the polygons' signatures, so the stored
  // copper counts for connectivity until the board changes near it.
  const TOUCH=.002;
  const {pointSegmentDistanceSquared: segDist2, segmentDistanceSquared} = globalThis.AtriumGeometry;
  // Distance from a core (point, segment or convex land) to stored copper.
  function touchesStoredCopper({inside,band,edges:E,lists},center,core,limit,box){
    if(inside(center[0],center[1]))return true;
    const lo=band(box[1]),hi=band(box[3]),poly=core.length>2;
    for(let k=lo;k<=hi;k++)for(const e of lists.get(k)||[]){
      const ax=E[e],ay=E[e+1],bx=E[e+2],by=E[e+3];
      if(Math.max(ax,bx)<box[0]||Math.min(ax,bx)>box[2]||Math.max(ay,by)<box[1]||Math.min(ay,by)>box[3])continue;
      if(core.length===1){if(segDist2(core[0][0],core[0][1],ax,ay,bx,by)<=limit*limit)return true;continue;}
      for(let i=0,j=core.length-1;i<core.length;j=i++){
        if(!poly&&i===0)continue;
        if(Math.sqrt(segmentDistanceSquared(ax,ay,bx,by,core[j][0],core[j][1],core[i][0],core[i][1]))<=limit)return true;
      }
      if(poly&&ringHas(core.flat(),ax,ay))return true;
    }
    return false;
  }
  // Same-net copper on each region's layer that the region's copper touches,
  // as connectivity keys [id, slot]. Writes region.links.
  function linkStored(doc,defs,regions){
    const groups=new Map(),index=new Map(),links=new Map(regions.map(r=>[r,new Map()]));
    for(const r of regions){if(!r.net||!COPPER.test(r.layer||""))continue;const k=r.layer+"\u0000"+r.net;let l=groups.get(k);if(!l)groups.set(k,l=[]);l.push(r);}
    function visit(list,core,radius,center,link){
      const m=radius+TOUCH,box=clipBox(Atrium.bounds(core),m);
      for(const r of list){
        if(!areaOverlaps(box,r.bounds))continue;
        let x=index.get(r);if(!x)index.set(r,x=AtriumPCBPours.edgeBands(rings(r),null,r.bounds));
        if(touchesStoredCopper(x,center,core,m,box))links.get(r).set(link.join("\u0000"),link);
      }
    }
    const {padLayer,onLayer}=appearance();
    const pad=(p,parent,link)=>{
      const net=parent&&own(parent.pinNets,p.number)?parent.pinNets[p.number]:p.net||"";
      if(!net||p.holeOnly||p.plated===false&&p.drill>0)return;
      const l=padLayer(parent,p);
      for(const g of groups.values()){
        const layer=g[0].layer;
        if(g[0].net!==net||!onLayer(l,layer,p))continue;
        const pc=padOnLayer(p,parent,layer);
        if(pc&&pc.drill<Math.min(pc.w,pc.h)-1e-9)visit(g,pc.core,pc.radius,pc.center,link);
      }
    };
    const path=(item,net,link,parent)=>{
      const list=net&&groups.get(item.layer+"\u0000"+net);if(!list)return;
      const arc=pathArc(item),r=Math.max(0,+item.width||0)/2;
      for(const group of arc?list.map(r=>[r]):[list])for(const pts of pathRuns(item,parent,arc,clipBox(group[0].bounds,r+TOUCH+TRACK_CHORD_ERROR))){
        if(item.fill&&(item.closed||!parent&&item.kind==="graphic")&&pts.length>2)visit(group,pts,r,pts[0],link);
        else for(let k=1;k<pts.length;k++)visit(group,[pts[k-1],pts[k]],r,pts[k-1],link);
      }
    };
    for(const i of doc.items||[]){
      if(i.kind==="track"||i.kind==="graphic"){if(!i.keepout)path(i,i.net,[i.id,0]);}
      else if(i.kind==="via")pad(i,null,[i.id,0]);
      else if(i.kind==="pad")pad(i,null,[i.id,0]);
      else if(i.kind==="part"){
        const fp=defs?.get?.(i.def)?.footprint;if(!fp)continue;
        (fp.pads||[]).forEach((p,j)=>pad({...p,kind:p.kind==="via"?"via":"pad",w:p.w||p.diameter,h:p.h||p.diameter},i,[i.id,"pad"+j]));
        (fp.shapes||[]).forEach((s,j)=>{if(s.kind==="path"&&!s.cutout&&!s.keepout)path(s,s.net,[i.id,"shape"+j],i);});
      }
    }
    for(const [r,found] of links)r.links=[...found.values()];
  }
  // A first board inspection can finish importing stored copper after the project opened.
  // Include those derived fields in the next checkpoint, even if the user edits a different sheet.
  function noteAdoption(doc,hint){
    const undo=globalThis.AtriumUndoStore,project=undo?.root?.();
    if(project?.documents?.includes(doc))undo.touch(project,hint);
  }
  function adopt(doc,defs,options={},repair=true){
    const source=sourceMode(doc);
    if(!source||!rulesReadyForEdit(doc,options))return false;
    const mode=doc.pcbDrawing.sourceFill;
    if(source==="legacy"){
      if(!globalThis.AtriumPCBPours?.matchesSignature?.(doc,defs,copperProject(doc,options),options.rules))return false;
      doc.pcbDrawing.sourceFill=true;
      delete doc.pcbDrawing.pourSignatures;
      delete doc.pcbDrawing.pourSignatureVersion;
    }
    const changed=adoptStored(doc,defs,options,repair,source==="legacy");
    if(!options.detached&&!doc.pcbDrawing.sourceFill){
      stateMemo=null;
      if(live.cache?.doc===doc)live.cache=null;
      noteAdoption(doc,mode!=="pour"&&!repair?{doc,items:[]}:undefined);
    }
    return changed;
  }
  // sourceFill "pour" (Eagle: the file stores no fill): pour the pours that have no copper yet.
  function adoptStored(doc,defs,options,repair,verifiedArchive){
    const d=doc?.pcbDrawing;if(!d?.sourceFill)return false;
    if(d.sourceFill==="pour"){
      delete d.sourceFill;
      const has=new Set((d.pours||[]).map(r=>r.polygon)),ids=polygons(doc).filter(p=>!has.has(p.id)).map(p=>p.id);
      if(ids.length)apply(doc,defs,{...options,only:ids});
      return true;
    }
    // An edit or precision lost in an old project can make the raw stamp unverifiable.
    // An explicit adoption solves the original zones. Status/export queries leave them stale
    // for the normal live queue or Repour All, and never publish ambiguous imported copper.
    if(!verifiedArchive&&!globalThis.AtriumPCBPours?.matchesSignature?.(doc,defs,copperProject(doc,options),options.rules)){
      const ids=repair?unverifiedZones(doc):[];
      if(!ids.length)return false;
      apply(doc,defs,{...options,only:ids});
      return true;
    }
    // Stored islands of polygons that have no signature yet (the importer gives them links:[]).
    const signed=d.pourSignatureVersion===SIGNATURE_VERSION?d.pourSignatures||{}:{};
    const regions=(d.pours||[]).filter(r=>r.polygon!=null&&signed[r.polygon]==null),ids=new Set(regions.map(r=>r.polygon));
    for(const i of doc.items)if(i.sourcePour!=null&&signed[i.sourcePour]==null)ids.add(i.sourcePour);
    if(regions.length)try{linkStored(doc,defs,regions);}catch(e){
      if(!(e instanceof RangeError)||e.message!=="Curve point budget exceeded.")throw e;
      globalThis.AtriumDiagnostics?.record?.("pour-failed",failureText(e));return false;
    }
    delete d.sourceFill;
    delete d.sourceHatchSignature;
    if(d.pours?.length&&needsScopeTrace(pourRules(doc,options)))doc.sourcePourSignature=AtriumPCBPours.signature(doc,defs,copperProject(doc,options),false,options.rules);
    if(!ids.size)return false;
    const sigs=polygonSignatures(doc,defs,options),old=d.pourSignatureVersion===SIGNATURE_VERSION?d.pourSignatures||{}:{},next={...old};
    for(const id of ids)if(sigs[id]!=null)next[id]=sigs[id];
    d.pourSignatures=next;d.pourSignatureVersion=SIGNATURE_VERSION;
    return true;
  }

  // Applying the source tool's rules can re-certify artwork authored under
  // those rules. Keep the decision and both stamps with the pour authority.
  function adoptRuleTransition(doc,defs,options,commit){
    if(!rulesReadyForEdit(doc,options)){commit();return {kept:0,repoured:0};}
    if(sourceMode(doc)&&sourceMode(doc)!=="fill")adopt(doc,defs,options,false);
    const drawing=doc.pcbDrawing, project=copperProject(doc,options);
    const hasPours=doc.items.some(i=>i.kind==="polygon");
    // These checks bracket an authored edit, so never reuse the host's prior revision.
    const before=hasPours?inspectCopper(doc,defs,{...options,rules:pourRules(doc,options)}):null;
    const base=()=>({...doc,items:doc.items.filter(i=>i.kind!=="polygon")});
    const boardStamp=hasPours?AtriumPCBPours.signature(doc,defs,project):null;
    const importStamp=drawing?.importedPourSignature?AtriumPCBPours.signature(base(),defs,project):null;
    commit();
    if(!before||!rulesReadyForEdit(doc,options))return {kept:0,repoured:0};

    const after=inspectCopper(doc,defs,{...options,rules:pourRules(doc,options)});
    const edited=new Set(before.stale),generated=new Set((drawing?.pours||[])
      .filter(r=>r.polygon!=null&&r.source!=="altium").map(r=>r.polygon));
    const keep=doc.sourceRulesReplaced||before.source?[]:after.stale.filter(id=>!edited.has(id)&&!generated.has(id));
    const rest=after.stale.filter(id=>!keep.includes(id));
    if(keep.length){
      const signatures=polygonSignatures(doc,defs,options),next={...(drawing.pourSignatures||{})};
      for(const id of keep)if(signatures[id]!=null)next[id]=signatures[id];
      drawing.pourSignatures=next;
      if(boardStamp&&doc.sourcePourSignature===boardStamp)doc.sourcePourSignature=AtriumPCBPours.signature(doc,defs,project);
      if(importStamp&&drawing.importedPourSignature===importStamp)drawing.importedPourSignature=AtriumPCBPours.signature(base(),defs,project);
    }
    let repoured=0;
    if(rest.length){
      const downstream=affected(doc,rest,defs),bare=rest.every(id=>!(drawing?.pours||[]).some(r=>r.polygon===id));
      if(bare){
        apply(doc,defs,{...options,only:rest});
        repoured=(doc.pcbDrawing?.pours||[]).filter(r=>rest.includes(r.polygon)).length;
      }
      if(!bare||repoured&&downstream.length>rest.length)
        repoured=apply(doc,defs,{...options,only:downstream}).regions.length;
    }
    return {kept:keep.length,repoured};
  }

  function pendingPlanes(doc){
    const evaluated=evaluatedPours(doc);
    return polygons(doc).filter(p=>p.powerPlane&&!evaluated.has(p.id)).map(p=>p.id);
  }

  function unverifiedZones(doc){
    const regions=doc.pcbDrawing?.pours||[];
    if(regions.some(r=>r.polygon==null))return [];
    const tagged=new Set(regions.map(r=>r.polygon));
    return polygons(doc).filter(p=>tagged.has(p.id)).map(p=>p.id);
  }
  // Adopt fresh artwork or solve Eagle and unverifiable tagged zones without blocking the editor:
  // computed step by step with the overlay in the pour worker (idle slices without one), then
  // committed by the same apply(). Call before the board is shown; resolves like adopt().
  /** @param {{signal?: AbortSignal, project?: Project, rules?: Rules}} [opts] */
  async function adoptAsync(doc,defs,opts={}){
    const {signal,...options}=opts;
    const aborted=()=>Object.assign(Error("Import cancelled."),{name:"AbortError"});
    if(signal?.aborted)throw aborted();
    if(queryPending(doc,options)){
      await queryReady(doc,options);
      if(signal?.aborted)throw aborted();
    }
    const d=doc?.pcbDrawing,mode=d?.sourceFill;
    const planes=pendingPlanes(doc);
    if(!mode&&!planes.length)return false;
    let ids;
    if(!mode)ids=planes;
    else if(mode==="pour"){
      const has=new Set((d.pours||[]).map(r=>r.polygon));
      ids=polygons(doc).filter(p=>!has.has(p.id)).map(p=>p.id);
    }else{
      if(adopt(doc,defs,options,false)){if(!planes.length)return true;ids=planes;}
      else ids=[...new Set([...unverifiedZones(doc),...planes])];
    }
    if(!ids.length)return adopt(doc,defs,options,false);
    const control={}, cancel=()=>stopRun(control), pool=solvePool();
    signal?.addEventListener("abort",cancel,{once:true});
    try{
      const result=await repourParallel(doc,defs,{...options,only:ids,control,active:()=>!signal?.aborted},pool?.available?pool:null);
      if(!result||signal?.aborted)throw aborted();
      if(d)delete d.sourceFill;
      try{apply(doc,defs,{...options,only:ids,result});}catch(e){if(d&&mode)d.sourceFill=mode;throw e;}
      noteAdoption(doc);
    }finally{signal?.removeEventListener("abort",cancel);}
    return true;
  }

  // ----------------------------------------------------- Altium conversion
  // Polygons6 record properties -> polygon item. `toLayer` and `netName`
  // are the importer's layer and net lookups.
  /** @param {{toLayer?: (layer: string) => LayerName, netName?: (index: number) => string}} [options] */
  function fromAltium(p,options={}){
    const {toLayer,netName}=options;
    // The conversion lives in pcb-import.js (AtriumPCB), which the import worker also loads.
    const q=globalThis.AtriumPCB?.polygon?.({POLYGONTYPE:"Polygon",...p},{toLayer,netName});
    if(!q)throw Error("Unsupported Altium polygon record.");
    const {points,kind,closed,...fields}=q;
    return make(points,fields);
  }

  // ------------------------------------------------------------ live pours
  // Live pours (Allegro dynamic shapes). After every edit, undo and redo the
  // editor emits "change"; once idle, the pours whose signature no longer
  // matches the board and that were poured before are repoured in pour
  // order. A dedicated worker mirrors journaled board edits and runs the
  // physical input check, prepare, solve and encoding. When workers are
  // unavailable the same work runs in idle slices. Copper uses host.derive(),
  // which changes the document without an undo checkpoint and keeps redo.
  //
  // Why that is one undo step: copper is derived data. An edit's undo
  // snapshot is taken before the edit, so it holds the copper that matched the
  // old geometry; undo restores both together. A repour that lands after the
  // edit only rewrites the current state, never a history entry, and a job
  // whose revision changed before it finishes is discarded. If redo restores
  // a state whose repour had not finished, that state is stale and the live
  // engine repours it again. Polygons never poured (imported zones, Shelved)
  // are left alone: live mode keeps poured copper current. A pour added after
  // its board was first seen (a paste, a script, an applied proposal) is new,
  // so it is poured at once, like one drawn through the dialog.
  const known=new Map();
  function noteKnown(){for(const d of live.host?.project?.()?.documents||[])if(d.kind==="pcb"&&!known.has(d.id))known.set(d.id,new Set((d.items||[]).filter(i=>i.kind==="polygon").map(i=>i.id)));}
  const added=(doc,id)=>{const k=known.get(doc.id);if(!k||k.has(id))return false;const i=(doc.items||[]).find(x=>x.id===id);return !!i&&!i.shelved&&!i.cutout;}; // known pours first: no item scan per pour
  function evaluatedPours(doc){
    const d=doc.pcbDrawing,ids=new Set([...Object.keys(d?.pourSignatures||{}),...(globalThis.AtriumPourMarker.read(d)||[])]);
    if(d)for(const p of doc.items||[])if(p.kind==="polygon"&&p.copperBasis)ids.add(p.id);
    for(const r of d?.pours||[])if(r.polygon!=null)ids.add(r.polygon);
    return ids;
  }
  function eligibleStale(doc,staleIds,evaluated=evaluatedPours(doc)){
    if(!staleIds.length)return [];
    return staleIds.filter(id=>evaluated.has(id)||added(doc,id));
  }
  function runnableStale(doc,defs,options,all,sigs,failed,eligible){
    const ids=all.filter(eligible);
    if(!sigs)return ids;
    const held=new Set(ids.filter(id=>failed[id]?.sig!=null&&failed[id].sig===sigs[id]));
    if(!held.size)return ids;
    // Keep the same-input failure dormant. Its dependents can run when it is
    // eligible again, and separately runnable pours still proceed.
    const list=polygons(doc),deps=pourDependencies(doc,defs,list,options,doc.pcbDrawing?.pours);
    forwardMarkPrerequisites(list,deps,p=>eligible(p.id),i=>held.has(list[i].id),p=>held.add(p.id));
    return ids.filter(id=>!held.has(id));
  }
  const live={mode:null,host:null,timer:null,running:null,again:false,failed:null,last:null,cache:null,worker:null,workerBroken:false,seq:0,waiters:new Map()};
  const canMirror=()=>!live.remoteDisabled&&live.remoteEnabled!==false&&typeof Worker==="function"&&
    !!globalThis.document?.baseURI&&!!(globalThis.AtriumLivePourClient||globalThis.AtriumLazy?.need);
  function editorVisible(){return globalThis.AtriumPower?.visible?.()!==false;}
  const copperRuleTypes=new Set(["clearance","polygonConnect","width"]);
  function copperRuleScopes(doc,project){
    return (pourRules(doc,{project})?.list||[]).filter(r=>r.enabled!==false&&copperRuleTypes.has(r.type))
      .flatMap(r=>[r.scope,r.scope2]).filter(Boolean);
  }
  const scopeSelector=scope=>globalThis.AtriumDesignQueryRecord?.toSelector?.(scope)||scope;
  function scopedWorkerSnapshot(doc,project){
    // A fresh project identity invalidates the spatial and scalar scope indexes.
    return copperRuleScopes(doc,project).some(scope=>scope.kind==="query"||
      scope.languageVersion===1&&!scopeSelector(scope).kind);
  }
  const boardScopeFamilies=new Set(["all","net","layer","component","room","polygon","padkind"]);
  function scopeUsesSheets(node){
    if(!node)return false;
    if(node.args)return node.args.some(scopeUsesSheets);
    if(node.arg)return scopeUsesSheets(node.arg);
    // Named room/near anchors resolve on this PCB. Signal, hierarchy and
    // parameter expressions may read a schematic outside the visible board.
    return node.type==="relation"?!boardScopeFamilies.has(node.family):
      node.type==="near"?!/^\s*(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*(?:mm|um|µm|mil|in|cm)?\s*$/i.test(node.radius?.source):node.type==="compare";
  }
  function folderPourDependencies(host,doc,project){
    const folder=host?.folderProject?.();
    if(!folder||folder.standalone)return null;
    const incomplete=new Set(),check=id=>{if(id&&folder.ownerReady?.(id)===false)incomplete.add(id);};
    check(doc.id);
    let needsSheets=false;
    for(const scope of copperRuleScopes(doc,project)){
      for(const {target} of scope.bindings||[]){
        check(target?.docId);check(target?.ownerId);
      }
      const selector=scopeSelector(scope);
      if(selector.kind==="query"||!selector.kind){
        const parsed=globalThis.AtriumDesignQueryParser?.parse?.(scope.source);
        if(!parsed?.ok||scopeUsesSheets(parsed.ast))needsSheets=true;
      }else if(!boardScopeFamilies.has(selector.kind))needsSheets=true;
    }
    if(!needsSheets&&(doc.items||[]).some(i=>i.kind==="polygon"&&(i.connectStyle==="auto"||i.viaConnectStyle==="auto")))needsSheets=true;
    const sheets=needsSheets&&folder.completeFor?.("erc")===false;
    return incomplete.size||sheets?{folder,ids:[...incomplete],sheets}:null;
  }
  function waitForFolder(host,doc,project){
    const folder=host.folderProject?.();
    if(live.folderWait?.folder!==folder){
      live.folderWait?.off?.();
      live.folderWait={folder,off:folder?.on?.(event=>{
        if(event!=="loaded"||live.host!==host||host.folderProject?.()!==folder)return;
        if(live.withheld)sourcePreparation.delete(live.withheld.doc);
        stateMemo=null;live.cache=null;
        live.withheld=null;host.redraw?.();schedule();wakeSettle();
      })};
    }
    live.withheld={doc,project,rev:host.revision?.()};
  }
  function canMirrorBoard(doc,project){
    return canMirror()&&doc?.kind==="pcb"&&project?.documents?.includes(doc)&&
      !doc.pcbDrawing?.sourceFill&&doc.pcbDrawing?.pourSignatureVersion!==3&&
      !(doc.pcbDrawing?.pours||[]).some(r=>r.polygon==null);
  }
  // Run by the dedicated worker. All of the work that reads the whole board
  // (including the post-fill signatures) finishes before the editor derives.
  function* liveWorkerSteps(doc,defs,{project,known,failed,area,mirrorSignatures}){
    const drawing=doc.pcbDrawing;
    // Source hatches and the old format's verified artwork can require changes to items.
    // The usual source-adoption path handles those edits with its provenance checks.
    if(drawing?.sourceFill||drawing?.pourSignatureVersion===3||
      (drawing?.pours||[]).some(r=>r.polygon==null)||
      (doc.items||[]).some(i=>i.sourcePour!=null))return {unsupported:true};
    const options={project,area,mirrorSignatures,slices:true,reuse:false},keep=new Set(known),evaluated=evaluatedPours(doc);
    const eligible=id=>evaluated.has(id)||!keep.has(id);
    let sigs=yield* pauses(polygonSignatureSteps(doc,defs,{
      ...options,keepItemHashes:h=>{options.itemHashes=h;}
    },SLICE_CHUNK));
    let all=staleFromSignatures(doc,sigs);
    const ids=runnableStale(doc,defs,options,all,sigs,failed,eligible);
    if(!ids.length)return {ids,all,next:[]};

    const result=yield* repourSteps(doc,defs,{...options,only:ids});
    const boardSig=yield* pauses(AtriumPCBPours.signatureSteps(doc,defs,SLICE_CHUNK,project));
    const plan=yield* pauses(commitPlanSteps(doc,defs,{...options,only:ids,result,boardSig},SLICE_CHUNK));
    const view={...doc,pcbDrawing:{...(drawing||{annotations:{}})}};
    apply(view,defs,{...scopedBoardView(doc,defs,options),only:ids,plan,result,detached:true,derived:true});
    sigs=result.signatures;all=staleFromSignatures(view,sigs);
    const failuresAfter={...failed};
    for(const id of Object.keys(result.stats.polygons))if(!result.stats.polygons[id]?.failed)delete failuresAfter[id];
    for(const f of result.failed)failuresAfter[f.id]={sig:sigs[f.id]};
    const next=runnableStale(view,defs,options,all,sigs,failuresAfter,eligible);
    // Connection descriptions can contain every pad on the board. The editor's
    // live statistics use aggregate timings; the dialog computes details on demand.
    for(const stats of Object.values(result.stats.polygons))delete stats.connections;
    return {ids,all,next,drawing:view.pcbDrawing,stamp:view.sourcePourSignature,
      stats:result.stats,failed:result.failed,signatures:sigs,unverified:result.unverified};
  }
  const liveEnabled=()=>liveMode()==="live"&&editorVisible();
  // Live slices: about SLICE_MS of work each; signatures hash SLICE_CHUNK items between checks.
  const SLICE_MS=8,SLICE_MAX=40,SLICE_CHUNK=1500;
  const slot=fn=>globalThis.requestIdleCallback?globalThis.requestIdleCallback(fn,{timeout:50}):setTimeout(fn,0);
  // Without requestIdleCallback (WebKit) the repour starts after the edit's frame is drawn (idle.js).
  const idle=fn=>globalThis.requestIdleCallback?globalThis.requestIdleCallback(fn,{timeout:150}):globalThis.AtriumIdle?.afterFrame?AtriumIdle.afterFrame(fn):setTimeout(fn,0);
  function liveMode(){
    if(live.mode)return live.mode;
    let v=null;try{v=(globalThis.AtriumPref||globalThis.AtriumPrefs)?.get?.("pcb.livePours");}catch{v=null;}
    return v==="manual"?"manual":"live";
  }
  function setLiveMode(mode){
    live.mode=mode==="manual"?"manual":"live";
    try{globalThis.AtriumPrefs?.set?.("pcb.livePours",live.mode);}catch{/* not stored */}
    try{globalThis.AtriumNavCommon?.setChecked?.("pour-live",live.mode==="live");}catch{/* no menu */}
    stateMemo=null;live.cache=null;live.host?.invalidate?.();
    if(live.mode==="live")schedule();
    else{live.client?.close();cancelExact();stopRun(live.running?.control);live.deferred=false;forgetTilePreview();}
    return live.mode;
  }
  function makeWorker(){
    if(live.workerBroken||typeof Worker!=="function"||typeof Blob!=="function"||typeof globalThis.URL?.createObjectURL!=="function")return null;
    try{
      const url=URL.createObjectURL(new Blob([solveSource()],{type:"text/javascript"})),w=new Worker(url);
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      w.onmessage=e=>{const f=live.waiters.get(e.data.id);live.waiters.delete(e.data.id);live.workerJobs=(live.workerJobs||0)+1;f?.(e.data);};
      // A crash drops this worker; the next solve starts a fresh one. Two crashes before any solve
      // ever finished: workers do not run here.
      w.onerror=e=>{e?.preventDefault?.();if(live.worker===w)live.worker=null;live.crashes=(live.crashes||0)+1;if(!live.workerJobs&&live.crashes>=2)live.workerBroken=true;
        const ws=[...live.waiters.values()];live.waiters.clear();for(const f of ws)f({error:"worker"});};
      return w;
    }catch{live.workerBroken=true;return null;}
  }
  // Solve one task off the input path: in the live worker; a crash is retried once in a fresh
  // worker, then the pour fails (error.crashed: it keeps its copper). Only where no worker can start
  // does the solve run on this thread, in idle time with its budget (mainSolve).
  function solveAsync(task,retried=false){
    return new Promise((resolve,reject)=>{
      const local=()=>{const p=mainSolve(task);live.localSolve=p;p.then(v=>{if(live.localSolve===p)live.localSolve=null;resolve(v);},e=>{if(live.localSolve===p)live.localSolve=null;reject(e?.cancelled?"moved":e);});};
      if(!live.worker)live.worker=makeWorker();
      if(!live.worker){local();return;}
      const id=++live.seq;
      live.waiters.set(id,d=>{
        if(d.error==="moved")reject("moved");
        else if(d.error==="worker"){if(!retried)solveAsync(task,true).then(resolve,reject);else reject(Object.assign(Error("crashed"),{crashed:true}));}
        else if(d.error)reject(Error(d.error));else resolve(d.result);
      });
      // Structured clone (no transfer): the task stays readable if the worker dies.
      try{live.worker.postMessage({id,task});}catch{live.waiters.delete(id);live.workerBroken=true;live.worker=null;local();}
    });
  }
  // Latest wins: an edit cancels the exact solve in flight (the worker is replaced; its job is
  // answered "moved" and repoured for the new revision).
  function cancelExact(){
    if(live.localSolve){const p=live.localSolve;live.localSolve=null;p.cancel();}
    if(!live.worker||!live.waiters.size)return false;
    try{live.worker.terminate();}catch{/* gone */}
    live.worker=null;const w=[...live.waiters.values()];live.waiters.clear();for(const f of w)f({error:"moved"});
    return true;
  }
  // Stale polygons that were poured before, cached per document revision.
  function liveStale(doc,defs){const g=liveStaleSteps(doc,defs);let r=g.next();while(!r.done)r=g.next();return r.value;}
  // liveStale as steps: the same stale() answer, its signatures hashed in chunks.
  function* liveStaleSteps(doc,defs,chunk=Infinity){
    const H=live.host,rev=H?.revision?.();
    const failed=failures(doc),cached=live.cache;
    if(cached&&cached.doc===doc&&cached.rev===rev&&cached.defs===defs&&rev!=null&&Array.isArray(cached.ids)&&
        (cached.runnable||!Object.keys(failed).length))return cached.ids;
    const d=doc.pcbDrawing,options={project:H?.project?.()};
    let all,sigs;
    if(!d?.sourceFill&&(d?.pourSignatureVersion===SIGNATURE_VERSION||!d?.pourSignatures)){
      // What stale() computes, in steps.
      sigs=yield* polygonSignatureSteps(doc,defs,{...options,keepItemHashes:h=>{live.itemHashes={doc,rev,h};}},chunk);
      all=staleFromSignatures(doc,sigs);
    }else all=stale(doc,defs,options);
    const eligible=new Set(eligibleStale(doc,all));
    const ids=runnableStale(doc,defs,options,all,sigs,failed,id=>eligible.has(id));
    live.cache={doc,rev,defs,ids,all,runnable:true};
    return ids;
  }
  // Live pours on the shared pour pool (LIVE.pool false: the single live worker, for measurements).
  const LIVE_WORKERS=4,LIVE={pool:true};
  function livePool(){if(!LIVE.pool)return null;const p=solvePool();return p?.available?p:null;}
  const stillHere=(host,doc)=>host.doc?.()===doc||
    (live.saving?.doc===doc&&live.saving.project===host.project?.()&&live.saving.project.documents.includes(doc));
  function schedule(){
    const H=live.host;
    if(live.timer?.current?.()===false){live.timer=null;live.timerDoc=null;}
    if(!H||!liveEnabled()||live.timer||live.deferred)return;
    const saved=live.saving?.doc;
    const doc=saved&&stillHere(H,saved)?saved:H.doc?.(),rev=H.revision?.(),c=live.cache;
    const withheld=live.withheld;
    if(withheld?.doc===doc&&withheld.rev===rev&&withheld.project===H.project?.())return;
    if(c&&c.doc===doc&&c.rev===rev&&rev!=null&&c.defs===H.defs?.()&&Array.isArray(c.ids)&&!c.ids.length)return;
    if(live.running){if(live.running.doc!==doc||live.running.rev!==rev)live.again=true;return;}
    // The legacy fill waits while a tile pass paints, to keep its own main-thread slices out of that
    // frame. The dedicated board worker can start independently of the tile worker.
    live.timerDoc=doc;
    if(H.stageEdit)live.timer=H.stageEdit("pours","exact-pour",current=>{
      live.timer=null;live.timerDoc=null;if(!current())return;
      if(canMirrorBoard(doc,H.project?.())||!tiles.busy&&!tiles.painting){run(doc);return;}
      const wait={current};live.timer=wait;live.timerDoc=doc;
      afterTiles(()=>{if(live.timer!==wait)return;live.timer=null;live.timerDoc=null;if(current())run(doc);});
    });
    else live.timer=idle(()=>{live.timer=null;live.timerDoc=null;run(doc);});
  }
  // A timed-out or interrupted job has no result whose signatures can be trusted.
  // Track its intended work on this exact revision before an ordinary Save can proceed.
  async function interruptedRefill(H,doc,defs,project,still,error){
    const options={project};
    // A missing dependency cannot establish that retained copper is stale.
    if(queryPending(doc,options)||folderPourDependencies(H,doc,project))return still();
    const list=polygons(doc),available=list.map(p=>p.id);
    let signatures,all,marked;
    try{
      const check=await driveSlices(polygonSignatureSteps(doc,defs,options,SLICE_CHUNK),still);
      if(!check||!still())return false;
      signatures=check.value;all=staleFromSignatures(doc,signatures);
      const eligible=new Set(eligibleStale(doc,available)),dirty=new Set(all.filter(id=>eligible.has(id)));
      const deps=dirty.size?pourDependencies(doc,defs,list,options,doc.pcbDrawing?.pours):null;
      if(deps)forwardMarkPrerequisites(list,deps,p=>eligible.has(p.id),i=>dirty.has(list[i].id),p=>dirty.add(p.id));
      marked=available.filter(id=>dirty.has(id));
    }catch{
      // A failure while inspecting the inputs cannot establish which prior copper is valid.
      signatures=null;all=available;marked=eligibleStale(doc,all);
    }
    if(!still())return false;
    if(!error&&!marked.length)return true;
    if(marked.length)H.derive(()=>{
      const drawing=doc.pcbDrawing||={annotations:{}};
      globalThis.AtriumPourMarker.write(drawing,marked);
      if(error){
        // Keep failed inputs dormant. An ordinary pause can retry on resume.
        const eligible=new Set(marked);
        noteFailures(doc,{failed:all.filter(id=>eligible.has(id)).map(id=>({id,reason:error})),signatures});
      }
    },{source:"pours",touched:hintFor(doc),persistDerived:true});
    const rev=H.revision();
    if(error){
      const staleIds=new Set([...all,...marked]);
      live.failed={doc,rev,error};
      live.cache={doc,rev,defs:H.defs(),all:available.filter(id=>staleIds.has(id)),ids:[],runnable:true};
    }else live.cache=null;
    tileSettled(doc,rev);
    return true;
  }
  function publishLiveCopper(host,doc,commit){
    const span=globalThis.AtriumDiagnostics?.performance?.begin("pours","publish");
    try{host.derive(commit,{source:"pours",touched:hintFor(doc)});span?.end("completed");}
    catch(error){span?.end("failed");throw error;}
  }
  async function run(doc=live.host?.doc?.()){
    const H=live.host;if(!H||!liveEnabled()||!stillHere(H,doc)||H.drag?.()?.before)return;
    if(live.running){live.again=true;return;}
    if(doc?.kind!=="pcb"||!(doc.items||[]).some(i=>i.kind==="polygon"))return;
    const project=H.project?.();
    // Both live refill paths wait for the compiler to interpret scoped rules.
    const dependency=ruleDependency(doc,{project});
    if(dependency){
      if(!ruleLoadFailures.has(dependency))loadRuleDependency(dependency)?.catch(error=>globalThis.AtriumDiagnostics?.failed?.(error));
      return;
    }
    if(doc?.kind==="pcb"&&folderPourDependencies(H,doc,project)){waitForFolder(H,doc,project);wakeSettle();return;}
    live.withheld=null;
    if(!canMirrorBoard(doc,project))return runLegacy(doc);
    const defs=H.defs(),rev=H.revision(),journal=journalOf(),control={},t0=now();
    const docs=project.documents,n=docs.length;
    const still=()=>!control.stopped&&live.host===H&&liveEnabled()&&!H.drag?.()?.before&&
      H.revision()===rev&&H.defs()===defs&&stillHere(H,doc)&&H.project()===project&&project.documents===docs&&docs.length===n;
    const request={doc,rev,ids:[],control};
    live.running=request;live.again=false;
    let fallback=false,again=false;
    try{
      const lazy=globalThis.AtriumLazy;
      const C=globalThis.AtriumLivePourClient||await lazy.need("AtriumLivePourClient");
      // Body-distance scopes need the same measured outlines in the editor's
      // direct inspections and in the worker. Demand their reader on first use.
      if(scopedWorkerSnapshot(doc,project)&&!globalThis.AtriumDFA&&lazy?.need)await lazy.need("AtriumDFA");
      if(!still())return;
      const client=live.client??=C.create();
      const r=await client.refill(doc,defs,project,journal,known.get(doc.id)||new Set(),failures(doc),still);
      if(!still())return;
      if(r.unsupported){fallback=true;return;}
      if(!Array.isArray(r.ids)||!Array.isArray(r.all)||!Array.isArray(r.next)||
        r.ids.length&&(!r.drawing||!r.stats?.polygons||!r.transport||!Array.isArray(r.unverified))){
        throw Error("The live pour worker returned an incomplete refill.");
      }
      request.ids=r.ids;
      let commit=0;
      if(r.drawing){
        // Keep the original objects for unchanged regions; the canvas and its GPU
        // buffers can continue to use them. All new regions arrive encoded.
        const previous=doc.pcbDrawing?.pours||[];
        const regions=r.rows.map(row=>typeof row==="number"?previous[row]:row);
        if(regions.some(region=>!region||typeof region.data!=="string"))throw Error("The live pour worker returned incomplete copper.");
        await new Promise(resolve=>slot(resolve));
        if(!still())return;
        const start=now();
        publishLiveCopper(H,doc,()=>{
          const drawing=doc.pcbDrawing||={annotations:{}};
          for(const key of ["importedPourSignature","sourceHatchSignature","pourSignatures","pourSignatureVersion"]){
            if(own(r.drawing,key))drawing[key]=r.drawing[key];else delete drawing[key];
          }
          globalThis.AtriumPourMarker.write(drawing,r.unverified);
          if(r.hasPours)drawing.pours=regions;else delete drawing.pours;
          if(r.stamp)doc.sourcePourSignature=r.stamp;else delete doc.sourcePourSignature;
          noteFailures(doc,r);noteRefills(doc,r,new Set(r.ids));
          globalThis.AtriumPCBPours?.release?.(previous,regions);
          globalThis.AtriumCanvasFast?.releasePours?.(previous,regions);
        });
        client.accept(r,doc,H.defs(),project,journal);
        commit=now()-start;
      }
      const committedRev=H.revision();
      live.failed=null;
      live.cache={doc,rev:committedRev,defs:H.defs(),all:r.all,ids:r.next,runnable:true};
      if(r.next.length)again=true;
      else{
        tileSettled(doc,committedRev);
        if(!r.all.length&&H.doc?.()===doc)warmMirrorTiles(H);
      }
      if(r.ids.length)live.last={ids:r.ids,ms:now()-t0,main:r.transport.ms+commit,
        longest:Math.max(r.transport.longest,r.transport.receive,commit),commit,polygons:r.stats.polygons,at:Date.now(),transport:r.transport};
    }catch(e){
      if(!still()||e?.cancelled)return;
      if(e?.hung){
        if(await interruptedRefill(H,doc,defs,project,still,e.message))H.info?.(e.message+" Repour All to retry.");
      }else{
        live.client?.close();live.remoteDisabled=true;
        fallback=true;
      }
    }finally{
      if(live.running===request){
        live.running=null;wakeSettle();
        if(fallback&&still())runLegacy(doc,true);
        else if(again||live.again||(!still()&&!tileDragging())){live.again=false;schedule();}
      }
    }
  }
  const tileDragging=()=>!!live.host?.drag?.()?.before;
  async function runLegacy(doc,fallback=false){
    const H=live.host;if(!H||!liveEnabled()||!stillHere(H,doc))return;
    if(live.running){live.again=true;return;}
    if(!doc||doc.kind!=="pcb"||!(doc.items||[]).some(i=>i.kind==="polygon"))return;
    const defs=H.defs(),project=H.project?.(),rev=H.revision(),t0=now();let main=0,steps=0;const slices=[];
    if(sourceMode(doc)&&sourceMode(doc)!=="fill")adopt(doc,defs,{project},false);
    const timed=(fn,what="step")=>{const t=now();try{return fn();}finally{const d=now()-t;main+=d;steps=Math.max(steps,d);slices.push([what,+d.toFixed(2)]);}};
    // Every main-thread step runs in its own idle slice and the job is dropped as soon as the
    // board changes (cancellable). The canvas keeps showing the last good copper meanwhile
    // (displayState), and the new copper replaces it in one short commit.
    const control={},moved=()=>control.stopped||live.host!==H||!liveEnabled()||H.revision()!==rev||
      H.defs()!==defs||H.project?.()!==project||!stillHere(H,doc);
    // A pause gives the browser its turn; the idle deadline after it sets the next slice's budget:
    // SLICE_MS while frames are due, up to SLICE_MAX when the editor is really idle.
    let budget=SLICE_MS;
    const pause=()=>new Promise(r=>slot(d=>{budget=d&&!d.didTimeout&&typeof d.timeRemaining==="function"?Math.max(SLICE_MS,Math.min(SLICE_MAX,d.timeRemaining())):SLICE_MS;r();}));
    // Run a step generator in slices, pausing for the browser in between.
    const drive=async(gen,what)=>{
      for(;;){
        const t=now(),b=budget,r=timed(()=>{let x;do x=gen.next();while(!x.done&&now()-t<b);return x;},what);
        if(r.done)return r.value;
        await pause();if(moved())throw "moved";
      }
    };
    live.running={doc,rev,ids:[],control};
    const span=globalThis.AtriumDiagnostics?.performance?.begin("pours",fallback?"fallback":"build");
    let outcome="cancelled";
    try{
      const ids=await drive(liveStaleSteps(doc,defs,SLICE_CHUNK),"stale");
      if(!ids.length){tileSettled(doc,rev);outcome="completed";return;}
      live.running.ids=ids;live.again=false;
      let result;
      // With a worker pool: the two-stage scheduler of Repour All (repourParallel: every stale pour's
      // stage 1 at once, stage 2 as the pours it reads are done, main-thread steps in short slices),
      // at most LIVE_WORKERS solves at once, one in Efficiency mode (AtriumPower.efficient()). Else
      // one worker, one solve at a time. Both give the same copper.
      const pool=livePool();
      if(pool){
        const limit=()=>globalThis.AtriumPower?.efficient?.()?1:LIVE_WORKERS;
        result=await repourParallel(doc,defs,{project:H.project(),only:ids,active:()=>!moved(),control,limit,onProgress:p=>fillProgress(doc,p)},pool);
        if(!result||moved())throw "moved";
        main+=result.stats.main;steps=Math.max(steps,result.stats.longest);slices.push(["pool",+result.stats.main.toFixed(2)]);
      }else{
        const gen=repourSteps(doc,defs,{project:H.project(),only:ids,slices:true});
        // Main-thread steps continue through PAUSE until the slice budget is spent; tasks go to the worker.
        const step=first=>{const t=now(),b=budget;let x=first();while(!x.done&&x.value===PAUSE&&now()-t<b)x=gen.next();return x;};
        let r=timed(()=>step(()=>gen.next()),"prepare");
        while(!r.done){
          // A solve that fails (crash, budget) fails its pour only: thrown into its steps (guardedPourSteps).
          let solved,failed=null;
          if(r.value===PAUSE)solved=await pause();
          else try{solved=await solveAsync(r.value.task);}catch(e){if(e==="moved")throw e;failed=e;}
          if(moved())throw "moved";
          r=timed(()=>step(()=>failed?gen.throw(failed):gen.next(solved)),"prepare");
        }
        if(moved())throw "moved";
        result=r.value;
      }
      // The signatures of the new copper, then its canvas paths, each in their own slices.
      await pause();if(moved())throw "moved";
      const hashes=live.itemHashes&&live.itemHashes.doc===doc&&live.itemHashes.rev===rev?live.itemHashes.h:null;
      const plan=await drive(commitPlanSteps(doc,defs,{project:H.project(),only:ids,result,itemHashes:hashes},SLICE_CHUNK),"signatures");
      // Paths in batches of about 8 ms (one large region is one step).
      if(globalThis.AtriumPCBPours?.warm)for(let k=0;k<result.regions.length;){
        await pause();if(moved())throw "moved";
        const t=now(),b=budget;timed(()=>{do AtriumPCBPours.warm(result.regions[k++]);while(k<result.regions.length&&now()-t<b);},"paths");
      }
      await pause();if(moved())throw "moved";
      span?.ready();
      const tc=now();timed(()=>{publishLiveCopper(H,doc,()=>apply(doc,defs,{project:H.project(),only:ids,result,plan,derived:true}));restamp(doc,result.stats.reuseSeq);},"commit");
      // Earlier copper can change a previously current neighbour's signature. The commit plan
      // already hashed the new geometry; continue the dependency chain without waiting for paint.
      const staleAfter=staleFromSignatures(doc,result.signatures),eligible=new Set(eligibleStale(doc,staleAfter));
      const next=runnableStale(doc,defs,{project:H.project()},staleAfter,result.signatures,failures(doc),id=>eligible.has(id));
      const committedRev=H.revision?.();
      live.failed=null;
      live.cache={doc,rev:committedRev,defs,all:staleAfter,ids:next,runnable:true};
      if(next.length)live.again=true;else tileSettled(doc,committedRev);
      live.last={ids,ms:now()-t0,main,longest:steps,commit:now()-tc,polygons:result.stats.polygons,at:Date.now(),slices};
      outcome="completed";
    }catch(e){
      if(e!=="moved"&&!moved()){
        outcome="failed";
        const error=e?.message||String(e);
        if(await interruptedRefill(H,doc,defs,project,()=>!moved(),error))
          H.info?.("Live repour failed ("+error+"); the pours are marked stale. Repour All to retry.");
      }else live.again=true;
    }finally{
      span?.end(outcome);
      live.running=null;wakeSettle();
      if(live.again){live.again=false;schedule();}
    }
  }
  // Repour Selected (pour context menu, Tools › Polygon Pours): the selected pours only.
  async function repourSelected(host){
    const d=host.doc?.();
    if(!d||d.kind!=="pcb"){host.info?.("Open a board layout first.");return;}
    const sel=new Set(host.selection?.()||[]),picked=(d.items||[]).filter(i=>i.kind==="polygon"&&sel.has(i.id)&&!i.cutout);
    if(!picked.length){host.info?.("Select a polygon pour to repour. Repour All repours every pour.");return;}
    const defs=host.defs(),only=affected(d,picked.map(i=>i.id),defs);
    let r;
    try{r=await repour(d,defs,{project:host.project?.(),only},fn=>host.edit(fn),m=>host.info?.(m));}catch(e){host.info?.(e.message);return;}
    if(!r)return;
    const name=p=>p.name||((p.net||"No Net")+" on "+p.layer),more=only.length-picked.length;
    host.info?.("Repoured "+(picked.length===1?name(picked[0]):picked.length+" pours")+(more>0?" and "+more+" later pour"+(more===1?"":"s")+" on the same layer":"")+".");
  }
  function attachLive(host){
    if(!host)return;
    host.registerAction?.("repour-selected",()=>repourSelected(host));
    if(typeof host.derive!=="function")return;
    if(live.host!==host){live.client?.close();live.remoteDisabled=false;}
    live.host=host;
    let owner=host.project?.();
    function bindProject(){
      const project=host.project?.();
      if(project===owner)return;
      owner=project;
      forgetTilePreview();
      stateMemo=null;live.cache=null;live.failed=null;
      live.client?.close();cancelExact();
      specOnChange();stopRun(pooled?.control);stopRun(live.running?.control);
      clearTimeout(live.timer);live.timer=null;live.deferred=false;live.again=false;
      known.clear();noteKnown();
    }
    host.on?.("replace",()=>{live.folderWait?.off?.();live.folderWait=null;live.withheld=null;bindProject();});
    host.on?.("document",()=>{
      const owner=tiles.state?.doc||tiles.building?.doc||tiles.warm?.doc;
      if(owner&&owner!==host.doc?.())forgetTilePreview();
    });
    live.offPower?.();
    let wasVisible=editorVisible();
    live.offPower=globalThis.AtriumPower?.onChange?.(state=>{
      if(!state.visible||state.efficient){
        specOnChange();
      }
      if(!state.visible||state.efficient)forgetTilePreview();
      if(!state.visible){
        live.client?.close();
        cancelExact();
        stopRun(live.running?.control);
      }else if(!wasVisible&&liveEnabled()){
        if(!tiles.off&&!canMirrorBoard(host.doc?.(),host.project?.()))scheduleTileEdit(host);
        schedule();
      }
      wasVisible=state.visible;
    });
    host.registerAction?.("pour-live",()=>{const m=setLiveMode(liveMode()==="live"?"manual":"live");host.info?.(m==="live"?"Live pours on: pours repour after each edit.":"Live pours off: repour from Tools → Polygon Pours or the Pour Manager.");});
    noteKnown();
    specListen();
    host.on?.("change",detail=>{
      if(detail?.source==="pours")return;
      bindProject();
      noteKnown();specOnChange();
      stopRun(pooled?.control);
      stopRun(live.running?.control);
      if(!liveEnabled())return;
      if(live.running&&cancelExact())live.again=true;
      live.client?.cancel();
      if(canMirrorBoard(host.doc?.(),host.project?.())){
        scheduleMirrorTileEdit(host);
        schedule();
        return;
      }
      if(tiles.off){schedule();return;}
      if(tiles.state&&!tiles.building)live.deferred=true;
      else schedule();
      scheduleTileEdit(host);
    });
    // A drag starts without an editor event: the first pointer move of a drag starts the tile loop.
    try{globalThis.document?.addEventListener?.("pointermove",dragWatch,{capture:true,passive:true});}catch{/* no DOM */}
    // Preferences › PCB › Interactive editing (prefs.js): repour after edits, and while dragging.
    try{
      globalThis.AtriumPrefs?.on?.("pcb.livePours",e=>{if((e.value==="manual"?"manual":"live")!==liveMode())setLiveMode(e.value);});
      globalThis.AtriumPrefs?.on?.("pcb.livePourDrag",e=>{tiles.pref=e.value==="drop"||e.value==="off"?e.value:"live";host.redraw?.();});
    }catch{/* no preferences */}
    try{
      globalThis.AtriumNavCommon?.menuItem?.("tools","repour-selected","Polygon Pours → Repour Selected",{after:"repour",scope:"pcb"});
      globalThis.AtriumNavCommon?.menuItem?.("tools","pour-live","Polygon Pours → Live Pours",{after:"repour-selected",scope:"pcb",checkable:true});
      globalThis.AtriumNavCommon?.setChecked?.("pour-live",liveMode()==="live");
    }catch{/* no menu */}
  }
  // What the canvas should show. In live mode, stale engine pours are about
  // to be replaced, so the last copper stays visible instead of vanishing
  // between an edit and its repour; after a failed repour it is "stale".
  function displayState(doc,defs){
    // In live mode, with only engine copper (every region tagged) and no failed repour, the
    // answer is "source" whether or not the copper is stale (a stale pour is about to be
    // replaced), so the signature check moves out of the frame into the live job's idle slice.
    const pours=doc.pcbDrawing?.pours;
    if(liveMode()==="live"&&live.host&&live.host.doc?.()===doc&&!(live.failed&&live.failed.doc===doc)&&!doc?.pcbDrawing?.sourceFill&&
      Array.isArray(pours)&&pours.length&&pours.every(r=>r.polygon!=null)){schedule();return "source";}
    const report=inspectCopper(doc,defs);
    if(report.reason==="source-adoption")return "source";
    const s=report.state==="current"?"source":report.state==="none"?"none":"stale";
    if(s!=="stale"||liveMode()!=="live"||!live.host||live.host.doc?.()!==doc)return s;
    if(live.failed&&live.failed.doc===doc)return s;
    if((doc.pcbDrawing?.pours||[]).some(r=>r.polygon==null))return s;
    schedule();
    return "source";
  }
  // A cold view can explicitly request preparation. Keep the initial graph
  // back until source links have been indexed, without adopting in a read.
  let sourcePreparation=new WeakMap();
  function prepareLiveCopper(doc,defs){
    const H=live.host,project=H?.project?.(),revision=H?.revision?.();
    if(H?.doc?.()!==doc||H.drag?.()?.before||!globalThis.AtriumLazy?.need)return null;
    const options={project}, dependency=ruleDependency(doc,options), source=sourceMode(doc);
    if(!dependency&&!source&&!folderPourDependencies(H,doc,project))return null;
    const previous=sourcePreparation.get(doc);
    if(previous?.host===H&&previous.project===project&&previous.revision===revision)return previous.promise;
    const still=()=>H===live.host&&H.doc()===doc&&H.project()===project&&H.revision()===revision&&!H.drag?.()?.before;
    const preparation={host:H,project,revision,promise:null};
    preparation.promise=Promise.resolve().then(async()=>{
      await queryReady(doc,options);
      if(!still())return;
      if(folderPourDependencies(H,doc,project)){waitForFolder(H,doc,project);return;}
      if(sourceMode(doc)!=="fill")adopt(doc,H.defs?.()||defs,options,false);
      schedule();
    }).catch(error=>globalThis.AtriumDiagnostics?.failed?.(error)).finally(()=>{
      preparation.promise=null;
      if(still()){H.invalidate?.();H.redraw?.();}
      else if(sourcePreparation.get(doc)===preparation)sourcePreparation.delete(doc);
    });
    sourcePreparation.set(doc,preparation);
    return preparation.promise;
  }
  function verifying(doc,defs){
    const report=inspectCopper(doc,defs);
    return report.state==="pending"||report.reason==="source-adoption"||
      report.state==="stale"&&displayState(doc,defs)==="source";
  }
  function stateOf(doc,defs,options){
    const checked=inspectCopper(doc,defs,options);
    const pending=new Set(live.running?.doc===doc?live.running.ids:[]);
    const polygonsOut={};
    for(const i of doc.items||[]){
      if(i.kind!=="polygon")continue;
      polygonsOut[i.id]=i.cutout?"cutout":i.shelved?"shelved":pending.has(i.id)?"pending":ownerState(checked,i.id);
    }
    return {mode:liveMode(),state:checked.state==="current"?"source":checked.state,reason:checked.reason,pending:[...pending],
      stale:checked.stale.filter(id=>polygonsOut[id]==="stale"),polygons:polygonsOut,last:live.last,
      failed:live.failed?.doc===doc?live.failed.error:null};
  }
  // ------------------------------------------------ copper for fabrication outputs
  // What Gerber, drill, IPC-2581, STEP and the drawings plot (fab-outputs.js analyse): never copper
  // that is out of date, and never no copper in its place. outputCopper(doc, defs, {project, solve})
  // -> {state, regions, filled, pending, imported}:
  //   "none"     no pours.
  //   "current"  the stored copper is the exact fill for the board as it stands.
  //   "filled"   pours out of date or never poured in the document (`filled`, ids in pour order;
  //              `unpoured` the never-poured ones) were filled on a copy, exactly as Repour All
  //              would: the document is unchanged.
  //   "pending"  (solve false) `pending` lists the pours that need the fill; regions is null.
  //   imported:  regions imported without an editable pour (noneditable artwork). They are always
  //              plotted as stored, never solved: {count, fresh} (fresh false: the board changed since).
  // Output preparation runs on a private drawing. A no-solve probe never
  // adopts links or fills source zones, including imported Eagle polygons.
  function outputCopper(doc,defs,options={}){
    const context=options.rules===undefined?{project:copperProject(doc,options)}:
      {project:copperProject(doc,options),rules:options.rules};
    const report=inspectCopper(doc,defs,context);
    let imported=report.imported;
    const ready=regions=>({state:regions.length?"current":"none",regions,filled:[],pending:[],imported});
    if(!report.source&&!report.stale.length&&!report.unpoured.length&&!report.reason)return ready(report.regions);
    const active=polygons(doc);
    const evaluated=evaluatedPours(doc);
    if(options.evaluatedOnly)for(const i of doc.items)if(i.sourcePour!=null)evaluated.add(i.sourcePour);
    const requested=ids=>options.evaluatedOnly?ids.filter(id=>evaluated.has(id)):ids;
    const pending=ids=>({state:"pending",regions:null,filled:[],pending:ids,imported});
    if(report.reason==="project-members"){
      if(options.solve===false)return pending(requested(active.map(p=>p.id)));
      throw Error("The copper rules need unavailable project members. No outputs were made.");
    }
    if(report.reason==="AtriumRules"||report.reason==="AtriumDesignQuery"){
      if(options.solve===false)return pending(requested(active.map(p=>p.id)));
      throw Error(report.state==="pending"?"The design rules' scopes are still loading. Try the outputs again in a moment.":
        "The design rules' scopes cannot be verified. No outputs were made.");
    }
    let ids=requested(report.source?active.map(p=>p.id):report.stale);
    const adoptSource=report.reason==="source-adoption";
    if(!ids.length&&!adoptSource)return ready(report.regions);
    if(options.solve===false)return pending(ids);
    const drawing={...(doc.pcbDrawing||{annotations:{}})},view={...doc,items:[...doc.items],pcbDrawing:drawing};
    const viewOptions=scopedBoardView(doc,defs,context);
    if(drawing.pours)drawing.pours=adoptSource?drawing.pours.map(r=>r.polygon==null?r:{...r}):[...drawing.pours];
    if(drawing.pourSignatures)drawing.pourSignatures={...drawing.pourSignatures};
    if(adoptSource&&adopt(view,defs,{...context,detached:true},false)){
      const adopted=inspectCopper(view,defs,context);
      ids=requested(adopted.stale);
      if(!ids.length)return ready(adopted.regions);
    }
    // Eagle has outlines only. Solve once here, within the exact output loop.
    if(report.source==="fill")delete drawing.sourceFill;
    const filled=new Set();
    for(let guard=active.length+1;ids.length;guard--){
      if(guard<0)throw Error("The copper pours did not settle to one fill, so no outputs were made. Run Repour All and check the pours.");
      const {signatures}=apply(view,defs,{...viewOptions,only:ids,detached:true,reuse:false});
      for(const id of ids)filled.add(id);
      ids=requested(staleFromSignatures(view,signatures));
    }
    // Artwork without an editable owner still belongs in the films.
    const regions=[...(drawing.pours||[])],have=new Set(regions),owned=new Set(active.map(p=>p.layer+"\u0000"+(p.net||"")));
    for(const r of report.regions)if(r.polygon==null&&!have.has(r)&&!owned.has(r.layer+"\u0000"+(r.net||"")))regions.push(r);
    const count=regions.filter(r=>r.polygon==null).length;
    imported=count?{count,fresh:report.imported?.fresh??false}:null;
    const order=active.map(p=>p.id).filter(id=>filled.has(id));
    const unpoured=new Set(report.unpoured);
    return {state:"filled",regions,filled:order,unpoured:order.filter(id=>unpoured.has(id)),pending:[],imported};
  }
  function importedFresh(doc,defs,context,boardMatch){
    if(boardMatch())return true;
    const stamp=doc.pcbDrawing?.importedPourSignature??doc.sourcePourSignature;
    if(!stamp)return false;
    const base={...doc,items:doc.items.filter(i=>i.kind!=="polygon")};
    return AtriumPCBPours.signature(base,defs,context.project,false,context.rules)===stamp;
  }
  // Editor: resolves once the stored copper of `doc` is the exact fill (outputCopper "current" or "none"),
  // waiting for the live repour or a Repour All in flight, else starting Repour All itself (its progress
  // display on the board; one undo step). options: project, signal (an abort stops a Repour All this call
  // started, commits nothing and rejects with an AbortError), onProgress({done, total}). Resolves
  // outputCopper(..., {solve: false}). Away from the editor (no live host showing `doc`) it resolves at
  // once and outputCopper fills on a copy.
  const SETTLE={wake:new Set(),progress:new Set()};
  function wakeSettle(){for(const f of [...SETTLE.wake])f();}
  function fillProgress(doc,p){for(const f of [...SETTLE.progress])f(doc,p);}
  async function settle(doc,defs,options={}){
    const H=live.host,signal=options.signal,o={project:options.project,rules:options.rules};
    const abort=()=>Object.assign(Error("Cancelled."),{name:"AbortError"});
    const progress=(d,p)=>{if(d===doc)try{options.onProgress?.(p);}catch{/* display only */}};
    const nap=()=>new Promise(resolve=>{
      const done=()=>{clearTimeout(t);SETTLE.wake.delete(done);signal?.removeEventListener?.("abort",done);resolve();};
      const t=setTimeout(done,100);SETTLE.wake.add(done);signal?.addEventListener?.("abort",done,{once:true});
    });
    SETTLE.progress.add(progress);
    let started=false;
    try{
      for(;;){
        if(signal?.aborted)throw abort();
        if(queryPending(doc,o)){
          await queryReady(doc,o);
          if(signal?.aborted)throw abort();
        }
        if(H?.doc?.()===doc&&scopedWorkerSnapshot(doc,H.project?.())&&!globalThis.AtriumDFA){
          await globalThis.AtriumLazy?.need?.("AtriumDFA");
          if(signal?.aborted)throw abort();
        }
        const project=H?.project?.(), owned=!!H?.folderProject?.()&&project?.documents?.includes(doc);
        const here=!!H&&H.doc?.()===doc,d=here||owned?H.defs?.()||defs:defs;
        const deps=owned&&folderPourDependencies(H,doc,project);
        if(deps){
          // Explicit outputs can read dependencies. Background edits and normal
          // saves never expand the folder's resident document set.
          if(deps.ids.length)await deps.folder.requireClosure({purpose:"copper scopes",only:deps.ids,signal,assets:false});
          if(deps.sheets)await deps.folder.requireClosure({purpose:"erc",signal,assets:false});
          if(H.project?.()!==project||folderPourDependencies(H,doc,project))
            throw Error("The copper rules need unavailable project members. No outputs were made.");
          continue;
        }
        // A staged live job whose revision has passed never runs (schedule() drops it): not waited for.
        const staged=!!live.timer&&live.timer.current?.()!==false;
        if(here&&(pooled!=null||live.running||staged||live.deferred&&liveEnabled())){await nap();continue;}
        if(here&&sourceMode(doc)&&sourceMode(doc)!=="fill")adopt(doc,d,o,false);
        const out=outputCopper(doc,d,{...o,solve:false});
        if(out.state!=="pending"||!here||started)return out;
        // Live pours repour what edits made stale; a pour they leave (a failed run, never poured) gets Repour All.
        if(liveEnabled()&&!(live.failed&&live.failed.doc===doc)&&eligibleStale(doc,out.pending).length===out.pending.length){
          schedule();if(live.timer&&live.timer.current?.()!==false||live.running){await nap();continue;}
        }
        started=true;
        try{options.onProgress?.({done:0,total:polygons(doc).length});}catch{/* display only */}
        await repour(doc,d,{...o,signal},fn=>H.edit(fn),m=>H.info?.(m));
      }
    }finally{SETTLE.progress.delete(progress);}
  }
  // Save waits for an already-requested fill, or records stale copper when it is paused.
  function pendingSave(doc=live.running?.doc||live.timerDoc||live.host?.doc?.(),only){
    const H=live.host,project=H?.project?.();
    const owned=()=>live.host===H&&H?.project?.()===project&&project?.documents?.includes(doc);
    const pending=()=>owned()&&(live.running?.doc===doc||liveEnabled()&&
      (live.timerDoc===doc&&live.timer?.current?.()!==false||live.deferred&&H.doc?.()===doc));
    if(doc?.kind!=="pcb"||only&&!only.includes(doc.id)||!pending()||
      !(doc.items||[]).some(i=>i.kind==="polygon"))return null;
    if(live.saving?.doc===doc)return live.saving.promise;
    const saving={doc,project};
    live.saving=saving;
    saving.promise=(async()=>{
      try{
        while(owned()){
          if(pending()){
            await new Promise(resolve=>{
              const done=()=>{clearTimeout(timer);SETTLE.wake.delete(done);resolve();};
              const timer=setTimeout(done,50);SETTLE.wake.add(done);
            });
            continue;
          }
          if(liveEnabled())break;
          const rev=H.revision(),defs=H.defs();
          const still=()=>owned()&&!liveEnabled()&&H.revision()===rev&&H.defs()===defs;
          if(await interruptedRefill(H,doc,defs,project,still))break;
        }
      }finally{if(live.saving===saving)live.saving=null;}
    })();
    return saving.promise;
  }
  // ------------------------------------------------------ tiled live pours
  // The fast half of live pours. Every pour is kept as tiles in a tile worker
  // (PourTiles); after an edit only the items that changed are prepared again
  // (keyed shapes, in the pour's fixed integer frame), sent as a diff, and the
  // worker re-solves the tiles they reach. The tiles it reports are shown at
  // once as a display patch over the stored copper: the stored regions are
  // clipped out of the changed tiles (device-pixel-snapped rectangles, so the
  // seam has no anti-aliasing gap) and the tiles' copper is painted there.
  // The exact repour (live pours above) still runs and commits; its copper is
  // the same within one integer unit, so the patch is dropped when it lands.
  // Gerber, DRC and connectivity always read the committed, exact copper.
  // While a part is dragged the same diff runs every frame (latest wins: one
  // request in flight), so the copper follows the part.
  const TILE_TARGET=1024,TILE_MIN=2,DIFF_SLICE=6;
  // The tile worker's message handler (also run in-process when workers are unavailable).
  function tileMessage(T,m){
    if(m.op==="init")T.init(m.list,m.order);
    else if(m.op==="update")T.update(m.diffs,m.order);
    else if(m.op==="drop")T.drop(m.ids);
    else if(m.op==="clear")T.clear();
    const stats=m.run?T.run():null,ch=T.takeChanged(),out={},tr=[];
    if(!m.quiet)for(const id of Object.keys(ch)){
      const s=T.session(id);if(!s)continue;
      const want=new Set();
      for(const t of ch[id]){const c=t%s.cols,r=(t-c)/s.cols;for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){const cc=c+dc,rr=r+dr;if(cc>=0&&rr>=0&&cc<s.cols&&rr<s.rows)want.add(rr*s.cols+cc);}}
      const tiles=[];
      for(const t of want){
        const rings=T.tileRings(s,t).map(r=>{const f=new Float64Array(r.length);for(let i=0;i<r.length;i+=2){f[i]=r[i]/s.S+s.ox;f[i+1]=r[i+1]/s.S+s.oy;}tr.push(f.buffer);return f;});
        tiles.push({t,rings});
      }
      out[id]={changed:ch[id],tiles,grid:{gx0:s.gx0,gy0:s.gy0,TS:s.TS,cols:s.cols,rows:s.rows,S:s.S,ox:s.ox,oy:s.oy,layer:s.layer,net:s.net}};
    }
    return {msg:{id:m.id,stats,out},transfer:tr};
  }
  const tiles={hold:false,settle:null,engine:null,worker:null,broken:false,seq:0,waiters:new Map(),state:null,busy:false,again:false,full:false,only:null,
    patches:new Map(),version:0,list:null,listKey:null,clipped:new WeakMap(),last:null,dragLoop:0,pref:null,syncRev:null};
  function tileEngineLocal(){if(!tiles.engine)tiles.engine=PourTiles(CORE,offsetRing);return tiles.engine;}
  function makeTileWorker(){
    if(tiles.broken||typeof Worker!=="function"||typeof Blob!=="function"||typeof globalThis.URL?.createObjectURL!=="function")return null;
    try{
      const src='"use strict";const TAU=Math.PI*2;const {step:roundStep,envelope:roundEnvelope}='+AtriumGeometryCurves.roundProjectionSource()+';'+(globalThis.AtriumEngine?.workerSource?.()||"")+'const PourCore='+PourCore.toString()+';const offsetRing='+offsetRing.toString()+
        ';const PourTiles='+PourTiles.toString()+';const tileMessage='+tileMessage.toString()+';const T=PourTiles(PourCore(),offsetRing);\n'+
        'onmessage=e=>{let r;try{r=tileMessage(T,e.data);}catch(err){postMessage({id:e.data.id,error:String(err&&err.stack||err)});return;}postMessage(r.msg,r.transfer);};';
      const url=URL.createObjectURL(new Blob([src],{type:"text/javascript"})),w=new Worker(url);
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      w.onmessage=e=>{e.data.arrived=now();const f=tiles.waiters.get(e.data.id);tiles.waiters.delete(e.data.id);f?.(e.data);};
      w.onerror=e=>{e?.preventDefault?.();tiles.broken=true;tiles.worker=null;for(const f of tiles.waiters.values())f({error:"worker"});tiles.waiters.clear();tiles.state=null;};
      return w;
    }catch{tiles.broken=true;return null;}
  }
  // Send one message to the tile engine (worker, else in-process). Resolves with {stats, out}.
  function tileCall(m,transfer=[]){
    return new Promise((resolve,reject)=>{
      const id=++tiles.seq;m.id=id;
      if(!tiles.worker&&!tiles.broken&&tiles.useWorker!==false)tiles.worker=makeTileWorker();
      if(!tiles.worker){try{resolve(tileMessage(tileEngineLocal(),m).msg);}catch(e){reject(e);}return;}
      tiles.waiters.set(id,d=>{if(d.error)reject(Error(d.error));else resolve(d);});
      try{tiles.worker.postMessage(m,transfer);}catch(e){tiles.waiters.delete(id);reject(e);}
    });
  }
  // A keyed job packed into one Int32Array (transferable).
  function packJob(job){
    const keys=[],kidx=new Map(),meta=[],am=[];let size=0;
    const ki=k=>{let v=kidx.get(k);if(v===undefined){v=keys.length;kidx.set(k,v);keys.push(k);}return v;};
    const shapes=job.task?.shapes||[],anchors=job.task?.anchors||[];
    for(const s of shapes)size+=s.ring.length;for(const a of anchors)size+=a.length;
    const data=new Int32Array(size);let o=0;
    for(const s of shapes){meta.push(ki(s.key),s.cls,s.sign,o,s.ring.length);data.set(s.ring,o);o+=s.ring.length;}
    anchors.forEach((a,i)=>{am.push(ki(job.anchorKeys[i]),o,a.length);data.set(a,o);o+=a.length;});
    return {keys,shapes:Int32Array.from(meta),anchors:Int32Array.from(am),data};
  }
  // The tile grid of a keyed job: square tiles of at least TILE_MIN mm and twice the largest
  // clearance to an earlier pour, about TILE_TARGET of them over the work box.
  // A later pour's tiles are at least as large as its earlier pours' (each of its tiles clears
  // the earlier copper around it, so fewer, larger tiles re-solve less of it).
  function tileSpec(job,minMm=0){
    const S=job.S,w=job.work,gx0=Math.floor((w[0]-job.ox)*S)-1,gy0=Math.floor((w[1]-job.oy)*S)-1,gx1=Math.ceil((w[2]-job.ox)*S)+1,gy1=Math.ceil((w[3]-job.oy)*S)+1;
    const maxC=Math.max(0,...job.earlier.map(e=>e.c)),area=(w[2]-w[0])*(w[3]-w[1]);
    const mm=Math.max(TILE_MIN,minMm,2*(maxC+job.tol)+.1,Math.sqrt(area/TILE_TARGET)),TS=Math.max(16,Math.ceil(mm*S));
    const P=job.P,net=P.net;
    return {id:P.id,layer:P.layer,net,S,ox:job.ox,oy:job.oy,tol:job.tol,K:6+job.earlier.length,hasBoard:job.task.hasBoard,
      removeDead:job.task.removeDead,minArea:job.task.minArea,minSize:job.task.minSize,earlier:job.earlier,
      gx0,gy0,TS,cols:Math.max(1,Math.ceil((gx1-gx0)/TS)),rows:Math.max(1,Math.ceil((gy1-gy0)/TS)),pack:packJob(job)};
  }
  // What an item contributes to a pour, compared field by field (references first).
  const PRINT_FIELDS=[...new Set(["kind","x","y","angle","points","w","h","width","diameter","drill","shape","layer","fromLayer","toLayer","plated","net","pinNets","closed","fill","size","text","keepout","keepoutRestrictions","cutout","stackMode","padStack","backdrill","tent","ipc4761","def","sourcePour","r","style","pourIndex"])];
  const fpPrints=new WeakMap();
  function fpPrint(defs,i){
    if(i.kind!=="part")return null;
    const def=defs?.get?.(i.def),fp=def?.footprint;if(!fp)return null;
    const old=fpPrints.get(fp);
    if(old&&old.pads===fp.pads&&old.shapes===fp.shapes&&old.name===fp.name&&old.defName===def.name&&old.value===def.value&&old.footprintName===def.footprintName)return old.hash;
    const h=fastHasher();h.value(fp.pads||[]);h.value(fp.shapes||[]);h.value([fp.name,def.name,def.value,def.footprintName]);
    const hash=h.hex();fpPrints.set(fp,{pads:fp.pads,shapes:fp.shapes,name:fp.name,defName:def.name,value:def.value,footprintName:def.footprintName,hash});return hash;
  }
  // The fields prepare() reads, per kind (any other kind compares them all).
  const KIND_FIELDS={
    track:["kind","points","width","layer","net","fill","closed","keepout","sourcePour"],
    via:["kind","x","y","diameter","drill","layer","fromLayer","toLayer","net","plated","stackMode","padStack","backdrill","tent","ipc4761"],
    pad:["kind","x","y","w","h","diameter","angle","shape","drill","layer","fromLayer","toLayer","net","plated","stackMode","padStack","backdrill"],
    part:["kind","x","y","angle","def","pinNets","layer","ref","value"],
    label:["kind","x","y","angle","size","text","layer"],
    polygon:["kind","points","outline","layer","cutout"]};
  KIND_FIELDS.graphic=KIND_FIELDS.track;
  // Arrays and objects (points, pinNets, pad stacks) enter a print as a hash of their content,
  // never by reference: some tools change a track's points in place.
  function contentWord(v){
    let a=2166136261,b=5381;
    // Point lists ([[x, y], ...], the common case) inline; anything else walks generically.
    if(Array.isArray(v)&&v.length&&Array.isArray(v[0])&&v[0].length===2){
      let i=0;
      for(;i<v.length;i++){
        const q=v[i];if(!Array.isArray(q)||q.length!==2)break;
        F64[0]=q[0];a=Math.imul(a^U32[0],16777619);b=(Math.imul(b,33)^U32[1])|0;
        F64[0]=q[1];a=Math.imul(a^U32[1],16777619);b=(Math.imul(b,33)^U32[0])|0;
      }
      if(i===v.length)return (a>>>0)*2097152+(((b>>>0)^v.length)&2097151);
      a=2166136261;b=5381;
    }
    const mix=x=>{a=Math.imul(a^x,16777619);b=(Math.imul(b,33)^x)|0;};
    const walk=v=>{
      if(typeof v==="number"){F64[0]=v;mix(U32[0]);mix(U32[1]);}
      else if(typeof v==="string"){mix(0x73000000|v.length);for(let i=0;i<v.length;i++)mix(v.charCodeAt(i));}
      else if(Array.isArray(v)){mix(0x5b5b5b5b^v.length);for(let i=0;i<v.length;i++)walk(v[i]);}
      else if(v!==null&&typeof v==="object"){mix(0x7b7b7b7b);for(const k in v){walk(k);walk(v[k]);}}
      else mix(v===true?1:v===false?2:v===null?3:4);
    };
    walk(v);
    return (a>>>0)*2097152+((b>>>0)&2097151);
  }
  function printOf(i,defs){
    const f=KIND_FIELDS[i.kind]||PRINT_FIELDS,v=new Array(f.length),t=new Uint8Array(f.length);
    const refs=new Array(f.length);
    for(let k=0;k<f.length;k++){const x=i[f[k]];refs[k]=x;if(x!==null&&typeof x==="object"){t[k]=1;v[k]=contentWord(x);}else v[k]=x;}
    return {o:i,refs,f,v,t,fp:fpPrint(defs,i)};
  }
  // The quick pass: the same object with the same field references (no content compared).
  function sameRefs(p,i){
    if(p.o!==i)return false;const f=p.f,r=p.refs;
    if(f!==(KIND_FIELDS[i.kind]||PRINT_FIELDS))return false;
    for(let k=0;k<f.length;k++)if(r[k]!==i[f[k]])return false;
    return true;
  }
  function unchanged(p,i,defs){
    const f=p.f,v=p.v,t=p.t;
    if(f!==(KIND_FIELDS[i.kind]||PRINT_FIELDS))return false;
    for(let k=0;k<f.length;k++){
      const x=i[f[k]];
      if(t[k]){if(x===null||typeof x!=="object"||contentWord(x)!==v[k])return false;}
      else if(x!==v[k]&&!(x!==x&&v[k]!==v[k]))return false;
    }
    return p.fp===fpPrint(defs,i);
  }
  // Pour items (non-cutout polygons) are not keyed: their settings are part of the global key.
  const keyedItem=i=>i.kind!=="netlabel"&&!(i.kind==="polygon"&&!i.cutout);
  // Everything a tile session depends on besides the keyed items.
  function globalKey(doc,defs,options){
    const h=fastHasher(),rules=pourRules(doc,options),connectRules=hasConnectRules(rules);
    let smart=false;
    for(const p of polygons(doc)){const {outline,...s}=settings(p);h.value(p.id);h.value(s);h.value(outline);smart||=variableConnections(s,connectRules);}
    h.value(doc.outline||null);
    {const ch=(()=>{try{return globalThis.AtriumBoardShape?.holes?.(doc)||null;}catch{return null;}})();if(ch?.length)h.value(ch);}
    h.value(rules);
    if(smart)h.value(doc.stackup||null);
    return h.hex();
  }
  // Build every session from scratch (keyed full prepare in idle slices, then one init).
  function* tileBuildSteps(doc,defs,options){
    // Prints first: an item edited while the sessions build differs from its print, so the next
    // diff sends it again.
    const prints=new Map();let scanned=0;
    for(const i of doc.items||[]){
      if(keyedItem(i))prints.set(i.id,printOf(i,defs));
      if(options.slices&&++scanned%DIFF_CHUNK===0)yield;
    }
    const list=polygons(doc),specs=[],ord=[],earlier=[],connectRules=hasConnectRules(pourRules(doc,options));
    const variable=list.some(p=>variableConnections(settings(p),connectRules));
    const connect=list.length?connectContext(doc,defs,options):null;
    // Remove Necks and Outlines Only are not local (a tile cannot tell a neck): pours on a layer with
    // such a pour are left to the exact repour, and so are the pours after them there.
    const whole=new Set(list.filter(p=>{const s=settings(p);return s.fillMode==="outline"||s.fillMode==="solid"&&s.neckWidth>=NECK_MIN;}).map(p=>p.layer));
    for(const p of list){
      if(whole.has(p.layer))continue;
      const job=yield* prepareSteps(doc,defs,p,{...options,connect,keyed:true,arcs:false,poured:[],earlier:earlier.slice(),slices:options.slices});
      earlier.push({id:p.id,net:p.net||"",layer:p.layer});
      if(!job.task)continue;
      const before=specs.filter(x=>job.earlier.some(e=>e.id===x.id)).map(x=>x.TS/x.S);
      specs.push(tileSpec(job,Math.max(0,...before)));ord.push(p.id);
      if(options.slices)yield;
    }
    return {specs,ord,prints,variable,connect,byPolygon:new Map(list.map(p=>[p.id,p]))};
  }
  // The items that changed since the sessions were last told, and the diff for each session.
  function tileDiff(doc,defs,st,options,only,itemsById){const g=tileDiffSteps(doc,defs,st,options,only,false,itemsById);let r=g.next();while(!r.done)r=g.next();return r.value;}
  // tileDiff in steps: yields every DIFF_CHUNK items of the scan (live pours run it in short tasks).
  const DIFF_CHUNK=3000;
  // The old and new role of a component can affect pads anywhere on one of its nets.
  const partRoleFields=["def","ref","value","pinNets"].map(k=>KIND_FIELDS.part.indexOf(k));
  function partRoleChanged(a,b){
    if(a?.f!==KIND_FIELDS.part&&b?.f!==KIND_FIELDS.part)return false;
    return a?.f!==b?.f||a.fp!==b.fp||partRoleFields.some(k=>a.v[k]!==b.v[k]);
  }
  // quick: skip objects whose field references are all unchanged (an edit replaces values; an
  // in-place change inside an array is left to the next full pass).
  function* tileDiffSteps(doc,defs,st,options,only,quick,itemsById){
    const changed=[],removed=[];
    let relink=false;
    const update=(id,cur,old)=>{
      const next=cur&&printOf(cur,defs);
      if(st.variable&&partRoleChanged(old,next))relink=true;
      if(cur){changed.push(cur);st.prints.set(id,next);}
      else{removed.push(id);st.prints.delete(id);}
    };
    if(only){
      // A drag frame: the items by id from a map kept while the item list is the same.
      const items=doc.items||[];
      if(!itemsById){
        if(!st.byId||st.byId.items!==items||st.byId.n!==items.length){const m=new Map();for(const x of items)m.set(x.id,x);st.byId={items,n:items.length,m};}
        itemsById=st.byId.m;
      }
      for(const id of only){const cur=itemsById.get(id);
        const p=st.prints.get(id);
        if(!cur||cur.id!==id||!keyedItem(cur)){if(p)update(id,null,p);continue;}
        if(!p||!unchanged(p,cur,defs))update(id,cur,p);
      }
    }else{
      const seen=new Set();let tick=0;
      for(const i of doc.items||[]){
        if(++tick%DIFF_CHUNK===0)yield;
        if(!keyedItem(i))continue;seen.add(i.id);
        const p=st.prints.get(i.id);
        if(quick&&p&&sameRefs(p,i)&&(i.kind!=="part"||p.fp===fpPrint(defs,i)))continue;
        if(!p||!unchanged(p,i,defs))update(i.id,i,p);
      }
      if(seen.size!==st.prints.size)for(const [id,p] of st.prints)if(!seen.has(id))update(id,null,p);
    }
    if(relink)return null;
    if(!changed.length&&!removed.length)return {diffs:[],changed,removed};
    const remove=[...changed.map(i=>i.id),...removed],diffs=[];
    const byId=options.tileEdit?.byPolygon||new Map((doc.items||[]).filter(i=>i.kind==="polygon").map(i=>[i.id,i]));
    // The connect context of this revision (a drag sends many diffs within one revision).
    const rev=live.host?.revision?.();
    const baseConnect=options.tileEdit?.baseConnect;
    if(changed.length&&!baseConnect&&!(st.connect&&st.connect.doc===doc&&st.connect.rev===rev&&rev!=null&&st.connect.defs===defs))st.connect={doc,rev,defs,cx:connectContext(doc,defs,options)};
    const connect=changed.length?(baseConnect||st.connect.cx):null;
    for(const spec of st.specs){
      const p=byId.get(spec.id);if(!p)return null;
      const job=changed.length?prepare(doc,defs,p,{...options,connect,keyed:true,arcs:false,poured:[],items:changed,noGlobals:true,frame:{S:spec.S,ox:spec.ox,oy:spec.oy,extent:LIMIT/spec.S}}):{task:null};
      if(job.frameOverflow)return null;
      diffs.push({id:spec.id,remove,pack:packJob(job)});
    }
    return {diffs,changed,removed};
  }
  // ---- display patches
  // patch: {id, grid, tiles: Map(t -> Float64Array rings), shown: Set(t), path, region, alpha}
  function patchRegion(pt){
    const g=pt.grid,cell=t=>{const c=t%g.cols,r=(t-c)/g.cols;return [(g.gx0+c*g.TS)/g.S+g.ox,(g.gy0+r*g.TS)/g.S+g.oy,(g.gx0+(c+1)*g.TS)/g.S+g.ox,(g.gy0+(r+1)*g.TS)/g.S+g.oy];};
    const b=[Infinity,Infinity,-Infinity,-Infinity];
    // Clip rectangles: runs of shown tiles along each row (fewer, larger rectangles).
    const rows=new Map();for(const t of pt.shown){const c=t%g.cols,r=(t-c)/g.cols;(rows.get(r)||rows.set(r,[]).get(r)).push(c);}
    const rects=[];
    for(const [r,cs] of rows){cs.sort((a,b)=>a-b);for(let i=0;i<cs.length;){let j=i;while(j+1<cs.length&&cs[j+1]===cs[j]+1)j++;const a=cell(r*g.cols+cs[i]),z=cell(r*g.cols+cs[j]);rects.push([a[0],a[1],z[2],z[3]]);i=j+1;}}
    for(const q of rects){b[0]=Math.min(b[0],q[0]);b[1]=Math.min(b[1],q[1]);b[2]=Math.max(b[2],q[2]);b[3]=Math.max(b[3],q[3]);}
    pt.rects=rects;
    let path=null;
    if(typeof Path2D==="function"){
      path=new Path2D();
      const near=new Set();
      for(const t of pt.shown){const c=t%g.cols,r=(t-c)/g.cols;for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){const cc=c+dc,rr=r+dr;if(cc>=0&&rr>=0&&cc<g.cols&&rr<g.rows)near.add(rr*g.cols+cc);}}
      for(const t of near)for(const f of pt.tiles.get(t)||[]){path.moveTo(f[0],f[1]);for(let i=2;i<f.length;i+=2)path.lineTo(f[i],f[i+1]);}
    }
    pt.path=path;
    pt.region={layer:g.layer,net:g.net,polygon:pt.id,bounds:[b[0]-1,b[1]-1,b[2]+1,b[3]+1],count:0,data:"",patch:pt};
  }
  function applyTileOut(out,doc,reveal,afterEditFrame){
    // Patches already on screen that show copper newer than the stored copper (an earlier edit's, not
    // yet committed): holding them back would show older copper.
    let shown=false;for(const pt of tiles.patches.values())if(pt.doc===doc&&pt.shown.size&&!pt.exact)shown=true;
    for(const [id,o] of Object.entries(out||{})){
      let pt=tiles.patches.get(id);
      if(!pt||pt.grid.TS!==o.grid.TS||pt.grid.S!==o.grid.S||pt.grid.cols!==o.grid.cols){pt={id,grid:o.grid,tiles:new Map(),shown:new Set(),alpha:1};tiles.patches.set(id,pt);}
      pt.doc=doc;pt.grid=o.grid;pt.exact=false;
      for(const x of o.tiles)pt.tiles.set(x.t,x.rings);
      for(const t of o.changed)pt.shown.add(t);
      patchRegion(pt);
    }
    tiles.version++;tiles.list=null;tiles.settle=null;
    if(reveal&&Object.keys(out||{}).length)fadePatches(out,doc,shown&&!tiles.hold,afterEditFrame);
  }
  function retainTileOut(st,out){
    const pending=st.unshown??=new Map();
    for(const [id,row] of Object.entries(out||{})){
      let group=pending.get(id);
      if(!group){group={grid:row.grid,changed:new Set(),tiles:new Map()};pending.set(id,group);}
      for(const t of row.changed)group.changed.add(t);
      for(const tile of row.tiles)group.tiles.set(tile.t,tile);
    }
  }
  function showTileOut(st,doc,reveal,afterEditFrame){
    if(!st.unshown?.size)return;
    const out=Object.fromEntries([...st.unshown].map(([id,r])=>[id,{grid:r.grid,changed:[...r.changed],tiles:[...r.tiles.values()]}]));
    st.unshown.clear();applyTileOut(out,doc,reveal,afterEditFrame);
  }
  // A short cross-fade from the old copper to the patch (motion.js; instant when motion is off). Every
  // fade frame repaints the whole board (the tile version is in its key), and a patch costs its clip of
  // the stored copper even at alpha 0. So when that is slow the patches are held back for one frame
  // instead: the next frame draws the stored copper alone (as cheap as a frame without patches), and
  // the one after shows the final copper (an undo: 41-50 ms of work in that frame in WebKit at fit,
  // against 51-68 with the patch drawn and 41-56 with the old fade; the fade then repainted the board
  // 8-10 times). Slow: motion reduced, the last whole board layer took over FADE_MAX_MS to draw (8 ms:
  // half a 60 Hz frame; the 25.6k-object test board takes 20-28 ms at fit in WebKit, 5-7 in Chrome), or
  // the stored copper is over DRAG_DRAW_MAX vertices (the drag-drawing limit). When patches were
  // already shown (`shown`), they snap in: hiding them for a frame would flash older copper.
  const FADE_MAX_MS=8;
  function fadePatches(out,doc,shown,afterEditFrame){
    const M=globalThis.AtriumMotion;if(!M?.animate||M.level?.()==="off")return;
    tiles.fade?.cancel?.(true);
    if(M.level?.()!=="full"||(globalThis.AtriumCanvasFast?.lastBoardMs?.()||0)>FADE_MAX_MS||pourVertices(doc)>DRAG_DRAW_MAX){
      // A staged journal edit has already painted the geometry. Show its tile in the next
      // scheduled redraw, including a frame that was queued before the worker's reply.
      if(!shown&&!afterEditFrame)holdPatches();
      return;
    }
    const ps=[];for(const id in out){const pt=tiles.patches.get(id);if(pt){pt.alpha=0;ps.push(pt);}}
    tiles.fade=M.animate({duration:"fast",ease:"decelerate",step:a=>{for(const pt of ps)pt.alpha=a;tiles.version++;live.host?.redraw?.();},done:()=>{for(const pt of tiles.patches.values())pt.alpha=1;}});
  }
  // Patches are held back until the next animation frame. Frame callbacks run in the order asked: a
  // board frame already requested (the edit's or the undo's own) draws first without them and this one
  // asks for the next; when none was requested, the caller's redraw comes after this, so that frame
  // draws the patches and no frame is spent. A page that draws no frames releases them after 150 ms.
  function holdPatches(){
    if(tiles.hold)return;
    tiles.hold=true;tiles.version++;tiles.list=null;
    const go=()=>{if(!tiles.hold)return;tiles.hold=false;tiles.version++;tiles.list=null;live.host?.redraw?.();};
    const raf=globalThis.requestAnimationFrame;
    if(typeof raf==="function")raf(go);
    setTimeout(go,150);
  }
  function clearPatches(ids){
    let any=false;
    for(const id of ids||[...tiles.patches.keys()])if(tiles.patches.delete(id))any=true;
    if(any){tiles.version++;tiles.list=null;}
    return any;
  }
  // The pours the canvas paints: the stored regions plus a patch region per pour with tiles
  // shown. Stored regions of a patched pour are clipped out of its patch (pcb-pours.js paint).
  // What the canvas paints: displayTiles, through the Repour All progress display (pour-anim.js) when loaded.
  function displayPours(doc){const l=displayTiles(doc),A=globalThis.AtriumPourAnim;return A?.display?A.display(doc,l):l;}
  function displayTiles(doc){
    const pours=doc?.pcbDrawing?.pours;
    if(!tiles.patches.size||tiles.hold||!Array.isArray(pours)||!currentTilePreview(doc))return pours;
    if(tiles.list&&tiles.listKey===pours&&tiles.listVersion===tiles.version)return tiles.list;
    // A pour still showing another tool's fill (regions tagged source, e.g. "altium") keeps it
    // untouched until its exact repour replaces the whole pour: no tile copper next to it.
    const foreign=new Set();for(const r of pours)if(r.source!=null&&r.polygon!=null)foreign.add(r.polygon);
    const extra=[];
    for(const pt of tiles.patches.values())if(pt.doc===doc&&pt.region&&pt.shown.size&&!foreign.has(pt.id))extra.push(pt.region);
    if(!extra.length)return pours;
    const by=new Map(extra.map(r=>[r.polygon,r.patch]));
    for(const r of pours){const pt=r.polygon!=null&&by.get(r.polygon);if(pt)tiles.clipped.set(r,pt);else tiles.clipped.delete(r);}
    tiles.list=[...pours,...extra];tiles.listKey=pours;tiles.listVersion=tiles.version;
    return tiles.list;
  }
  function currentTilePreview(doc){
    const st=tiles.state;
    return !st?.mirror||st.doc===doc&&live.host?.doc?.()===doc&&st.previewRevision===live.host?.revision?.();
  }
  // pcb-pours.js paint hook: how to paint `region`, or null for a plain fill.
  function paintPatch(ctx,region,fill){
    const pt=region.patch||tiles.clipped.get(region);
    if(!pt||!pt.rects||tiles.hold||tiles.patches.get(pt.id)!==pt||!currentTilePreview(pt.doc))return false;
    const m=typeof ctx.getTransform==="function"?ctx.getTransform():null;
    // Snap the clip rectangles to device pixels, so a clip edge covers whole pixels.
    const axis=m&&Math.abs(m.b)<1e-12&&Math.abs(m.c)<1e-12;
    const sx=x=>axis?(Math.round(m.a*x+m.e)-m.e)/m.a:x,sy=y=>axis?(Math.round(m.d*y+m.f)-m.f)/m.d:y;
    const clip=new Path2D();
    if(!region.patch)clip.rect(-1e7,-1e7,2e7,2e7);
    for(const q of pt.rects){const x0=sx(q[0]),x1=sx(q[2]),y0=sy(q[1]),y1=sy(q[3]);clip.rect(Math.min(x0,x1),Math.min(y0,y1),Math.abs(x1-x0),Math.abs(y1-y0));}
    const a=ctx.globalAlpha;
    ctx.save();ctx.clip(clip,"evenodd");
    if(region.patch){if(pt.path){ctx.globalAlpha=a*pt.alpha;ctx.fill(pt.path,"evenodd");}}
    else fill();
    ctx.restore();
    // While the patch fades in, the old copper fades out inside it.
    if(!region.patch&&pt.alpha<1){
      const inside=new Path2D();for(const q of pt.rects){const x0=sx(q[0]),x1=sx(q[2]),y0=sy(q[1]),y1=sy(q[3]);inside.rect(Math.min(x0,x1),Math.min(y0,y1),Math.abs(x1-x0),Math.abs(y1-y0));}
      ctx.save();ctx.clip(inside);ctx.globalAlpha=a*(1-pt.alpha);fill();ctx.restore();
    }
    return true;
  }
  if(globalThis.AtriumPCBPours&&Object.isExtensible?.(globalThis.AtriumPCBPours)!==false)try{globalThis.AtriumPCBPours.paintHook=paintPatch;}catch{/* frozen */}
  function tileReset(){tiles.state=null;tiles.patches.clear();tiles.version++;tiles.list=null;tiles.busy=false;tiles.again=false;tiles.full=false;tiles.quick=false;tiles.only=null;tiles.recorded=null;tiles.building=null;tiles.warm=null;tiles.fullTimer=0;tiles.hold=false;tiles.settle=null;releaseAfterTiles();}
  // ---- the fast path: diff, tile worker, patch
  function tilePref(){
    if(tiles.pref)return tiles.pref;
    let v=null;try{v=(globalThis.AtriumPref||globalThis.AtriumPrefs)?.get?.("pcb.livePourDrag");}catch{v=null;}
    v=v==="drop"||v==="off"||v==="always"?v:"live";
    // Efficiency mode (power.js): pours repaint on the drop, not every drag frame (the same copper after it).
    try{if(v!=="off"&&globalThis.AtriumPower?.efficient?.())return "drop";}catch{/* no power module */}
    return v;
  }
  // Following a drag repaints the pours every frame. That costs about 5 ms a frame on the 25.6k
  // board (580k pour vertices), so "live" follows only while the stored copper is at most
  // DRAG_DRAW_MAX vertices (every real board measured); "always" follows regardless.
  const DRAG_DRAW_MAX=200000,vertexCount=new WeakMap();
  function pourVertices(doc){
    const pours=doc?.pcbDrawing?.pours;if(!Array.isArray(pours))return 0;
    let n=vertexCount.get(pours);
    if(n===undefined){n=0;for(const r of pours)n+=Math.max(0,((r.data?.length||0)*3/4-4*(r.count||1))/16);vertexCount.set(pours,n);}
    return n;
  }
  // Start (or restart) the sessions for the host's board.
  async function tileRebuild(){
    if(!editorVisible()||tiles.building)return;
    const H=live.host,doc=H?.doc?.();if(!doc||doc.kind!=="pcb"||doc.pcbDrawing?.sourceFill){tiles.state=null;return;}
    if(!polygons(doc).length||(doc.pcbDrawing?.pours||[]).some(r=>r.polygon==null)){tiles.state=null;return;}
    const defs=H.defs(),rev=H.revision(),options={project:H.project?.()};
    const J=journalOf(),at=(J?.recordedChanges?.(doc)??J?.changed?.(doc))?.seq,outer=J?.outer?.();
    const pours=doc.pcbDrawing?.pours,mirror=canMirrorBoard(doc,options.project),token={doc};
    const draft=H.drag?.()?.before;
    tiles.building=token;
    const ownsBuild=()=>tiles.building===token;
    const usable=()=>ownsBuild()&&live.host===H&&H.doc()===doc&&H.defs()===defs&&
      H.project?.()===options.project&&editorVisible()&&(!mirror||H.revision()===rev&&H.drag?.()?.before===draft);
    const abandon=()=>{if(ownsBuild()){tiles.building=null;if(live.host&&liveEnabled()&&!mirror)scheduleTileEdit(live.host);}};
    const g=tileBuildSteps(doc,defs,{...options,slices:true});
    let r;
    for(;;){
      const t=now();do r=g.next();while(!r.done&&now()-t<SLICE_MS);
      if(r.done)break;
      await new Promise(f=>slot(f));
      if(!usable()){abandon();return;}
    }
    const {specs,ord,prints,variable,connect,byPolygon}=r.value;
    const tr=[];for(const s of specs)tr.push(s.pack.data.buffer);
    const t0=now();
    try{
      await tileCall({op:"clear"});
      if(usable())await tileCall({op:"init",list:specs,order:ord,run:true,quiet:true},tr);
    }catch(e){
      if(ownsBuild()){tiles.building=null;tiles.state=null;}
      if(!/worker/.test(String(e?.message)))globalThis.console?.warn?.("tile repour",e);
      return;
    }
    if(!usable()){
      abandon();
      return;
    }
    tiles.building=null;tiles.quick=false;tiles.full=false;
    const evaluated=mirror?evaluatedPours(doc):null;
    const eligible=mirror&&specs.length>0&&!variable&&specs.every(s=>evaluated.has(s.id));
    tiles.state={doc,defs,project:options.project,gk:globalKey(doc,defs,options),specs:specs.map(s=>({...s,pack:null})),
      ord,prints,variable,baseConnect:connect,byPolygon,initMs:now()-t0,rev,at,outer,pours,mirror,eligible};
    // Legacy sessions reconcile edits made while they were built.
    if(!mirror&&H.revision()!==rev)scheduleTileEdit(H);
  }
  // Reuse a warm tile session solely for an ordinary committed geometry change.
  // The exact board mirror still owns connectivity, stored copper and outputs.
  const mirrorMoveFields={part:new Set(["x","y","angle"]),via:new Set(["x","y"]),track:new Set(["points"])};
  function onlyMirrorMove(before,after){
    const fields=mirrorMoveFields[before.kind];
    if(!fields||before.kind!==after.kind||before.kind==="track"&&
        (before.points?.length>64||after.points?.length>64))return false;
    const unchanged=row=>Object.keys(row).filter(k=>!fields.has(k)).sort().map(k=>[k,row[k]]);
    return JSON.stringify(unchanged(before))===JSON.stringify(unchanged(after));
  }
  function forgetTilePreview(){
    tiles.state=null;tiles.building=null;tiles.recorded=null;tiles.warm=null;
    if(clearPatches())live.host?.redraw?.();
  }
  function mirrorTileBoard(doc,project){
    if(tiles.off||globalThis.AtriumPower?.efficient?.()||!canMirrorBoard(doc,project))return false;
    const drawing=doc.pcbDrawing;
    return !!drawing?.pours?.length&&!drawing.pours.some(r=>r.source!=null)&&
      !globalThis.AtriumPourMarker.read(drawing)?.length&&!queryPending(doc,{project})&&
      !copperRuleScopes(doc,project).some(s=>!globalThis.AtriumRules?.kit?.allScope(s));
  }
  // Prepare once in idle time after an accepted fill of the visible board.
  function warmMirrorTiles(H){
    const doc=H.doc?.(),project=H.project?.(),rev=H.revision?.();
    if(tiles.state||tiles.building||tiles.warm||!mirrorTileBoard(doc,project)||!journalOf()?.recordedChanges)return;
    const ticket={doc};tiles.warm=ticket;
    idle(()=>{
      if(tiles.warm!==ticket)return;
      tiles.warm=null;
      if(tiles.state||tiles.building||tiles.busy||!liveEnabled()||tileDragging()||H!==live.host||
          H.doc?.()!==doc||H.project?.()!==project||H.revision?.()!==rev||!mirrorTileBoard(doc,project))return;
      const active=polygons(doc),evaluated=evaluatedPours(doc),connectRules=hasConnectRules(pourRules(doc,{project}));
      if(active.some(p=>!evaluated.has(p.id)||variableConnections(settings(p),connectRules)))return;
      tileRebuild();
    });
  }
  function scheduleMirrorTileEdit(H){
    if(!mirrorTileBoard(H.doc?.(),H.project?.())){forgetTilePreview();return;}
    const previous=tiles.state;
    if(previous?.mirror&&previous.previewRevision!=null){
      previous.previewRevision=null;tiles.version++;tiles.list=null;
    }
    const preview=current=>{
      if(!current()||H!==live.host||!liveEnabled())return;
      const doc=H.doc?.(),project=H.project?.(),st=tiles.state,J=journalOf();
      if(!st)return;
      if(st.doc!==doc||st.defs!==H.defs()||st.project!==project||
          st.pours!==doc.pcbDrawing?.pours||!mirrorTileBoard(doc,project)||st.outer!==J?.outer?.()){
        forgetTilePreview();
        return;
      }
      if(!st.eligible)return;
      const changes=J?.recordedChanges?.(doc,st.at,12);
      if(!changes?.ids||changes.ids.size>12||
          changes.ids.size&&!J?.onlyRecordedItemUpdates?.(doc,st.at,onlyMirrorMove)){
        forgetTilePreview();
        return;
      }
      tiles.recorded={st,changes,outer:st.outer,current,mirror:true};
      if(tiles.busy)tiles.again=true;else tileRun();
    };
    if(H.stageEdit)H.stageEdit("pours","live-pour-tiles",preview,{short:true});
    else preview(()=>true);
  }
  function scheduleTileEdit(H){
    const start=(current,deadline)=>{
      if(!current()||H!==live.host||!liveEnabled())return;
      const st=tiles.state,doc=H.doc?.(),J=journalOf();
      const locate=J?.recordedChanges||J?.changed,limit=deadline?12:8192;
      const changes=st?.doc===doc&&st.at!=null?locate?.(doc,st.at,limit):null,outer=J?.outer?.();
      if(deadline&&(!changes?.ids||changes.ids.size>limit||st.outer!==outer||deadline.timeRemaining()<1)){
        H.stageEdit("pours","live-pour-tiles",start);
        return;
      }
      if(changes?.ids&&st.outer===outer){
        st.byId=null;tiles.recorded={st,changes,outer,current};
        if(tiles.busy)tiles.again=true;else tileRun();
      }else{tiles.recorded=null;tileSchedule();}
    };
    if(H.stageEdit)H.stageEdit("pours","live-pour-tiles",start,{short:true});else start(()=>true);
  }
  // tileSchedule() diffs every item; tileSchedule(ids) only those (a drag frame). A full request wins.
  // tileSchedule() after an edit: a quick pass now (objects whose field references changed), then a
  // full content pass when idle (in-place changes). tileSchedule("full") only the full pass;
  // tileSchedule(ids) a drag frame's items.
  function tileSchedule(only){
    if(!only){tiles.quick=true;tiles.full=true;}
    else if(only==="full")tiles.full=true;
    else if(!tiles.quick){if(!tiles.only)tiles.only=new Set();for(const id of only)tiles.only.add(id);}
    if(tiles.busy){tiles.again=true;return;}
    tileRun();
  }
  // Diff the board against the sessions and show the tiles that changed.
  async function tileRun(){
    const H=live.host;if(!H||!liveEnabled())return;
    const doc=H.doc?.();if(!doc||doc.kind!=="pcb")return;
    const defs=H.defs(),options={project:H.project?.()};
    let st=tiles.state;
    const mirror=tiles.recorded?.st===st&&tiles.recorded?.mirror&&tiles.recorded.current();
    if(st&&(st.doc!==doc||!mirror&&st.gk!==globalKey(doc,defs,options))){st=tiles.state=null;clearPatches();}
    if(!st){if(!tiles.building)tileRebuild();if(live.deferred){live.deferred=false;schedule();}return;}
    if(tiles.recorded&&(tiles.recorded.st!==st||!tiles.recorded.current()))tiles.recorded=null;
    // Order: the quick pass, then a drag frame's items, then the full pass (idle).
    const quick=!!tiles.quick,record=!quick&&tiles.recorded?.st===st?tiles.recorded:null;
    const only=quick?null:record?.changes.ids||tiles.only,full=!quick&&!only&&tiles.full;
    const afterEditFrame=!!record&&!!H.stageEdit;
    if(quick)tiles.quick=false;else if(record)tiles.recorded=null;else if(only)tiles.only=null;else if(full)tiles.full=false;
    if(!quick&&!only&&!full){if(live.deferred){live.deferred=false;schedule();}return;}
    tiles.busy=true;tiles.syncRev=H.revision?.();
    // A staged edit's later phases (online rules, idle work) wait for this preview's frame, at most 250 ms:
    // a pours job stays pending (and checks again in the next task) until it is shown.
    if(afterEditFrame&&!tiles.holding){
      const until=now()+250,wait=current=>{if(current()&&(tiles.busy||tiles.painting)&&now()<until)H.stageEdit("pours","live-pour-frame",wait);else tiles.holding=false;};
      tiles.holding=true;H.stageEdit("pours","live-pour-frame",wait);
    }
    try{
      // The quick pass starts after the edit frame. Unknown changes are verified in idle slices.
      const t0=now();let d,tScan=0;
      if(only)d=tileDiff(doc,defs,st,record?.mirror?{...options,tileEdit:st}:options,only,record?.changes.items);
      else if(quick){const g=tileDiffSteps(doc,defs,st,options,null,true);let r=g.next();while(!r.done)r=g.next();d=r.value;tScan=now()-t0;}
      else{
        const g=tileDiffSteps(doc,defs,st,options,null,false);let r;
        for(;;){
          await new Promise(f=>idle(f));
          if(tiles.state!==st||H.doc?.()!==doc||!editorVisible())return;
          const t=now();do r=g.next();while(!r.done&&now()-t<DIFF_SLICE);tScan+=now()-t;
          if(r.done)break;
        }
        d=r.value;
        tiles.verified=(tiles.verified||0)+1;
        if(d&&d.diffs.length)tiles.corrections=(tiles.corrections||0)+1;
      }
      if(!d){tiles.state=null;clearPatches();tileRebuild();return;}
      if(full&&H.revision()===tiles.syncRev){const J=journalOf();st.at=(J?.recordedChanges?.(doc)??J?.changed?.(doc))?.seq;st.outer=J?.outer?.();}
      if(!d.diffs.length){
        if(record){st.at=record.changes.seq;st.outer=record.outer;}
        if(H.revision()!==tiles.syncRev||record&&!record.current())return;
        if(st.mirror&&tiles.patches.size&&st.previewRevision!==tiles.syncRev){
          st.previewRevision=tiles.syncRev;tiles.version++;tiles.list=null;H.redraw?.();
        }
        if(st.unshown?.size){
          if(st.mirror)st.previewRevision=tiles.syncRev;
          showTileOut(st,doc,true,afterEditFrame);H.redraw?.();
        }
        return;
      }
      const tDiff=only?now()-t0:tScan,tr=[];for(const x of d.diffs)tr.push(x.pack.data.buffer);
      const r=await tileCall({op:"update",diffs:d.diffs,order:st.ord,run:true},tr);
      if(tiles.state!==st)return;
      if(record){st.at=record.changes.seq;st.outer=record.outer;}
      if(H.doc?.()!==doc||H.revision()!==tiles.syncRev||record&&!record.current()||!liveEnabled()){retainTileOut(st,r.out);return;}
      const t1=now(),reveal=!only||!!record;
      if(st.mirror)st.previewRevision=tiles.syncRev;
      if(st.unshown?.size){retainTileOut(st,r.out);showTileOut(st,doc,reveal,afterEditFrame);}else applyTileOut(r.out,doc,reveal,afterEditFrame);
      H.redraw?.();
      if(!tiles.painting){tiles.painting=true;afterFrame(()=>{tiles.painting=false;if(!tiles.busy)releaseAfterTiles();});}
      tiles.last={t0,ms:now()-t0,diff:tDiff,reply:r.arrived!=null?r.arrived-t0:null,worker:r.stats?.ms,apply:now()-t1,tiles:r.stats?.tiles,items:d.changed.length+d.removed.length,drag:!!only,at:Date.now()};
      (tiles.history||(tiles.history=[])).push(tiles.last);if(tiles.history.length>200)tiles.history.shift();
    }catch(e){tiles.state=null;clearPatches();if(!/worker/.test(String(e?.message)))globalThis.console?.warn?.("tile repour",e);}
    finally{
      tiles.busy=false;
      const st=tiles.settle;if(st&&!tiles.again&&!tiles.quick&&!tiles.only&&!tiles.recorded){tiles.settle=null;tileSettled(st.doc,st.rev);}
      if(tiles.again||tiles.quick||tiles.only||tiles.recorded?.st===tiles.state){tiles.again=false;tileRun();}
      else{if(live.deferred){live.deferred=false;schedule();}if(tiles.full&&!tiles.fullTimer)tiles.fullTimer=idle(()=>{tiles.fullTimer=0;if(!tiles.busy)tileRun();});}
      if(!tiles.busy&&!tiles.painting)releaseAfterTiles();
    }
  }
  // Work that waits for the tile pass in flight and the frame that shows its patches (at most 250 ms:
  // a reply that never comes holds nothing back).
  function afterTiles(fn){let done=false;const once=()=>{if(!done){done=true;fn();}};(tiles.after||(tiles.after=[])).push(once);setTimeout(once,250);}
  function releaseAfterTiles(){const l=tiles.after;tiles.after=null;for(const f of l||[])setTimeout(f,0);}
  const afterFrame=fn=>globalThis.AtriumIdle?.afterFrame?AtriumIdle.afterFrame(fn):setTimeout(fn,0);
  // The stored copper is exact for this revision: the patches show the same copper, drop them.
  function tileSettled(doc,rev){
    const H=live.host;if(!H)return;
    if(H.doc?.()!==doc){
      // Saving can commit the exact copper after switching tabs.
      if(tiles.state?.doc===doc)forgetTilePreview();
      clearPatches([...tiles.patches].filter(([,pt])=>pt.doc===doc).map(([id])=>id));
      return;
    }
    // A drag moves items in place without a new revision: the patches show the dragged copper, the stored
    // copper does not. The drop's edit (or its "no change" frame) settles them.
    if(H.drag?.()?.before)return;
    // Patches kept (the commit itself moved the revision) show the stored copper: fadePatches may hide them.
    if(!tiles.busy&&!tiles.quick&&!tiles.only&&!tiles.recorded)for(const pt of tiles.patches.values())if(pt.doc===doc)pt.exact=true;
    if(H.revision?.()!==rev)return;
    // A tile pass still running (the commit's change listener starts one): drop them when it ends.
    if(tiles.busy||tiles.quick||tiles.only||tiles.recorded){tiles.settle={doc,rev};return;}
    tiles.settle=null;
    if(tiles.state?.doc===doc){
      tiles.state.pours=doc.pcbDrawing?.pours;
      tiles.state.unshown?.clear();
    }
    if(clearPatches())H.redraw?.();
  }
  // While a selection is dragged, the moved items are diffed every frame.
  function dragTick(){
    tiles.dragLoop=0;
    const H=live.host,dr=H?.drag?.();
    if(!H||!dr||!dr.before){
      tiles.dragging=false;
      if(canMirrorBoard(H?.doc?.(),H?.project?.())){
        // Cancel and a zero-distance drop have no authored change to supersede these tiles.
        if(tiles.dragRevision===H.revision?.())forgetTilePreview();
        schedule();
      }else tileSchedule();
      return;
    }
    if(!tiles.dragging)tiles.dragRevision=H.revision?.();
    tiles.dragging=true;
    const doc=H.doc?.(),pref=tilePref();
    if(dragVisible(doc)&&!tiles.busy)tileSchedule(H.selection?.()||[]);
    else if(!tiles.off&&!tiles.state&&!tiles.building&&doc&&
      (pref==="always"||pref==="live"&&pourVertices(doc)<=DRAG_DRAW_MAX)&&canMirrorBoard(doc,H.project?.()))tileRebuild();
    tiles.dragLoop=(globalThis.requestAnimationFrame||(f=>setTimeout(f,16)))(dragTick);
  }
  function dragWatch(){
    const H=live.host;if(!H||tiles.dragLoop||liveMode()!=="live")return;
    const dr=H.drag?.();if(dr&&dr.kind==="move")tiles.dragLoop=(globalThis.requestAnimationFrame||(f=>setTimeout(f,16)))(dragTick);
  }
  // Pours stay visible while dragging when the tiles follow the part (canvas.js asks).
  function dragVisible(doc){
    const p=tilePref();
    return !tiles.off&&liveMode()==="live"&&(p==="always"||p==="live"&&pourVertices(doc)<=DRAG_DRAW_MAX)&&!!tiles.state&&tiles.state.doc===doc;
  }
  globalThis.AtriumNavCommon?.ready?.(attachLive);

  // ----------------------------------------------------------- SVG preview
  function svgPath(regions){
    let d="";
    for(const r of regions)for(const ring of rings(r)){
      for(let i=0;i<ring.length;i+=2)d+=(i?"L":"M")+ring[i].toFixed(4)+" "+ring[i+1].toFixed(4);
      d+="Z";
    }
    return d;
  }

  // ---------------------------------------------------------------- dialog
  function el(tag,attrs={},...kids){
    const n=document.createElement(tag);
    for(const [k,v] of Object.entries(attrs)){
      if(v==null||v===false)continue;
      if(k==="text")n.textContent=v;else if(k==="class")n.className=v;else if(k.startsWith("on"))n[k]=v;
      else if(k in n&&k!=="list")n[k]=v;else n.setAttribute(k,v===true?"":v);
    }
    for(const kid of kids)if(kid!=null)n.append(kid);
    return n;
  }
  function copperLayers(doc,defs){
    const names=new Set(["Top","Bottom"]);
    const take=i=>{for(const l of [i?.layer,i?.fromLayer,i?.toLayer])if(COPPER.test(l||""))names.add(l);};
    for(const i of doc.items||[]){take(i);if(i.kind==="part"){const fp=defs?.get?.(i.def)?.footprint;fp?.pads?.forEach(take);fp?.shapes?.forEach(take);}}
    const {index}=appearance();
    return [...names].sort((a,b)=>index(a)-index(b));
  }
  function netNames(doc,defs){
    const names=new Set();
    for(const i of doc.items||[]){
      if(i.net)names.add(i.net);
      for(const n of Object.values(i.pinNets||{}))if(n)names.add(n);
    }
    return [...names].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  }
  // The net a new pour connects to when none is given: a ground net when the board has one
  // (GND first, then other grounds), otherwise the net with the most pads. "" when no pad has a net.
  function defaultNet(doc,defs){
    const pads=new Map();
    for(const i of doc.items||[]){
      if(i.kind!=="part")continue;
      const fp=defs?.get?.(i.def)?.footprint;
      for(const p of fp?.pads||[]){const n=own(i.pinNets||{},p.number)?i.pinNets[p.number]:p.net||"";if(n)pads.set(n,(pads.get(n)||0)+1);}
    }
    for(const i of doc.items||[])if(i.net&&!pads.has(i.net))pads.set(i.net,0);
    const names=[...pads.keys()],up=n=>n.toUpperCase();
    const ground=names.find(n=>up(n)==="GND")||names.find(n=>/^(DGND|PGND|GND\w*|VSS|GROUND|0V)$/.test(up(n)))||names.find(n=>/GND/.test(up(n)));
    if(ground)return ground;
    let best="",most=0;for(const [n,c] of pads)if(c>most){best=n;most=c;}
    return best;
  }
  // open(ctx): ctx = {doc, defs, polygon?|outline?, edit(fn), info?(text),
  //   unit?:"mm"|"mil", select?(id)}. With `polygon` it edits that item;
  // with `outline` (from a Place » Polygon Pour tool) it creates one.
  function open(ctx){
    const {doc,defs}=ctx,A=globalThis.Atrium,unit=ctx.unit==="mil"?"mil":"mm";
    const existing=ctx.polygon||null;
    // A new pour starts on ground (or the busiest net) rather than No Net; the dialog says so.
    const autoNet=!existing&&!ctx.net?defaultNet(doc,defs):"";
    const base=existing?{...existing}:make(ctx.outline||[],{layer:ctx.layer&&COPPER.test(ctx.layer)?ctx.layer:"Top",net:ctx.net||autoNet,pourIndex:polygons(doc).length});
    const S=settings(base);
    const fmt=v=>A?.units?A.units.value(v,unit):+(+v).toFixed(4);
    const parse=t=>A?.units?A.units.parse(t,unit):Number(t);
    const fields=new Map();
    const length=(key,label,opts={})=>{
      const input=el("input",{class:"ui-field ui-field-number",type:"text",inputMode:"decimal",value:opts.blank&&S[key]==null?"":fmt(S[key]??0),placeholder:opts.placeholder||"","aria-label":label,"aria-description":unit});
      fields.set(key,{input,kind:"length",label,blank:opts.blank});
      return el("label",{class:"pp-field"},el("span",{text:label}),el("span",{class:"pp-input ui-field-measure"},input,el("small",{class:"ui-field-unit",text:unit})));
    };
    const number=(key,label,suffix)=>{
      const input=el("input",{class:"ui-field ui-field-number",type:"text",inputMode:"decimal",value:String(+(+S[key]).toFixed(6)),"aria-label":label,"aria-description":suffix});
      fields.set(key,{input,kind:"number",label});
      return el("label",{class:"pp-field"},el("span",{text:label}),el("span",{class:"pp-input ui-field-measure"},input,el("small",{class:"ui-field-unit",text:suffix})));
    };
    const choice=(key,label,options)=>{
      const select=el("select",{class:"ui-field","aria-label":label});
      for(const [v,t] of options)select.add(new Option(t,String(v)));
      select.value=String(S[key]);fields.set(key,{input:select,kind:"choice",label,options});
      return el("label",{class:"pp-field"},el("span",{text:label}),select);
    };
    const check=(key,label)=>{
      const input=el("input",{class:"ui-checkbox",type:"checkbox",checked:!!S[key]});fields.set(key,{input,kind:"bool",label});
      return el("label",{class:"pp-check"},input,el("span",{text:label}));
    };
    const nets=netNames(doc,defs);if(S.net&&!nets.includes(S.net))nets.unshift(S.net);
    const name=el("input",{class:"ui-field",type:"text",value:S.name||"","aria-label":"Name",placeholder:"Polygon"});
    const preview=el("div",{class:"pp-preview","aria-label":"Pour preview"});
    const status=el("p",{class:"pp-status",role:"status"});
    // Per-pad decisions grouped by style, with the reason and an override.
    let overrides={...S.connectOverrides};
    const connectView=el("details",{class:"pp-connect",open:true});
    const STYLE_NAMES={direct:"Direct connect",relief:"Relief connect",none:"No connect"};
    function showConnections(list){
      const counts={direct:0,relief:0,none:0};for(const d of list)counts[d.style]++;
      const summary=el("summary",{text:"Pad connections · "+counts.direct+" direct · "+counts.relief+" relief"+(counts.none?" · "+counts.none+" no connect":"")+(Object.keys(overrides).length?" · "+Object.keys(overrides).length+" overridden":"")});
      connectView.replaceChildren(summary);
      if(!list.length){connectView.append(el("p",{class:"pp-note",text:S.net||fields.get("net").input.value?"No pads or vias of this net on the polygon layer.":"Choose a net to connect pads."}));return;}
      const table=el("table",{class:"pp-table"}),head=el("tr");
      for(const h of ["Pad","Kind","Why","Spokes","Override"])head.append(el("th",{text:h}));
      const tbody=el("tbody");table.append(el("thead",{},head),tbody);
      let shown=0;
      for(const style of ["direct","relief","none"]){
        const group=list.filter(d=>d.style===style);if(!group.length)continue;
        tbody.append(el("tr",{class:"pp-group"},el("th",{colSpan:5,text:STYLE_NAMES[style]+" ("+group.length+")"})));
        for(const d of group){
          if(++shown>400)break;
          const sel=el("select",{"aria-label":"Override for "+d.label});
          for(const [v,t] of [["","Default"],["relief","Relief"],["direct","Direct"],["none","No connect"]])sel.add(new Option(t,v));
          sel.value=overrides[d.key]||"";
          sel.onchange=safe(()=>{if(sel.value)overrides[d.key]=sel.value;else delete overrides[d.key];run(read());});
          const why=el("td",{class:"pp-why"},el("span",{text:d.reason}));
          if(d.hint)why.append(el("small",{text:d.hint}));
          why.append(el("small",{class:"pp-source",text:{auto:"Auto",rule:"Rule",polygon:"Polygon",override:"Override"}[d.source]}));
          tbody.append(el("tr",{class:d.source==="override"?"is-override":""},el("td",{class:"pp-pad",text:d.label}),el("td",{text:{th:"TH pad",smd:"SMD pad",via:"Via"}[d.kind]}),why,
            el("td",{class:"pp-num",text:d.style==="relief"?d.entries+" × "+fmt(d.spokeWidth)+" "+unit:"—"}),el("td",{},sel)));
        }
      }
      connectView.append(el("div",{class:"pp-table-wrap"},table));
      if(shown>400)connectView.append(el("p",{class:"pp-note",text:"Showing the first 400 pads."}));
    }
    const section=(title,...rows)=>el("fieldset",{class:"pp-section"},el("legend",{text:title}),...rows);
    const hatchRadio=el("input",{type:"radio",name:"pp-fill",checked:S.fillMode==="hatched"}),outlineRadio=el("input",{type:"radio",name:"pp-fill",checked:S.fillMode==="outline"});
    const fill=el("div",{class:"pp-fill",role:"radiogroup","aria-label":"Fill mode"},
      el("label",{class:"pp-check"},el("input",{type:"radio",name:"pp-fill",checked:S.fillMode==="solid"}),el("span",{text:"Solid (Copper Regions)"})),
      el("label",{class:"pp-check"},hatchRadio,el("span",{text:"Hatched (Tracks/Arcs)"})),
      el("span",{class:"pp-hatch"},length("hatchWidth","Track Width"),length("hatchPitch","Grid Size"),choice("hatchAngle","Hatch Mode",[[45,"45 Degree"],[90,"90 Degree"],[0,"Horizontal"]])),
      el("label",{class:"pp-check"},outlineRadio,el("span",{text:"None (Outlines Only)"})));
    const dlg=el("dialog",{class:"ui-dialog work-dialog polygon-pour-dialog","aria-label":"Polygon Pour"},
      el("h2",{class:"ui-dialog-title",text:"Polygon Pour"}),
      fill,
      el("div",{class:"pp-body ui-dialog-body"},
        el("div",{class:"pp-left"},preview,
          section("Properties",
            el("label",{class:"pp-field"},el("span",{text:"Name"}),name),
            choice("layer","Layer",copperLayers(doc,defs).map(l=>[l,appearance()?.name?.(l)||l])),
            length("minPrimLength","Min Prim Length"),
            number("pourIndex","Pour Index",""))),
        el("div",{class:"pp-right"},
          section("Solid Fill",
            number("islandAreaThreshold","Remove Islands Less Than","sq. mm"),
            length("neckWidth","Remove Necks Less Than",{blank:true,placeholder:"Off"}),
            length("arcApproximation","Arc Approximation"),
            length("clearance","Clearance",{blank:true,placeholder:"Rules"}),
            length("boardClearance","Board Edge Clearance")),
          section("Net Options",
            choice("net","Connect to Net",[["","No Net"],...nets.map(n=>[n,n])]),
            choice("pourOverSameNet","Pour Over",[["true","All Same Net Objects"],["false","Don't Pour Over Same Net"]]),
            check("removeDeadCopper","Remove Dead Copper")),
          section("Polygon Connect Style",
            choice("connectStyle","Pad Connection",[["auto","Auto (smart)"],["relief","Relief Connect"],["direct","Direct Connect"],["none","No Connect"]]),
            choice("viaConnectStyle","Via Connection",[["auto","Auto (smart)"],["direct","Direct Connect"],["relief","Relief Connect"],["none","No Connect"]]),
            choice("reliefEntries","Conductors",[[2,"2"],[4,"4"]]),
            length("reliefConductorWidth","Conductor Width"),
            length("reliefAirGap","Air Gap"),
            choice("reliefAngle","Angle",[[90,"90 Angle"],[45,"45 Angle"]])))),
      connectView,status);
    fields.get("pourOverSameNet").input.value=String(!!S.pourOverSameNet);
    function read(){
      const out={name:name.value.trim()};
      for(const [key,f] of fields){
        const raw=f.input.type==="checkbox"?f.input.checked:f.input.value;
        if(f.kind==="bool")out[key]=!!raw;
        else if(f.kind==="choice"){
          out[key]=key==="reliefEntries"||key==="reliefAngle"?+raw:key==="pourOverSameNet"?raw==="true":raw;
        }else{
          const t=String(raw).trim();
          if(!t&&f.blank){out[key]=null;continue;}
          const v=f.kind==="length"?parse(t):Number(t);
          if(!finite(v)||(key!=="pourIndex"&&v<0)||Math.abs(v)>1000)throw Error(f.label+" needs a value between 0 and 1000.");
          out[key]=v;
        }
      }
      if(out.reliefConductorWidth<=0&&out.connectStyle==="relief")throw Error("Conductor Width must be greater than zero.");
      if(out.arcApproximation<=0)throw Error("Arc Approximation must be greater than zero.");
      if(out.clearance===null)out.clearance=undefined;
      out.connectOverrides=Object.keys(overrides).length?{...overrides}:undefined;
      out.fillMode=hatchRadio.checked?"hatched":outlineRadio.checked?"outline":"solid";out.hatchAngle=+out.hatchAngle;
      if(out.neckWidth===null||out.neckWidth===0)out.neckWidth=undefined;else if(out.neckWidth>5)throw Error("Remove Necks Less Than needs a width up to 5 mm.");
      if(out.fillMode==="outline"&&!(out.hatchWidth>0))throw Error("Outlines Only needs a Track Width above zero.");
      if(out.fillMode==="hatched"&&!(out.hatchWidth>0&&out.hatchWidth<out.hatchPitch))throw Error("Hatch Track Width must be above zero and below the Grid Size.");
      return out;
    }
    function draft(values){
      const p={...base,...values};if(values.clearance===undefined)delete p.clearance;
      if(values.connectOverrides===undefined)delete p.connectOverrides;
      if(values.neckWidth===undefined)delete p.neckWidth;
      if(!values.name)delete p.name;
      return p;
    }
    function showPreview(regions,p,decisions=[]){
      const pts=outlineOf(p),board=doc.outline?.length>=3?doc.outline:[];
      const all=[...pts,...board];if(!all.length){preview.replaceChildren();return;}
      const b=boxOf(all.flatMap(q=>[+q[0],+q[1]])),pad=Math.max(b[2]-b[0],b[3]-b[1])*.04+.1;
      const ns="http://www.w3.org/2000/svg",svg=document.createElementNS(ns,"svg");
      svg.setAttribute("viewBox",[b[0]-pad,b[1]-pad,b[2]-b[0]+pad*2,b[3]-b[1]+pad*2].join(" "));
      svg.setAttribute("preserveAspectRatio","xMidYMid meet");
      const add=(d,cls,style)=>{const n=document.createElementNS(ns,"path");n.setAttribute("d",d);n.setAttribute("class",cls);if(style)n.setAttribute("style",style);svg.append(n);};
      const poly=q=>q.map((v,i)=>(i?"L":"M")+v[0]+" "+v[1]).join("")+"Z";
      if(board.length)add(poly(board),"pp-board");
      add(svgPath(regions),"pp-copper","color:"+(appearance()?.color?.(p.layer)||"currentColor"));
      if(pts.length>=3)add(poly(pts),"pp-outline");
      const r=Math.max(b[2]-b[0],b[3]-b[1])*.006+.05;
      for(const d of decisions){if(!d.at)continue;const c=document.createElementNS(ns,"circle");
        c.setAttribute("cx",String(d.at[0]));c.setAttribute("cy",String(d.at[1]));c.setAttribute("r",String(r));c.setAttribute("class","pp-mark pp-"+d.style);svg.append(c);}
      preview.replaceChildren(svg);
    }
    function run(values){
      const p=draft(values),stats={};
      const earlier=(doc.pcbDrawing?.pours||[]).filter(r=>{
        if(r.polygon==null||r.polygon===p.id)return false;
        const other=(doc.items||[]).find(i=>i.id===r.polygon);
        return other&&settings(other).pourIndex<settings(p).pourIndex;
      });
      const regions=pour(doc,defs,p,{...(ctx.options||{}),poured:earlier,stats});
      showPreview(regions,p,stats.connections||[]);showConnections(stats.connections||[]);
      status.textContent=regions.length+" region"+(regions.length===1?"":"s")+" · "+(stats.deadIslands||0)+" dead island"+(stats.deadIslands===1?"":"s")+" removed · "+Math.round(stats.ms||0)+" ms";
      if(stats.warning){status.textContent+=" · Warning: "+stats.warning;status.dataset.kind="warning";}else delete status.dataset.kind;
      return regions;
    }
    const safe=fn=>()=>{try{fn();}catch(e){status.textContent=e.message||String(e);}};
    const button=(text,fn,variant)=>{const b=el("button",{class:"ui-button",type:"button",text});if(variant)b.dataset.variant=variant;b.onclick=safe(fn);return b;};
    dlg.append(el("div",{class:"work-actions ui-dialog-actions"},
      button("Preview",()=>run(read())),
      button("Cancel",()=>dlg.close()),
      button("OK",()=>{
        const values=read();
        if(outlineOf(base).length<3)throw Error("The polygon outline needs at least three vertices.");
        let result;
        ctx.edit(()=>{
          let item=existing&&(doc.items||[]).find(i=>i.id===existing.id);
          if(!item){item=base;doc.items.push(item);}
          for(const [k,v] of Object.entries(values)){if(v===undefined||(k==="name"&&!v))delete item[k];else item[k]=v;}
          validate(item);
          // Pour on OK in the same undo step: this polygon and every pour it
          // affects (a new pour fills at once; Altium pours on OK).
          result=apply(doc,defs,{...(ctx.options||{}),only:affected(doc,[item.id],defs)});
        });
        const n=result?.regions?.length||0;
        const warn=Object.values(result?.stats?.polygons||{}).map(x=>x.warning).filter(Boolean);
        ctx.info?.("Polygon poured · "+n+" region"+(n===1?"":"s")+" · "+Math.round(result?.stats?.ms||0)+" ms"+(warn.length?" · Warning: "+warn.join(" "):""));
        dlg.close();
      },"primary")));
    dlg.addEventListener("close",()=>dlg.remove(),{once:true});
    document.body.append(dlg);
    try{run(read());}catch(e){status.textContent=e.message||String(e);}
    globalThis.AtriumShell?.adoptDialog?.(dlg, {defaultAction:false}); dlg.showModal();
    return dlg;
  }

  // Place a new pour or edit the selected one. Repour All commits a single undo step.
  function command(action, {doc, defs, project, edit, info}, selected, layer) {
    if (action === "repour") return repour(doc, defs, {project}, edit, info);
    const base = {doc, defs, unit: project.units || "mm", edit, info, layer: layer || "Top", options: {project}};
    const draw = globalThis.AtriumPCBDraw;
    if (selected?.kind === "polygon" && !draw?.drawPour) { open({...base, polygon: selected}); return; }
    if (draw?.drawPour(base)) return;
    if (!doc.outline?.length) { info("Set the board perimeter first."); return; }
    open({...base, outline: doc.outline.map(p => [...p])});
  }

  return Object.freeze({DEFAULTS,command,make,validate,settings,outline:outlineOf,failures,refills,pour,repourAll,repourParallel,pourDependencies,repour,apply,stale,current,state,inspectCopper,ownerState,contactRegions,strip,place,affected,stateOf,displayState,verifying,queryPending,queryReady,outputCopper,settle,
    tiles:Object.freeze({engine:(core)=>PourTiles(core||CORE,offsetRing),spec:tileSpec,pack:packJob,build:(doc,defs,o={})=>{const g=tileBuildSteps(doc,defs,o);let r=g.next();while(!r.done)r=g.next();return r.value;},
      diff:tileDiff,message:tileMessage,displayPours,dragVisible,paint:paintPatch,rebuild:tileRebuild,schedule:tileSchedule,
      get version(){return tiles.version;},get corrections(){return tiles.corrections||0;},get state(){return tiles.state;},get last(){return tiles.last;},get history(){return tiles.history||[];},get patches(){return tiles.patches;},get busy(){return tiles.busy||!!tiles.building||!!tiles.quick||!!tiles.full;},get pending(){return tiles.busy||!!tiles.quick||!!tiles.only;},
      setPref(v){tiles.pref=v==="drop"||v==="off"||v==="always"?v:"live";if(tiles.pref!=="always")try{globalThis.AtriumPrefs?.set?.("pcb.livePourDrag",tiles.pref);}catch{/* not stored */}return tiles.pref;},
      useWorker(v){tiles.useWorker=v;},enable(v){tiles.off=!v;if(!v){live.deferred=false;forgetTilePreview();}},reset:tileReset}),
    displayPours,noteView,poolSize(n){POOL_SIZE.n=Math.max(0,Math.floor(+n||0));return POOL_SIZE.n||POOL_WORKERS;},
    live:Object.freeze({attach:attachLive,prepare:prepareLiveCopper,mode:liveMode,setMode:setLiveMode,schedule,run,get running(){return live.running;},get busy(){return !!(live.timer||live.running||live.deferred);},get last(){return live.last;},usePool(v){if(v!=null)LIVE.pool=!!v;return LIVE.pool;},
      useWorker(v){live.remoteEnabled=!!v;if(!v)live.client?.close();},pendingSave,
      reset(){known.clear();stateMemo=null;ruleLoadFailures.clear();sourcePreparation=new WeakMap();live.offPower?.();live.client?.close();live.client=null;live.remoteDisabled=false;live.saving=null;live.folderWait?.off?.();live.folderWait=null;live.withheld=null;live.offPower=null;live.host=null;live.running=null;live.failed=null;live.last=null;live.cache=null;live.mode=null;live.deferred=false;tileReset();}}),
    // Exact reuse of unchanged pours (Repour All, live and parallel repours): stats, on/off, clear; journal(j) for tests.
    reuse:Object.freeze({get stats(){return {...REUSE.stats,entries:[...reuseEntries()].length};},get last(){return REUSE.last||null;},enable(v){REUSE.on=!!v&&!!EntryRef;if(!REUSE.on)clearReuse();},clear:clearReuse,journal(j){REUSE.journal=j||null;},get on(){return REUSE.on;}}),
    // Speculative Repour All (energy-aware): mode, intent(kind, strong), run(), stats.
    speculation:Object.freeze({mode:specMode,setMode(m){SPEC.mode=m==="off"||m==="always"||m==="auto"?m:null;if(specMode()==="off")specOnChange();return specMode();},
      intent,run:speculate,get running(){return SPEC.run;},get stats(){const p=[...reuseEntries()].filter(e=>e.spec).length;return {...SPEC.stats,intents:{...SPEC.stats.intents},pending:p};},
      reset(){specOnChange();SPEC.run=null;SPEC.stats={intents:{},started:0,completed:0,stopped:0,skippedPower:0,skippedFresh:0,poursSolved:0,used:0,wasted:0,cpuMs:0,usedMs:0,wastedMs:0};}}),
    connections,thermals,connectContext,ipcWidth,
    signature: (doc,defs,project,rules) => AtriumPCBPours.signature(doc,defs,project,false,rules),
    copperBases,adoptSourceCopper,adoptRuleTransition,needsScopeTrace,polygonSignatureSteps,polygonSignatures,rings,encode,protectStoredLands,svgPath,fromAltium,polygons,adopt,adoptAsync,pendingPlanes,linkStored,repourOne,
    boolean:booleanMm,union,difference,intersection,open,defaultNet,
    mainSolve,_internal:{forwardMarkPrerequisites,MAIN,interacting,liveWorkerSteps,scopedWorkerSnapshot,itemBox,pool:solvePool,discTemplate,morphOf,rounded,overlayInt,pointInRing,area2,core:CORE,prepare,prepareSteps,finish,finishSteps,PourCore,PourTiles,offsetRing,jobWords,clipRing,stage2Steps,finalize,solveStages,CLIP_MM}});
})();
