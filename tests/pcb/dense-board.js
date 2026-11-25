"use strict";
// Shared deterministic workload for the CPU query benchmark and the device frame benchmark.
globalThis.makeAtriumBenchmarkBoard = function(n=160){
  const A=globalThis.Atrium;
  const d=A.sheet("pcb","Dense signal board"),defs=new Map(AtriumParts.catalogue.map(p=>[p.id,p]));
  let id=0;
  for(let row=0;row<n;row++)for(let col=0;col<n;col++){
    const x=2.3*col,y=1.72*row,base={id:"o"+(++id)};
    switch((row+col)%12){
      case 0: d.items.push({...base,kind:"part",def:"std-r",x,y,angle:row%4*90,ref:"R"+id,value:"10 kΩ"});break;
      case 1: case 2: d.items.push({...base,kind:"via",x,y,diameter:.6,drill:.3,layer:"Multi"});break;
      case 3: d.items.push({...base,kind:"pad",x,y,w:.95,h:.6,angle:45,layer:"Top",shape:"rect"});break;
      default: d.items.push({...base,kind:"track",layer:col%3?"Top":"Bottom",width:.22,points:[[x,y],[x+.5,y-.5],[x+2.15,y-.5]]});
    }
  }
  d.outline=[[0,0],[n*2.3,0],[n*2.3,n*1.72],[0,n*1.72]];
  return {d,defs};
};
