"use strict";

const assert = require("node:assert/strict");
const {sheetObjects} = require("./corpus.cjs");
const {menu, openProperties, data, activeDocument, itemPoint} = require("./browser.cjs");

const kindLabels = {port: "Port", offsheet: "Off-sheet connector", label: "Net label", power: "Power port", entry: "Sheet entry"};
const element = {card: ".sheet-connection-card", properties: ".sheet-connection-properties", target: "button.sheet-connection-target"};
const jumpModifier = process.platform === "darwin" ? "Meta" : "Control";
const ref = ({doc, item}) => ({doc: doc.id, item: item.id, name: item.text});

function candidates(design, scope) {
  const sheets = design.documents.filter(d => d.kind === "schematic");
  const groups = sheetObjects(sheets);
  return Object.entries(groups).flatMap(([kind, names]) => {
    const options = [];
    for (const [name, places] of names) {
      if (name.includes("[") || name.includes("{")) continue; // Seeded fixtures separately cover buses.
      for (const source of places) {
        const cross = places.find(other => other.doc.id !== source.doc.id);
        const local = places.find(other => other.doc.id === source.doc.id && other.item !== source.item);
        const ignored = cross && (kind === "label" && scope !== "global" || kind === "port" && scope === "hierarchical");
        const target = ignored ? local : cross || local;
        options.push({kind, ...ref(source), target: target && ref(target), ignored: ignored && ref(cross),
          score: ignored || cross ? 4 : local ? 2 : 1});
      }
    }
    return options.length ? [options.sort((a, b) => b.score - a.score)] : [];
  });
}

function targetIn(container, p) {
  let query = element.target + data("doc", p.doc) + data("item", p.item);
  if (p.entry) query += data("entry", p.entry);
  return container.locator(query).first();
}

async function ready(page) {
  await page.waitForFunction(() => {
    const h = AtriumNavHost, index = globalThis.AtriumConnectionPreview?.current();
    return index && index.compiled === AtriumHierarchy.peek(h.project(), h.revision());
  }, null, {timeout: 10000});
}

async function openCard(page, xy, probe) {
  const card = page.locator(element.card);
  await page.mouse.move(4, 4);
  await page.mouse.move(xy[0], xy[1]);
  await card.waitFor({state: "visible"});
  const title = await card.locator(".sheet-connection-title").innerText();
  assert.ok(title.includes(probe.name), "The card title did not name the hovered object.");
  assert.ok((await card.innerText()).includes(kindLabels[probe.kind]), "The card did not identify the object kind.");
  const box = await card.boundingBox();
  assert.ok(xy[0] < box.x || xy[0] > box.x + box.width || xy[1] < box.y || xy[1] > box.y + box.height,
    "The preview covered the hovered point.");
  return card;
}

async function readyTarget(container, probe, power) {
  let target = targetIn(container, probe);
  const more = container.getByRole("button", {name: /^Show more connections/});
  while (!await target.count() && await more.count()) {
    await more.click();
    target = targetIn(container, probe);
  }
  if (power && !await target.count()) target = container.locator(element.target).first();
  await target.scrollIntoViewIfNeeded();
  await target.locator('canvas[data-ready="true"]').waitFor();
  return target;
}

async function inspectNative(page, design, source) {
  await openProperties(page);
  const samples = candidates(design, source.effective);
  let native = 0, thumbnails = 0, crossJumps = 0, ignored = 0, noCrossSheet = 0, powerCards = 0;
  let checkedProperties = false;
  for (const options of samples) {
    let xy, probe;
    for (const option of options.slice(0, 15)) {
      try { xy = await itemPoint(page, option); probe = option; break; }
      catch (error) { if (error.code !== "ERR_ASSERTION") throw error; }
    }
    assert.ok(probe, "No usable canvas point for a native " + options[0].kind + ".");
    await ready(page);
    await page.evaluate(() => {
      // The independent ECO/ERC schedulers can read or replace the cache while
      // the pointer is still. Count compiler requests originating in preview UI.
      const hierarchy = AtriumHierarchy, methods = {compile: hierarchy.compile, compileCached: hierarchy.compileCached};
      const probe = {methods, requests: 0, revision: AtriumNavHost.revision()};
      window.__schematicHoverProbe = probe;
      for (const [key, method] of Object.entries(methods)) hierarchy[key] = function (...args) {
        if (/connection-preview\.js/.test(String(new Error().stack))) probe.requests++;
        return method.apply(this, args);
      };
    });
    let card;
    try { card = await openCard(page, xy, probe); }
    finally {
      const observed = await page.evaluate(() => {
        const probe = window.__schematicHoverProbe;
        Object.assign(AtriumHierarchy, probe.methods);
        delete window.__schematicHoverProbe;
        return {requests: probe.requests, unchanged: AtriumNavHost.revision() === probe.revision};
      });
      assert.deepEqual(observed, {requests: 0, unchanged: true}, "A pointer hover requested compilation or edited the project.");
    }
    native++;
    if (probe.ignored) {
      assert.equal(await targetIn(card, probe.ignored).count(), 0, "Scoped-out label or port appeared as a connection.");
      assert.match(await card.innerText(), /scope (keeps net labels|connects ports only)/i);
      ignored++;
    }
    if (probe.kind === "power") {
      const text = await card.locator(".sheet-connection-summary").first().innerText();
      assert.match(text, /[0-9]+ connections? on [0-9]+ sheets?/i);
      assert.ok(await card.locator(element.target).count() <= 3, "The power preview exceeded its thumbnail cap.");
      powerCards++;
    }
    if (probe.target) {
      const target = await readyTarget(card, probe.target, probe.kind === "power");
      const destination = await target.getAttribute("data-doc");
      thumbnails++;
      if (destination !== probe.doc) {
        await target.click();
        await activeDocument(page, destination);
        await page.locator(".sheet-connection-flash").waitFor();
        await menu(page, "view", "view-back");
        await activeDocument(page, probe.doc);
        await menu(page, "view", "view-forward");
        await activeDocument(page, destination);
        crossJumps++;
      }
    }
    if (source.sheets === 1) {
      const outside = card.locator(element.target + ":not(" + data("doc", probe.doc) + ")");
      assert.equal(await outside.count(), 0, "A one-sheet project exposed an external destination.");
      noCrossSheet++;
    }
    await page.keyboard.press("Escape");
    await card.waitFor({state: "hidden"});

    if (!checkedProperties) {
      xy = await itemPoint(page, probe);
      await page.mouse.click(...xy);
      const row = page.locator(element.properties);
      await row.waitFor({state: "visible"});
      assert.match(await row.innerText(), /Connects to/i);
      if (probe.target) await readyTarget(row, probe.target, probe.kind === "power");
      checkedProperties = true;
    }
  }
  assert.ok(native && checkedProperties, "The frozen sheet must exercise native hover and Properties.");
  return {native, thumbnails, crossJumps, ignored, noCrossSheet, powerCards};
}

