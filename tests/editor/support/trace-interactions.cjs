"use strict";

// Browser-protocol inputs for scripts/perf-interactions.cjs. Setup and state
// checks stay outside the marked windows. All coordinates are CSS pixels.
const assert = require("node:assert/strict");
const {setTimeout:wait} = require("node:timers/promises");
const {watchResult} = require("../../../scripts/ci/interaction_trace.cjs");

async function prepareProject(page) {
  return page.evaluate(async () => {
    const h = AtriumNavHost;
    await AtriumLazy.need("AtriumSchObjects");
    const {project, stats} = makeAtriumSchBenchProject({sheets:12, cells:36});
    project.documents = project.documents.filter(d => d.kind === "schematic");
    const notebook = Atrium.sheet("schematic", "Engineering notebook");
    notebook.id = "trace-notebook";
    const D = await AtriumLazy.need("AtriumDrawing");
    const drawing = D.create(project, {name:"Signal flow drawing", preset:"empty"}), sheet = drawing.drawing.sheets[0].id;
    for (let i = 0; i < 120; i++) {
      const x = 15 + i % 10 * 38, y = 18 + Math.floor(i / 10) * 21;
      drawing.drawing.texts.push({id:"text-" + i, sheet, x, y, text:"Signal " + (i + 1), height:2.5});
      drawing.drawing.lines.push({id:"line-" + i, sheet, points:[[x,y+3],[x+16,y+3]]});
    }
    drawing.drawing = D.normalize(drawing.drawing);
    project.documents.push(notebook, drawing);
    await h.replaceProject(project, {force:true});
    h.selectDocument(project.documents[0].id);
    globalThis.AtriumStartPage?.close();
    await AtriumLazy.need("AtriumMessages");
    await AtriumLazy.need("AtriumPerformanceDiagnostics", {measure:false});
    const documents = h.project().documents.map(d => d.kind);
    if (documents.some(kind => kind !== "schematic" && kind !== "drawing")) throw Error("Unexpected document in interaction fixture");
    return {hierarchySheets:stats.sheets, schematicObjects:stats.items, largestSheet:stats.maxSheetItems,
      drawingLabels:drawing.drawing.texts.length, drawingLines:drawing.drawing.lines.length, documents};
  });
}

