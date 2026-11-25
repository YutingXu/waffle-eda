"use strict";

const assert = require("node:assert/strict");
const {menu, data, activeDocument, zoom, screen} = require("./browser.cjs");

const row = id => '#documents > [role="treeitem"]' + data("doc", id);
const scopeButton = "#project-connection-scope";

async function inspectNative(page, design, source) {
  const scope = page.locator(scopeButton);
  await scope.waitFor({state: "visible"});
  assert.match(await scope.innerText(), new RegExp("Connections:.*" + source.effective, "i"));
  assert.equal(await page.locator("#project-scope-notice:visible").count(), 0, "Opening the saved project prompted to change its scope.");
  await scope.click();
  const dialog = page.locator("#project-connections-dialog");
  await dialog.waitFor({state: "visible"});
  const choices = await dialog.locator("select option").evaluateAll(options => options.map(o => o.value));
  assert.deepEqual(choices.slice().sort(), ["automatic", "flat", "global", "hierarchical"]);
  assert.equal(await dialog.locator("select").inputValue(), source.scope, "The settings dialog changed the stored scope.");
  await dialog.getByRole("button", {name: "Cancel", exact: true}).focus();
  await page.keyboard.press("Escape");
  await dialog.waitFor({state: "hidden"});

  const sheets = design.documents.filter(d => d.kind === "schematic");
  let nativeTree = false;
  if (source.links && source.effective === "hierarchical") {
    const parent = sheets.find(d => d.items.some(i => i.kind === "sheetsymbol" && i.sheet));
    const children = parent.items.filter(i => i.kind === "sheetsymbol" && i.sheet).map(i => i.sheet);
    const branch = page.locator(row(parent.id));
    await branch.waitFor({state: "visible"});
    assert.equal(await branch.getAttribute("aria-level"), "1");
    await branch.focus();
    if (await branch.getAttribute("aria-expanded") === "true") await page.keyboard.press("ArrowLeft");
    assert.equal(await branch.getAttribute("aria-expanded"), "false");
    for (const id of children) assert.equal(await page.locator(row(id) + ":visible").count(), 0);
    await page.keyboard.press("ArrowRight");
    assert.equal(await branch.getAttribute("aria-expanded"), "true");
    for (const id of children) assert.equal(await page.locator(row(id)).getAttribute("aria-level"), "2");
    nativeTree = true;
  } else {
    assert.ok(!(await page.locator('#documents [role="treeitem"][aria-level]:not([aria-level="1"])').count()),
      "A project without resolved children displayed nested sheet rows.");
  }
  return {scope: source.effective, nativeTree};
}

async function seed(page) {
  return page.evaluate(async () => {
    const h = AtriumNavHost, A = Atrium, S = AtriumSchObjects, p = A.clone(h.project());
    const parent = p.documents.find(d => d.kind === "schematic");
    const child = A.sheet("schematic", "QA Sensor"), peer = A.sheet("schematic", "QA Peer");
    const repeats = A.sheet("schematic", "QA Repeated");
    p.documents.push(child, peer, repeats);
    const used = parent.items.flatMap(i => A.itemPoints(i, h.defs().get(i.def), parent.kind));
    const bounds = A.bounds(used) || [0, 0, 50, 50];
    const x = bounds[2] + 30, y = bounds[1] + 10;
    const testPort = (doc, text, at, kind = "port") => {
      const item = S.make(kind, at, {text, io: "input"});
      doc.items.push(item);
      return {doc: doc.id, item: item.id, name: text, kind};
    };
    const port = testPort(child, "__QA_SENSOR_R5", [20, 20]);
    const row = {id: A.id(), name: port.name, side: "left", offset: 5.08, io: "input"};
    const symbol = S.make("sheetsymbol", [x, y], {name: "QA Sensor link", sheet: child.id, entries: [row]});
    const entry = {doc: parent.id, item: symbol.id, entry: row.id, name: row.name, kind: "entry"};
    const peerSymbol = S.make("sheetsymbol", [x, y + 30], {name: "QA Peer link", sheet: peer.id});
    const repeatSymbol = S.make("sheetsymbol", [x, y + 60], {name: "Repeat(QA,1,2)", sheet: repeats.id});
    parent.items.push(symbol, peerSymbol, repeatSymbol);
    const isolated = testPort(child, "__QA_IGNORED_R5", [20, 38]);
    testPort(peer, isolated.name, [20, 38]);
    const offsheet = [child, peer].map(d => testPort(d, "__QA_SIBLING_R5", [20, 60], "offsheet"));
    offsheet.push(testPort(peer, offsheet[0].name, [20, 80], "offsheet"));
    p.rules ??= {version: 1, list: []};
    p.rules.list = p.rules.list.filter(r => r.type !== "ercNetScope");
    p.rules.list.push({id: "qa-scope-r5", name: "Net Identifier Scope", priority: 1,
      enabled: true, type: "ercNetScope", where: "schematic", scope: {kind: "all"}, netScope: "hierarchical"});
    await h.replaceProject(p, {force: true, copy: true, dirty: false});
    return {parent: parent.id, child: child.id, repeats: repeats.id, port, entry, isolated, offsheet};
  });
}

