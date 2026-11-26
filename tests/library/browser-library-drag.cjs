"use strict";

// Library panel placement with a real mouse: dragging a row onto the canvas places the part where it is
// released (no second click), keys work mid-drag, releasing elsewhere cancels, and double-click places.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function libraryDrag(browser) {
  const page = await browser.newPage({viewport:{width:1280,height:880}}), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  try {
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => globalThis.AtriumNavHost?.doc()?.kind === "pcb");
    await page.evaluate(() => AtriumNavHost.act("library-panel"));
    const id = await page.evaluate(() => AtriumNavHost.project().library.find(d => d.footprint).id);
    const row = page.locator('.panel-library .lib-row[data-def="' + id + '"]');
    // The panel renders its rows lazily after opening; wait until the row stays put.
    await page.waitForFunction(id => { const r = document.querySelector('.panel-library .lib-row[data-def="' + id + '"]');
      if (!r) return false; r.scrollIntoView({block:"center"}); const b = r.getBoundingClientRect(), last = globalThis.__rowAt;
      globalThis.__rowAt = b.top; return last === b.top && b.height > 0; }, id, {polling:100});
    const parts = () => page.evaluate(() => AtriumNavHost.doc().items.filter(i => i.kind === "part").length);
    const placing = () => page.evaluate(() => AtriumNavHost.placing());
    const centre = async locator => { const b = await locator.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
    const canvas = await page.locator("#canvas").boundingBox(), target = [canvas.x + canvas.width / 2, canvas.y + canvas.height / 2];

    // Drag onto the canvas, rotate with Space while dragging, release: one rotated part, back to Select.
    const before = await parts();
    await page.mouse.move(...await centre(row));
    await page.mouse.down();
    await page.mouse.move(target[0] - 40, target[1], {steps:12});
    await page.waitForFunction(() => AtriumNavHost.placing());
    await page.keyboard.press("Space");
    await page.mouse.move(...target, {steps:4});
    await page.mouse.up();
    assert.equal(await parts(), before + 1, "releasing over the canvas places the part without another click");
    assert.equal(await placing(), false, "a dragged placement places one part and returns to Select");
    const placed = await page.evaluate(id => AtriumNavHost.doc().items.filter(i => i.kind === "part" && i.def === id).at(-1), id);
    assert.notEqual(((placed.angle % 360) + 360) % 360, 0, "Space during the drag rotates the part being placed");
    const at = await page.evaluate(() => { const c = AtriumNavHost.canvas().getBoundingClientRect(); return {left:c.left, top:c.top}; });
    const expected = await page.evaluate(([x, y]) => AtriumNavHost.view().screenToWorld([x, y]), [target[0] - at.left, target[1] - at.top]);
    const grid = await page.evaluate(() => AtriumNavHost.doc().grid || 1);
    assert.ok(Math.abs(placed.x - expected[0]) <= grid && Math.abs(placed.y - expected[1]) <= grid, "the part lands where it was released");
    await page.evaluate(() => AtriumNavHost.act("undo"));
    assert.equal(await parts(), before, "the dragged placement is one undo step");

    // Releasing away from the canvas cancels.
    await page.mouse.move(...await centre(row));
    await page.mouse.down();
    await page.mouse.move(...target, {steps:12});
    await page.waitForFunction(() => AtriumNavHost.placing());
    await page.mouse.move(...await centre(row), {steps:12});
    await page.mouse.up();
    assert.equal(await parts(), before, "releasing outside the canvas places nothing");
    assert.equal(await placing(), false, "releasing outside the canvas ends placement");

    // Double-click places (the part follows the pointer); it no longer opens the editor.
    await row.dblclick();
    assert.equal(await placing(), true, "double-click starts placing the component");
    assert.equal(await page.locator("dialog[open]").count(), 0, "double-click does not open an editor");
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
    console.log("PASS library drag places on release with live keys, cancels off the canvas, and double-click places");
  } finally { await page.close(); }
}

if (require.main === module)
  require("../support/standalone-chromium.cjs")({channel:"chrome"}, libraryDrag, error => { console.error(error); process.exitCode = 1; });
module.exports = libraryDrag;
