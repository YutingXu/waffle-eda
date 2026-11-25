"use strict";
// Run with Node, Playwright and Chrome after preparing the app assets.
// Pass --mcp for saved-project parity through Python and the native folder host.
const assert = require("node:assert/strict");
const {mkdtemp, mkdir, rm, writeFile} = require("node:fs/promises");
const {execFileSync} = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require("playwright-core");
const {projectZIP, openProjectZIP, readProjectZIP} = require("../support/browser-native-project.cjs");
require("../../app/pcb/stackup.js");

const root = path.resolve(__dirname, "../..");
const app = process.argv.includes("--app") ? path.resolve(process.argv[process.argv.indexOf("--app") + 1]) : path.join(root, "app");
const editor = pathToFileURL(path.join(app, "index.html")).href;
const ringCheck = "layout.annularRing";

function fixture() {
  const pad = (number, x, size) => ({kind:"pad", number, x, y:0, w:size, h:size, layer:"Multi", drill:.4, shape:"round", plated:true});
  // Pad 1 fails the scoped design rule. Pad 2 fails the four-layer fab's PTH limit.
  const def = {id:Atrium.id(), name:"Ring test footprint", footprint:{pads:[pad("1", 0, .78), pad("2", 6, .56)], shapes:[]}};
  const project = Atrium.project("Annular ring regression", [def]);
  const board = project.documents.find(doc => doc.kind === "pcb");
  const part = {id:Atrium.id(), kind:"part", def:def.id, ref:"U1", value:"", x:10, y:10, angle:90, layer:"Top",
    pinNets:{"1":"STRICT", "2":"FAB"}};
  // The inner land fails DRC at .04 mm, and the authored land fails DFM at .12 mm.
  const stack = {...pad("3", 25, .64), id:Atrium.id(), y:10, net:"STRICT", stackMode:"tmb",
    padStack:{Top:{w:.64, h:.64, shape:"round"}, Mid:{w:.48, h:.48, shape:"round"}, Bottom:{w:.64, h:.64, shape:"round"}}};
  const via = {id:Atrium.id(), kind:"via", x:25, y:25, layer:"Multi", net:"CONTROL", diameter:.38, drill:.3};
  board.items = [part, stack, via];
  board.outline = [[0, 0], [40, 0], [40, 40], [0, 40]];
  board.stackup = AtriumStackup.preset("4");
  board.fabPreset = {id:"jlcpcb-4l"};
  const rule = (name, net, min) => ({id:Atrium.id(), name, type:"annularRing", comment:"", enabled:true, priority:1,
    scope:AtriumDesignQueryRecord.selector("net", net), min});
  project.rules = {format:"atrium-rules", version:3, units:"mm",
    list:[rule("Strict pad ring", "STRICT", .22), rule("Control via ring", "CONTROL", .1)]};
  return {project:Atrium.validate(project), board, part, stack, via};
}

