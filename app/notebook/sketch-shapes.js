"use strict";

// Recognition runs only at the end of a deliberate hold. Geometry stays in sheet
// millimetres. A fitted shape projects the existing pressure profile back to ink.
globalThis.AtriumSketchShapes = (() => {
  const TAU = Math.PI * 2;
  const distance = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]);
  const mix = (a,b,t) => a+(b-a)*t;

  function measure(source) {
    const points=[], lengths=[];
    let length=0;
    for(const p of source) {
      const step=points.length?distance(points.at(-1),p):0;
      if(!Number.isFinite(step))return null;
      if(points.length && !step){points[points.length-1]=p;continue;}
      length+=step;points.push(p);lengths.push(length);
    }
    if(!length)return null;
    function at(t) {
      if(t<=0)return points[0];
      if(t>=1)return points.at(-1);
      const d=t*length;
      let left=0,right=lengths.length-1;
      while(right-left>1){const mid=(left+right)>>1;if(lengths[mid]<d)left=mid;else right=mid;}
      const u=(d-lengths[left])/(lengths[right]-lengths[left]),a=points[left],b=points[right];
      return a.map((v,j)=>mix(v,b[j],u));
    }
    return {points,lengths,length,at};
  }

  function rectangle(samples,length,sign,pixel) {
    // The four edge directions of any rotated rectangle agree after
    // quadrupling their angle. Curves and diagonal shortcuts do not.
    let cosine=0,sine=0;
    for(let i=1;i<samples.length;i++){
      const a=samples[i-1],b=samples[i],d=distance(a,b),angle=4*Math.atan2(b[1]-a[1],b[0]-a[0]);
      cosine+=d*Math.cos(angle);sine+=d*Math.sin(angle);
    }
    if(Math.hypot(cosine,sine)<length*.72)return null;
    const angle=Math.atan2(sine,cosine)/4,c=Math.cos(angle),s=Math.sin(angle),origin=samples[0];
    const local=samples.map(p=>[(p[0]-origin[0])*c+(p[1]-origin[1])*s,-(p[0]-origin[0])*s+(p[1]-origin[1])*c]);
    const xs=local.map(p=>p[0]),ys=local.map(p=>p[1]),l=Math.min(...xs),r=Math.max(...xs),t=Math.min(...ys),b=Math.max(...ys);
    const w=r-l,h=b-t,short=Math.min(w,h),perimeter=2*(w+h);
    if(short<14*pixel || length/perimeter<.91 || length/perimeter>1.09)return null;
    const edges=local.map(([x,y])=>Math.min(x-l,r-x,y-t,b-y));
    if(Math.max(...edges)>Math.max(1.5*pixel,short*.075) || edges.reduce((a,b)=>a+b,0)/edges.length>short*.035)return null;
    const corners=[[l,t],[r,t],[r,b],[l,b]];
    if(corners.some(q=>!local.some(p=>distance(p,q)<=short*.12+perimeter/128)))return null;
    // Start on the user's first side, including when they began halfway along it.
    const [x,y]=local[0],ds=[y-t,r-x,b-y,x-l],side=ds.indexOf(Math.min(...ds));
    const phase=[x-l,w+y-t,w+h+r-x,2*w+h+b-y][side];
    const wrap=n=>((n%perimeter)+perimeter)%perimeter;
    const stops=[0,w,w+h,2*w+h].map(n=>wrap(sign*(n-phase))/perimeter);
    function at(u) {
      const n=wrap(phase+sign*(u===1?0:u)*perimeter);
      const [x,y]=n<w?[l+n,t]:n<w+h?[r,t+n-w]:n<2*w+h?[r-(n-w-h),b]:[l,b-(n-2*w-h)];
      return [origin[0]+x*c-y*s,origin[1]+x*s+y*c];
    }
    return {kind:"rectangle",at,stops};
  }

  function fit(trace,{scale,width}) {
    if(!(scale>0) || !(width>0))return null;
    const path=measure(trace);if(!path)return null;
    const samples=Array.from({length:65},(_,i)=>path.at(i/64)),first=samples[0],last=samples.at(-1);
    const xs=samples.map(p=>p[0]),ys=samples.map(p=>p[1]),l=Math.min(...xs),r=Math.max(...xs),t=Math.min(...ys),b=Math.max(...ys);
    const pixel=1/scale,chord=distance(first,last);
    if(chord>=24*pixel && path.length<chord*1.065) {
      const dx=last[0]-first[0],dy=last[1]-first[1],tolerance=Math.max(pixel*1.3,chord*.033);
      if(samples.every(p=>Math.abs(dx*(p[1]-first[1])-dy*(p[0]-first[0]))<=chord*tolerance))
        return {kind:"line",stops:[],at:u=>[mix(first[0],last[0],u),mix(first[1],last[1],u)]};
    }
    const span=Math.max(r-l,b-t),short=Math.min(r-l,b-t);
    if(span<24*pixel || short<14*pixel || chord>Math.min(span*.11,Math.max(2.5*pixel,short*.12)))return null;
    const cx=(r+l)/2,cy=(t+b)/2;
    let turn=0,travel=0;
    for(let i=1;i<samples.length;i++){
      const ax=samples[i-1][0]-cx,ay=samples[i-1][1]-cy,bx=samples[i][0]-cx,by=samples[i][1]-cy;
      const delta=Math.atan2(ax*by-ay*bx,ax*bx+ay*by);
      turn+=delta;travel+=Math.abs(delta);
    }
    if(Math.abs(Math.abs(turn)-TAU)>.35 || travel-Math.abs(turn)>.48)return null;
    const sign=Math.sign(turn),rect=rectangle(samples,path.length,sign,pixel);
    if(rect)return rect;
    if(path.points.length<10 || short/span<.89)return null;
    const radii=samples.map(p=>Math.hypot(p[0]-cx,p[1]-cy)),radius=radii.reduce((a,b)=>a+b,0)/radii.length;
    if(Math.abs(path.length/(TAU*radius)-1)>.075 || radii.some(n=>Math.abs(n-radius)>.095*radius))return null;
    // Large isolated turns belong to a polygon or a scribble.
    for(let i=1;i<samples.length-1;i++){
      const a=samples[i-1],b=samples[i],c=samples[i+1],dx=b[0]-a[0],dy=b[1]-a[1],ex=c[0]-b[0],ey=c[1]-b[1];
      if(Math.abs(Math.atan2(dx*ey-dy*ex,dx*ex+dy*ey))>.65)return null;
    }
    const start=Math.atan2(first[1]-cy,first[0]-cx);
    const error=Math.min(radius/32,Math.max(.008,Math.min(.05,width*.08)));
    const count=Math.min(192,Math.max(24,4*Math.ceil(Math.PI/Math.acos(1-error/radius)/4)));
    return {kind:"circle",stops:Array.from({length:count-1},(_,i)=>(i+1)/count),at:u=>{
      const angle=start+sign*TAU*(u===1?0:u);
      return [cx+radius*Math.cos(angle),cy+radius*Math.sin(angle)];
    }};
  }

  function project(shape,source,preceding=[]) {
    function* samples(){for(const segment of preceding)yield* segment;yield* source;}
    const path=measure(preceding.length?samples():source);
    if(!path)return source;
    // Bound the pressure simplifier even for a coalesced, high-rate pen.
    // Keep each bucket’s extrema and their neighbours so a brief pressure
    // spike stays narrow even if it happened in an earlier stroke chunk.
    const bins=new Map();
    for(let i=0;i<path.points.length;i++){
      const t=path.lengths[i]/path.length,p=path.points[i][2],k=Math.min(63,Math.floor(t*64));
      const bin=bins.get(k);
      if(!bin)bins.set(k,[i,i]);
      else {if(p<path.points[bin[0]][2])bin[0]=i;if(p>path.points[bin[1]][2])bin[1]=i;}
    }
    const last=path.points.length-1,indices=new Set([0,last]);
    for(const pair of bins.values())for(const i of pair){
      indices.add(Math.max(0,i-1));indices.add(i);indices.add(Math.min(i+1,last));
    }
    const profile=[...indices].sort((a,b)=>a-b).map(i=>({t:path.lengths[i]/path.length,p:path.points[i][2]}));
    // Keep a pressure stop if interpolation would lose more than 1.5 of the
    // 255 pressure levels. A constant-pressure line needs only two vertices.
    const stops=new Set([0,1,...shape.stops]),segments=[[0,profile.length-1]];
    while(segments.length) {
      const [a,b]=segments.pop(),start=profile[a],end=profile[b];
      let worst=1.5,split=-1;
      for(let j=a+1;j<b;j++){
        const q=profile[j],error=Math.abs(q.p-mix(start.p,end.p,(q.t-start.t)/(end.t-start.t)));
        if(error>worst){worst=error;split=j;}
      }
      if(split>=0){stops.add(profile[split].t);segments.push([a,split],[split,b]);}
    }
    return [...stops].sort((a,b)=>a-b).map(t=>[...shape.at(t),Math.round(path.at(t)[2])]);
  }

  return Object.freeze({fit,project});
})();
