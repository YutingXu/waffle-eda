"use strict";
// Run with Node, Playwright and Chrome after preparing the app assets.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require("playwright-core");
const {projectZIP, openProjectZIP} = require("../support/browser-native-project.cjs");
require("../../app/schematic/sch-objects.js");

const app = process.argv.includes("--app") ? path.resolve(process.argv[process.argv.indexOf("--app") + 1]) : path.resolve(__dirname, "../../app");
const editor = pathToFileURL(path.join(app, "index.html")).href;
function fixture({shared = false, global = false} = {}) {
  const A = Atrium, S = AtriumSchObjects;
  const definition = {id:"terminal", name:"Terminal", symbol:{pins:[{number:"1", name:"1", x:0, y:0, electrical:4}], shapes:[]},
    footprint:{pads:[], shapes:[]}};
  const project = A.project("Schematic net navigation", [definition]);
  const main = {...A.sheet("schematic", "Main"), id:"root"};
  const childA = {...A.sheet("schematic", "Channel A"), id:"child-a"};
  const childB = {...A.sheet("schematic", "Channel B"), id:"child-b"};
  project.documents = shared ? [main, childA] : [main, childA, childB];
  project.rules = {format:"atrium-rules", version:3, units:"mm", list:[{
    id:"net-scope", type:"ercNetScope", name:"Net Identifier Scope", enabled:true, priority:1,
    where:"schematic", scope:AtriumDesignQueryRecord.selector("all"), netScope:global ? "global" : "hierarchical"
  }]};
  const part = (id, ref, x, y) => ({kind:"part", id, def:definition.id, ref, x, y, angle:0, value:""});
  const wire = (id, ...points) => ({kind:"wire", id, points});
  const label = (id, text, x, y) => ({kind:"netlabel", id, text, x, y});
  for (const [i, suffix, child] of [[0, "a", childA], [1, "b", shared ? childA : childB]]) {
    const y = 30 * i, name = "FEED_" + suffix.toUpperCase();
    const entry = {id:"vin-" + suffix, name:"VIN", side:"left", offset:5.08, io:"input"};
    const symbol = {...S.make("sheetsymbol", [30, y - entry.offset], {name:"U_" + suffix.toUpperCase(), sheet:child.id, entries:[entry]}),
      id:"symbol-" + suffix};
    main.items.push(part("root-" + suffix, "J" + (i + 1), 0, y), label("feed-" + suffix, name, 0, y),
      wire("parent-wire-" + suffix, [0, y], S.entryPoint(symbol, entry)), symbol);
    if (shared && i) continue;
    child.items.push(part("input-" + suffix, "U" + (i + 1), 0, 0), wire("input-wire-" + suffix, [0, 0], [16, 0]),
      {...S.make("port", [16, 0], {text:"VIN", io:"input"}), id:"port-" + suffix},
      part("sense-" + suffix, "TP" + (i + 1), 0, 18), wire("sense-wire-" + suffix, [0, 18], [16, 18]),
      label("sense-label-" + suffix, "SENSE", 16, 18));
  }
  return Atrium.validate(project);
}

