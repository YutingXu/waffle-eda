"use strict";
globalThis.WaffleLibraryInputProbe=async function(){
  await AtriumLazy.need("AtriumLibrary");
  const out=[];
  for(const kind of ["symbol","footprint"]){
    const symbol=kind==="symbol",ui=symbol?AtriumSymbolEditor:AtriumFootprintEditor;
    const ed=ui.open({library:[]}),c=ed.dialog.querySelector("canvas.fe-canvas"),s=ed.stage,initialFit=s.view.fitScale();
    try{
      await WaffleInputProbe.waitFor(()=>s.view.fitScale()!==initialFit,kind+" stage did not fit its canvas");
      const tool=symbol?"pin":"pad",count=()=>symbol?ed.model.pins.length:ed.draft.footprint.pads.length;
      const initial=count(),r=c.getBoundingClientRect(),v=s.view.camera();
      const pt=q=>{const at=s.toScreen(q);return [r.left+at[0],r.top+at[1]];};
      function e(type,id,at,kind="touch"){c.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:id,pointerType:kind,
        clientX:at[0],clientY:at[1],button:type==="pointermove"?-1:0,buttons:type==="pointerup"?0:1}));}
      ed.setTool(tool);const place=pt([0,0]);
      e("pointerdown",121,place);e("pointerup",121,place);
      if(count()!==initial+1)throw Error(kind+" precision tap did not add a "+tool);
      ed.setTool("select");
      const after=count(),a=[r.left+r.width*.4,r.top+r.height*.25],b=[a[0]+44,a[1]],end=[b[0]+30,b[1]+7];
      e("pointerdown",122,a);e("pointerdown",123,b);e("pointermove",123,end);
      if(!(s.view.scale()>v.scale))throw Error(kind+" pinch did not zoom");
      e("pointercancel",122,a);e("pointerup",123,end);
      if(count()!==after)throw Error(kind+" pinch changed the draft");
      const start=pt([0,0]), target=[start[0]+40,start[1]+26],old=symbol?JSON.stringify(ed.model):JSON.stringify(ed.draft);
      e("pointerdown",124,start,"pen");e("pointermove",124,target,"pen");e("pointercancel",124,target,"pen");
      if((symbol?JSON.stringify(ed.model):JSON.stringify(ed.draft))!==old)throw Error(kind+" lost stylus left a changed draft");
      const base=[r.left+r.width*.3,r.top+r.height*.25];
      for(let i=0;i<3;i++)e("pointerdown",130+i,[base[0]+i*16,base[1]]);
      for(let i=0;i<3;i++)e("pointermove",130+i,[base[0]+i*16-85,base[1]]);
      for(let i=0;i<3;i++)e("pointerup",130+i,[base[0]+i*16-85,base[1]]);
      if(count()!==initial)throw Error(kind+" swipe did not undo its local draft");
      out.push(kind+" touch placement, pinch, stylus cancellation and private history");
    }finally{ed.dialog.close();}
  }
  await AtriumLazy.need("AtriumDiffView");
  const before=AtriumNavHost.project(),after=JSON.parse(JSON.stringify(before)),sheet=after.documents.find(d=>d.kind==="schematic");
  sheet.items.push({id:"review-tap",kind:"netlabel",text:"OUT",x:4,y:3});
  try{
    const {panes}=await AtriumDiffView.start({project:before,label:"Before"},{project:after,label:"After"},{doc:sheet.id});
    const p=panes.find(p=>p.side==="after"),c=p.cross,r=c.getBoundingClientRect(),start=p.view.scale();
    const x=r.left+r.width/2,y=r.top+r.height/2;
    function contact(type,id,at){c.dispatchEvent(new PointerEvent(type,{pointerId:id,pointerType:"touch",button:0,buttons:type==="pointerup"?0:1,clientX:at,clientY:y,bubbles:true,cancelable:true}));}
    contact("pointerdown",151,x-20);contact("pointerdown",152,x+20);contact("pointermove",152,x+40);contact("pointerup",152,x+40);contact("pointercancel",151,x-20);
    await WaffleInputProbe.waitFor(()=>panes.every(p=>Math.abs(p.view.scale()/start-1.5)<.01),"revision canvases lost their shared camera after pinch",1);
    out.push("linked revision cameras pinch together");
  }finally{AtriumDiffView.close();}
  return out;
};
