"use strict";
if (!globalThis.AtriumResolvedLand && typeof require === "function") require("../pcb/pcb-appearance.js");
if (!globalThis.AtriumGeometryCurves && typeof require === "function") require("../pcb/resolved-geometry-curves.js");

globalThis.AtriumConnectivity = (() => {
  const A=Atrium, EPS=1e-6; // one nanometre, in model millimetres
  const cmp=(a,b)=>a<b?-1:a>b?1:0;
  const sub=(a,b)=>[a[0]-b[0],a[1]-b[1]];
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1];
  const cross=(a,b)=>a[0]*b[1]-a[1]*b[0];
  const dist2=(a,b)=>(a[0]-b[0])**2+(a[1]-b[1])**2;
  const compareKey=(a,b)=>cmp(a.key,b.key);
  function sets(n){
    const parent=Array.from({length:n},(_,i)=>i),sizes=parent.map(()=>1);
    function root(i){while(i!==parent[i]){parent[i]=parent[parent[i]];i=parent[i];}return i;}
    function join(i,j){i=root(i);j=root(j);if(i===j)return false;if(sizes[i]<sizes[j])[i,j]=[j,i];parent[j]=i;sizes[i]+=sizes[j];return true;}
    return {root,join};
  }
  /** @returns {[number, number] | null} */
  function copperSpan(i,parent,layer=globalThis.AtriumPCBAppearance.padLayer(parent,i)){
    const PCB=globalThis.AtriumPCBAppearance;
    if(i.kind==="via"){
      if(!i.fromLayer&&!i.toLayer)return PCB.copperSpan(null);
      if(i.fromLayer!==i.toLayer)return PCB.copperSpan(i);
      layer=i.fromLayer; // Same-endpoint vias retain their single contact plane.
    }
    if(layer==="Multi")return i.kind==="pad"&&i.drill>0&&i.plated!==false?PCB.copperSpan(null):null;
    const n=PCB.index(layer);return n<0?null:[n,n];
  }
  function support(shape,d) {
    const len=Math.hypot(...d)||1;
    if(shape.ellipse){
      const {a,b,c,s}=shape.ellipse,dx=c*d[0]+s*d[1],dy=-s*d[0]+c*d[1],den=Math.hypot(a*dx,b*dy)||1;
      const x=a*a*dx/den,y=b*b*dy/den;
      return [shape.center[0]+c*x-s*y,shape.center[1]+s*x+c*y];
    }
    let best=shape.core[0],score=dot(best,d);
    for(let i=1;i<shape.core.length;i++){const next=dot(shape.core[i],d);if(next>score){best=shape.core[i];score=next;}}
    return [best[0]+shape.radius*d[0]/len,best[1]+shape.radius*d[1]/len];
  }
  function edgeClosest(a,b){
    const delta=sub(b,a),den=dot(delta,delta),u=den?-dot(a,delta)/den:0;
    if(u<=0)return {p:a,points:[a]};if(u>=1)return {p:b,points:[b]};
    return {p:[a[0]+delta[0]*u,a[1]+delta[1]*u],points:[a,b]};
  }
  function closest(points){
    if(points.length===2)return edgeClosest(points[0],points[1]);
    const [a,b,c]=points,ab=cross(a,b),bc=cross(b,c),ca=cross(c,a);
    if(cross(sub(b,a),sub(c,a))!==0 && ((ab>=0&&bc>=0&&ca>=0)||(ab<=0&&bc<=0&&ca<=0)))return {p:[0,0],points};
    const options=[edgeClosest(a,b),edgeClosest(b,c),edgeClosest(c,a)];
    return options.reduce((best,x)=>dot(x.p,x.p)<dot(best.p,best.p)?x:best);
  }
  // Support points in the Minkowski difference handle circles, true ellipses,
  // capsules, rotated polygons and the canvas's rounded rectangle radius.
  function outerContact(a,b){
    const difference=d=>sub(support(a,d),support(b,[-d[0],-d[1]]));
    const p=difference([1,0]);let current={p,points:[p]};
    for(let loop=0;loop<80;loop++){
      const v=current.p,length=Math.hypot(...v);if(length<=EPS)return true;
      const w=difference([-v[0]/length,-v[1]/length]);
      if(dot(v,w)/length>EPS)return false; // Separating support plane.
      if(current.points.some(q=>dist2(q,w)<1e-22))return length<=EPS;
      current=closest([...current.points,w]);
    }
    return Math.hypot(...current.p)<=EPS;
  }
  // Exact maximum radial extent for a rotated ellipse relative to a hole.
  // In the reflected first quadrant the stationary condition is monotonic.
  function farthest(shape,center){
    if(!shape.ellipse){
      let maximum=0;for(const p of shape.core)maximum=Math.max(maximum,dist2(p,center));
      return Math.sqrt(maximum)+shape.radius;
    }
    const {a,b,c,s}=shape.ellipse,[dx,dy]=sub(shape.center,center);
    const x=Math.abs(c*dx+s*dy),y=Math.abs(-s*dx+c*dy);
    let lo=0,hi=Math.PI/2;
    for(let i=0;i<52;i++){const t=(lo+hi)/2,si=Math.sin(t),co=Math.cos(t);
      if(b*y*co-a*x*si+(b*b-a*a)*co*si>0)lo=t;else hi=t;}
    const t=(lo+hi)/2;return Math.max(Math.hypot(x+a,y), Math.hypot(x,y+b), Math.hypot(x+a*Math.cos(t),y+b*Math.sin(t)));
  }
  function contact(a,b){
    if(a.pieces||b.pieces){
      for(const p of a.pieces||[a])for(const q of b.pieces||[b]){
        if(p.box&&q.box&&(p.box[0]>q.box[2]+EPS||q.box[0]>p.box[2]+EPS||p.box[1]>q.box[3]+EPS||q.box[1]>p.box[3]+EPS))continue;
        if(contact(p,q))return true;
      }
      return false;
    }
    if(a.rim||b.rim){
      const [region,other]=a.rim?[a,b]:[b,a];
      if(region.rim.some(edge=>contact(edge,other)))return true;
      const point=other.rim?other.core[0]:support(other,[1,0]),inside=AtriumBoardShape.polyContains;
      return inside(region.core,point)&&!region.cutouts.some(loop=>inside(loop,point));
    }
    if(!outerContact(a,b))return false;
    if(a.hole&&farthest(b,a.center)<a.hole-EPS)return false;
    if(b.hole&&farthest(a,b.center)<b.hole-EPS)return false;
    return true;
  }
  // Convex pieces covering a simple polygon: itself when convex, else ear-clipped
  // triangles; null when the outline is not simple (rules.js has the same helper).
  function isConvex(pts){
    let pos=false,neg=false;
    for(let n=0;n<pts.length;n++){const o=cross(sub(pts[(n+1)%pts.length],pts[n]),sub(pts[(n+2)%pts.length],pts[n]));if(o>1e-12)pos=true;else if(o< -1e-12)neg=true;}
    return !(pos&&neg);
  }
  function fillPieces(points){
    let pts=points.filter((p,n)=>!n||dist2(p,points[n-1])>1e-18);
    if(pts.length>3&&dist2(pts[0],pts.at(-1))<=1e-18)pts=pts.slice(0,-1);
    if(pts.length<3)return null;
    const orient=(a,b,c)=>cross(sub(b,a),sub(c,a));
    let area=0,pos=false,neg=false;
    for(let n=0;n<pts.length;n++){const a=pts[n],b=pts[(n+1)%pts.length],c=pts[(n+2)%pts.length];area+=cross(a,b);const o=orient(a,b,c);if(o>1e-12)pos=true;else if(o< -1e-12)neg=true;}
    if(!(Math.abs(area)>1e-12))return null;
    if(!(pos&&neg))return [pts];
    const triangles=A.triangulateRing(pts,area,"complete");
    return triangles && A.mergeConvex(triangles,isConvex);
  }
  function padGeometry(p,parent,layer){
    const L=AtriumResolvedLand,land=L.geometry(p,layer);
    if(!land||land.holeOnly)return null;
    const {at:center,angle,mirror}=L.place(land,parent),hole=(p.drill||0)/2;
    if(land.shape==="ellipse")return {center,ellipse:{a:land.w/2,b:land.h/2,c:Math.cos(A.rad(angle)),s:Math.sin(A.rad(angle))},hole};
    const {core,r:radius}=L.core(land,center,angle,mirror);
    if(land.shape==="custom"){
      const pieces=fillPieces(core);
      return pieces?{center,pieces:pieces.map(core=>({core,radius})),hole}:null;
    }
    return {center,core,radius,hole};
  }
  function airwireEdges(islands,net) {
    if(islands.length<2)return [];
    // Anchors of each island (its pads when it has any); n is the point's slot in rootOf.
    const all=[];
    islands.forEach((group,index)=>{
      const pads=group.filter(e=>e.kind==="pad");
      for(const e of pads.length?pads:group)for(const a of e.anchors)all.push({at:a.at,id:a.id,label:a.label,key:a.key,index,n:all.length});
    });
    const group=sets(islands.length),out=[],rootOf=new Int32Array(all.length);
    function tree(points){
      let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity; // A.bounds of the anchors, without the copy
      for(const {at:[x,y]} of points){if(!Number.isFinite(x)||!Number.isFinite(y))continue;x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
      const b=x0===Infinity?null:[x0,y0,x1,y1];
      const node={box:b,root:-1};
      if(points.length<=12){node.points=points;return node;}
      const axis=b[2]-b[0]>=b[3]-b[1]?0:1;
      points.sort((a,c)=>a.at[axis]-c.at[axis]||compareKey(a,c));
      const mid=points.length>>1;node.left=tree(points.slice(0,mid));node.right=tree(points.slice(mid));return node;
    }
    const kd=tree([...all]);
    function mark(n){
      if(n.points){const first=rootOf[n.points[0].n];n.root=n.points.every(p=>rootOf[p.n]===first)?first:-1;}
      else {const a=mark(n.left),b=mark(n.right);n.root=a===b?a:-1;}return n.root;
    }
    const boxDist=(p,b)=>Math.max(b[0]-p[0],0,p[0]-b[2])**2+Math.max(b[1]-p[1],0,p[1]-b[3])**2;
    // Candidate edges are made only when they can win; the tie-break key only on equal lengths.
    function edge(a,b,d){
      if(compareKey(a,b)>0)[a,b]=[b,a];
      return {a,b,d,key:null};
    }
    const keyOf=e=>e.key??=JSON.stringify([e.a.key,e.b.key]);
    const better=(a,b)=>!b||a.d<b.d||(a.d===b.d&&cmp(keyOf(a),keyOf(b))<0);
    function nearest(p,n,root,best){
      if(n.root===root||best&&boxDist(p.at,n.box)>best.d)return best;
      if(n.points){for(const q of n.points){if(rootOf[q.n]===root)continue;const d=dist2(p.at,q.at);if(best&&d>best.d)continue;const candidate=edge(p,q,d);if(better(candidate,best))best=candidate;}return best;}
      const l=boxDist(p.at,n.left.box),r=boxDist(p.at,n.right.box);
      if(l<=r){best=nearest(p,n.left,root,best);return nearest(p,n.right,root,best);}
      best=nearest(p,n.right,root,best);return nearest(p,n.left,root,best);
    }
    // Borůvka on the implicit Euclidean graph. No quadratic edge list is stored.
    while(out.length<islands.length-1){
      // Island roots do not change while the round looks for each one's nearest neighbour.
      for(const p of all)rootOf[p.n]=group.root(p.index);
      mark(kd);const best=new Map();
      for(const p of all){const r=rootOf[p.n],hit=nearest(p,kd,r,best.get(r));if(hit)best.set(r,hit);}
      let joins=0;
      for(const e of [...best.values()].sort((a,b)=>a.d-b.d||cmp(keyOf(a),keyOf(b)))){
        if(!group.join(e.a.index,e.b.index))continue;
        joins++;out.push({net,from:e.a.at,to:e.b.at,fromId:e.a.id,toId:e.b.id,fromLabel:e.a.label,toLabel:e.b.label,distance:Math.sqrt(e.d)});
      }
      if(!joins)break;
    }
    return out;
  }
  // Sweep over flat typed arrays: boxes along the sweep axis (lo, hi), across it (lo2, hi2)
  // and the copper layer span of each feature.
  // The sweep's candidates are the pairs n < j whose boxes meet within EPS on a shared layer, visited in
  // (n, j) order. A uniform grid finds them without scanning every feature that shares the sweep axis
  // (a dense board puts thousands there), and visits them in the same order, so the union, the
  // witnesses and the shorts are the sweep's.
  function visitCandidates(features,axis,visit){
    const other=1-axis,count=features.length,lo=new Float64Array(count),hi=new Float64Array(count),lo2=new Float64Array(count),hi2=new Float64Array(count);
    const l0=new Float64Array(count),l1=new Float64Array(count);
    for(let n=0;n<count;n++){const f=features[n],b=f.box;lo[n]=b[axis];hi[n]=b[axis+2];lo2[n]=b[other];hi2[n]=b[other+2];l0[n]=f.layers[0];l1[n]=f.layers[1];}
    const meets=(n,j)=>!(lo[j]>hi[n]+EPS||l1[n]<l0[j]||l1[j]<l0[n]||lo2[j]>hi2[n]+EPS||lo2[n]>hi2[j]+EPS);
    // Cell: about twice the median feature extent; features over BIG cells (and non-finite boxes) are
    // checked against every later feature by the sweep's own scan.
    const sample=[],stride=Math.max(1,Math.floor(count/1024));
    for(let n=0;n<count;n+=stride){const w=Math.max(hi[n]-lo[n],hi2[n]-lo2[n]);if(Number.isFinite(w))sample.push(w);}
    sample.sort((a,b)=>a-b);
    const cell=Math.max(2*(sample[sample.length>>1]||0),1e-3),BIG=64,OFF=1048576,SPAN=2097152;
    const cx=v=>Math.floor(v/cell),grid=new Map(),big=new Uint8Array(count),bigs=[];
    for(let n=0;n<count;n++){
      const x0=cx(lo[n]-EPS),x1=cx(hi[n]+EPS),y0=cx(lo2[n]-EPS),y1=cx(hi2[n]+EPS);
      if(!(x1-x0<BIG&&y1-y0<BIG)){big[n]=1;bigs.push(n);continue;}
      for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const k=(x+OFF)*SPAN+(y+OFF);let c=grid.get(k);if(!c)grid.set(k,c=[]);c.push(n);}
    }
    const stamp=new Int32Array(count).fill(-1),found=[];
    for(let n=0;n<count;n++){
      if(big[n]){
        const end=hi[n]+EPS;
        for(let j=n+1;j<count;j++){if(lo[j]>end)break;if(meets(n,j))visit(features[n],features[j]);}
        continue;
      }
      found.length=0;
      const x0=cx(lo[n]-EPS),x1=cx(hi[n]+EPS),y0=cx(lo2[n]-EPS),y1=cx(hi2[n]+EPS);
      for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){
        const c=grid.get((x+OFF)*SPAN+(y+OFF));if(!c)continue;
        for(const j of c)if(j>n&&stamp[j]!==n){stamp[j]=n;if(meets(n,j))found.push(j);}
      }
      for(const j of bigs)if(j>n&&meets(n,j))found.push(j);
      if(found.length>1)found.sort((a,b)=>a-b);
      for(const j of found)visit(features[n],features[j]);
    }
  }
  // Copper -> entities and features (feature.node indexes b.entities; feature.e is it).
  function builder(doc,defs,cut){
    const b={entities:[],features:[],excluded:0,unassigned:0};
    const {index,padLayer,hasPadRows,padPlanes}=globalThis.AtriumPCBAppearance;
    let copperKeys;
    const copper=()=>copperKeys??=globalThis.AtriumStackup?.copperLayers(doc,defs)||["Top","Bottom"];
    // Drill-only pads have no copper that could take part in the connectivity check.
    const drillOnly = i => i.kind === "pad" && (i.holeOnly ||
      !hasPadRows(i) && AtriumResolvedLand.geometry(i)?.holeOnly);
    function addEntity(i,parent,slot,cutouts=[]){
      const declared=padLayer(parent,i);
      if(index(declared)<0&&declared!=="Multi")return;
      const layers=copperSpan(i,parent,declared);
      if(!layers||i.kind==="pad"&&i.plated===false&&i.drill>0){if(!drillOnly(i))b.excluded++;return;}
      const id=parent?.id||i.id,key=JSON.stringify([id,slot]);
      const net=parent&&i.kind==="pad"&&Object.hasOwn(parent.pinNets||{},i.number)?parent.pinNets[i.number]:i.net||"";
      const label=parent ? parent.ref+(i.kind==="pad"?"."+String(i.number||"?"):" copper") : i.kind==="pad"?"Pad "+(i.number||"?"):i.kind==="track"?"Track":i.kind==="region"?(i.teardrop?"Teardrop":"Copper region"):"Via";
      const entities=b.entities,features=b.features,node=entities.length,shapes=[],points=[];
      if(i.kind==="region"){
        // Filled copper (teardrops): the whole area conducts, not just its outline.
        const place=loop=>parent?loop.map(p=>A.world(p,parent)):loop,line=place(i.points),r=Math.max(0,(i.width||0)/2);
        if(cutouts.length){
          const holes=cutouts.map(place),rim=[line,...holes].flatMap((loop,index)=>loop.map((p,j)=>
            ({core:[p,loop[(j+1)%loop.length]],radius:index===0?r:0})));
          shapes.push({core:line,radius:r,rim,cutouts:holes});
        }else{
          const pieces=fillPieces(line);
          if(pieces)shapes.push({pieces:pieces.map(core=>({core,radius:r}))});
          else for(let j=0;j<line.length;j++)shapes.push({core:[line[j],line[(j+1)%line.length]],radius:Math.max(r,.0005)});
        }
        points.push(line[0]);
      }else if(i.kind==="track"){
        if(!(i.width>0)||!Array.isArray(i.points)||i.points.length<2){b.excluded++;return;}
        const path=AtriumGeometryCurves.pathPoints(i,.001),line=parent?path.map(p=>A.world(p,parent)):path;
        if(cut&&!parent&&!i.clipped){const runs=AtriumBoardShape.clipPolyline(doc,line);if(runs.length!==1||runs[0].length!==line.length){runs.forEach((pts,k)=>addEntity({...i,points:pts,arc:undefined,clipped:true},null,slot+"/"+k));if(!runs.length)b.excluded++;return;}}
        for(let j=1;j<line.length;j++)shapes.push({core:[line[j-1],line[j]],radius:i.width/2});
        if(i.closed&&!A.same(line[0],line.at(-1)))shapes.push({core:[line.at(-1),line[0]],radius:i.width/2});
        points.push(line[0]);if(!A.same(line[0],line.at(-1)))points.push(line.at(-1));
      }else{
        for(const key of padPlanes(i,declared,copper)){
          const plane=key==null?-1:index(key);
          if(plane>=0&&(plane<layers[0]||plane>layers[1]))continue;
          const geom=padGeometry(i,parent,key);
          if(!geom||cut&&AtriumBoardShape.inCutout(doc,geom.center))continue;
          shapes.push({...geom,layerSpan:plane<0?layers:[plane,plane]});
          if(!points.length)points.push(geom.center);
        }
        if(!shapes.length){if(!drillOnly(i))b.excluded++;return;}
      }
      const entity={key,id,label,net,kind:i.kind,anchors:points.map((at,n)=>({at:[...at],id,label,key:key+"/"+n}))};
      entities.push(entity);
      if(!net)b.unassigned++;
      // A shape's box: support() in the four axis directions. For finite core points that is the extreme
      // coordinate less or plus the radius, the same arithmetic without four passes and arrays.
      const boxOf=shape=>{
        const c=shape.core,r=shape.radius;
        if(!shape.ellipse&&c?.length){
          let x0=c[0][0],y0=c[0][1],x1=x0,y1=y0,ok=Number.isFinite(x0)&&Number.isFinite(y0);
          for(let k=1;ok&&k<c.length;k++){const x=c[k][0],y=c[k][1];if(!Number.isFinite(x)||!Number.isFinite(y)){ok=false;break;}if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}
          if(ok)return [x0+r*-1,y0+r*-1,x1+r,y1+r];
        }
        return [support(shape,[-1,0])[0],support(shape,[0,-1])[1],support(shape,[1,0])[0],support(shape,[0,1])[1]];
      };
      for(const shape of shapes){
        // A filled region is one feature (one sweep entry) holding its convex pieces.
        if(shape.pieces){
          for(const q of shape.pieces)q.box=boxOf(q);
          const box=shape.pieces.reduce((b,q)=>[Math.min(b[0],q.box[0]),Math.min(b[1],q.box[1]),Math.max(b[2],q.box[2]),Math.max(b[3],q.box[3])],[Infinity,Infinity,-Infinity,-Infinity]);
          features.push({pieces:shape.pieces,box,layers:shape.layerSpan??layers,node,e:entity});
        }else features.push({...shape,box:boxOf(shape),layers:shape.layerSpan??layers,node,e:entity});
      }
    }
    function graphic(s,parent,slot){
      if(index(s.layer)<0&&s.layer!=="Multi")return;
      if(s.keepout===true||s.cutout)return; // a keep-out on one copper layer is a rule, not copper (pcb-draw.js)
      if(s.regionShape&&!globalThis.AtriumBoardShape&&typeof require==="function")require("../pcb/board-shape-core.js");
      const C=AtriumGeometryCurves;
      let accepted=false;
      C.artworkInk(s,s.width||0,(ink,part)=>{
        if(ink.kind==="stroke"){
          if(s.fill||!(ink.width>0))return;
          accepted=true;
          addEntity({...s,kind:"track",points:C.flatten(ink.centerline,.001),arc:undefined},parent,slot);
        }else{
          // An unassigned fill can conduct through any pads it touches.
          const {outer,holes}=ink.islands[0],project=loop=>C.flatten(loop,.001).slice(0,-1);
          accepted=true;
          addEntity({...s,kind:"region",points:project(outer),width:part==="disk"?0:s.width},parent,slot,holes.map(project));
        }
      });
      if(!accepted)b.excluded++;
    }
    b.item=i=>{
      if(["pad","track","via"].includes(i.kind))addEntity(i,null,0);
      if(i.kind==="graphic")graphic(i,null,0);
      if(i.kind!=="part")return;
      const fp=defs.get(i.def)?.footprint;if(!fp){b.excluded++;return;}
      (fp.pads||[]).forEach((p,j)=>addEntity({...p,kind:p.kind==="via"?"via":"pad",diameter:p.diameter||p.w},i,"pad"+j));
      (fp.shapes||[]).forEach((s,j)=>graphic(s,i,"shape"+j));
    };
    return b;
  }
  // Stored pour islands share this union. Full and incremental connectivity both call it after contactRegions.
  function joinIslandLinks(union,entities,copper){
    if(!copper?.length)return;
    const byKey=new Map(entities.map((e,n)=>[e.key,n]));
    for(const r of copper){
      const nodes=(r.links||[]).map(l=>byKey.get(JSON.stringify(l))).filter(n=>n!=null);
      for(let k=1;k<nodes.length;k++)union.join(nodes[0],nodes[k]);
    }
  }
  // The whole pass (connectivity-live.js, lazy, answers local edits incrementally, equal to it).
  // o.airwires === false: the caller reads shorts only (DRC without the un-routed check); nets carry no
  // missing count and there are no airwires (the minimum spanning trees are most of a large board's pass).
  function inspectFull(doc,defs,o){
    if(doc.kind!=="pcb")throw Error("Choose a PCB layout to inspect connectivity.");
    // Board cutouts (AtriumBoardShape.holes) remove copper: tracks are clipped, pads and vias inside are dropped.
    const cut=!!globalThis.AtriumBoardShape?.holes?.(doc)?.length;
    const B=builder(doc,defs,cut);
    for(const i of doc.items)B.item(i);
    const {entities,features}=B,excluded=B.excluded,unassigned=B.unassigned;
    // Net ties (net-ties.js): contacts through a tie's own copper are resolved after the sweep.
    const T=globalThis.AtriumNetTies?.prepare(doc,defs,entities)||null;
    const union=sets(entities.length),witnesses=[],stats={objects:entities.length,features:features.length,candidates:0,contacts:0};
    if(features.length){
      // The board's extent over every box corner (as A.bounds of them, without building the list).
      let wx=0,wy=0;const bounds=[Infinity,Infinity,-Infinity,-Infinity];
      for(const f of features){
        const b=f.box;wx+=b[2]-b[0];wy+=b[3]-b[1];
        for(let k=0;k<4;k+=2){const x=b[k],y=b[k+1];if(!Number.isFinite(x)||!Number.isFinite(y))continue;if(x<bounds[0])bounds[0]=x;if(y<bounds[1])bounds[1]=y;if(x>bounds[2])bounds[2]=x;if(y>bounds[3])bounds[3]=y;}
      }
      const axis=wx/Math.max(EPS,bounds[2]-bounds[0])<=wy/Math.max(EPS,bounds[3]-bounds[1])?0:1,other=1-axis;
      features.sort((a,b)=>a.box[axis]-b.box[axis] || a.box[other]-b.box[other] || compareKey(entities[a.node],entities[b.node]));
      visitCandidates(features,axis,(a,b)=>{
        if(T&&T.skip(a.node,b.node)){if(contact(a,b))T.touch(a.node,b.node);return;}
        if(union.root(a.node)===union.root(b.node))return;
        stats.candidates++;if(contact(a,b)){
          union.join(a.node,b.node);stats.contacts++;
          const first=entities[a.node],second=entities[b.node];
          if(first.net&&second.net&&first.net!==second.net)witnesses.push([a.node,b.node]);
        }
      });
    }
    // The stored current islands join the same-net copper they touch.
    const copper=globalThis.AtriumPolygonPour?.contactRegions?.(doc,defs,o);
    joinIslandLinks(union,entities,copper);
    const tied=T?T.resolve(union):null;
    const roots=new Map(),byNet=new Map();
    for(let n=0;n<entities.length;n++){
      const e=entities[n],r=union.root(n);
      if(!roots.has(r))roots.set(r,[]);roots.get(r).push(e);
      if(!e.net)continue;
      if(!byNet.has(e.net))byNet.set(e.net,new Map());
      const groups=byNet.get(e.net);if(!groups.has(r))groups.set(r,[]);groups.get(r).push(e);
    }
    const shorts=[],shorted=new Set(),direct=new Map();
    for(const pair of witnesses){
      const root=union.root(pair[0]),ordered=pair.map(n=>entities[n]).sort(compareKey);
      const previous=direct.get(root);
      if(!previous||compareKey(ordered[0],previous[0])<0||
        compareKey(ordered[0],previous[0])===0&&compareKey(ordered[1],previous[1])<0)direct.set(root,ordered);
    }
    for(const [root,group] of roots){
      // Most islands hold one net: tell without sorting.
      let one=null,many=false;for(const e of group)if(e.net){if(one===null)one=e.net;else if(e.net!==one){many=true;break;}}
      if(!many)continue;
      const named=group.filter(e=>e.net).sort(compareKey),names=[...new Set(named.map(e=>e.net))].sort(cmp);
      names.forEach(name=>shorted.add(name));
      const pair=direct.get(root);
      const from=pair?pair[0]:named[0],to=pair?pair[1]:named.find(e=>e.net!==from.net);
      shorts.push({nets:names,direct:!!pair,from:from.anchors[0].at,to:to.anchors[0].at,fromId:from.id,toId:to.id,fromLabel:from.label,toLabel:to.label});
    }
    if(tied)for(const s of tied.shorts){shorts.push(s);s.nets.forEach(n=>shorted.add(n));}
    {const key=new Map(shorts.map(s=>[s,JSON.stringify([s.nets,s.fromId,s.toId,s.from])]));shorts.sort((a,b)=>cmp(key.get(a),key.get(b)));}
    // Airwires: Rust/WebAssembly (engine-core.js, lazy) for all nets at once, else airwireEdges.
    const air=o?.airwires!==false,nets=[],airwires=[],names=[...byNet.keys()].sort(cmp),groups=names.map(n=>[...byNet.get(n).values()]),batch=air?globalThis.AtriumEngine?.airwires?.(groups,names):null;
    for(const [k,name] of names.entries()){
      const islands=groups[k], items=islands.flat();
      const links=!air?null:batch?batch[k]:airwireEdges(islands,name);
      nets.push({name,pads:items.filter(i=>i.kind==="pad").length,tracks:items.filter(i=>i.kind==="track").length,
        vias:items.filter(i=>i.kind==="via").length,islands:islands.length,missing:links?links.length:null,shorted:shorted.has(name)});
      if(links)for(const link of links)airwires.push(link);
    }
    const sourceNotes=(doc.notes||[]).filter(note=>/polygon|pour|plane|region|pad.stack/i.test(note));
    return {nets,airwires,shorts,excluded,unassigned,stats,sourceNotes,...(tied?{ties:tied.allowed}:{})};
  }
  const inspect=(doc,defs,journal,o)=>doc.kind==="pcb"&&o?.airwires!==false&&globalThis.AtriumConnectivityLive?.inspect(doc,defs,journal,o)||inspectFull(doc,defs,o);
  return {inspect,inspectFull,fillPieces,copperSpan,kit:{A,EPS,cmp,compareKey,sets,contact,builder,airwireEdges,joinIslandLinks}};
})();