async function openNavigator(browser, data, docId) {
  const page = await browser.newPage({viewport:{width:1440, height:900}});
  page.setDefaultTimeout(10000);
  await page.goto(editor);
  await openProjectZIP(page, await projectZIP(data, {entryDocument:docId}));
  await page.waitForFunction(({docId, ids}) => AtriumNavHost.currentId() === docId && AtriumNavHost.defs().has("terminal") &&
    ids.every(id => AtriumNavHost.project().documents.some(d => d.id === id && d.items?.length)), {docId, ids:data.documents.map(d => d.id)});
  await page.evaluate(async () => {
    await AtriumLazy.need("AtriumConnectionPreview");
    await AtriumLazy.need("AtriumNavigatorPanel");
    await AtriumLazy.need("AtriumAltiumKeys");
    AtriumNavHost.act("navigator-panel");
    // Record the flags used by the real canvas painters, independently of pane selection.
    const paint = globalThis.schematicNetPaint = {};
    const label = AtriumSchAppearance.label;
    AtriumSchAppearance.label = (ctx, item, scale, selected) => {
      if (item.kind === "netlabel") paint[item.id] = !!selected;
      return label(ctx, item, scale, selected);
    };
    const draw = AtriumSchObjects.draw;
    AtriumSchObjects.draw = (ctx, item, opts) => {
      if (item.kind === "port") paint[item.id] = !!opts.lit;
      return draw(ctx, item, opts);
    };
    const maskAlpha = globalThis.schematicNetMaskAlpha = {};
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
      if (source instanceof HTMLCanvasElement && !source.isConnected &&
          source.width === this.canvas.width && source.height === this.canvas.height) {
        const pane = AtriumNavHost.panes().find(p => p.canvas === this.canvas);
        const mask = pane && source.getContext("2d");
        // The dimming bitmap is translucent away from the selected geometry.
        if (mask) {
          const corner = mask.getImageData(1, 1, 1, 1).data[3];
          const point = pane.view.worldToScreen([8, 0]);
          const x = Math.round(point[0] * this.canvas.width / this.canvas.clientWidth);
          const y = Math.round(point[1] * this.canvas.height / this.canvas.clientHeight);
          if (corner > 0 && corner < 255 && x >= 0 && y >= 0 && x < source.width && y < source.height)
            maskAlpha[pane.docId] = mask.getImageData(x, y, 1, 1).data[3];
        }
      }
      return drawImage.call(this, source, ...args);
    };
  });
  await page.getByRole("tree", {name:"Compiled design"}).waitFor();
  return page;
}

async function snapshot(page) {
  return page.evaluate(async () => {
    for (const id of Object.keys(schematicNetPaint)) delete schematicNetPaint[id];
    for (const id of Object.keys(schematicNetMaskAlpha)) delete schematicNetMaskAlpha[id];
    AtriumNavHost.invalidate();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const seen = Object.keys(schematicNetPaint).sort();
    return {doc:AtriumNavHost.currentId(), ids:AtriumNavHost.selection().sort(), highlight:AtriumNavHost.highlight(),
      occurrence:AtriumConnectionPreview.location().occurrence?.instanceId ?? null, seen, lit:seen.filter(id => schematicNetPaint[id]), mask:{...schematicNetMaskAlpha}};
  });
}

async function choose(page, name) {
  const panel = page.locator(".panel-navp:visible");
  await panel.getByRole("searchbox", {name:"Search the Navigator"}).fill(name);
  const row = panel.locator('.navp-row[data-type="net"]:visible').filter({has:page.getByText(name, {exact:true})});
  await row.click();
  return snapshot(page);
}

async function netsRow(page, name, nodes) {
  const filter = page.getByRole("searchbox", {name:"Filter nets"});
  await filter.fill(name);
  const row = page.getByRole("grid", {name:"Nets", exact:true}).getByRole("row").filter({has:page.getByText(name, {exact:true})});
  await row.waitFor();
  const actual = await row.getByRole("gridcell").last().textContent();
  assert.equal(actual, String(nodes), name + " should report all pins of the compiled net");
  return row;
}

