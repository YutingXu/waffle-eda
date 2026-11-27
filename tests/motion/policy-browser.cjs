"use strict";
const assert = require("node:assert/strict"), path = require("node:path"), {pathToFileURL} = require("node:url");
const {chromium} = require("../support/playwright.cjs");
const serveApp = require("../support/browser-app-server.cjs");

async function checkColdFlags(browser) {
  const app = await serveApp();
  const page = await browser.newPage();
  let release;
  const held = new Promise(resolve => {release = resolve;});
  try {
    await page.route("**/automation/command-broker.js", async route => {await held; await route.continue();});
    await page.addInitScript(() => {
      localStorage.setItem("atrium.prefs", JSON.stringify({format:"atrium-prefs", version:1, values:{
        "butter.motion":true, "butter.links":"true", "butter.numericFields":1,
      }}));
      Object.defineProperty(globalThis, "AtriumLabs", {configurable:true,set(labs) {
        globalThis.earlyButterFlags = ["motion", "links", "numericFields", "macros"].map(feature => labs.butterEnabled(feature));
        Object.defineProperty(globalThis, "AtriumLabs", {value:labs, configurable:true, writable:true});
      }});
    });
    await page.goto(app.url, {waitUntil:"domcontentloaded"});
    const cold = await page.evaluate(async () => {
      const motion = await AtriumLazy.need("AtriumMotion");
      return {flags:earlyButterFlags, motion:motion.butterEnabled(), broker:!!globalThis.AtriumButter};
    });
    assert.deepEqual(cold, {flags:[true,false,false,false], motion:true, broker:false});
    release();
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => AtriumNavHost.project().name === "Sensor interface" &&
      !!AtriumKeymap.command("butter.motion.policy"));
    const enabled = await page.evaluate(() => ["motion", "links", "numericFields", "macros"].map(feature => AtriumButter.state(feature).enabled));
    assert.deepEqual(enabled, cold.flags);
    await page.locator("#canvas").focus();
    await page.keyboard.press("F1");
    const palette = page.locator("#palette[open]");
    await palette.getByRole("combobox").fill("Inspect motion eligibility");
    const command = palette.getByRole("listbox", {name:"Results"}).getByText("Inspect motion eligibility", {exact:true});
    await command.waitFor();
    await page.evaluate(() => AtriumPrefs.set("butter.motion", false));
    await command.waitFor({state:"detached"});
    assert.equal(await palette.isVisible(), true);
    assert.equal(await page.evaluate(() => AtriumMotion.butterEnabled()), false);
  } finally {
    release();
    await page.close();
    await app.close();
  }
}

