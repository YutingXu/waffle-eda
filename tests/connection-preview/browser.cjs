"use strict";
// Real pointer/keyboard gestures on the editor canvas. Optional screenshots
// always contain this generated project, never a customer's design.
const assert=require("node:assert/strict");
const path=require("node:path"), fs=require("node:fs/promises"), {pathToFileURL}=require("node:url");
const {chromium}=require("playwright-core");

async function main() {
  const browser=await chromium.launch(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"});
  const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:"reduce"});
  page.setDefaultTimeout(6000);
  const errors=[]; page.on("pageerror",e=>errors.push(e.message));
  const shots=process.env.CONNECTION_SCREENSHOTS;
  if (shots) await fs.mkdir(shots,{recursive:true});
  try {
    await page.clock.install();
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name").filter({hasText:"Sensor board"}).waitFor();
    await page.evaluate(async()=>{
      const h=AtriumNavHost,A=Atrium,S=AtriumSchObjects,p=A.project("Connection directions",[]);
      await AtriumLazy.need("AtriumPrefs"); AtriumPrefs.set("checks.liveErc",false);
      const top=A.sheet("schematic","Control"),child=A.sheet("schematic","Sensor"),other=A.sheet("schematic","Sensor B");
      const board=p.documents.find(d=>d.kind==="pcb");
      top.id="control"; child.id="sensor"; other.id="other"; board.id="board"; p.documents=[top,child,other,board];
      p.rules={version:1,list:[{id:"scope",name:"NetIdentifierScope",type:"ercNetScope",scope:{languageVersion:1,source:"object"},netScope:"hierarchical",enabled:true}]};
      const symbol=(doc,x,id)=>({...S.make("sheetsymbol",[x,4],{name:"U_"+doc.name,sheet:doc.id,
        entries:[{id:"entry",name:"VIN",io:"input",side:"left",offset:5.08}]}),id});
      const make=(id,kind,x,y,text,io)=>({...S.make(kind,[x,y],{text,io}),id});
      top.items=[symbol(child,0,"sym1"),symbol(other,50,"sym2"),make("earth","power",2,34,"GND")];
      child.items=[make("vin","port",10,10,"VIN","input"),make("clock","offsheet",10,20,"CLK"),make("orphan","port",10,30,"ENABLE","output"),
        {id:"wire",kind:"wire",points:[[-5,10],[10,10]]},{id:"local",kind:"netlabel",text:"LOCAL",x:10,y:40}];
      other.items=[make("vin-b","port",10,10,"VIN","input"),make("clk-b","offsheet",10,20,"CLK"),make("clk-c","offsheet",10,42,"CLK"),make("alone-b","port",10,30,"ENABLE","input")];
      for(let i=0;i<12;i++) other.items.push(make("ground"+i,"power",18+i*8,55,"GND"));
      board.items=[{id:"track",kind:"track",points:[[1,1],[3,1]],layer:"Top",net:"GND",width:.25}];
      await h.replaceProject(p,{force:true,dirty:false}); h.selectDocument("sensor");
      await AtriumLazy.need("AtriumConnectionPreview"); AtriumCamera.setPref("camera.animate",false);
      h.view().restoreCamera({cx:17,cy:24,scale:8,referenceScale:6});h.redraw();
    });
    await page.waitForFunction(()=>!!AtriumConnectionPreview.current() && !globalThis.AtriumMotion?.active());
    await page.evaluate(()=>{
      const h=AtriumNavHost; AtriumCamera.land(); h.view().restoreCamera({cx:17,cy:24,scale:8,referenceScale:6});h.redraw();
    });
    if (process.env.CONNECTION_TRACE) await page.evaluate(()=>{
      window.inputTrace=[];
      for (const type of ["pointermove","pointerdown","pointerup","click","dblclick","contextmenu"]) document.addEventListener(type,e=>{
        const hit=e.target.tagName==="CANVAS" && AtriumNavHost.hit(e.target,e.clientX,e.clientY);
        inputTrace.push([type,e.target.id,e.target.className,e.ctrlKey,e.button,e.detail,e.clientX,e.clientY,hit?.item?.id]);
      },true);
    });
    const card=page.locator(".sheet-connection-card"), pin=page.locator(".sheet-connection-properties");
    async function point(id) {
      return page.evaluate(id=>{
        const h=AtriumNavHost, i=h.doc().items.find(x=>x.id===id), r=h.canvas().getBoundingClientRect();
        const p=i.kind==="sheetsymbol"?AtriumSchObjects.entryPoint(i,i.entries[0]):[i.x,i.y];
        const [x,y]=h.view().worldToScreen(p);return {x:r.left+x,y:r.top+y};
      },id);
    }
    async function move(id) {const p=await point(id);await page.mouse.move(p.x,p.y);return p;}
    async function ctrlDouble(id) {const p=await point(id);await page.keyboard.down("Control");try {await page.mouse.dblclick(p.x,p.y);} finally {await page.keyboard.up("Control");}}
    const doc=async id=>page.waitForFunction(id=>AtriumNavHost.currentId()===id,id);
    async function shot(name) {if(shots)await page.screenshot({path:path.join(shots,name+".png")});}
    const runs=await page.evaluate(()=>{
      window.hierarchyRuns=0; window.compilerCalls=[];
      const original=AtriumHierarchy.compileCached;
      AtriumHierarchy.compileCached=(...args)=>{window.hierarchyRuns++;window.compilerCalls.push(new Error().stack);return original(...args);};
      return hierarchyRuns;
    });
    const p=await move("vin");
    await page.clock.runFor(120);
    assert.equal(await card.count(),0);
    await card.waitFor(); await card.locator("canvas[data-ready]").waitFor();
    assert.match(await card.innerText(),/Control[\s\S]+Sheet entry VIN · input/);
    assert.equal(await page.evaluate(()=>hierarchyRuns),runs,"hover and thumbnails never invoke the compiler");
    const b=await card.boundingBox();assert.ok(p.x<b.x || p.x>b.x+b.width || p.y<b.y || p.y>b.y+b.height);
    await shot("port-hover");
    await page.mouse.click(p.x,p.y);
    await pin.locator("canvas[data-ready]").waitFor();assert.equal(await card.count(),0);
    assert.deepEqual(await page.evaluate(()=>AtriumNavHost.selection()),["vin"],"canvas click passes through");
    await page.mouse.move(p.x,p.y+18);await move("vin");
    await card.locator("button[data-entry=entry]").click();await doc("control");
    await page.keyboard.press("Alt+ArrowLeft");await doc("sensor");
    await ctrlDouble("vin"); await doc("control");
    assert.deepEqual(await page.evaluate(()=>AtriumNavHost.selection()),["sym1"]);
    await page.locator(".sheet-connection-flash").waitFor(); await pin.locator("button[data-item=vin]").waitFor();
    await page.keyboard.press("Alt+ArrowLeft"); await doc("sensor");
    assert.deepEqual(await page.evaluate(()=>AtriumNavHost.selection()),["vin"]);
    await page.keyboard.press("Alt+ArrowRight");await doc("control");
    await ctrlDouble("sym1");await doc("sensor");
    await page.evaluate(()=>{const h=AtriumNavHost;h.view().restoreCamera({cx:17,cy:24,scale:8,referenceScale:6});h.redraw();});
    await ctrlDouble("clock");await card.locator("button[data-item=clk-b]").waitFor();
    assert.equal(await card.locator("button.sheet-connection-target").count(),2);
    assert.ok(await card.locator("button:focus").count()); await page.keyboard.press("Enter");await doc("other");
    await page.evaluate(()=>{const h=AtriumNavHost;h.selectDocument("sensor");h.view().restoreCamera({cx:17,cy:24,scale:8,referenceScale:6});h.redraw();});
    await move("orphan");await card.waitFor();
    assert.match(await card.innerText(),/Not connected to any other sheet/);assert.match(await card.innerText(),/hierarchical scope connects ports only to sheet entries/);
    await page.keyboard.press("Escape");await card.waitFor({state:"detached"});
    await page.evaluate(()=>{const h=AtriumNavHost;h.selectDocument("control");h.view().restoreCamera({cx:23,cy:25,scale:6,referenceScale:6});h.redraw();});
    await move("earth");await card.locator("canvas[data-ready]").last().waitFor();
    assert.match(await card.innerText(),/GND: 12 connections on 1 sheet/);assert.equal(await card.locator("canvas").count(),3);
    await page.mouse.move(2,2);await card.waitFor({state:"detached"});
    await page.evaluate(()=>{const h=AtriumNavHost;h.selectDocument("board");h.select(["track"]);h.act("cross-probe");});
    await doc("control"); await pin.locator("button[data-item=ground0]").waitFor();
    assert.deepEqual(await page.evaluate(()=>AtriumNavHost.selection()),["earth"]);
    await shot("pcb-cross-probe");
    await page.evaluate(()=>{const h=AtriumNavHost;h.selectDocument("board");h.openSplit("right","control");h.select(["track"]);h.act("cross-probe");});
    assert.equal(await page.evaluate(()=>AtriumNavHost.currentId()),"board");
    assert.ok(await page.evaluate(()=>AtriumNavHost.panes().some(p=>!p.active && p.docId==="control")));
    await page.evaluate(()=>AtriumNavHost.act("split-close"));
    await page.evaluate(()=>{const h=AtriumNavHost;h.selectDocument("sensor");h.select(["vin"]);});
    await pin.locator("button[data-item=sym1]").waitFor();
    await page.evaluate(()=>{const h=AtriumNavHost,i=h.doc().items.find(x=>x.id==="vin");h.edit(()=>{i.text="RENAMED";},undefined,[i]);});
    await pin.getByText("Not connected to any other sheet").waitFor();
    await page.evaluate(()=>AtriumNavHost.act("undo"));await pin.locator("button[data-item=sym1]").waitFor();
    await page.evaluate(()=>AtriumTheme.setPreset("light"));
    await pin.locator("canvas[data-ready]").waitFor();await shot("properties-light");
    await page.evaluate(()=>{const h=AtriumNavHost;h.select([]);AtriumPower.setMode("always");});
    await page.evaluate(()=>{
      const h=AtriumNavHost, item=h.doc().items.find(i=>i.id==="vin");
      window.compilerCalls.length=0;h.edit(()=>{item.text="VIN2";},undefined,[item]);
    });
    await page.clock.runFor(450);
    assert.equal(await page.evaluate(()=>compilerCalls.filter(s=>s.includes("/connection-preview.js")).length),0,"Efficiency does no speculative hierarchy compilation");
    // A hover that dwells is a request: it loads the connections by itself, without a Load button.
    await move("vin");await card.waitFor();await card.getByText("Not connected to any other sheet").waitFor();
    assert.equal(await card.getByRole("button",{name:"Load connections"}).count(),0);
    await page.keyboard.press("Escape");
    const held=await page.evaluate(()=>{
      const h=AtriumNavHost,c=h.canvas(),i=h.doc().items.find(x=>x.id==="vin"),r=c.getBoundingClientRect(),p=h.view().worldToScreen([i.x,i.y]);
      return !c.dispatchEvent(new CustomEvent("waffle-canvas-hold",{bubbles:true,cancelable:true,detail:{canvas:c,docId:h.currentId(),item:i,itemId:i.id,clientX:r.left+p[0],clientY:r.top+p[1],pointerType:"touch"}}));
    });
    assert.ok(held);await card.waitFor();
    await page.keyboard.press("Escape");
    await page.evaluate(()=>{
      const h=AtriumNavHost,p=h.project(),d=h.docById("other");
      h.edit(()=>{p.rules.list[0].netScope="global";d.items.push({id:"peer-label",kind:"netlabel",text:"LOCAL",x:20,y:40});});
      h.view().restoreCamera({cx:17,cy:24,scale:8,referenceScale:6});h.redraw();
    });
    await ctrlDouble("local");await doc("other");
    assert.deepEqual(await page.evaluate(()=>AtriumNavHost.selection()),["peer-label"]);
    assert.deepEqual(errors,[]);
    console.log("PASS actual hover, thumbnail, click-through, entry selection, Ctrl+double-click, choices, keyboard, Back/Forward, ignored hierarchical names, power cap, board cross-probe, undo and themes");
  } catch (e) {
    if (process.env.CONNECTION_TRACE) console.log(await page.evaluate(()=>({input:window.inputTrace,calls:window.compilerCalls,doc:AtriumNavHost.currentId(),selection:AtriumNavHost.selection(),cam:AtriumNavHost.view().camera(),dialog:document.querySelector("dialog[open]")?.className,status:document.querySelector("#status")?.textContent})),errors);
    throw e;
  } finally {await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
