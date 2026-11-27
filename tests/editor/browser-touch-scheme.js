"use strict";
// The touch scheme (docs/design-system.md, Touch), one assertion group per row, on a deliberately
// dense board where a finger always lands on copper or a part. What a gesture does depends only on
// the gesture and on whether the touched object is already selected. Trusted CDP touches, in the
// Preview profile and with Labs on, in light and dark.

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const N = 40, PITCH = [2.3, 1.72];

async function setup(page) {
  await page.evaluate(async ([n]) => {
    await AtriumLazy.need(["AtriumCamera", "AtriumCanvasInput", "AtriumContextMenu"]);
    // The demo project keeps its part library; its board becomes the dense benchmark layout.
    const h = AtriumNavHost, p = structuredClone(h.project()), {d} = makeAtriumBenchmarkBoard(n);
    p.documents[p.documents.findIndex(doc => doc.kind === "pcb")] = {...p.documents.find(doc => doc.kind === "pcb"), items:d.items, outline:d.outline};
    const board = p.documents.find(doc => doc.kind === "pcb");
    await h.replaceProject(p, {force:true, dirty:false}); h.selectDocument(board.id); h.setTool("select"); h.select([]);
    AtriumCamera.setPref("camera.animate", false); AtriumCamera.setPref("camera.momentum", false);
    // The board's right edge sits inside the canvas: blank space to its right, dense copper everywhere else.
    const c = h.canvas(), v = h.view();
    AtriumCamera.takeCamera(v);
    v.restoreCamera({...v.camera(), scale:9, cx:n*2.3 - c.clientWidth/9*.3, cy:n*1.72/2, rotation:0}); h.redraw();
    // Warm the undo store so the gesture status line can name the step.
    await AtriumLazy.need("AtriumUndoStore");
  }, [N]);
  await finishLiveCheck(page);
}

