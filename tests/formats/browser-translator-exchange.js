"use strict";

const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const {pathToFileURL} = require("node:url");

module.exports = async function exchange(browser, {url = pathToFileURL(path.join(__dirname,"../../app/index.html")).href} = {}) {
  const context = await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(15000);
  page.on("pageerror", e => errors.push(e.message));
  try {
    await page.addInitScript(() => {
      window.exchangeRequests = [];
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function(message,...args) {
        if (message?.operation?.startsWith("translate-")) window.exchangeRequests.push([message.operation,message.translator || message.options?.translator || "auto"]);
        return send.call(this,message,...args);
      };
    });
    await page.goto(url);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => globalThis.AtriumNavHost?.doc()?.kind === "pcb");
    const boardId = await page.evaluate(() => AtriumNavHost.currentId());
    // A first visit to Dimensions uses only the eager geometry. Defining an outline
    // loads its constructor once. The DXF adapter must load it independently in its worker.
    await page.evaluate(() => AtriumNavHost.act("board-dimensions"));
    const outlineDialog = page.getByRole("dialog",{name:"Board Shape"});
    await outlineDialog.getByRole("tab",{name:"Dimensions & Corners"}).waitFor();
    assert.equal(await page.evaluate(()=>!!globalThis.AtriumBoardShapeSources),false);
    await outlineDialog.getByRole("tab",{name:"Define from Selection"}).click();
    await outlineDialog.getByRole("button",{name:"Define Board Shape"}).waitFor();
    assert.equal(await page.evaluate(()=>typeof AtriumBoardShapeSources.fromSegments),"function");
    await outlineDialog.getByRole("button",{name:"Close",exact:true}).click();
    const area=await page.evaluate(async()=>{
      const pairs=[0,"SECTION",2,"ENTITIES"], points=[[0,0],[12,0],[12,6],[0,6]];
      points.forEach(([x,y],i)=>{const [a,b]=points[(i+1)%points.length];pairs.push(0,"LINE",8,"EDGE",10,x,20,y,11,a,21,b);});
      pairs.push(0,"ENDSEC",0,"EOF");
      const drawing={name:"rectangle.dxf",bytes:new TextEncoder().encode(pairs.join("\n")+"\n")}, client=await AtriumLazy.need("AtriumTranslatorClient");
      const out=await client.import([drawing],{translator:"dxf",mode:"outline",mm:1});
      return AtriumBoardShape.area(out.model.documents[0].boardShape);
    });
    assert.equal(area,72);
    assert.equal(await page.evaluate(()=>window.exchangeRequests.filter(([type,id])=>type==="translate-import"&&id==="dxf").length),1);
    await page.evaluate(()=>{window.exchangeRequests.length=0;});
    const action = async (menu,sub,id) => {
      await page.locator('details[data-menu="' + menu + '"] > summary').click();
      await page.locator("#sub-" + menu + "-" + sub + " > .submenu-trigger").hover();
      await page.locator('[data-action="' + id + '"]:visible').click();
    };
    const downloaded = page.waitForEvent("download");
    await action("file","export","export-netlist-kicad");
    const netFile = await downloaded;
    assert.ok(netFile.suggestedFilename().endsWith(".net"));
    const actual = await fs.readFile(await netFile.path(),"utf8");
    assert.ok(actual.startsWith("(export")); assert.match(actual,/\(node \(ref "/);

    const raw = await page.evaluate(() => {
      const def = Atrium.clone(AtriumNavHost.project().library.find(d => d.symbol && d.footprint));
      def.source = {kind:"kicad-symbol",attribution:{author:"Fixture contributors",licence:"CC0"}};
      return {format:"atrium-library",version:1,id:"translator-portable",name:"Portable test library",description:"Fixture",defs:[def]};
    });
    await action("design","library","library-sources");
    const dialog = page.getByRole("dialog",{name:"Library sources",exact:true});
    const picked = page.waitForEvent("filechooser");
    await dialog.getByRole("button",{name:"Open library file…",exact:true}).click();
    await (await picked).setFiles({name:"Portable.atrlib",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(raw))});
    const row = dialog.getByRole("row").filter({hasText:raw.name});
    await row.waitFor();
    const saved = page.waitForEvent("download");
    await row.getByRole("button",{name:"Save…",exact:true}).click();
    const library = await saved;
    assert.equal(library.suggestedFilename(),"Portable.atrlib");
    assert.deepEqual(JSON.parse(await fs.readFile(await library.path(),"utf8")),raw);
    await page.waitForFunction(() => document.querySelector('.doc-view article')?.textContent?.includes('Portable.atrlib') || document.querySelector('.import-report')?.textContent?.includes('Portable.atrlib'));
    assert.equal(await page.evaluate(id => {
      const groups = AtriumImportReports.provenance();
      const projected = AtriumTranslatorProvenance.toLegacy(AtriumNavHost.project(),groups).library.find(d => d.id === id);
      return !!projected && !groups.some(g => g.portableLibrary?.id === "translator-portable") && projected.source?.attribution?.author !== "Fixture contributors";
    },raw.defs[0].id),true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({state:"hidden"});

    const [choosing] = await Promise.all([page.waitForEvent("filechooser"),action("file","import","import-netlist")]);
    await choosing.setFiles({name:"Unique.csv",mimeType:"text/csv",buffer:Buffer.from("Net,Designator,Pin,Pin Name\nTRANSLATOR_NET,ZX990,1,Out\nTRANSLATOR_NET,ZX991,1,In\n")});
    await page.waitForFunction(() => AtriumNavHost.project().documents.some(d => d.items.some(i => i.ref === "ZX990")));
    await page.waitForFunction(() => {
      const sheet = AtriumNavHost.project().documents.find(d => d.items.some(i => i.ref === "ZX990"));
      return globalThis.AtriumImportReports?.recent(sheet?.id)?.names?.includes("Unique.csv");
    });
    await page.getByRole("dialog",{name:"Engineering change order"}).waitFor();
    const summary = await page.evaluate(() => {
      const p = AtriumNavHost.project(), d = p.documents.find(d => d.items.some(i => i.ref === "ZX990"));
      const result = AtriumImportReports.recent(d.id);
      return {refs:d.items.filter(i => i.kind === "part").map(i => i.ref).sort(),labels:d.items.filter(i => i.kind === "netlabel").map(i => i.text),
        pins:result.report.kinds.find(k => k.kind === "Pin connection")?.kept,requests:window.exchangeRequests};
    });
    assert.deepEqual(summary.refs,["ZX990","ZX991"]); assert.deepEqual(summary.labels,["TRANSLATOR_NET","TRANSLATOR_NET"]);
    assert.equal(summary.pins,2);
    for (const [op,id] of [["translate-export","netlist-kicad"],["translate-import","waffle-library"],["translate-export","waffle-library"]]) {
      assert.ok(summary.requests.some(([type,translator]) => type === op && translator === id),op+" "+id);
    }
    assert.ok(summary.requests.filter(([type])=>type==="translate-import").length >= 2);
    await page.getByRole("dialog", {name: "Engineering change order"}).getByRole("button", {name: "Close", exact: true}).click();
    await page.locator('#document-tabs [data-tab="' + boardId + '"]').click();

    const layerGraphics = () => page.evaluate(() => AtriumNavHost.doc().items.filter(i => i.kind === "graphic" && i.layer === "Mechanical 7").length);
    const before = await layerGraphics();
    await action("file", "import", "import-dxf");
    const shape = page.getByRole("dialog", {name: "Board Shape"});
    const [drawing] = await Promise.all([page.waitForEvent("filechooser"), shape.getByRole("button", {name: "Choose DXF file…"}).click()]);
    const line = "0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nOUTLINE\n10\n0\n20\n0\n11\n20\n21\n8\n0\nENDSEC\n0\nEOF\n";
    await drawing.setFiles({name: "Bracket.dxf", mimeType: "application/dxf", buffer: Buffer.from(line)});
    await shape.getByLabel("Import as", {exact: true}).selectOption("graphics");
    await shape.getByLabel("Layer", {exact: true}).selectOption("Mechanical 7");
    await shape.getByRole("button", {name: "Import", exact: true}).click();
    await page.waitForFunction(id => globalThis.AtriumImportReports?.recent(id)?.names.includes("Bracket.dxf"), boardId);
    assert.equal(await layerGraphics(), before + 1);
    assert.equal(await page.evaluate(id => AtriumImportReports.recent(id).report.kinds.find(k => k.kind === "DXF LINE")?.kept, boardId), 1);
    assert.equal(await page.evaluate(() => window.exchangeRequests.filter(([op, id]) => op === "translate-import" && id === "dxf").length), 2);
    assert.deepEqual(errors,[]);
    console.log("PASS browser translator exchange: DXF graphic on the selected board layer, menu netlist, attributed portable library, isolated imports and ECO sheet.");
  } finally { await context.close(); }
};
