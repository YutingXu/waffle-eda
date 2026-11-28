"use strict";
// Browser scenario for the editor-interaction group and --drc-messages-only.
const assert = require("node:assert/strict");
const {pathToFileURL} = require("node:url");
const path = require("node:path");
const {readFileSync} = require("node:fs");

function onlyOneOwner() {
  const source = name => readFileSync(path.join(__dirname, "../../app/checks", name), "utf8");
  assert.doesNotMatch(source("drc.js"), /openDialog|drc-panel/);
  assert.doesNotMatch(source("drc-view.js"), /function overlay\(|ctx\.arc\(|#00ff00/);
  assert.match(source("drc-view.js"), /\.renderFor\(host, d, shown\.get\(d\.id\)/);
  assert.match(source("drc-view.js"), /\.groupAt\(host, pane, shown/);
}

async function insightStatus(page) {
  await page.evaluate(async () => {
    await AtriumLazy.need(["AtriumDRCView", "AtriumInsightsUI", "AtriumChecks"]);
    const h = AtriumNavHost, A = Atrium, project = A.project("Checks status", []);
    const board = (id, items = []) => ({...A.sheet("pcb", id), id, items, outline:[[0,0],[15,0],[15,15],[0,15]]});
    const pad = (id, x, y) => ({id,kind:"pad",x,y,layer:"Top",net:"SIG",shape:"circle",w:.8,h:.8});
    const bend = {id:"bend",kind:"track",layer:"Top",net:"SIG",width:.4,points:[[4,4],[8,4],[5,5]]};
    project.documents = [board("d03-acute", [pad("a",4,4), bend, pad("b",5,5)]), board("d03-zero"),
      {...A.sheet("drawing", "Drawing"), id:"d03-drawing"}];
    const original = h.stageEdit, held = new Map(), open = new Set(), canceled = [];
    h.stageEdit = (phase, key, run) => {
      if (typeof key !== "string" || !key.startsWith("insights:d03-")) return original(phase, key, run);
      const id=key.slice("insights:".length);
      if (open.has(id)) return original(phase, key, run);
      held.set(id, run);
      return {cancel() {if (held.delete(id)) canceled.push(run);}};
    };
    // Only suspend the actual Insights task, before its first slice.
    window.checkStatus = {
      held, read() {
        const id=h.doc().id, status=document.getElementById("status-problems");
        return {id, revision:h.authoredRevision(), state:status.dataset.state, text:status.textContent, busy:status.getAttribute("aria-busy"),
          drc:AtriumDRCView.status(), pending:AtriumChecks.meta(id,"drc")?.pending,
          findings:AtriumChecks.problemReport(h.project()).active.map(v=>[v.doc,v.check])};
      },
      release(id) {const run=held.get(id); held.delete(id); open.add(id); run(() => true, {timeRemaining:() => 100});},
      stale() {for (const run of canceled.splice(0)) run(() => true, {timeRemaining:() => 100});},
      rehold() {open.clear();},
      restore() {h.stageEdit=original;}
    };
    if (!await h.replaceProject(project,{force:true,dirty:false})) throw Error("Checks status fixture did not open");
  });
  const ready = id => page.waitForFunction(id => {
    const s=checkStatus.read();
    return s.id===id && s.drc===null && s.pending===false;
  }, id);
  const read = () => page.evaluate(() => checkStatus.read());
  const assertChecking = (state, note) => assert.deepEqual([state.state,state.text,state.busy], ["checking","Checking…","true"], note);
  await ready("d03-acute");
  const before = await read();
  assert.deepEqual(before.findings, [], "DRC has verified zero problems");
  assert.ok(await page.evaluate(() => checkStatus.held.has("d03-acute")), "initial Insight is genuinely queued");
  console.log("D03 after DRC zero, initial Insights queued", before);
  assertChecking(before, "the board cannot settle green while Insights is pending");
  await page.evaluate(() => AtriumNavHost.selectDocument("d03-zero"));
  await ready("d03-zero");
  await page.evaluate(() => checkStatus.stale());
  assertChecking(await read(), "a cancelled completion does not settle the new board");
  await page.evaluate(() => checkStatus.release("d03-zero"));
  await page.locator('#status-problems[data-state="ok"]').waitFor();
  assert.deepEqual((await read()).findings, [], "actual completed zero, with no old-board findings");
  await page.evaluate(() => {checkStatus.rehold(); AtriumChecks.scheduler.plan("insights",{force:true,now:true});});
  assertChecking(await read(), "a new queued pass updates the status without a finding publication");
  await page.evaluate(() => AtriumChecks.scheduler.cancel("insights"));
  await page.locator('#status-problems[data-state="ok"]').waitFor();
  assert.ok(await page.evaluate(async () => {
    const h=AtriumNavHost, prior=h.doc(), replacement=Atrium.clone(h.project());
    replacement.documents.sort((a,b) => Number(b.id===prior.id)-Number(a.id===prior.id));
    AtriumChecks.scheduler.plan("insights",{force:true,now:true});
    return await h.replaceProject(replacement,{force:true,dirty:false}) && h.doc()!==prior && h.doc().id===prior.id;
  }),"a replacement project reuses the old board ID with a new board object");
  await ready("d03-zero");
  await page.evaluate(() => checkStatus.stale());
  assertChecking(await read(),"a cancelled completion does not settle a replacement with the same ID");
  await page.evaluate(() => checkStatus.release("d03-zero"));
  await page.locator('#status-problems[data-state="ok"]').waitFor();
  await page.evaluate(() => checkStatus.rehold());
  await page.evaluate(() => AtriumChecks.scheduler.queue("insights",AtriumNavHost.doc(),"idle",{heavy:true}));
  assert.equal((await read()).state,"ok","optional heavier work does not replace a completed zero");
  await page.evaluate(() => AtriumNavHost.selectDocument("d03-drawing"));
  assert.equal((await read()).state,"ok","an ineligible document does not count another board's pending task");
  await page.evaluate(() => {checkStatus.rehold(); return AtriumNavHost.selectDocument("d03-acute");});
  await ready("d03-acute");
  const again = await read();
  assertChecking(again);
  await page.evaluate(() => checkStatus.release("d03-acute"));
  await page.locator('#status-problems[data-state="warning"]').waitFor();
  const complete = await read();
  console.log("D03 first Insights publication", complete);
  assert.equal(complete.revision, again.revision);
  assert.deepEqual(complete.findings, [["d03-acute","layout.fab.acid"]]);
  await page.evaluate(() => {checkStatus.rehold(); AtriumChecks.scheduler.plan("insights",{force:true,now:true});});
  assert.equal((await read()).state,"warning","pending Insights retains findings already known");
  await page.evaluate(() => {AtriumInsightsUI.setEnabled(false,{quiet:true}); checkStatus.restore();});
  await page.locator('#status-problems[data-state="ok"]').waitFor();
  assert.equal((await read()).text,"0 problems");
  console.log("D03 same-board check, stale completion, actual zero, cancellation, optional and ineligible work, known findings and disabled Insights passed");
}

async function run(browser) {
  onlyOneOwner();
  const page = await browser.newPage({viewport:{width:1440,height:960}}), errors = [];
  page.setDefaultTimeout(10000);
  page.on("pageerror", e => errors.push(e.message));
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.evaluate(async () => {
      await AtriumLazy.need(["AtriumDRCView", "AtriumDRC", "AtriumMessages", "AtriumEditorWorkflows"]);
      await AtriumNavHost.act("drc");
      const prepare = AtriumDRC.prepare;
      let release;
      AtriumDRC.prepare = () => new Promise(resolve => {release = resolve;});
      window.releaseDRC = () => {AtriumDRC.prepare = prepare; release();};
      window.drc = AtriumDRCView.run({});
    });
    const messages = page.locator(".msg-panel");
    const grid = messages.locator(".msg-grid");
    assert.equal(await grid.getAttribute("aria-busy"), "true");
    assert.match(await messages.locator(".msg-foot").innerText(), /Checking/);
    assert.equal(await page.locator('#status-problems[data-state="checking"]').count(), 1);
    assert.equal(await messages.getByText(/No messages|No problems/).count(), 0);
    assert.equal(await messages.getByRole("button", {name:"Report…", exact:true}).count(), 0);
    await page.evaluate(async () => {
      const h = AtriumNavHost;
      h.edit(() => {
        const tracks = h.doc().items.filter(i => i.kind === "track");
        const a = tracks[0], b = tracks.find(i => i.net && i.net !== a.net);
        a.points = b.points.map(([x,y]) => [x,y + .05]);
      });
      releaseDRC();
      await window.drc;
    });
    await page.waitForFunction(() => document.querySelector(".msg-foot")?.textContent.includes("Run DRC to check this revision."));
    assert.equal(await messages.getByRole("button", {name:"Report…", exact:true}).count(), 0, "the old revision cannot export a success");
    await page.evaluate(async () => {
      await AtriumNavHost.act("drc");
      window.resultRows = AtriumMessages.messages().filter(m => m.group === "DRC");
    });
    assert.ok(await page.evaluate(() => resultRows.some(m => m.drc?.type === "clearance")));
    assert.equal(await page.locator("dialog.drc-panel").count(), 0);
    await messages.locator("button").filter({hasText:/^Units: mm$/}).evaluate(button => button.click());
    assert.ok(await page.evaluate(() => AtriumMessages.messages().some(m => m.drc?.actual != null && /mil/.test(m.text))));
    await messages.getByRole("searchbox").fill("Clearance");
    await messages.locator(".msg-grid tr[data-no]").filter({hasText:"Clearance"}).first().click();
    await messages.locator("button").filter({hasText:/^Locate other object$/}).evaluate(button => {
      if (button.disabled) throw Error("A two-object clearance row must allow locating the other object");
      button.click();
    });
    assert.ok(await page.evaluate(() => AtriumNavHost.selection().some(id => resultRows.some(m => m.drc?.otherId === id))));
    await messages.getByRole("searchbox").fill("rules passed");
    await grid.getByText(/rules passed/).click();
    await messages.getByRole("searchbox").fill("");
    assert.ok(await page.evaluate(() => AtriumMessages.messages().some(m => m.group === "DRC" && m.source === "Rule summary" && /: passed$/.test(m.text))));
    await page.evaluate(() => AtriumNavHost.act("rules"));
    const apply = page.getByRole("button", {name:"Apply & run DRC", exact:true});
    await apply.click();
    await messages.locator("button").filter({hasText:/^Report…$/}).waitFor({state:"attached"});
    assert.equal(await page.locator("dialog.drc-panel").count(), 0);
    await page.evaluate(async () => {
      const h = AtriumNavHost, original = AtriumLazy, painter = await AtriumLazy.need("AtriumDRCMarkers");
      window.markerLoads = 0;
      window.loadMarkers = () => {};
      delete globalThis.AtriumDRCMarkers;
      globalThis.AtriumLazy = {...original, need(names) {
        if (names !== "AtriumDRCMarkers") return original.need(names);
        markerLoads++;
        return new Promise((resolve, reject) => {
          window.loadMarkers = () => {
            if (markerLoads === 1) reject(Error("Injected marker load failure"));
            else {globalThis.AtriumDRCMarkers = painter; resolve(painter);}
          };
        });
      }};
      window.restoreLazy = () => {globalThis.AtriumLazy = original;};
      await AtriumDRCView.run({});
      window.markHit = () => {
        const d = h.doc(), p = h.panes().find(x => x.active);
        const v = AtriumDRCView.violations(d.id).find(v => v.type === "clearance" && v.at);
        const r = p.canvas.getBoundingClientRect(), [x,y] = p.view.worldToScreen(v.at);
        return AtriumDRCView.groupAt(p,r.left+x,r.top+y)?.members.length || 0;
      };
    });
    await page.waitForFunction(() => markerLoads === 1);
    assert.equal(await page.evaluate(() => markHit()), 0, "cold markers have no pointer target");
    await page.evaluate(() => {loadMarkers();});
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("Injected marker load failure"));
    assert.equal(await page.evaluate(() => markHit()), 0, "a failed painter leaves no fallback hit");
    await page.evaluate(() => AtriumDRCView.run({}));
    await page.waitForFunction(() => markerLoads === 2);
    await page.evaluate(() => {loadMarkers(); restoreLazy();});
    await page.waitForFunction(() => markHit() > 0);
    await page.evaluate(async () => {
      const loader = AtriumLazy;
      globalThis.AtriumLazy = {...loader, has:() => false, need:names =>
        names.includes("AtriumDRCView") ? Promise.reject(Error("Injected DRC load failure")) : loader.need(names)};
      try {await AtriumNavHost.act("drc");} finally {globalThis.AtriumLazy = loader;}
    });
    assert.match(await messages.locator(".msg-foot").innerText(), /Could not run Design Rule Check.*Injected DRC load failure/);
    await page.evaluate(() => AtriumNavHost.act("drc"));
    await messages.locator("button").filter({hasText:/^Report…$/}).waitFor({state:"attached"});
    await page.evaluate(async () => {
      const h = AtriumNavHost, ctx = {doc:h.doc(), project:h.project()};
      globalThis.AtriumNavHost = null;
      try {await AtriumEditorWorkflows.checkDRC(ctx);} finally {globalThis.AtriumNavHost = h;}
    });
    assert.match(await messages.locator(".msg-foot").innerText(), /Open a board in the editor/);
    assert.equal(await page.locator("dialog[open]").count(), 0);
    await insightStatus(page);
    assert.deepEqual(errors, []);
    console.log("PASS hosted DRC waits for its revision, filters, locates both objects, changes units, discloses rules and runs from Rules");
  } finally {await page.close();}
}

module.exports = run;
if (require.main === module && process.argv.includes("--guard-only")) onlyOneOwner();
else if (require.main === module) {
  (async () => {
    const browser = await require("../support/playwright.cjs").chromium.launch({...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"}),
      args:["--allow-file-access-from-files"]});
    try {await run(browser);} finally {await browser.close();}
  })().catch(e => {console.error(e); process.exitCode = 1;});
}