async function inspectSeeded(page, seed) {
  const {port, entry, isolated, offsheet} = seed;
  let xy = await itemPoint(page, port);
  await ready(page);
  let card = await openCard(page, xy, port);
  await readyTarget(card, entry, false);
  assert.match(await card.innerText(), /\binput\b/i);
  await page.keyboard.down(jumpModifier);
  try { await page.mouse.dblclick(...xy); } finally { await page.keyboard.up(jumpModifier); }
  await activeDocument(page, entry.doc);

  xy = await itemPoint(page, entry);
  card = await openCard(page, xy, entry);
  await (await readyTarget(card, port, false)).click();
  await activeDocument(page, port.doc);
  await card.waitFor({state: "hidden"});

  xy = await itemPoint(page, isolated);
  card = await openCard(page, xy, isolated);
  const message = await card.innerText();
  assert.match(message, /not connected to any other sheet/i);
  assert.match(message, /hierarchical scope connects ports only to sheet entries/i);
  await page.keyboard.press("Escape");
  await card.waitFor({state: "hidden"});

  xy = await itemPoint(page, offsheet[0]);
  card = await openCard(page, xy, offsheet[0]);
  await readyTarget(card, offsheet[1], false);
  await page.mouse.move(4, 4);
  await card.waitFor({state: "hidden"});
  await page.keyboard.down(jumpModifier);
  try { await page.mouse.dblclick(...xy); } finally { await page.keyboard.up(jumpModifier); }
  await card.waitFor({state: "visible"});
  await activeDocument(page, offsheet[0].doc);
  await targetIn(card, offsheet[1]).waitFor();
  await targetIn(card, offsheet[2]).waitFor();
  await page.keyboard.press("Escape");
  await card.waitFor({state: "hidden"});
  return {seededPortEntry: true, seededIgnoredPort: true, seededSiblings: true, multiTargetChoice: true};
}

async function crossProbe(page) {
  const target = await page.evaluate(async () => {
    await AtriumLazy.need(["AtriumConnectionPreview", "AtriumCrossProbe"]);
    const h = AtriumNavHost, p = h.project();
    const graph = AtriumSheetConnections.index(AtriumHierarchy.compileCached(p, {defs: h.defs()}));
    const marks = new Map();
    for (const d of p.documents) if (d.kind === "pcb") for (const i of d.items) {
      if ((i.kind === "track" || i.kind === "via") && i.net && !marks.has(i.net)) marks.set(i.net, {d, i});
    }
    for (const [name, {d, i}] of marks) {
      const targets = graph.connectionsFor(name);
      if (!targets.length) continue;
      h.selectDocument(d.id);
      h.setTool("select");
      h.select([i.id]);
      return targets.map(t => [t.doc.id, t.item.id]);
    }
    return null;
  });
  if (!target) return {pcbProbe: false};
  await menu(page, "tools", "cross-probe");
  await page.waitForFunction(targets => {
    const h = AtriumNavHost;
    return targets.some(([doc, id]) => h.currentId() === doc && h.selection().includes(id));
  }, target);
  await page.locator(".sheet-connection-flash").waitFor();
  return {pcbProbe: true};
}

module.exports = {inspectNative, inspectSeeded, crossProbe};