async function canvasInputs(page, cdp, measure, kind) {
  await page.evaluate(kind => {
    const h = AtriumNavHost;
    const docs = h.project().documents.filter(d => d.kind === kind);
    h.selectDocument(docs.reduce((a,b) => a.items.length > b.items.length ? a : b).id);
    h.setTool("select"); h.select([]); h.canvas().focus(); h.act("fit");
  }, kind);
  await wait(650);
  const camera = () => page.evaluate(() => AtriumNavHost.view().camera());
  const test = (name, action) => measure(kind + "-" + name, action);
  const setup = await page.evaluate(() => {
    const canvas = AtriumNavHost.canvas(), r = canvas.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    if (document.elementFromPoint(x, y) !== canvas) throw Error("The editor canvas is covered");
    return {x, y};
  });
  const {x, y} = setup;
  const fit = await camera();
  async function gesture(name, transform, action, magnification = 1) {
    await page.evaluate(({fit, magnification}) => {
      const h = AtriumNavHost, view = h.view(), r = h.canvas().getBoundingClientRect();
      view.restoreCamera(fit);
      if (magnification !== 1) view.zoom(magnification, [r.width / 2, r.height / 2]);
      h.redraw(true);
    }, {fit, magnification});
    await wait(260);
    const before = await camera();
    await test(name, action);
    const after = await camera();
    if (transform === "zoom") assert.ok(after.scale > before.scale, kind + " " + name + " changed magnification");
    else {
      assert.equal(after.scale, before.scale);
      assert.ok(Math.hypot(after.cx - before.cx, after.cy - before.cy) * after.scale > 1, kind + " " + name + " moved the camera");
    }
    assert.ok(await page.evaluate(() => {
      const h = AtriumNavHost, v = h.view();
      const view = v.worldViewport(), d = h.doc();
      if (d.kind === "schematic") return v.query(d, h.defs(), view).length > 0;
      const [ox, oy] = AtriumDrawing.sheetOrigins(d.drawing)[0];
      return d.drawing.texts.some(t => t.x+ox >= view[0] && t.x+ox <= view[2] && t.y+oy >= view[1] && t.y+oy <= view[3]);
    }), kind + " " + name + " kept design objects in view");
  }
  await page.mouse.move(x, y);
  await test("hover", () => page.mouse.move(x + 55, y + 10, {steps:30}));
  await gesture("drag-pan", "pan", async () => {
    await page.mouse.down({button:"middle"});
    await page.mouse.move(x - 45, y - 20, {steps:24});
    await page.mouse.up({button:"middle"});
  });
  async function wheel(dx, dy) {
    for (let i = 0; i < 24; i++) {
      await page.mouse.wheel(dx, dy);
      await wait(8);
    }
  }
  await gesture("wheel-pan", "pan", () => wheel(4, 2));
  await gesture("detail-wheel-pan", "pan", () => wheel(4, 2), 4);
  await page.keyboard.down("Control");
  try {
    await gesture("wheel-zoom", "zoom", () => wheel(1, -4));
    await gesture("detail-wheel-zoom", "zoom", () => wheel(1, -4), 4);
  }
  finally { await page.keyboard.up("Control"); }
  await gesture("notch-zoom", "zoom", async () => {
    for (let i = 0; i < 7; i++) { await page.mouse.wheel(0, i % 2 ? 100 : -100); await wait(42); }
  });
  await gesture("keyboard-pan", "pan", async () => {
    for (let i = 0; i < 8; i++) await page.keyboard.press(i < 3 ? "ArrowLeft" : "ArrowRight", {delay:18});
  });
  await gesture("touch-pan", "pan", async () => {
    await cdp.send("Input.dispatchTouchEvent", {type:"touchStart", touchPoints:[{x, y}]});
    for (let i = 1; i <= 16; i++) await cdp.send("Input.dispatchTouchEvent", {type:"touchMove", touchPoints:[{x:x+i*3, y:y+i}]});
    await cdp.send("Input.dispatchTouchEvent", {type:"touchEnd", touchPoints:[]});
  });
  await gesture("touch-pinch", "zoom", async () => {
    const touch = (type, span) => cdp.send("Input.dispatchTouchEvent", {type, touchPoints:span ?
      [{id:1, x:x-span, y}, {id:2, x:x+span, y}] : []});
    await touch("touchStart", 40);
    for (let i = 1; i <= 16; i++) await touch("touchMove", 40 + i);
    await touch("touchEnd", 0);
  });
  // Pick an unobstructed object using the same hit test as the editor.
  await page.evaluate(fit => {
    const h = AtriumNavHost, r = h.canvas().getBoundingClientRect();
    h.view().restoreCamera(fit);
    h.view().zoom(4, [r.width / 2, r.height / 2]); h.redraw(true);
  }, fit);
  const target = await page.evaluate(kind => {
    const h = AtriumNavHost, canvas = h.canvas(), r = canvas.getBoundingClientRect();
    const doc = h.doc(), drawing = kind === "drawing", origin = drawing && AtriumDrawing.sheetOrigins(doc.drawing)[0];
    const items = drawing ? doc.drawing.texts : doc.items.filter(item => item.kind === "part");
    for (const item of items) {
      const box = drawing ? null : AtriumNavCommon.itemBox(doc, h.defs(), item);
      const point = drawing ? [item.x+origin[0],item.y+origin[1]] : [(box[0]+box[2])/2, (box[1]+box[3])/2];
      const [sx, sy] = h.view().worldToScreen(point);
      const x = Math.round(r.left + sx), y = Math.round(r.top + sy);
      if (sx < 50 || sy < 50 || sx > r.width - 50 || sy > r.height - 50 || document.elementFromPoint(x,y) !== canvas) continue;
      const hit = drawing ? AtriumDrawing.inputAt(h.view().screenToWorld([x-r.left,y-r.top]), h.view().scale()) : h.hit(canvas, x, y);
      if (hit?.item?.id === item.id) return {x, y, id:item.id};
    }
    throw Error("No visible " + kind + " object to select");
  }, kind);
  await test("select", () => page.mouse.click(target.x, target.y));
  const selected = () => page.evaluate(id => (AtriumNavHost.doc().kind === "drawing" ? AtriumDrawing.selection() : AtriumNavHost.selection()).includes(id), target.id);
  assert.ok(await selected(), "click selected the hit object");
  await page.evaluate(() => AtriumNavHost.doc().kind === "drawing" ? AtriumDrawing.selectIds(AtriumNavHost.doc(), []) : AtriumNavHost.select([]));
  await test("pen-tap", async () => {
    const press = (type, buttons) => cdp.send("Input.dispatchMouseEvent", {type, x:target.x, y:target.y,
      button:"left", buttons, pointerType:"pen", force:buttons ? .6 : 0, clickCount:1});
    await press("mousePressed", 1); await press("mouseReleased", 0);
  });
  assert.ok(await selected(), "pen selected the hit object");
  const position = () => page.evaluate(id => {
    const doc = AtriumNavHost.doc(), item = (doc.drawing?.texts || doc.items).find(i => i.id === id);
    return [item.x, item.y];
  }, target.id);
  const before = await position();
  await test("object-drag", async () => {
    await page.mouse.down();
    await page.mouse.move(target.x + 32, target.y + 18, {steps:24});
    await page.mouse.up();
  });
  assert.notDeepEqual(await position(), before, "drag committed the edit");
  await test("undo-key", () => page.keyboard.press("ControlOrMeta+z"));
  assert.deepEqual(await position(), before, "keyboard Undo restored the object");
  if (kind === "schematic") {
    await page.evaluate(id => AtriumNavHost.select([id]), target.id);
    const designator = page.locator("#inspector").getByRole("textbox", {name:"Designator", exact:true});
    const original = await designator.inputValue();
    await designator.click(); await page.keyboard.press("ControlOrMeta+a");
    await test("properties-type", () => page.keyboard.type("U98765", {delay:24}));
    await test("properties-commit", () => page.keyboard.press("Tab"));
    const ref = () => page.evaluate(id => AtriumNavHost.doc().items.find(i => i.id === id).ref, target.id);
    assert.equal(await ref(), "U98765");
    await page.locator("#canvas").focus();
    await test("properties-undo", () => page.keyboard.press("ControlOrMeta+z"));
    assert.equal(await ref(), original);
  }
}