// A completed online publication includes the optional open-track findings in this fixture.
async function finishLiveCheck(page) {
  await page.evaluate(() => AtriumLazy.need(["AtriumDRCView", "AtriumDRCMarkers", "AtriumInsightsUI"]));
  await page.waitForFunction(() => {
    const report = AtriumDRCView.check();
    return report && report.mode !== "partial" &&
      AtriumDRCView.violations(AtriumNavHost.currentId()).some(v => v.type === "netAntennae");
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// In-page: screen targets on the dense board.
function targets([n, stackOnly]) {
  const h = AtriumNavHost, c = h.canvas(), v = h.view(), r = c.getBoundingClientRect();
  const client = w => { const s = v.worldToScreen(w); return [r.left + s[0], r.top + s[1]]; };
  const inside = ([x, y]) => x > r.left + 80 && y > r.top + 80 && x < r.right - 80 && y < r.bottom - 80;
  const hitAt = at => h.hit(c, at[0], at[1])?.item || null;
  const all = at => h.hit(c, at[0], at[1], true) || [];
  let stack = null;
  const parts = [], pane = h.panes().find(p => p.canvas === c), board = h.doc();
  const badges = AtriumChecksCross.projected(h, board);
  // A finding glyph has its own action. Test copper selection where the real pickers leave it to copper.
  const clear = ([x, y]) => !AtriumDRCView.groupAt(pane, x, y) && !AtriumInsightsUI.markerAt(pane, x, y) &&
    !AtriumProblemMarks.badgeUnder(pane, badges, board.kind, x - r.left, y - r.top);
  // Points where the topmost object is a part (its pads and the copper around it win elsewhere).
  for (const item of stackOnly ? [] : board.items) {
    if (item.kind !== "part" || parts.length >= 12) continue;
    let part = null;
    const box = AtriumNavCommon.itemBox(h.doc(), h.defs(), item), a = client([box[0], box[1]]), b = client([box[2], box[3]]);
    for (let y = Math.ceil(Math.min(a[1], b[1])); y <= Math.max(a[1], b[1]) && !part; y += 2)
      for (let x = Math.ceil(Math.min(a[0], b[0])); x <= Math.max(a[0], b[0]) && !part; x += 2)
        if (inside([x, y]) && clear([x, y]) && hitAt([x, y])?.id === item.id) part = {id:item.id, at:[x, y]};
    if (part) parts.push(part);
  }
  // A point with at least two objects under it, for tap cycling.
  for (let y = Math.ceil(r.top) + 120; y < r.bottom - 120 && !stack; y += 3)
    for (let x = Math.ceil(r.left) + 120; x < r.right - 260 && !stack; x += 3) {
      const list = all([x, y]);
      if (list.length >= 2 && clear([x, y])) stack = {at:[x, y], ids:list.map(i => i.id)};
    }
  if (stackOnly) return stack;
  const edge = Math.round(client([n*2.3 + 1, n*1.72/2])[0]);
  const blank = [Math.round(Math.min(r.right - 60, edge + 70)), Math.round(r.top + r.height/2)];
  // Dense: most points inside the board's screen area hit something.
  let hits = 0, samples = 0;
  for (let y = r.top + 40; y < r.bottom - 40; y += 17) for (let x = r.left + 40; x < edge - 10; x += 17) { samples++; if (hitAt([x, y])) hits++; }
  return {parts, stack, blank, blankEmpty:!hitAt(blank), edge, density:hits/samples};
}

const state = page => page.evaluate(() => {
  const h = AtriumNavHost;
  return {camera:h.view().camera(), selection:h.selection(), drag:h.drag()?.kind || null, tool:h.tool(),
    count:h.doc().items.length, status:document.getElementById("status").textContent};
});
const item = (page, id) => page.evaluate(id => JSON.stringify(AtriumNavHost.doc().items.find(i => i.id === id)), id);
const menuOpen = page => page.evaluate(() => {
  const m = document.querySelector('.nav-menu[role=menu],.ctx-menu[role=menu]');
  if (!m) return null; const b = m.getBoundingClientRect(); return {x:b.left, y:b.top, w:b.width, h:b.height};
});
const closeMenu = page => page.evaluate(() => AtriumContextMenu.close(false));
const sameCamera = (a, b) => Math.abs(a.cx - b.cx) < 1e-9 && Math.abs(a.cy - b.cy) < 1e-9 && Math.abs(a.scale - b.scale) < 1e-9;

async function checkScheme(page, label) {
  await setup(page);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", {type, touchPoints:points.map(([id, x, y]) => ({id, x, y}))});
  const drag = async (from, steps = 8, d = [7, 4], id = 1) => {
    await touch("touchStart", [[id, ...from]]);
    for (let i = 1; i <= steps; i++) {
      await page.clock.runFor(16);
      await touch("touchMove", [[id, from[0] + i*d[0], from[1] + i*d[1]]]);
    }
    await touch("touchEnd", []);
  };
  const tap = async (...points) => {
    if (points.length === 1) return page.touchscreen.tap(...points[0]);
    await touch("touchStart", points.map((point, index) => [index + 1, ...point]));
    await page.clock.runFor(80);
    await touch("touchEnd", []);
  };
  const hold = async at => { await touch("touchStart", [[1, ...at]]); await page.clock.runFor(520); };
  const t = await page.evaluate(targets, [N]);
  // The part a mouse click selects there, so touch is compared with the editor's own pick.
  for (const p of t.parts) {
    await page.mouse.click(...p.at);
    const picked = (await state(page)).selection;
    if (picked.length === 1 && picked[0] === p.id) { t.part = p; break; }
  }
  await page.evaluate(() => AtriumNavHost.select([]));
  await page.mouse.move(5, 5);
  assert.ok(t.density > .6, `${label}: the fixture is dense (${(t.density*100).toFixed(0)}% of the board hits an object)`);
  assert.ok(t.part && t.stack && t.blankEmpty, `${label}: a part, a stack of objects and blank space are on screen`);

  // Advance gestures on the app clock so CDP scheduling cannot turn a drag into a hold.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500));

  // One-finger drag starting anywhere not selected pans, even on a part.
  let before = await state(page);
  const original = await item(page, t.part.id);
  await drag(t.part.at);
  let after = await state(page);
  assert.equal(await item(page, t.part.id), original, `${label}: a one-finger drag over an unselected part does not move it`);
  assert.ok(Math.abs((before.camera.cx - after.camera.cx)*after.camera.scale - 56) < 1.5, `${label}: a one-finger drag over a part pans`);
  assert.deepEqual(after.selection, [], `${label}: panning selects nothing`);
  await page.evaluate(cam => { AtriumNavHost.view().restoreCamera(cam); AtriumNavHost.redraw(); }, before.camera);

  // Tap selects what is under the finger; tap empty space clears the selection.
  await tap(t.part.at);
  assert.deepEqual((await state(page)).selection, [t.part.id], `${label}: a tap selects the part under the finger`);
  await tap(t.blank);
  assert.deepEqual((await state(page)).selection, [], `${label}: a tap on empty space clears the selection`);

  // One-finger drag starting on something already selected moves the selection.
  await tap(t.part.at);
  before = await state(page);
  await drag(t.part.at);
  after = await state(page);
  assert.notEqual(await item(page, t.part.id), original, `${label}: dragging the selected part moves it`);
  assert.ok(sameCamera(after.camera, before.camera), `${label}: moving the selection does not pan`);
  const moved = await item(page, t.part.id);

  // Two-finger tap undoes and three-finger tap redoes, each named on the status line.
  const [x, y] = t.blank;
  await tap([x - 30, y], [x + 30, y]);
  after = await state(page);
  assert.equal(await item(page, t.part.id), original, `${label}: a two-finger tap undoes the move`);
  assert.match(after.status, /^Undo: \S/, `${label}: the status line names the undone step (${after.status})`);
  assert.ok(sameCamera(after.camera, before.camera), `${label}: a two-finger tap does not zoom or pan`);
  await tap([x - 30, y], [x, y + 20], [x + 30, y]);
  after = await state(page);
  assert.equal(await item(page, t.part.id), moved, `${label}: a three-finger tap redoes the move`);
  assert.match(after.status, /^Redo: \S/, `${label}: the status line names the redone step (${after.status})`);
  await page.clock.resume();
  await page.evaluate(() => AtriumNavHost.act("undo"));

  // Tap a selected object again: cycle to the next object under the finger.
  await page.evaluate(() => AtriumNavHost.select([]));
  await finishLiveCheck(page);
  t.stack = await page.evaluate(targets, [N, true]);
  assert.ok(t.stack, `${label}: a marker-free copper stack is available after the history operations`);
  await tap(t.stack.at);
  const first = (await state(page)).selection;
  assert.deepEqual(first, [t.stack.ids[0]], `${label}: the first tap selects the topmost object`);
  await page.clock.runFor(350);
  await tap(t.stack.at);
  after = await state(page);
  assert.deepEqual(after.selection, [t.stack.ids[1]], `${label}: tapping the selected object selects the next one under the finger`);
  assert.match(after.status, new RegExp(`^Object 2 of ${t.stack.ids.length}`), `${label}: the status line counts the stack`);
  for (let i = 2; i < t.stack.ids.length; i++) { await page.clock.runFor(350); await tap(t.stack.at); }
  await page.clock.runFor(350); await tap(t.stack.at);
  assert.deepEqual((await state(page)).selection, [t.stack.ids[0]], `${label}: cycling wraps back to the topmost object`);

  // Long press then drag picks up an unselected part and moves it in one gesture, with a lift cue.
  await page.evaluate(() => AtriumNavHost.select([]));
  before = await state(page);
  await hold(t.part.at);
  const cue = await page.evaluate(() => {
    const n = document.querySelector(".touch-lift"); if (!n) return null;
    const css = getComputedStyle(n), b = n.getBoundingClientRect();
    return {kind:n.dataset.kind, border:css.borderTopColor, width:b.width, anim:n.getAnimations().map(a => a.effect.getKeyframes().some(k => k.transform && k.transform !== "none"))};
  });
  assert.equal(cue?.kind, "object", `${label}: the pick-up shows a lift cue around the object`);
  assert.ok(!/rgba\(0, 0, 0, 0\)|transparent/.test(cue.border) && cue.width > 4, `${label}: the cue is visible (${cue.border})`);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[1, t.part.at[0] + i*7, t.part.at[1] + i*4]]);
  assert.equal(await page.evaluate(() => !!document.querySelector(".touch-lift")), false, `${label}: the cue leaves once the object moves`);
  await touch("touchEnd", []);
  after = await state(page);
  assert.notEqual(await item(page, t.part.id), original, `${label}: long press then drag moves an unselected part`);
  assert.deepEqual(after.selection, [t.part.id], `${label}: the picked-up part is selected`);
  assert.ok(sameCamera(after.camera, before.camera), `${label}: a pick-up does not pan`);
  await page.evaluate(() => AtriumNavHost.act("undo"));
  assert.equal(await item(page, t.part.id), original, `${label}: one Undo restores the picked-up part`);

  // Long press on empty space then drag draws a selection box.
  await page.evaluate(() => AtriumNavHost.select([]));
  before = await state(page);
  await hold(t.blank);
  assert.equal(await page.evaluate(() => document.querySelector(".touch-lift")?.dataset.kind), "marquee", `${label}: the empty-space hold shows the marquee origin`);
  const into = [t.edge - 90, t.blank[1] - 60];
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[1, t.blank[0] + (into[0]-t.blank[0])*i/8, t.blank[1] + (into[1]-t.blank[1])*i/8]]);
  const during = await state(page);
  await touch("touchEnd", []);
  after = await state(page);
  assert.equal(during.drag, "box", `${label}: long press on empty space then drag draws a selection box`);
  assert.ok(after.selection.length > 0, `${label}: the box selects what it encloses`);
  assert.ok(sameCamera(after.camera, before.camera), `${label}: box selection does not pan`);

  // Long press and release without moving: the context menu at the finger.
  await page.evaluate(() => AtriumNavHost.select([]));
  await hold(t.part.at); await touch("touchEnd", []);
  await page.waitForFunction(() => !!document.querySelector('.nav-menu[role=menu],.ctx-menu[role=menu]'));
  const menu = await menuOpen(page);
  assert.ok(Math.abs(menu.x - t.part.at[0]) < 40 || Math.abs(menu.x + menu.w - t.part.at[0]) < 40, `${label}: the menu opens at the finger`);
  assert.deepEqual((await state(page)).selection, [t.part.id], `${label}: the held object is the menu's subject`);
  assert.equal(await item(page, t.part.id), original);
  await closeMenu(page);

  // Two fingers pinch-zoom and pan, never select or move.
  await page.evaluate(() => AtriumNavHost.select([]));
  before = await state(page);
  const [mx, my] = t.part.at;
  await touch("touchStart", [[1, mx - 40, my], [2, mx + 40, my]]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[1, mx - 40 - i*5, my], [2, mx + 40 + i*5, my]]);
  await touch("touchEnd", []);
  after = await state(page);
  assert.ok(Math.abs(after.camera.scale/before.camera.scale - 2) < .02, `${label}: spreading two fingers over a part zooms 2x`);
  assert.deepEqual(after.selection, [], `${label}: two fingers select nothing`);
  assert.equal(await item(page, t.part.id), original, `${label}: two fingers move nothing`);
  await page.evaluate(cam => { AtriumNavHost.view().restoreCamera(cam); AtriumNavHost.redraw(); }, before.camera);

  // An active tool: one finger places, two fingers still navigate.
  await page.evaluate(() => AtriumNavHost.setTool("via"));
  before = await state(page);
  await tap(t.part.at);
  after = await state(page);
  assert.equal(after.count, before.count + 1, `${label}: a tap with the Via tool places one via`);
  assert.equal(after.tool, "via");
  await touch("touchStart", [[1, mx - 40, my], [2, mx + 40, my]]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[1, mx - 40 - i*5, my], [2, mx + 40 + i*5, my]]);
  await touch("touchEnd", []);
  const pinched = await state(page);
  assert.ok(Math.abs(pinched.camera.scale/before.camera.scale - 2) < .02 && pinched.count === after.count && pinched.tool === "via",
    `${label}: two fingers zoom with the tool armed and place nothing`);
  await page.evaluate(cam => { const h = AtriumNavHost; h.view().restoreCamera(cam); h.redraw(); h.act("undo"); h.setTool("select"); }, before.camera);

  // A stylus is a mouse: a drag on an object moves it, a drag on empty space draws a box.
  const pen = async (type, at) => cdp.send("Input.dispatchMouseEvent", {type, x:at[0], y:at[1], button:"left",
    buttons:type === "mouseReleased" ? 0 : 1, clickCount:1, pointerType:"pen", force:.6});
  await page.evaluate(() => AtriumNavHost.select([]));
  before = await state(page);
  await pen("mousePressed", t.part.at);
  for (let i = 1; i <= 6; i++) await pen("mouseMoved", [t.part.at[0] + i*7, t.part.at[1] + i*4]);
  await pen("mouseReleased", [t.part.at[0] + 42, t.part.at[1] + 24]);
  after = await state(page);
  assert.notEqual(await item(page, t.part.id), original, `${label}: a pen drag moves an unselected part`);
  assert.ok(sameCamera(after.camera, before.camera), `${label}: a pen drag does not pan`);
  await page.evaluate(() => AtriumNavHost.act("undo"));
  await pen("mousePressed", t.blank);
  for (let i = 1; i <= 4; i++) await pen("mouseMoved", [t.blank[0] - i*10, t.blank[1] - i*6]);
  const penBox = await state(page);
  await pen("mouseReleased", [t.blank[0] - 40, t.blank[1] - 24]);
  assert.equal(penBox.drag, "box", `${label}: a pen drag on empty space draws a selection box`);

  // Hover-only UI never comes from touch: WebKit's mouse echo where a finger lifts shows no card.
  await page.evaluate(() => AtriumNavHost.select([]));
  await page.mouse.move(5, 5); await page.clock.runFor(800);
  await tap(t.part.at);
  await page.evaluate(([x, y]) => AtriumNavHost.canvas().dispatchEvent(new PointerEvent("pointermove",
    {bubbles:true, cancelable:true, pointerType:"mouse", pointerId:1, clientX:x, clientY:y, buttons:0})), t.part.at);
  await page.clock.runFor(450);
  assert.equal(await page.evaluate(() => !!document.querySelector(".is-card:not([hidden])")), false, `${label}: a touch shows no hover card`);
  // The same spot does show its card to a real mouse, so the check above is meaningful.
  await page.clock.runFor(400);
  await page.mouse.move(t.part.at[0] + 1, t.part.at[1]); await page.mouse.move(...t.part.at);
  await page.waitForFunction(() => !!document.querySelector(".is-card:not([hidden])"), null, {timeout:2500});
  await page.mouse.move(5, 5);

  // An actual DRC glyph over copper keeps its own touch action and opens the violation inspector.
  await page.evaluate(() => AtriumNavHost.select([]));
  await finishLiveCheck(page);
  const marker = await page.evaluate(() => {
    const h = AtriumNavHost, pane = h.panes().find(p => p.active), r = pane.canvas.getBoundingClientRect();
    for (const v of AtriumDRCView.violations(h.currentId())) {
      if (v.type !== "netAntennae" || !v.at) continue;
      const [x, y] = pane.view.worldToScreen(v.at);
      if (x < 80 || x > r.width - 80 || y < 80 || y > r.height - 80) continue;
      const at = [x + r.left, y + r.top], hit = AtriumDRCView.groupAt(pane, ...at);
      if (hit?.v === v && h.hit(pane.canvas, ...at)?.item) return {at, id: v.id, type: v.type};
    }
    return null;
  });
  assert.ok(marker, `${label}: a visible native open-track marker lands over copper`);
  await tap(marker.at);
  await page.waitForFunction(({id, type}) => {
    const v = globalThis.AtriumDRCInspector?.current?.();
    return v?.id === id && v.type === type;
  }, marker);
  assert.deepEqual((await state(page)).selection, [], `${label}: tapping the actual marker opens its action without selecting underlying copper`);
  await page.evaluate(() => AtriumDRCInspector.close({reason: "canvas"}));
  await cdp.detach();
}