function altiumFixture() {
  const file = (name, source) => ({name, mimeType:"application/octet-stream", buffer:Buffer.from(source)});
  const sheet = (name, parts, sources) => {
    const records = ["|RECORD=31"];
    for (const [ref, x, y] of parts) {
      const owner = records.length;
      records.push("|RECORD=1|LIBREFERENCE=Contact|LOCATION.X=" + x + "|LOCATION.Y=" + y,
        "|RECORD=2|OWNERINDEX=" + owner + "|OWNERPARTID=1|DESIGNATOR=1|ELECTRICAL=4|PINLENGTH=1|LOCATION.X=" + x + "|LOCATION.Y=" + y,
        "|RECORD=34|OWNERINDEX=" + owner + "|TEXT=" + ref,
        "|RECORD=27|LOCATIONCOUNT=2|X1=" + (x+1) + "|Y1=" + y + "|X2=" + (x+5) + "|Y2=" + y);
    }
    for (const [type, name, x, y] of sources) records.push("|RECORD=" + type + (type === 18 ? "|NAME=" : "|TEXT=") + name + "|LOCATION.X=" + x + "|LOCATION.Y=" + y);
    return file(name + ".SchDoc", records.join("\n"));
  };
  return [file("Test.PrjPcb","[Design]\nHierarchyMode=3\nNetlistSinglePinNets=0\n[Document1]\nDocumentPath=Local.SchDoc\n[Document2]\nDocumentPath=Remote.SchDoc\n"),
    sheet("Local", [["TP1",20,80],["TP2",30,90],["TP3",20,110],["TP4",20,130],["TP8",30,150],["TP9",30,160]],
      [[17,"SUPPLY",25,80],[18,"LINK",35,90],[25,"SOLO",25,110],[25,"OTHER",25,130],
       [25,"DATA0",35,150],[25,"DATA1",35,160],[18,"DATA[0..1]",20,180]]),
    sheet("Remote", [["TP5",50,70],["TP6",50,90],["TP7",60,110],["TP10",50,150]],
      [[17,"SUPPLY",55,70],[18,"LINK",55,90],[17,"SUPPLY",65,110],[25,"DATA0",55,150],[18,"DATA[0..1]",50,180]])];
}

async function importedMembership(browser) {
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  try {
    await page.goto(editor);
    await page.getByRole("button", {name:"Continue to editor", exact:true}).click();
    await page.locator("#file-input").setInputFiles(altiumFixture());
    await page.waitForFunction(() => AtriumNavHost.importSession()?.state === "unsaved");
    await page.evaluate(async () => {
      const h = AtriumNavHost;
      h.selectDocument(h.project().documents.find(d => d.name === "Local").id);
      await h.act("nets-panel");
    });
    await netsRow(page,"SUPPLY",3);
    await netsRow(page,"LINK",2);
    await netsRow(page,"SOLO",1);
    await netsRow(page,"DATA0",2);
    await netsRow(page,"DATA1",1);
    assert.equal(await page.evaluate(() => AtriumNetsPanel.rows().some(r => r.name === "DATA[0..1]")),false,
      "a bus does not combine its separate scalar pin memberships into a net row");
    const other = await netsRow(page,"OTHER",1);
    await other.click();
    assert.equal(await page.evaluate(() => AtriumNavHost.highlight()), "OTHER");

    await page.evaluate(() => AtriumNavHost.act("navigator-panel"));
    const tree = page.getByRole("tree",{name:"Compiled design"});
    await page.getByRole("searchbox",{name:"Search the Navigator"}).fill("SUPPLY");
    await tree.locator('.navp-row[data-type="net"]').filter({has:page.getByText("SUPPLY",{exact:true})}).locator('.navp-twisty').click();
    assert.deepEqual(await tree.locator('.navp-row[data-type="pin"] .navp-label').allTextContents(), ["TP1-1","TP5-1","TP7-1"]);
    await tree.getByText("TP7-1",{exact:true}).click();
    const services = await page.evaluate(async () => {
      const h = AtriumNavHost, project = h.project(), defs = h.defs(), doc = h.doc();
      const [Q, N, E] = await Promise.all([AtriumLazy.need("AtriumQueryService"), AtriumLazy.need("AtriumNetlist"), AtriumLazy.need("AtriumERC")]);
      const ruleQuery = 'pin where net.name = "SUPPLY"';
      const query = await Q.search(ruleQuery,{project, enabled:true, documentId:doc.id, revision:h.revision()});
      const restricted = await Q.search(ruleQuery,{project, enabled:true, documentId:doc.id, revision:h.revision(),
        authority:{documentIds:new Set([doc.id]),canReadItem:()=>false}});
      const extracted = N.extract(project,{source:"schematic"});
      const erc = E.run(project,{defs});
      return {sheet:doc.name, selection:h.selection().map(id => doc.items.find(i => i.id === id)?.ref),
        query:[query.status,query.count], restricted:[restricted.status,restricted.rows],
        protel:N.protel(extracted).split("\r\n").filter(line => ["SUPPLY","TP1-1","TP5-1","TP7-1","SOLO","TP3-1"].includes(line)),
        erc:erc.hierarchy.nets.find(n => n.name === "SUPPLY").pins.map(p => p.ref).sort()};
    });
    assert.deepEqual(services, {sheet:"Remote",selection:["TP7"],query:["complete",2],restricted:["denied",undefined],
      protel:["SOLO","TP3-1","SUPPLY","TP1-1","TP5-1","TP7-1"],erc:["TP1","TP5","TP7"]});
  } finally { await page.close(); }
}

