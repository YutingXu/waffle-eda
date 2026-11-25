"use strict";
// Drawing extents, organisational selection and its real undo journal under Node and JavaScriptCore.
const assert = require("node:assert/strict");
for (const name of ["model","spatial","sch-appearance","sch-objects","pcb-appearance","canvas","edit-selection","undo-store","hierarchy","navigator-panel","minimap"])
  require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const A=Atrium, S=AtriumSchObjects, P=AtriumSchAppearance, U=AtriumUndoStore;
const defs=new Map([["symbol",{id:"symbol",name:"Symbol",symbol:{pins:[{number:"1",x:-1,y:0},{number:"2",x:1,y:0}],shapes:[]}}]]);
const project=A.project("Frame test",[...defs.values()]), doc=project.documents[0];
const makeFrame=(id,x,y,w,h,text=id)=>({...S.make("frame",[x,y],{w,h,text}),id});
const frame=makeFrame("frame",-100,-50,70,48), nested=makeFrame("nested",-90,-40,30,20,"Channel");
const peer=makeFrame("peer",-100,-50,70,48,"Channel"), partial=makeFrame("partial",-80,-12,40,20);
const inside={kind:"wire",id:"inside",points:[[-96,-46],[-90,-46]]};
const part={kind:"part",id:"part",def:"symbol",ref:"R1",value:"1k",x:-50,y:-30};
const lead={kind:"wire",id:"lead",points:[[-49,-30],[20,-30]]};
const polygon={kind:"graphic",id:"polygon",points:[[-70,-25],[3,-16],[-73,-19]]};
const bus=S.make("bus",[0,0],{points:[[-101,-40],[0,-40]]});
const label={kind:"netlabel",id:"boundary",x:-30,y:-2,text:"EDGE"};
const cutPart={...part,id:"cutPart",ref:"R2",x:-30};
doc.items=[frame,nested,peer,partial,inside,part,lead,polygon,bus,label,cutPart];
const beforeSize=P.pageBounds(doc);
assert.deepEqual(P.pageBounds({...doc,sheet:{infinite:false}}),beforeSize);
assert.ok(!P.isInfinite(doc));
assert.equal(P.sheetOf(doc).titleBlock,"standard");
doc.sheet={size:"A3",infinite:true};
assert.equal(P.sheetOf(doc).size,"none");assert.equal(P.sheetOf(doc).titleBlock,"none");
assert.deepEqual(S.frameBounds(frame),[-100,-50,-30,-2]);
assert.deepEqual(S.frameContents(doc,frame,defs),[nested,inside,part,label]);
assert.deepEqual(S.frameContents(doc,frame,defs,[label,lead,nested]),[label,nested]);
assert.deepEqual(S.netSources(frame),[]);assert.deepEqual(S.hotspots(frame),[]);
const graph=d=>Array.from(A.connectivity(d,defs).byPin);
assert.deepEqual(graph(doc),graph({...doc,items:doc.items.filter(i=>!S.isFrame(i))}));
assert.equal(S.hit(frame,[-70,-20],1)>1,true);
assert.equal(S.hit(frame,[-100,-20],1),0);assert.equal(S.hit(frame,[-98,-49],1),0);
assert.equal(S.isFrame({kind:"textframe",text:"ordinary"}),false);
for(const bad of [{...frame,text:"  "},{...frame,text:"a".repeat(301)},{...frame,w:0},{...frame,h:-1},{...frame,role:null}]){
  assert.throws(()=>S.validateItem(bad,()=>{throw Error("invalid");}),/invalid/);
}
for(const infinite of [null,1,"true",{}])assert.throws(()=>P.validateSheet({infinite}));
A.validate(project);
const ctx=new Proxy({},{get:(o,k)=>o[k]||(()=>{})});
const view=AtriumCanvas.create({getContext:()=>ctx,getBoundingClientRect:()=>({width:960,height:640})});
const bounds=()=>{const expected=P.drawingBounds(doc,defs);assert.deepEqual(view.drawingBounds(doc,defs),expected);return expected;};
const raw=bounds();
const nav=AtriumNavigatorPanel.model(project,defs), rows=AtriumNavigatorPanel.flatten(nav,{query:"Channel"});
assert.deepEqual(rows.filter(r=>r.type==="frame").map(r=>r.entry.id),["nested","peer"]);
doc.sheet.titleBlock="standard";
assert.deepEqual(bounds(),[Math.min(raw[0],raw[2]-88.9),raw[1],raw[2],raw[3]+2.54+20.32]);
const firstTitle=bounds();
delete doc.sheet.titleBlock;
const move=AtriumEditSelection.translation(doc,defs,[frame,nested,inside],{query:b=>view.query(doc,defs,b)});
assert.equal(new Set(move.affected).size,move.affected.length,"overlapping or selected members move once");
const history=[],future=[],state=JSON.stringify(doc.items);
const mark=U.mark(project);move.apply(-30,45);U.checkpoint(history,future,mark);U.record(project,{doc,items:move.affected});AtriumCanvas.edited(false);
assert.deepEqual([nested.x,nested.y],[-120,5]);assert.deepEqual(inside.points,[[-126,-1],[-120,-1]]);
assert.deepEqual([peer.x,peer.y],[-100,-50]);assert.deepEqual(lead.points.at(-1),[20,-30]);assert.deepEqual(lead.points[0],[-79,15]);
bounds();
for(const n of [-1,1,-1]){
  assert.ok(U.jump(history,future,U.mark(project),n));U.record(project);AtriumCanvas.edited(false);bounds();
  if(n===-1)assert.equal(JSON.stringify(doc.items),state);
}
const alone=AtriumEditSelection.translation(doc,defs,[frame],{frameOnly:true});assert.deepEqual(alone.affected,[frame]);
alone.apply(1,2);view.invalidate(doc,alone.affected);bounds();alone.apply(0,0);view.invalidate(doc,alone.affected);
const extreme=makeFrame("outlier",9e7,-8e7,64,24);doc.items.push(extreme);view.invalidate(doc);
doc.sheet.titleBlock="standard";bounds();view.fit(doc,defs,"document");
for(const p of [[extreme.x+extreme.w,extreme.y],[frame.x,frame.y]]){
  const [x,y]=view.worldToScreen(p);assert.ok(x>=0&&y>=0&&x<=960&&y<=640,"Fit includes the remote corner");
}
assert.deepEqual(view.query(doc,defs,S.frameBounds(extreme)),[extreme]);
const mm=AtriumMinimap.bounds(doc);assert.ok(mm[1]<extreme.y&&mm[2]>extreme.x+extreme.w);
extreme.x=0;extreme.y=0;view.invalidate(doc,[extreme]);bounds();
doc.items.pop();view.invalidate(doc);assert.deepEqual(bounds(),firstTitle);
const empty={...doc,items:[],sheet:{infinite:true}};
assert.deepEqual(P.pageBounds(empty,defs),[-24,-16,24,16]);
assert.deepEqual(P.pageBounds({...doc,sourceName:"source.kicad_sch",sheet:{size:"A4"}},defs),[0,0,297,210]);
console.log("PASS infinite sheet geometry, unbounded Fit, grouped and isolated moves, Navigator, Undo/Redo and full extent parity");
