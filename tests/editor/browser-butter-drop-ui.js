"use strict";
// Walks the butter.drop target language and transfer status with real Chromium file drops:
// ready and over on the canvas pane, a denied target with its reason, reading with Cancel,
// cancellation, completion, a mixed offer, approval before a STEP model changes a shared footprint,
// and the arrow cursor on chrome drag sources.
// node tests/editor/browser-butter-drop-ui.js [--shots OUTPUT_DIRECTORY]
const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs"), os = require("node:os");
const {boot, run} = require("../support/butter-design.cjs");
const fixtures = path.join(__dirname, "../fixtures/butter-acceptance/drop");
const notes = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "drop-ui-")), "notes.txt");
fs.writeFileSync(notes, "Not a design file.\n");

run("drop", async ({browser, profile, shot}) => {
  const {page, errors} = await boot(browser, profile, {"butter.drop":true, "labs.notebook":true});
  const client = await page.context().newCDPSession(page);
  const status = page.locator(".statusbar .drop-status");
  const bar = page.locator(".statusbar");
  // The whole window at CSS scale: the pane's target face and the status line together.
  const shotArea = name => shot({page:() => page, screenshot:o => page.screenshot({...o, scale:"css"})}, name);
  try {
    await page.evaluate(async () => {
      const H = AtriumNavHost;
      await H.selectDocument(H.project().documents.find(doc => doc.kind === "schematic").id);
      await AtriumLazy.need("AtriumSheetWidgets");
      const table = AtriumSheetWidgets.make("table", [-12, -10]);
      H.edit(() => H.doc().items.push(table), "Create the receiving table", [table]);
      H.act("fit-document");
      window.dropUI = {id:table.id};
      await AtriumLazy.need("AtriumDropEditor");
      await AtriumLazy.need("AtriumDropUI");
      await AtriumLazy.need("AtriumUIKit");
    });
    const dropPoint = async kind => (await page.waitForFunction(kind => {
      const H = AtriumNavHost, c = H.canvas(), b = c.getBoundingClientRect(), doc = H.doc();
      if (doc.kind !== (kind === "table" ? "schematic" : "pcb") || globalThis.AtriumMotion?.active()) return;
      const table = doc.items.find(item => item.id === dropUI.id);
      const targets = kind === "table" ? [[12, 8], [10, 2], [1, 1], [28, 15]]
        .map(([x,y]) => ({id:table.id,x:table.x+x,y:table.y+y})) :
        doc.items.filter(item => item.kind === "part" && H.defs().get(item.def)?.footprint);
      for (const item of targets) {
        const [x,y] = H.view().worldToScreen([item.x,item.y]).map((pixel,axis) => pixel+(axis ? b.top : b.left));
        if (document.elementFromPoint(x,y) === c && H.hit(c,x,y)?.item?.id === item.id) return {x,y,name:item.ref};
      }
    },kind)).jsonValue();
    const offTable = async () => (await page.evaluate(() => { const b = AtriumNavHost.canvas().getBoundingClientRect(); return {x:b.left + 24, y:b.top + 24}; }));
    const drag = async (type, at, files) => client.send("Input.dispatchDragEvent", {type, ...at, data:{items:[], files, dragOperationsMask:1}});
    const csv = path.join(fixtures, "input.csv");
    const rows = () => page.evaluate(() => { const s = AtriumNavHost.doc().items.find(i => i.id === dropUI.id).widget.state; return s.rows.filter(r => Object.keys(r).length > 1).length; });

    // Ready and over: the pane under the pointer takes the library target face; the status says what happens.
    let at = await dropPoint("table");
    await drag("dragEnter", at, [csv]);
    await drag("dragOver", at, [csv]);
    await page.locator("#editor-panes .split-pane[data-drop=over]").waitFor();
    await status.getByText("Drop to add rows to", {exact:false}).waitFor();
    await shotArea("over-table");
    // Denied: off the table, a CSV has nowhere to go. The reason is in the status line.
    const off = await offTable();
    await drag("dragOver", off, [csv]);
    await page.locator("#editor-panes .split-pane[data-drop=denied]").waitFor();
    await status.getByText("CSV files go into a schematic table").waitFor();
    assert.equal(await status.getAttribute("data-tone"), "warning");
    await shotArea("denied");
    await drag("dragOver", at, [csv]);
    await drag("drop", at, [csv]);
    await status.getByText(/^Imported input\.csv into/).waitFor();
    assert.equal(await page.locator("#editor-panes .split-pane[data-drop]").count(), 0);
    assert.equal(await rows(), 2);
    await shot(bar, "complete");

    // Reading holds while the stream stalls; Cancel (or Escape) ends it.
    await page.evaluate(() => {
      const read = File.prototype.stream;
      File.prototype.stream = function () {
        if (this.name !== "input.csv" || !dropUI.stall) return read.call(this);
        return new ReadableStream({cancel() { dropUI.cancelled = true; }});
      };
      dropUI.stall = true;
    });
    at = await dropPoint("table");
    await drag("dragEnter", at, [csv]);
    await drag("dragOver", at, [csv]);
    await drag("drop", at, [csv]);
    await status.getByText(/^Reading input\.csv/).waitFor();
    await status.locator(".ui-progress[data-indeterminate]").waitFor();
    await page.locator("#editor-panes .split-pane[data-drop=busy]").waitFor();
    await shotArea("reading");
    await status.getByRole("button", {name:"Cancel"}).click();
    await status.getByText("Drop cancelled").waitFor();
    assert.equal(await page.evaluate(() => dropUI.cancelled), true);
    await shot(bar, "cancelled");
    // Stale: an edit while reading abandons the drop.
    await drag("dragEnter", at, [csv]);
    await drag("dragOver", at, [csv]);
    await drag("drop", at, [csv]);
    await status.getByText(/^Reading/).waitFor();
    await page.evaluate(() => AtriumNavHost.edit(() => { AtriumNavHost.doc().name += " "; }, "Rename"));
    await status.getByText(/cancelled|changed/).waitFor();
    await shot(bar, "stale");
    await page.evaluate(() => { dropUI.stall = false; });

    // Mixed: one usable file and one the app cannot take.
    await drag("dragEnter", at, [csv, notes]);
    await drag("dragOver", at, [csv, notes]);
    await drag("drop", at, [csv, notes]);
    await status.getByText("1 of 2 files accepted · 1 not supported (notes.txt)").waitFor();
    await shot(bar, "mixed");

    // Approval first: a STEP model replaces a footprint other parts share.
    await page.evaluate(async () => {
      const H = AtriumNavHost;
      await H.selectDocument(H.project().documents.find(doc => doc.kind === "pcb").id);
      H.act("fit-document");
    });
    const part = await dropPoint("part");
    const step = path.join(fixtures, "body.step");
    await drag("dragEnter", part, [step]);
    await drag("dragOver", part, [step]);
    await status.getByText("Drop a STEP model to attach it to " + part.name).waitFor();
    await drag("drop", part, [step]);
    const consent = page.getByRole("dialog", {name:"Approve drop"});
    await consent.getByText(/^body\.step/).waitFor();
    await shot(consent, "consent");
    await consent.getByRole("button", {name:"Cancel"}).click();
    await status.getByText("Drop cancelled").waitFor();

    // Chrome drag sources keep the arrow cursor.
    const cursors = await page.evaluate(() => [...document.querySelectorAll(".document-tab, .ui-drag-handle, .lib-row, .clip-row")]
      .map(n => getComputedStyle(n).cursor).filter(c => /grab/.test(c)));
    assert.deepEqual(cursors, []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}).then(() => console.log("PASS butter drop UI"), error => { console.error(error); process.exit(1); });
