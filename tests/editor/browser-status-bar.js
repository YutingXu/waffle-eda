"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

// The bundled demo is clean under ERC. Supply two overlapping pin findings on the
// same component and a board finding on its footprint so both renderers use real markers.
function publishReviewMarkers(on) {
  const h = AtriumNavHost, [sheet, board] = ["schematic", "pcb"].map(kind => h.project().documents.find(doc => doc.kind === kind));
  const symbol = sheet.items.find(item => item.kind === "part" && item.ref === "U1");
  const footprint = board.items.find(item => item.kind === "part" && item.ref === symbol.ref);
  const bounds = AtriumNavCommon.itemBox(sheet, h.defs(), symbol);
  const pin = [bounds[2] + .7, bounds[3] + 1.4];
  const findings = ["Error", "Warning"].map((severity, index) => ({
    class:severity, check:"unconnected", text:"Pin " + (index + 1) + " needs review",
    documentId:sheet.id, objectId:symbol.id, point:[pin[0],pin[1] + index * .06],
  }));
  const violation = {type:"clearance", warning:true, title:"Footprint pad", id:footprint.id, at:[footprint.x,footprint.y]};
  const slot = "browser-marker-fixture";
  AtriumChecks.publish(sheet.id, slot, on ? findings : [], row => AtriumChecks.fromERC(row));
  AtriumChecks.publish(board.id, slot, on ? [violation] : [], row => AtriumChecks.fromDRC(row, board));
  h.invalidate();
  return {pin, sheet:sheet.id, board:board.id};
}

async function markerInk(page, doc, point) {
  return page.evaluate(async ({doc,point}) => {
    const h = AtriumNavHost;
    if (h.currentId() !== doc) await h.selectDocument(doc);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = h.canvas(), ctx = canvas.getContext("2d"), view = h.view();
    const at = point || AtriumChecksCross.projected(h,h.doc()).find(badge => badge.label === "U1")?.at;
    if (!at) return null;
    const badge = !point && AtriumProblemMarks.badgeAt(at,view.scale(),h.doc().kind);
    const center = badge ? [badge.x,badge.y] : at;
    const [x,y] = view.worldToScreen(center).map(value => Math.round(value * devicePixelRatio));
    const half = Math.ceil(13 * devicePixelRatio);
    return {center, samples:Array.from(ctx.getImageData(x-half,y-half,2*half,2*half).data)};
  },{doc,point});
}

async function checkRenderedMarkers(page) {
  await page.evaluate(() => AtriumNavHost.act("drc-clear"));
  const fixture = await page.evaluate(publishReviewMarkers,false);
  const clean = await markerInk(page,fixture.sheet,fixture.pin);
  await page.evaluate(publishReviewMarkers,true);
  const marked = await markerInk(page,fixture.sheet,fixture.pin);
  const projected = await markerInk(page,fixture.board);
  assert.ok(projected, "findings from the schematic project onto the matching footprint");
  await page.evaluate(publishReviewMarkers,false);
  const cleared = await markerInk(page,fixture.board,projected.center);
  assert.notDeepEqual(marked.samples,clean.samples,"overlapping ERC findings paint onto the sheet");
  assert.notDeepEqual(projected.samples,cleared.samples,"the stacked schematic badge paints in the board's overlay");
}

