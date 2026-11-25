"use strict";
const assert=require("node:assert/strict");
for(const m of ["model","parts","sch-objects","mcad-xml","notebook-image-format","notebook-images"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const I=AtriumNotebookImages, F=AtriumNotebookImageFormat;
const ref={sha256:"a".repeat(64),mediaType:"image/png",byteLength:10};
const row={id:"photo",kind:"image",x:13,y:-4,w:33,h:17,extent:[300,210],name:"Board.png",asset:ref,crop:[100000,120000,700000,870000],angle:30};
assert(I.valid(row));
const approx=(a,b,tol=1e-7)=>assert(Math.abs(a-b)<tol,a+" ~= "+b);
const same=(a,b)=>a.forEach((n,i)=>approx(n,b[i]));
for(const angle of [0,30,90,180,270,345]){
  const i={...row,angle},m=I.matrix(i);
  for(const p of [[0,0],[100000,120000],[700000,870000],[450000,888888]])same(I.local(i,I.projectPoint(m,p)),p);
  assert.equal(I.hit(i,I.projectPoint(m,[400000,450000])),0);
  assert(I.hit(i,I.projectPoint(m,[990000,450000]))>4);
  for(const g of I.grips(i)){
    const grip=I.resizeAt(i,g),op=I.grips(i).find(q=>q.u===1-g.u&&q.v===1-g.v).at;
    grip.move([g.at[0]+3,g.at[1]+2]);same(I.grips(i).find(q=>q.u===1-g.u&&q.v===1-g.v).at,op);
    grip.cancel();same([i.x,i.y,i.w,i.h],[row.x,row.y,row.w,row.h]);
  }
}
const mark={id:"mark",kind:"imageMarkup",imageId:row.id,shape:"box",at:[120000,200000],to:[530000,810000],colour:"#aa3344",width:6000};
assert(I.validMark(mark));assert(!I.validMark({...mark,at:[-1,0]}));
for(const mutate of [{name:"dir/file.png"},{crop:[100000,1,100000,2]},{asset:{...ref,sha256:"a".repeat(60)}},{extent:[99999,99999]}])assert(!I.valid({...row,...mutate}));
const {extent,...unknownExtent}=row;
assert(I.valid(unknownExtent));
for(const extent of [null,[0,210],[NaN,210]])assert(!I.valid({...unknownExtent,extent}));
const pdf={...ref,mediaType:"application/pdf"},clip={source:pdf,page:2,name:"Datasheet.pdf",region:[100000,200000,400000,600000]};
assert(I.valid({...row,clip}));assert(!I.valid({...row,clip:{...clip,page:0}}));
const model=AtriumParts.example(),sheet=model.documents.find(d=>d.kind==="schematic"),defs=new Map(model.library.map(d=>[d.id,d]));
const pins=()=>JSON.stringify([...Atrium.connectivity(sheet,defs).byPin]);
const before=pins();sheet.items.push(row,mark);Atrium.validate(model);assert.equal(pins(),before);
const svg=t=>new TextEncoder().encode(t);
const ns=' xmlns="http://www.w3.org/2000/svg" width="40" height="10"';
const safe=F.info(svg('<svg'+ns+'><rect width="40" height="10" fill="#dd2244"/></svg>'));assert.deepEqual(safe.extent,[40,10]);
assert.throws(()=>F.info(svg('<!DOCTYPE svg><svg'+ns+'/>')));
assert.throws(()=>F.info(svg('<svg'+ns+'><image href="https://example.invalid/image"/></svg>')));
assert.throws(()=>F.info(svg('<svg'+ns+'><script>1</script></svg>')));
assert.throws(()=>F.checkedExtent(40000,60000));
assert.deepEqual(I.foreignImage(row,{doc:sheet}).text,"Board.png");
console.log("Notebook image geometry, attached markup, SVG subset, model and electrical invariance passed.");

// Export may continue after another project is opened. Its assets belong to the initiating session.
async function pinnedSession(){
  const secondRef={...ref,sha256:"b".repeat(64)};
  const requested=[],released=[];
  const replacement={readAsset(){throw Error("A different project received an asset read.");}};
  const initiating={readAsset({assetRef}){
    requested.push(assetRef.sha256);
    current=replacement;
    return Promise.resolve({assetRef,bytes:new Uint8Array(assetRef.byteLength)});
  }};
  let current=initiating;
  globalThis.AtriumNavHost={folderProject:()=>current};
  globalThis.AtriumNotebookMedia={decode:async(bytes,assetRef)=>({
    width:1,height:1,bitmap:{},rgba:new Uint8Array(4),close:()=>released.push(assetRef.sha256)
  })};
  const project={documents:[{id:"sheet",items:[row,{...row,id:"second",asset:secondRef}]}]};
  const prepared=await I.prepareAssets(project);
  assert.deepEqual(requested,[ref.sha256,secondRef.sha256]);
  assert(prepared.get(secondRef.sha256).bitmap);
  prepared.release();
  assert.deepEqual(released,requested);
  console.log("Folder ownership and release verified across a mid-export project switch.");
}
pinnedSession().catch(e=>{console.error(e);process.exitCode=1;});
