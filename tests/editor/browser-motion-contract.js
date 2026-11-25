"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function editor(browser) {
  const page = await browser.newPage({viewport:{width:1440,height:920},reducedMotion:"no-preference"});
  page.setDefaultTimeout(7000);
  await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
  await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
  await page.waitForFunction(() => globalThis.AtriumNavHost?.doc()?.items?.length);
  // Canvas input loads on first demand; load it here so a synthetic wheel event is handled synchronously.
  await page.evaluate(() => AtriumLazy.need(["AtriumMotion","AtriumCamera","AtriumCanvasInput","AtriumPrefs"]));
  return page;
}

async function inputPolicy(page) {
  const file = page.locator(".work-menu[data-menu=file] > summary");
  await file.focus();
  await page.keyboard.press("Enter");
  const keyMenu = await file.evaluate(summary => ({
    open:summary.parentElement.open,
    input:document.documentElement.dataset.motionInput,
    effects:summary.parentElement.querySelector(".menu-items").getAnimations().length
  }));
  assert.deepEqual(keyMenu,{open:true,input:"keyboard",effects:0},"native Enter opens File instantly");
  await page.keyboard.press("Escape");
  assert.equal(await file.evaluate(n=>n.parentElement.open),false,"keyboard dismissal is also immediate");

  await file.evaluate(summary=>summary.addEventListener("click", () => {
    const list = summary.nextElementSibling;
    window.menuOpenEffects = list.getAnimations().map(a => ({
      ms:a.effect.getTiming().duration,first:a.effect.getKeyframes()[0]
    }));
  },{once:true}));
  await file.click();
  const [entrance] = await page.evaluate(()=>window.menuOpenEffects);
  assert.equal(entrance.ms,120);
  assert.equal(entrance.first.transform,"scale(0.97)");
  const edit = page.locator(".work-menu[data-menu=edit]");
  await edit.locator("summary").hover();
  assert.equal(await edit.evaluate(menu=>menu.open && !menu.querySelector(".menu-items").getAnimations().length),true,
    "pointer movement between open menus is immediate");
  await page.keyboard.press("Escape");
  assert.equal(await edit.evaluate(n=>n.open),false);
  await page.mouse.click(8,8);
}