async function snapGrid(page) {
  const state = () => page.evaluate(() => AtriumNavHost.doc().grid);
  const open = async (kind, custom = false) => {
    await page.evaluate(custom => AtriumNavHost.executeKey(custom ? "grid-custom" : "grid-picker"), custom);
    const dialog = page.getByRole("dialog", {name:kind + " snap grid",exact:true});
    await dialog.waitFor();
    return dialog;
  };
  const apply = async dialog => {
    await dialog.getByRole("button", {name:"Apply"}).click();
    await dialog.waitFor({state:"hidden"});
  };
  const choose = async value => {
    const dialog = await open("PCB");
    await dialog.getByLabel("Grid spacing", {exact:true}).selectOption(String(value));
    await apply(dialog);
    assert.equal(await state(),value);
  };
  const customBoardGrid = async text => {
    const dialog = await open("PCB",true);
    await dialog.getByLabel("Custom grid spacing (mil)").fill(text);
    await apply(dialog);
  };
  const reject = async (dialog, text) => {
    await dialog.getByLabel(/Custom grid spacing/).fill(text);
    await dialog.getByRole("button", {name:"Apply"}).click();
    await page.waitForFunction(() => {
      const current = document.querySelector("dialog.keys-grid[open]");
      return current?.querySelector('input[aria-invalid="true"]') || current?.querySelector(".keys-grid-note").textContent;
    });
    await dialog.getByRole("button", {name:"Cancel"}).click();
  };
  const legacy = value => page.evaluate(value => {
    const host = AtriumNavHost;
    host.edit(() => {host.doc().grid = value;},"Load old spacing");
  },value);
  const original = await page.evaluate(async () => {
    const host = AtriumNavHost, [sheet,board] = host.project().documents;
    await host.selectDocument(board.id);
    if (host.units() !== "mm") host.act("toggle-units");
    return {geometry:JSON.stringify(board.items),sheet:sheet.grid};
  });

  await choose(.01);
  await choose(.025);
  await page.evaluate(() => AtriumNavHost.act("undo"));
  assert.equal(await state(),.01);
  await choose(2.5);
  const view = page.locator('.menubar [data-menu="view"]');
  await view.locator(":scope > summary").click();
  await view.getByRole("menuitem", {name:"Grids",exact:true}).press("ArrowRight");
  await view.getByRole("menuitem", {name:"Next Snap Grid",exact:true}).click();
  assert.equal(await state(),.01);

  await page.evaluate(() => AtriumNavCommon.openPalette("search"));
  const palette = page.locator("dialog#palette");
  await palette.getByRole("combobox").fill("Snap Grid 0.025mm");
  await palette.getByRole("listbox").getByText("Preferences: Snap Grid: 0.025 mm",{exact:true}).click();
  await palette.waitFor({state:"hidden"});
  assert.equal(await state(),.025);

  for (const value of [.00025,.0100000000005]) {
    await legacy(value);
    const dialog = await open("PCB");
    assert.equal(await dialog.getByLabel("Grid spacing", {exact:true}).inputValue(),String(value));
    await apply(dialog);
    assert.equal(await state(),value);
  }
  await page.evaluate(() => AtriumNavHost.act("toggle-units"));
  await apply(await open("PCB",true));
  assert.equal(await state(),.0100000000005,"Applying the displayed conversion keeps the stored spacing.");
  await customBoardGrid("2.5");
  assert.equal(await state(),.0635);
  await customBoardGrid("1 µm");
  assert.equal(await state(),.001);
  await reject(await open("PCB",true),"0.5 µm");
  assert.equal(await state(),.001);

  await page.evaluate(() => {
    AtriumNavHost.act("toggle-units");
    AtriumNavHost.select([]);
  });
  const settings = page.locator("#inspector summary").filter({hasText:/^Document settings$/});
  if (!await settings.evaluate(node => node.parentElement.open)) await settings.click();
  const spacing = page.locator("#inspector").getByLabel("Grid (mm)", {exact:true});
  await spacing.fill("0.01mm");
  await spacing.press("Enter");
  await page.waitForFunction(() => AtriumNavHost.doc().grid === .01);

  const after = await page.evaluate(async () => {
    const host = AtriumNavHost, [sheet,board] = host.project().documents;
    await host.selectDocument(sheet.id);
    return {geometry:JSON.stringify(board.items),sheet:sheet.grid};
  });
  assert.deepEqual(after,original);
  await reject(await open("Schematic",true),"0.01mm");
  assert.equal(await state(),original.sheet);
}

