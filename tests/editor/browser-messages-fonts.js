"use strict";

// Messages draws every source in one face: schematic (Compile, ERC), layout (DRC), fab sign-off, imported
// board rules and Board Shape rows, and the panel's own tabs, counters and chips, all in the UI font
// (--font-ui) at the library sizes, with no monospace anywhere. A message row has the same font for its
// message and the same font for its details whatever produced it. Run standalone or with
// integration-browser.cjs --messages-fonts-only.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const APP = path.join(__dirname, "../../app");
const logs = [
  ["Imported board rules", "Import", "Import"],
  ["Board Shape", "Board Shape", "Board shape"],
  ["PDN", "PDN", "Power"],
  ["Thermal", "Thermal", "Thermal"],
  ["Fab outputs", "Gerber", "Output"],
];
const logTexts = logs.flatMap(([, , title]) => [title + " warning on R1", title + " error on net GND"]);

module.exports = async function messagesFonts(browser) {
  const page = await browser.newPage({viewport:{width:1400, height:900}, reducedMotion:"reduce"});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  try {
    await page.goto(pathToFileURL(path.join(APP, "index.html")).href);
    const demo = page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Try the Demo", exact:true});
    await demo.waitFor(); await demo.click();
    await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
    await page.waitForFunction(() => !!globalThis.AtriumNavHost);
    await page.evaluate(() => AtriumLazy.need(["AtriumMessages", "AtriumChecks"]));
    // Rows from every source: the checks (Problems), and one log group per tool, as each tool reports them.
    await page.evaluate(logs => {
      const host = AtriumNavHost, ctx = host.messageContext?.() || {host};
      const doc = host.doc(), now = new Date();
      const rows = (source, group) => [{class:"Warning", source, text:group + " warning on R1", document:doc.name, documentId:doc.id, time:now},
        {class:"Error", source, text:group + " error on net GND", document:doc.name, documentId:doc.id, time:now}];
      // Compiler, DRC and DFM rows list under Problems; the other tools log their rows.
      AtriumMessages.show(ctx, {title:"Compile", group:"Compiler", messages:rows("ERC", "Schematic")});
      AtriumMessages.show(ctx, {title:"Design rule check", group:"DRC", messages:rows("Clearance", "Layout")});
      for (const [group, source, title] of logs) AtriumMessages.show(ctx, {title, group, messages:rows(source, title)});
    }, logs);
    await page.evaluate(() => AtriumNavHost.act("check-design"));
    await page.waitForFunction(() => document.getElementById("status")?.textContent.startsWith("Check Design:"));
    const messages = page.getByRole("region", {name:"Messages", exact:true});
    await messages.getByRole("tab", {name:"Problems", selected:true}).waitFor();
    assert.equal(await page.evaluate(() => AtriumMessages.detail()), null, "Check Design opens the shared Problems list");

    const fontOf = n => { const s = getComputedStyle(n); return [s.fontFamily, s.fontSize, s.fontWeight, s.fontStyle].join(" / "); };
    const sample = () => page.evaluate(fontOf => {
      const f = new Function("return " + fontOf)();
      const panel = document.querySelector(".msg-panel");
      const ui = getComputedStyle(document.body).fontFamily;
      const mono = [...panel.querySelectorAll("*")].filter(n => n.getClientRects().length && n.textContent.trim() && !n.closest("svg"))
        .filter(n => /mono|courier|menlo|consolas/i.test(getComputedStyle(n).fontFamily) || getComputedStyle(n).fontFamily !== ui)
        .map(n => n.className + " " + getComputedStyle(n).fontFamily);
      const rows = [...panel.querySelectorAll("tbody tr[data-no]")].map(tr => ({
        source:tr.querySelector(".msg-col-source")?.textContent || "",
        content:tr.querySelector(".msg-col-text").textContent.trim(),
        text:f(tr.querySelector(".msg-col-text span") || tr.querySelector(".msg-col-text")),
        details:[...tr.querySelectorAll(".msg-col-document, .msg-col-source")].map(f),
        numbers:[...tr.querySelectorAll(".msg-col-time, .msg-col-no")].map(f)}));
      const head = [...panel.querySelectorAll(".msg-tab, .msg-filter, .msg-chip")].map(n => ({label:n.textContent.trim(), font:f(n)}));
      return {mono, rows, head};
    }, fontOf.toString());
    const logTab = messages.getByRole("tab", {name:"Log", exact:true});
    const report = messages.locator("button").filter({hasText:/^Report…$/});
    const checkLog = rows => {
      for (const entry of logTexts) {
        assert.equal(rows.filter(row => row.content === entry).length, 1, "Log shows exactly one " + entry);
      }
      assert.ok(new Set(rows.map(r => r.source)).size >= 5, "log rows come from five sources");
    };

    for (const view of ["log", "problems"]) {
      await messages.getByRole("tab", {name:view === "log" ? "Log" : "Problems", exact:true}).click();
      const {mono, rows, head} = await sample();
      assert.deepEqual(mono, [], view + ": every text in Messages is in the UI font");
      if (view === "log") checkLog(rows);
      else {
        assert.ok(rows.length, "Problems has check findings");
        assert.ok(rows.every(row => !logTexts.includes(row.content)), "Problems excludes the tool log entries");
      }
      const one = (list, what) => assert.equal(new Set(list).size, 1, view + ": one " + what + " font across sources: " + [...new Set(list)].join(" | "));
      one(rows.map(r => r.text), "message");
      one(rows.flatMap(r => r.details), "detail");
      if (rows[0].numbers.length) one(rows.flatMap(r => r.numbers), "number");
      const families = new Set(head.map(h => h.font.split(" / ")[0]));
      assert.equal(families.size, 1, view + ": tabs, counters and chips share one family: " + JSON.stringify(head));
      const sizes = new Set(head.map(h => h.font.split(" / ")[1]));
      assert.equal(sizes.size, 1, view + ": tabs, counters and chips share one size: " + JSON.stringify(head));
    }
    // The domain chips are library filter chips.
    const chips = await page.locator(".msg-chips > button").evaluateAll(nodes => nodes.map(n => n.classList.contains("ui-chip") && n.hasAttribute("aria-pressed")));
    assert.ok(chips.length >= 4 && chips.every(Boolean), "Schematic, Layout, Fab sign-off and Waived are .ui-chip toggles");
    await page.evaluate(() => AtriumNavHost.act("drc"));
    await report.waitFor({state:"attached"});
    const task = await sample();
    assert.ok(task.rows.length && task.rows.every(row => !logTexts.includes(row.content)), "the DRC report is scoped to its task");
    await logTab.click();
    checkLog((await sample()).rows);
    assert.equal(await report.count(), 0, "the general Log does not retain DRC report controls");
    assert.deepEqual(errors, [], "no page errors");
    console.log("messages fonts: ok");
  } finally {
    await page.close();
  }
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => {
      const at = process.argv.indexOf("--executable");
      return {headless:true, ...(at > 0 ? {executablePath:process.argv[at + 1]} : {channel:"chrome"})};
    },
    browser => module.exports(browser),
    error => { console.error(error); process.exit(1); });
}
