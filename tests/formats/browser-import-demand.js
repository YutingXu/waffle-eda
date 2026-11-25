"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {openProjectZIP,saveFirstProjectZIP,readProjectZIP} = require("../support/browser-native-project.cjs");
require("../../app/formats/sexpr.js");
require("../../app/project/source-file.js");

async function nativeTrackCopy(page, original) {
  const before = await fs.readFile(original), index = 131;
  await page.locator('#document-tabs [data-kind="pcb"]').first().click();
  await page.evaluate(() => AtriumLazy.need("AtriumPolygonPour"));
  const sourceRules = await page.evaluate(() => AtriumImportReports.sourceDocument(AtriumNavHost.doc()).sourceRules);
  const target = await page.evaluate(index => {
    const h = AtriumNavHost, doc = h.doc(), rect = h.canvas().getBoundingClientRect();
    const raw = AtriumImportReports.recent(doc.id).provenance.fields.find(f => f.type === "item" && f.values.sourceRecord === "tracks6/data#" + index);
    const track = doc.items.find(i => i.id === raw?.id);
    const [a, b] = track.points, point = a.map((v, n) => (v + b[n]) / 2);
    return {id: track.id, at: h.view().worldToScreen(point).map((v, n) => v + [rect.x, rect.y][n])};
  }, index);
  await page.mouse.click(...target.at);
  await page.waitForFunction(id => AtriumNavHost.selection().includes(id), target.id);
  await page.locator('[data-dock-tab="properties"]').click();
  const width = page.getByLabel("Width (mm)", {exact: true});
  await width.fill("0.1778");
  await width.press("Tab");
  await page.waitForFunction(() => {
    const drawing = AtriumNavHost.doc().pcbDrawing;
    return drawing?.pours?.some(r => !r.source && drawing.pourSignatures?.[r.polygon]);
  });

  async function reviewCopy(target=page) {
    await target.locator('details[data-menu="file"] > summary').click();
    await target.locator("#sub-file-export > .submenu-trigger").hover();
    await target.locator('[data-action="export"]').click();
    const dialog = target.getByRole("dialog", {name: "Export Design", exact: true});
    await dialog.getByLabel("Format", {exact: true}).selectOption("altium");
    const source = target.waitForEvent("filechooser");
    await dialog.getByRole("button", {name: "Choose original…", exact: true}).click();
    await (await source).setFiles(original);
    return dialog;
  }
  const dialog = await reviewCopy();
  await dialog.getByText("width · tracks6/data#" + index, {exact: true}).waitFor();
  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", {name: "Export", exact: true}).click();
  const download = await downloading;
  assert.equal(await download.failure(), null);
  const copy = AtriumSourceFile.open(await fs.readFile(await download.path())), source = AtriumSourceFile.open(before);
  assert.deepEqual(copy.paths(), source.paths());
  const tracks = source.paths().find(name => name.toLowerCase() === "tracks6/data");
  const expected = Buffer.from(source.read(tracks));
  let pos = 0;
  for (let row = 0; row < index; row++) pos += 5 + (expected.readUInt32LE(pos + 1) & 0xffffff);
  assert.equal(expected.readInt32LE(pos + 5 + 29), 60000);
  expected.writeInt32LE(70000, pos + 5 + 29);
  for (const name of source.paths()) {
    assert.deepEqual(Buffer.from(copy.read(name)), name === tracks ? expected : Buffer.from(source.read(name)), name);
  }
  assert.deepEqual(await fs.readFile(original), before);

  const saved=await saveFirstProjectZIP(page);
  const snapshot=await readProjectZIP(saved.buffer), originalHash=AtriumFormat2.sha256(before);
  assert.deepEqual(Buffer.from(snapshot.files.get(".waffle/imports/"+originalHash+"/source")),before);
  const reopened=await page.context().browser().newPage();
  try {
    await reopened.goto(page.url());
    await openProjectZIP(reopened,saved);
    await reopened.waitForFunction(name=>AtriumNavHost.project().name===name && AtriumNavHost.folderProject()?.temporary,snapshot.manifest.header.name);
    await reopened.locator('#document-tabs [data-kind="pcb"]').first().click();
    const retained=await reopened.evaluate(async()=>{
      const h=AtriumNavHost, folder=h.folderProject(), pcb=h.doc();
      await folder.ensureImportReports();
      return {rules:AtriumImportReports.sourceDocument(pcb).sourceRules,clean:!("sourceRules" in pcb),
        foreignLinker:!!globalThis.AtriumImportLink};
    });
    assert.deepEqual(retained,{rules:sourceRules,clean:true,foreignLinker:false});
    const next=await reviewCopy(reopened);
    await next.getByText("width · tracks6/data#"+index,{exact:true}).waitFor();
    const copying=reopened.waitForEvent("download");
    await next.getByRole("button",{name:"Export",exact:true}).click();
    assert.deepEqual(await fs.readFile(await (await copying).path()),await fs.readFile(await download.path()));
    await reopened.locator('details[data-menu="design"] > summary').click();
    await reopened.locator('[data-action="rules"]').click();
    const rules=reopened.locator(".rules-window"), chooser=reopened.waitForEvent("filechooser");
    const beforeRuleImport=await reopened.evaluate(()=>[AtriumNavHost.revision(),AtriumNavHost.project().rules]);
    await rules.getByRole("button",{name:"Import rules",exact:true}).click();
    await (await chooser).setFiles({name:"Invalid.RUL",mimeType:"application/octet-stream",buffer:Buffer.from("NAME=Missing rule kind")});
    await rules.getByText("Invalid Altium rule records.",{exact:true}).waitFor();
    assert.deepEqual(await reopened.evaluate(()=>[AtriumNavHost.revision(),AtriumNavHost.project().rules]),beforeRuleImport);
    await rules.getByRole("button",{name:"Close",exact:true}).click();
    console.log("PASS edited source-backed copper survives first Save, verified Format 2 reopen and a second native source export");
  } finally { await reopened.close(); }

  await page.evaluate(() => {
    const h = AtriumNavHost, polygon = h.doc().items.find(i => i.kind === "polygon");
    h.edit(() => { polygon.points[0][0] += .2; });
  });
  const changedPour = await reviewCopy();
  await changedPour.getByRole("status").filter({hasText: /Only existing standalone copper tracks/}).waitFor();
  assert.ok(await changedPour.getByRole("button", {name: "Export", exact: true}).isDisabled());
  await changedPour.getByRole("button", {name: "Cancel", exact: true}).click();
  await page.evaluate(() => {
    const h = AtriumNavHost;
    h.historyGo(-1);
    const shape = AtriumBoardShape.fresh(h.doc());
    const points = [[20, -12], [21, -12], [21, -11], [20, -11]];
    h.edit(() => { h.doc().boardShape = {...shape, cutouts: [points.map((a, n) => ({kind: "line", a, b: points[(n + 1) % points.length]}))]}; });
  });
  const changedCutout = await reviewCopy();
  await changedCutout.getByRole("status").filter({hasText: /boardShape field changed/}).waitFor();
  assert.ok(await changedCutout.getByRole("button", {name: "Export", exact: true}).isDisabled());
  await changedCutout.getByRole("button", {name: "Cancel", exact: true}).click();
}

