"use strict";

const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {readProjectZIP} = require("../support/browser-native-project.cjs");
for (const name of ["netlist", "mcad-xml", "mcad", "mcad-idx", "mcad-idf"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));

const sortRows = rows => rows.map(row => JSON.stringify(row)).sort();
const coordinates = parts => sortRows(parts.map(p => [p.ref, Math.round(p.x*1e4), Math.round(p.y*1e4)]));
const pageOptions = {viewport:{width:1440,height:1000},reducedMotion:"reduce",acceptDownloads:true};
async function menu(page, label, submenu = false) {
  const file = page.locator('details[data-menu="file"]');
  await file.locator(":scope > summary").click();
  if (submenu) await file.getByRole("menuitem",{name:"Export",exact:true}).hover();
  await file.getByRole("menuitem",{name:label,exact:true}).click();
}
function bounds(outline) {
  return [0,1].flatMap(axis => {
    const values = outline.map(point => Math.round(point[axis]*1e4)+0);
    return [Math.min(...values), Math.max(...values)];
  });
}

module.exports = async function menuDownloads(browser, {
  url = pathToFileURL(path.join(__dirname,"../../app/index.html")).href, checkBlank = true
} = {}) {
  const page = await browser.newPage(pageOptions);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  try {
    await page.goto(url);
    await page.getByRole("button",{name:"Try the Demo",exact:true}).click();
    await page.getByRole("tab",{name:"Sensor board",exact:true}).click();
    const board = await page.evaluate(() => {
      const {name,items,outline} = AtriumNavHost.doc();
      const parts = items.filter(item => item.kind === "part").map(({ref,x,y,pinNets}) => ({ref,x,y,pinNets}));
      return {name,parts,outline};
    });
    assert.ok(board.parts.length);
    const refs = board.parts.map(p => p.ref).sort();
    const pins = sortRows(board.parts.flatMap(p => Object.entries(p.pinNets || {})
      .filter(([, net]) => net).map(([pin, net]) => [net,p.ref,pin])));
    assert.ok(pins.length);

    async function capture(action, ...suffixes) {
      const events = suffixes.map(suffix => page.waitForEvent("download",{
        predicate: download => download.suggestedFilename().endsWith(suffix),timeout:15000
      }));
      const [, ...downloads] = await Promise.all([action(), ...events]);
      return Promise.all(downloads.map(async download => {
        assert.equal(await download.failure(),null);
        const bytes=await fs.readFile(await download.path()), name=download.suggestedFilename();
        assert.ok(bytes.length,name);
        return {name,bytes,sha256:createHash("sha256").update(bytes).digest("hex")};
      }));
    }
    const evidence = [];
    for (const [format,label,suffix] of [["kicad","KiCad Netlist…",".net"],
      ["protel","Protel Netlist…","-protel.net"],["csv","Netlist CSV…",".csv"]]) {
      const [actual] = await capture(() => menu(page,label,true),suffix);
      const parsed = AtriumNetlist.parse(actual.bytes.toString("utf8"));
      assert.equal(parsed.format,format);
      assert.deepEqual(parsed.issues,[]);
      assert.deepEqual(sortRows(parsed.nets.flatMap(n => n.nodes.map(p => [n.name,p.ref,p.pin]))),pins);
      if (format !== "csv") assert.deepEqual(parsed.components.map(p => p.ref).sort(),refs);
      evidence.push(actual);
    }

    const [idx] = await capture(() => menu(page,"IDX Baseline…",true),"-baseline.idx");
    const baseline = idx.bytes.toString("utf8");
    assert.deepEqual(AtriumIDX.validate(baseline),[]);
    const mechanical = AtriumIDX.read(baseline);
    assert.equal(mechanical.kind,"baseline");
    assert.ok(mechanical.board.outline.length > 2);
    assert.deepEqual(bounds(mechanical.board.outline),bounds(board.outline));
    assert.deepEqual(coordinates(mechanical.parts),coordinates(board.parts));
    await page.waitForFunction(() => !!AtriumNavHost.doc().mcad?.baseline);
    const [emn,emp] = await capture(() => menu(page,"IDF 3.0 (.emn, .emp)…",true),".emn",".emp");
    const library = emp.bytes.toString("utf8");
    assert.match(library,/^\.HEADER\nLIBRARY_FILE 3\.0 /);
    assert.match(library,/\n\.ELECTRICAL\n/);
    const idf = AtriumIDF.read(emn.bytes.toString("utf8"),library);
    assert.ok(idf.board.outline.length > 2);
    assert.deepEqual(bounds(idf.board.outline),bounds(board.outline));
    assert.deepEqual(coordinates(idf.parts),coordinates(board.parts));
    assert.ok(idf.parts.every(p => Number.isFinite(p.height) && p.height >= 0));
    evidence.push(idx,emn,emp);

    await menu(page,"Save as Zip…");
    const save = page.getByRole("dialog",{name:"Save project first",exact:true});
    const [zip] = await capture(() => save.getByRole("button",{name:"Save project…",exact:true}).click(),".zip");
    const zipped = await readProjectZIP(zip.bytes);
    assert.equal(zipped.manifest.header.formatVersion,"2.0");
    const {members} = AtriumFormat2Model.manifest(zipped.manifest);
    const pcb = members.find(member => member.kind === "pcb");
    assert.ok(pcb);
    assert.ok(members.some(member => member.kind === "schematic"));
    const reopened = AtriumFormat2Model.document(AtriumFormat2Model.parse(zipped.files.get(pcb.path)),{name:pcb.name});
    assert.equal(reopened.name,board.name);
    assert.deepEqual(coordinates(reopened.items.filter(i => i.kind === "part")),coordinates(board.parts));
    evidence.push(zip);
    if (checkBlank) {
      const unexpected = [];
      for (const label of ["IDX Baseline…","IDF 3.0 (.emn, .emp)…"]) {
        const blank = await browser.newPage(pageOptions);
        blank.setDefaultTimeout(10000);
        blank.on("pageerror", error => errors.push(error.message));
        blank.on("download", download => unexpected.push(download.suggestedFilename()));
        try {
          await blank.goto(url);
          await blank.locator("dialog.sp-dialog[open]").getByRole("button",{name:"New Project…",exact:true}).click();
          const dialog = blank.getByRole("dialog",{name:"New project",exact:true});
          const name = "Blank mechanical board";
          await dialog.getByRole("textbox",{name:"New project",exact:true}).fill(name);
          await dialog.getByRole("button",{name:"Apply",exact:true}).click();
          await blank.waitForFunction(name => AtriumNavHost.project().name === name,name);
          await blank.getByRole("tab",{name:"Board layout",exact:true}).click();
          assert.deepEqual(await blank.evaluate(() => {
            const {kind,outline} = AtriumNavHost.doc();
            return {kind,outline};
          }),{kind:"pcb",outline:[]});
          await menu(blank,label,true);
          await blank.locator("#status").filter({hasText:/^Define a closed board outline before exporting to MCAD\.$/}).waitFor();
          assert.equal(await blank.evaluate(() => AtriumNavHost.doc().mcad?.baseline),undefined);
        } finally {
          await blank.close();
        }
      }
      assert.deepEqual(unexpected,[]);
      console.log("PASS outline-less PCB requests explain the missing outline without downloading or recording a baseline");
    }
    assert.deepEqual(errors,[]);
    console.log("PASS real File menu downloads, verified project closure, netlist connections and MCAD placements");
    return evidence.map(({name,bytes,sha256}) => ({name,bytes:bytes.length,sha256}));
  } finally {
    await page.close();
  }
};
