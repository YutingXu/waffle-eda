"use strict";
// Count minimap callbacks around ordinary, committed editor edits and compare the visible bitmap.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require("../support/playwright.cjs");

async function run() {
  const browser = await chromium.launch({channel:"chrome"});
  try {
    const page = await browser.newPage({viewport:{width:1420,height:940},reducedMotion:"reduce"});
    const errors = [];
    const power = process.argv.includes("--normal-power") ? "off" : "always";
    page.on("pageerror", error => errors.push(error.message));
    await page.route(/^https?:/, route => route.abort());
    await page.clock.install();
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => globalThis.AtriumNavHost?.doc());
    await page.evaluate(async power => {
      const host = AtriumNavHost;
      await AtriumLazy.need(["AtriumMinimap","AtriumUndoStore"]);
      const board = host.project().documents.find(d => d.kind==="pcb" && d.items.some(i => i.kind==="part"));
      if (!board) throw Error("The demo must have a populated PCB.");
      await host.selectDocument(board.id);
      if (host.doc()!==board) throw Error("The demo PCB must be active.");
      AtriumPower.setMode(power);
      const part = board.items.find(i => i.kind==="part");
      if (!host.edit(() => { part.value="Before the comment edit"; },"Set up the minimap probe",[part]) ||
          !AtriumUndoStore.documentVersions(board,host.project())) throw Error("The probe needs a committed journal cursor.");
      AtriumMinimap.show(true);
      AtriumMinimap.repaint();
      const bitmap = () => document.querySelector(".cam-minimap-base").toDataURL();
      const idle = AtriumIdle;
      const stats = {queued:0, delivered:0};
      globalThis.AtriumIdle = {...idle,idle(callback,options) {
        if (!String(callback).includes("paintBase()")) return idle.idle(callback,options);
        stats.queued++;
        return idle.idle(deadline => { stats.delivered++; callback(deadline); },options);
      }};
      globalThis.minimapProbe = {
        begin() { Object.assign(stats,{queued:0,delivered:0}); this.before=bitmap(); },
        edit(field,value) {
          if (!host.edit(() => { part[field]=value; },"Change part in test",[part])) throw Error("Editor edit failed.");
        },
        report() { return {...stats,pixelsUnchanged:this.before===bitmap()}; },
        fullAgrees() {
          const incremental=bitmap();
          AtriumMinimap.show(false);
          AtriumMinimap.show(true);
          AtriumMinimap.repaint();
          return incremental===bitmap();
        },
        movedX:part.x+5
      };
    },power);
    await page.evaluate(() => { minimapProbe.begin(); minimapProbe.edit("value","Only the component comment changed"); });
    await page.clock.runFor(350);
    const comment = await page.evaluate(() => minimapProbe.report());
    const baseline = process.argv.includes("--baseline");
    assert.deepEqual(comment,{queued:baseline?1:0,delivered:baseline?1:0,pixelsUnchanged:true});
    assert.equal(await page.evaluate(() => minimapProbe.fullAgrees()),true);

    await page.evaluate(() => { minimapProbe.begin(); minimapProbe.edit("x",minimapProbe.movedX); });
    await page.waitForFunction(() => minimapProbe.report().delivered>=1);
    const move = await page.evaluate(() => minimapProbe.report());
    assert.deepEqual(move,{queued:1,delivered:1,pixelsUnchanged:false});
    assert.equal(await page.evaluate(() => minimapProbe.fullAgrees()),true);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({browser:browser.version(),baseline,power,comment,move,fullPaintMatches:true}));
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode=1; });