module.exports = async function coldImport(browser) {
  const app = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;
  const fixture = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");
  const page = await browser.newPage(), requests = [], errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => requests.push(request.url().split("/").pop()));
  try {
    await page.goto(app);
    const open = page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Import from Altium or KiCad…", exact:true});
    await open.waitFor();
    assert.ok(await page.evaluate(() => {
      const project = AtriumNavHost.project();
      return Atrium.preferredDocument(project, "schematic")?.kind === "schematic" &&
        Atrium.preferredDocument(project, "pcb")?.kind === "pcb";
    }), "document navigation is ready on Home");
    const optionalFiles = ["altium-rules.js", "import-link.js", "translator-table.js", "translator-registry.js", "import-worker-client.js", "import-reports.js", "worker-source.js"];
    assert.deepEqual(requests.filter(name => optionalFiles.includes(name)), [], "Home leaves foreign import modules cold");
    const chooser = page.waitForEvent("filechooser");
    await open.click();
    await (await chooser).setFiles(["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"].map(name => path.join(fixture, name)));
    await page.waitForFunction(() => document.querySelector(".import-report") && AtriumNavHost.project().name === "PCB-PiDP11IOExpander");
    const imported = await page.evaluate(() => {
      const project = AtriumNavHost.project(), sheet = Atrium.preferredDocument(project, "schematic");
      const board = Atrium.preferredDocument(project, "pcb"), parts = d => d.items.filter(i => i.kind === "part");
      const source = AtriumImportReports.sourceDocument(board);
      const links = new Map(parts(sheet).map(p => [p.ref, p.link]));
      return {
        sheetParts: parts(sheet).length, boardParts: parts(board).length, rules: source.sourceRules.length, clean: !("sourceRules" in board),
        namedRule: source.sourceRules.some(s => /NAME=[^|]+/.test(s)),
        paired: parts(board).filter(p => p.link && p.link === links.get(p.ref)).length
      };
    });
    assert.equal(imported.sheetParts, 23);
    assert.equal(imported.boardParts, 23);
    assert.equal(imported.rules, 41);
    assert.ok(imported.namedRule && imported.clean);
    assert.equal(imported.paired, 23, "the first open links all placed components by reference");
    for (const file of ["import-link.js", "import-worker-client.js", "import-reports.js", "translator-registry.js"]) assert.equal(requests.filter(name => name === file).length, 1, file);
    assert.deepEqual(errors, []);
    console.log("PASS cold Home navigation and first Altium file-picker import with paired components and 41 source rules");

    const sheetId = await page.evaluate(() => AtriumNavHost.project().documents.find(d => d.kind==="schematic").id);
    await page.locator('#document-tabs [data-tab="'+sheetId+'"]').click();
    await page.locator('details[data-menu="file"] > summary').click();
    await page.locator("#sub-file-export > .submenu-trigger").hover();
    await page.locator('[data-action="export"]').click();
    const copy = page.getByRole("dialog", {name:"Export Design"});
    await copy.getByLabel("Format", {exact:true}).selectOption("altium");
    const original = path.join(fixture, "PiDP11IOExpander.SchDoc"), originalBytes = await fs.readFile(original);
    const originalChooser = page.waitForEvent("filechooser");
    await copy.getByRole("button", {name:"Choose original…"}).click();
    await (await originalChooser).setFiles(original);
    await copy.getByText("No native changes. The copy is byte-identical to the original.", {exact:true}).waitFor();
    const copyDownload = page.waitForEvent("download");
    await copy.getByRole("button", {name:"Export",exact:true}).click();
    const copied = await copyDownload;
    assert.notEqual(copied.suggestedFilename().toLowerCase(),path.basename(original).toLowerCase());
    assert.deepEqual(await fs.readFile(await copied.path()), originalBytes);
    assert.deepEqual(await fs.readFile(original), originalBytes);
    console.log("PASS the normal Export Design review writes a separately named, byte-identical binary Altium source copy");

    await page.locator('details[data-menu="file"] > summary').click();
    await page.locator("#sub-file-export > .submenu-trigger").hover();
    await page.locator('[data-action="export-altium"]').click();
    const exportDialog = page.getByRole("dialog", {name: "Export Altium Project (ASCII)"});
    await exportDialog.getByText("8 STEP companion files", {exact: true}).waitFor();
    await exportDialog.locator("p").filter({hasText: "choose Embed Model"}).filter({hasText: "Altium source copy"}).waitFor();
    await exportDialog.getByRole("button", {name: "Export Altium source copy…"}).click();
    const nativeDialog = page.getByRole("dialog", {name: "Export Design", exact: true});
    await nativeDialog.getByRole("button", {name: "Choose original…"}).waitFor();
    const pcbId = await page.evaluate(() => AtriumNavHost.project().documents.find(d => AtriumImportReports.sourceDocument(d).sourceName === "PiDP11IOExpander.PcbDoc").id);
    assert.equal(await nativeDialog.getByLabel("Document").inputValue(), pcbId);
    assert.equal(await nativeDialog.getByLabel("Format").inputValue(), "altium");
    const pcbOriginal = path.join(fixture,"PiDP11IOExpander.PcbDoc"), choosingPCB = page.waitForEvent("filechooser");
    await nativeDialog.getByRole("button",{name:"Choose original…"}).click();
    await (await choosingPCB).setFiles(pcbOriginal);
    await nativeDialog.getByText("No native changes. The copy is byte-identical to the original.",{exact:true}).waitFor();
    const nativePCBDownload = page.waitForEvent("download");
    await nativeDialog.getByRole("button",{name:"Export",exact:true}).click();
    const binaryPCB=await nativePCBDownload;
    assert.notEqual(binaryPCB.suggestedFilename().toLowerCase(),path.basename(pcbOriginal).toLowerCase());
    assert.deepEqual(await fs.readFile(await binaryPCB.path()), await fs.readFile(pcbOriginal));
    await page.locator('details[data-menu="file"] > summary').click();
    await page.locator("#sub-file-export > .submenu-trigger").hover();
    await page.locator('[data-action="export-altium"]').click();
    const downloading = page.waitForEvent("download");
    await exportDialog.getByRole("button", {name: "Export…", exact: true}).click();
    const download = await downloading;
    assert.equal(await download.failure(), null);
    const archive = AtriumImportFormats.unzip(await fs.readFile(await download.path()));
    const stepFiles = [...archive.keys()].filter(name => /\.(?:stp|step)$/i.test(name));
    assert.equal(stepFiles.length, 8);
    for (const name of stepFiles) assert.match(Buffer.from(archive.get(name)).toString("ascii", 0, 16), /^ISO-10303-21;/);
    for (const name of ["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"]) {
      assert.ok(archive.get("PCB-PiDP11IOExpander/" + name)?.byteLength, name);
    }
    await nativeTrackCopy(page, path.join(fixture, "PiDP11IOExpander.PcbDoc"));
    assert.deepEqual(errors, []);
    console.log("PASS Altium preview lists the binary source-copy route and downloads the design documents with eight STEP companion files");
    console.log("PASS Altium source copy preserves native streams after live repour and refuses authored pour and board cutout edits");
  } finally {
    await page.close();
  }
};
