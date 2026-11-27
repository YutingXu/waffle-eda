"use strict";

// One print path in real Chrome: BOM Print…, Messages › Export › Print…, the comparison's
// Export › Print… and File › Print… each end in exactly one AtriumHost.printPDF call (the
// macOS/Linux host's system print panel) with valid PDF bytes and a sensible job name. Mod+P
// over the BOM prints the BOM, not the document. Nothing prints through a hidden iframe.
// SHOTS=dir also saves the report Print dialog.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const appUrl = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;
const jobs = page => page.evaluate(() => window.__printJobs.splice(0));
async function stubHost(page) {
  await page.evaluate(() => {
    window.__printJobs = [];
    // Only printPDF: the rest of the app keeps its browser behaviour.
    window.AtriumHost = {printPDF: async (name, bytes) => {
      let text = ""; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
      window.__printJobs.push({name, head: text.slice(0, 5), eof: /%%EOF\s*$/.test(text.slice(-32)), pages: (text.match(/\/Type\s*\/Page(?![s\w])/g) || []).length,
        iframes: document.querySelectorAll("iframe").length});
      return !window.__cancelPrint;
    }};
  });
}
function valid(job, name) {
  assert.match(job.name, name);
  assert.equal(job.head, "%PDF-");
  assert.ok(job.eof, "complete PDF");
  assert.ok(job.pages >= 1, "at least one page");
  assert.equal(job.iframes, 0, "no print iframe");
}
async function onePrintJob(page, name, label, timeout) {
  await page.waitForFunction(() => window.__printJobs.length >= 1, null, {timeout});
  await page.clock.runFor(150);
  const list = await jobs(page);
  assert.equal(list.length, 1, label + " prints once");
  valid(list[0], name);
}

async function reportDialog(page) {
  const d = page.locator("dialog.print-report-dialog[open]");
  await d.waitFor();
  await d.locator(".print-thumb img").first().waitFor();
  return d;
}

async function bom(page) {
  await page.evaluate(() => AtriumNavHost.act("bom"));
  const b = page.locator("dialog.bom-dialog[open]");
  await b.locator(".ui-sheet-grid tbody tr.bom-line").first().waitFor();
  const opener = b.locator(".bom-actions").getByRole("button", {name: "Print…", exact: true});
  await opener.click();
  let d = await reportDialog(page);
  assert.equal(await d.locator(".ui-dialog-actions button.is-primary").textContent(), "Print…");
  assert.match(await d.locator(".print-status").textContent(), /page/);
  if (process.env.SHOTS) { await page.evaluate(() => document.fonts.ready); await page.screenshot({path: path.join(process.env.SHOTS, "print-dialog-bom@2x.png")}); }
  await d.locator(".ui-dialog-actions").getByRole("button", {name: "Print…", exact: true}).click();
  await onePrintJob(page, /-BOM\.pdf$/, "BOM Print…");
  assert.match(await d.locator(".print-status").textContent(), /Sent to the printer/);
  await page.keyboard.press("Escape");
  await page.locator("dialog.print-report-dialog").waitFor({state:"detached"});
  assert.ok(await opener.evaluate(node => new Promise(resolve =>
    requestAnimationFrame(() => resolve(node === document.activeElement)))), "Escape returns focus to the BOM Print button");

  // Mod+P over the BOM opens the BOM's print dialog; Mod+P in it prints.
  await b.locator(".ui-sheet-grid").click({position: {x: 40, y: 40}});
  await page.keyboard.press("ControlOrMeta+Alt+KeyP");
  d = await reportDialog(page);
  assert.equal(await page.locator("dialog.print-dialog:not(.print-report-dialog)[open]").count(), 0, "not the document Print dialog");
  await page.keyboard.press("ControlOrMeta+Alt+KeyP");
  await page.waitForFunction(() => window.__printJobs.length >= 1);
  const list = await jobs(page);
  assert.equal(list.length, 1); valid(list[0], /-BOM\.pdf$/);
  await page.evaluate(() => { for (const x of document.querySelectorAll("dialog[open]")) x.close(); });
  console.log("PASS BOM Print… and Mod+P print the BOM through printPDF");
}

