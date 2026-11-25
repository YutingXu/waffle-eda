"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const {pathToFileURL} = require("node:url");

module.exports = async function touchPrecision(browser) {
  const page = await browser.newPage({viewport:{width:1450,height:950},hasTouch:true,deviceScaleFactor:1.5});
  await require("../fixtures/notebook-labs.cjs").profile(page);
  const errors=[];
  page.on("pageerror",e=>errors.push(e.stack));
  try {
    await page.clock.install();
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(()=>globalThis.AtriumNavHost?.doc()?.kind==="pcb");
    await page.evaluate(async () => {
      const h=AtriumNavHost, p=Atrium.project("Touch precision"), sheet=p.documents[0], board=p.documents[1];
      sheet.grid=1;
      sheet.items=[{kind:"wire",id:"lead",points:[[-12,-5],[5,-5]]},
        {id:"one",kind:"label",x:-10,y:8,text:"ONE"},{id:"two",kind:"label",x:5,y:8,text:"TWO"}];
      board.grid=1; board.items=[{id:"via",kind:"via",x:0,y:0,net:"GND",diameter:1.5,drill:.5}];
      await h.replaceProject(p,{force:true,dirty:false}); h.selectDocument(sheet.id);
      await AtriumLazy.need(["AtriumCamera","AtriumSchPlace"]);
      h.select(["lead"]); AtriumCamera.takeCamera(h.view()); h.view().restoreCamera({...h.view().camera(),cx:0,cy:0,scale:10}); h.redraw();
      globalThis.touchSamples=0;
      const draw=CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage=function(...args){
        if(this.canvas.parentElement?.classList.contains("touch-loupe"))touchSamples++;
        return draw.apply(this,args);
      };
    });
    assert.equal(await page.evaluate(()=>!!globalThis.AtriumTouchPrecision),false,"precision UI is absent before touch");
    const session=await page.context().newCDPSession(page);
    const contact=(type,p,id=1)=>session.send("Input.dispatchTouchEvent",{type,touchPoints:p?[{id,x:p[0],y:p[1]}]:[]});
    const pt=(world,library=false)=>page.evaluate(([p,library])=>{
      const c=library?lib.dialog.querySelector("canvas"):AtriumNavHost.canvas(), rect=c.getBoundingClientRect();
      const s=library?lib.stage.toScreen(p):AtriumNavHost.view().worldToScreen(p);
      return [s[0]+rect.left,s[1]+rect.top];
    },[world,library]);
    const tap=async p=>{await contact("touchStart",p);await contact("touchEnd");};
    const frame=()=>page.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))));
    const drag=async(from,to,cancel=false)=>{
      await contact("touchStart",from); await contact("touchMove",to);await frame();
      assert.equal(await page.locator(".touch-loupe:visible").count(),1,"loupe appears over the active surface");
      assert.ok(await page.evaluate(()=>touchSamples)>0,"backing canvas sampled");
      await contact(cancel?"touchCancel":"touchEnd");await frame();
      assert.equal(await page.locator(".touch-loupe:visible").count(),0,"loupe leaves on release or cancel");
    };
    const key=k=>page.locator('.touch-modifiers [data-key="'+k+'"]');
    const items=()=>page.evaluate(()=>AtriumNavHost.doc().items);
    const history=()=>page.evaluate(()=>AtriumNavHost.undoSteps().history.length);
    const undo=()=>page.evaluate(()=>AtriumNavHost.act("undo"));
    const redo=()=>page.evaluate(()=>AtriumNavHost.act("redo"));
    const shift=(p,x,y)=>[p[0]+x,p[1]+y];
    const orig=await items(), before=await history();
    const tip=await pt([-12,-5]), near=shift(tip,0,-21), target=shift(near,13,43);
    // First contact occurs with Camera warm and precision cold. Replay must keep the offset.
    await drag(near,target);
    assert.deepEqual((await items())[0].points[0],[-11,-1]);
    assert.equal(await history(),before+1);
    await undo();assert.deepEqual(await items(),orig); await redo();assert.deepEqual((await items())[0].points[0],[-11,-1]);
    await undo();
    await page.evaluate(()=>AtriumNavHost.select(["lead"]));
    await drag(near,target,true);assert.deepEqual(await items(),orig);assert.equal(await history(),before);

    // The untouched mouse/pen grip tolerance stays small.
    await session.send("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",buttons:1,x:near[0],y:near[1],pointerType:"pen",force:.67,tiltX:25});
    await session.send("Input.dispatchMouseEvent",{type:"mouseMoved",button:"left",buttons:1,x:target[0],y:target[1],pointerType:"pen",force:.71,tiltX:30});
    await session.send("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",x:target[0],y:target[1],pointerType:"pen"});
    assert.deepEqual(await items(),orig);assert.equal(await page.locator(".touch-loupe:visible").count(),0);
    const one=await pt([-10,8]),two=await pt([5,8]);
    await tap(one);assert.deepEqual(await page.evaluate(()=>AtriumNavHost.selection()),["one"],"first selection");
    await key("shiftKey").tap();assert.deepEqual(await page.evaluate(()=>AtriumCanvasInput.modifiers()),{shiftKey:true,ctrlKey:false,altKey:false},"Shift button armed");await tap(two);
    assert.deepEqual((await page.evaluate(()=>AtriumNavHost.selection())).sort(),["one","two"]);
    assert.equal(await key("shiftKey").getAttribute("aria-pressed"),"false");
    for(const k of ["shiftKey","ctrlKey","altKey","lock"]){
      const b=await key(k).boundingBox();assert.ok(b.width>=44&&b.height>=44);
    }
    await key("lock").tap();await key("ctrlKey").tap();await key("altKey").tap();
    await page.evaluate(()=>AtriumTheme.set({preset:"light",followSystem:false,motion:"off"},{persist:false}));
    assert.equal(await page.evaluate(()=>!!globalThis.AtriumPastePlan),false,"ordinary touch edits leave the paste planner cold");
    // Hold the real script insertion on file:// until both gestures have ended.
    await page.evaluate(()=>{
      const head=document.head, append=head.append;
      head.append=function(...nodes){
        if(nodes[0]?.getAttribute?.("src")==="editor/paste-plan.js"){
          head.append=append;
          globalThis.allowPastePlanner=()=>head.append(...nodes);
        }else append.apply(this,nodes);
      };
    });
    await drag(one,shift(one,36,28),true);assert.deepEqual(await items(),orig);
    await drag(one,shift(one,36,28));
    assert.deepEqual(await items(),orig,"release while the planner loads waits to commit");
    await page.evaluate(()=>allowPastePlanner());
    await page.waitForFunction(n=>AtriumNavHost.doc().items.length===n+2,orig.length);
    const moved=await items(), copies=moved.slice(orig.length);
    assert.deepEqual(moved.slice(0,orig.length),orig); assert.equal(copies.length,2);
    assert.ok(Math.abs((copies[0].x-orig[1].x)-3.6)<.05);assert.ok(Math.abs((copies[0].y-orig[1].y)-2.8)<.05);
    assert.equal(await history(),before+1);
    await undo();assert.deepEqual(await items(),orig);
    assert.equal(await key("ctrlKey").getAttribute("aria-pressed"),"true");
    await key("ctrlKey").tap();await key("lock").tap();
    await page.evaluate(()=>AtriumNavHost.setTool("label"));
    const dest=await pt([13.4,7.7]);
    await drag(shift(dest,-24,-19),dest);
    const placed=(await items()).at(-1);
    assert.equal(placed.kind,"netlabel");assert.ok(Math.abs(placed.x-13.4)<.05&&Math.abs(placed.y-7.7)<.05);
    assert.equal(await key("altKey").getAttribute("aria-pressed"),"false");
    await undo();assert.deepEqual(await items(),orig);

    // An armed placement displays its aim while the finger rests. A second contact
    // takes over for navigation, clears the overlay and leaves the document unchanged.
    await page.evaluate(()=>AtriumNavHost.setTool("label"));
    await contact("touchStart",dest);await frame();
    assert.equal(await page.locator(".touch-loupe:visible").count(),1);
    assert.equal(await page.locator(".touch-snap-point:visible").count(),1);
    await session.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[
      {id:1,x:dest[0],y:dest[1]},{id:2,x:dest[0]+58,y:dest[1]+70}]});
    // Rest past the two-finger tap window: a quick two-finger tap would be Undo (canvas-input.js GESTURES).
    await page.clock.runFor(320);
    await contact("touchEnd");await frame();
    assert.equal(await page.locator(".touch-loupe:visible").count(),0);assert.deepEqual(await items(),orig);

    if (process.env.WAFFLE_TOUCH_EVIDENCE || process.env.WAFFLE_TOUCH_TIMING) {
      const output=process.env.WAFFLE_TOUCH_EVIDENCE;
      if (output) fs.mkdirSync(output,{recursive:true});
      for (const theme of ["dark","light"]) {
        await page.evaluate(theme=>{AtriumTheme.set({preset:theme,followSystem:false,motion:"off"},{persist:false});
          AtriumNavHost.setTool("label");},theme);
        await frame();
        await contact("touchStart",dest);await contact("touchMove",shift(dest,-25,-25));await frame();
        if (output) await page.locator("#canvas-stage").screenshot({path:path.join(output,"touch-"+theme+".png")});
        await contact("touchCancel");await frame();
        if (process.env.WAFFLE_TOUCH_TIMING) {
          const result=await page.evaluate(async()=>{
            const h=AtriumNavHost,c=h.canvas(),r=c.getBoundingClientRect(), start=[r.left+r.width*.7,r.top+r.height*.65];
            const samples=[],paints=[], latency=[], callbacks=[];
            // Account for the editor and magnifier animation callbacks together on each frame.
            const oldFrame=window.requestAnimationFrame;
            window.requestAnimationFrame=function(f){return oldFrame.call(this,time=>{const t=performance.now();try{return f(time);}finally{callbacks.push({time,ms:performance.now()-t});}});};
            const fire=(type,x,y)=>c.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:912,pointerType:"touch",isPrimary:true,button:type==="pointermove"?-1:0,buttons:type==="pointerup"?0:1,clientX:x,clientY:y}));
            // Dispatch one synthetic touch move per display callback, through the real editor.
            try {
              fire("pointerdown",...start);
              for(let i=0;i<48;i++){
                const t=performance.now();
                fire("pointermove",start[0]+Math.sin(i*.17)*27,start[1]+Math.cos(i*.12)*33);
                samples.push(performance.now()-t);
                const ft=await new Promise(ok=>oldFrame.call(window,ok));
                paints.push(callbacks.filter(v=>v.time===ft).reduce((sum,v)=>sum+v.ms,0));
                latency.push(performance.now()-t);
              }
              fire("pointercancel",...start);
            } finally {window.requestAnimationFrame=oldFrame;}
            const summary=v=>{const a=v.toSorted((x,y)=>x-y);return {median:a[Math.floor(a.length/2)],p95:a[Math.floor(a.length*.95)],max:a.at(-1)};};
            return {samples:samples.length,dispatch:summary(samples),animationCallbacks:summary(paints),dispatchToFrame:summary(latency)};
          });
          console.log("TIMING "+theme+" "+JSON.stringify(result));
        }
      }
    }
    await page.evaluate(()=>{const h=AtriumNavHost;h.selectDocument(h.project().documents[1].id);h.setTool("select");
      h.view().restoreCamera({...h.view().camera(),cx:0,cy:0,scale:25});h.redraw();});
    const via=await pt([0,0]);await tap(via);await key("ctrlKey").tap();await drag(via,shift(via,48,24));
    const vias=await items();assert.equal(vias.length,2);assert.deepEqual([vias[1].x,vias[1].y],[2,1]);
    await undo();assert.equal((await items()).length,1);

    for(const kind of ["symbol","footprint"]){
      await page.evaluate(async kind=>{
        await AtriumLazy.need("AtriumLibrary");
        globalThis.lib=kind==="symbol"?AtriumSymbolEditor.open():AtriumFootprintEditor.open();
        lib.setTool(kind==="symbol"?"pin":"pad");
      },kind);
      await frame();const origin=await pt([0,0],true);
      assert.equal(await page.evaluate(([x,y])=>document.elementFromPoint(x,y)?.tagName,origin),"CANVAS","library origin is on canvas");
      await tap(origin);
      await page.evaluate(()=>lib.setTool("select"));await tap(origin);
      assert.equal(await page.evaluate(()=>document.querySelector(".touch-modifiers").closest("dialog")===lib.dialog),true,"library owns modifiers");
      await key("ctrlKey").tap();await key("altKey").tap();
      const rows=()=>page.evaluate(k=>k==="symbol"?lib.model.pins:lib.draft.footprint.pads,kind);
      const old=await rows();await drag(origin,shift(origin,36,21));
      const next=await rows();assert.equal(next.length,old.length+1,kind+" duplicate");
      assert.deepEqual(next.slice(0,old.length),old);assert.notEqual(next.at(-1).number,old.at(-1).number);
      await page.keyboard.press("Control+z");
      assert.deepEqual(await rows(),old,kind+" single Undo");
      await page.evaluate(()=>lib.dialog.close());
    }

    // Model an overlay keyboard and its viewport change independently of page layout.
    const keyboard=await page.evaluate(async()=>{
      const vv=window.visualViewport, height=Object.getOwnPropertyDescriptor(vv,"height");
      const dlg=document.createElement("dialog"), text=document.createElement("textarea");
      dlg.style.height="700px";const spacer=document.createElement("div");spacer.style.height="540px";
      dlg.append(spacer,text);document.body.append(dlg);dlg.showModal();text.focus();text.value="R1";text.setSelectionRange(1,1);
      Object.defineProperty(vv,"height",{configurable:true,value:300});vv.dispatchEvent(new Event("resize"));
      await new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok)));
      const field=text.getBoundingClientRect(), result={visible:field.bottom<=300&&field.top>=0,caret:text.selectionStart,scroll:dlg.scrollTop};
      dlg.close();dlg.remove();if(height)Object.defineProperty(vv,"height",height);else delete vv.height;
      result.reset=!document.body.classList.contains("touch-keyboard");return result;
    });
    assert.equal(keyboard.visible,true);assert.equal(keyboard.caret,1);assert.equal(keyboard.reset,true);assert.ok(keyboard.scroll>0);
    const inline=await page.evaluate(async()=>{
      const h=AtriumNavHost, c=h.canvas(),v=h.view(),vv=window.visualViewport,box=c.parentNode;
      const f=document.createElement("textarea");f.style.cssText="position:absolute;left:36%;bottom:4%;width:100px;height:30px";
      box.append(f);const b=c.getBoundingClientRect(),first=f.getBoundingClientRect(), world=v.screenToWorld([(first.left+first.right)/2-b.left, first.bottom-b.top]);
      const length=h.undoSteps().history.length, cam=v.camera();
      f.focus();Object.defineProperty(vv,"height",{configurable:true,value:320});vv.dispatchEvent(new Event("resize"));
      await new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok)));
      const y=c.getBoundingClientRect().top+v.worldToScreen(world)[1], end=v.camera();
      f.remove();delete vv.height;return {y,pan:cam.cy!==end.cy,unchanged:length===h.undoSteps().history.length};
    });
    assert.ok(inline.y<320&&inline.pan&&inline.unchanged,"inline text camera scrolls above keyboard without editing the design");
    const stable=await page.evaluate(()=>touchSamples);await frame();await frame();assert.equal(await page.evaluate(()=>touchSamples),stable,"idle has no loupe frames");
    assert.deepEqual(errors,[]);
    console.log("PASS touch precision: cold grip, loupe, cancellation, modifiers, two library editors, pen tolerance, keyboard viewport and idle");
  } finally {await page.close();}
};
if(require.main===module)require("playwright-core").chromium.launch(process.env.CHROME?{executablePath:process.env.CHROME}:{channel:"chrome"})
  .then(async b=>{try{await module.exports(b);}finally{await b.close();}})
  .catch(error=>{console.error(error);process.exitCode=1;});