async function run(browser, {observe = false} = {}) {
  if (!observe) await importedMembership(browser);
  const page = await openNavigator(browser, fixture(), "child-b");
  const check = (condition, message) => {
    if (!observe) assert.ok(condition, message);
  };
  try {
    const wrongNamesake = await choose(page, "SENSE");
    check(wrongNamesake.doc === "child-a", JSON.stringify(wrongNamesake));
    check(wrongNamesake.ids.includes("sense-wire-a") && !wrongNamesake.ids.includes("sense-wire-b"), JSON.stringify(wrongNamesake));
    const nativeChild = await choose(page, "SENSE_U_B");
    check(nativeChild.doc === "child-b" && nativeChild.ids.includes("sense-wire-b") && nativeChild.ids.includes("sense-label-b"), JSON.stringify(nativeChild));
    const feed = await choose(page, "FEED_B");
    check(feed.doc === "child-b" && feed.ids.includes("input-wire-b") && feed.ids.includes("port-b"), JSON.stringify(feed));

    if (!observe) {
      await page.evaluate(() => AtriumNavHost.act("nets-panel"));
      await netsRow(page, "FEED_B", 2);
      await netsRow(page, "SENSE_U_B", 1);
    }
    const masks = await page.evaluate(async () => {
      const host = AtriumNavHost;
      const raw = AtriumCrossProbe.targetAt(host.doc(), host.defs(), host.doc().items.find(i => i.id === "input-wire-b"))?.net;
      await host.openSplit("right", "child-a");
      host.select([]);
      return raw;
    });
    check(masks === "VIN", "the local wire pick retains its name");
    await page.getByRole("group", {name:"On click"}).getByRole("button", {name:"Select", exact:true}).click();
    const compiledPaint = await choose(page, "FEED_B");
    check(compiledPaint.seen.includes("port-a") && compiledPaint.lit.includes("port-b") && !compiledPaint.lit.includes("port-a"), JSON.stringify(compiledPaint));
    check(compiledPaint.mask["child-a"] > 100 && compiledPaint.mask["child-b"] < 10, "the inactive namesake stays dimmed: " + JSON.stringify(compiledPaint));
    await page.evaluate(() => {
      const h = AtriumNavHost, doc = h.doc(), item = doc.items.find(i => i.id === "input-wire-b");
      AtriumCrossProbe.highlightHit({doc, item});
    });
    const localPaint = await snapshot(page);
    check(localPaint.highlight === "VIN" && ["port-a", "port-b"].every(id => localPaint.lit.includes(id)), JSON.stringify(localPaint));
    check(localPaint.mask["child-a"] < 10 && localPaint.mask["child-b"] < 10, "local VIN still cuts both wires out of the dimming mask");
    if (!observe) {
      const row = await netsRow(page,"SENSE_U_B",1);
      await row.click();
      await page.getByRole("grid",{name:"Nets",exact:true}).press("Shift+Enter");
      const exact = await snapshot(page);
      assert.ok(exact.lit.includes("sense-label-b") && !exact.lit.includes("sense-label-a"),
        "Nets panel selects the compiled net instead of its sheet-local namesake: " + JSON.stringify(exact));
    }

    await page.getByRole("group", {name:"On click"}).getByRole("button", {name:"Select", exact:true}).click();
    await page.evaluate(() => {
      const h = AtriumNavHost, item = h.doc().items.find(i => i.id === "input-wire-b");
      h.edit(() => {item.points = [[0, 0], [12, 0]];}, "Disconnect child port", [item]);
    });
    const changed = await choose(page, "FEED_B");
    // The entry still reaches the child port. Only the disconnected wire leaves FEED_B.
    check(changed.doc === "child-b" && changed.ids.join() === "port-b" && changed.lit.includes("port-b"), JSON.stringify(changed));
    const disconnected = await choose(page, "Net-U2-1");
    check(disconnected.doc === "child-b" && disconnected.ids.join() === "input-wire-b" && !disconnected.lit.includes("port-b"), JSON.stringify(disconnected));
    await page.evaluate(() => AtriumNavHost.act("undo"));
    const undone = await choose(page, "FEED_B");
    check(undone.doc === "child-b" && undone.ids.includes("input-wire-b"), JSON.stringify(undone));
    await page.evaluate(() => AtriumNavHost.act("redo"));
    const redone = await choose(page, "FEED_B");
    check(redone.doc === "child-b" && redone.ids.join() === "port-b", JSON.stringify(redone));
    if (observe) console.log(JSON.stringify({wrongNamesake, nativeChild, feed, masks, compiledPaint, localPaint, changed, disconnected, undone, redone}));
  } finally { await page.close(); }

  const repeated = await openNavigator(browser, fixture({shared:true}), "child-a");
  try {
    const occurrences = await repeated.evaluate(() => {
      const h = AtriumNavHost, {instances} = AtriumHierarchy.compileCached(h.project(), {defs:h.defs()});
      return Object.fromEntries(instances.filter(i => i.parent).map(i => [i.symbol.name, i.id]));
    });
    const initial = await choose(repeated, "FEED_A");
    const second = await choose(repeated, "FEED_B");
    check(initial.occurrence === occurrences.U_A && second.occurrence === occurrences.U_B, JSON.stringify({occurrences, initial, second}));
    check(second.doc === "child-a" && second.ids.includes("input-wire-a") && second.lit.includes("port-a"), JSON.stringify(second));
    await repeated.evaluate(id => AtriumConnectionPreview.activateInstance("child-a", id), occurrences.U_A);
    const movedOccurrence = await snapshot(repeated);
    check(movedOccurrence.highlight === "FEED_B" && movedOccurrence.seen.includes("port-a") && !movedOccurrence.lit.includes("port-a"),
      JSON.stringify(movedOccurrence));
    if (observe) console.log(JSON.stringify({occurrences, initial, second, movedOccurrence}));
    else {
      await repeated.evaluate(() => AtriumNavHost.act("nets-panel"));
      await netsRow(repeated, "FEED_A", 2);
      assert.equal(await repeated.evaluate(() => AtriumNetsPanel.rows().some(r => r.name === "FEED_B")), false);
      await repeated.evaluate(id => AtriumConnectionPreview.activateInstance("child-a", id), occurrences.U_B);
      await netsRow(repeated, "FEED_B", 2);
      assert.equal(await repeated.evaluate(() => AtriumNetsPanel.rows().some(r => r.name === "FEED_A")), false);
    }
  } finally { await repeated.close(); }
  const global = await openNavigator(browser, fixture({global:true}), "child-b");
  try {
    await global.evaluate(() => AtriumNavHost.openSplit("right", "child-a"));
    await global.getByRole("group", {name:"On click"}).getByRole("button", {name:"Select", exact:true}).click();
    const joined = await choose(global, "SENSE");
    check(["sense-label-a", "sense-label-b"].every(id => joined.lit.includes(id)), JSON.stringify(joined));
    if (observe) console.log(JSON.stringify({joined}));
  } finally { await global.close(); }
  if (!observe) console.log("PASS Nets and Navigator compiled membership, exact highlight, sheet instances, typed query, export and ERC in Chrome");
}

module.exports = run;
if (require.main === module) {
  (async () => {
    const browser = await chromium.launch({...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"}),
      args:["--allow-file-access-from-files"]});
    try { await run(browser, {observe:process.argv.includes("--observe")}); } finally { await browser.close(); }
  })().catch(error => {console.error(error); process.exitCode = 1;});
}