// The owner outline of a part's text is hover-only: a touch never shows it, and a touch clears it.
async function checkOwnerOutline(page, label) {
  // Part text picking (sch-fields.js) is an idle prefetch, or loads on the first move over a sheet; the
  // synchronous sweep below cannot wait for it, so it is loaded first (under load the idle may not have come).
  await page.evaluate(() => AtriumLazy.need(["AtriumCamera", "AtriumCanvasInput", "AtriumSchFields"]).then(() => true));
  await page.evaluate(() => { const h = AtriumNavHost; h.selectDocument(h.project().documents.find(d => d.kind === "schematic").id);
    h.setTool("select"); h.select([]); h.act("fit"); });
  await page.waitForFunction(() => AtriumNavHost.doc().kind === "schematic" && !globalThis.AtriumMotion?.active());
  const spot = await page.evaluate(() => {
    const h = AtriumNavHost, c = h.canvas(), r = c.getBoundingClientRect();
    const send = (x, y) => c.dispatchEvent(new PointerEvent("pointermove", {bubbles:true, pointerType:"mouse", pointerId:1, clientX:x, clientY:y, buttons:0}));
    for (let y = r.top + 40; y < r.bottom - 40; y += 4) for (let x = r.left + 40; x < r.right - 40; x += 4) {
      send(x, y); if (h.fieldFocus()?.mode === "hover") { send(r.left + 2, r.top + 2); return [x, y]; }
    }
    return null;
  });
  assert.ok(spot, `${label}: a part text with an owner outline on mouse hover`);
  // Labs can queue the first touch while precision input loads. Observe its actual replay before the mouse echo.
  await page.evaluate(() => window.__waffleInputTrace = (event, taken) => {
    if (taken && event.type === "pointerup" && event.pointerType === "touch") window.__waffleInputTrace = null;
  });
  await page.touchscreen.tap(...spot);
  await page.waitForFunction(() => window.__waffleInputTrace === null);
  await page.evaluate(([x, y]) => AtriumNavHost.canvas().dispatchEvent(new PointerEvent("pointermove",
    {bubbles:true, pointerType:"mouse", pointerId:1, clientX:x, clientY:y, buttons:0})), spot);
  assert.notEqual(await page.evaluate(() => AtriumNavHost.fieldFocus()?.mode), "hover", `${label}: touch shows no owner outline`);
}

