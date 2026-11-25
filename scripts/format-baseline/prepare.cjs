"use strict";
// Prepare a native snapshot through the shipping editor's foreign-file open and canonical writer.
// The browser profile, input buffers and resulting snapshot all live outside the checkout.
const fs = require("node:fs/promises");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const assert = require("node:assert/strict");
const {chromium} = require("playwright-core");
const root = path.resolve(__dirname, "../..");

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const {files, synthetic} = JSON.parse(Buffer.concat(chunks));
  const browser = await chromium.launch({headless: true, ...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: "chrome"})});
  try {
    const page = await browser.newPage({viewport: {width: 1380, height: 860}});
    // The file URL matches the shipping editor. Reject external requests even when preparing public inputs.
    await page.route(/^https?:/, route => route.abort());
    await page.goto(pathToFileURL(path.join(root, "app/index.html")).href);
    await page.getByRole("button", {name: "Continue to editor"}).click();
    if (synthetic) await page.addScriptTag({path: path.join(root, "tests/pcb/dense-board.js")});
    const {native, documents, items, version} = await page.evaluate(async ({files, synthetic}) => {
      const h = AtriumNavHost;
      let p;
      if (synthetic) {
        const fixture = makeAtriumBenchmarkBoard(160);
        fixture.d.id = "dense-board";
        p = Atrium.project("Dense signal board", [fixture.defs.get("std-r")]);
        const sheet = p.documents[0];
        sheet.id = "control-sheet";
        sheet.items = [{id: "wire-1", kind: "wire", points: [[0, 0], [12.7, 0]]},
          {id: "label-1", kind: "netlabel", x: 0, y: 0, text: "SENSE"}];
        p.documents = [fixture.d, sheet];
        if (fixture.d.items.length !== 25600) throw Error("Unexpected workload size");
        await AtriumLazy.need(AtriumLazy.validatorsFor(p));
        Atrium.validate(p);
      } else {
        const selected = files.map(({name, bytes}) => new File([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], name));
        const before = h.project();
        await h.openFiles(selected);
        p = h.project();
        const names = selected.filter(f => /\.(schdoc|pcbdoc|kicad_sch|kicad_pcb)$/i.test(f.name)).map(f => f.name).sort();
        const sourceName = d => (globalThis.AtriumImportReports?.sourceDocument(d) || d).sourceName;
        const opened = p.documents.map(d => ({name: sourceName(d), items: d.items})).filter(d => d.name);
        if (p === before || !names.length || JSON.stringify(opened.map(d => d.name).sort()) !== JSON.stringify(names) ||
            opened.some(d => !d.items.length)) throw Error("The selected drawings did not all open");
      }
      const writer = await AtriumIO.serializer();
      return {native: writer.serialize(p), documents: p.documents.length, items: p.documents.map(d => d.items.length), version: p.formatVersion};
    }, {files, synthetic});
    assert.equal(version, "1.5");
    assert.equal(documents, items.length);
    await fs.writeFile(process.argv[2], native, {mode: 0o600, flag: "wx"});
    console.log(JSON.stringify({documents, items, version}));
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
