"use strict";

// Fast approximate polygon pour for display only (the "fast + slow" solve).
// PourPreview().solve(task) takes the same pure integer task as the exact core
// (polygon-pour.js prepare -> PourCore().solve) and returns {islands, stats} in
// the SAME integer frame, so polygon-pour.js finish() can encode it unchanged.
// The copper is approximate: it is shown, and drives the pour animation's
// edges, until the exact solve of the same task replaces it. It must never
// reach Gerber, DRC, connectivity or a saved file: stats.preview is true and
// callers keep it out of pcbDrawing.pours.
//
// Method "raster" (the default): the pour predicate sampled at the centre of
// every screen pixel (a scanline sweep of winding numbers per class), the
// pixel boundary traced into rings (outer rings counter-clockwise, holes
// clockwise, copper 4-connected), the staircase straightened by
// Douglas-Peucker at half a pixel. Its cost is the input edges plus the pixels
// of the grid (limited by opts.view), not the crossings of the arrangement, so
// it is far cheaper than any reduction solved exactly. On the dense board
// (25.6k objects, ten pours, exact = stage 1 + stage 2 in Chrome):
// fit-to-board (1400 px) 41 ms for all ten against 600 ms (WebAssembly core)
// or 1275 ms (JS core); 10 px/mm 142 ms for whole pours (a 1400 x 900 view
// bounds one pour to 10-35 ms). Deviation: boundary within 0.7 px for 99% and
// 0.9 px for 99.9% of the boundary; the sampled pixels differ from the exact
// copper sampled on the same grid in 0.03% of pixels. Features thinner than a
// pixel (slivers, necks) may vanish or appear: that is where the largest
// boundary distances (2-3 px) come from.
//
// Method "reduce": the task clipped to the outline box (exactly: a run of
// vertices outside one side keeps only its first and last vertex, so no
// winding inside the box changes and no new coordinate is made), obstacles
// simplified by Douglas-Peucker (opts.centre: centred error on convex rings),
// coordinates quantised to a power-of-two grid, then solved by the exact core
// and scaled back. Measured 1.5-2.3x faster at 0.25-0.5 px tolerance (boundary
// p99 0.4 px): the arrangement's crossings do not shrink with the vertices,
// so it never reached 3x below one pixel. Kept for comparison and for callers
// that need copper solved by the exact core.
//
// Arc tags are not kept (finish() finds no true arcs to fit). Like PourCore,
// PourPreview refers to no outer binding, so a worker can be built from its
// source text (AtriumPourPreview.source()); pass the core (a PourCore()
// instance, for its pour predicate and, for "reduce", its solve) as opts.core,
// else globalThis.AtriumPolygonPour._internal.core is used.
globalThis.AtriumPourPreview=(()=>{
  function PourPreview(){
    const now=()=>globalThis.performance?.now?.()??Date.now();
    function boxOf(r){
      let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity;
      for(let i=0;i<r.length;i+=2){const x=r[i],y=r[i+1];if(x<a)a=x;if(x>c)c=x;if(y<b)b=y;if(y>d)d=y;}
      return [a,b,c,d];
    }
    function area2(r){
      let s=0;const n=r.length>>1;
      for(let i=0,j=n-1;i<n;j=i++)s+=r[2*j]*r[2*i+1]-r[2*i]*r[2*j+1];
      return s;
    }
    // One side of the clip box: axis 0 (x) or 1 (y); out(v) is v[axis]*dir > bound*dir.
    // Returns the ring (array) and tags, null when the ring lies wholly outside.
    function clipSide(ring,tags,axis,bound,dir){
      const n=ring.length>>1;
      const out=i=>dir*(ring[2*i+axis]-bound)>0;
      let start=-1,outside=0;
      for(let i=0;i<n;i++){if(out(i))outside++;else if(start<0)start=i;}
      if(outside===n)return null;
      if(!outside)return {ring,tags};
      // Walk from an inside vertex; a run V1..Vk outside keeps V1 and Vk only.
      const R=[],T=[];
      for(let s=0;s<n;){
        const i=(start+s)%n;
        if(!out(i)){R.push(ring[2*i],ring[2*i+1]);T.push(tags?tags[i]:-1);s++;continue;}
        let e=s;while(e+1<n&&out((start+e+1)%n))e++;
        const a=i,b=(start+e)%n;
        R.push(ring[2*a],ring[2*a+1]);T.push(a===b?(tags?tags[a]:-1):-1);
        if(b!==a){R.push(ring[2*b],ring[2*b+1]);T.push(tags?tags[b]:-1);}
        s=e+1;
      }
      return {ring:R,tags:T};
    }
    // Exact clip of a ring to box [x0,y0,x1,y1] (winding numbers strictly inside the box kept).
    function clipRing(ring,tags,box){
      const b=boxOf(ring);
      if(b[2]<box[0]||b[0]>box[2]||b[3]<box[1]||b[1]>box[3])return null;
      if(b[0]>=box[0]&&b[2]<=box[2]&&b[1]>=box[1]&&b[3]<=box[3])return {ring,tags};
      let r={ring,tags};
      for(const [axis,bound,dir] of [[0,box[0],-1],[0,box[2],1],[1,box[1],-1],[1,box[3],1]]){
        r=clipSide(r.ring,r.tags,axis,bound,dir);if(!r||r.ring.length<6)return null;
      }
      return r;
    }
    // Douglas-Peucker on a closed ring (tolerance tol, frame units). Splits at
    // vertex 0 and the vertex farthest from it.
    function simplifyRing(r,tol,centre){
      const n=r.length>>1;if(n<=4||!(tol>0))return r;
      let far=0,fd=-1;
      for(let i=1;i<n;i++){const dx=r[2*i]-r[0],dy=r[2*i+1]-r[1],d=dx*dx+dy*dy;if(d>fd){fd=d;far=i;}}
      const keep=new Uint8Array(n);keep[0]=keep[far]=1;
      const t2=tol*tol,stack=[0,far,far,n];
      while(stack.length){
        const b=stack.pop(),a=stack.pop();if(b-a<2)continue;
        const ax=r[2*a],ay=r[2*a+1],bi=b%n,bx=r[2*bi],by=r[2*bi+1],vx=bx-ax,vy=by-ay,L=vx*vx+vy*vy;
        let best=-1,bd=t2;
        for(let i=a+1;i<b;i++){
          const px=r[2*i]-ax,py=r[2*i+1]-ay;let d;
          if(L===0)d=px*px+py*py;
          else{const t=(px*vx+py*vy)/L;if(t<=0)d=px*px+py*py;else if(t>=1){const qx=r[2*i]-bx,qy=r[2*i+1]-by;d=qx*qx+qy*qy;}else{const c=px*vy-py*vx;d=c*c/L;}}
          if(d>bd){bd=d;best=i;}
        }
        if(best>=0){keep[best]=1;stack.push(a,best,best,b);}
      }
      const out=[];for(let i=0;i<n;i++)if(keep[i])out.push(r[2*i],r[2*i+1]);
      return centre&&convex(r)?centred(r,keep,out):out;
    }
    // A convex ring winds one way: every turn has the sign of its area.
    function convex(r){
      const n=r.length>>1,a=area2(r);if(!a)return false;
      for(let i=0;i<n;i++){
        const p=(i+n-1)%n,q=(i+1)%n,c=(r[2*i]-r[2*p])*(r[2*q+1]-r[2*i+1])-(r[2*i+1]-r[2*p+1])*(r[2*q]-r[2*i]);
        if(c&&(c>0)!==(a>0))return false;
      }
      return true;
    }
    // Douglas-Peucker cuts the corners of a convex ring (an inscribed polygon:
    // it loses up to tol on one side). Each kept edge moves outward by half the
    // largest distance of the vertices it replaced, so the error is centred
    // (+-tol/2) instead of one-sided; edges that replaced nothing stay put.
    function centred(r,keep,out){
      const n=r.length>>1,m=out.length>>1,idx=[];
      for(let i=0;i<n;i++)if(keep[i])idx.push(i);
      const s=area2(r)>0?1:-1,NX=new Float64Array(m),NY=new Float64Array(m),Cv=new Float64Array(m);
      for(let k=0;k<m;k++){
        const a=idx[k],b=idx[(k+1)%m],ax=r[2*a],ay=r[2*a+1],bx=r[2*b],by=r[2*b+1],L=Math.hypot(bx-ax,by-ay)||1;
        const nx=s*(by-ay)/L,ny=-s*(bx-ax)/L;let dev=0;
        for(let i=(a+1)%n;i!==b;i=(i+1)%n){const d=(r[2*i]-ax)*nx+(r[2*i+1]-ay)*ny;if(d>dev)dev=d;}
        NX[k]=nx;NY[k]=ny;Cv[k]=ax*nx+ay*ny+dev/2;
      }
      const o=[];
      for(let k=0;k<m;k++){
        const j=(k+m-1)%m,det=NX[j]*NY[k]-NY[j]*NX[k],v=idx[k];
        if(Math.abs(det)<1e-6){const d=Cv[k]-(r[2*v]*NX[k]+r[2*v+1]*NY[k]);o.push(Math.round(r[2*v]+d*NX[k]),Math.round(r[2*v+1]+d*NY[k]));continue;}
        o.push(Math.round((Cv[j]*NY[k]-Cv[k]*NY[j])/det),Math.round((NX[j]*Cv[k]-NX[k]*Cv[j])/det));
      }
      return o;
    }
    // Divide by g and round; drop repeated and collinear vertices.
    function quantise(r,g){
      const n=r.length>>1,q=[];
      for(let i=0;i<n;i++){
        const x=Math.round(r[2*i]/g),y=Math.round(r[2*i+1]/g),k=q.length;
        if(k&&q[k-2]===x&&q[k-1]===y)continue;
        q.push(x,y);
      }
      while(q.length>=4&&q[0]===q[q.length-2]&&q[1]===q[q.length-1])q.length-=2;
      let changed=true;
      while(changed&&q.length>=6){
        changed=false;
        const m=q.length>>1,o=[];
        for(let i=0;i<m;i++){
          const p=(i+m-1)%m,s=(i+1)%m,ax=q[2*p],ay=q[2*p+1],bx=q[2*i],by=q[2*i+1],cx=q[2*s],cy=q[2*s+1];
          if((bx-ax)*(cy-ay)-(by-ay)*(cx-ax)===0){changed=true;continue;}
          o.push(bx,by);
        }
        if(changed){q.length=0;for(const v of o)q.push(v);}
      }
      return q.length>=6?q:null;
    }
    function outlineBox(task){
      let box=null;
      for(const s of task.shapes)if(s.cls===0){const b=boxOf(s.ring);box=box?[Math.min(box[0],b[0]),Math.min(box[1],b[1]),Math.max(box[2],b[2]),Math.max(box[3],b[3])]:b;}
      return box;
    }
    // Default reduction for a pixel of `pixel` frame units: the deviation stays
    // well under one pixel (see tests/pour-preview.cjs for the measured bounds).
    function params(task,opts={}){
      let pixel=+opts.pixel;
      if(!(pixel>0)){
        // Fit-to-board default: the pour outline's larger side over 1400 px.
        const b=outlineBox(task)||[0,0,1400,1400];
        pixel=Math.max(b[2]-b[0],b[3]-b[1],1)/1400;
      }
      const tol=opts.tol!=null?+opts.tol:pixel*(opts.tolPx!=null?+opts.tolPx:.25);
      let grid=opts.grid!=null?+opts.grid:1;
      if(opts.grid==null){const want=pixel*(opts.gridPx!=null?+opts.gridPx:1/16);while(grid*2<=want)grid*=2;}
      const drop=opts.drop!=null?+opts.drop:pixel*(opts.dropPx!=null?+opts.dropPx:0);
      return {pixel,tol,grid:Math.max(1,Math.floor(grid)),drop,clip:opts.clip!==false,centre:opts.centre!==false};
    }
    // The reduced task on the coarse grid (coordinates / grid).
    function reduce(task,opts={}){
      const p=params(task,opts),g=p.grid;
      // Copper needs a non-zero winding of class 0 (the pour outline): its box bounds the copper.
      let box=p.clip?outlineBox(task):null;
      if(box){const m=Math.max(64,4*g,2*p.tol);box=[box[0]-m,box[1]-m,box[2]+m,box[3]+m];}
      const shapes=[];let vertsIn=0,vertsOut=0,culled=0,dropped=0,collapsed=0;
      for(const s of task.shapes){
        const n0=s.ring.length>>1;vertsIn+=n0;
        let ring=s.ring;
        if(box){const c=clipRing(ring,null,box);if(!c){culled++;continue;}ring=c.ring;}
        if(p.drop>0&&s.cls>=2){const b=boxOf(ring);if(b[2]-b[0]<p.drop&&b[3]-b[1]<p.drop){dropped++;continue;}}
        const a0=area2(ring);
        if(p.tol>0&&s.cls>=2)ring=simplifyRing(ring,p.tol,p.centre);
        const q=quantise(ring,g);
        if(!q){collapsed++;continue;}
        const a1=area2(q);
        if(!a1||(a1>0)!==(a0>0)){collapsed++;continue;}
        vertsOut+=q.length>>1;
        shapes.push({cls:s.cls,ring:Int32Array.from(q),sign:s.sign,tags:null});
      }
      const anchors=task.anchors.map(a=>{const r=new Int32Array(a.length);for(let i=0;i<a.length;i++)r[i]=Math.round(a[i]/g);return r;});
      const reduced={shapes,K:task.K,hasBoard:task.hasBoard,anchors,removeDead:task.removeDead,minArea:task.minArea/(g*g),minSize:task.minSize/g};
      return {task:reduced,grid:g,params:p,stats:{shapesIn:task.shapes.length,shapesOut:shapes.length,vertsIn,vertsOut,culled,dropped,collapsed}};
    }
    function scale(r,g){
      if(g===1)return Int32Array.from(r);
      const o=new Int32Array(r.length);for(let i=0;i<r.length;i++)o[i]=r[i]*g;return o;
    }
    function coreOf(opts){
      const core=opts.core||globalThis.AtriumPolygonPour?._internal?.core;
      if(!core||typeof core.solve!=="function")throw Error("AtriumPourPreview needs opts.core (a PourCore())");
      return core;
    }
    // Method "reduce": the reduced task solved by the exact core, scaled back.
    function solveReduced(task,opts={}){
      const t0=now(),core=coreOf(opts);
      const red=reduce(task,opts),t1=now();
      const solved=core.solve(red.task),t2=now(),g=red.grid;
      const pack=r=>{const ring=scale(r.ring,g);return {ring,tags:new Int32Array(ring.length>>1).fill(-1)};};
      const islands=solved.islands.map(isl=>({...pack(isl),links:isl.links,holes:isl.holes.map(pack)}));
      const t3=now();
      const stats={...solved.stats,preview:true,method:"reduce",grid:g,tol:red.params.tol,pixel:red.params.pixel,...red.stats,
        tReduce:t1-t0,tCore:t2-t1,tScale:t3-t2,tSolve:t3-t0};
      return {islands,stats};
    }
    // ------------------------------------------------------------ raster
    // Method "raster": the pour predicate sampled at pixel centres, then the
    // pixel boundary traced into rings. Pixel (i, j) covers [X0+i*p, X0+(i+1)*p]
    // x [Y0+j*p, ...]; its centre is copper when the predicate holds for the
    // winding numbers there (a scanline sweep per row: every edge crossing the
    // row's centre line adds its class's winding change). Cost: the edges plus
    // the pixels (bounded by opts.view), not the crossings of the arrangement.
    // Copper pixels are 4-connected (an island never joins at a corner).
    function rasterise(task,inside,X0,Y0,p,W,H){
      const K=task.K,M=2*K,img=new Uint8Array(W*H),cnt=new Int32Array(H+1),X1=X0+W*p,Y1=Y0+H*p;
      // Rings wholly right of, above or below the grid cross no row left of a pixel centre.
      const live=[];
      for(const s of task.shapes){const b=boxOf(s.ring);if(b[0]<X1&&b[1]<Y1&&b[3]>Y0)live.push(s);}
      // Rows whose centre line an edge crosses: centres in [min y, max y).
      for(const s of live){
        const r=s.ring,n=r.length>>1;
        for(let i=0,j=n-1;i<n;j=i++){
          const ya=r[2*j+1],yb=r[2*i+1];if(ya===yb)continue;
          const lo=Math.max(0,Math.ceil(((ya<yb?ya:yb)-Y0)/p-.5)),hi=Math.min(H-1,Math.ceil(((ya<yb?yb:ya)-Y0)/p-.5)-1);
          for(let y=lo;y<=hi;y++)cnt[y+1]++;
        }
      }
      for(let y=0;y<H;y++)cnt[y+1]+=cnt[y];
      const keys=new Float64Array(cnt[H]),fill=cnt.slice(0,H);
      for(const s of live){
        const r=s.ring,n=r.length>>1,cls2=s.cls*2,sign=s.sign;
        for(let i=0,j=n-1;i<n;j=i++){
          const xa=r[2*j],ya=r[2*j+1],xb=r[2*i],yb=r[2*i+1];if(ya===yb)continue;
          const lo=Math.max(0,Math.ceil(((ya<yb?ya:yb)-Y0)/p-.5)),hi=Math.min(H-1,Math.ceil(((ya<yb?yb:ya)-Y0)/p-.5)-1);
          if(lo>hi)continue;
          // Winding seen from the left: a downward edge of a +1 ring adds 1.
          const code=cls2+((yb<ya?sign:-sign)>0?1:0),slope=(xb-xa)/(yb-ya);
          for(let y=lo;y<=hi;y++){
            let x=(xa+(Y0+(y+.5)*p-ya)*slope-X0)/p;
            if(x>=W)x=W;else if(x<0)x=-1;
            keys[fill[y]++]=(Math.floor(x*256)+512)*M+code;
          }
        }
      }
      const w=new Int32Array(K);
      for(let y=0;y<H;y++){
        const a=cnt[y],b=cnt[y+1];if(a===b)continue;
        const row=keys.subarray(a,b).sort();w.fill(0);
        for(let k=0;k<row.length;k++){
          const key=row[k],code=key%M;w[code>>1]+=code&1?1:-1;
          if(k+1===row.length)break;
          const ka=Math.floor(key/M),kb=Math.floor(row[k+1]/M);
          if(kb>ka&&inside(w)){
            const i0=Math.max(0,Math.ceil((ka-512)/256-.5)),i1=Math.min(W-1,Math.ceil((kb-512)/256-.5)-1),o=y*W;
            for(let i=i0;i<=i1;i++)img[o+i]=1;
          }
        }
      }
      return img;
    }
    // The 4-connected copper components, from the pixel runs of each row (a
    // union-find over runs that share a column with a run of the row below).
    // at(i, j): the component of pixel (i, j) or -1; comps: id -> {n, x0, y0, x1, y1}.
    function label(img,W,H){
      const RS=[],RE=[],row=new Int32Array(H+1);
      for(let y=0;y<H;y++){
        const o=y*W;
        for(let x=0;x<W;){
          if(!img[o+x]){x++;continue;}
          const s=x;while(x<W&&img[o+x])x++;
          RS.push(s);RE.push(x-1);
        }
        row[y+1]=RS.length;
      }
      const n=RS.length,par=new Int32Array(n);for(let k=0;k<n;k++)par[k]=k;
      const find=a=>{while(par[a]!==a){par[a]=par[par[a]];a=par[a];}return a;};
      for(let y=1;y<H;y++){
        let a=row[y-1],b=row[y];const ae=row[y],be=row[y+1];
        while(a<ae&&b<be){
          if(RE[a]>=RS[b]&&RE[b]>=RS[a]){const p=find(a),q=find(b);if(p<q)par[q]=p;else if(q<p)par[p]=q;}
          if(RE[a]<RE[b])a++;else b++;
        }
      }
      const comps=new Map(),lab=new Int32Array(n);
      for(let y=0;y<H;y++)for(let k=row[y];k<row[y+1];k++){
        const l=lab[k]=find(k);let c=comps.get(l);
        if(!c)comps.set(l,c={n:0,x0:RS[k],y0:y,x1:RE[k],y1:y});
        c.n+=RE[k]-RS[k]+1;if(RS[k]<c.x0)c.x0=RS[k];if(RE[k]>c.x1)c.x1=RE[k];c.y1=y;
      }
      const at=(i,j)=>{
        if(j<0||j>=H)return -1;
        let lo=row[j],hi=row[j+1]-1;
        while(lo<=hi){const m=(lo+hi)>>1;if(RE[m]<i)lo=m+1;else if(RS[m]>i)hi=m-1;else return lab[m];}
        return -1;
      };
      return {at,comps};
    }
    // Trace every pixel boundary with copper on the left (outer rings counter-
    // clockwise, holes clockwise, as the exact core returns them). Turning left
    // whenever the pixel ahead-left is empty keeps copper 4-connected. Rings in
    // pixel-corner coordinates, vertices only where the direction changes.
    function traceRings(img,W,H){
      const cu=(x,y)=>x>=0&&y>=0&&x<W&&y<H&&img[y*W+x]===1;
      const done=new Uint8Array(W*H),rings=[];
      const DX=[1,0,-1,0],DY=[0,1,0,-1];
      for(let j=0;j<H;j++)for(let i=0;i<W;i++){
        const at=j*W+i;
        if(!img[at]||done[at]||cu(i,j-1))continue;
        // Start on the bottom side of pixel (i, j), heading +x.
        let x=i,y=j,d=0;const ring=[];
        for(let guard=0;guard<4*W*H+4;guard++){
          // Mark the bottom side of the pixel left of a +x edge (rings start only there).
          if(d===0)done[y*W+x]=1;
          x+=DX[d];y+=DY[d];
          let L,R;
          if(d===0){L=cu(x,y);R=cu(x,y-1);}
          else if(d===1){L=cu(x-1,y);R=cu(x,y);}
          else if(d===2){L=cu(x-1,y-1);R=cu(x-1,y);}
          else{L=cu(x,y-1);R=cu(x-1,y-1);}
          const nd=!L?(d+1)&3:R?(d+3)&3:d;
          if(nd!==d)ring.push(x,y);
          d=nd;
          if(x===i&&y===j&&d===0)break;
        }
        rings.push({ring,x:i,y:j});
      }
      return rings;
    }
    // Douglas-Peucker on the staircase (pixel units); a ring keeps at least 3 vertices.
    function smoothRing(r,tol){if(!(tol>0)||r.length<=8)return r;const s=simplifyRing(r,tol,false);return s.length>=6?s:r;}
    function solveRaster(task,opts={}){
      const t0=now(),core=coreOf(opts),inside=core.pourInside(task.K,task.hasBoard);
      const p=params(task,opts),px=p.pixel;
      let box=outlineBox(task);
      const empty={islands:[],stats:{preview:true,method:"raster",pixel:px,tSolve:now()-t0}};
      if(!box)return empty;
      if(opts.view){const v=opts.view;box=[Math.max(box[0],v[0]),Math.max(box[1],v[1]),Math.min(box[2],v[2]),Math.min(box[3],v[3])];}
      if(!(box[0]<box[2]&&box[1]<box[3]))return empty;
      // Pixel grid aligned to opts.origin (the frame point of a screen pixel corner; default 0, 0), so
      // the staircase lands on screen pixel edges and neighbouring views agree.
      const ox=opts.origin?+opts.origin[0]||0:0,oy=opts.origin?+opts.origin[1]||0:0;
      const X0=ox+Math.floor((box[0]-ox)/px)*px,Y0=oy+Math.floor((box[1]-oy)/px)*px,W=Math.max(1,Math.ceil((box[2]-X0)/px)),H=Math.max(1,Math.ceil((box[3]-Y0)/px));
      if(W*H>(opts.maxPixels||16e6))throw Error("AtriumPourPreview: "+W+" x "+H+" pixels; pass a coarser pixel or a view");
      const img=rasterise(task,inside,X0,Y0,px,W,H),t1=now();
      const lab=label(img,W,H),t2=now();
      const traced=traceRings(img,W,H),t3=now();
      const smooth=opts.smooth!=null?+opts.smooth:.5;
      // Components: area (pixels) and box (pixels), for the island limits.
      const comp=lab.comps;
      for(const c of comp.values()){c.outer=null;c.holes=[];c.links=[];}
      const toFrame=r=>{const o=new Int32Array(r.length);for(let i=0;i<r.length;i+=2){o[i]=Math.round(X0+r[i]*px);o[i+1]=Math.round(Y0+r[i+1]*px);}return o;};
      for(const t of traced){
        const c=comp.get(lab.at(t.x,t.y));if(!c)continue;
        const a=area2(t.ring);
        if(a>0)c.outer=t.ring;else c.holes.push(t.ring);
      }
      // Anchors link the components their vertices (or centre) land in.
      task.anchors.forEach((a,k)=>{
        const seen=new Set(),n=a.length>>1;let cx=0,cy=0;
        const hit=(x,y)=>{const i=Math.floor((x-X0)/px),j=Math.floor((y-Y0)/px);if(i<0||j<0||i>=W||j>=H)return;const l=lab.at(i,j);if(l>=0&&!seen.has(l)){seen.add(l);comp.get(l).links.push(k);}};
        for(let i=0;i<n;i++){hit(a[2*i],a[2*i+1]);cx+=a[2*i];cy+=a[2*i+1];}
        if(n)hit(cx/n,cy/n);
      });
      const islands=[];let verts=0,dead=0;
      const pack=r=>{const ring=toFrame(smoothRing(r,smooth));verts+=ring.length>>1;return {ring,tags:new Int32Array(ring.length>>1).fill(-1)};};
      for(const c of comp.values()){
        if(!c.outer)continue;
        if(task.removeDead&&!c.links.length){dead++;continue;}
        if(task.minArea>0&&c.n*px*px<task.minArea)continue;
        if((c.x1-c.x0+1)*px<task.minSize&&(c.y1-c.y0+1)*px<task.minSize)continue;
        islands.push({...pack(c.outer),links:c.links,holes:c.holes.map(pack)});
      }
      const t4=now();
      return {islands,stats:{preview:true,method:"raster",pixel:px,width:W,height:H,origin:[X0,Y0],verts,deadIslands:dead,
        tRaster:t1-t0,tLabel:t2-t1,tTrace:t3-t2,tPack:t4-t3,tSolve:t4-t0}};
    }
    // solve(task, opts) -> {islands, stats} in the task's frame (stats.preview = true).
    // opts: method "raster" (default) or "reduce"; core (a PourCore() instance);
    // pixel (frame units per screen pixel; default: the outline's larger side / 1400);
    // raster: view [x0, y0, x1, y1] (frame units) limits the work to the visible part,
    // smooth (pixels, default 0.5) straightens the pixel staircase;
    // reduce: tolPx / gridPx / dropPx (fractions of a pixel) or tol / grid / drop, clip, centre.
    function solve(task,opts={}){return opts.method==="reduce"?solveReduced(task,opts):solveRaster(task,opts);}
    // Guidance: is a raster preview worth showing before the exact solve? Cost
    // model fitted on the dense board (25.6k objects, ten pours; Chrome and JSC):
    // exact ~0.5 us per input vertex with the WebAssembly core (~1.2 us in JS);
    // raster ~0.03 us per vertex plus ~8 ns per pixel of the (view-limited)
    // grid. Worth it when the exact solve is expected to take at least `minMs`
    // (default 50 ms: about three frames) and the preview at most a third of it.
    function worthIt(task,opts={}){
      let verts=0;for(const s of task.shapes)verts+=s.ring.length>>1;
      const p=params(task,opts);let box=outlineBox(task),pixels=0;
      if(box&&opts.view){const v=opts.view;box=[Math.max(box[0],v[0]),Math.max(box[1],v[1]),Math.min(box[2],v[2]),Math.min(box[3],v[3])];}
      if(box&&box[0]<box[2]&&box[1]<box[3])pixels=Math.ceil((box[2]-box[0])/p.pixel+1)*Math.ceil((box[3]-box[1])/p.pixel+1);
      const perVertex=opts.perVertex!=null?+opts.perVertex:opts.engine==="js"?1.2e-3:.5e-3;
      const exactMs=verts*perVertex,previewMs=verts*3e-5+pixels*8e-6,minMs=opts.minMs!=null?+opts.minMs:50;
      return {worth:exactMs>=minMs&&previewMs*3<=exactMs,exactMs,previewMs,verts,pixels};
    }
    return {solve,solveRaster,solveReduced,reduce,params,worthIt,clipRing,simplifyRing,quantise,rasterise,traceRings};
  }
  const api=PourPreview();
  return {...api,PourPreview,source:()=>"const PourPreview="+PourPreview.toString()+";"};
})();