// Touch never leaves a sticky :hover on canvas chrome. WebKit keeps :hover where a finger lifted (the
// cursor stays there), so the test forces :hover after a tap, as WebKit would, and checks the fill.
async function checkStickyHover(page, label) {
  const selector = "#editor-area .split-button:not(.split-counterpart-button)";
  const tool = page.locator(selector).first();
  const box = await tool.boundingBox(), at = [box.x + box.width/2, box.y + box.height/2];
  const fill = () => tool.evaluate(n => getComputedStyle(n).backgroundColor);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const {root} = await cdp.send("DOM.getDocument", {depth:-1});
  const {nodeId} = await cdp.send("DOM.querySelector", {nodeId:root.nodeId, selector});
  const force = on => cdp.send("CSS.forcePseudoState", {nodeId, forcedPseudoClasses:on ? ["hover"] : []});
  await page.mouse.move(5, 5); await page.mouse.move(6, 6);
  const rest = await fill();
  await force(true);
  assert.notEqual(await fill(), rest, `${label}: a mouse hover fills the split button`);
  await force(false);
  // A tap on the button (it opens the side pane and stays put), then WebKit's lingering :hover.
  await page.touchscreen.tap(...at);
  await force(true);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.pointer), "touch", `${label}: a touch marks the window as touch-driven`);
  assert.equal(await fill(), rest, `${label}: a tap leaves no sticky hover fill`);
  // The mouse moving again restores ordinary hover.
  await page.mouse.move(20, 20); await page.mouse.move(24, 22);
  assert.notEqual(await fill(), rest, `${label}: the next mouse move restores hover fills`);
  await force(false);
  await cdp.detach();
}