async function messages(page) {
  await page.evaluate(async () => {
    const M = await AtriumLazy.need("AtriumMessages");
    M.show({info() {}}, {title: "Compile", group: "Compile", messages: [
      {class: "Error", document: "Sheet1", source: "ERC", text: "Net VCC has no driver"},
      {class: "Warning", document: "Sheet1", source: "ERC", text: "Unconnected pin U1-4"}]});
  });
  const panel = page.locator('.dock-body .msg-panel[data-dock-panel="messages"]');
  const compact = await panel.evaluate(node => new Promise(resolve => {
    const resize = new ResizeObserver(() => { resize.disconnect(); resolve(node.classList.contains("msg-compact")); });
    resize.observe(node);
  }));
  if (!compact) {
    await panel.locator(".msg-export > summary").click();
    await panel.locator(".msg-export-items").getByRole("button", {name: "Print…", exact: true}).click();
  } else {
    await panel.locator("button.msg-more").click();
    await page.getByRole("menuitem", {name: "Print…", exact: true}).click();
  }
  const d = await reportDialog(page);
  await d.locator(".ui-dialog-actions").getByRole("button", {name: "Print…", exact: true}).click();
  await onePrintJob(page, / messages\.pdf$/, "Messages Print…");
  await page.evaluate(() => { for (const x of document.querySelectorAll("dialog[open]")) x.close(); AtriumMessages.close(); });
  console.log("PASS Messages › Export › Print… prints through printPDF");
}

async function comparison(page) {
  await page.evaluate(async () => {
    await AtriumLazy.need("AtriumDiffView");
    const after = AtriumNavHost.project(), before = Atrium.clone(after);
    const part = before.documents[0].items.find(i => i.ref);
    part.ref = part.ref + "9";
    await AtriumDiffView.start({project: before, label: "Before"}, {project: after, label: "After"});
  });
  await page.locator("button.dv-export").click();
  await page.locator('.dv-pop[aria-label="Export review report"]').locator("button.dv-pop-item", {hasText: /^Print…$/}).click();
  await onePrintJob(page, / compare .*\.pdf$/, "comparison Print…", 20000);
  await page.evaluate(() => AtriumDiffView.close());
  console.log("PASS comparison Export › Print… prints through printPDF");
}

async function filePrint(page) {
  await page.evaluate(() => AtriumNavHost.act("print"));
  const d = page.locator("dialog.print-dialog[open]");
  await d.waitFor();
  await d.locator(".print-thumb img").first().waitFor();
  if (process.env.SHOTS) { await page.evaluate(() => document.fonts.ready); await page.screenshot({path: path.join(process.env.SHOTS, "print-dialog-file@2x.png")}); }
  await d.locator(".ui-dialog-actions").getByRole("button", {name: "Print…", exact: true}).click();
  await onePrintJob(page, /\.pdf$/, "File › Print…", 20000);
  await page.evaluate(() => { window.__cancelPrint = true; });
  await page.keyboard.press("ControlOrMeta+Alt+KeyP");
  await page.waitForFunction(() => document.querySelector(".print-dialog[open] .print-status")?.textContent === "Printing cancelled.");
  const cancelled = await jobs(page);
  assert.equal(cancelled.length, 1, "a cancelled native print is reported after one job");
  valid(cancelled[0], /\.pdf$/);
  await page.evaluate(() => { window.__cancelPrint = false; });
  await page.evaluate(() => { for (const x of document.querySelectorAll("dialog[open]")) x.close(); });
  console.log("PASS File › Print… and Mod+P use printPDF and report cancellation");
}

module.exports = async function printUnify(browser) {
  const page = await browser.newPage({viewport: {width: 1440, height: 900}, deviceScaleFactor: 2, reducedMotion: "reduce"});
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("dialog", d => d.dismiss());
  page.setDefaultTimeout(10000);
  try {
    await page.clock.install();
    await page.goto(appUrl);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => globalThis.AtriumNavHost?.project()?.documents?.length);
    await stubHost(page);
    // Mod+P is Quick open since 2026-11-23; a user binding for Print keeps the context print (reports, dialogs).
    await page.evaluate(() => AtriumKeymap.setBindings("print", ["Mod+Alt+P"]));
    await bom(page);
    await messages(page);
    await comparison(page);
    await filePrint(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
};

if (require.main === module) {
  const {chromium} = require("playwright-core");
  (async () => {
    const browser = await chromium.launch({channel: "chrome", headless: true});
    try { await module.exports(browser); } finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
