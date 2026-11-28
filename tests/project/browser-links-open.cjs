"use strict";
// Opening a link: every opener (the palette's Open link row, Open Waffle Link… and a stored link in
// Properties) gives the same result. A datasheet page link keeps its page, brings a Datasheet tab that
// sits behind Properties to the front, and a reader without a size goes to the page once it has one.
// A saved query opens in Query from the palette row as it does from Open Waffle Link….
// node tests/project/browser-links-open.cjs
const assert = require("node:assert/strict");
const H = require("../automation/butter-intel-ui-shared.cjs");
const {fixture} = require("../support/datasheet-pdf.cjs");

async function walk(browser, profile) {
  const {page, errors} = await H.openDemo(browser, profile, ["query"]);
  page.setDefaultTimeout(10000);
  const links = page.locator("#inspector .intel-links");
  const reader = page.locator(".panel-datasheet");
  const position = reader.locator(".docs-foot .ui-pager-position");
  const shown = () => page.evaluate(() => {
    const panel = document.querySelector(".panel-datasheet"), pages = panel?.querySelector(".docs-pages");
    return !!panel && !panel.hidden && panel.getClientRects().length > 0 && pages.clientHeight > 0;
  });
  // The reader has drawn the page it reports and nothing moves it afterwards.
  const settled = async () => {
    await page.waitForFunction(() => AtriumDatasheetReader.current()?.pages > 0 &&
      document.querySelector(".panel-datasheet .docs-pages img"));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return page.evaluate(() => AtriumDatasheetReader.current().page);
  };
  const palette = url => page.evaluate(url => AtriumIntelUI.paletteRows(url).find(row => row.label === "Open link").run(), url);
  try {
    await page.evaluate(() => AtriumPrefs.set("butter.datasheets", true));
    const pdf = [...fixture(6)];
    const {source, sheet, projectId} = await page.evaluate(async pdf => {
      const D = await AtriumLazy.need("AtriumDatasheets");
      const ref = await D.referenceBytes({bytes:new Uint8Array(pdf), name:"LMV321 datasheet.pdf"});
      const track = AtriumNavHost.doc().items.find(i => i.kind === "track" && AtriumLinkRecord.id(i.id));
      return {source:track.id, sheet:ref.id, projectId:AtriumNavHost.project().id};
    }, pdf);
    const pageLink = n => "waffle://" + projectId + "/" + sheet + "#datasheet:page=" + n;

    // The palette row opens page 3.
    await palette(pageLink(3));
    assert.equal(await settled(), 3, "the palette row opens the linked page");

    // A stored link to page 3 opens page 3 from Properties, as the palette row does.
    await page.evaluate(async ({source, url}) => {
      await AtriumButterEditor.apply("butter.links.create", {sourceId:source, url, label:"Pinout page"});
      AtriumDatasheetReader.close();
      AtriumDock.reveal("properties");
      AtriumNavHost.select([source], source);
    }, {source, url:pageLink(3)});
    await links.locator(".ui-row", {hasText:"Pinout page"}).click();
    assert.equal(await settled(), 3, "the stored link keeps its page");
    await position.filter({hasText:"3 of 6"}).waitFor();

    // Datasheet open behind Properties: following a link brings it to the front at the linked page.
    await page.evaluate(() => AtriumDock.reveal("properties"));
    await page.waitForFunction(() => document.querySelector(".panel-datasheet").getClientRects().length === 0);
    assert.equal(await shown(), false, "the reader sits behind Properties");
    await palette(pageLink(5));
    assert.equal(await shown(), true, "the Datasheet tab comes to the front");
    assert.equal(await settled(), 5, "the reader opens the linked page, not the last one");
    await position.filter({hasText:"5 of 6"}).waitFor();

    // A reader with no size goes to the page once it has a layout.
    await page.evaluate(() => { document.querySelector(".panel-datasheet .docs-pages").style.display = "none"; });
    await palette(pageLink(2));
    await page.waitForFunction(() => AtriumDatasheetReader.current()?.pages > 0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => AtriumDatasheetReader.current().page), 2, "no page is chosen from a zero-size view");
    await page.evaluate(() => { document.querySelector(".panel-datasheet .docs-pages").style.display = ""; });
    assert.equal(await settled(), 2, "the reader goes to the page once it has a size");
    await position.filter({hasText:"2 of 6"}).waitFor();
    assert.ok(await page.evaluate(() => {
      const pages = document.querySelector(".panel-datasheet .docs-pages").getBoundingClientRect();
      const two = document.querySelector('.panel-datasheet .docs-page[data-page="2"]').getBoundingClientRect();
      return Math.abs(two.top - pages.top) < 40;
    }), "page 2 is at the top of the view");

    // A saved query opens in Query from the palette row, as from Open Waffle Link….
    const query = "resistor where value < 100 kΩ";
    const queryLink = await page.evaluate(async source => {
      const record = (await AtriumButterEditor.apply("butter.query.save-query", {name:"Low resistors", source})).result.record;
      return AtriumLinks.format({projectId:AtriumNavHost.project().id, objectId:record.id});
    }, query);
    const queryShown = () => page.evaluate(() => {
      const panel = document.querySelector(".panel-design-query");
      return panel && !panel.hidden && panel.getClientRects().length > 0 ? panel.querySelector("[role=combobox]").value : null;
    });
    await page.evaluate(() => AtriumDock.reveal("properties"));
    await palette(queryLink);
    assert.equal(await queryShown(), query, "the palette row shows the saved query");
    await page.evaluate(async () => { await AtriumIntelUI.open("query", {source:""}); AtriumDock.reveal("properties"); });
    await page.evaluate(() => AtriumKeymap.command("assist.open-link").run());
    const dialog = page.locator("dialog[open]");
    await dialog.getByLabel("Waffle link").fill(queryLink);
    await dialog.getByRole("button", {name:"Open"}).click();
    await page.waitForFunction(query => document.querySelector(".panel-design-query [role=combobox]")?.value === query, query);
    assert.equal(await queryShown(), query, "Open Waffle Link… shows the saved query");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

H.runWalk(walk, "SKIP Links open walk: Playwright Core unavailable.", "PASS Links open: palette, Open Waffle Link… and Properties keep the page, reveal a Datasheet tab behind Properties, wait for the reader's size and show a saved query.");
