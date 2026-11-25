"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const selectors = {
  connection: ".sheet-connection-card",
  problem: "#waffle-problem-card",
  object: "#waffle-tooltip.is-card",
  insight: ".insight-card"
};

async function visible(page) {
  return page.evaluate(selectors => Object.keys(selectors).filter(kind => {
    const node = document.querySelector(selectors[kind]);
    return node && !node.hidden && node.getClientRects().length;
  }), selectors);
}

async function open(browser, app) {
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  page.setDefaultTimeout(6000);
  await page.clock.install();
  await page.goto(pathToFileURL(path.join(app, "index.html")).href);
  await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
  await page.waitForFunction(() => !!globalThis.AtriumNavHost?.doc()?.items.length);
  await page.evaluate(async () => {
    await AtriumLazy.need(["AtriumPrefs", "AtriumChecks", "AtriumConnectionPreview", "AtriumTooltip", "AtriumInsightsUI"]);
    AtriumPrefs.set("checks.liveErc", false);
    AtriumCamera.setPref("camera.animate", false);
  });
  return page;
}

async function connectionCrossing(page) {
  await page.evaluate(async () => {
    const h = AtriumNavHost, project = Atrium.project("Connection hover", []);
    const sheet = Atrium.sheet("schematic", "Hover sheet"), peer = Atrium.sheet("schematic", "Other sheet");
    project.documents = [sheet, peer, ...project.documents.filter(d => d.kind === "pcb")];
    sheet.items = [{...AtriumSchObjects.make("port", [10, 10], {text: "CONNECTOR", io: "input"}), id: "connector"}];
    peer.items = [{...AtriumSchObjects.make("port", [10, 10], {text: "CONNECTOR", io: "output"}), id: "other-port"}];
    await h.replaceProject(project, {force: true, dirty: false});
    await h.selectDocument(sheet.id);
  });
  await page.waitForFunction(() => !!AtriumConnectionPreview.current());
  const points = await page.evaluate(() => {
    const h = AtriumNavHost, pane = h.panes().find(p => p.active);
    const {canvas, view} = pane, rect = canvas.getBoundingClientRect();
    AtriumCamera.land();
    view.restoreCamera({cx: 10, cy: 10, scale: 16, referenceScale: 16});
    h.redraw();
    const [cx, cy] = view.worldToScreen([10, 10]);
    const points = [];
    for (let dx = -140; dx <= 140; dx += 3) {
      const x = rect.left + cx + dx, y = rect.top + cy;
      if (h.hit(canvas, x, y)?.item?.id === "connector") points.push({x, y});
    }
    if (points.length < 20) throw Error("Expected a connector spanning at least 60 px");
    const rest = points[4], marker = points.at(-5);
    const point = view.screenToWorld([marker.x - rect.left, marker.y - rect.top]), d = h.doc();
    const warning = {key: "hover-crossing", doc: d.id, domain: "schematic", source: "erc",
      check: "erc.unconnected_pin", severity: "warning", text: "Test connector warning",
      objects: [], at: [{doc: d.id, point}]};
    AtriumChecks.publish(d.id, "hover-crossing", [warning], row => row);
    if (AtriumProblemHover.over(canvas, rest.x, rest.y) || !AtriumProblemHover.over(canvas, marker.x, marker.y)) {
      throw Error("Expected the two points to straddle the marker hit region");
    }
    return {rest, marker, docId: d.id};
  });
  await page.mouse.move(points.rest.x, points.rest.y);
  await page.locator(selectors.connection).waitFor();
  assert.deepEqual(await visible(page), ["connection"]);
  await page.mouse.move(points.marker.x, points.marker.y);
  await page.locator(selectors.problem).waitFor();
  assert.deepEqual(await visible(page), ["problem"], "crossing along one connector leaves only the problem card");
  await page.mouse.move(points.rest.x, points.rest.y);
  await page.locator(selectors.connection).waitFor();
  assert.deepEqual(await visible(page), ["connection"], "the problem exit never overlaps the next connection card");
  await page.evaluate(() => {
    AtriumNavHost.view().pan(24, 0);
    AtriumNavHost.redraw();
  });
  await page.locator(selectors.connection).waitFor({state: "hidden"});
  await page.clock.runFor(420);
  assert.deepEqual(await visible(page), [], "pan invalidates the hover until the pointer moves");
  await page.evaluate(() => {
    AtriumNavHost.view().pan(-24, 0);
    AtriumNavHost.redraw();
    AtriumNavHost.canvas().focus();
  });
  await page.mouse.move(points.rest.x, points.rest.y + 40);
  await page.mouse.move(points.rest.x, points.rest.y);
  const target = page.locator(".sheet-connection-card .sheet-connection-target").first();
  await target.waitFor();
  await page.keyboard.press("Tab");
  assert.equal(await target.evaluate(node => node === document.activeElement), true);
  await page.mouse.move(points.marker.x, points.marker.y);
  await page.clock.runFor(420);
  assert.deepEqual(await visible(page), ["connection"], "a connection action keeps focus during pointer movement");
  assert.equal(await target.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement === AtriumNavHost.canvas()), true);
  await page.mouse.move(points.rest.x, points.rest.y);
  await page.evaluate(() => {
    const h = AtriumNavHost;
    return h.selectDocument(h.project().documents.find(d => d.kind === "pcb").id);
  });
  await page.clock.runFor(420);
  assert.deepEqual(await visible(page), [], "a pending schematic hover cannot open after a document switch");
  await page.evaluate(async docId => {
    const h = AtriumNavHost;
    await h.selectDocument(docId);
    await AtriumLazy.need("AtriumCanvasInput");
    AtriumCamera.land();
    h.view().restoreCamera({cx: 10, cy: 10, scale: 16, referenceScale: 16});
    h.redraw();
  }, points.docId);
  await page.mouse.move(points.rest.x, points.rest.y + 40);
  await page.mouse.move(points.rest.x, points.rest.y);
  await page.locator(selectors.connection).waitFor();
  const touch = type => page.evaluate(({type, point}) => {
    AtriumNavHost.canvas().dispatchEvent(new PointerEvent(type, {
      pointerType: "touch", isPrimary: true, pointerId: 91, bubbles: true, cancelable: true,
      clientX: point.x, clientY: point.y, button: 0, buttons: type === "pointerdown" ? 1 : 0
    }));
  }, {type, point: points.rest});
  await touch("pointerdown");
  await page.locator(selectors.connection).waitFor({state: "hidden", timeout: 250});
  await page.clock.runFor(500);
  await touch("pointerup");
  await page.locator(".nav-menu[role=menu], .ctx-menu[role=menu]").first().waitFor();
  assert.deepEqual(await visible(page), [], "a touch hold replaces passive hover with the canvas context menu");
}

