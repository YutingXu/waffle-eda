"use strict";
const assert=require("node:assert/strict");
// The connection and unified palette modules arrive on separate workstreams. Exercise their actual
// UI automatically when this checkout carries both integrations.
module.exports=async function notebookHold(page) {
  if(!await page.evaluate(()=>AtriumLazy.modules().includes("AtriumConnectionPreview") && !!AtriumNavCommon.openPalette))return false;
  await page.evaluate(async()=>{
    await AtriumLazy.need(["AtriumConnectionPreview","AtriumCamera","AtriumSchObjects","AtriumRules","AtriumHierarchy"]);
    const h=AtriumNavHost,A=Atrium,S=AtriumSchObjects,p=A.project("Held notebook connections",[]);
    const parent=A.sheet("schematic","Controller"),child=A.sheet("schematic","Sensor");
    parent.id="input-parent";child.id="input-sensor";
    parent.items=[{...S.make("sheetsymbol",[0,4],{name:"U_SENSOR",sheet:child.id,entries:[{id:"input-entry",name:"VIN",io:"input",side:"left",offset:5.08}]}),id:"input-symbol"}];
    child.items=[{...S.make("port",[10,10],{text:"VIN",io:"input"}),id:"input-port"}];
    p.documents=[parent,child,...p.documents.filter(d=>d.kind==="pcb")];
    AtriumProjectRules.setNetScope(p,"hierarchical");
    await h.replaceProject(p,{force:true,dirty:false});h.selectDocument(child.id);h.setTool("select");h.canvas().focus();
    AtriumCamera.setPref("camera.animate",false);h.view().restoreCamera({...h.view().camera(),cx:10,cy:10,scale:14});h.redraw();
  });
  await page.waitForFunction(()=>!!AtriumConnectionPreview.current());
  const menu=page.locator('.nav-menu[role=menu],.ctx-menu[role=menu]').first();
  const waitForLift=()=>page.evaluate(()=>WaffleInputProbe.waitFor(()=>document.querySelector(".touch-lift"),"touch lift did not mount"));
  const hold=async(world,id)=>{
    const where=await page.evaluate(({world,id})=>{
      const h=AtriumNavHost,c=h.canvas(),r=c.getBoundingClientRect(),at=h.view().worldToScreen(world),p=[at[0]+r.left,at[1]+r.top];
      c.dispatchEvent(new PointerEvent("pointerdown",{pointerId:id,pointerType:"touch",clientX:p[0],clientY:p[1],button:0,buttons:1,isPrimary:true,bubbles:true,cancelable:true}));return p;
    },{world,id});
    await waitForLift();
    await page.evaluate(({where,id})=>AtriumNavHost.canvas().dispatchEvent(new PointerEvent("pointerup",{pointerId:id,pointerType:"touch",clientX:where[0],clientY:where[1],button:0,buttons:0,isPrimary:true,bubbles:true,cancelable:true})),{where,id});
    await menu.waitFor({timeout:3500});
  };
  // A released hold in place opens the current canvas context menu. Wait for its real exit before the next contact.
  const closeMenu=async()=>{await page.evaluate(()=>AtriumContextMenu.close(false));await menu.waitFor({state:"detached"});};
  await hold([10,10],201);
  assert.equal(await page.locator('.sheet-connection-card button[data-entry="input-entry"]').count(),0,"a held port opens no hover card");
  await closeMenu();
  await page.evaluate(()=>{const h=AtriumNavHost;h.selectDocument("input-parent");h.view().restoreCamera({...h.view().camera(),cx:15,cy:15,scale:8});h.canvas().focus();h.redraw();});
  await hold([28,23],202);
  assert.ok(await menu.getByRole("menuitem",{name:/^Paste/}).count()>0,"blank schematic canvas opens the canvas menu");
  await closeMenu();
  await page.evaluate(()=>{const h=AtriumNavHost,d=h.project().documents.find(d=>d.kind==="pcb");h.selectDocument(d.id);h.canvas().focus();h.view().restoreCamera({...h.view().camera(),cx:20,cy:20,scale:8});h.redraw();});
  await hold([24,26],203);await closeMenu();
  console.log("PASS a held port and blank schematic and PCB canvases released in place open the context menu");
  const picker=page.locator('dialog[open][data-mode="insert"]');
  await page.evaluate(()=>AtriumLazy.need("AtriumLibrary").then(()=>true));
  for(const kind of ["symbol","footprint"]){
    const at=await page.evaluate(async kind=>{
      const ui=kind==="symbol"?AtriumSymbolEditor:AtriumFootprintEditor,ed=ui.open({library:[]});
      await new Promise(requestAnimationFrame);
      const surface=ed.dialog.paletteSurface,c=surface.canvas,r=c.getBoundingClientRect();
      const x=r.left+r.width*.22,y=r.top+r.height*.32;
      const count=()=>kind==="symbol"?ed.model.pins.length:ed.draft.footprint.pads.length;
      window.libraryDown=type=>c.dispatchEvent(new PointerEvent(type,{pointerId:225,pointerType:"touch",clientX:x,clientY:y,
        button:0,buttons:type==="pointerup"?0:1,bubbles:true,cancelable:true}));
      window.libraryCount=count;window.libraryClose=()=>ed.dialog.close();
      const result={world:surface.toWorld(x,y),docId:AtriumNavHost.currentId(),count:count()};libraryDown("pointerdown");return result;
    },kind);
    try{
      await waitForLift();await page.evaluate(()=>libraryDown("pointerup"));await picker.waitFor({timeout:3500});
      const held=await picker.evaluate(n=>({point:n.paletteRequest.point,docId:n.paletteRequest.docId,kind:n.paletteRequest.surface?.kind,source:n.paletteRequest.source}));
      assert.equal(held.kind,kind);assert.equal(held.source,"hold");assert.equal(held.docId,at.docId);
      assert.ok(Math.hypot(held.point[0]-at.world[0],held.point[1]-at.world[1])<.15);
      const title=kind==="symbol"?"Pin":"Pad",input=picker.getByRole("combobox");await input.fill(title);
      const row=picker.getByRole("option").filter({has:page.getByText(title,{exact:true})}).first();
      await row.click();await page.waitForFunction(n=>libraryCount()===n,at.count+1,{timeout:3500});
      console.log("PASS held library Insert places one "+title+" in the "+kind+" draft");
    }finally{await page.evaluate(()=>{if(document.getElementById("palette").open)AtriumPalette.close();libraryClose();});}
  }
  return true;
};
