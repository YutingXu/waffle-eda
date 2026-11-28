"use strict";
// Coarser grids store objects spanning many fine cells, such as an imported
// perimeter or a long bus. Order always follows the document's item sequence.
globalThis.AtriumSpatial = (() => {
  const overlaps=(b,q)=>b[0]<=q[2] && b[2]>=q[0] && b[1]<=q[3] && b[3]>=q[1];
  const encloses=(a,b)=>a[0]<=b[0] && a[1]<=b[1] && a[2]>=b[2] && a[3]>=b[3];
  const key=(x,y)=>x+","+y;
  const DENSE_ENTRY_LIMIT=131072;
  function create(items,getBox,pitch=4) {
    const entries=new Map(), levels=new Map();
    let denseRows=null, denseBox=null;
    let entryCount=0; // The item map can omit older repeated inserts.
    function cells(box,size){
      return [Math.floor(box[0]/size),Math.floor(box[1]/size),Math.floor(box[2]/size),Math.floor(box[3]/size)];
    }
    const count=r=>(r[2]-r[0]+1)*(r[3]-r[1]+1);
    function store(item,order,entry){
      const box=getBox(item);
      if(!box || !box.every(Number.isFinite))return;
      let size=pitch, range=cells(box,size);
      while(count(range)>24){size*=4;range=cells(box,size);}
      if(!levels.has(size))levels.set(size,new Map());
      const grid=levels.get(size),keys=[];
      if(entry){entry.box=box;entry.size=size;entry.keys=keys;}
      else entry={item,order,box,size,keys};
      denseRows=denseBox=null;
      entries.set(item,entry);entryCount++;
      for(let y=range[1];y<=range[3];y++)for(let x=range[0];x<=range[2];x++){
        const k=key(x,y);
        if(!grid.has(k))grid.set(k,{x,y,entries:new Set()});
        grid.get(k).entries.add(entry);keys.push(k);
      }
      return true;
    }
    function insert(item,order){store(item,order);}
    for(let i=0;i<items.length;i++)insert(items[i],i);
    function remove(item){
      const prior=entries.get(item);if(!prior)return;
      const grid=levels.get(prior.size);
      for(const k of prior.keys){const bucket=grid.get(k);bucket.entries.delete(prior);if(!bucket.entries.size)grid.delete(k);}
      if(!grid.size)levels.delete(prior.size);
      denseRows=denseBox=null;
      entries.delete(item);entryCount--;return prior.order;
    }
    function update(item){
      const entry=entries.get(item), rows=denseRows, order=remove(item);
      // A valid move changes bucket membership, with the same entry and rank.
      if(order!==undefined && store(item,order,entry))denseRows=rows;
    }
    function reorder(items){
      for(let order=0;order<items.length;order++){
        const item=items[order],e=entries.get(item);
        if(!e)insert(item,order);
        else if(e.order!==order){e.order=order;denseRows=denseBox=null;}
      }
    }
    // The optional list holds every indexed item once, already in document order.
    // A pure predicate can discard hits before allocating and sorting the result.
    function query(box,ordered,keep){
      // Only switch after exact hits establish a dense view across many buckets.
      // Keep narrow queries and heavily concentrated cells on the grid.
      const limit=ordered && entryCount>=512 && ordered.length===entryCount && entries.size===entryCount &&
        box[2]-box[0]>=8*pitch && box[3]-box[1]>=8*pitch ? entryCount/4 : Infinity;
      const scan=()=>{
        const hits=[];
        if(denseRows&&!keep){
          for(const e of denseRows)if(overlaps(e.box,box))hits.push(e.item);
        }else{
          // Seed the bounded reference array only after validating every rank.
          const rows=!keep && entryCount<=DENSE_ENTRY_LIMIT ? new Array(entryCount) : null;
          let rank=-Infinity, i=0;
          for(const item of ordered){
            const e=entries.get(item);
            if(!e || !(e.order>rank))return;
            rank=+e.order;
            if(rows)rows[i++]=e;
            if(overlaps(e.box,box)&&(!keep||keep(item)))hits.push(item);
          }
          if(rows){if(i!==entryCount)return;denseRows=rows;}
        }
        if(denseRows&&!keep&&hits.length>=limit&&(!denseBox||!encloses(box,denseBox)))denseBox=[box[0],box[1],box[2],box[3]];
        return hits;
      };
      // An enclosing view still contains the previously counted dense hits.
      if(denseBox&&!keep&&limit<Infinity&&encloses(box,denseBox))return scan();
      let bucketsLeft=32;
      const found=new Set();
      const add=keep ? bucket=>{if(bucket)for(const e of bucket.entries)if(overlaps(e.box,box)&&keep(e.item))found.add(e);}
        : bucket=>{if(bucket)for(const e of bucket.entries)if(overlaps(e.box,box))found.add(e);};
      for(const [size,grid] of levels){
        const r=cells(box,size);
        if(count(r)>grid.size*3){
          // At overview zoom the viewport may cover millions of empty cells.
          for(const bucket of grid.values())if(bucket.x>=r[0]&&bucket.x<=r[2]&&bucket.y>=r[1]&&bucket.y<=r[3])add(bucket);
        }else{
          for(let y=r[1];y<=r[3];y++)for(let x=r[0];x<=r[2];x++){
            const bucket=grid.get(key(x,y));add(bucket);
            if(bucket && found.size>=limit && --bucketsLeft===0){
              const hits=scan();if(hits)return hits;
            }
          }
        }
      }
      return Array.from(found).sort((a,b)=>a.order-b.order).map(e=>e.item);
    }
    // Such a viewport intersects at most four cells per stored level.
    const smallQuery = box => box[2]-box[0]<=pitch && box[3]-box[1]<=pitch;
    return {query,insert,update,remove,reorder,smallQuery};
  }
  return {create,overlaps};
})();
