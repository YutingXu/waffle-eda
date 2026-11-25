"use strict";

const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");
const path = require("node:path");
const {root} = require("./corpus.cjs");
const pinned = require(path.join(root, "tests/real-history/sources.json"));

const sofleVariant = "sofle-v2-soldered";
const extra = {corne: ["pcbs/common/left.kicad_sch", "pcbs/common/right.kicad_sch"], lily58: [], [sofleVariant]: []};
const size = {A3: [297, 420], A4: [210, 297], A5: [148, 210]};
const direction = new Map([["input", "input"], ["output", "output"], ["bidirectional", "bidirectional"],
  ["tri_state", "bidirectional"], ["passive", "unspecified"]]);
const tuple = (text, x, y, io) => JSON.stringify([text, Number(x), Number(y), io || "unspecified"]);

function readSource(id, cache) {
  const pin = pinned.find(p => p.id === (id === sofleVariant ? "sofle" : id));
  assert.ok(pin && Object.hasOwn(extra, id), "Choose a modern pinned KiCad schematic project.");
  const from = path.join(cache, pin.id);
  const git = (...args) => execFileSync("git", ["-C", from, ...args], {maxBuffer: 32 * 1024 * 1024});
  assert.equal(git("rev-parse", pin.head + "^{commit}").toString().trim(), pin.head);
  const stem = id === sofleVariant ? "Sofle_v2_soldered/PCB/SofleKeyboard" : pin.design.replace(/\.kicad_pcb$/, "");
  return [stem + ".kicad_pcb", stem + ".kicad_pro", stem + ".kicad_sch", ...extra[id]].map(file => ({
    name: path.basename(file),
    mimeType: "application/octet-stream",
    buffer: git("show", pin.head + ":" + file),
  }));
}

async function openSource(page, files) {
  require(path.join(root, "app/formats/sexpr.js"));
  const parser = globalThis.AtriumSexpr;
  const expected = files.filter(f => f.name.endsWith(".kicad_sch")).map(f => {
    const tree = parser.parse(f.buffer.toString("utf8"));
    const paper = parser.val(tree, "paper"), axes = size[paper];
    assert.ok(axes, "A pinned source sheet had an unexpected paper size.");
    const labels = parser.all(tree, "global_label").map(i => {
      const shape = parser.val(i, "shape"), xy = parser.xy(i, "at");
      assert.ok(direction.has(shape), "A pinned input used an unexpected label shape.");
      return tuple(i[1], ...xy, direction.get(shape));
    });
    return {name: f.name, axes, labels: labels.sort()};
  });
  await page.locator("#file-input").setInputFiles(files);
  await page.waitForFunction(n => {
    const p = AtriumNavHost.project();
    return p.documents.length === n && p.documents.every(d =>
      (globalThis.AtriumImportReports?.sourceDocument(d) || d).sourceName?.includes(".kicad_"));
  }, files.length - 1, {timeout: 30000});
  const actual = await page.evaluate(() => AtriumNavHost.project().documents.filter(d => d.kind === "schematic").map(d => {
    const [l, t, r, b] = AtriumSchAppearance.pageBounds(d);
    const src = globalThis.AtriumImportReports?.sourceDocument(d) || d;
    return {name: src.sourceName.split("/").at(-1), origin: [l, t], axes: [r - l, b - t].sort((a, b) => a - b),
      labels: d.items.filter(i => i.kind === "offsheet").map(i => [i.text, i.x, i.y, i.io])};
  }));
  for (const wanted of expected) {
    const found = actual.find(row => row.name === wanted.name);
    assert.ok(found, "The editor omitted a selected source sheet.");
    assert.deepEqual(found.origin, [0, 0], "The imported drawing changed KiCad's top-left origin.");
    assert.deepEqual(found.axes.map(x => Math.round(x * 100) / 100), wanted.axes, "The imported drawing changed KiCad's paper.");
    const labels = found.labels.map(args => tuple(...args)).sort();
    const matches = labels.filter((value, i) => value === wanted.labels[i]).length;
    assert.ok(labels.length === wanted.labels.length && matches === wanted.labels.length,
      "Imported global-label I/O differs from raw KiCad (" + matches + "/" + wanted.labels.length + " positions matched).");
  }
  return {paperSheets: expected.length, labelShapes: expected.reduce((total, d) => total + d.labels.length, 0)};
}

function reopen(page, id, cache) {
  return openSource(page, readSource(id, cache));
}

async function prepareSofle(page, cache) {
  const files = readSource(sofleVariant, cache);
  const imported = await openSource(page, files);
  const bytes = Buffer.from(await page.evaluate(() => JSON.stringify(AtriumNavHost.project())));
  return {bytes, design: JSON.parse(bytes), imported, verify() {
    readSource(sofleVariant, cache).forEach((file, index) => {
      assert.ok(file.buffer.equals(files[index].buffer), "A pinned source blob changed during verification.");
    });
  }};
}

module.exports = {reopen, prepareSofle, sofleVariant};
