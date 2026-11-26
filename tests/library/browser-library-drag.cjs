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

    // A library-file component dragged over the canvas and cancelled leaves the project unchanged.
    const panel = page.locator(".panel-library");
    const fileDef = await page.evaluate(id => {
      const def = Atrium.clone(AtriumNavHost.defs().get(id)); def.id = "drag-file-part"; def.name = "Drag file part";
      AtriumLibrary.sourceStore.save([{id:"drag-file", name:"Drag file", path:"drag.atrlib", defs:[def]}]);
      AtriumLibrary.mountPanel().render();
      return def.id;
    }, id);
    await panel.getByLabel("Library source", {exact:true}).selectOption("drag-file");
    const fileRow = panel.locator('.lib-row[data-def="' + fileDef + '"]');
    await fileRow.waitFor();
    const library = () => page.evaluate(() => AtriumNavHost.project().library.length);
    const libraryBefore = await library();
    await page.mouse.move(...await centre(fileRow));
    await page.mouse.down();
    await page.mouse.move(...target, {steps:12});
    await page.waitForFunction(() => AtriumNavHost.placing());
    await page.mouse.move(...await centre(fileRow), {steps:12});
    await page.mouse.up();
    assert.equal(await library(), libraryBefore, "a cancelled drag does not leave the file component in the project");
    assert.equal(await parts(), before);

    // Dropping it on the board adds it to the project and places it.
    await page.mouse.move(...await centre(fileRow));
    await page.mouse.down();
    await page.mouse.move(...target, {steps:12});
    await page.waitForFunction(() => AtriumNavHost.placing());
    await page.mouse.up();
    assert.equal(await library(), libraryBefore + 1);
    assert.equal(await parts(), before + 1, "a library-file component places on release");

    // A stub entry loads while it is dragged: placement starts once it arrives, and a release before then
    // cancels for good instead of arming placement late.
    await page.evaluate(async () => {
      await AtriumLazy.need("AtriumLibrarySourcesUI");
      const real = globalThis.__realSources = AtriumLibrarySources;
      globalThis.AtriumLibrarySources = {...real, load(lib, id) {
        if (id !== "drag-stub-part") return real.load(lib, id);
        const def = AtriumLibrary.sourceStore.list().find(l => l.id === "drag-file").defs.find(d => d.id === id);
        const full = {...def}; delete full.stub;
        return new Promise(done => setTimeout(() => done(full), globalThis.__stubDelay));
      }};
      const lib = AtriumLibrary.sourceStore.list().find(l => l.id === "drag-file");
      lib.defs.push({...lib.defs[0], id:"drag-stub-part", name:"Drag stub part", stub:{kind:"test"}});
      AtriumLibrary.sourceStore.save([lib]);
      AtriumLibrary.mountPanel().render();
    });
    const stubRow = panel.locator('.lib-row[data-def="drag-stub-part"]');
    await stubRow.waitFor();
    const stubLibrary = await library(), stubParts = await parts();
    await page.evaluate(() => { globalThis.__stubDelay = 1200; });
    await page.mouse.move(...await centre(stubRow));
    await page.mouse.down();
    await page.mouse.move(...target, {steps:6});
    await page.mouse.up();
    await page.waitForTimeout(1600);
    assert.equal(await placing(), false, "a stub that loads after the release does not arm placement");
    assert.equal(await library(), stubLibrary);
    await page.evaluate(() => { globalThis.__stubDelay = 300; });
    await page.mouse.move(...await centre(stubRow));
    await page.mouse.down();
    await page.mouse.move(...target, {steps:6});
    await page.waitForFunction(() => AtriumNavHost.placing());
    await page.mouse.up();
    assert.equal(await parts(), stubParts + 1, "a stub placed once loaded lands on release");
    await page.evaluate(() => { globalThis.AtriumLibrarySources = globalThis.__realSources; });
    await panel.getByLabel("Library source", {exact:true}).selectOption({index:0});

    // On a schematic sheet the dragged symbol is placed on release too (the placement script may load cold).
    await page.evaluate(() => AtriumNavHost.selectDocument(AtriumNavHost.project().documents.find(d => d.kind === "schematic").id));
    await page.waitForFunction(() => AtriumNavHost.doc().kind === "schematic");
    const symbolId = await page.evaluate(() => AtriumNavHost.project().library.find(d => d.symbol).id);
    const symbolRow = panel.locator('.lib-row[data-def="' + symbolId + '"]');
    await symbolRow.waitFor();
    const sheetParts = await parts();
    const sheet = await page.locator("#canvas").boundingBox(), drop = [sheet.x + sheet.width / 2, sheet.y + sheet.height / 2];
    await page.mouse.move(...await centre(symbolRow));
    await page.mouse.down();
    await page.mouse.move(...drop, {steps:12});
    await page.mouse.up();
    await page.waitForFunction(n => AtriumNavHost.doc().items.filter(i => i.kind === "part").length === n + 1, sheetParts);
    await page.waitForFunction(() => !AtriumNavHost.placing());

    // Split view: crossing the inactive pane on the way leaves it alone; releasing over it activates it and
    // places the part there.
    await page.evaluate(() => AtriumNavHost.act("split-right"));
    await page.waitForSelector("#canvas-2");
    await page.waitForTimeout(400);
    const activeId = () => page.evaluate(() => AtriumNavHost.canvas().id);
    const first = await activeId(), other = first === "canvas" ? "#canvas-2" : "#canvas";
    const mid = async sel => centre(page.locator(sel));
    const otherPoint = await mid(other), activePoint = await mid("#" + first);
    const activeParts = await parts();
    await page.mouse.move(...await centre(symbolRow));
    await page.mouse.down();
    await page.mouse.move(...otherPoint, {steps:10});
    await page.mouse.move(...activePoint, {steps:10});
    await page.mouse.up();
    await page.waitForFunction(() => !AtriumNavHost.placing());
    assert.equal(await activeId(), first, "crossing the inactive pane does not activate it");
    assert.equal(await parts(), activeParts + 1, "the part lands in the pane it was released over");
    await page.evaluate(() => AtriumNavHost.act("undo"));
    await page.mouse.move(...await centre(symbolRow));
    await page.mouse.down();
    const counts = () => page.evaluate(() => Object.fromEntries(AtriumNavHost.project().documents.map(d => [d.id, (d.items || []).filter(i => i.kind === "part").length])));
    const countsBefore = await counts();
    await page.mouse.move(...activePoint, {steps:10});
    await page.mouse.move(...otherPoint, {steps:10});
    await page.mouse.up();
    await page.waitForFunction(() => !AtriumNavHost.placing());
    assert.equal(await activeId(), other.slice(1), "releasing over the inactive pane activates it");
    const countsAfter = await counts(), target2 = await page.evaluate(() => AtriumNavHost.doc().id);
    assert.equal(countsAfter[target2], countsBefore[target2] + 1, "the part is placed in the pane it was released over");
    await page.evaluate(() => AtriumNavHost.act("split-close"));
    assert.deepEqual(errors, []);
    console.log("PASS library drag places on release with live keys, cancels off the canvas, and double-click places");
  } finally { await page.close(); }
}

if (require.main === module)
  require("../support/standalone-chromium.cjs")({channel:"chrome"}, libraryDrag, error => { console.error(error); process.exitCode = 1; });
module.exports = libraryDrag;
