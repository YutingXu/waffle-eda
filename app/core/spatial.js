"use strict";
// Coarser grids store objects spanning many fine cells, such as an imported
// perimeter or a long bus. Order always follows the document's item sequence.
globalThis.AtriumSpatial = (() => {
  const overlaps=(b,q)=>b[0]<=q[2] && b[2]>=q[0] && b[1]<=q[3] && b[3]>=q[1];
  const key=(x,y)=>x+","+y;
  function create(items,getBox,pitch=4) {
    const entries=new Map(), levels=new Map();
    function cells(box,size){
      return [Math.floor(box[0]/size),Math.floor(box[1]/size),Math.floor(box[2]/size),Math.floor(box[3]/size)];
    }
    const count=r=>(r[2]-r[0]+1)*(r[3]-r[1]+1);
    function insert(item,order){
      const box=getBox(item);
      if(!box || !box.every(Number.isFinite))return;
      let size=pitch, range=cells(box,size);
      while(count(range)>24){size*=4;range=cells(box,size);}
      if(!levels.has(size))levels.set(size,new Map());
      const grid=levels.get(size),keys=[],entry={item,order,box,size,keys};
      entries.set(item,entry);
      for(let y=range[1];y<=range[3];y++)for(let x=range[0];x<=range[2];x++){
        const k=key(x,y);
        if(!grid.has(k))grid.set(k,{x,y,entries:new Set()});
        grid.get(k).entries.add(entry);keys.push(k);
      }
    }
    for(let i=0;i<items.length;i++)insert(items[i],i);
    function remove(item){
      const prior=entries.get(item);if(!prior)return;
      const grid=levels.get(prior.size);
      for(const k of prior.keys){const bucket=grid.get(k);bucket.entries.delete(prior);if(!bucket.entries.size)grid.delete(k);}
      if(!grid.size)levels.delete(prior.size);
      entries.delete(item);return prior.order;
    }
    function update(item){
      const order=remove(item);if(order!==undefined)insert(item,order);
    }
    function reorder(items){
      for(let order=0;order<items.length;order++){
        const item=items[order],e=entries.get(item);
        if(e)e.order=order;else insert(item,order);
      }
    }
    function query(box){
      const found=new Set();
      const add=bucket=>{if(bucket)for(const e of bucket.entries)if(overlaps(e.box,box))found.add(e);};
      for(const [size,grid] of levels){
        const r=cells(box,size);
        if(count(r)>grid.size*3){
          // At overview zoom the viewport may cover millions of empty cells.
          for(const bucket of grid.values())if(bucket.x>=r[0]&&bucket.x<=r[2]&&bucket.y>=r[1]&&bucket.y<=r[3])add(bucket);
        }else{
          for(let y=r[1];y<=r[3];y++)for(let x=r[0];x<=r[2];x++)add(grid.get(key(x,y)));
        }
      }
      return Array.from(found).sort((a,b)=>a.order-b.order).map(e=>e.item);
    }
    return {query,insert,update,remove,reorder};
  }
  return {create,overlaps};
})();
