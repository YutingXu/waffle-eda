"use strict";
// Messages filter keystrokes stay cheap (incremental-first): a small list filters within the keystroke,
// a long one once per frame however fast the keys come; a keystroke does not sort or rebuild the list,
// keeps the elements of rows still shown, paints only the rows in view, and narrows a longer query from
// the rows the shorter one kept. Synthetic rows only. Run: node tests/integration-browser.cjs --messages-filter-only
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const editor = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;

module.exports = async function messagesFilter(browser) {
  const context = await browser.newContext({viewport: {width: 1400, height: 900}});
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  try {
    await page.goto(editor);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => globalThis.AtriumNavHost?.doc()?.items.length);
    await page.evaluate(() => AtriumLazy.need("AtriumMessages"));
    const show = n => page.evaluate(n => {
      const rows = Array.from({length: n}, (_, i) => ({class: ["Error", "Warning", "Info"][i % 3], source: "Synthetic", document: "Sheet " + (i % 40),
        text: "Synthetic note " + i + (i % 7 ? " clearance between track and pad" : " unconnected pin")}));
      AtriumMessages.show(AtriumNavHost.messageContext(), {title: "Synthetic", group: "Synthetic", messages: rows});
      const search = document.querySelector(".msg-panel input[type=search]");
      search.value = ""; search.dispatchEvent(new Event("input", {bubbles: true}));
      return document.querySelectorAll(".msg-panel tbody tr[data-no]").length;
    }, n);
    // What one batch of keystrokes (one task) costs: synchronous time, list repaints until the next
    // frame has painted, rows painted, rows kept from before, and the summary.
    const type = (values) => page.evaluate(async values => {
      const panel = document.querySelector(".msg-panel"), tbody = panel.querySelector("tbody"), search = panel.querySelector("input[type=search]");
      const before = new Set(tbody.querySelectorAll("tr[data-no]"));
      let repaints = 0;
      // A repaint puts the rows in (moving a kept row out of the list first is not one).
      const watch = new MutationObserver(records => {repaints += records.filter(r => r.target === tbody && r.addedNodes.length).length;});
      watch.observe(tbody, {childList: true});
      let frameStart = 0;
      requestAnimationFrame(() => {frameStart = performance.now();});
      const t0 = performance.now();
      for (const v of values) {search.value = v; search.dispatchEvent(new Event("input", {bubbles: true}));}
      const sync = performance.now() - t0;
      const immediate = tbody.querySelectorAll("tr[data-no]").length && [...tbody.querySelectorAll("tr[data-no] .msg-col-text")].every(td => td.textContent.toLowerCase().includes(values.at(-1).toLowerCase()));
      const frame = await new Promise(r => requestAnimationFrame(() => r(performance.now() - frameStart)));
      await new Promise(r => setTimeout(r, 0));
      watch.disconnect();
      const rows = [...tbody.querySelectorAll("tr[data-no]")];
      return {sync, frame, repaints, immediate, rows: rows.length, kept: rows.filter(tr => before.has(tr)).length,
        match: rows.every(tr => tr.querySelector(".msg-col-text").textContent.toLowerCase().includes(values.at(-1).toLowerCase())),
        summary: panel.querySelector(".msg-foot [role=status]").textContent};
    }, values);

    // ---- a small list: filtered within the keystroke
    assert.ok(await show(300) > 10, "the small list paints its rows in view");
    let r = await type(["unconnected"]);
    assert.equal(r.immediate, true, "a small list is filtered within the keystroke");
    assert.match(r.summary, /· 43 shown/, "the summary counts the matches: " + r.summary);

    // ---- a long list
    const painted = await show(20000);
    assert.ok(painted > 10 && painted < 400, "a long list paints only the rows in view (" + painted + ")");
    // A query every shown row matches: the keystroke keeps their elements (no rebuild).
    r = await type(["synthetic"]);
    assert.equal(r.match, true);
    assert.equal(r.kept, r.rows, "the rows still shown keep their elements");
    // Keys faster than frames: one repaint with the last text, and the keystrokes themselves cost next to nothing.
    r = await type(["synthetic n", "synthetic no", "synthetic not", "synthetic note", "synthetic note 1"]);
    assert.equal(r.repaints, 1, "five keystrokes within a frame repaint the list once ");
    assert.equal(r.match, true, "the repaint uses the latest text");
    assert.ok(r.sync < 8, "the keystrokes of a long list are queued, not filtered at once (" + r.sync.toFixed(1) + " ms)");
    assert.ok(r.frame < 60, "the frame that filters 20,000 rows stays short (" + r.frame.toFixed(1) + " ms)");
    // A longer query narrows the rows the shorter one kept, and the count follows.
    r = await type(["synthetic note 12345"]);
    assert.match(r.summary, /· 1 shown/, "one row matches " + r.summary);
    r = await type(["synthetic note 1234"]);
    assert.match(r.summary, /· 11 shown/, "deleting a character widens the match again: " + r.summary);
    r = await type([""]);
    assert.doesNotMatch(r.summary, /shown/, "an empty filter shows every row");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
  console.log("PASS Messages filter: instant for small lists, one repaint per frame for long ones, rows kept, narrowing and counts");
};
