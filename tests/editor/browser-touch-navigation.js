"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function setup() {
  await AtriumLazy.need(["AtriumCamera", "AtriumCanvasInput", "AtriumMotion", "AtriumSchPlace", "AtriumTouchPrecision"]);
  const h = AtriumNavHost, project = Atrium.project("Gesture editing"), sheet = project.documents[0];
  const wire = (id, ...points) => ({id, kind:"wire", points});
  const label = (id, x, y) => ({id, kind:"netlabel", text:id, x, y});
  sheet.grid = 1;
  sheet.items = [
    wire("head", [-8,0], [8,0]), label("OLD_HEAD", -8, 0), wire("head-tap", [0,0], [0,-2]),
    wire("head-target", [-8,4], [8,4]), label("NEW_HEAD", 8, 4),
    wire("tail", [-8,9], [8,9]), label("OLD_TAIL", 8, 9), wire("tail-tap", [0,9], [0,7]),
    wire("tail-target", [-8,13], [8,13]), label("NEW_TAIL", -8, 13)
  ];
  await h.replaceProject(project, {force:true, dirty:false});
  h.selectDocument(sheet.id);
  h.openSplit("right", project.documents.find(d => d.kind === "pcb").id, {focus:false});
  h.canvas().focus();
  AtriumCamera.setPref("mouse.wheel", "zoom");
  for (const {view} of h.panes()) AtriumCamera.takeCamera(view);
  h.view().restoreCamera({...h.view().camera(), cx:0, cy:6, scale:12});
  h.redraw();
}

async function checkDomNavigation() {
  const h = AtriumNavHost, sheet = h.panes()[0], board = h.panes()[1], original = JSON.stringify(h.project().documents);
  const count = h.doc().items.length;
  const errors = [], check = (ok, message) => { if (!ok) errors.push(message); };
  const same = (a, b) => a.every((x, n) => Math.abs(x - b[n]) < .001);
  const clientPoint = (p, at) => { const r = p.canvas.getBoundingClientRect(); return {clientX:r.left+at[0], clientY:r.top+at[1]}; };
  const motion = (p, type, id, at) => p.canvas.dispatchEvent(new PointerEvent(type, {
    bubbles:true, cancelable:true, pointerType:"touch", pointerId:id, ...clientPoint(p, at)
  }));
  const wheel = (p, at, settings) => p.canvas.dispatchEvent(new WheelEvent("wheel", {
    bubbles:true, cancelable:true, ...clientPoint(p, at), ...settings
  }));
  function gesture(p, type, scale, at) {
    const event = Object.assign(new Event(type, {bubbles:true, cancelable:true}), {scale, ...clientPoint(p, at)});
    p.canvas.dispatchEvent(event);
  }
  function editingOnSheet(tool) {
    sheet.canvas.focus();
    h.setTool(tool);
  }
  function track(p, at) {
    const {view} = p, world = view.screenToWorld(at), scale = view.scale();
    return (factor, target) => Math.abs(view.scale() / scale - factor) < .0001 && same(view.worldToScreen(world), target);
  }
  editingOnSheet("pan");
  const centre = [85,85], pan = track(board, centre), sheetCamera = sheet.view.camera();
  motion(board, "pointerdown", 57, centre); motion(board, "pointermove", 57, [96,92]);
  check(pan(1, [96,92]), "one finger pans the pane under the finger");
  motion(board, "pointerdown", 58, [136,92]); const pinch = track(board, [116,92]);
  gesture(board, "gesturestart", 1, [116,92]);
  motion(board, "pointermove", 58, [156,92]); gesture(board, "gesturechange", 1.5, [126,92]);
  wheel(board, [126,92], {ctrlKey:true, deltaY:-4});
  check(pinch(1.5, [126,92]), "pinch follows its moving midpoint exactly once");
  motion(board, "pointerup", 58, [156,92]); gesture(board, "gestureend", 1.5, [126,92]);
  const resume = track(board, [96,92]);
  motion(board, "pointermove", 57, [101,88]); motion(board, "pointercancel", 57, [0,0]);
  check(resume(1, [101,88]), "remaining finger pans without a jump on release or cancel");
  check(h.canvas() === sheet.canvas && h.tool() === "pan" && document.activeElement === sheet.canvas, "direct touch in other pane preserves Pan, document and focus");
  check(JSON.stringify(sheet.view.camera()) === JSON.stringify(sheetCamera), "other pane gestures preserve editing camera");

  editingOnSheet("label");
  const web = track(board, [91,97]);
  gesture(board, "gesturestart", 1, [91,97]); gesture(board, "gesturechange", 1.25, [94,90]);
  wheel(board, [94,90], {ctrlKey:true, deltaY:-8}); gesture(board, "gestureend", 1.25, [94,90]);
  check(web(1.25, [94,90]), "trackpad pinch follows its moving midpoint exactly once");
  check(h.canvas() === sheet.canvas && h.tool() === "label" && document.activeElement === sheet.canvas, "trackpad pinch in other pane preserves armed Net Label and focus");

  editingOnSheet("label");
  motion(sheet, "pointerdown", 59, centre); motion(sheet, "pointerup", 59, centre);
  for (const type of ["click", "dblclick", "contextmenu"]) sheet.canvas.dispatchEvent(new MouseEvent(type, {bubbles:true, cancelable:true, ...clientPoint(sheet, centre)}));
  check(h.tool() === "label", "compatibility click and long-press leave Net Label armed");
  check(!document.querySelector("dialog[open]") && h.doc().items.length===count+1 && h.doc().items.at(-1).kind==="netlabel", "one deliberate tap places exactly one armed label");
  h.act("undo");
  check(original===JSON.stringify(h.project().documents),"undo restores the untouched split documents");

  editingOnSheet("route");
  motion(board, "pointerdown", 60, centre);
  // Capture loss can be followed by an untracked move over the other pane. Wheel must resume immediately.
  motion(sheet, "lostpointercapture", 60, [0,0]); const released = track(board, centre);
  motion(sheet, "pointermove", 60, [45,35]); wheel(board, centre, {deltaX:5, deltaY:3});
  check(released(1,[80,82]), "capture loss ends touch and allows ordinary two-axis scrolling");
  // WheelEvent coordinates are whole pixels while the pane may start at a fractional one: aim at a whole client pixel.
  const r = board.canvas.getBoundingClientRect(), whole = [Math.round(r.left+centre[0])+1e-6-r.left, Math.round(r.top+centre[1])+1e-6-r.top];
  const target = board.view.scale() * Math.exp(.128);
  const anchor = board.view.screenToWorld(whole);
  wheel(board, whole, {deltaMode:1, deltaY:-1});
  // Full Motion interpolates the notch, while Reduced Motion and Efficiency land it immediately.
  const reached = () => Math.abs(board.view.scale() / target - 1) < 1e-9;
  let anchored = same(board.view.worldToScreen(anchor), whole);
  const deadline = performance.now() + 500;
  while (!reached() && performance.now() < deadline) {
    await new Promise(requestAnimationFrame);
    anchored &&= same(board.view.worldToScreen(anchor), whole);
  }
  check(anchored && reached(), "detented wheel keeps its pointer anchor through the exact zoom endpoint");
  const control = track(board, whole);
  wheel(board, whole, {ctrlKey:true, deltaY:-2.5});
  check(control(Math.exp(.020), whole), "Ctrl+pixel wheel zooms around the pointer");
  check(h.canvas() === sheet.canvas && h.tool() === "route", "scrolling and zooming preserve the armed Wire tool");
  return errors;
}

