"use strict";
// AtriumConnectivityLive (lazy, prefetched at idle): incremental connectivity.js inspect().
// Per document: each item's entities and features (kept while the item's JSON, less non-copper part fields, and its footprint's
// definition are unchanged), the contact graph between features (a grid finds the neighbours of
// changed features only), and each net's airwires
// while its islands are the same entities. The result equals inspectFull's (nets, shorts, airwires,
// excluded, unassigned): shorts name the contact the sweep would have found first, so they are
// rebuilt in sweep order (Kruskal over the contact edges of shorted islands). stats.candidates is
// the pairs tested in this pass. Board cutout changes invalidate the copper cache.
globalThis.AtriumConnectivityLive = (() => {
  // An older connectivity.js (no kit) keeps its full pass.
  if(!globalThis.AtriumConnectivity?.kit)return Object.freeze({inspect:()=>null});
  const {EPS,cmp,compareKey,sets,contact,builder,airwireEdges,joinIslandLinks}=AtriumConnectivity.kit;
  const caches=new WeakMap(),BIG=24,CHUNK=2048,CUTOUT_CHUNK=64,REPLACEMENT_CHUNK=32,AIR_LIMIT=512,NEXT_TASK=Symbol();
  // An item's print: its JSON, less the part fields no copper depends on (the builder never reads
  // them), so a BOM edit of a comment, parameter or DNP flag keeps the part's features and contacts.
  const NON_COPPER=new Set(["value","parameters","dnp"]);
  function printOf(i){
    if(i?.kind!=="part"||!(Object.hasOwn(i,"value")||Object.hasOwn(i,"parameters")||Object.hasOwn(i,"dnp")))return JSON.stringify(i);
    const o={};for(const k of Object.keys(i))if(!NON_COPPER.has(k))o[k]=i[k];
    return JSON.stringify(o);
  }
  const overlaps=(a,b)=>!(a.box[0]>b.box[2]+EPS||b.box[0]>a.box[2]+EPS||a.box[1]>b.box[3]+EPS||b.box[1]>a.box[3]+EPS)&&!(a.layers[1]<b.layers[0]||b.layers[1]<a.layers[0]);
  function cellsOf(c,box,fn){
    const x0=Math.floor((box[0]-EPS)/c.cell),x1=Math.floor((box[2]+EPS)/c.cell),y0=Math.floor((box[1]-EPS)/c.cell),y1=Math.floor((box[3]+EPS)/c.cell);
    for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)fn(x*1048576+y);
  }
  const spanCells=(c,box)=>Math.max((box[2]-box[0])/c.cell,(box[3]-box[1])/c.cell);
  function place(c,f){
    if(!f.box.every(Number.isFinite))return;
    if(spanCells(c,f.box)>BIG){c.big.add(f);return;}
    cellsOf(c,f.box,k=>{let l=c.grid.get(k);if(!l)c.grid.set(k,l=[]);l.push(f);});
  }
  function unplace(c,f){
    if(c.big.delete(f)||!f.box.every(Number.isFinite))return;
    cellsOf(c,f.box,k=>{const l=c.grid.get(k);if(!l)return;const i=l.indexOf(f);if(i>=0){l[i]=l[l.length-1];l.pop();}if(!l.length)c.grid.delete(k);});
  }
  function link(c,a,b){const e={a,b};c.edges.add(e);(a.links||=[]).push(e);(b.links||=[]).push(e);}
  function unlink(c,f){
    for(const e of f.links||[]){c.edges.delete(e);const o=e.a===f?e.b:e.a;if(o.links){const i=o.links.indexOf(e);if(i>=0){o.links[i]=o.links[o.links.length-1];o.links.pop();}}}
    f.links=null;
  }
  // A feature's contacts with what is already placed; then it is placed itself.
  function connect(c,f,stamp,all){
    let tested=0;
    const test=g=>{if(g.q===stamp||g.e===f.e)return;g.q=stamp;if(!overlaps(f,g))return;tested++;if(contact(f,g))link(c,f,g);};
    if(!f.box.every(Number.isFinite)){c.odd.add(f);return 0;}
    if(spanCells(c,f.box)>BIG){for(const r of all)for(const g of r.feats)if(g.placed)test(g);}
    else{cellsOf(c,f.box,k=>{const l=c.grid.get(k);if(l)for(const g of l)test(g);});for(const g of c.big)test(g);}
    place(c,f);f.placed=true;
    return tested;
  }
  // Views: online DRC (drc-view.js) checks a neighbourhood as {...board, items: nearby}, a new object
  // each time that shares every other field with its board. A cache for it would be built once and
  // dropped; building one tests and keeps every contact, where the full pass stops at the first
  // contact that joins two islands, so a view takes the full pass (on a board of stacked parts, where
  // every pad touches every other, that is milliseconds against a second).
  const boards=new Map(),Weak=globalThis.WeakRef;
  function isView(doc){
    const b=Weak&&doc.id!=null?boards.get(doc.id)?.deref():null;
    if(!b||b===doc||b.items===doc.items)return false;
    const ks=Object.keys(doc);if(ks.length!==Object.keys(b).length)return false;
    for(const k of ks)if(k!=="items"&&doc[k]!==b[k])return false;
    return true;
  }
  // Stable sort in runs so a congested shorted island can return to input mid-sweep.
  function* sortRuns(values, compare, current){
    const n=values.length;
    if(n<=CHUNK)return values.sort(compare);
    let src=values,dst=new Array(n);
    for(let start=0;start<n;start+=CHUNK){
      const run=src.slice(start,start+CHUNK).sort(compare);
      for(let i=0;i<run.length;i++)src[start+i]=run[i];
      yield;if(!current())return null;
    }
    for(let width=CHUNK;width<n;width*=2){
      for(let start=0;start<n;start+=2*width){
        const mid=Math.min(start+width,n),end=Math.min(mid+width,n);
        let a=start,b=mid;
        for(let i=start;i<end;i++){
          dst[i]=b===end||a<mid&&compare(src[a],src[b])<=0?src[a++]:src[b++];
          if((i+1)%CHUNK===0){yield;if(!current())return null;}
        }
      }
      [src,dst]=[dst,src];
    }
    return src;
  }
  // Multiple feature contacts between the same two entities are one adjacency.
  function neighbours(record,out){
    if(record.ents.length>32||record.feats.length>128)return false;
    for(const e of record.ents)out.set(e,new Set());
    let contacts=0;
    for(const f of record.feats){
      const links=f.links||[];
      if((contacts+=links.length)>256)return false;
      for(const edge of links)out.get(f.e).add((f===edge.a?edge.b:edge.a).e);
    }
    return true;
  }
  function* replacementPlan(removed,added,air,current){
    // The local scan replaces existing records in matching item order.
    const before=new Map(),prior=new Map(),swaps=new Map(),names=new Set();
    let members=0;
    for(let k=0;k<removed.length;k++){
      if(k&&k%REPLACEMENT_CHUNK===0){yield;if(!current())return null;}
      const [,old]=removed[k],[,next]=added[k];
      if(old.ents.length!==next.ents.length||old.feats.length!==next.feats.length||
        old.excluded!==next.excluded||old.unassigned!==next.unassigned)return null;
      for(let j=0;j<old.ents.length;j++){
        const a=old.ents[j],b=next.ents[j];
        if(a.key!==b.key||a.kind!==b.kind||a.net!==b.net)return null;
        // Reject oversized airwire work before recording neighbours for the group.
        if(a.net&&!names.has(a.net)){
          const islands=air.get(a.net)?.islands;
          if(!islands||islands.length>AIR_LIMIT)return null;
          for(const island of islands)if((members+=island.length)>AIR_LIMIT)return null;
          names.add(a.net);
        }
        prior.set(b,a);swaps.set(a,b);b.n=a.n;
      }
      if(!neighbours(old,before))return null;
      next.index=old.index;
    }
    return {before,prior,swaps,names};
  }
  // Unchanged neighbours preserve every island. Match all replacement entities
  // together so contacts between two moved items compare against their old endpoints.
  function* sameNeighbours(added,{before,prior},current){
    const after=new Map();
    for(let k=0;k<added.length;k++){
      if(k&&k%REPLACEMENT_CHUNK===0){yield;if(!current())return false;}
      after.clear();
      if(!neighbours(added[k][1],after))return false;
      for(const [b,now] of after){
        const was=before.get(prior.get(b));
        if(was.size!==now.size)return false;
        for(const e of now)if(!was.has(prior.get(e)||e))return false;
      }
    }
    return true;
  }
  function updateAir(c,last,plan,candidates){
    let nets=last.nets,airwires=last.airwires;
    if(plan?.names.size){
      const {swaps}=plan,names=[...plan.names];
      const groups=names.map(name=>c.air.get(name).islands.map(members=>members.map(e=>swaps.get(e)||e)));
      const batch=globalThis.AtriumEngine?.airwires?.(groups,names);
      const air=new Map(c.air);
      for(const [k,name] of names.entries())air.set(name,{islands:groups[k],links:batch?batch[k]:airwireEdges(groups[k],name)});
      nets=[];airwires=[];
      for(const net of last.nets){
        const links=air.get(net.name).links;
        nets.push(links.length===net.missing?net:{...net,missing:links.length});
        for(const link of links)airwires.push(link);
      }
      c.air=air;
    }
    return {...last,nets,airwires,stats:{...last.stats,candidates,contacts:c.edges.size}};
  }
  function* inspectStages(doc,defs,journal,cache=caches,options){
    const holes=globalThis.AtriumBoardShape?.holes?.(doc),cutouts=holes?.length?holes:null;
    const chunk=cutouts?CUTOUT_CHUNK:CHUNK;
    let c=cache.get(doc);
    if(c&&(c.preparing||c.cutouts!==cutouts))c=null;
    if(!c){
      if(isView(doc))return null;
      c={items:new Map(),grid:new Map(),big:new Set(),odd:new Set(),edges:new Set(),cell:0,air:new Map(),stamp:0,defIds:new Map(),cutouts};cache.set(doc,c);
      if(Weak&&doc.id!=null)boards.set(doc.id,new Weak(doc));
    }
    const drop=()=>cache.delete(doc);
    const work=c.work=(c.work||0)+1;
    const current=()=>cache.get(doc)===c&&c.work===work;
    // The editor calls this after the edit frame, when it can share the recorded changes.
    // Plain design or preview callers continue to check the items' actual content.
    const delta=journal?.recordedChanges?.(doc,c.seq)??journal?.changed(doc,c.seq),outer=journal?.outer();
    const changed=c.journal===journal&&c.outer===outer&&c.defs===defs?delta?.ids:null;
    const touched=changed&&delta.items.size===changed.size&&c.docItems===doc.items&&c.itemCount===doc.items.length?
      [...delta.items.values()]:null;
    const local=touched&&touched.every(i=>c.items.has(i));
    const previous=c.projection, ties=globalThis.AtriumNetTies;
    const plain=delta?.seq!=null&&outer!=null&&!doc.pcbDrawing?.sourceFill&&!doc.pcbDrawing?.pours?.some(r=>r.links?.length>1);
    const reuse=plain&&local&&previous&&c.ties===ties&&touched.every(i=>
      doc.items[c.items.get(i).index]===i&&(!ties||ties.isTiePart&&!ties.isTiePart(i,defs)));
    // A part's entities depend on its definition too: each definition's JSON gets a small number.
    const B=builder(doc,defs,!!cutouts),defPrints=new Map(),order=[],added=[],removed=[],seen=local?null:new Set();
    const defPrint=id=>{let v=defPrints.get(id);if(v===undefined){const d=defs.get(id),j=d?JSON.stringify(d):"";v=c.defIds.get(j);if(v===undefined){if(c.defIds.size>4096)c.defIds.clear();c.defIds.set(j,v=c.defIds.size+1);}defPrints.set(id,v);}return v;};
    let scanned=0;
    for(const i of local?touched:doc.items){
      if(scanned&&scanned%chunk===0){yield;if(!current())return;}
      scanned++;
      if(seen?.has(i)){drop();return null;}
      seen?.add(i);
      const def=i?.kind==="part"?defPrint(i.def):0;
      let r=c.items.get(i);
      if(r&&r.def===def&&changed&&!changed.has(i.id)){order.push(r);continue;}
      const print=printOf(i);
      if(!r||r.print!==print||r.def!==def){
        if(r)removed.push([i,r]);
        B.entities=[];B.features=[];B.excluded=0;B.unassigned=0;B.item(i);
        r={print,def,ents:B.entities,feats:B.features,excluded:B.excluded,unassigned:B.unassigned};
        r.feats.forEach((f,k)=>{f.ord=k;});
        added.push([i,r]);
      }
      if(!local)order.push(r);
    }
    if(seen)for(const [i,r] of c.items)if(!seen.has(i))removed.push([i,r]);
    const plan=reuse&&removed.length?yield* replacementPlan(removed,added,c.air,current):null;
    if(!current())return;
    const entities=[];let excluded=0,unassigned=0,featureCount=0;
    const gather=r=>{for(const e of r.ents){e.n=entities.length;entities.push(e);}excluded+=r.excluded;unassigned+=r.unassigned;featureCount+=r.feats.length;};
    // Once contacts start changing, a superseding inspection needs a fresh
    // graph until all replacements have been linked. Extraction above only
    // reads the retained graph and can be abandoned without discarding it.
    c.preparing=true;c.projection=null;
    let candidates=0,prepared=false;
    try{
      let n=0;
      for(const [i,r] of removed){
        for(const f of r.feats){
          unlink(c,f);unplace(c,f);c.odd.delete(f);f.placed=false;
          if(++n%CHUNK===0){yield;if(!current())return;}
        }
        c.items.delete(i);
      }
      for(const [i,r] of added)c.items.set(i,r);
      if(!local){
        for(let k=0;k<order.length;k++){
          if(k&&k%CHUNK===0){yield;if(!current())return;}
          const r=order[k];r.index=k;gather(r);
        }
        if(ties?.prepare(doc,defs,entities))return null;
      }
      if(!c.cell){
        let area=0,count=0;
        for(const [,r] of added)for(const f of r.feats)if(f.box.every(Number.isFinite)){area+=(f.box[2]-f.box[0])*(f.box[3]-f.box[1]);count++;}
        c.cell=Math.min(50,Math.max(.25,2*Math.sqrt(area/Math.max(1,count))||1));
      }
      n=0;
      for(const [,r] of added)for(const f of r.feats){
        candidates+=connect(c,f,++c.stamp,local?c.items.values():order);
        if(++n%chunk===0){yield;if(!current())return;}
      }
      prepared=true;
    }finally{
      c.preparing=false;
      if(!prepared&&current())drop();
    }
    // The contact graph is consistent. Assemble exact islands and airwires in
    // cancellable slices before allowing the edit's live pour tiles to start.
    yield;
    if(!current())return;
    function publish(result){
      c.projection=plain&&!result.shorts.length?result:null;c.ties=ties;
      c.journal=journal;c.seq=delta?.seq;c.outer=outer;c.defs=defs;c.docItems=doc.items;c.itemCount=doc.items.length;
      return result;
    }
    if(reuse){
      const matching=!removed.length||plan&&(yield* sameNeighbours(added,plan,current));
      if(!current())return;
      if(matching)return publish(updateAir(c,previous,plan,candidates));
    }
    if(local){
      for(let n=0;n<doc.items.length;n++){
        if(n&&(n&2047)===0){yield;if(!current())return;}
        const i=doc.items[n],r=c.items.get(i);
        r.index=n;order.push(r);gather(r);
      }
      if(globalThis.AtriumNetTies?.prepare(doc,defs,entities)){drop();return null;}
    }
    // Islands: every contact edge, then pours that are current join their copper.
    const union=sets(entities.length);
    let nEdges=0;
    for(const e of c.edges){
      union.join(e.a.e.n,e.b.e.n);
      if((++nEdges&2047)===0){yield;if(!current())return;}
    }
    const P=globalThis.AtriumPolygonPour;
    if(P?.contactRegions&&doc.pcbDrawing?.pours?.some(r=>r.links?.length>1)){
      // Cutout boards with retained artwork can need a whole copper signature.
      if(cutouts){yield NEXT_TASK;if(!current())return;}
      const copper=P.contactRegions(doc,defs,options);
      joinIslandLinks(union,entities,copper);
    }
    const roots=new Map(),byNet=new Map();
    for(let n=0;n<entities.length;n++){
      if(n&&(n&2047)===0){yield;if(!current())return;}
      const e=entities[n],r=union.root(n);
      let g=roots.get(r);if(!g)roots.set(r,g=[]);g.push(e);
      if(!e.net)continue;
      let groups=byNet.get(e.net);if(!groups)byNet.set(e.net,groups=new Map());
      let h=groups.get(r);if(!h)groups.set(r,h=[]);h.push(e);
    }
    const shorts=[],shorted=new Set(),shortedRoots=new Set();
    let nRoots=0;
    for(const [root,group] of roots){
      let first=null;for(const e of group)if(e.net){if(first===null)first=e.net;else if(e.net!==first){shortedRoots.add(root);break;}}
      if((++nRoots&2047)===0){yield;if(!current())return;}
    }
    if(shortedRoots.size){
      // The sweep's first contacts: features in sweep order, edges in visit order, a fresh union.
      let wx=0,wy=0,x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity,n=0;
      for(const r of order)for(const {box} of r.feats){
        const [loX,loY,hiX,hiY]=box;
        wx+=hiX-loX;wy+=hiY-loY;
        if(Number.isFinite(loX)&&Number.isFinite(loY)){x0=Math.min(x0,loX);y0=Math.min(y0,loY);x1=Math.max(x1,loX);y1=Math.max(y1,loY);}
        if(Number.isFinite(hiX)&&Number.isFinite(hiY)){x0=Math.min(x0,hiX);y0=Math.min(y0,hiY);x1=Math.max(x1,hiX);y1=Math.max(y1,hiY);}
        if(++n%CHUNK===0){yield;if(!current())return;}
      }
      const axis=wx/Math.max(EPS,x1-x0)<=wy/Math.max(EPS,y1-y0)?0:1,other=1-axis;
      const rank=(a,b)=>a.box[axis]-b.box[axis]||a.box[other]-b.box[other]||compareKey(a.e,b.e)||(a.e.n-b.e.n)||(a.ord-b.ord);
      const list=[];
      for(const e of c.edges){
        if(shortedRoots.has(union.root(e.a.e.n)))list.push(rank(e.a,e.b)<=0?[e.a,e.b]:[e.b,e.a]);
        if(++n%CHUNK===0){yield;if(!current())return;}
      }
      const sorted=yield* sortRuns(list,(p,q)=>rank(p[0],q[0])||rank(p[1],q[1]),current);
      if(!sorted)return;
      const sweep=sets(entities.length),direct=new Map();
      for(const [x,y] of sorted){
        if(++n%CHUNK===0){yield;if(!current())return;}
        if(!sweep.join(x.e.n,y.e.n))continue;
        const first=x.e,second=y.e;
        if(!(first.net&&second.net&&first.net!==second.net))continue;
        const root=union.root(x.e.n),ordered=compareKey(first,second)<=0?[first,second]:[second,first],previous=direct.get(root);
        if(!previous||compareKey(ordered[0],previous[0])<0||compareKey(ordered[0],previous[0])===0&&compareKey(ordered[1],previous[1])<0)direct.set(root,ordered);
      }
      for(const [root,group] of roots){
        if(!shortedRoots.has(root))continue;
        const namesSet=new Set(),pair=direct.get(root);
        let first=null,second=null;
        for(const e of group){
          if(++n%CHUNK===0){yield;if(!current())return;}
          if(!e.net)continue;
          namesSet.add(e.net);
          if(pair)continue;
          if(!first||compareKey(e,first)<0){if(first&&e.net!==first.net)second=first;first=e;}
          else if(e.net!==first.net&&(!second||compareKey(e,second)<0))second=e;
        }
        const names=[...namesSet].sort(cmp);
        names.forEach(name=>shorted.add(name));
        const [from,to]=pair||[first,second];
        shorts.push({nets:names,direct:!!pair,from:from.anchors[0].at,to:to.anchors[0].at,fromId:from.id,toId:to.id,fromLabel:from.label,toLabel:to.label});
      }
      const shortKey=s=>JSON.stringify([s.nets,s.fromId,s.toId,s.from]);
      const ordered=yield* sortRuns(shorts.map(s=>[shortKey(s),s]),(a,b)=>cmp(a[0],b[0]),current);
      if(!ordered)return;
      for(let k=0;k<ordered.length;k++)shorts[k]=ordered[k][1];
    }
    yield;
    if(!current())return;
    // Airwires: only nets whose islands changed are solved again.
    const names=[...byNet.keys()].sort(cmp),groups=names.map(n=>[...byNet.get(n).values()]),todo=[];
    const same=(a,b)=>{if(!b||a.length!==b.length)return false;for(let k=0;k<a.length;k++){const x=a[k],y=b[k];if(x.length!==y.length)return false;for(let j=0;j<x.length;j++)if(x[j]!==y[j])return false;}return true;};
    const air=new Map();
    names.forEach((name,k)=>{const prev=c.air.get(name);if(same(groups[k],prev?.islands))air.set(name,prev);else todo.push(k);});
    for(let start=0;start<todo.length;start+=8){
      const group=todo.slice(start,start+8);
      const batch=globalThis.AtriumEngine?.airwires?.(group.map(k=>groups[k]),group.map(k=>names[k]));
      for(const [j,k] of group.entries())air.set(names[k],{islands:groups[k],links:batch?batch[j]:airwireEdges(groups[k],names[k])});
      if(start+8<todo.length){yield;if(!current())return;}
    }
    const nets=[],airwires=[];let count=0;
    for(const [k,name] of names.entries()){
      const islands=groups[k];let pads=0,tracks=0,vias=0;
      for(const g of islands)for(const i of g){
        if(i.kind==="pad")pads++;else if(i.kind==="track")tracks++;else if(i.kind==="via")vias++;
        if(++count%CHUNK===0){yield;if(!current())return;}
      }
      const links=air.get(name).links;
      nets.push({name,pads,tracks,vias,islands:islands.length,missing:links.length,shorted:shorted.has(name)});
      for(const l of links)airwires.push(l);
    }
    c.air=air;
    const sourceNotes=(doc.notes||[]).filter(note=>/polygon|pour|plane|region|pad.stack/i.test(note));
    return publish({nets,airwires,shorts,excluded,unassigned,stats:{objects:entities.length,features:featureCount,candidates,contacts:c.edges.size},sourceNotes});
  }
  function inspect(doc,defs,journal,options){const work=inspectStages(doc,defs,journal,undefined,options);let r=work.next();while(!r.done)r=work.next();return r.value;}
  function* stages(doc,defs,journal,cache){
    const result=yield* inspectStages(doc,defs,journal,cache);
    if(result!==null)return result;
    yield NEXT_TASK;
    return AtriumConnectivity.inspectFull(doc,defs);
  }
  // The pass run now for up to `budget` ms: {result,cost} when it finished, else {work,cost}.
  function quick(doc,defs,journal,budget){
    const at=performance.now(),work=stages(doc,defs,journal);let r=work.next();
    while(!r.done&&r.value!==NEXT_TASK&&performance.now()-at<budget)r=work.next();
    const cost=performance.now()-at;return r.done?{result:r.value,cost}:{work,cost};
  }
  // started: a number runs the pass now for that many ms first (in the edit's own frame, with its
  // geometry): finished, it is published at once (publish(result,cost,true)). Or quick()'s pass.
  function deferAirwires(doc,defs,journal,stage,key,ready,publish,started){
    if(typeof started==="number"){const q=quick(doc,defs,journal,started);if(q.result){if(ready())publish(q.result,q.cost,true);return {current:()=>false,cancel(){}};}started=q;}
    let job, work, cost=0;
    const clock=()=>performance.now();
    const usable=()=>job.current()&&ready();
    const cancel=()=>{job.cancel();work?.return();};
    const continueProjection=()=>stage("airwires",key,projectAirwires,{short:true});
    function projectAirwires(_current,deadline){
      if(!usable()){cancel();return;}
      const at=clock(),budget=Math.min(4,deadline?.timeRemaining()??4);
      let result=work.next();while(!result.done&&result.value!==NEXT_TASK&&clock()-at<budget)result=work.next();
      cost+=clock()-at;
      if(result.done){
        const use=usable();
        if(use&&!result.value){
          // Another consumer used the same board cache. A still-visible view
          // can finish on its own graph without displacing the other pass.
          work=stages(doc,defs,journal,new WeakMap());job=continueProjection();return;
        }
        cancel();if(use)publish(result.value,cost);
      }
      else job=continueProjection();
    }
    if(started?.work){work=started.work;cost=started.cost;job=continueProjection();return {current:()=>job.current(),cancel};}
    job=stage("connectivity",key,()=>{
      if(!usable()){cancel();return;}
      const at=clock();
      work=stages(doc,defs,journal);
      work.next();cost+=clock()-at;
      job=continueProjection();
    });
    return {current:()=>job.current(),cancel};
  }
  return Object.freeze({inspect, stages, quick, deferAirwires});
})();