async function cameraPolicy(page) {
  await page.evaluate(() => {
    const raf = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
    let next = -1;
    const steps = new Map();
    window.requestAnimationFrame = callback => {
      if ((new Error().stack.split("\n")[2] || "").includes("/motion.js:")) {
        const id = next--;
        steps.set(id,callback);
        return id;
      }
      return raf(callback);
    };
    window.cancelAnimationFrame = id => {if (id < 0) steps.delete(id); else cancel(id);};
    const H = AtriumNavHost;
    H.selectDocument(H.project().documents.find(d=>d.kind==="pcb").id);
    const canvas = H.canvas(), view = H.view(), bounds = canvas.getBoundingClientRect();
    view.restoreCamera({...view.camera(),scale:2});
    const event = options => canvas.dispatchEvent(new WheelEvent("wheel",{
      bubbles:true,cancelable:true,clientX:bounds.left+bounds.width/2,clientY:bounds.top+bounds.height/2,...options
    }));
    window.motionCamera = {
      camera:()=>view.camera(), size:()=>steps.size,
      frame(at) {const [id,callback] = steps.entries().next().value; steps.delete(id); callback(at);},
      notch:()=>event({deltaMode:1,deltaY:-1}),
      pan:()=>event({deltaMode:0,deltaX:12,deltaY:28}),
      pinch:()=>event({deltaMode:0,deltaY:-37,ctrlKey:true}),
      restore() {window.requestAnimationFrame=raf; window.cancelAnimationFrame=cancel;}
    };
  });
  const values = await page.evaluate(async () => {
    const c = window.motionCamera, root=document.documentElement;
    const base = c.camera().scale, start=performance.now();
    c.notch(); const immediately = c.camera().scale;
    c.frame(start); c.frame(start+40); const middle = c.camera().scale;
    c.notch(); const afterRetarget = c.camera().scale;
    c.frame(start+41); c.frame(start+162); const landed = c.camera().scale;
    const idle = c.size(), beforePan = c.camera();
    c.pan(); const trackpad = c.camera();
    c.pinch(); const pinch = c.camera(), direct = c.size();
    c.notch(); root.dataset.motion="off";
    await Promise.resolve();
    const off = c.camera().scale, offIdle = c.size();
    root.dataset.motion="full";
    return {base,immediately,middle,afterRetarget,landed,idle,beforePan,trackpad,pinch,direct,off,offIdle};
  });
  const factor = Math.exp(.128);
  assert.equal(values.immediately,values.base);
  assert.ok(values.middle > values.base && values.middle < values.base * factor);
  assert.equal(values.afterRetarget,values.middle,"retarget starts at the rendered camera");
  assert.ok(Math.abs(values.landed - values.base * factor * factor) < 1e-9,"notches accumulate");
  assert.equal(values.idle,0,"camera owns no frames after settling");
  assert.notEqual(values.trackpad.cx,values.beforePan.cx);
  assert.equal(values.trackpad.scale,values.beforePan.scale);
  assert.ok(values.pinch.scale > values.trackpad.scale,"pinch lands synchronously");
  assert.equal(values.direct,0);
  assert.ok(Math.abs(values.off - values.pinch.scale * factor) < 1e-9,"Off lands a pending notch");
  assert.equal(values.offIdle,0);
  await page.emulateMedia({reducedMotion:"reduce"});
  assert.equal(await page.evaluate(()=>{
    const c = window.motionCamera, before=c.camera().scale;
    c.notch(); return c.camera().scale > before && c.size()===0 && AtriumMotionUI.enabled() && !AtriumMotionUI.moves();
  }),true,"OS reduction keeps eligible fades, while wheel movement is direct");
  await page.emulateMedia({reducedMotion:"no-preference"});
  const ownership = await page.evaluate(async () => {
    const H = AtriumNavHost, original = H.project(), p = structuredClone(original);
    const board = p.documents.find(d => d.kind === "pcb"), sheet = p.documents.find(d => d.kind === "schematic");
    const twin = d => ({...structuredClone(d), id:Atrium.id(), name:d.name + " copy"});
    const boardCopy = twin(board), sheetCopy = twin(sheet);
    p.documents.push(boardCopy, sheetCopy);
    await H.replaceProject(p, {force:true, dirty:false});
    H.selectDocument(board.id);
    await H.openSplit("right", sheet.id, {focus:false});
    const turn = pane => {
      const r = pane.canvas.getBoundingClientRect();
      pane.canvas.dispatchEvent(new WheelEvent("wheel", {bubbles:true, cancelable:true, ctrlKey:true,
        deltaMode:1, deltaY:-1, clientX:r.left+r.width/2, clientY:r.top+r.height/2}));
      return window.motionCamera.size();
    };
    const expected = H.panes().find(pane => !pane.active).view.camera();
    const inactivePending = turn(H.panes().find(pane => !pane.active));
    H.showInOther(sheetCopy.id);
    const other = H.panes().find(pane => !pane.active);
    const inactive = {pending:inactivePending, remaining:window.motionCamera.size(), replaced:other.docId===sheetCopy.id,
      sameCamera:JSON.stringify(expected)===JSON.stringify(other.view.camera())};
    const activePending = turn(H.panes().find(pane => pane.active));
    H.selectDocument(boardCopy.id);
    const active = {pending:activePending, remaining:window.motionCamera.size(), replaced:H.currentId()===boardCopy.id};
    await H.replaceProject(original, {force:true, dirty:false});
    return {inactive, active};
  });
  assert.deepEqual(ownership, {
    inactive:{pending:1, remaining:0, replaced:true, sameCamera:true},
    active:{pending:1, remaining:0, replaced:true}
  }, "a queued Control-wheel zoom stays with its original document, even when a replacement has the identical camera");
  await page.evaluate(()=>window.motionCamera.restore());
}