const sortRows = list => list.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.actual - b.actual || a.required - b.required);
const signature = ({id, at, actual, required}) => ({id, at, actual:Math.round(actual * 1000) / 1000, required});
const signatures = rows => sortRows(rows.map(signature));
function expected({part, stack, via}, moved = false) {
  const x = moved ? 13 : 10;
  return [
    {text:/0\.19\s?mm < 0\.22\s?mm.*Pad U1-1\b/, source:"drc", id:part.id, at:[x, 10], actual:.19, required:.22},
    {text:/Pad U1-2\b.*0\.08 mm.*0\.15 mm PTH minimum/, source:"dfm", id:part.id, at:[x, 16], actual:.08, required:.15},
    {text:/0\.04\s?mm < 0\.22\s?mm.*Pad 3\b.*STRICT/, source:"drc", id:stack.id, at:[25, 10], actual:.04, required:.22},
    {text:/Pad 3\b.*0\.12 mm.*0\.15 mm PTH minimum/, source:"dfm", id:stack.id, at:[25, 10], actual:.12, required:.15},
    ...(moved ? [] : [{text:/0\.04\s?mm < 0\.1\s?mm.*Via \(.*CONTROL.*rule Control via ring applied/,
      source:"drc", id:via.id, at:[25, 25], actual:.04, required:.1}])
  ];
}

async function snapshot(page) {
  return page.evaluate(() => {
    const board = AtriumNavHost.doc();
    const check = "layout.annularRing", alias = "layout.fab.ring";
    const read = v => ({key:v.key, check:v.check, source:v.source, id:v.objects[0].id, at:v.at[0].point,
      actual:v.measure?.actual, required:v.measure?.required, text:v.text, merged:v.merged});
    return {
      raw:AtriumChecks.violations({doc:board.id}).filter(v => v.check === check || v.check === alias).map(read),
      merged:AtriumMessages.problems().filter(row => row.problem?.check === check)
        .map(row => ({...read(row.problem), text:row.text}))
    };
  });
}

async function runCheckDesign(page) {
  const previous = await page.evaluate(() =>
    AtriumChecks.sources().find(s => s.scope === AtriumNavHost.currentId() && s.source === "dfm")?.at ?? null);
  await page.locator('.work-menu[data-menu="tools"] > summary').click();
  await page.getByRole("menuitem", {name:"Check Design", exact:true}).click();
  await page.waitForFunction(previous => {
    const dfm = AtriumChecks.sources().find(s => s.scope === AtriumNavHost.currentId() && s.source === "dfm");
    return dfm?.at > (previous ?? 0) && globalThis.AtriumMessages?.view() === "problems" && AtriumMessages.isOpen();
  }, previous);
}

const messages = page => page.locator(".msg-panel:visible");
const visibleRows = page => messages(page).locator('tr[data-no]');

async function verifyView(page, fixture, moved, label) {
  const want = expected(fixture, moved);
  const {raw, merged} = await snapshot(page);
  assert.deepEqual(signatures(raw), signatures(moved ? want : [...want, {...want.at(-1), required:.05}]), label + " raw DRC and fabrication");
  assert.deepEqual(signatures(merged), signatures(want), label + " merged Problems");
  assert.equal(new Set(merged.map(row => row.key)).size, want.length, label + " distinct selectable keys");
  if (!moved) assert.deepEqual(merged.find(row => row.id === fixture.via.id).merged, ["layout.fab.ring"]);

  await messages(page).getByRole("searchbox", {name:"Filter messages"}).fill("annular ring");
  const text = await visibleRows(page).locator(".msg-col-text").allTextContents();
  assert.equal(text.length, want.length, label + " visible Problems");
  for (const row of want) {
    const found = merged.find(v => v.source === row.source && v.id === row.id && v.at.join() === row.at.join());
    assert.ok(found && row.text.test(found.text), label + " row for " + row.text);
    assert.equal(text.filter(value => row.text.test(value)).length, 1, label + " paints " + found.text);
  }
  return merged.sort((a, b) => a.key.localeCompare(b.key));
}

async function verifyTarget(page, fixture, row) {
  const visible = visibleRows(page).filter({hasText:row.text});
  assert.equal(await visible.count(), 1);
  // Move away first, so the check observes a fresh camera move even for the two stacked-pad rows.
  await page.evaluate(() => AtriumNavHost.centerOn([4, 4]));
  await page.waitForFunction(() => Math.abs(AtriumNavHost.view().camera().cx - 4) < .05);
  await visible.click();
  assert.equal(await visible.getAttribute("aria-selected"), "true");
  await page.waitForFunction(({board, point}) => {
    const host = AtriumNavHost, {cx, cy} = host.view().camera();
    return host.currentId() === board && Math.hypot(cx - point[0], cy - point[1]) < .05;
  }, {board:fixture.board.id, point:row.at});
  await page.waitForFunction(({actual, required, source}) => {
    const finding = globalThis.AtriumDRCInspector?.current();
    const measure = source === "dfm" && finding?.source === source ? finding.measure
      : source === "drc" && finding?.type === "annularRing" ? finding : null;
    return measure && Math.abs(measure.actual - actual) < 1e-9 && measure.required === required;
  }, row);
  if (row.source === "dfm") assert.deepEqual(await page.evaluate(() => AtriumNavHost.selection()), [row.id]);
}

async function checkMCP(file, fixture, editorRows) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "waffle-annular-problems-"));
  try {
    const {files} = await readProjectZIP(file.buffer);
    for (const [name, bytes] of files) {
      const target = path.join(dir, name);
      await mkdir(path.dirname(target), {recursive:true});
      await writeFile(target, bytes);
    }
    const manifest = [...files.keys()].find(name => name.endsWith(".waffle"));
    assert.ok(manifest);
    const checkout = path.dirname(app), server = path.join(checkout, "mcp", "server.py");
    const env = require("../support/native-folder-fixture.cjs").hostEnv(path.join(dir, "folder-host"), checkout);
    const args = {documents:[fixture.board.id], checks:[ringCheck], domains:["layout"], hints:false};
    const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
    const result = JSON.parse(execFileSync(python, ["-B", server, "--project", path.join(dir, manifest), "--read-only",
      "--cli", "check", "--args", JSON.stringify(args)], {encoding:"utf8", env, timeout:20000}));
    assert.deepEqual(result.items.map(row => row.check), Array(editorRows.length).fill(ringCheck));
    assert.deepEqual(signatures(result.items.map(row => ({id:row.objects[0], at:row.at[0], ...row.measure}))), signatures(editorRows));
    assert.deepEqual(result.items.map(row => row.key).sort(), editorRows.map(row => row.key).sort());
    const via = result.items.find(row => row.objects.includes(fixture.via.id));
    assert.equal(via.bound, "rule");
    assert.deepEqual(via.merged, ["layout.fab.ring"]);
    assert.match(via.text, /rule Control via ring applied/);
  } finally {
    await rm(dir, {recursive:true, force:true});
  }
}

