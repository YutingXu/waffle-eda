"use strict";
const assert=require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/checks/connectivity.js");
require("../../app/core/spatial.js");
require("../../app/pcb/pcb-appearance.js");
require("../../app/canvas/canvas.js");

const actualInspect=AtriumConnectivity.inspect;
let inspections=0;
AtriumConnectivity.inspect=(doc,defs)=>{inspections++;return actualInspect(doc,defs);};
const strokes=[];
let path=[];
const ctx=new Proxy({
  beginPath(){path=[];},moveTo(x,y){path.push(["M",x,y]);},lineTo(x,y){path.push(["L",x,y]);},
  stroke(){if(this.strokeStyle===AtriumPCBAppearance.system.connection)strokes.push(path.slice());}
},{get(obj,key){return obj[key]??(()=>{});}});
const canvas={getContext:()=>ctx,getBoundingClientRect:()=>({width:690,height:450})};
const view=AtriumCanvas.create(canvas),defs=new Map(),doc=Atrium.sheet("pcb","Unrouted example");
const pad=(id,net,x,y)=>({id,kind:"pad",net,x,y,w:1,h:1,layer:"Top",shape:"round"});
doc.items.push(pad("a1","A",0,0),pad("a2","A",10,0),pad("b1","B",0,3),pad("b2","B",10,3));
view.fit(doc,defs);
view.render(doc,defs,{grid:false});
assert.equal(inspections,0,"unchecked overlay does no connectivity work");
const graph=view.boardConnectivity(doc,defs);assert.equal(graph.airwires.length,2);assert.equal(inspections,1);
const render=(opts={})=>{strokes.length=0;view.render(doc,defs,{grid:false,showUnrouted:true,...opts});return strokes.flat().filter(p=>p[0]==="L")};
assert.equal(render().length,2);assert.strictEqual(view.boardConnectivity(doc,defs),graph);
assert.equal(render({highlight:"A"}).length,1);assert.equal(render({highlight:"missing"}).length,0);
view.pan(10,5);view.zoom(1.2);render();assert.equal(inspections,1,"view-only operations share the panel's cached graph");
doc.items[1].x=.5;view.invalidate(doc,[doc.items[1]]);
assert.equal(render({transientGeometry:true}).length,0);assert.equal(inspections,1);
assert.equal(render().length,1);assert.equal(inspections,2);
assert.deepEqual(view.boardConnectivity(doc,defs).airwires.map(w=>w.net),["B"]);
doc.items=doc.items.slice(0,2);assert.equal(render().length,0);assert.equal(inspections,3);
const large=Atrium.sheet("pcb","Dense ratsnest");
large.items=Array.from({length:200},(_,j)=>pad("n"+j,"N",j*3,0));
let largeInspections=inspections;view.fit(large,defs);view.render(large,defs,{grid:false,showUnrouted:true});
view.zoom(50);strokes.length=0;view.render(large,defs,{grid:false,showUnrouted:true});
const traces=strokes.flat().filter(p=>p[0]==="L").length;
assert(traces>0 && traces<20,"zoomed rendering queries only nearby airwires");
assert.equal(inspections,largeInspections+1);
console.log("PASS optional unrouted overlay, shared revision cache, net isolation, deferred drag recompute, viewport culling and physical reconnection");