async function inspectSeeded(page, seed) {
  const parent = page.locator(row(seed.parent)).first();
  await parent.waitFor({state: "visible"});
  await parent.focus();
  if (await parent.getAttribute("aria-expanded") !== "true") await page.keyboard.press("ArrowRight");
  const child = page.locator(row(seed.child)).first();
  assert.equal(await child.getAttribute("aria-level"), "2");
  assert.ok(Number(await child.getAttribute("aria-posinset")) > 0 && Number(await child.getAttribute("aria-setsize")) >= 3);
  const repeated = page.locator(row(seed.repeats)).first();
  assert.match(await repeated.innerText(), /×\s*2/);
  await repeated.focus();
  if (await repeated.getAttribute("aria-expanded") !== "true") await page.keyboard.press("ArrowRight");
  for (const channel of ["QA1", "QA2"]) {
    assert.ok(await page.getByRole("treeitem", {name: new RegExp(channel)}).count(), "A repeated channel is missing.");
  }
  await child.focus();
  if (await child.getAttribute("aria-expanded") !== "true") await page.keyboard.press("ArrowRight");
  const port = page.locator('#documents > [role="treeitem"]' + data("port", seed.port.item));
  await port.click();
  await activeDocument(page, seed.child);
  return {seededRepeat: true, seededPortJump: true};
}

async function overview(page, design, source) {
  assert.equal(await page.locator("#doc-view-sheet-overview:visible").count(), 0);
  assert.equal(await page.evaluate(() => Boolean(globalThis.AtriumSheetOverviewModel)), false, "Opening a project eagerly loaded the diagram.");
  const open = () => menu(page, "project", "sheet-overview");
  await open();
  const panel = page.locator("#doc-view-sheet-overview");
  const nodes = panel.locator(".sheet-overview-node");
  await nodes.first().waitFor({state: "visible"});
  const count = design.documents.filter(d => d.kind === "schematic").length;
  // The diagram virtualizes boxes outside its scrolling viewport.
  assert.match(await panel.locator(".sheet-overview-bar").innerText(), new RegExp("\\b" + count + " sheets?\\b", "i"));
  assert.equal(await panel.locator(".sheet-overview-branch").count(), source.links);
  const edge = panel.locator(".sheet-overview-connection");
  let edges = await edge.count();
  const status = panel.locator(".sheet-overview-pages [role=status]");
  if (await status.isVisible()) edges = Number((await status.innerText()).match(/([0-9]+)\s*$/)?.[1]);
  if (edges) {
    assert.ok(count > 1);
    await edge.first().click();
    await panel.waitFor({state: "hidden"});
    assert.ok(await page.evaluate(() => AtriumNavHost.doc().kind === "schematic" && AtriumNavHost.selection().length > 0),
      "A labelled inter-sheet connection did not land on an object.");
    await open();
  } else await panel.getByText("No connections between sheets.", {exact: true}).waitFor();
  await nodes.first().click();
  await panel.waitFor({state: "hidden"});
  assert.equal(await page.evaluate(() => AtriumNavHost.doc().kind === "schematic" && !AtriumNavHost.isDirty()), true);
  return {overviewSheets: count, overviewEdges: edges};
}

async function setScope(page, value) {
  await page.locator(scopeButton).click();
  const dialog = page.locator("#project-connections-dialog");
  await dialog.locator("select").selectOption(value);
  await dialog.getByRole("button", {name: "Apply", exact: true}).click();
  await dialog.waitFor({state: "hidden"});
}

async function firstPortNotice(page) {
  await page.evaluate(() => {
    const h = AtriumNavHost;
    h.selectDocument(h.project().documents.find(d => d.kind === "schematic").id);
  });
  await setScope(page, "automatic");
  const scope = page.locator(scopeButton), notice = page.locator("#project-scope-notice");
  const place = async () => {
    await zoom(page, [12, 12, 35, 35]);
    await menu(page, "place", "sch-port");
    await page.waitForFunction(() => AtriumNavHost.tool() === "sch-place");
    await page.mouse.click(...await screen(page, [21, 21]));
    await notice.waitFor({state: "visible"});
    assert.match(await notice.innerText(), /Global → Flat/);
    await page.evaluate(() => AtriumNavHost.setTool("select"));
  };
  const original = await page.evaluate(() => AtriumNavHost.undoSteps().history.length);
  await place();
  await notice.getByRole("button", {name: "Keep Global", exact: true}).click();
  assert.match(await scope.innerText(), /Connections: Global/i);
  assert.equal(await page.evaluate(() => AtriumHierarchy.scopeSetting(AtriumNavHost.project())), "global");
  await menu(page, "edit", "undo");
  await page.waitForFunction(() => AtriumHierarchy.scopeSetting(AtriumNavHost.project()) === "automatic" && !AtriumNavHost.doc().items.some(i => i.kind === "port"));

  await place();
  await notice.getByRole("button", {name: "Switch", exact: true}).click();
  assert.match(await scope.innerText(), /Automatic → Flat/i);
  assert.equal(await page.evaluate(() => AtriumNavHost.undoSteps().history.length), original + 1);
  await menu(page, "edit", "undo");
  assert.match(await scope.innerText(), /Automatic → Global/i);
  return {automaticKeepAndSwitch: true, scopeUndo: true};
}

module.exports = {inspectNative, seed, inspectSeeded, overview, setScope, firstPortNotice};