async function openDemo(page) {
  await page.clock.install();
  await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
  await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
  await page.waitForFunction(() => !!globalThis.AtriumNavHost && AtriumNavHost.doc().kind === "pcb");
  await page.addScriptTag({path:path.join(__dirname, "../pcb/dense-board.js")});
}

module.exports = async function touchScheme(browser) {
  for (const labs of [false, true]) for (const theme of ["light", "dark"]) {
    const label = `${theme}${labs ? " with Labs" : ""}`;
    const page = await browser.newPage({viewport:{width:1280, height:860}, hasTouch:true}), errors = [];
    if (labs) await require("../fixtures/notebook-labs.cjs").profile(page);
    page.on("pageerror", error => errors.push(error.message));
    try {
      await openDemo(page);
      await page.evaluate(theme => AtriumTheme.set({preset:theme, followSystem:false}, {persist:false}), theme);
      await checkOwnerOutline(page, label);
      await checkScheme(page, label);
      await checkStickyHover(page, label);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
  // Reduced motion keeps the cue but drops its scale pulse.
  const page = await browser.newPage({viewport:{width:1280, height:860}, hasTouch:true, reducedMotion:"reduce"});
  try {
    await openDemo(page);
    await setup(page);
    const t = await page.evaluate(targets, [N]);
    t.part = t.parts[0];
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {type:"touchStart", touchPoints:[{id:1, x:t.part.at[0], y:t.part.at[1]}]});
    await page.clock.runFor(520);
    const cue = await page.evaluate(() => { const n = document.querySelector(".touch-lift");
      return n && n.getAnimations().flatMap(a => a.effect.getKeyframes()).some(k => k.transform && k.transform !== "none"); });
    await cdp.send("Input.dispatchTouchEvent", {type:"touchCancel", touchPoints:[]});
    assert.equal(cue, false, "reduced motion: the lift cue shows without a scale pulse");
    assert.equal(await page.locator(".touch-lift").count(),0,"cancelling a held touch removes the lift cue");
  } finally { await page.close(); }
  console.log("PASS touch scheme on a dense board: pan anywhere unselected, tap select and cycle, drag the selection, hold to pick up or box-select, hold for the menu, pinch, two/three-finger undo/redo, tools, stylus, no touch hover, light/dark, Preview/Labs, reduced motion");
};

if (require.main === module) {
  const {chromium} = require("../support/playwright.cjs");
  (async () => {
    const browser = await chromium.launch(process.env.CHROME ? {executablePath:process.env.CHROME} :
      {channel:"chrome", args:["--allow-file-access-from-files"]});
    try { await module.exports(browser); } finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