async function checkTrustedWheel(page) {
  const before = await page.evaluate(() => {
    const h = AtriumNavHost, {canvas,view} = h.panes()[1], r = canvas.getBoundingClientRect();
    const client = [Math.round(r.left + 110), Math.round(r.top + 125)];
    const at = [client[0] - r.left, client[1] - r.top];
    return {client, at, world:view.screenToWorld(at), scale:view.scale(), active:h.canvas().id, tool:h.tool()};
  });
  await page.mouse.move(...before.client);
  await page.mouse.wheel(0,-120);
  const target = before.scale * Math.exp(.96);
  await page.waitForFunction(target => Math.abs(AtriumNavHost.panes()[1].view.scale() / target - 1) < 1e-9,
    target, {timeout:1000});
  const after = await page.evaluate(world => {
    const h = AtriumNavHost;
    return {at:h.panes()[1].view.worldToScreen(world), active:h.canvas().id, tool:h.tool()};
  },before.world);
  assert.ok(Math.hypot(after.at[0] - before.at[0], after.at[1] - before.at[1]) < .001,
    "the trusted wheel keeps the same world point under the pointer");
  assert.equal(after.active,before.active,"a wheel zoom leaves the editing pane active");
  assert.equal(after.tool,before.tool,"a wheel zoom leaves the Wire tool armed");
}

