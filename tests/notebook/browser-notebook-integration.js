"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const {nativeRecords} = require("../support/native-cad.cjs");
for (const name of ["format-2-closure","import-sidecars","zip","project-archive","widget-catalogue","sheet-widgets"])
  require(require("../support/app-source-paths.cjs").appFile(name+".js"));

async function notebookZIP() {
  // Keep the frozen native RC calculation and both of its library owners byte for byte.
  const original = nativeRecords("calculation"), manifestPath = "Project.waffle";
  const sheet = Atrium.sheet("schematic","Release checks");
  sheet.id = "release-checks";
  let n = 0;
  const makeId = () => "release-"+(++n), widgets = AtriumSheetWidgets;
  const table = widgets.make("table",[24,44],{makeId});
  const todo = widgets.make("todo",[24,70],{makeId,argument:"Verify cutoff frequency"});
  const [name,value] = table.widget.state.columns.map(c=>widgets.keyFor(c.id));
  Object.assign(table.widget.state.rows[0],{[name]:{kind:"literal",text:"Cutoff frequency"},
    [value]:{kind:"calculation",documentId:"timing",blockId:"corner"}});
  todo.widget.state.rows[0].done = true;
  sheet.items.push(table,todo,{id:"formula",kind:"textframe",x:24,y:25,w:42,h:14,math:true,text:"\\frac{V}{R}"},
    {id:"method",kind:"textframe",x:24,y:15,w:105,h:8,text:"Measure with the load connected.",
      richText:{blocks:[{style:"paragraph",runs:[{type:"text",text:"Measure with the load connected.",bold:true}]}]}});
  const ref={kind:"document",docKind:sheet.kind,id:sheet.id,name:sheet.name,path:"Release checks.wsch",order:"j"};
  const manifest=AtriumFormat2.applyDelta(original.manifest,{put:[ref]}).file;
  const files=new Map([[manifestPath,AtriumFormat2.serialize(manifest)],
    [ref.path,AtriumFormat2.serialize(AtriumFormat2Model.createDocument(sheet))],
    [AtriumImportSidecars.IGNORE,AtriumImportSidecars.ignoreText]]);
  const read=name=>files.get(name) ?? original.read(name);
  const verified=await AtriumProjectArchive.verifyClosure({manifestPath,read});
  assert.equal(verified.manifest.header.formatVersion,"2.0");
  const {name:filename,bytes}=await AtriumProjectArchive.archive({...verified,read});
  return {name:filename,mimeType:"application/zip",buffer:Buffer.from(bytes)};
}

async function pick(page,file,payload) {
  await file.locator("summary").click();
  const [chooser]=await Promise.all([page.waitForEvent("filechooser"),file.locator('[data-action="open"]').click()]);
  await chooser.setFiles(payload);
}

function installRetainedCalculationProbe() {
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, options) {
    // Keep readback from changing the active canvas's raster backend between the two frames.
    return getContext.call(this, type, type === "2d" && this.id === "canvas" ? {...options, willReadFrequently: true} : options);
  };
  const owners = window.notebookRetained = {};
  for (const id of ["timing", "release-checks"]) {
    let resolve;
    const delivered = new Promise(done => { resolve = done; });
    owners[id] = {waiting: true, delivered, release() { this.waiting = false; resolve(); }};
  }
  Object.defineProperty(window, "AtriumCalculations", {configurable: true, set(calc) {
    const target = options => options?.documentId === "timing" && options.blockId === "corner" &&
      owners[window.AtriumNavHost?.currentId()];
    Object.defineProperty(window, "AtriumCalculations", {configurable: true, writable: true, value: {
      ...calc,
      peek(project, options) { return target(options)?.waiting ? null : calc.peek(project, options); },
      evaluate(project, options) {
        const outcome = calc.evaluate(project, options), owner = target(options);
        return owner?.waiting ? outcome.then(result => {
          owner.value = result.records[0]?.result.display;
          return owner.delivered.then(() => result);
        }) : outcome;
      }
    }});
  }});
  Object.defineProperty(window, "AtriumCanvasFast", {configurable: true, set(fast) {
    Object.defineProperty(window, "AtriumCanvasFast", {configurable: true, writable: true, value: {
      ...fast,
      reuse(view, doc, ...args) {
        const reused = fast.reuse(view, doc, ...args);
        if (owners[doc.id] && view.canvas === window.AtriumNavHost?.canvas()) owners[doc.id].reused = reused;
        return reused;
      },
      saved(view, doc, defs, options, ms, count) {
        // Exercise the normal dense-sheet retention branch regardless of machine speed.
        const subject = owners[doc.id]?.force && view.canvas === window.AtriumNavHost?.canvas();
        return fast.saved(view, doc, defs, options, ms, subject ? Math.max(count, 300) : count);
      }
    }});
  }});
}

