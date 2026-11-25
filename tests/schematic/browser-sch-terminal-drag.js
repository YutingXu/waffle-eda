"use strict";
const assert = require("node:assert/strict"), path = require("node:path");
const {pathToFileURL} = require("node:url");

module.exports = async function terminalDrag(browser) {
  const page = await browser.newPage({viewport: {width: 1280, height: 880}}), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    const choose = page.waitForEvent("filechooser");
    await page.locator('dialog.sp-dialog[open] [data-start-action="import"]').click();
    await (await choose).setFiles(path.join(__dirname, "../fixtures/altium/terminal-drag/Terminal drag.SchDoc"));
    await page.locator("button.document-tab", {hasText: "Terminal drag"}).first().click();
    await page.evaluate(async () => {
      await AtriumLazy.need(["AtriumUndoStore", "AtriumWireEdit"]);
      const h = AtriumNavHost, p = h.doc().items.find(i => i.ref === "R1");
      h.zoomTo([p.x - 16, p.y - 16, p.x + 20, p.y + 17], {margin: .02});
      globalThis.ATRIUM_UNDO_VERIFY = true;
    });
    await page.waitForFunction(() => {
      if (globalThis.AtriumMotion?.active()) return false;
      const h = AtriumNavHost, p = h.doc().items.find(i => i.ref === "R1");
      const box = h.canvas().getBoundingClientRect(), [x, y] = h.view().worldToScreen([p.x,p.y]);
      return h.view().scale() > 12 && document.elementFromPoint(x + box.left, y + box.top) === h.canvas();
    });
    const state = () => page.evaluate(() => {
      const h = AtriumNavHost, doc = h.doc(), defs = h.defs(), p = doc.items.find(i => i.ref === "R1");
      const graph = Atrium.connectivity(doc, defs), pins = Atrium.pins(p, defs.get(p.def), "schematic");
      return {part: [p.x, p.y, p.angle], nets: pins.map(pin => graph.byPin.get(p.id + "/" + pin.number) ?? null),
        dots: doc.items.filter(i => i.kind === "junction").map(i => [i.x, i.y]),
        wires: doc.items.filter(i => i.kind === "wire").map(i => i.points), content: JSON.stringify(doc.items)};
    });
    const body = () => page.evaluate(() => {
      const h = AtriumNavHost, p = h.doc().items.find(i => i.ref === "R1"), r = h.canvas().getBoundingClientRect();
      const point = [p.x, p.y + .95];
      const [x, y] = h.view().worldToScreen(point);
      return {hit: h.hitAt(point)?.ref, x: r.left + x, y: r.top + y, step: h.doc().grid * h.view().scale()};
    });
    async function drag(dx, dy, {cancel = false, returnWithin = false} = {}) {
      const {x, y, step, hit} = await body();
      assert.equal(hit, "R1", "the pointer presses the component body");
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx * step, y + dy * step, {steps: 8});
      const preview = await state();
      if (returnWithin) await page.mouse.move(x, y, {steps: 8});
      if (cancel) await page.keyboard.press("Escape");
      await page.mouse.up();
      return {preview, after: await state()};
    }
    const initial = await state(), nets = ["LEAF", "BRANCH"];
    assert.deepEqual(initial.nets, nets);
    const {preview, after} = await drag(1, 4);
    assert.notDeepEqual(after.part, initial.part);
    assert.deepEqual(preview.nets, nets, "the moving pin is connected during the live drag");
    assert.deepEqual(after.nets, nets, "the moved component retains both nets");
    assert.deepEqual(after.wires[1], initial.wires[1], "the stationary wire keeps both authored arms");
    assert.deepEqual(after.dots[1], initial.dots[1], "the stationary junction stays on the bend");
    assert.notDeepEqual(after.dots[0], initial.dots[0], "the one-arm dot follows the other pin");
    assert.equal(after.wires.length, 3);
    await page.evaluate(() => AtriumNavHost.act("undo"));
    assert.equal((await state()).content, initial.content);
    await page.evaluate(() => AtriumNavHost.act("redo"));
    assert.equal((await state()).content, after.content);
    assert.equal((await drag(-1, -4)).after.content, initial.content, "a later drag collapses the lead and restores all original objects");
    assert.equal((await drag(2, 4, {cancel: true})).after.content, initial.content, "Escape removes the live lead");
    assert.equal((await drag(2, 4, {returnWithin: true})).after.content, initial.content, "returning within the gesture removes the live lead");
    await page.evaluate(() => AtriumNavHost.act("undo"));
    assert.equal((await state()).content, after.content, "neither cancelled nor zero-displacement drags add an undo step");
    await page.evaluate(() => AtriumNavHost.act("redo"));
    const {x, y, step} = await body();
    await page.evaluate(() => AtriumNavHost.act("move-object"));
    await page.mouse.click(x,y);
    await page.keyboard.press("Space");
    await page.mouse.click(x - 3 * step, y + 5 * step);
    const rotated = await state();
    assert.notEqual(rotated.part[2], initial.part[2], "Space turns the picked component before placement");
    assert.deepEqual(rotated.nets, nets);
    assert.deepEqual(rotated.wires[1], initial.wires[1]);
    assert.deepEqual(rotated.dots[1], initial.dots[1]);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => AtriumUndoStore.stats().mismatch), 0);
    console.log("PASS imported schematic terminal drag through trusted pointer movement, undo, redo, cancellation and rotated placement");
  } finally { await page.close(); }
};