module.exports = async function statusBar(browser) {
  const page = await browser.newPage({viewport:{width:1280,height:840}}), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(7000);
  try {
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => AtriumNavHost.doc().items.length);
    await page.evaluate(async () => {
      await AtriumLazy.need(["AtriumDRCView", "AtriumRevisionsUI", "AtriumMessages", "AtriumVariants"]);
      AtriumDRCView.setEnabled(false);
      AtriumChecks.clear();
    });
    const bar = page.locator("footer.statusbar"), problems = bar.locator("#status-problems");
    for (const [kind, theme] of [["pcb","light"], ["schematic","dark"]]) {
      await page.evaluate(async ([kind, theme]) => {
        AtriumTheme.set({preset:theme,followSystem:false,motion:"off"},{persist:false});
        const host = AtriumNavHost, doc = host.documentRefs().find(doc => doc.kind === kind);
        await host.selectDocument(doc.id);
      }, [kind, theme]);
      await page.mouse.move(10,300);
      const report = await bar.evaluate(node => {
        const active = [...node.querySelectorAll(".status-action")].filter(n => n.getClientRects().length);
        return {height:node.getBoundingClientRect().height, width:node.clientWidth, scroll:node.scrollWidth,
          styles:active.map(n => {
            const s = getComputedStyle(n);
            return [s.fontSize,s.borderTopWidth,s.backgroundColor,n.getAnimations().length];
          }),
          status:node.querySelector("#status").getAttribute("aria-live"),
          hasOldMenu:!!node.querySelector(".status-theme,.panels-menu")};
      });
      assert.equal(report.height, 24);
      assert.equal(report.width, report.scroll, "the row fits the editor width");
      assert.ok(report.styles.length >= 6, "the core controls are present alongside project status");
      assert.ok(report.styles.every(s => s.join() === ["11px","0px","rgba(0, 0, 0, 0)",0].join()));
      assert.equal(report.status, "polite");
      assert.equal(report.hasOldMenu, false);

      assert.equal(await bar.locator("#unit-toggle").isVisible(), false, "no separate units control");
      assert.equal(await bar.locator(".variant-switch").isVisible(), false);
      assert.equal(await bar.locator(".revision-chip").isVisible(), false);
      const canvas = await page.locator("#canvas").boundingBox(), coords = bar.locator("#coords");
      if (kind === "pcb") {
        await page.evaluate(() => {
          const host = AtriumNavHost;
          host.centerOn(globalThis.AtriumBoardShape?.fromUser(host.doc(), [20.7,10.2]) ?? [20.7,10.2]);
        });
        assert.equal(await coords.textContent(), "X 20.70 mm Y 10.20 mm");
        assert.equal(await bar.locator("#grid-value").textContent(), "Grid 0.25 mm");
        assert.match(await page.locator("#inspector").textContent(), /36 × 22 mm/);
      }
      const position = () => coords.evaluate(node => ({
        text:node.textContent, numeric:getComputedStyle(node).fontVariantNumeric,
        axes:[...node.children].map(axis => {
          const label=axis.firstElementChild.getBoundingClientRect(), value=axis.lastElementChild.getBoundingClientRect(), rect=axis.getBoundingClientRect();
          return {left:rect.left,right:rect.right,start:value.left,width:value.width,gap:value.left-label.right,
            alignment:getComputedStyle(axis.lastElementChild).textAlign};
        })
      }));
      await page.mouse.move(canvas.x + 80, canvas.y + 100);
      const first = await position();
      await page.mouse.move(canvas.x + canvas.width - 80, canvas.y + canvas.height - 100);
      const second = await position();
      assert.notEqual(second.text, first.text);
      assert.deepEqual(second.axes, first.axes, "both coordinate values stay anchored as the pointer moves");
      assert.equal(second.numeric, "tabular-nums");
      assert.deepEqual(second.axes.map(axis => [axis.gap,axis.width,axis.alignment]), [[4,64,"start"],[4,64,"start"]]);
      assert.equal(second.axes[1].left-second.axes[0].right,12);

      const grid = bar.locator("#status-grid-menu > summary"), menu = bar.getByRole("menu",{name:"Grid",exact:true});
      const visibleGrid = menu.getByRole("menuitemcheckbox",{name:"Show Grid",exact:true});
      const gridState = () => bar.locator('#status-grid-menu [data-action="grid"]').getAttribute("aria-checked");
      const pressed = await gridState();
      await grid.hover();
      assert.notEqual(await grid.evaluate(n => getComputedStyle(n).backgroundColor), "rgba(0, 0, 0, 0)");
      await grid.click();
      assert.equal(await grid.getAttribute("aria-expanded"), "true");
      assert.ok((await menu.boundingBox()).y + (await menu.boundingBox()).height <= (await grid.boundingBox()).y);
      await visibleGrid.click();
      assert.notEqual(await gridState(), pressed);
      await grid.press("ArrowDown");
      assert.equal(await visibleGrid.evaluate(n => document.activeElement === n), true);
      await visibleGrid.press("Space");
      assert.equal(await gridState(), pressed);
      assert.equal(await grid.evaluate(n => document.activeElement === n), true);

      const units = menu.getByRole("menuitem",{name:"Switch to mil",exact:true});
      await grid.press("End");
      await units.press("Enter");
      assert.match(await bar.locator("#grid-value").textContent(), /^Grid [\d.]+ mil$/);
      await page.locator("#canvas").press("q");
      assert.match(await bar.locator("#grid-value").textContent(), /^Grid [\d.]+ mm$/);
      await grid.press("Enter");
      await page.keyboard.press("Escape");
      assert.equal(await grid.getAttribute("aria-expanded"),"false");
      assert.equal(await grid.evaluate(n => document.activeElement === n),true);

      const snap = bar.locator(".status-snap:visible");
      const dot = () => snap.evaluate(n => getComputedStyle(n,"::before").backgroundColor);
      if (kind === "pcb") {
        const oldSnap = await snap.getAttribute("aria-pressed"), oldDot = await dot();
        await snap.click();
        const objects = page.locator(".pcb-edit-snap-pop").getByRole("checkbox",{name:"Snap to objects",exact:true});
        await objects.press("Space");
        assert.notEqual(await snap.getAttribute("aria-pressed"), oldSnap);
        assert.notEqual(await dot(), oldDot);
        await objects.press("Space");
        assert.equal(await snap.getAttribute("aria-pressed"), oldSnap);
        await objects.press("Escape");
      } else {
        assert.equal(await snap.getAttribute("data-snap"), "on");
        await snap.press("Enter");
        const dialog = page.getByRole("dialog", {name:"Schematic snap grid",exact:true});
        await dialog.waitFor();
        await page.keyboard.press("Escape");
        await dialog.waitFor({state:"hidden"});
      }
      const zoom = bar.locator("#zoom-value"), initial = await zoom.textContent();
      const zoomIn = bar.getByRole("button",{name:"Zoom in",exact:true}), zoomOut = bar.getByRole("button",{name:"Zoom out",exact:true});
      for (const control of [zoomIn,zoomOut]) {
        const {width,height,x,y} = await control.boundingBox();
        assert.deepEqual([width,height],[24,24]);
        assert.ok(Number.isInteger(x) && Number.isInteger(y), "zoom targets sit on whole pixels");
        assert.equal(await control.locator("svg").getAttribute("aria-hidden"), "true");
      }
      await zoomIn.click();
      await page.waitForFunction(old => document.getElementById("zoom-value").textContent !== old, initial);
      await zoomOut.press("Enter");
      await page.waitForFunction(old => document.getElementById("zoom-value").textContent === old, initial);
      await bar.getByRole("button",{name:"Fit design",exact:true}).press("Enter");
      const variant = bar.getByRole("combobox",{name:"Active assembly variant",exact:true}), revision = bar.getByRole("button",{name:/Open Board Revisions/});
      const variantId = await page.evaluate(() => {
        const h = AtriumNavHost;
        let id;
        h.edit(() => {
          id = AtriumVariants.create(h.project(), {name:"Bench"}).id;
          AtriumRevisions.start(h.project(), {letter:"A"});
        });
        return id;
      });
      await variant.waitFor();
      assert.ok((await variant.boundingBox()).width <= 112);
      assert.equal(await variant.locator("option:checked").textContent(), "Base design");
      await variant.selectOption(variantId);
      assert.equal(await variant.locator("option:checked").textContent(), "Bench");
      await revision.waitFor();
      assert.equal(await revision.textContent(), "Rev A · Draft");
      await page.evaluate(() => {
        const h = AtriumNavHost;
        h.edit(() => {
          AtriumVariants.remove(h.project(),h.project().activeVariant);
          delete h.project().revision;
        });
      });
      await variant.waitFor({state:"hidden"});
      await revision.waitFor({state:"hidden"});
    }

    const narrowVariant = await page.evaluate(() => {
      const host = AtriumNavHost;
      let id;
      host.edit(() => {
        id = AtriumVariants.create(host.project(), {name:"Bench production variant"}).id;
        AtriumRevisions.start(host.project(), {letter:"A"});
      });
      return id;
    });
    const variantControl = bar.getByRole("combobox",{name:"Active assembly variant",exact:true});
    const revisionControl = bar.getByRole("button",{name:/Open Board Revisions/});
    await variantControl.waitFor();
    await revisionControl.waitFor();
    await page.evaluate(() => AtriumNavHost.markUnsaved());
    const unsaved = bar.locator("#unsaved");
    for (const width of [1000,800,621,620,390,320]) {
      await page.setViewportSize({width,height:840});
      assert.ok(await unsaved.isVisible(),"the unsaved indicator stays visible at " + width + "px");
      assert.deepEqual(await bar.evaluate(node => ({
        row:node.clientHeight, overflow:node.scrollWidth - node.clientWidth,
      })),{row:24,overflow:0},"the status bar keeps all primary controls within one row at " + width + "px");
    }
    const compactZoom = bar.getByRole("button",{name:"Zoom in",exact:true});
    const previousZoom = await bar.locator("#zoom-value").textContent();
    await compactZoom.click();
    await page.waitForFunction(value => document.getElementById("zoom-value").textContent !== value, previousZoom);
    const more = bar.getByRole("button",{name:"More status controls",exact:true});
    await variantControl.waitFor({state:"hidden"});
    await revisionControl.waitFor({state:"hidden"});
    await more.press("ArrowDown");
    const overflow = page.getByRole("menu",{name:"More status controls",exact:true});
    await overflow.waitFor();
    const topItems = await overflow.locator(":scope > button, :scope > .nav-sub > button").allTextContents();
    assert.ok(topItems.every(label => label.trim()),"every project command in the menu has a visible label");
    assert.ok(!topItems.includes("Save unsaved changes"),"the save indicator stays in the bar");
    assert.ok((await overflow.boundingBox()).y + (await overflow.boundingBox()).height <= (await more.boundingBox()).y,
      "the status menu opens above the bar");
    await overflow.getByRole("menuitem",{name:/Assembly variant/}).press("ArrowRight");
    await page.getByRole("menuitemradio",{name:"Bench production variant",exact:true}).press("Enter");
    await page.waitForFunction(id => AtriumNavHost.project().activeVariant === id, narrowVariant);
    await more.click();
    await overflow.getByRole("menuitem",{name:/Rev A · Draft/}).click();
    const revisions = page.getByRole("dialog",{name:"Board Revisions",exact:true});
    await revisions.waitFor();
    await page.keyboard.press("Escape");
    await revisions.waitFor({state:"hidden"});
    await page.setViewportSize({width:1280,height:840});
    await more.waitFor({state:"hidden"});
    await variantControl.waitFor();
    await revisionControl.waitFor();
    await page.evaluate(id => {
      const host = AtriumNavHost;
      host.edit(() => {
        AtriumVariants.remove(host.project(),id);
        delete host.project().revision;
      });
    }, narrowVariant);

    await snapGrid(page);
    await page.evaluate(() => AtriumChecks.clear());
    await page.waitForFunction(() => document.getElementById("status-problems").dataset.state === "ok");
    assert.equal(await problems.textContent(), "0 problems");
    await problems.press("Enter");
    const messages = page.getByRole("region",{name:"Messages",exact:true}), activeTab = messages.getByRole("tab",{name:"Problems",exact:true});
    await activeTab.waitFor();
    assert.equal(await activeTab.getAttribute("aria-selected"), "true");
    await page.evaluate(async () => {
      AtriumMessages.close();
      const h = AtriumNavHost, board = h.documentRefs().find(doc => doc.kind === "pcb");
      await h.selectDocument(board.id);
      const track = h.doc().items.find(item => item.kind === "track" && item.net);
      if (!track) throw Error("The demo board has no routed track for the overlap check");
      h.edit(() => h.doc().items.push({...Atrium.clone(track), id:Atrium.id(), net:"QA_SHORT_PROBE"}));
      await AtriumDRCView.run({});
    });
    await page.waitForFunction(() => document.getElementById("status-problems").dataset.state === "bad");
    assert.match(await problems.textContent(), /^[1-9][0-9]* problems?$/);
    // The count toggles Problems (as in VS Code): the check run may have opened it already, so start closed.
    await page.evaluate(() => AtriumMessages.close());
    await problems.click();
    assert.equal(await activeTab.getAttribute("aria-selected"), "true");
    assert.equal(parseInt(await problems.textContent(),10), await page.evaluate(() => AtriumMessages.problems().length));
    await problems.click();
    await page.waitForFunction(() => !AtriumMessages.isOpen());
    await checkRenderedMarkers(page);
    assert.deepEqual(errors, []);
    console.log("PASS spaced units and fixed coordinates, Grid and 24px zoom controls, conditional project status, and live Problems states");
  } finally { await page.close(); }
};

module.exports.publishReviewMarkers = publishReviewMarkers;

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"},
    browser => module.exports(browser),
    error => {console.error(error); process.exitCode = 1;});
}