async function run(browser, {mcp = false} = {}) {
  const data = fixture(), file = await projectZIP(data.project, {entryDocument:data.board.id});
  const page = await browser.newPage({viewport:{width:1440, height:900}});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  try {
    await page.goto(editor);
    await openProjectZIP(page, file);
    await page.waitForFunction(({boardId, defId}) => {
      const host = AtriumNavHost, pads = host.defs().get(defId)?.footprint?.pads;
      return host.currentId() === boardId && pads?.length === 2 && pads.every(pad => pad.nativeId);
    }, {boardId:data.board.id, defId:data.part.def});
    await page.evaluate(() => AtriumLazy.need("AtriumChecks"));
    await runCheckDesign(page);
    const initial = await verifyView(page, data, false, "Initial");
    for (const row of expected(data)) await verifyTarget(page, data, row);
    await page.evaluate(() => AtriumNavHost.act("toggle-units"));
    await runCheckDesign(page);
    await visibleRows(page).filter({hasText:/1\.575mil < 3\.937mil.*rule Control via ring applied/}).waitFor();
    await page.evaluate(() => AtriumNavHost.act("toggle-units"));

    assert.ok(await page.evaluate(({partId, viaId}) => {
      const host = AtriumNavHost, [part, via] = [partId, viaId].map(id => host.doc().items.find(item => item.id === id));
      return host.edit(() => {part.x += 3; via.diameter = .65;}, "Move footprint and enlarge via", [part, via]);
    }, {partId:data.part.id, viaId:data.via.id}));
    await runCheckDesign(page);
    const edited = await verifyView(page, data, true, "Edited");
    await verifyTarget(page, data, expected(data, true)[1]);

    await page.evaluate(() => AtriumNavHost.act("undo"));
    await runCheckDesign(page);
    assert.deepEqual(await verifyView(page, data, false, "Undo"), initial);
    await verifyTarget(page, data, expected(data)[0]);

    await page.evaluate(() => AtriumNavHost.act("redo"));
    await runCheckDesign(page);
    assert.deepEqual(await verifyView(page, data, true, "Redo"), edited);
    await verifyTarget(page, data, expected(data, true)[1]);

    assert.deepEqual(errors, []);
    console.log("PASS annular-ring Problems in Chrome: separate footprint pads and stack measurements, one simple via, row navigation, Undo and Redo");
    if (mcp) {
      await checkMCP(file, data, initial);
      console.log("PASS saved MCP check matches the editor's annular-ring keys, values and locations");
    }
  } finally {
    await page.close();
  }
}

module.exports = run;
if (require.main === module) {
  (async () => {
    const browser = await chromium.launch({...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"}),
      args:["--allow-file-access-from-files"]});
    try { await run(browser, {mcp:process.argv.includes("--mcp")}); } finally { await browser.close(); }
  })().catch(error => {console.error(error); process.exitCode = 1;});
}
