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
// Then, on a saved (folder) project: no whole-project audit runs while both editors are idle; an
// item changed without its Undo hint is not published until the host saves, when the audit
// publishes and counts it (r.stats().repairs); a second one is published when the host leaves.
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
    for (const c of s.contexts) await c.close();
    console.log("collab-remote-scope-browser: remote scope ok " + JSON.stringify(results));

    // ---- the audit: at save and before leaving, never while idle ----
    // A browser saves an unsaved project as a folder project (a download); later saves keep it.
    let t;
    try { t = await P.session(browser, base, "local", null, {saveFirst: true}); }
    catch (e) {
      if (!/did not make a folder project/.test(e.message)) throw e;
      console.log("collab-remote-scope-browser: audit part SKIPPED (this browser cannot save a folder project: " + e.message.split("\n")[0] + ")");
      return;
    }
    await t.host.evaluate(P.instrument); await t.guest.evaluate(P.instrument);
    await P.setupKinds(t.host);
    const stats = page => page.evaluate(() => { const {audits, repairs, repairedOps} = AtriumCollabLive.session().r.stats(); return {audits, repairs, repairedOps}; });
    const quiet = (id, value) => t.host.evaluate(({id, value}) => {
      // Changed in place with no edit call: no Undo hint, no change event (a missed hint).
      for (const d of AtriumNavHost.project().documents) { const it = d.items.find(i => i.id === id); if (it) it.diameter = value; }
    }, {id, value});
    const guestValue = id => t.guest.evaluate(id => { for (const d of AtriumNavHost.project().documents) { const it = d.items.find(i => i.id === id); if (it) return it.diameter; } return null; }, id);
    const [v1, v2] = await t.host.evaluate(() => window.pcTargets.vias.slice(20, 22));
    await quiet(v1, 0.777);
    const r = await t.host.evaluate(P.runKind, {kind: "property", i: 7, flush: true});
    await P.guestSaw(t.guest, r.start);
    assert.notEqual(await guestValue(v1), 0.777, "a change without its hint is not in the scoped publication");
    const idle0 = [await stats(t.host), await stats(t.guest)];
    await sleep(6000);
    const idle1 = [await stats(t.host), await stats(t.guest)];
    assert.deepEqual(idle1.map(x => x.audits), idle0.map(x => x.audits), "no audit runs while the editors are idle");
    assert.deepEqual(idle0.map(x => x.audits), [0, 0], "no audit ran during the edits");
    // Save (the current document, as Save does), and wait for the save itself to finish: the folder
    // project reports it ("saved"), or the project is replaced. The audit runs a task later.
    const saved = await t.host.evaluate(async () => {
      const H = AtriumNavHost, t0 = performance.now(), events = [], at = () => Math.round(performance.now() - t0);
      const wait = async done => { while (!done() && performance.now() - t0 < 180000) await new Promise(r => setTimeout(r, 50)); };
      H.on("dirty", v => events.push("dirty " + v + " @" + at())); H.on("replace", () => events.push("replace @" + at()));
      H.folderProject?.()?.on?.(kind => { if (kind === "saved" || kind.startsWith("write")) events.push("folder " + kind + " @" + at()); });
      H.markUnsaved(); H.act("save");
      await wait(() => events.some(e => e.startsWith("folder saved") || e.startsWith("replace")));
      const audits = () => AtriumCollabLive.session()?.r.stats().audits || 0;
      await wait(() => audits() > 0 || !AtriumCollabLive.session());
      return {savedEvent: events.some(e => e.startsWith("folder saved")), folder: !!H.folderProject?.(), session: !!AtriumCollabLive.session(),
        audits: audits(), ms: at(), events, status: document.getElementById("status")?.textContent?.slice(0, 160)};
    });
    results.save = saved;
    assert.ok(saved.savedEvent, "the folder save finished (its \"saved\" report) within 180 s: " + JSON.stringify(saved));
    assert.ok(saved.folder, "the saved project is still a folder project: " + JSON.stringify(saved));
    assert.ok(saved.session, "a folder save keeps the session: " + JSON.stringify(saved));
    assert.equal(saved.audits, 1, "the save ran one whole-project audit: " + JSON.stringify(saved));
    for (let k = 0; k < 40 && await guestValue(v1) !== 0.777; k++) await sleep(100);
    assert.equal(await guestValue(v1), 0.777, "the audit at save publishes the missed change");
    const atSave = await stats(t.host);
    assert.deepEqual(atSave, {audits: 1, repairs: 1, repairedOps: 1}, "the save audit is counted with its repair");
    await quiet(v2, 0.555);
    await t.host.evaluate(() => AtriumCollabLive.leave());
    for (let k = 0; k < 40 && await guestValue(v2) !== 0.555; k++) await sleep(100);
    assert.equal(await guestValue(v2), 0.555, "the audit before leaving publishes the missed change");
    assert.deepEqual(t.errors, [], "no page errors");
    results.audit = {idle: idle1, atSave};
    await t.guest.evaluate(() => AtriumCollabLive.leave()).catch(() => {});
    console.log("collab-remote-scope-browser: audit ok " + JSON.stringify({audit: results.audit, save: results.save}));
  } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exit(1); });
