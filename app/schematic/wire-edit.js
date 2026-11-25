"use strict";

globalThis.AtriumWireEdit = (() => {
  const A=Atrium;
  // Same contact tolerance as the schematic connectivity model, in millimetres.
  const contact=0.00011;
  const copy=p=>p.slice();
  const axis=(a,b)=>a[1]===b[1] && a[0]!==b[0]?0:a[0]===b[0] && a[1]!==b[1]?1:null;
  const same=(a,b)=>A.same(a,b);
  const on=(p,a,b)=>A.nearSegment(p,a,b)<contact;
  function around(a,b,r){
    return [Math.min(a[0],b[0])-r,Math.min(a[1],b[1])-r,Math.max(a[0],b[0])+r,Math.max(a[1],b[1])+r];
  }
  function closest(wire,p){
    let best=null;
    for(let n=0;n+1<wire.points.length;n++){
      const a=wire.points[n],b=wire.points[n+1],dx=b[0]-a[0],dy=b[1]-a[1],l=dx*dx+dy*dy;
      if(!l)continue;
      const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/l));
      let at=t===0?a:t===1?b:[a[0]+t*dx,a[1]+t*dy];
      if(same(at,a))at=a;else if(same(at,b))at=b;
      const distance=Math.hypot(at[0]-p[0],at[1]-p[1]);
      if(!best || distance<best.distance)best={index:n,at,distance};
    }
    return best;
  }
  // Collect only electrically meaningful locations. A crossing of two bare
  // segment interiors is deliberately absent until a junction is placed.
  function anchors(doc,wire,defs,a,b,query){
    const points=new Map();
    const add=p=>{if(on(p,a,b))points.set(A.pointKey(p),p);};
    for(const item of query?query(around(a,b,contact)):doc.items){
      if(item===wire)continue;
      if(item.kind==="part"){
        for(const pin of A.pins(item,defs.get(item.def),"schematic"))add(pin.at);
      }else if(item.kind==="junction" || item.kind==="netlabel")add([item.x,item.y]);
      else if(item.kind==="wire"){
        for(let i=0;i<item.points.length;i++){
          add(item.points[i]);
          if(i){
            const f=item.points[i-1],t=item.points[i];
            if(on(a,f,t))add(a);
            if(on(b,f,t))add(b);
          }
        }
      }
    }
    return [...points.values()];
  }
  function endpointAt(wire,press,tolerance){
    if(wire?.kind!=="wire" || wire.points.length<2)return null;
    const last=wire.points.length-1,distance=p=>Math.hypot(p[0]-press[0],p[1]-press[1]);
    const firstDistance=distance(wire.points[0]),lastDistance=distance(wire.points[last]);
    if(Math.min(firstDistance,lastDistance)>tolerance)return null;
    return firstDistance<=lastDistance?0:last;
  }
  function moveEnd(doc,wire,defs,press,query,index,snap){
    const original=wire.points.map(copy),points=index===0?original:original.slice().reverse();
    const [tip,next]=points,along=axis(tip,next);
    // The first tap along the old segment stays connected when the endpoint passes it.
    const dist=p=>Math.hypot(p[0]-tip[0],p[1]-tip[1]);
    const fixed=anchors(doc,wire,defs,tip,next,query).filter(p=>!same(p,tip)).reduce((near,p)=>dist(p)<dist(near)?p:near,next);
    return {pointsAt(pointer,grid){
      if(same(pointer,press))return original.map(copy);
      const aim=tip.map((v,k)=>v+pointer[k]-press[k]);
      const target=snap?snap(aim):grid>0?aim.map(v=>A.snap(v,grid)):aim;
      if(same(target,tip))return original.map(copy);
      const result=[copy(target)],add=p=>{if(!same(result.at(-1),p))result.push(copy(p));};
      if(along!==null){const bend=fixed.slice();bend[along]=target[along];add(bend);}
      add(fixed);points.slice(1).forEach(add);
      if(result.length<2)return original.map(copy);
      return index===0?result:result.reverse();
    }};
  }
  // Wires joined end to end at a dragged end follow it ([{wire, original, session}]).
  function joined(doc,wire,defs,press,query,tip,snap){
    const out=[];
    for(const o of query?query(around(tip,tip,contact)):doc.items){
      const end=o===wire||o.kind!=="wire"?-1:same(o.points[0],tip)?0:o.points.findLastIndex(p=>same(p,tip));
      if(end===0||end>0&&end===o.points.length-1)out.push({wire:o,original:o.points,session:moveEnd(doc,o,defs,press,query,end,snap)});
    }
    return out;
  }
  function begin(doc,wire,defs,press,query,grip){
    if(doc.kind!=="schematic" || wire?.kind!=="wire")return null;
    if(grip){const end=endpointAt(wire,press,grip.tolerance);if(end!==null){
      const s=moveEnd(doc,wire,defs,press,query,end,grip.snap);s.followers=joined(doc,wire,defs,press,query,wire.points[end],grip.snap);return s;}}
    const pick=closest(wire,press);if(!pick)return null;
    const original=wire.points.map(copy),index=pick.index,a=original[index],b=original[index+1];
    const along=axis(a,b);if(along===null)return null;
    const across=1-along,forward=Math.sign(b[along]-a[along]);
    const support=anchors(doc,wire,defs,a,b,query);
    // A tap inside a long wire holds the adjacent span in place. Move only
    // the interval under the pointer, even if the native wire is a single record.
    const stops=new Set([a[along],b[along]]);
    for(const p of support)if((p[along]-a[along])*forward>0 && (b[along]-p[along])*forward>0)stops.add(p[along]);
    const ordered=[...stops].sort((x,y)=>(x-y)*forward);
    let n=0;while(n<ordered.length-2 && (pick.at[along]-ordered[n+1])*forward>=0)n++;
    function at(v){const p=a.slice();p[along]=v;return p;}
    const left=at(ordered[n]),right=at(ordered[n+1]),first=same(left,a),last=same(right,b);
    let lower=-Infinity,upper=Infinity;
    // At an unanchored bend the adjoining perpendicular segment stretches.
    // Clamp shortening to its nearest attached pin, branch, or other end.
    function stretch(endpoint,neighbor){
      if(!neighbor || support.some(q=>same(q,endpoint)) || axis(endpoint,neighbor)!==across)return false;
      const sign=Math.sign(neighbor[across]-endpoint[across]);
      for(const q of [neighbor,...anchors(doc,wire,defs,endpoint,neighbor,query)]){
        const offset=q[across]-endpoint[across];
        if(offset*sign<=0)continue;
        if(sign<0)lower=Math.max(lower,offset);else upper=Math.min(upper,offset);
      }
      return true;
    }
    const slideLeft=first && stretch(a,original[index-1]);
    const slideRight=last && stretch(b,original[index+2]);
    return {
      pointsAt(pointer,grid){
        let delta=pointer[across]-press[across];
        if(Math.abs(delta)>1e-10 && grid>0)delta=A.snap(a[across]+delta,grid)-a[across];
        delta=Math.max(lower,Math.min(upper,delta));
        if(Math.abs(delta)<1e-10)return original.map(copy);
        const result=[];
        function add(p){if(!result.length || !same(result[result.length-1],p))result.push(copy(p));}
        const displaced=p=>{const moved=copy(p);moved[across]+=delta;return moved;};
        original.slice(0,index).forEach(add);
        if(!first)add(a);
        if(!slideLeft)add(left);
        add(displaced(left));add(displaced(right));
        if(!slideRight)add(right);
        if(!last)add(b);
        original.slice(index+2).forEach(add);
        return result;
      }
    };
  }
  function place(doc,mode,p,tolerance,query){
    const no=message=>({changed:false,message});
    if(doc.kind!=="schematic" || !["junction","split-wire"].includes(mode))return no("Choose a schematic wire.");
    const candidates=query?query(around(p,p,tolerance+contact)):doc.items;
    let target=null;
    for(const wire of candidates){
      if(wire.kind!=="wire")continue;
      const hit=closest(wire,p);
      if(!hit || hit.distance>tolerance+contact)continue;
      const inside=!same(hit.at,wire.points[0])&&!same(hit.at,wire.points.at(-1));
      if(!target || hit.distance<target.distance-1e-9 || (Math.abs(hit.distance-target.distance)<1e-9 && inside&&!target.inside))target={...hit,wire,inside};
    }
    if(!target)return no("Choose a wire or a crossing.");
    const {wire,at,index}=target;
    const junction=candidates.find(i=>i.kind==="junction" && same([i.x,i.y],at));
    if(mode==="junction"){
      if(junction)return no("A junction already exists here.");
      return {changed:true,message:"Junction placed",apply(){doc.items.push({id:A.id(),kind:"junction",x:at[0],y:at[1]});}};
    }
    if(!target.inside)return no("Choose a point between the wire ends.");
    if(!junction){
      // Splitting creates an endpoint. At a bare crossing it would also
      // join two previously distinct signals under schematic contact rules.
      let connects=false,crossed=false;
      for(const i of candidates){
        if(i.kind==="wire"){
          if(i.points.some(point=>same(point,at)))connects=true;
          if(i!==wire && i.points.some((point,j)=>j>0&&on(at,i.points[j-1],point)))crossed=true;
        }
        if(i.kind==="netlabel"&&same([i.x,i.y],at))connects=true;
      }
      if(crossed&&!connects)return no("This is a bare crossing. Place a junction to connect it, or split the wire away from the crossing.");
    }
    return {changed:true,message:"Wire split",apply(){
      const left=wire.points.slice(0,index+1).map(copy),right=wire.points.slice(index+1).map(copy);
      if(!same(left.at(-1),at))left.push(copy(at));
      if(!same(right[0],at))right.unshift(copy(at));
      const other={...wire,id:A.id(),points:right};
      delete other.schSource;delete other.sourceRecord;
      wire.points=left;
      doc.items.splice(doc.items.indexOf(wire)+1,0,other);
    }};
  }
  return {begin,place,endpointAt};
})();
