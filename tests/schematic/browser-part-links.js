"use strict";
// Web links in Properties and on the sheet (run by integration-browser.cjs, --links-only):
// a part's URL parameters are listed under Links, on the sheet and on the board (from its linked
// schematic part), and open through the host's external-link opener; a hyperlinked text shows and
// edits its URL and opens it on Cmd/Ctrl+click. Values are made up.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const DATASHEET = "https://example.com/parts/opamp.pdf", VENDOR = "https://vendor.example.net/item?id=7", TEXT_URL = "https://example.org/notes";

module.exports = async function partLinks(browser) {
  const page = await browser.newPage({viewport: {width: 1280, height: 860}}), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => !!globalThis.AtriumNavHost && AtriumNavHost.doc().kind === "pcb");
    // The host's opener records instead of opening a browser.
    await page.evaluate(() => { globalThis.opened = []; globalThis.AtriumHost = {...(globalThis.AtriumHost || {}), openURL: url => { opened.push(url); return Promise.resolve(true); }}; });
    const target = await page.evaluate(({DATASHEET, VENDOR, TEXT_URL}) => {
      const H = AtriumNavHost, p = H.project(), sheet = p.documents.find(d => d.kind === "schematic");
      const part = sheet.items.find(i => i.kind === "part" && p.documents.some(d => d.kind === "pcb" && d.items.some(j => j.link === i.link)));
      const def = p.library.find(d => d.id === part.def);
      def.parameters = {...def.parameters, "Datasheet URL": DATASHEET, ComponentLink1URL: VENDOR, ComponentLink1Description: "Vendor page", Note: "javascript:alert(1)"};
      const text = {id: Atrium.id(), kind: "label", x: part.x + 40, y: part.y, text: "Linked note", url: TEXT_URL};
      sheet.items.push(text);
      return {sheet: sheet.id, part: part.id, link: part.link, text: text.id};
    }, {DATASHEET, VENDOR, TEXT_URL});
    const links = () => page.evaluate(() => [...document.querySelectorAll("#inspector .ui-list[aria-label=Links] .ui-row")].map(r => [r.querySelector(".ui-row-title").textContent, r.title || r.dataset.tooltip]));

    // The sheet: Links lists the description and the parameter name; the unsafe value is not a link.
    await page.evaluate(t => { AtriumNavHost.selectDocument(t.sheet); AtriumNavHost.select([t.part]); }, target);
    await page.locator("#inspector .ui-list[aria-label=Links] .ui-row").first().waitFor();
    assert.deepEqual(await links(), [["Vendor page", VENDOR], ["Datasheet URL", DATASHEET]]);
    await page.locator("#inspector .ui-list[aria-label=Links] .ui-row").first().click();
    assert.deepEqual(await page.evaluate(() => opened.splice(0)), [VENDOR], "a Links row opens through the host");
    // It reads as a link: link ink and pointer on the title, a muted host line; Enter opens it too.
    const look = await page.evaluate(() => {
      const row = document.querySelector("#inspector a.part-link[href]"), title = row.querySelector(".ui-row-title"), detail = row.querySelector(".ui-row-detail");
      const ink = n => getComputedStyle(n).color;
      return {cursor: getComputedStyle(row).cursor, title: ink(title), detail: ink(detail), glyph: !!title.querySelector("svg.icon")};
    });
    assert.equal(look.cursor, "pointer");
    assert.ok(look.glyph && look.title !== look.detail, "link ink differs from the muted host " + JSON.stringify(look));
    await page.locator("#inspector a.part-link").nth(1).focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await page.evaluate(() => opened.splice(0)), [DATASHEET], "Enter opens the focused link");

    // The board part shows its schematic part's links.
    await page.evaluate(t => {
      const H = AtriumNavHost, board = H.project().documents.find(d => d.kind === "pcb");
      H.selectDocument(board.id); H.select([board.items.find(i => i.kind === "part" && i.link === t.link).id]);
    }, target);
    await page.waitForFunction(() => AtriumNavHost.doc().kind === "pcb" && document.querySelectorAll("#inspector .ui-list[aria-label=Links] .ui-row").length === 2);
    assert.deepEqual(await links(), [["Vendor page", VENDOR], ["Datasheet URL", DATASHEET]]);

    // The hyperlinked text: its URL is a field, with an Open link row.
    await page.evaluate(t => { AtriumNavHost.selectDocument(t.sheet); AtriumNavHost.select([t.text]); }, target);
    const field = page.locator('#inspector input[aria-label="URL"]');
    await field.waitFor();
    assert.equal(await field.inputValue(), TEXT_URL);
    await page.getByRole("link", {name: /^Open link \(/}).click();
    assert.deepEqual(await page.evaluate(() => opened.splice(0)), [TEXT_URL]);

    // Cmd/Ctrl+click on the text opens it; a plain click only selects.
    const at = await page.evaluate(t => {
      const H = AtriumNavHost, item = H.doc().items.find(i => i.id === t.text);
      H.zoomTo([item.x - 30, item.y - 20, item.x + 30, item.y + 20], {margin: .02});
      return t.text;
    }, target);
    await page.waitForFunction(() => !globalThis.AtriumMotion?.active());
    const point = await page.evaluate(id => {
      const H = AtriumNavHost, d = H.doc(), r = H.canvas().getBoundingClientRect();
      for (let dx = 0; dx < 30; dx += .25) for (const dy of [.5, 1, 1.5, 0, -.5]) {
        const item = d.items.find(i => i.id === id), w = [item.x + dx, item.y + dy];
        if (H.hitAt(w)?.id === id) { const s = H.view().worldToScreen(w); return {x: s[0] + r.left, y: s[1] + r.top}; }
      }
      return null;
    }, at);
    assert.ok(point, "the text can be hit");
    await page.mouse.click(point.x, point.y);
    assert.deepEqual(await page.evaluate(() => opened.splice(0)), [], "a plain click does not open the link");
    await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
    assert.deepEqual(await page.evaluate(() => opened.splice(0)), [TEXT_URL], "Cmd/Ctrl+click opens the text's link");

    // Clearing the field removes the link, in one undo step.
    await field.fill(""); await field.press("Enter");
    assert.equal(await page.evaluate(id => AtriumNavHost.doc().items.find(i => i.id === id).url, at), undefined);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
};

if (require.main === module) require("../support/standalone-chromium.cjs")(
  () => process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"},
  browser => module.exports(browser).then(() => console.log("PASS part links")),
  error => { console.error(error); process.exitCode = 1; });