module.exports = async function touchNavigation(browser) {
  const page = await browser.newPage({viewport:{width:1480,height:950}, hasTouch:true}), errors = [];
  await require("../fixtures/notebook-labs.cjs").profile(page);
  page.on("pageerror", err => errors.push(err.message));
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => !!globalThis.AtriumNavHost && AtriumNavHost.doc().kind === "pcb");
    await page.evaluate(setup);
    const dom = await page.evaluate(checkDomNavigation);
    assert.deepEqual(dom, []);
    await checkTrustedWheel(page);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", {type, touchPoints:points.map(([id,x,y]) => ({id,x,y}))});
    const focus = id => page.evaluate(id => { const h = AtriumNavHost; h.panes()[0].canvas.focus(); h.setTool(id); }, id);
    const coords = (world, pane = 0) => page.evaluate(([world,n]) => {
      const p = AtriumNavHost.panes()[n], r = p.canvas.getBoundingClientRect(), [x,y] = p.view.worldToScreen(world);
      return [r.left+x,r.top+y];
    }, [world,pane]);
    const data = () => page.evaluate(() => {
      const h = AtriumNavHost, d = h.project().documents[0];
      return {items:d.items, tool:h.tool(), active:h.canvas().id, camera:h.panes()[1].view.camera(), drag:h.drag()?.kind || null};
    });
    await focus("route");
    const origin = [-8,0], destination = [-8,4];
    await page.mouse.click(...await coords(origin));
    const start = await data(), other = await page.locator("#canvas-2").boundingBox(), x = other.x + 90, y = other.y + 105;
    const midpoint = await page.evaluate(() => AtriumNavHost.panes()[1].view.screenToWorld([110,105]));
    await touch("touchStart", [[1,x,y]]); await touch("touchMove", [[1,x+12,y+5]]);
    await touch("touchStart", [[1,x+12,y+5],[2,x+52,y+5]]);
    await touch("touchMove", [[1,x+12,y+5],[2,x+72,y+5]]);
    // Blink ends the listed finger, leaving the first down. The empty cancel releases the rest.
    await touch("touchEnd", [[2,x+72,y+5]]);
    await touch("touchMove", [[1,x+19,y+9]]); await touch("touchCancel", []);
    const end = await data();
    assert.equal(end.active, start.active, "browser touch in the second pane keeps an unfinished wire in the first");
    assert.equal(end.tool, "route"); assert.deepEqual(end.items, start.items);
    assert.ok(Math.abs(end.camera.scale / start.camera.scale - 1.5) < .001, "trusted touch pinches once");
    const screen = await page.evaluate(midpoint => AtriumNavHost.panes()[1].view.worldToScreen(midpoint), midpoint);
    assert.ok(Math.hypot(screen[0]-139, screen[1]-114) < 1, "the remaining browser contact pans from the pinch midpoint without resetting it");
    await page.mouse.click(...await coords(destination));
    const committed = await data();
    assert.deepEqual(committed.items.at(-1).points, [origin, destination], "the original wire anchor survives split navigation");
    await page.evaluate(() => AtriumNavHost.act("undo"));

    for (const [id,tip,target,far] of [["head",[-8,0],[-5,4],[8,0]], ["tail",[8,9],[5,13],[-8,9]]]) {
      await focus("select");
      await page.evaluate(id => AtriumNavHost.select([id]), id);
      const original = (await data()).items;
      const press = await coords(tip), drop = await coords(target);
      await page.mouse.move(...press); await page.mouse.down(); await page.mouse.move(...drop); await page.mouse.up();
      const result = await page.evaluate(id => {
        const h = AtriumNavHost, items = h.doc().items, nets = Atrium.connectivity(h.doc(),h.defs()).byWire;
        return {points:items.find(i=>i.id===id).points, selection:h.selection(), wire:nets.get(id), tap:nets.get(id+"-tap"),
          labels:items.filter(i=>i.kind==="netlabel")};
      }, id);
      assert.deepEqual(result.selection, [id]);
      assert.deepEqual([result.points[0],result.points.at(-1)], id==="head"?[target,far]:[far,target]);
      assert.equal(result.wire, "NEW_"+id.toUpperCase()); assert.equal(result.tap, result.wire);
      assert.deepEqual(result.labels, original.filter(i=>i.kind==="netlabel"), "coincident net label stays at its anchor");
      await page.evaluate(() => AtriumNavHost.act("undo")); assert.deepEqual((await data()).items, original);
      await page.evaluate(() => AtriumNavHost.act("redo")); assert.deepEqual((await data()).items.find(i=>i.id===id).points, result.points);
      await page.evaluate(() => AtriumNavHost.act("undo"));
      await page.evaluate(id => AtriumNavHost.select([id]),id);
      await page.mouse.move(...press); await page.mouse.down(); await page.mouse.move(...drop);
      await page.evaluate(() => {
        const c = AtriumNavHost.canvas();
        c.releasePointerCapture(1); // Playwright's real mouse is pointer 1.
      });
      await page.mouse.move(drop[0]+2,drop[1]);
      const lost = await data();
      await page.mouse.up();
      assert.equal(lost.drag, null, "losing capture cancels the wire-end preview");
      assert.deepEqual(lost.items, original);
    }
    assert.deepEqual(errors, []);
    console.log("PASS touch and trackpad navigation, split focus, wire-end anchors and capture loss");
  } finally { await page.close(); }
  await require("./browser-input-foundation.js")(browser);
};