async function themePolicy(page) {
  await page.evaluate(()=>{
    const theme = AtriumTheme;
    theme.set({preset:"light",systemLight:"light",systemDark:"dark",followSystem:false,motion:"off"},{persist:false});
    theme.set({motion:"full"},{persist:false});
    window.themeMotionEffect = () => document.getAnimations().find(a=>a.animationName==="atrium-theme-out");
  });
  if (!await page.evaluate(()=>typeof document.startViewTransition==="function")) {
    assert.equal(await page.evaluate(()=>{AtriumTheme.toggle();return document.documentElement.dataset.theme;}),"dark");
    return;
  }
  await page.evaluate(()=>AtriumTheme.toggle());
  await page.waitForFunction(()=>themeMotionEffect());
  const transition = await page.evaluate(()=>{
    const root=document.documentElement, effect=themeMotionEffect();
    const alpha=()=>getComputedStyle(root,"::view-transition-old(root)").opacity;
    effect.pause();
    effect.currentTime=70;
    const before=alpha();
    AtriumTheme.toggle();
    return {before,after:alpha(),same:effect===themeMotionEffect(),duration:effect.effect.getTiming().duration,
      direction:effect.playbackRate,requested:AtriumTheme.get().preset,painted:root.dataset.theme,
      properties:Object.keys(effect.effect.getKeyframes()[0]).filter(k=>!["offset","computedOffset","easing","composite"].includes(k))};
  });
  assert.ok(Number(transition.before)>0 && Number(transition.before)<1);
  assert.equal(transition.after,transition.before,"reverse retains the displayed compositor alpha");
  assert.equal(transition.same,true,"reverse keeps both captured layers");
  assert.equal(transition.duration,200);
  assert.equal(transition.direction,-1);
  assert.equal(transition.requested,"light");
  assert.equal(transition.painted,"dark","the outgoing live picture stays available until the old image fully covers it");
  assert.deepEqual(transition.properties,["opacity"]);
  await page.waitForFunction(()=>!document.documentElement.hasAttribute("data-theme-fading"));
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),"light");

  await page.evaluate(()=>AtriumTheme.toggle());
  await page.waitForFunction(()=>themeMotionEffect());
  const third = await page.evaluate(()=>{
    const root=document.documentElement, effect=themeMotionEffect();
    const alpha=()=>Number(getComputedStyle(root,"::view-transition-old(root)").opacity);
    const start=performance.now();
    window.thirdThemePaints = [];
    const changes = new MutationObserver(() => {
      window.thirdThemePaints.push({preset:root.dataset.theme,alpha:alpha(),
        same:effect===themeMotionEffect(),elapsed:performance.now()-start});
      changes.disconnect();
    });
    changes.observe(root,{attributeFilter:["data-theme"]});
    effect.pause();
    effect.currentTime=100;
    const before=alpha();
    AtriumTheme.setPreset("hc");
    const earlier=root.dataset.theme;
    AtriumTheme.setPreset("classic");
    const overlay=document.getAnimations().find(a=>!a.animationName&&a.effect?.pseudoElement==="::view-transition-old(root)");
    const frames=overlay?.effect.getKeyframes() || [];
    return {before,after:alpha(),requested:AtriumTheme.get().preset,earlier,painted:root.dataset.theme,
      cover:frames.filter(frame=>frame.opacity==="1").length,reveal:frames.at(-1)?.opacity,
      duration:overlay?.effect.getTiming().duration,same:effect===themeMotionEffect()};
  });
  assert.equal(third.requested,"classic");
  assert.equal(third.earlier,"dark");
  assert.equal(third.painted,"dark","a third preset holds the current live layer while it remains visible");
  assert.equal(third.after,third.before,"third-preset retarget retains the current compositor opacity");
  assert.ok(third.same);
  assert.deepEqual([third.cover,third.reveal,third.duration],[2,"0",200],
    "one compositor animation covers, holds and reveals on a bounded timeline");
  await page.waitForFunction(()=>!document.documentElement.hasAttribute("data-theme-fading"));
  const paints=await page.evaluate(()=>window.thirdThemePaints);
  assert.deepEqual(paints.map(({preset,alpha,same})=>({preset,alpha,same})),[{preset:"classic",alpha:1,same:true}],
    "only the latest preset is painted and its first frame is fully covered");
  assert.ok(paints[0].elapsed>=60,"the old image reaches full opacity over a paced cover rather than jumping");

  async function startThird() {
    await page.evaluate(()=>{
      AtriumTheme.set({preset:"light",motion:"off"},{persist:false});
      AtriumTheme.set({motion:"full"},{persist:false});
      AtriumTheme.setPreset("dark");
    });
    await page.waitForFunction(()=>themeMotionEffect());
    await page.evaluate(()=>{
      themeMotionEffect().pause();
      themeMotionEffect().currentTime=100;
      AtriumTheme.setPreset("classic");
    });
  }
  await startThird();
  assert.equal(await page.evaluate(async()=>{
    AtriumTheme.set({motion:"off"},{persist:false});
    await Promise.resolve();
    const root=document.documentElement;
    return root.dataset.theme==="classic" && !themeMotionEffect() && !root.hasAttribute("data-theme-fading");
  }),true,"Off immediately lands the latest preset and removes the theme transition");
  await startThird();
  await page.keyboard.press("Shift");
  assert.equal(await page.evaluate(()=>{
    const root=document.documentElement;
    return root.dataset.theme==="classic" && !themeMotionEffect() && !root.hasAttribute("data-theme-fading");
  }),true,"keyboard interruption immediately lands the latest preset");
  assert.equal(await page.evaluate(()=>{
    AtriumTheme.setPreset("dark");
    return document.documentElement.dataset.theme==="dark" && !themeMotionEffect() &&
      !document.documentElement.hasAttribute("data-theme-fading");
  }),true,"keyboard intent applies the theme synchronously");
}