async function insightOverlap(page) {
  await page.evaluate(async () => {
    const h = AtriumNavHost, project = Atrium.project("Insight hover", []);
    const board = project.documents.find(d => d.kind === "pcb");
    board.items = [{id: "hover-track", kind: "track", points: [[1, 1], [9, 1]], layer: "Top", net: "SENSE", width: .25}];
    AtriumInsights.register({
      id: "hover-fixture", kind: "pcb", title: "Test advice",
      run: () => [{objects: ["hover-track"], at: [5, 1], message: "This advice is placed over the track", sig: "same"}]
    });
    await h.replaceProject(project, {force: true, dirty: false});
    await h.selectDocument(board.id);
    AtriumPrefs.set("insights.expand", "click");
    AtriumInsightsUI.schedule({now: true, force: true});
  });
  await page.waitForFunction(() => AtriumInsightsUI.current().some(i => i.check === "hover-fixture"));
  const point = await page.evaluate(() => {
    const h = AtriumNavHost, pane = h.panes().find(p => p.active);
    AtriumCamera.land();
    pane.view.restoreCamera({cx: 5, cy: 1, scale: 18, referenceScale: 18});
    h.redraw();
    const rect = pane.canvas.getBoundingClientRect(), [sx, sy] = pane.view.worldToScreen([5, 1]);
    const x = rect.left + sx, y = rect.top + sy;
    if (h.hit(pane.canvas, x, y)?.item?.id !== "hover-track" ||
        AtriumInsightsUI.markerAt(pane, x, y)?.check !== "hover-fixture") throw Error("Marker must overlap its track");
    return {x, y};
  });
  await page.mouse.move(point.x, point.y);
  await page.locator(selectors.problem).waitFor();
  assert.deepEqual(await visible(page), ["problem"], "default click-to-expand shows the compact card");
  await page.keyboard.press("Escape");
  await page.evaluate(() => AtriumPrefs.set("insights.expand", "hover"));
  await page.mouse.move(point.x, point.y + 35);
  await page.mouse.move(point.x, point.y);
  await page.locator(selectors.insight).waitFor();
  assert.deepEqual(await visible(page), ["insight"], "the actionable hover Insight owns the same point as the track");
  await page.evaluate(() => {
    AtriumNavHost.view().pan(26, 0);
    AtriumNavHost.redraw();
  });
  await page.locator(selectors.insight).waitFor({state: "hidden"});
  await page.clock.runFor(420);
  assert.deepEqual(await visible(page), [], "programmatic pan dismisses a passive Insight");
  await page.evaluate(() => {
    AtriumNavHost.view().pan(-26, 0);
    AtriumNavHost.redraw();
  });
  await page.mouse.move(point.x, point.y + 35);
  await page.mouse.move(point.x, point.y);
  await page.locator(selectors.insight + " .insight-close").focus();
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement === AtriumNavHost.canvas()), true,
    "Escape from a focused passive Insight returns focus to its canvas");
  await page.evaluate(() => AtriumInsightsUI.open(AtriumInsightsUI.current().find(i => i.check === "hover-fixture")));
  await page.locator(selectors.insight).waitFor();
  await page.evaluate(() => {
    AtriumNavHost.view().pan(-26, 0);
    AtriumNavHost.redraw();
  });
  assert.deepEqual(await visible(page), ["insight"], "an explicitly opened Insight keeps its pinned lifetime");
}

module.exports = async function canvasHover(browser, {app = path.join(__dirname, "../../app")} = {}) {
  const failures = [];
  for (const scenario of [connectionCrossing, insightOverlap]) {
    const page = await open(browser, app);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await scenario(page);
      assert.deepEqual(errors, []);
    } catch (error) {
      failures.push(error);
    } finally {
      await page.close();
    }
  }
  if (failures.length) throw new AggregateError(failures, "Canvas hover ownership");
  console.log("PASS canvas hover ownership across a connector and problem, and an object and hover Insight");
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: "chrome"},
    browser => module.exports(browser, {app: process.argv[2]}),
    error => { console.error(error); process.exitCode = 1; });
}
