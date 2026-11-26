"use strict";
// Show in Messages (problem hover card, the DRC marker's context menu, AtriumMessages.reveal) reveals the
// exact message: the Messages tab in front of its dock, on the right view (Problems or Log), with a chip,
// class toggle or filter text that hid it cleared and said so, scrolled into view, selected with the
// panel's selection style and holding the keyboard focus, which the arrow keys then move row by row.
// Synthetic demo-project problems only. Run: node tests/integration-browser.cjs --show-in-messages-only
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const editor = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;

async function open(browser) {
  const context = await browser.newContext({viewport: {width: 1400, height: 900}});
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  await page.goto(editor);
  await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
  await page.waitForFunction(() => globalThis.AtriumNavHost?.doc()?.items.length);
  // Real problems on the demo board: a track dropped across another net (clearance, short).
  await page.evaluate(async () => {
    const h = AtriumNavHost, p = h.project();
    await AtriumLazy.need(["AtriumChecks", "AtriumDRCView", "AtriumDRCMarkers", "AtriumMessages"]);
    const pcb = p.documents.find(d => d.kind === "pcb");
    h.selectDocument(pcb.id);
    const tracks = pcb.items.filter(i => i.kind === "track"), t = tracks[0], other = tracks.find(x => x.net !== t.net);
    h.edit(() => { const dx = other.points[0][0] - t.points[0][0], dy = other.points[0][1] - t.points[0][1] + .15; t.points = t.points.map(q => [q[0] + dx, q[1] + dy]); });
    await AtriumChecks.checkDesign(h, {});
  });
  await page.waitForFunction(() => AtriumDRCView.violations(AtriumNavHost.doc().id).length, null, {timeout: 15000});
  return {context, page, errors};
}

