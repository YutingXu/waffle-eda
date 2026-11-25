"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

module.exports = async function tooltips(browser) {
  const url = pathToFileURL(path.join(__dirname,"../../app/index.html")).href;
  const page = await browser.newPage({viewport:{width:1280,height:840}});
  const errors = [];
  page.on("pageerror", error=>errors.push(error.message));
  page.setDefaultTimeout(5000);
  try {
    await page.clock.install();
    await page.goto(url);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => AtriumNavHost.doc().items.length);
    const tip = page.locator("#waffle-tooltip");
    const share = page.locator("#collab-share");
    await share.hover();
    await page.clock.runFor(600);
    assert.equal(await tip.isVisible(),false,"Share already shows its label");
    assert.equal(await share.getAttribute("title"),null);
    assert.ok(await share.getAttribute("aria-label"));
    await page.evaluate(() => {
      const dialog = document.createElement("dialog");
      dialog.id = "tooltip-controls";
      dialog.innerHTML = '<button id="keyboard-hint" aria-label="Action" aria-describedby="always-description">↓</button>' +
        '<button id="disabled-hint" disabled title="This action is unavailable">Disabled action</button>' +
        '<button id="labelled-hint" title="Next">Next</button>' +
        '<button id="clipped-hint" title="Full action name"><span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:35px">Full action name</span></button>' +
        '<button id="leave-hint">Other action</button><span id="always-description" hidden>Saved description</span>' +
        '<svg width="24" height="24"><title>Artwork name</title><circle r="8" cx="12" cy="12"/></svg>';
      document.body.append(dialog);
      AtriumNavCommon.shortcutTitle(dialog.querySelector("#keyboard-hint"),"Explain the action","Mod+Shift+P");
      dialog.showModal();
      dialog.querySelector("#leave-hint").focus();
    });
    const first = page.locator("#keyboard-hint"), disabled = page.locator("#disabled-hint");
    await page.waitForFunction(() => !document.querySelector("#keyboard-hint").hasAttribute("title"));
    assert.equal(await page.locator("#tooltip-controls svg title").textContent(),"Artwork name");
    await first.hover();
    await page.clock.runFor(300);
    assert.equal(await tip.isVisible(),false,"cold hover waits for intent");
    await tip.waitFor({state:"visible"});
    assert.match(await tip.textContent(),/Explain the action/);
    assert.equal(await tip.locator("kbd.ui-shortcut").count(),1);
    assert.equal(await first.getAttribute("aria-describedby"),"always-description waffle-tooltip");
    await page.evaluate(() => {
      const control = document.querySelector("#keyboard-hint");
      AtriumNavCommon.shortcutTitle(control,"Updated action","Mod+P");
    });
    await tip.getByText("Updated action",{exact:false}).waitFor();
    await disabled.hover({force:true});
    await tip.waitFor({state:"hidden"});
    assert.equal(await disabled.getAttribute("aria-description"),"This action is unavailable");
    assert.equal(await first.getAttribute("aria-describedby"),"always-description");
    await page.locator("#clipped-hint").hover();
    await tip.getByText("Full action name",{exact:true}).waitFor();
    await page.locator("#labelled-hint").hover();
    await tip.waitFor({state:"hidden"});
    await page.locator("#leave-hint").hover();
    await tip.waitFor({state:"hidden"});
    await page.keyboard.press("Tab");
    await first.focus();
    await tip.waitFor({state:"visible"});
    assert.match(await tip.textContent(),/Updated action/);
    assert.equal(await tip.evaluate(n=>n.getAnimations().length),0,"focus-triggered hints have no motion");
    await page.keyboard.press("Escape");
    await tip.waitFor({state:"hidden"});
    assert.equal(await page.locator("#tooltip-controls").evaluate(n=>n.open),true,"Escape closes only the hint");
    await page.evaluate(() => document.getElementById("tooltip-controls").remove());
    await page.locator('.editor-tabbar [data-action="split-toggle"]').hover();
    await tip.getByText("Split editor right").first().waitFor();
    await page.mouse.move(3,3);
    await tip.waitFor({state:"hidden"});

    await page.emulateMedia({reducedMotion:"reduce"});
    const target = await page.evaluate(() => {
      const nav = AtriumNavHost;
      const d = nav.project().documents.find(row=>row.kind === "pcb");
      nav.selectDocument(d.id);
      nav.setTool("select");
      const example = d.items.find(i=>i.kind === "track" && i.net);
      const net = example.net, point = [200,200];
      const track = {id:"tooltip-short-track",kind:"track",points:[[199,200],[201,200]],layer:example.layer,net,width:.35};
      const neighbour = {...track,id:"tooltip-long-track",points:[[190,201],[210,201]]};
      nav.edit(()=>d.items.push(track,neighbour),"Add hover fixture",[track.id,neighbour.id],{documents:[d.id],items:[track.id,neighbour.id]});
      const view = nav.view(), canvas = nav.canvas().getBoundingClientRect();
      view.restoreCamera({...view.camera(),rotation:0,flipped:false,cx:point[0],cy:point[1],scale:20});
      const [x,y] = view.worldToScreen(point);
      const hit = nav.hit(nav.canvas(),x+canvas.left,y+canvas.top).item;
      if (hit?.id !== track.id) throw Error("Spatial fixture did not hit the short track");
      const original = nav.hit.bind(nav);
      window.tooltipHits = 0;
      nav.hit = (...args) => {window.tooltipHits++; return original(...args);};
      function bounds(row) {
        const [l,t,r,bottom] = AtriumCanvas.schematicArtwork.box(row,d,nav.defs());
        const [left,top] = view.worldToScreen([l,t]), [right,end] = view.worldToScreen([r,bottom]);
        return {left:left+canvas.left,top:top+canvas.top,right:right+canvas.left,bottom:end+canvas.top};
      }
      return {x:x+canvas.left,y:y+canvas.top,label:hit.net || hit.ref || hit.text || hit.kind,
        track:bounds(track),neighbour:bounds(neighbour)};
    });
    await page.mouse.move(target.x-7,target.y);
    await page.mouse.move(target.x,target.y);
    await page.clock.runFor(140);
    assert.equal(await tip.isVisible(),false,"a spatial card waits for a stationary pointer");
    assert.equal(await page.evaluate(()=>window.tooltipHits),0,"no spatial hit work before intent");
    await page.locator(".ui-tooltip.is-card:visible").waitFor();
    assert.ok((await tip.textContent()).includes(target.label));
    const rect = await tip.boundingBox();
    for (const bounds of [target.track,target.neighbour])
      assert.ok(rect.x + rect.width < bounds.left || rect.x > bounds.right ||
        rect.y + rect.height < bounds.top || rect.y > bounds.bottom,"the card stays outside the picked track and its neighbouring net");
    assert.equal(await page.evaluate(()=>window.tooltipHits),1,"only one spatial hit for settled intent");
    assert.ok(await tip.evaluate(n=>n.getAnimations().every(animation=>
      animation.effect.getKeyframes().every(frame=>!frame.transform || frame.transform === "none")
    )),"reduced motion permits a fade and removes translation");
    await page.mouse.move(3,3);
    await tip.waitFor({state:"hidden"});
    await page.emulateMedia({reducedMotion:"no-preference"});
    await page.evaluate(()=>document.documentElement.setAttribute("data-motion","off"));
    await page.mouse.move(target.x,target.y);
    await page.locator(".ui-tooltip.is-card:visible").waitFor();
    assert.equal(await tip.evaluate(n=>n.getAnimations().length),0,"motion Off removes the entry animation");
    // Beta: hover cards stayed put while the camera moved. Any camera change dismisses a canvas card, and it
    // returns only after the pointer moves and rests again: a pan (touch, right-drag, GPU and 2D all move the
    // view), then a wheel zoom at the resting pointer.
    const card = page.locator(".ui-tooltip.is-card");
    await page.evaluate(() => { const nav = AtriumNavHost; nav.view().pan(40,0); nav.redraw(); });
    await card.waitFor({state:"hidden",timeout:1000});
    await page.clock.runFor(600);
    assert.equal(await card.isVisible(),false,"a panned-away card does not come back while the pointer rests");
    await page.evaluate(() => { const nav = AtriumNavHost; nav.view().pan(-40,0); nav.redraw(); });
    await page.mouse.move(target.x+12,target.y); await page.mouse.move(target.x,target.y);
    await card.waitFor({state:"visible"});
    await page.mouse.wheel(0,-120);
    await card.waitFor({state:"hidden",timeout:1000});
    await page.clock.runFor(600);
    assert.equal(await card.isVisible(),false,"a zoomed-away card does not come back while the pointer rests");
    const camera = await page.evaluate(async () => {
      await AtriumLazy.need("AtriumCanvasInput");
      return AtriumNavHost.view().camera();
    });
    const setCamera = camera => page.evaluate(camera => {
      const nav = AtriumNavHost; nav.view().restoreCamera(camera); nav.redraw();
    },camera);
    await page.mouse.move(3,3);
    await page.mouse.move(target.x,target.y);
    await setCamera({...camera,rotation:Math.PI/6});
    await page.clock.runFor(400);
    assert.equal(await card.isVisible(),false,"rotation cancels a pending hover at the resting pointer");
    await setCamera(camera);
    await page.mouse.move(target.x+12,target.y); await page.mouse.move(target.x,target.y);
    await card.waitFor({state:"visible"});
    await setCamera({...camera,flipped:!camera.flipped});
    await card.waitFor({state:"hidden",timeout:1000});
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }

  const context = await browser.newContext({hasTouch:true,isMobile:true,viewport:{width:480,height:800}});
  try {
    const touchPage = await context.newPage();
    await touchPage.clock.install();
    await touchPage.goto(url);
    await touchPage.getByRole("button",{name:"Continue to editor",exact:true}).click();
    await touchPage.evaluate(() => {
      const b = document.createElement("button");
      b.style.position = "fixed"; b.style.top = "300px"; b.style.left = "70px"; b.style.zIndex = "500";
      b.id = "hold-hint"; b.textContent = ""; b.title = "Touch description"; b.style.minWidth = b.style.minHeight = "44px";
      b.onclick = () => b.dataset.tapped = "yes";
      document.body.append(b);
    });
    const touch = await context.newCDPSession(touchPage), button = touchPage.locator("#hold-hint");
    await button.tap({trial:true}); // The closing Welcome sheet releases the hit target before the real hold.
    const box = await button.boundingBox();
    const point = {x:box.x+box.width/2,y:box.y+box.height/2};
    const touchTip = touchPage.locator("#waffle-tooltip");
    await touch.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[point]});
    await touchTip.waitFor({state:"visible"});
    assert.equal(await touchTip.textContent(),"Touch description");
    assert.equal(await touchTip.evaluate(n=>n.getAnimations().length),0,"touch holding has no hover motion");
    await touch.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    assert.equal(await button.getAttribute("data-tapped"),null,"a held control does not activate");
    await touch.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[point]});
    await touch.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    assert.equal(await button.getAttribute("data-tapped"),"yes","an ordinary tap still activates");
    await button.evaluate(b => { b.textContent = "Labelled"; b.title = "Labelled"; delete b.dataset.tapped; });
    const updated = await button.boundingBox();
    const labelled = {x:updated.x+updated.width/2,y:updated.y+updated.height/2};
    await touch.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[labelled]});
    await touchPage.clock.runFor(600);
    assert.equal(await touchTip.isVisible(),false,"a labelled touch control has no tooltip");
    await touch.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    await touch.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[labelled]});
    await touch.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    assert.equal(await button.getAttribute("data-tapped"),"yes","a labelled control still receives its normal tap");
  } finally { await context.close(); }
  console.log("PASS tooltip cold/warm timing, dynamic labels, keycaps, native dialogs, disabled controls, keyboard, protected canvas placement, reduced motion and real touch");
};
