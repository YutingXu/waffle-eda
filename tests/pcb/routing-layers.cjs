"use strict";
const assert=require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/core/spatial.js");
require("../../app/pcb/pcb-appearance.js");
require("../../app/canvas/canvas.js");
const via=(id,x,fromLayer,toLayer)=>({id,kind:"via",x,y:0,diameter:.8,drill:.3,layer:"Multi",fromLayer,toLayer});
const def={id:"fp",footprint:{shapes:[],pads:[
  {...via("embedded",0,"Inner 2","Bottom"),w:.8,h:.8,number:""},
  {x:3,y:0,w:1,h:1,number:"1",drill:.4},
  {x:6,y:0,w:1,h:1,number:"2",drill:0}
]}};
const board=Atrium.sheet("pcb","Layer contacts"),defs=new Map([[def.id,def]]);
board.items=[
  via("through",0),via("blind",4,"Top","Inner 2"),via("buried",8,"Inner 3","Inner 1"),
  {id:"part",kind:"part",x:14,y:0,angle:0,layer:"Bottom",def:def.id},
  {id:"track",kind:"track",layer:"Inner 4",width:.25,points:[[24,0],[28,0]]},
  {id:"hole",kind:"pad",layer:"Multi",x:31,y:0,w:1,h:1,drill:.4,plated:false}
];
const view=AtriumCanvas.create({getContext:()=>({}),getBoundingClientRect:()=>({width:700,height:400})});
view.fit(board,defs);
assert.deepEqual(AtriumCanvas.routingLayers(board,defs),["Top","Inner 1","Inner 2","Inner 3","Inner 4","Bottom"]);
function snap(x,layer,expected,hidden=[]){
  const start=[x+.03,.02];
  const point=view.snapPoint(board,defs,start,{routing:true,layer,hidden:new Set(hidden),grid:false});
  assert.deepEqual(point,expected?[x,0]:start,JSON.stringify({x,layer,hidden}));
}
snap(0,"Inner 4",true);snap(0,"Inner 4",false,["Inner 4"]);
snap(4,"Inner 1",true);snap(4,"Bottom",false);snap(4,"Inner 3",false);
snap(8,"Inner 2",true);snap(8,"Top",false);snap(8,"Bottom",false);
snap(14,"Inner 1",false);snap(14,"Inner 3",true);snap(14,"Bottom",true);
snap(17,"Top",true);snap(17,"Inner 1",true);
snap(20,"Top",false);snap(20,"Bottom",true);snap(20,"Bottom",false,["Bottom"]);
snap(24,"Inner 4",true);snap(24,"Top",false);snap(24,"Inner 4",false,["Inner 4"]);
snap(31,"Inner 1",false);
console.log("PASS inner copper discovery, through/blind/buried and embedded vias, pad sides, hidden copper and nonplated holes");
