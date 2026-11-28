"use strict";
// Walks the ODB++ output card in File › Release (butter.odb, task 55): the live preview with its
// progress line, fidelity summary, fidelity report and receipt, then each reason the archive cannot be
// written (ODB++ off, no PCB, no closed board shape, worker unavailable) with its fixing action.
// node tests/formats/browser-butter-odb-ui.js [--shots OUTPUT_DIRECTORY]
const assert = require("node:assert/strict");
const {boot, run} = require("../support/butter-design.cjs");

run("odb", async ({browser, profile, shot}) => {
  const {page, errors} = await boot(browser, profile, {"butter.odb":true});
  try {
    const release = page.getByRole("dialog", {name:"Release", exact:true});
    const file = page.locator('.menubar [data-menu="file"]');
    await file.locator(":scope > summary").click();
    await file.getByRole("menuitem", {name:"Release…", exact:true}).click();
    const jobs = release.getByRole("combobox", {name:"Job set"});
    await jobs.waitFor();
    await page.evaluate(() => {
      window.odbSeen = {progress:false};
      new MutationObserver(() => { if (document.querySelector('article[data-kind="odb"] .odb-lines .ui-progress')) odbSeen.progress = true; })
        .observe(document.body, {subtree:true, childList:true});
    });
    await jobs.selectOption({label:"ODB++ fabrication"});
    const card = release.locator('article[data-kind="odb"]');
    await card.locator(".rel-state.is-ok, .rel-state.is-warn").waitFor({timeout:60000});
    const lines = card.locator(".odb-lines");
    await lines.getByRole("button", {name:"Fidelity report…"}).waitFor();
    assert.match(await lines.innerText(), /approximations?\b.*package body outlines/i);
    assert.match(await card.locator(".rel-summary").innerText(), /Design 8\.1 · \d+ layers · 1 step/);
    await lines.getByText(/^Receipt ·/).waitFor();
    assert.match(await lines.locator("code").getAttribute("data-tooltip"), /^SHA-256 [0-9a-f]{64}$/);
    assert.equal(await page.evaluate(() => odbSeen.progress), true, "the card showed its progress line while the archive was written");
    await card.scrollIntoViewIfNeeded();
    await shot(card, "ready");

    await lines.getByRole("button", {name:"Fidelity report…"}).click();
    const report = page.getByRole("dialog", {name:"ODB++ fidelity report"});
    await report.getByRole("row", {name:/Package body outlines/}).waitFor();
    await shot(report, "fidelity-report");
    await report.getByRole("button", {name:"Close"}).click();

    // The progress line and each reason it cannot run, drawn on the live card.
    const draw = (row, busy) => page.evaluate(async ({row, busy}) => {
      const C = await AtriumLazy.need("AtriumODBCard"), node = document.querySelector('article[data-kind="odb"]');
      const entry = {node, summary:node.querySelector(".rel-summary"), thumb:node.querySelector(".rel-thumb")};
      const chip = node.querySelector(".rel-state");
      if (busy) { chip.textContent = "Making…"; chip.className = "rel-state is-muted"; }
      else { chip.textContent = row.status === "skipped" ? "Skipped" : "Error"; chip.className = "rel-state is-" + (row.status === "skipped" ? "muted" : "bad"); }
      window.odbActs = [];
      if (busy) return C.busy(entry);
      C.fill(entry, row, {project:row.noBoard ? {documents:[]} : AtriumNavHost.project(), act:a => odbActs.push(a), retry:() => odbActs.push("retry")});
    }, {row, busy});
    await draw(null, true);
    await lines.getByRole("progressbar").waitFor();
    await lines.getByText("1 s").waitFor();
    await shot(card, "progress");
    const cases = [
      ["disabled", {status:"skipped", message:"ODB++ output is disabled in Experimental features."}, "ODB++ is turned off", "Experimental features…", "labs"],
      ["no-board", {status:"skipped", message:"The project has no PCB layout.", noBoard:true}, "This project has no PCB", "Add PCB…", "add-pcb"],
      ["no-outline", {status:"error", message:"Define a closed board shape before exporting ODB++."}, "Define a closed board shape", "Board shape…", "board-shape"],
      ["worker", {status:"error", message:"The output worker stopped."}, "The output worker is unavailable", "Try again", "retry"],
    ];
    for (const [key, row, text, action, act] of cases) {
      await draw(row);
      await lines.getByText(text, {exact:false}).waitFor();
      assert.equal(await card.getAttribute("data-odb"), key);
      await lines.getByRole("button", {name:action}).click();
      assert.deepEqual(await page.evaluate(() => odbActs), [act]);
      await shot(card, "problem-" + key);
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}).then(() => console.log("PASS butter ODB++ card"), error => { console.error(error); process.exit(1); });