async function messageInputs(page, cdp, measure) {
  await page.evaluate(() => {
    const h = AtriumNavHost, doc = h.project().documents.find(d => d.kind === "schematic"), parts = doc.items.filter(i => i.kind === "part");
    h.selectDocument(doc.id);
    const messages = Array.from({length:5000}, (_, i) => {
      const p = parts[i % parts.length];
      return {class:i % 7 ? "Warning" : "Info", source:"Compiler", document:doc.name, objectId:p.id, point:[p.x,p.y],
        text:(i % 3 ? "Unconnected input at " : "Short between signals at ") + p.ref};
    });
    AtriumMessages.show(h.messageContext(), {title:"Compile schematic", group:"Compiler", detail:true, messages});
  });
  await page.locator('.dock-tab[data-dock-tab="messages"]').waitFor();
  await page.evaluate(() => AtriumDock.moveTo("messages", {area:"bottom", mode:"end"}));
  const grid = page.locator(".msg-grid"), search = page.getByRole("searchbox", {name:"Filter messages"});
  const summary = page.locator(".msg-foot [role=status]");
  assert.match(await summary.textContent(), /^5000 messages/);
  const stop = await watchResult(page, {input:'.msg-panel input[type=search]', output:".msg-foot [role=status]", name:"message-count"});
  await measure("messages-filter-focus", () => search.click());
  for (let i = 0; i < 5; i++) {
    await measure("messages-filter-type", () => page.keyboard.type("short", {delay:24}),
      () => summary.filter({hasText:/1667 shown$/}).waitFor());
    assert.equal(await search.inputValue(), "short");
    assert.match(await summary.textContent(), /1667 shown$/);
    await measure("messages-filter-delete", async () => {
      for (let k = 0; k < 5; k++) await page.keyboard.press("Backspace", {delay:24});
    }, () => summary.filter({hasNotText:/shown/}).waitFor());
    assert.equal(await search.inputValue(), "");
    assert.doesNotMatch(await summary.textContent(), /shown/);
  }
  await stop();
  await measure("messages-ime", async () => {
    for (const text of ["s", "sh", "short"]) {
      await cdp.send("Input.imeSetComposition", {text, selectionStart:text.length, selectionEnd:text.length});
    }
    await cdp.send("Input.insertText", {text:"short"});
  });
  assert.equal(await search.inputValue(), "short");
  assert.match(await summary.textContent(), /1667 shown$/);
  await measure("messages-filter-clear", () => page.keyboard.press("Escape"));
  assert.equal(await search.inputValue(), "");
  assert.doesNotMatch(await summary.textContent(), /shown/);
  await grid.focus();
  await measure("messages-row-keys", async () => {
    for (let i = 0; i < 20; i++) await page.keyboard.press(i % 5 === 4 ? "PageDown" : "ArrowDown");
  });
  assert.ok(Number(await grid.locator('tr[aria-selected="true"]').getAttribute("data-no")) > 1);
  const box = await grid.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await grid.evaluate(el => el.scrollTop);
  await measure("messages-wheel-scroll", async () => {
    for (let i = 0; i < 24; i++) { await page.mouse.wheel(0, 81); await wait(8); }
  });
  assert.ok(await grid.evaluate(el => el.scrollTop) > before, "wheel scrolled the rows");
  const header = grid.locator("th.msg-col-text");
  for (let i = 0; i < 6; i++) {
    await measure("messages-sort", () => header.getByRole("button").click());
    assert.equal(await header.getAttribute("aria-sort"), i % 2 ? "descending" : "ascending");
  }
}

