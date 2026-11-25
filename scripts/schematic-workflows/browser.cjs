"use strict";

const assert = require("node:assert/strict");

async function menu(page, group, action, sub) {
  const target = page.locator('.work-menu[data-menu="' + group + '"]');
  await target.locator("summary").click();
  if (sub) await target.locator(".submenu-trigger").filter({hasText: sub}).first().click();
  await target.locator('[data-action="' + action + '"]').click();
}

async function openProperties(page) {
  const inspector = page.locator("#inspector");
  if (await inspector.isVisible()) return;
  const panels = page.locator(".panels-menu");
  await panels.locator("summary").click();
  await panels.getByRole("menuitem", {name:"Properties", exact:true}).click();
  await inspector.waitFor();
}

function data(name, value) {
  return "[data-" + name + "=" + JSON.stringify(value) + "]";
}

function activeDocument(page, id) {
  return page.waitForFunction(id => AtriumNavHost.currentId() === id, id);
}

async function zoom(page, box, scale) {
  await page.evaluate(({box, scale}) => {
    const h = AtriumNavHost, view = h.view();
    const camera = AtriumNavCommon.cameraFor(box, h.canvas().clientWidth, h.canvas().clientHeight, view.camera());
    if (scale) camera.scale = scale;
    view.restoreCamera(camera);
    h.redraw(true);
  }, {box, scale});
}

function screen(page, point) {
  return page.evaluate(point => {
    const h = AtriumNavHost, rect = h.canvas().getBoundingClientRect(), [x, y] = h.view().worldToScreen(point);
    return [rect.left + x, rect.top + y];
  }, point);
}

async function itemPoint(page, destination) {
  const point = await page.evaluate(({doc, item, entry}) => {
    const h = AtriumNavHost;
    h.selectDocument(doc);
    h.setTool("select");
    const i = h.doc().items.find(i => i.id === item);
    if (!i) return null;
    const drawing = AtriumSchAppearance.displayItem(h.doc(), i);
    if (entry) {
      const row = i.entries.find(e => e.id === entry);
      return {box: [...AtriumSchObjects.entryPoint(i, row), ...AtriumSchObjects.entryPoint(i, row)]};
    }
    const bounds = i.kind === "netlabel" ? AtriumSchAppearance.labelBox(drawing) : AtriumSchObjects.box(drawing);
    return {box: bounds || [i.x, i.y, i.x, i.y], anchor: [i.x, i.y]};
  }, destination);
  assert.ok(point, "The preview source is absent from the current sheet.");
  await zoom(page, point.box, 20);
  const xy = await page.evaluate(({item, entry, point}) => {
    const h = AtriumNavHost, rect = h.canvas().getBoundingClientRect();
    const [l, t, r, b] = point.box;
    const positions = [[(l + r) / 2, (t + b) / 2], ...(point.anchor ? [point.anchor] : [])];
    for (const x of [.2, .5, .8]) for (const y of [.2, .5, .8]) positions.push([l + x * (r - l), t + y * (b - t)]);
    for (const at of positions) {
      if (!entry && h.hitAt(at)?.id !== item) continue;
      const [x, y] = h.view().worldToScreen(at);
      if (x > 10 && x < rect.width - 10 && y > 10 && y < rect.height - 10) return [rect.left + x, rect.top + y];
    }
    return null;
  }, {...destination, point});
  assert.ok(xy, "The native canvas did not expose a pointer position for the object.");
  return xy;
}

module.exports = {menu, openProperties, data, activeDocument, zoom, screen, itemPoint};