async function checkRetainedCalculation(page, id) {
  await page.waitForFunction(doc => window.notebookRetained[doc].value === "15.92 kHz", id);
  const result = await page.evaluate(async id => {
    const host = AtriumNavHost, owner = window.notebookRetained[id], canvas = host.canvas();
    const item = host.doc().items.find(i => id === "timing" ? i.id === "corner" : i.widget?.type === "table");
    const frame = run => new Promise((done,reject) => {
      const off = host.on("frame", () => { clearTimeout(timeout); off(); done(); });
      const timeout = setTimeout(() => { off(); reject(Error("Missing canvas frame for " + id)); }, 4000);
      run();
    });
    await document.fonts.ready;
    owner.force = true;
    await frame(() => host.invalidateDocument(id, true));
    const deadline = performance.now() + 4000;
    do { await frame(() => host.redraw()); } while (!owner.reused && performance.now() < deadline);
    const reused = owner.reused;
    const ratio = canvas.width / canvas.clientWidth, view = host.view();
    const [x, y] = view.worldToScreen([item.x, item.y]).map(n => Math.max(0, Math.floor(n * ratio)));
    const [r, b] = view.worldToScreen([item.x + item.w, item.y + item.h]).map(n => Math.ceil(n * ratio));
    const pixels = () => canvas.getContext("2d").getImageData(x, y, r - x, b - y).data;
    const same = (a, b) => a.every((byte, index) => byte === b[index]);
    const fallback = pixels();
    await new Promise((done,reject) => {
      const invalidate = host.invalidateDocument;
      const timeout = setTimeout(() => { host.invalidateDocument = invalidate; reject(Error("Missing calculation publication for " + id)); }, 4000);
      host.invalidateDocument = (doc, artwork) => {
        if (doc !== id) return invalidate(doc, artwork);
        host.invalidateDocument = invalidate;
        clearTimeout(timeout);
        frame(() => invalidate(doc, artwork)).then(done,reject);
      };
      owner.release();
    });
    const settled = pixels();
    await frame(() => host.invalidateDocument(id, true));
    const fresh = pixels();
    owner.force = false;
    return {reused, freshShowsResult: !same(fallback, fresh), matchesFresh: same(settled, fresh)};
  }, id);
  assert.deepEqual(result, {reused:true, freshShowsResult:true, matchesFresh:true}, id + " calculation repaints retained canvas artwork");
}

