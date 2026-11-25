"use strict";

const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const {pathToFileURL} = require("node:url");
require("../../app/core/zip.js");
require("../../app/formats/import-sidecars.js");

const fixture = path.join(__dirname, "../fixtures/butter-acceptance/saved-views");
async function entries(folder, prefix = "") {
  const result = [];
  for (const item of await fs.readdir(folder, {withFileTypes:true})) {
    const name = prefix + item.name, file = path.join(folder, item.name);
    if (item.isDirectory()) result.push(...await entries(file, name + "/"));
    else result.push({name, data:await fs.readFile(file)});
  }
  return result;
}

module.exports = async function savedViews(browser) {
  const page = await browser.newPage({viewport:{width:1330,height:840},acceptDownloads:true});
  page.setDefaultTimeout(9000);
  const requests = [], errors = [];
  page.on("request", request => {if (request.resourceType() === "script") requests.push(request.url().split("/").pop());});
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Continue to editor",exact:true}).click();
    const cold = await page.evaluate(() => ({readyMs:performance.now(),heap:performance.memory?.usedJSHeapSize ?? null}));
    assert.ok(!requests.some(name => name.startsWith("butter-") || name === "saved-views.js"), "default startup stays cold");
    const {IGNORE,ignoreText} = AtriumImportSidecars;
    const bytes = AtriumZip.create([...await entries(fixture), {name:IGNORE, data:ignoreText}]);
    await page.locator("#file-input").setInputFiles({name:"Study.zip",mimeType:"application/zip",buffer:Buffer.from(bytes)});
    await page.getByRole("dialog", {name:"Open project ZIP",exact:true}).getByRole("button", {name:"Open project",exact:true}).click();
    await page.waitForFunction(() => AtriumNavHost.project().name === "Saved-view study");
    await page.evaluate(() => AtriumLazy.need("AtriumPrefs").then(prefs => prefs.set("butter.savedViews",true)));
    await page.waitForFunction(() => globalThis.AtriumButterEditor);

    const proof = await page.evaluate(async () => {
      const host = AtriumNavHost, apply = (id, args) => AtriumButterEditor.apply("butter.savedViews." + id, args);
      const [board, schematic] = host.project().savedViews.map(view => view.id);
      const prior = {dirty:host.isDirty(), undo:host.undoSteps().history.length};
      const start = performance.now(), applied = (await apply("apply", {id:board})).result, firstApplyMs = performance.now() - start;
      const {viewport,camera,layers} = host.captureViewState(), selection = host.selection(), filter = AtriumQuery.applied();
      const warmApplyMs = [];
      for (let n=0; n<8; n++) {
        const start = performance.now();
        await apply("apply", {id:board});
        warmApplyMs.push(performance.now()-start);
      }
      await apply("present", {ids:[board,schematic]});
      const next = (await apply("step", {})).result;
      const moving = {active:host.currentId(), filter: AtriumQuery.applied(), dirty:host.isDirty(), undo:host.undoSteps().history.length};
      await apply("capture", {name:"Local live schematic"});
      const captured = host.project().savedViews.at(-1), undoDelta = host.undoSteps().history.length - moving.undo;
      host.act("undo");
      const undone = host.project().savedViews.every(view => view.id !== captured.id);
      host.act("redo");
      const redone = host.project().savedViews.at(-1).id === captured.id;
      return {applied,viewport,camera,layers,selection,filter,next,moving,prior,captured,undoDelta,undone,redone,firstApplyMs,warmApplyMs};
    });
    assert.equal(proof.applied.status,"ready");
    assert.deepEqual(proof.applied.filter.rows,[{id:"run"}]);
    assert.deepEqual(proof.selection,["run"]);
    assert.deepEqual(proof.layers,{active:"Top",mode:"single",hidden:["Bottom"]});
    assert.deepEqual([proof.camera.cx,proof.camera.cy,proof.camera.flipped,proof.camera.rotation],[5,4,true,.125]);
    const scale = 45 * Math.min(proof.viewport.pixelWidth/960,proof.viewport.pixelHeight/660);
    assert.ok(Math.abs(proof.camera.scale-scale)<1e-8);
    assert.deepEqual(proof.filter.ids,["run"]);
    assert.equal(proof.next.index,1);
    assert.equal(proof.prior.dirty,false);
    assert.deepEqual(proof.moving,{active:"top",filter:null,...proof.prior});
    assert.equal(proof.captured.documentId,"top");
    assert.equal(proof.captured.name,"Local live schematic");
    assert.equal(proof.undoDelta,1);
    assert.ok(proof.undone && proof.redone);

    const [download, exported] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => {
      const ids = AtriumNavHost.project().savedViews.slice(0,2).map(view => view.id);
      return AtriumButterEditor.apply("butter.savedViews.export-pdf", {ids});
    })]);
    assert.equal(exported.result.pageCount,2);
    assert.equal(exported.result.links,2);
    const pdf = (await fs.readFile(await download.path())).toString("latin1");
    assert.match(pdf,/^%PDF-/);
    assert.equal((pdf.match(/\/Type \/Page /g) ?? []).length,2);
    assert.equal((pdf.match(/\/Subtype \/Link /g) ?? []).length,2);
    assert.doesNotMatch(pdf,/\/Subtype \/Image\b/);

    const filters = await page.evaluate(async () => {
      const host = AtriumNavHost;
      await AtriumButterEditor.apply("butter.savedViews.apply",{id:host.project().savedViews[0].id});
      const command = (name,args) => AtriumButterEditor.apply("butter.savedViews."+name,args);
      const original = host.project().savedViews[0];
      const source = "pad near origin of TP1 within 1 mm";
      AtriumPrefs.set("butter.query",true);
      const named = (await AtriumButterEditor.apply("butter.query.save-query",
        {name:"Probe pad",source,scope:{documentId:original.documentId}})).result.record;
      const base = {documentId:original.documentId,camera:original.camera,viewport:original.viewport,selection:[]};
      const capture = async (name,scope) => (await command("capture",
        {name,view:{...base,filter:{scope,mask:true,highlight:true}}})).result.view;
      const bound = await capture("Bound pad",named.query);
      const namedView = await capture("Named pad",{savedQueryId:named.id});
      const boundApplied = (await command("apply",{id:bound.id})).result;
      const boundCopy = (await command("capture",{name:"Bound recapture"})).result.view;
      const namedApplied = (await command("apply",{id:namedView.id})).result;
      const namedCopy = (await command("capture",{name:"Named recapture"})).result.view;
      const board = host.project().documents.find(doc => doc.id === original.documentId);
      const jobs = [original,bound].map(saved => {
        const resolved = saved === original ? {...saved,filter:undefined} : boundApplied;
        return {...resolved,title:saved.name,camera:AtriumSavedViews.restore(saved.camera)};
      });
      jobs.push({...jobs[1],title:"Incomplete",filter:{...jobs[1].filter,status:"partial"}});
      const [selected,masked,incomplete] = AtriumPrint.build(host.project(),{presentation:jobs,attachments:false}).pages;
      const colorSamples = [selected,...["grey","mono"].map(color =>
        AtriumPrint.build(host.project(),{presentation:jobs.slice(0,1),attachments:false,color}).pages[0])];
      const item = board.items.find(item => item.id === "run");
      const segment = page => {
        const [a,b] = item.points.slice(0,2).map(page.map);
        return page.list.filter(op => {
          const path = op.d;
          return path && op.w && path[0] === 0 && path[3] === 1 &&
            [a[0],a[1],b[0],b[1]].every((v,i) => Math.abs(v-path[[1,2,4,5][i]]) < .01);
        });
      };
      const isDim = op => op.fill && op.a === .7 && op.c.every((v,i) => i === 3 || v === 1);
      return {boundScope:named.query,boundCopy:boundCopy.filter?.scope,namedScope:{savedQueryId:named.id},namedCopy:namedCopy.filter?.scope,
        boundResult:boundApplied.filter,namedResult:namedApplied.filter,namedReady:namedApplied.status,
        selected:colorSamples.map(page => segment(page).map(op => op.c.slice(0,3))),
        dimmed:masked.list.some(isDim),trackPresent:!!segment(masked).length,
        subitemOutline:masked.list.filter(op => op.a === .9 && op.w && op.d?.length === 13).length,
        incompleteDimmed:incomplete.list.some(isDim)};
    });
    assert.ok(filters.boundScope.bindings.length);
    assert.deepEqual(filters.boundCopy,filters.boundScope,JSON.stringify(filters.boundResult));
    assert.deepEqual(filters.namedCopy,filters.namedScope,JSON.stringify(filters.namedResult));
    assert.equal(filters.namedReady,"ready");
    assert.equal(filters.boundResult.rows.length,1);
    assert.equal(filters.boundResult.rows[0].ownerId,"probe");
    assert.ok(filters.selected.every(sample => sample.some(rgb => rgb.some(channel => channel < .6))),
      "selected copper remains visible on white in all three color modes");
    assert.ok(filters.dimmed && filters.trackPresent && filters.subitemOutline === 1);
    assert.equal(filters.incompleteDimmed,false);

    const point = await page.evaluate(async () => {
      const host = AtriumNavHost, D = await AtriumLazy.need("AtriumDrawing");
      await host.selectDocument("draw");
      const doc = host.doc(), box = D.contextFor(host.project(),doc);
      const item = doc.drawing.views[0], bounds = AtriumDrawingViews.box(item,box), [x,y] = D.sheetOrigins(doc.drawing)[0];
      const cx = x + (bounds[0]+bounds[2])/2, cy = y + (bounds[1]+bounds[3])/2;
      const view = host.view();
      view.restoreCamera({...view.camera(),cx,cy,scale:12});
      host.redraw(true);
      const [u,v] = view.worldToScreen([cx,cy]), rect = host.canvas().getBoundingClientRect();
      return [u+rect.left,v+rect.top];
    });
    await page.mouse.click(...point);
    const drawing = await page.evaluate(async () => {
      const host = AtriumNavHost, apply = (name,args) => AtriumButterEditor.apply("butter.savedViews."+name,args);
      const [board,schematic] = host.project().savedViews;
      const captured = (await apply("capture",{name:"Drawing object"})).result.view;
      await apply("present",{ids:[board.id,schematic.id,captured.id]});
      await apply("remove",{id:schematic.id});
      const skipped = (await apply("step")).result;
      const reached = (await apply("step")).result;
      return {captured:captured.selection,restored:AtriumDrawing.selection(),skipped:skipped.status,reached:reached.view.status};
    });
    assert.deepEqual(drawing,{captured:["view"],restored:["view"],skipped:"missing-view",reached:"ready"});
    assert.deepEqual(errors,[]);
    console.log("PASS Saved Views editor capture, local sequencing, one-step Undo and linked vector PDF",JSON.stringify({
      cold, firstApplyMs:proof.firstApplyMs, warmApplyMs:proof.warmApplyMs
    }));
  } finally {await page.close();}
};

if (require.main === module) (async () => {
  const {chromium} = require("playwright-core");
  const browser = await chromium.launch(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"});
  try {await module.exports(browser);}
  finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
