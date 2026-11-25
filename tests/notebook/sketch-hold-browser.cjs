"use strict";
const assert=require("node:assert/strict"),path=require("node:path"),{pathToFileURL}=require("node:url");

const line=Array.from({length:25},(_,i)=>[i*4,i+.9*Math.sin(i/2)]);
const circle=Array.from({length:49},(_,i)=>{const a=i*Math.PI/24,r=38+.6*Math.sin(3*a);return [r*Math.cos(a),r*Math.sin(a)];});
function edges(corners){return [corners[0],...corners.slice(1).flatMap((b,j)=>Array.from({length:6},(_,i)=>[
  corners[j][0]+(b[0]-corners[j][0])*(i+1)/6,corners[j][1]+(b[1]-corners[j][1])*(i+1)/6]))];}
const rectangle=edges([[0,0],[40,0],[40,50],[-40,50],[-40,0],[0,0]]).map(([x,y])=>[x*.96-y*.28,x*.28+y*.96]);
const ambiguous=edges([[0,0],[40,12],[5,22],[49,38]]);
async function openSketch(page) {
  await page.locator("#canvas").focus();await page.keyboard.press("/");
  const dialog=page.locator("dialog[open]").filter({has:page.locator('[role="listbox"]')}).last();
  await dialog.locator("input").first().fill("Sketch");
  await dialog.getByRole("option",{name:/Sketch/i}).first().click();await dialog.waitFor({state:"hidden"});
  await page.waitForFunction(()=>AtriumNavHost.tool()==="sketch");
}
async function input(page,cdp,type) {
  let last,x0,y0;
  async function event(phase,p=last,force=.5) {
    if(phase==="start"){
      const r=await page.locator("#canvas").boundingBox();
      x0=Math.round(r.x+145);y0=Math.round(r.y+170);
    }
    last=p;const x=Math.round((x0+p[0])*10)/10,y=Math.round((y0+p[1])*10)/10;
    if(phase==="start"){
      await page.waitForFunction(({x,y})=>document.elementFromPoint(x,y)===AtriumNavHost.canvas(),{x,y},{timeout:9000});
      if(type==="pen")await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y,button:"none",buttons:0,pointerType:type,force:0});
    }
    if(type==="mouse"){
      // Keep the browser's mouse button state across the complete gesture.
      if(phase!=="end")await page.mouse.move(x,y);
      if(phase==="start")await page.mouse.down();
      if(phase==="end")await page.mouse.up();
      return;
    }
    if(type==="touch"){
      await cdp.send("Input.dispatchTouchEvent",{type:{start:"touchStart",move:"touchMove",end:"touchEnd"}[phase],
        touchPoints:phase==="end"?[]:[{x,y,id:3,force,radiusX:2,radiusY:2}]});return;
    }
    await cdp.send("Input.dispatchMouseEvent",{type:{start:"mousePressed",move:"mouseMoved",end:"mouseReleased"}[phase],
      x,y,button:phase==="move"?"none":"left",buttons:phase==="end"?0:1,pointerType:type,clickCount:phase==="move"?0:1,force:phase==="end"?0:force});
  }
  async function trace(points){
    await event("start",points[0],.2);
    for(let n=1;n<points.length;n++)await event("move",points[n],.2+.65*n/(points.length-1));
  }
  return {event,trace};
}
const records=page=>page.evaluate(()=>AtriumNavHost.doc().items.filter(i=>i.ink).map(i=>({id:i.id,ink:i.ink,points:AtriumMarkup.points(i)})));
const snapped=(page,kind)=>page.waitForFunction(k=>document.querySelector("#status").textContent.startsWith(k+" snapped."),kind,{timeout:3000}).catch(async error=>{
  const detail=await page.evaluate(async()=>({status:document.querySelector("#status").textContent,visibility:document.visibilityState,
    tool:AtriumNavHost.tool(),scale:AtriumNavHost.view().camera().scale,inputs:window.shapeInputs,diagnostics:await globalThis.AtriumDiagnostics?.entries?.()}));
  throw Error(kind+" was not previewed: "+JSON.stringify(detail),{cause:error});
});
const main=()=>require("../support/standalone-chromium.cjs")(
  {channel:"chrome",args:["--allow-file-access-from-files"]},async browser=>{
    const page=await browser.newPage({viewport:{width:1320,height:840},hasTouch:true}),cdp=await page.context().newCDPSession(page),errors=[];
    page.on("pageerror",e=>{errors.push(e.message);console.error(e.stack);});
    await page.addInitScript(()=>{window.trustedSketchInputs=new Set();
      addEventListener("pointerdown",e=>{if(e.isTrusted&&e.target.id==="canvas")trustedSketchInputs.add(e.pointerType);},true);
    });
    let requested,release;
    const entered=new Promise(done=>{requested=done;}),delayed=new Promise(done=>{release=done;});
    await page.route("**/sketch-shapes.js",async route=>{requested();await delayed;await route.continue();});
    await require("../fixtures/notebook-labs.cjs").profile(page);
    await page.clock.install();
    await page.goto(pathToFileURL(path.resolve(__dirname,"../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name",{hasText:"Sensor board"}).waitFor();
    await page.evaluate(async()=>{
      const h=AtriumNavHost,p=Atrium.project("Sketch hold"),d=Atrium.sheet("schematic","Shape sheet");p.documents=[d];
      await h.replaceProject(p,{force:true,copy:true,dirty:false});h.selectDocument(d.id);
      window.shapeInputs=[];
      document.addEventListener("waffle-sketch-input",e=>{if(e.detail.phase==="start")shapeInputs.push(e.detail.pointerType);});
    });
    await openSketch(page);
    const panel=page.locator("#review-notes-panel");
    const cold=await input(page,cdp,"mouse");
    await cold.trace(line);await cold.event("end");await page.clock.runFor(670);
    assert.ok((await records(page)).at(-1).points.length>2);
    assert.equal(await page.evaluate(()=>typeof globalThis.AtriumSketchShapes),"undefined","idle and ordinary freehand never load the shape fitter");
    try{
      const before=(await records(page)).length;
      await cold.trace(line);
      await Promise.race([entered,new Promise((_,reject)=>setTimeout(()=>reject(Error("The held stroke did not request its fitter")),9000).unref())]);
      assert.equal((await records(page)).length,before,"an unsettled cold preview has no document edit");
      release();await snapped(page,"Line");await cold.event("end");
      assert.equal((await records(page)).at(-1).points.length,2,"the first held line is recognized after loading");
    }finally{release();}
    for(const type of ["mouse","pen","touch"]){
      const device=await input(page,cdp,type);
      for(const [label,points] of [["Line",line],["Circle",circle],["Rectangle",rectangle]]){
        const high=label==="Circle";
        await panel.getByLabel("Drawing tool").selectOption(high?"highlighter":"pen");
        await panel.getByLabel("Ink colour").selectOption("violet");
        const before=(await records(page)).length;
        await device.trace(points);await snapped(page,label);
        assert.equal((await records(page)).length,before,"a preview has no document record");
        await device.event("end");
        const after=await records(page),last=after.at(-1);
        assert.equal(after.length,before+1);assert.equal(last.ink.brush,high?"highlighter":"pen");assert.equal(last.ink.colour,"violet");
        assert.deepEqual(Object.keys(last.ink).sort(),["at","brush","colour","p","path","width"],"ordinary portable ink schema");
        assert.equal(last.ink.width,high?2.4:.55);
        const ps=last.points.map(p=>p[2]);if(type!=="mouse")assert.ok(Math.max(...ps)-Math.min(...ps)>100,type+" pressure retained");
        if(label==="Line"){
          const a=last.points[0],b=last.points.at(-1);
          assert.ok(last.points.every(p=>Math.abs((p[0]-a[0])*(b[1]-a[1])-(p[1]-a[1])*(b[0]-a[0]))<1e-6));
          if(type==="mouse")assert.equal(last.points.length,2);
        }else assert.ok(Math.hypot(last.points[0][0]-last.points.at(-1)[0],last.points[0][1]-last.points.at(-1)[1])<1e-6);
      }
      const before=(await records(page)).length;await device.trace(ambiguous);await page.clock.runFor(690);await device.event("end");
      const drawn=await records(page);assert.equal(drawn.length,before+1);
      assert.ok(drawn.at(-1).points.length>=4);assert.ok(!(await page.locator("#status").innerText()).includes("snapped."));
      console.log("PASS Chromium "+type+" line, circle and rotated rectangle; held zigzag stayed freehand");
    }
    const mouse=await input(page,cdp,"mouse");
    await mouse.trace(line);await mouse.event("end");const quick=(await records(page)).at(-1);
    assert.ok(quick.points.length>2,"ordinary release keeps the curve");
    await mouse.trace(line);await snapped(page,"Line");await mouse.event("move",[64,61]);await mouse.event("end");
    assert.ok((await records(page)).at(-1).points.length>2,"continuing after preview restores the original gesture");
    const before=(await records(page)).length;
    await mouse.trace(line);await snapped(page,"Line");
    const visible=panel.getByLabel("Show on this sheet");
    await visible.evaluate(box=>box.click());await mouse.event("end");assert.equal((await records(page)).length,before,"hiding Notes cancels the held stroke");
    await visible.check();
    await mouse.trace(line);await snapped(page,"Line");
    await page.evaluate(()=>AtriumNavHost.canvas().dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true})));
    await mouse.event("end");assert.equal((await records(page)).length,before,"double-click cancels just the active stroke");
    await mouse.trace(line);
    await page.evaluate(()=>{const d=document;Object.defineProperty(d,"hidden",{value:true,configurable:true});d.dispatchEvent(new Event("visibilitychange"));delete d.hidden;});
    await page.clock.runFor(670);await mouse.event("end");assert.equal((await records(page)).length,before,"backgrounding cancels the timer");
    await mouse.trace(line);await snapped(page,"Line");await page.evaluate(()=>AtriumNavHost.act("undo"));
    const undone=await records(page);await mouse.event("end");assert.equal(undone.length,before-1);assert.deepEqual(await records(page),undone);
    await page.evaluate(()=>AtriumNavHost.act("redo"));assert.equal((await records(page)).length,before);
    if(!await page.evaluate(()=>AtriumNavHost.tool()==="sketch"))await openSketch(page);
    await mouse.trace(line);await snapped(page,"Line");await mouse.event("end");
    const saved=(await records(page)).at(-1);await page.evaluate(()=>AtriumNavHost.act("undo"));
    assert.ok(!(await records(page)).some(i=>i.id===saved.id));await page.evaluate(()=>AtriumNavHost.act("redo"));
    assert.deepEqual((await records(page)).find(i=>i.id===saved.id),saved);
    const output=await page.evaluate(async()=>{
      await AtriumLazy.need("AtriumPrint");const h=AtriumNavHost,p=h.project(),d=h.doc();
      const plan=includeNotes=>AtriumPrint.build(p,{documents:[d.id],includeNotes}).pages.flatMap(pg=>pg.list);
      const ink=ops=>ops.filter(op=>op.k==="p"&&Math.abs(op.a-.28)<.002);
      const printed=ink(plan(true)),hidden=ink(plan(false));
      return {printed:printed.length,hidden:hidden.length,types:[...new Set(shapeInputs)],trusted:[...trustedSketchInputs]};
    });
    assert.ok(output.printed>=3,"printed vector highlighters: "+JSON.stringify(output));assert.equal(output.hidden,0);
    assert.deepEqual(output.types.sort(),["mouse","pen","touch"]);assert.deepEqual(output.trusted.sort(),["mouse","pen","touch"]);assert.deepEqual(errors,[]);
    console.log("PASS early release, movement after snap, double-click, simulated document hide, Undo during hold, one-step Undo/Redo and physical Notes print policy");
  },error=>{console.error(error);process.exitCode=1;});
module.exports={input,openSketch,line,circle,rectangle,snapped,records};
if(require.main===module)main();