module.exports = async function notebookIntegration(browser) {
  const root = path.resolve(__dirname,"../..");
  const old = path.join(__dirname,"../fixtures/compat/projects/v1.4-calculation-frame.waffle");
  const archive = await notebookZIP();
  const screenshots = process.env.NOTEBOOK_REVIEW_DIR;
  for (const theme of ["light","dark"]) {
    const context = await browser.newContext({viewport:{width:1400,height:950},acceptDownloads:true,reducedMotion:"reduce"});
    try {
      await context.route(/^https?:/, route => route.abort());
      await context.addInitScript(installRetainedCalculationProbe);
      await context.addInitScript(() => {
        const workers = [];
        window.notebookTestWorkers = workers;
        window.Worker = new Proxy(window.Worker,{
          construct(target,args) { workers.push(String(args[0])); return Reflect.construct(target,args); }
        });
        const fillText = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function(text,...args) {
          if (text === "15.92 kHz" && globalThis.AtriumNavHost?.currentId() === "release-checks")
            window.notebookTestTablePainted = true;
          return fillText.call(this,text,...args);
        };
      });
      const page = await context.newPage(), errors = [];
      page.on("pageerror",e=>errors.push(e.message));
      page.setDefaultTimeout(10000);
      await page.goto(pathToFileURL(path.join(root,"app","index.html")).href);
      await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
      await page.locator("#doc-name",{hasText:"Sensor board"}).waitFor();
      await page.waitForFunction(()=>globalThis.AtriumEditorDemand && globalThis.AtriumCamera);
      const cold = await page.evaluate(()=>({
        scripts:performance.getEntriesByType("resource").map(e=>e.name.split("/").at(-1)).filter(name=>
          /^(?:notebook|note-fields|rich-text|math(?:-|\.)|stix-two-math|calculation|sheet-widget|review-notes|widget-catalogue|board-shape-sources)/.test(name)),
        workers:window.notebookTestWorkers.filter(url=>/notebook|math|calc|widget/i.test(url))
      }));
      assert.deepEqual(cold,{scripts:[],workers:[]},"ordinary file editor starts no notebook feature work");
      assert.equal(await page.evaluate(()=>AtriumLabs.notebookEnabled()),false);
      const file=page.locator('.menubar [data-menu="file"]');
      const before=await page.evaluate(()=>[AtriumNavHost.project().name,AtriumNavHost.currentId(),AtriumNavHost.revision()]);
      await pick(page,file,old);
      const refusal=page.getByRole("dialog",{name:"Couldn’t open this file"});
      await refusal.getByText("This file is from a pre-release Waffle build; re-import the design from its source EDA",{exact:true}).waitFor();
      assert.deepEqual(await page.evaluate(()=>[AtriumNavHost.project().name,AtriumNavHost.currentId(),AtriumNavHost.revision()]),before);
      await refusal.getByRole("button",{name:"Done"}).click();

      await file.locator("summary").click();
      await file.locator('[data-action="preferences"]').click();
      const prefs=page.getByRole("dialog",{name:"Preferences"});
      await prefs.getByRole("button",{name:"Experimental features",exact:true}).click();
      await prefs.getByRole("switch",{name:"Enable notebook features",exact:true}).check();
      await prefs.getByRole("button",{name:"Close Preferences",exact:true}).click();
      await prefs.waitFor({state:"hidden"});
      await page.evaluate(theme=>AtriumTheme.set({preset:theme,followSystem:false,motion:"off"},{persist:false}),theme);
      await pick(page,file,archive);
      await page.getByRole("dialog",{name:"Open project ZIP"}).getByRole("button",{name:"Open project",exact:true}).click();
      await page.waitForFunction(()=>AtriumNavHost.folderProject()?.temporary && AtriumNavHost.doc().id==="timing");
      await checkRetainedCalculation(page, "timing");
      await page.locator('#documents [data-doc="release-checks"]').click();
      await checkRetainedCalculation(page, "release-checks");
      await page.waitForFunction(()=>{
        const h=AtriumNavHost, doc=h.doc(), table=doc.items.find(i=>i.widget?.type==="table");
        return window.notebookTestTablePainted && table &&
          globalThis.AtriumSheetWidgetRuntime?.preparedView(h.project(),doc,table,h.revision())?.rows[1]?.cells[1]?.text==="15.92 kHz";
      });
      const jobs = await page.evaluate(()=>AtriumCalculations.stats().jobs);
      if (screenshots) {
        await fs.mkdir(screenshots,{recursive:true});
        await page.screenshot({path:path.join(screenshots,"notebook-canvas-"+theme+".png")});
      }
      await file.locator("summary").click();
      await file.locator("#sub-file-export > .submenu-trigger").hover();
      await file.getByRole("menuitem",{name:"PDF…",exact:true}).click();
      const dialog = page.getByRole("dialog",{name:"Export PDF",exact:true});
      await dialog.getByRole("button",{name:"Current document",exact:true}).click();
      const thumb = dialog.getByRole("img",{name:"Release checks",exact:true});
      await thumb.waitFor();
      await page.waitForFunction(()=>document.querySelectorAll(".print-pages img").length===1);
      const preview = await thumb.evaluate(async img=>{
        const xml=await (await fetch(img.src)).text();
        const svg=new DOMParser().parseFromString(xml,"image/svg+xml");
        return {
          text:[...svg.querySelectorAll("text")].map(n=>n.textContent).join(" ").replace(/\s+/g," "),
          mathGlyphs:svg.querySelectorAll('use[href^="#math-"]').length
        };
      });
      assert.match(preview.text,/Measure with the load connected\s*\./);
      assert.match(preview.text,/15\.92 kHz/);
      assert.match(preview.text,/☑ Verify cutoff frequency/);
      assert.ok(preview.mathGlyphs >= 2,"the schematic preview draws the fraction as vectors");
      if (screenshots) {
        await fs.mkdir(screenshots,{recursive:true});
        await page.screenshot({path:path.join(screenshots,"notebook-preview-"+theme+".png")});
      }
      const [download] = await Promise.all([page.waitForEvent("download"),dialog.getByRole("button",{name:"Export PDF…",exact:true}).click()]);
      const bytes = await fs.readFile(await download.path()), pdf = bytes.toString("latin1");
      assert.match(pdf,/^%PDF-/);
      assert.match(pdf,/\/Count 1\b/);
      assert.match(pdf,/\/Type0\b/);
      assert.match(pdf,/\/EmbeddedFiles\b/);
      assert.doesNotMatch(pdf,/\/Subtype\s+\/Image\b/,"the notebook print remains vector");
      assert.equal(await page.evaluate(()=>AtriumCalculations.stats().jobs),jobs,"export starts no live calculation job");
      assert.deepEqual(errors,[]);
      if (screenshots) await fs.writeFile(path.join(screenshots,"notebook-export-"+theme+".pdf"),bytes);
    } finally { await context.close(); }
  }
  console.log("PASS cold Labs-off startup, pre-release refusal, verified 2.0 ZIP, retained 15.92 kHz calculation and table artwork, and vector Smart PDF in Light and Dark");
};
