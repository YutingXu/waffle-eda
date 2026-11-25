"use strict";

const assert = require("node:assert/strict");
const {sheetObjects} = require("./corpus.cjs");
const {openProperties, itemPoint} = require("./browser.cjs");

function nativeConnector(design) {
  const sheets = design.documents.filter(d => d.kind === "schematic");
  const original = [...sheetObjects(sheets).offsheet.values()].flat()[0];
  return original && {doc: original.doc.id, item: original.item.id, kind: "offsheet"};
}

async function edit(page, source) {
  await openProperties(page);
  const at = await itemPoint(page, source);
  await page.mouse.click(...at);
  const field = page.getByRole("combobox", {name: "I/O type", exact: true});
  await field.waitFor();
  const choices = await field.locator("option").evaluateAll(options => options.map(o => o.value));
  assert.deepEqual(choices.slice().sort(), ["bidirectional", "input", "output", "unspecified"]);
  await field.selectOption("output");
  const state = await page.evaluate(async source => {
    await AtriumLazy.need("AtriumAltiumExport");
    const h = AtriumNavHost, item = h.doc().items.find(i => i.id === source.item);
    const r = AtriumAltiumExport.exportSchematic(h.project(), h.doc());
    return {kind: item.kind, io: item.io, reported: r.diagnostics.some(n => /off-sheet connector direction output was dropped/i.test(n))};
  }, source);
  assert.deepEqual(state, {kind: "offsheet", io: "output", reported: true});
  await field.selectOption("unspecified");
  assert.ok(await page.evaluate(id => {
    const item = AtriumNavHost.doc().items.find(i => i.id === id);
    return item && !Object.hasOwn(item, "io");
  }, source.item), "The neutral direction did not restore the optional default on the same object.");
  return {ioEdit: true, altiumDirectionLoss: true};
}

module.exports = {nativeConnector, edit};