async function instantEditorActions(page) {
  await page.mouse.click(8,8);
  const effectCount = await page.evaluate(()=>{
    const host=AtriumNavHost;
    const result=[];
    for (const tool of ["route","select"]) {
      host.setTool(tool);
      result.push([...document.querySelectorAll("#status,.tool[aria-pressed=true]")].flatMap(n=>n.getAnimations({subtree:true})).length);
    }
    return result;
  });
  assert.deepEqual(effectCount,[0,0],"switching editor tools is instantaneous");
  const statusEffects = await page.evaluate(async()=>{
    const H=AtriumNavHost, status=document.getElementById("status");
    let effects=0;
    const watcher=new MutationObserver(()=> {effects+=status.getAnimations({subtree:true}).length;});
    watcher.observe(status,{childList:true,subtree:true,characterData:true});
    try {
      const saved=await H.saveAll({download:false});
      if (!saved || !H.folderProject()) throw Error("The editor did not create the temporary native project");
      H.edit(()=>H.doc().name += " motion fixture","Rename for Save regression");
      if (!await H.saveAll({download:false})) throw Error("The editor did not commit the project");
      return {effects,text:status.textContent};
    } finally {watcher.disconnect();}
  });
  assert.match(statusEffects.text,/Saved|No unsaved changes/);
  assert.equal(statusEffects.effects,0,"the actual Save status is never animated");
}

async function themePointerPolicy(page) {
  await page.mouse.click(8,8);
  const supported=await page.evaluate(()=>{
    const H=AtriumNavHost, theme=AtriumTheme;
    H.selectDocument(H.project().documents.find(d=>d.kind==="schematic").id);
    H.setTool("select");
    theme.set({preset:"dark",motion:"off",followSystem:false},{persist:false});
    theme.set({motion:"full"},{persist:false});
    theme.setPreset("light");
    return typeof document.startViewTransition==="function";
  });
  if (!supported) return;
  await page.waitForFunction(()=>themeMotionEffect());
  const where=await page.evaluate(()=>{
    const fade=themeMotionEffect();
    fade.pause();
    fade.currentTime=70;
    const canvas=AtriumNavHost.canvas(), r=canvas.getBoundingClientRect();
    const x=r.left+40,y=r.top+120;
    const hit=node=>{
      const box=node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2));
    };
    return {x,y,canvas:document.elementFromPoint(x,y)===canvas,
      menu:hit(document.querySelector(".work-menu[data-menu=file] > summary")),
      dock:hit(document.querySelector(".dock-tabs:not([hidden]) .dock-tab"))};
  });
  assert.ok(where.canvas && where.menu && where.dock,"the old theme snapshot allows hit testing across the workbench");
  await page.mouse.move(where.x,where.y);
  await page.mouse.down();
  await page.mouse.move(where.x+300,where.y+180,{steps:4});
  assert.deepEqual(await page.evaluate(()=>({
    drag:AtriumNavHost.drag()?.kind,fading:!!themeMotionEffect()
  })),{drag:"box",fading:true},"a real canvas marquee starts during the live theme fade");
  await page.mouse.up();
  await page.evaluate(()=>AtriumTheme.set({motion:"off"},{persist:false}));
}

