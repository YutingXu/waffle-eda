"use strict";
// A remote edit enters the receiving editor through the change-set path a local edit uses, so the
// guest re-checks only what it touched. Two editors in headless Chrome (playwright-core) on the
// 25,600-object benchmark board, over the local carrier (scripts/perf-collab.cjs's session). For a
// remote in-place move, a property edit, an add and a delete, on the guest:
//   * the patch goes through host.derive({touched: scopes}): the Undo journal records it with a
//     scoped comparison, never a full one (undo-store stats().full);
//   * the board's journal range names only the changed items (what online DRC, the redraw, the
//     minimap, live pours and Design Insights read through AtriumUndoStore.changed/recordedChanges);
//   * online DRC hands AtriumRules.drc at most a neighbourhood (here 2,000 of 25,600 items).
//   node tests/project/collab-remote-scope-browser.cjs   (NODE_PATH with playwright-core; CHROME=… optional)
const assert = require("node:assert/strict"), path = require("node:path");
let chromium;
try { ({chromium} = require("playwright-core")); } catch { console.log("collab-remote-scope-browser: SKIPPED (no playwright-core)"); process.exit(0); }
const P = require(path.join(__dirname, "../../scripts/perf-collab.cjs"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const project = await P.design(), server = await P.serve(project), base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({headless: true, ...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: "chrome"}),
    args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"]});
  const results = {};
  try {
    const s = await P.session(browser, base, "local", null);
    await s.host.evaluate(P.instrument); await s.guest.evaluate(P.instrument);
    await P.setupKinds(s.host);
    await s.guest.evaluate(() => { const H = AtriumNavHost; H.selectDocument(H.project().documents.find(d => d.kind === "pcb" && d.items.length > 1000).id); });
    await sleep(3000);   // the guest's first (whole-board) online check
    for (const kind of ["move", "property", "add", "delete", "move"]) {
      const mark = await s.guest.evaluate(P.scopeMark);
      const r = await s.host.evaluate(P.runKind, {kind, i: 1, flush: true});
      await P.guestSaw(s.guest, r.start);
      await sleep(800);
      const scope = await s.guest.evaluate(P.scopeSince, mark);
      results[kind] = scope;
      assert.equal(scope.fullSyncs, 0, kind + ": the remote patch is recorded with a scoped journal comparison");
      assert.ok(scope.scopedSyncs >= 1, kind + ": the remote patch reached the journal");
      assert.equal(typeof scope.journalIds, "number", kind + ": the journal range is known");
      assert.ok(scope.journalIds >= 1 && scope.journalIds <= 2, kind + ": the journal names the changed item (" + scope.journalIds + ")");
      assert.ok(scope.drcWrapped, "online DRC ran on the guest");
      assert.ok(scope.drcItems <= P.BUDGETS.drcItems, kind + ": online DRC re-checked " + scope.drcItems + " items");
    }
    assert.deepEqual(s.errors, [], "no page errors");
    for (const p of s.pages) await p.evaluate(() => AtriumCollabLive.leave()).catch(() => {});
  } finally { await browser.close(); server.close(); }
  console.log("collab-remote-scope-browser: ok " + JSON.stringify(results));
})().catch(e => { console.error(e); process.exit(1); });