(async () => {
  const browser = await chromium.launch({channel:"chrome",args:["--allow-file-access-from-files"]});
  try {
    await checkColdFlags(browser);
    const page=await browser.newPage({viewport:{width:1120,height:720}});
    await page.addInitScript(()=>{
      const raf=requestAnimationFrame.bind(window), cancel=cancelAnimationFrame.bind(window);
      window.motionClockFrames=0;
      window.edgeFrames=0;window.allFrames=0;window.pendingEdge=new Set();
      window.requestAnimationFrame=f=>{
        const edge=f.name==="edgeStep";
        const id=raf(t=>{allFrames++;if(f.name==="tick")motionClockFrames++;if(edge){pendingEdge.delete(id);edgeFrames++;}f(t);});
        if(edge)pendingEdge.add(id);
        return id;
      };
      window.cancelAnimationFrame=id=>{pendingEdge.delete(id);cancel(id);};
    });
    await page.goto(pathToFileURL(path.resolve(__dirname,"../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    const feature = await page.evaluate(async()=>{
      await AtriumLazy.need("AtriumButter");
      const id = suffix => `butter.motion.${suffix}`;
      const failure = promise => promise.then(()=>null,error=>error.code);
      const before = AtriumButter.state("motion");
      const disabled = await failure(AtriumButter.run(id("policy")));
      const dormant = !globalThis.AtriumButterFeature_motion;
      AtriumPrefs.set("butter.motion",true);
      await AtriumLazy.need("AtriumButterEditor");
      const revision = AtriumNavHost.revision();
      const policy = await AtriumButter.run(id("policy"),{requested:"full",input:"keyboard"});
      const plan = await AtriumButter.run(id("plan"),{kind:"camera",duration:"slow",level:"full",visibility:"occluded"},{source:"macro",mode:"plan"});
      const args = {from:0,to:80,elapsedMs:50,durationMs:200,curve:"linear"};
      const sample = await AtriumButter.run(id("sample"),args);
      const retarget = await AtriumButter.run(id("retarget"),{...args,previousTarget:80,to:-40});
      const malformed = await failure(AtriumButter.run(id("sample"),{...args,elapsedMs:-1}));
      const write = await failure(AtriumButter.run(id("retarget"),{...args,previousTarget:80},{mode:"write"}));
      const available = AtriumButter.list().filter(command=>command.id.startsWith("butter.motion.")).map(command=>command.id).sort();
      const stable = revision === AtriumNavHost.revision();
      AtriumPrefs.set("butter.motion",false);
      return {before,disabled,dormant,policy:policy.result.level,plan,displayed:sample.result.value,from:retarget.result.from,
        malformed,write,available,stable,after:AtriumButter.state("motion"),removed:!AtriumButter.list().some(c=>c.id.startsWith("butter.motion."))};
    });
    assert.deepEqual(feature.before,{enabled:false,available:false});
    assert.deepEqual(feature.after,feature.before);
    assert.equal(feature.disabled,"butter_disabled");assert.equal(feature.dormant,true);assert.equal(feature.removed,true);
    assert.equal(feature.policy,"off");assert.equal(feature.plan.mode,"plan");assert.equal(feature.plan.result.durationMs,320);
    assert.equal(feature.plan.result.disposition,"paused");assert.equal(feature.displayed,20);assert.equal(feature.from,20);
    assert.equal(feature.malformed,"invalid_arguments");assert.equal(feature.write,"unsupported_mode");assert.equal(feature.stable,true);
    assert.deepEqual(feature.available,["plan","policy","retarget","sample"].map(id=>`butter.motion.${id}`));
    await page.evaluate(async()=>{
      await AtriumLazy.need(["AtriumMotion","AtriumCamera"]);
      AtriumPower.setMode("off");AtriumTheme.set({motion:"full"});AtriumNavHost.act("fit");
    });
    await page.waitForFunction(()=>!AtriumMotion.active());
    await page.evaluate(()=>{
      AtriumNavHost.act("zoom-in");AtriumNavCommon.toast("View changed",{ms:180});
    });
    await page.waitForFunction(()=>document.querySelector(".ui-toast").getAnimations().some(a=>a instanceof CSSTransition&&a.currentTime>0));
    const frozen=await page.evaluate(()=>{
      AtriumPower.host({occluded:true});
      const toast=document.querySelector(".ui-toast"), transition=toast.getAnimations().find(a=>a.transitionProperty==="opacity");
      if(!transition)throw Error("missing opacity transition");
      window.pausedToast=transition;
      return {cx:AtriumNavHost.view().camera().scale,t:transition.currentTime,frames:motionClockFrames};
    });
    await page.waitForTimeout(260);
    const later=await page.evaluate(()=>({cx:AtriumNavHost.view().camera().scale,t:pausedToast.currentTime,frames:motionClockFrames,paused:document.documentElement.hasAttribute("data-motion-paused")}));
    assert.equal(later.cx,frozen.cx);assert.equal(later.frames,frozen.frames);assert.equal(later.paused,true);
    assert.ok(Math.abs(later.t-frozen.t)<1,"the toast transition holds its visible appearance " + JSON.stringify({frozen,later}));
    assert.equal(await page.locator(".ui-toast").evaluate(el=>el.hidden),false,"the notice keeps its reading time while hidden");
    await page.evaluate(()=>AtriumPower.host({occluded:false}));
    await page.waitForFunction(()=>document.querySelector(".ui-toast").hidden);
    await page.waitForFunction(()=>!AtriumMotion.active());
    assert.ok(await page.evaluate(x=>AtriumNavHost.view().camera().scale>x,frozen.cx));
    await page.emulateMedia({reducedMotion:"reduce"});
    const reduced=await page.evaluate(()=>{
      AtriumTheme.set({motion:"system"});
      const h=AtriumNavHost,scale=h.view().camera().scale;h.act("zoom-in");
      return {level:AtriumMotion.level(),ratio:h.view().camera().scale/scale,travel:getComputedStyle(document.documentElement).getPropertyValue("--motion-move").trim()};
    });
    assert.equal(reduced.level,"reduced");assert.equal(reduced.travel,"0");assert.ok(Math.abs(reduced.ratio-1.25)<1e-12);
    await page.evaluate(()=>{AtriumTheme.set({motion:"full"});AtriumNavHost.act("zoom-in");AtriumPower.setMode("always");});
    const idle=await page.evaluate(()=>({active:AtriumMotion.active(),frames:motionClockFrames,mode:AtriumMotion.level()}));
    assert.equal(idle.mode,"off");assert.equal(idle.active,0);
    await page.waitForTimeout(1000);
    assert.equal(await page.evaluate(()=>motionClockFrames),idle.frames,"no decorative ticks during a second of idle efficiency mode");

    await page.emulateMedia({reducedMotion:"no-preference"});
    const board = await page.evaluate(async()=>{
      const h=AtriumNavHost, project=AtriumParts.example();
      const sheet=project.documents.find(d=>d.kind==="schematic"),board=project.documents.find(d=>d.kind==="pcb");
      const spare=Atrium.sheet("pcb","Second board");project.documents.push(spare);
      await h.replaceProject(project,{copy:true,force:true,dirty:false});h.selectDocument(sheet.id);
      h.openSplit("right",board.id);await AtriumLazy.need("AtriumSplitFollow");
      AtriumPower.setMode("off");AtriumTheme.set({motion:"full"});
      const other=()=>h.panes().find(p=>!p.active);
      const moveAway=()=>other().view.restoreCamera({...other().view.camera(),cx:-500,cy:-500,scale:1});
      const [selected,next]=sheet.items.filter(i=>i.kind==="part"&&board.items.some(j=>j.kind==="part"&&j.ref===i.ref));
      window.splitMotion={other,moveAway,spare:spare.id,board:board.id,selected:selected.id,next:next.id};
      moveAway();h.select([selected.id]);
      return board.id;
    });
    await page.waitForFunction(()=>AtriumMotion.active()===1);
    const newer=await page.evaluate(()=>{
      const {other,spare}=splitMotion;
      AtriumPower.host({occluded:true});
      const held=AtriumMotion.active();
      AtriumNavHost.showInOther(spare);
      const result={held,active:AtriumMotion.active(),id:other().docId,cam:other().view.camera()};
      AtriumPower.host({occluded:false});
      return result;
    });
    assert.equal(newer.held,1,"the window holds a live Follow glide while occluded");
    assert.equal(newer.active,0,"replacing the destination retires the held glide immediately");
    assert.notEqual(newer.id,board);
    await page.waitForTimeout(380);
    assert.deepEqual(await page.evaluate(()=>({id:splitMotion.other().docId,cam:splitMotion.other().view.camera()})),
      {id:newer.id,cam:newer.cam},"resuming preserves the newer pane document and its camera");

    await page.evaluate(()=>{
      const h=AtriumNavHost, {board,moveAway,selected}=splitMotion;
      h.showInOther(board);h.select([]);moveAway();
      // Use the normal key capture and selection event, then model the input marker the
      // competing pointer click writes while the Follow debounce is pending.
      h.canvas().dispatchEvent(new KeyboardEvent("keydown",{key:"Shift",bubbles:true}));
      if(document.documentElement.dataset.motionInput!=="keyboard")throw Error("keyboard input was not classified");
      h.select([selected]);delete document.documentElement.dataset.motionInput;
      splitMotion.beforeKeyFrames=motionClockFrames;
    });
    await page.waitForFunction(()=>splitMotion.other().view.camera().cx!==-500);
    assert.deepEqual(await page.evaluate(()=>({active:AtriumMotion.active(),ticks:motionClockFrames-splitMotion.beforeKeyFrames,
      pulses:document.querySelectorAll(".split-follow-pulse").length})),{active:0,ticks:0,pulses:0},
    "a later pointer marker cannot animate a keyboard-originated Follow");

    await page.evaluate(()=>{
      const h=AtriumNavHost;
      splitMotion.moveAway();h.select([splitMotion.next]);
    });
    await page.waitForFunction(()=>AtriumMotion.active()===1);
    const disposed=await page.evaluate(()=>{
      const h=AtriumNavHost;
      AtriumPower.host({occluded:true});
      const view=splitMotion.other().view, camera=view.camera();
      h.act("split-close");
      const result={active:AtriumMotion.active(),panes:h.panes().length};
      window.retiredPaneCamera=()=>({current:view.camera(),before:camera});
      AtriumPower.host({occluded:false});
      return result;
    });
    assert.deepEqual(disposed,{active:0,panes:1},"closing the destination cancels a held glide");
    await page.waitForTimeout(350);
    const retired=await page.evaluate(()=>retiredPaneCamera());
    assert.deepEqual(retired.current,retired.before,"resuming does not move the discarded pane");

    const cameraBeforeEdge=await page.evaluate(()=>{
      const h=AtriumNavHost;
      AtriumCamera.setPref("camera.edgeScroll","on");
      window.edgeInput=()=>{
        const c=h.canvas(),b=c.getBoundingClientRect();
        c.dispatchEvent(new PointerEvent("pointermove",{bubbles:true,pointerType:"mouse",clientX:b.left+1,clientY:b.top+b.height/2}));
      };
      window.edgeState=()=>({camera:h.view().camera(),frames:edgeFrames,pending:pendingEdge.size});
      edgeInput();
      return h.view().camera().cx;
    });
    await page.waitForFunction(before=>AtriumNavHost.view().camera().cx!==before,cameraBeforeEdge);
    const hiddenEdge=await page.evaluate(()=>{AtriumPower.host({occluded:true});return edgeState();});
    assert.equal(hiddenEdge.pending,0);
    await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(()=>edgeState()),hiddenEdge,"edge scrolling stops while the host is occluded");
    await page.evaluate(()=>AtriumPower.host({occluded:false}));
    await page.waitForTimeout(180);
    assert.deepEqual(await page.evaluate(()=>edgeState()),hiddenEdge,"visibility waits for new edge input");
    await page.evaluate(()=>edgeInput());
    await page.waitForFunction(before=>AtriumNavHost.view().camera().cx!==before,hiddenEdge.camera.cx);
    const efficientEdge=await page.evaluate(()=>{
      AtriumPower.setMode("always");edgeInput();return edgeState();
    });
    assert.equal(efficientEdge.pending,0);
    await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
    const idleFrames=await page.evaluate(()=>({all:allFrames,motion:motionClockFrames,edge:edgeFrames}));
    await page.waitForTimeout(1000);
    assert.deepEqual(await page.evaluate(()=>edgeState()),efficientEdge,"Efficiency stops and blocks further edge scrolling");
    const laterFrames=await page.evaluate(()=>({all:allFrames,motion:motionClockFrames,edge:edgeFrames}));
    assert.deepEqual(laterFrames,idleFrames,"no editor display callbacks during settled idle Efficiency");
    console.log("PASS browser motion: gated editor and macro commands, live occlusion paused camera and toast, zero hidden ticks, live resume, OS Reduce and efficiency landed, zero idle ticks");
    console.log("PASS Split Follow ownership and keyboard provenance, active edge-scroll retirement, and zero display callbacks in 1s of settled Efficiency");
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