// A DRC marker on screen (fitted board) and the violation the hover card names for it.
async function marker(page) {
  await page.evaluate(async () => {
    const h = AtriumNavHost, d = h.doc();
    h.zoomTo(d.items.map(i => AtriumNavCommon.itemBox(d, h.defs(), i)).filter(Boolean).reduce(AtriumNavCommon.union));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await page.waitForFunction(() => !globalThis.AtriumMotion?.active());
  const m = await page.evaluate(() => {
    const h = AtriumNavHost, d = h.doc(), pane = h.panes().find(p => p.active), rect = pane.canvas.getBoundingClientRect();
    for (const v of AtriumDRCView.violations(d.id)) {
      const at = v.at || v.otherAt; if (!at) continue;
      const s = pane.view.worldToScreen(at), x = rect.left + s[0], y = rect.top + s[1];
      if (x < rect.left + 60 || y < rect.top + 60 || x > rect.right - 60 || y > rect.bottom - 60) continue;
      const hit = AtriumProblemHover._find(pane, x, y);
      if (hit?.entries[0].kind !== "drc") continue;
      const c = pane.view.worldToScreen(hit.at);
      globalThis.__wanted = hit.entries[0].raw;
      return {x: rect.left + c[0], y: rect.top + c[1]};
    }
    return null;
  });
  assert.ok(m, "a DRC marker on screen");
  return m;
}

// What Messages shows: the selected row, whether it is the wanted problem, in view and focused.
const shown = page => page.evaluate(() => {
  // The row's face: the table layout paints its cells, the narrow list layout the row itself.
  const fill = tr => {if (!tr) return ""; const c = [tr, tr.querySelector("td")].map(n => getComputedStyle(n).backgroundColor).find(x => x !== "rgba(0, 0, 0, 0)"); return c || "none";};
  const panel = document.querySelector(".msg-panel"), grid = panel?.querySelector(".msg-grid");
  const selected = [...(panel?.querySelectorAll("tbody tr[aria-selected=true]") || [])];
  const tr = selected[0], g = grid?.getBoundingClientRect(), head = grid?.querySelector("thead")?.getBoundingClientRect();
  const r = tr?.getBoundingClientRect(), top = Math.max(g?.top ?? 0, head && head.height ? head.bottom : 0);
  const no = tr ? Number(tr.dataset.no) : null, row = AtriumMessages.view() === "problems" ? AtriumMessages.problems().find(m => m.no === no) : AtriumMessages.messages().find(m => m.no === no);
  const wanted = globalThis.__wanted;
  return {visible: !!panel && !panel.hidden && panel.getClientRects().length > 0 && grid.clientHeight > 0, view: AtriumMessages.view(),
    tab: panel?.querySelector(".msg-tab[aria-selected=true]")?.textContent, count: selected.length, text: tr?.textContent || "",
    isWanted: !!row && !!wanted && (row.drc === wanted || row.problem === wanted || row.problem?.raw === wanted || row.text === wanted),
    inView: !!r && r.top >= top - .5 && r.bottom <= g.bottom + .5 && r.height > 0,
    focused: !!tr && document.activeElement === tr, selectionFill: tr ? fill(tr) : "", restFill: fill(panel.querySelector("tbody tr[data-no]:not([aria-selected=true])")),
    query: panel?.querySelector("input[type=search]")?.value, status: document.getElementById("status")?.textContent || ""};
});
function revealed(s, label) {
  assert.ok(s.visible, label + ": the Messages panel shows");
  assert.equal(s.count, 1, label + ": one row is selected");
  assert.ok(s.isWanted, label + ": the selected row is the chosen message (" + s.text + ")");
  assert.ok(s.inView, label + ": the selected row is scrolled into view");
  assert.ok(s.focused, label + ": the keyboard focus is on the selected row");
  assert.notEqual(s.selectionFill, s.restFill, label + ": the row has the panel's selection style ");
}

module.exports = async function showInMessages(browser) {
  const {context, page, errors} = await open(browser);
  try {
    // ---- the problem hover card
    let m = await marker(page);
    await page.mouse.move(m.x + 1, m.y + 1, {steps: 4});
    await page.locator("#waffle-problem-card:not([hidden])").waitFor({state: "visible", timeout: 1500});
    await page.locator("#waffle-problem-card .ui-tooltip-actions button", {hasText: "Show in Messages"}).click();
    await page.waitForFunction(() => document.querySelector(".msg-panel tbody tr[aria-selected=true]") && !globalThis.AtriumMotion?.active());
    let s = await shown(page);
    revealed(s, "hover card");
    assert.equal(s.tab, "Problems");
    // The arrow keys move the selection, and the focus goes with it.
    await page.keyboard.press("ArrowDown");
    const moved = await page.evaluate(() => {const a = document.activeElement; return {row: a?.matches("tr[data-no]"), selected: a?.getAttribute("aria-selected")};});
    assert.deepEqual(moved, {row: true, selected: "true"}, "ArrowDown moves the focus with the selection");

    // ---- hidden by the filter text, a class toggle and a chip, and Messages behind another dock tab
    await page.evaluate(() => {
      const panel = document.querySelector(".msg-panel"), search = panel.querySelector("input[type=search]");
      search.value = "no message says this"; search.dispatchEvent(new Event("input", {bubbles: true}));
      const cls = AtriumMessages.problems().find(r => r.drc === globalThis.__wanted)?.class || "Error";
      [...panel.querySelectorAll(".msg-filter")].find(b => (b.getAttribute("aria-label") || "").toLowerCase().includes(cls === "Error" ? "errors" : cls === "Warning" ? "warnings" : cls.toLowerCase()))?.click();
      [...panel.querySelectorAll(".msg-chip")].find(b => b.textContent === "Schematic").click();
    });
    await page.evaluate(() => AtriumNavHost.canvas().focus());
    const props = page.locator(".dock-tab", {hasText: /^Properties$/});
    if (await props.count()) await props.first().click();
    m = await marker(page);
    await page.mouse.click(m.x, m.y, {button: "right"});
    await page.getByRole("menuitem", {name: "Show in Messages"}).click();
    await page.waitForFunction(() => document.activeElement?.matches?.(".msg-panel tr[aria-selected=true]"));
    await page.waitForFunction(() => !globalThis.AtriumMotion?.active());
    s = await shown(page);
    revealed(s, "context menu with the filters hiding it");
    assert.equal(s.query, "", "the filter text that hid it is cleared");
    assert.match(s.status, /cleared .*Schematic.*to show this problem/, "the status bar says what was cleared: " + s.status);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll(".msg-panel .msg-chip[aria-pressed=true]")].map(b => b.textContent).join()), "", "no chip hides it");

    // ---- a Log message far down a long list
    await page.evaluate(() => {
      const rows = Array.from({length: 600}, (_, n) => ({class: n % 5 ? "Info" : "Warning", source: "Import", text: "Synthetic import note " + n}));
      AtriumMessages.show(AtriumNavHost.messageContext(), {title: "Import", group: "Synthetic import", messages: rows, focus: false});
      AtriumMessages.setView("problems");
      globalThis.__wanted = "Synthetic import note 517";
      AtriumNavHost.canvas().focus();
    });
    assert.equal(await page.evaluate(() => AtriumMessages.reveal(m => m.text === "Synthetic import note 517")), true);
    await page.waitForFunction(() => document.activeElement?.matches?.(".msg-panel tr[aria-selected=true]"));
    s = await shown(page);
    revealed(s, "a Log message far down the list");
    assert.equal(s.tab, "Log", "Show in Messages switches to the Log tab");
    assert.equal(await page.evaluate(() => AtriumMessages.reveal(() => false)), false, "no match: false, and nothing changes");

    // ---- the Fix buttons of Problems rows belong to those rows (not to the Log row with the same number)
    const fixes = await page.evaluate(async () => {
      await AtriumLazy.need("AtriumDRCFixes");
      AtriumMessages.clear();
      AtriumMessages.show(AtriumNavHost.messageContext(), {title: "Synthetic", group: "Synthetic shift", focus: false,
        messages: [1, 2, 3].map(n => ({class: "Info", source: "Import", text: "Synthetic shift " + n}))});
      await AtriumChecks.checkDesign(AtriumNavHost, {});
      AtriumMessages.open(AtriumNavHost.messageContext(), {view: "problems", domain: null, fab: false, waived: false});
      AtriumDRCFixes.decorate();
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
      const rows = [...document.querySelectorAll(".msg-panel tbody tr[data-no]")];
      return rows.map(tr => {
        const m = AtriumMessages.problems().find(p => p.no === Number(tr.dataset.no));
        return {no: tr.dataset.no, button: !!tr.querySelector(".drc-fix-row"), fixable: !!m?.drc && AtriumDRCFixes.hasFix(m.drc)};
      });
    });
    assert.ok(fixes.some(r => r.fixable), "the board has a fixable violation");
    assert.deepEqual(fixes.filter(r => r.button !== r.fixable), [], "a Problems row has a Fix button exactly when its own violation has a fix");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
  console.log("PASS Show in Messages: hover card, context menu and reveal() select, scroll to, focus and unhide the exact message on its tab");
};