async function navigatorInputs(page, measure) {
  await page.evaluate(() => AtriumMessages.close());
  const menu = page.locator('.menubar [data-menu="window"]');
  await menu.locator(":scope > summary").click();
  await menu.locator("#sub-window-panels > .submenu-trigger").click();
  const field = page.getByRole("searchbox", {name:"Search the Navigator"});
  await measure("navigator-open", () => menu.locator('[data-action="navigator-panel"]').click(), () => field.waitFor());
  await field.click();
  const stop = await watchResult(page, {input:".navp-search input", output:".navp-search .ui-search-count", name:"match-count", requireChange:true});
  const count = page.locator(".navp-search .ui-search-count");
  for (let i = 0; i < 6; i++) {
    await measure("navigator-filter-result", () => page.keyboard.type("~"), () => count.filter({hasText:/^0 of [1-9]/}).waitFor());
    await measure("navigator-filter-result", () => page.keyboard.press("Backspace"), () => count.filter({hasText:/^[1-9]\d*$/}).waitFor());
  }
  for (let i = 0; i < 5; i++) {
    await measure("navigator-find-component", () => page.keyboard.type("R12", {delay:20}),
      () => count.filter({hasText:/^[1-9]\d* of /}).waitFor());
    assert.ok(await page.evaluate(() => AtriumNavigatorPanel.rows().some(row => row.type === "part" && row.label === "R12")));
    await page.keyboard.press("ControlOrMeta+a");
    await measure("navigator-find-component", () => page.keyboard.press("Backspace"), () => count.filter({hasText:/^[1-9]\d*$/}).waitFor());
  }
  await stop();
}

module.exports = {prepareProject, canvasInputs, messageInputs, navigatorInputs};