async function ruleCloseKeepsMenu(page) {
  await page.emulateMedia({reducedMotion:"reduce"});
  const name = await page.evaluate(() => {
    AtriumPower.setMode("off");
    AtriumTheme.set({preset:"dark",motion:"off",followSystem:false},{persist:false});
    AtriumTheme.set({motion:"full"},{persist:false});
    const host = AtriumNavHost, board = host.project().documents.find(doc => doc.kind === "pcb");
    host.selectDocument(board.id);
    const name = board.name;
    host.edit(() => { board.name += " focus fixture"; }, "Rename for menu focus regression");
    return name;
  });
  const design = page.locator('.work-menu[data-menu="design"]');
  await design.locator("summary").click();
  await design.locator('[data-action="rules"]').click();
  const close = page.getByRole("dialog",{name:"Rules and Constraints Editor"}).getByRole("button",{name:"Close",exact:true});
  const opened = await close.evaluate(async button => {
    const dialog = button.closest("dialog");
    await Promise.all(dialog.getAnimations().map(animation => animation.finished.catch(() => {})));
    button.addEventListener("click", () => {
      const fade = dialog.getAnimations().find(animation => {
        const frames = animation.effect?.getKeyframes();
        return frames?.[0]?.opacity === "1" && frames.at(-1)?.opacity === "0";
      });
      fade?.pause();
      window.heldRulesExit = fade;
    },{once:true});
    return {open:dialog.open, opacity:getComputedStyle(dialog).opacity,
      fades:AtriumMotionUI.enabled("pointer"), travel:AtriumMotionUI.moves("pointer")};
  });
  assert.deepEqual(opened,{open:true,opacity:"1",fades:true,travel:false},
    "the Rules dialog is fully painted with reduced-motion fades enabled");
  await close.click();
  assert.deepEqual(await page.evaluate(async () => {
    const fade = window.heldRulesExit;
    await fade?.ready;
    return {state:fade?.playState,view:AtriumDocViews.isOpen("rules")};
  }),{state:"paused",view:true},"the old rules view still owns a delayed close callback");

  const edit = page.locator('.work-menu[data-menu="edit"]'), summary = edit.locator("summary");
  await summary.click();
  assert.equal(await summary.getAttribute("aria-expanded"),"true");
  await page.evaluate(() => window.heldRulesExit.finish());
  await page.waitForFunction(() => !AtriumDocViews.isOpen("rules"));
  assert.ok(await summary.evaluate(element => document.activeElement === element),
    "the rules view lets the newer Edit menu keep focus after its fade ends");
  const undo = edit.getByRole("menuitem",{name:"Undo",exact:true});
  assert.ok(await undo.evaluate(button => {
    const rect = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  }),"the menu row receives hits after the old view has closed");
  await undo.click();
  assert.equal(await page.evaluate(() => AtriumNavHost.doc().name),name,"the trusted menu click undoes the board edit");

  await design.locator("summary").click();
  await design.locator('[data-action="rules"]').click();
  await close.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !AtriumDocViews.isOpen("rules") && document.activeElement === AtriumNavHost.canvas());
}

module.exports = async function motionContract(browser) {
  const page = await editor(browser);
  const errors=[];
  page.on("pageerror",error=>errors.push(error.stack || error.message));
  try {
    await inputPolicy(page);
    await cameraPolicy(page);
    await themePolicy(page);
    await themePointerPolicy(page);
    await instantEditorActions(page);
    assert.deepEqual(errors,[]);
  } finally {await page.close();}
  const rulesPage = await editor(browser);
  rulesPage.on("pageerror",error=>errors.push(error.stack || error.message));
  try {
    await ruleCloseKeepsMenu(rulesPage);
    assert.deepEqual(errors,[]);
  } finally {await rulesPage.close();}
  console.log("PASS canvas retargeting, direct pinch and trackpad, zero post-settle frames, theme reversal, instant tools, Save status and Edit Undo after closing Rules");
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"},
    browser => module.exports(browser),
    error => {console.error(error);process.exitCode=1;});
}
