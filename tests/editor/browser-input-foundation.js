"use strict";

const assert=require("node:assert/strict"), path=require("node:path"), {pathToFileURL}=require("node:url");
const {profile}=require("../fixtures/notebook-labs.cjs");
async function coldContact(browser){
  const page=await browser.newPage({viewport:{width:1200,height:820},hasTouch:true});
  await profile(page);
  let release;const waiting=new Promise(resolve=>{release=resolve;});
  try{
    await page.route("**/canvas-input.js",async route=>{await waiting;await route.continue();});
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href,{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>globalThis.AtriumNavHost?.canvas());
    assert.equal(await page.evaluate(()=>AtriumLabs.notebookEnabled()),true);
    const demanded=page.waitForRequest("**/canvas-input.js");
    const before=await page.evaluate(()=>{
      const h=AtriumNavHost,v=h.view(),c=h.canvas(),r=c.getBoundingClientRect(),x=r.left+55,y=r.top+65;
      if(globalThis.AtriumCanvasInput)throw Error("input loaded before the cold contact");
      const cam=v.camera();
      for(const [type,dx] of [["pointerdown",0],["pointermove",20],["pointerup",20]]){
        c.dispatchEvent(new PointerEvent(type,{pointerId:71,pointerType:"touch",clientX:x+dx,clientY:y,button:0,buttons:type==="pointerup"?0:1,bubbles:true,cancelable:true}));
      }
      return cam;
    });
    await demanded;
    release();
    await page.waitForFunction(cam=>Math.abs(AtriumNavHost.view().camera().cx-cam.cx)*cam.scale>18,before,{timeout:4000});
    assert.equal(await page.evaluate(()=>AtriumNavHost.drag()),null);
    console.log("PASS first contact survives deferred module loading");
  }finally{release();await page.close();}
}
module.exports=async function inputFoundation(browser){
  await coldContact(browser);
  const ink=await browser.newPage({viewport:{width:1200,height:820},hasTouch:true});
  await profile(ink);
  let releaseGrip;const loadingGrip=new Promise(resolve=>{releaseGrip=resolve;});
  try{
    await ink.route("**/touch-precision.js",async route=>{await loadingGrip;await route.continue();});
    await ink.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await ink.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    const phases=await ink.evaluate(async()=>{
      await AtriumLazy.need(["AtriumCamera","AtriumCanvasInput"]);const c=AtriumNavHost.canvas(),r=c.getBoundingClientRect(),out=[];
      AtriumCanvasInput.setSketchActive(c,true);
      c.addEventListener("waffle-sketch-input",e=>{out.push(e.detail.pointerType+"/"+e.detail.phase);if(e.detail.phase==="start")e.preventDefault();});
      function send(type,id,kind,x){c.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:id,pointerType:kind,button:0,
        buttons:type==="pointerup"?0:1,clientX:r.left+x,clientY:r.top+75}));}
      send("pointerdown",19,"touch",42);send("pointermove",19,"touch",45);send("pointerup",19,"touch",47);
      send("pointerdown",20,"pen",55);send("pointerdown",21,"touch",65);send("pointermove",20,"pen",59);
      send("pointerup",21,"touch",65);send("pointerup",20,"pen",61);
      send("pointerdown",22,"touch",80);send("pointermove",22,"touch",84);send("pointerup",22,"touch",86);
      AtriumCanvasInput.setSketchActive(c,false);return out;
    });
    assert.deepEqual(phases,["touch/start","touch/move","touch/end","pen/start","pen/move","pen/end","touch/start","touch/move","touch/end"]);
    console.log("PASS palms and active ink keep their event order while touch grips are cold");
  }finally{releaseGrip();await ink.close();}
  const page=await browser.newPage({viewport:{width:1400,height:900},hasTouch:true}),errors=[];
  await profile(page);
  page.on("pageerror",e=>errors.push(e.message));
  try{
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(()=>!!globalThis.AtriumNavHost);
    await page.evaluate(()=>AtriumLazy.need("AtriumCanvasInput").then(()=>true));
    await page.addScriptTag({path:path.join(__dirname,"../fixtures/input-foundation/probe.js")});
    const scripted=await page.evaluate(()=>WaffleInputProbe());
    console.log("PASS "+scripted.checks.length+" scripted contact and gesture checks in Chromium");
    await page.addScriptTag({path:path.join(__dirname,"../fixtures/input-foundation/library.js")});
    const library=await page.evaluate(()=>WaffleLibraryInputProbe());
    console.log("PASS "+library.join("; "));
    const cdp=await page.context().newCDPSession(page);
    const at=await page.evaluate(()=>{
      const h=AtriumNavHost,v=h.view(),c=h.canvas(),r=c.getBoundingClientRect();
      h.setTool("select");h.select([]);v.restoreCamera({...v.camera(),cx:0,cy:0,scale:12});h.redraw();
      globalThis.inputContacts=[];c.addEventListener("pointerdown",e=>{if(e.isTrusted)inputContacts.push({kind:e.pointerType,pressure:e.pressure});},{capture:true});
      // Observe before window-level recognition by using the CDP-provided pen pressure in the sketch claim.
      c.addEventListener("waffle-sketch-input",e=>{if(e.detail.phase==="start")inputContacts.push({kind:"sketch",pressure:e.detail.pressure});});
      const [x,y]=v.worldToScreen([1.5,0]);return {x:x+r.left,y:y+r.top};
    });
    await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",...at,pointerType:"pen",button:"left",buttons:1,clickCount:1,force:.71,tiltX:20});
    await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",...at,pointerType:"pen",button:"left",buttons:0,clickCount:1});
    // A first pen contact can be replayed once its lazy grip module loads, so the selection may land a frame later.
    await page.waitForFunction(()=>AtriumNavHost.selection().join()==="line",null,{timeout:2000}).catch(()=>{});
    assert.deepEqual(await page.evaluate(()=>AtriumNavHost.selection()),["line"]);
    assert.ok(await page.evaluate(()=>inputContacts.some(e=>e.kind==="sketch"&&e.pressure>.68)));
    const touch=(type,points)=>cdp.send("Input.dispatchTouchEvent",{type,touchPoints:points});
    await page.evaluate(()=>{AtriumNavHost.select([]);AtriumNavHost.setTool("label");});
    const count=await page.evaluate(()=>AtriumNavHost.doc().items.length);
    await touch("touchStart",[{id:1,x:at.x+80,y:at.y+65}]);await touch("touchEnd",[]);
    assert.equal(await page.evaluate(()=>AtriumNavHost.doc().items.length),count+1);
    await page.keyboard.press(process.platform==="darwin"?"Meta+z":"Control+z");
    assert.equal(await page.evaluate(()=>AtriumNavHost.doc().items.length),count);
    await page.keyboard.press("Escape");await page.evaluate(()=>AtriumNavHost.select(["line"]));
    await page.keyboard.press("Shift+F10");await page.getByRole("menu",{name:/object|wire/i}).first().waitFor({state:"visible",timeout:3500});
    await page.keyboard.press("Escape");assert.deepEqual(errors,[]);
    console.log("PASS browser contact dispatch for pen pressure, touch placement, keyboard history and object menu");
    await page.addScriptTag({path:path.join(__dirname,"../pcb/dense-board.js")});
    await page.addScriptTag({path:path.join(__dirname,"../fixtures/input-foundation/dense.js")});
    const stress=await page.evaluate(()=>WaffleInputStress());
    assert.equal(stress.items,25600);assert.ok(stress.paints>=70,"stress advanced real canvas frames");
    assert.ok(stress.movingPaints>=.9*stress.paints,"pan frames use the interactive camera path");
    console.log("Measured dense contact stream "+JSON.stringify(stress));
    await require("../fixtures/input-foundation/notebook.cjs")(page);
    await page.addScriptTag({path:path.join(__dirname,"../fixtures/input-foundation/manufacturing.js")});
    const documents=await page.evaluate(()=>WaffleManufacturingInputProbe());
    console.log("PASS "+documents.length+" drawing and panel contact, keyboard and undo checks");
    await page.evaluate(()=>AtriumNavHost.canvas().focus());
    await page.keyboard.press("Shift+F10");
    const cellMenu=page.getByRole("menu",{name:"Board cell",exact:true});
    await cellMenu.waitFor({state:"visible",timeout:3500});
    const properties=cellMenu.getByRole("menuitem",{name:"Properties",exact:true});
    assert.ok(await properties.evaluate(item=>item===document.activeElement),"the menu focuses its first enabled item");
    const zoom=cellMenu.getByRole("menuitem",{name:"Zoom to selected object",exact:true});
    await page.keyboard.press("ArrowDown");
    assert.ok(await zoom.evaluate(item=>item===document.activeElement),"the panel cell menu supports arrow navigation");
    assert.equal(await page.evaluate(()=>AtriumNavHost.view().scale()),5,"opening the menu keeps the current zoom");
    await zoom.click({timeout:3500});
    await cellMenu.waitFor({state:"hidden",timeout:3500});
    assert.ok(await page.evaluate(()=>AtriumNavHost.view().scale()>5),"the clicked menu item fits the selected cell");
    assert.ok(await page.evaluate(()=>document.activeElement===AtriumNavHost.canvas()),"the action returns focus to the canvas");
    assert.deepEqual(errors,[]);
    console.log("PASS Shift+F10 and Arrow Down reach the selected panel cell menu and its zoom action responds to a click");
    return {...scripted,stress};
  } finally {await page.close();}
};
