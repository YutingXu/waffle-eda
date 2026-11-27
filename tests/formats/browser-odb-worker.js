"use strict";
const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs");
const {pathToFileURL} = require("node:url");
const R = require("../support/odb-read.cjs");

async function probe(browser) {
  const page = await browser.newPage({viewport:{width:1360,height:900},reducedMotion:"reduce"}), workers = [], errors = [];
  page.on("worker",worker => workers.push(worker.url()));
  page.on("pageerror",error => errors.push(error.message));
  try {
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.getByRole("button",{name:"Continue to editor",exact:true}).click();
    await page.addScriptTag({path:path.join(__dirname,"../pcb/dense-board.js")});
    await page.evaluate(async () => {
      const G = globalThis;
      await G.AtriumLazy.need("AtriumTranslatorClient");
      const {d,defs} = G.makeAtriumBenchmarkBoard();
      const project = G.Atrium.project("ODB dense export",[...defs.values()]);
      project.documents = [d];
      const exportOdb = () => G.AtriumTranslatorClient.export("odb",project,{documentId:d.id,date:"2026-11-22T12:00:00Z"});
      const refused = await exportOdb().catch(error => error.code);
      if (refused !== "butter_disabled") throw Error("ODB++ export starts before opt-in");
      G.AtriumPrefs.set("butter.odb",true);
      G.odbDense = () => {
        const started = performance.now(), frames = [], longTasks = [];
        let pending = true, keyMs = null;
        const observer = new PerformanceObserver(list => {
          for (const row of list.getEntries()) longTasks.push(row.duration);
        });
        observer.observe({type:"longtask"});
        const paint = time => {
          if (!pending) return;
          frames.push(time);
          requestAnimationFrame(paint);
        };
        const key = event => {if (event.isTrusted && pending) keyMs = performance.now()-started;};
        addEventListener("keydown",key);
        G.odbDensePending = true;
        requestAnimationFrame(paint);
        return exportOdb().then(({files,report}) => {
          const bytes = new Uint8Array(files[0].bytes);
          let raw = "";
          for (let i = 0; i < bytes.length; i += 16384) raw += String.fromCharCode(...bytes.subarray(i,i+16384));
          const diffs = frames.slice(1).map((time,index) => time-frames[index]);
          return {data:btoa(raw),file:files[0].name,records:d.items.length,ms:performance.now()-started,
            painting:frames.length,maxFrameGap:Math.max(...diffs,0),keyMs,longTasks,report:report.format};
        }).finally(() => {
          pending = false;
          G.odbDensePending = false;
          removeEventListener("keydown",key);
          observer.disconnect();
        });
      };
    });
    // The export and a trusted editor event overlap. No test-only Worker serves the result.
    const exportStarted = page.evaluate(() => globalThis.odbDense());
    await Promise.race([page.waitForFunction(() => globalThis.odbDensePending === true),exportStarted]);
    await page.keyboard.press("Shift");
    const {data,...metrics} = await exportStarted;
    assert.equal(metrics.records,25600);
    assert.ok(workers.some(url => /import-worker\.js/.test(url) || url.startsWith("blob:")), workers.join(", "));
    assert.ok(metrics.painting > 1 && metrics.keyMs !== null && metrics.keyMs < metrics.ms, JSON.stringify(metrics));
    assert.ok(metrics.maxFrameGap < 120 && metrics.longTasks.every(ms => ms < 120), JSON.stringify(metrics));
    assert.match(metrics.file,/\.tgz$/);
    const bytes = Buffer.from(data,"base64"), result = R.read(bytes);
    const features = [...result.steps.get("pcb").layers.values()].reduce((n,row) => n + row.features.length,0);
    assert.ok(features >= 25600, "The worker archive should contain the authored workload");
    if (process.env.WAFFLE_ODB_DENSE_ARTIFACT) fs.writeFileSync(process.env.WAFFLE_ODB_DENSE_ARTIFACT,bytes);
    assert.deepEqual(errors,[]);
    console.log("ODB++ browser worker " + JSON.stringify({...metrics,features,bytes:bytes.length}));
  } finally {
    await page.close();
  }
}

async function releaseProbe(browser) {
  const page = await browser.newPage({viewport:{width:1360,height:900},reducedMotion:"reduce"}), errors = [];
  page.on("pageerror",error => errors.push(error.message));
  const date = "2026-01-02T03:04:05Z", preset = "ODB++ fabrication";
  try {
    await page.clock.setFixedTime(new Date(date));
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.getByRole("button",{name:"Try the Demo",exact:true}).click();
    await page.waitForFunction(()=>AtriumNavHost.project().name==="Sensor interface" && !AtriumStartPage.isOpen());
    const file = page.locator('.menubar [data-menu="file"]');
    const release = page.getByRole("dialog",{name:"Release",exact:true});
    const jobs = release.getByRole("combobox",{name:"Job set"});
    async function open() {
      await file.locator(":scope > summary").click();
      await file.getByRole("menuitem",{name:"Release…",exact:true}).click();
      await jobs.waitFor();
    }
    await open();
    assert.equal(await jobs.locator("option").filter({hasText:preset}).count(),0);
    await release.getByRole("button",{name:"Close",exact:true}).click();
    await page.evaluate(()=>AtriumPrefs.set("butter.odb",true));
    await open();
    await jobs.selectOption({label:preset});
    const card = release.locator('article[data-kind="odb"]');
    await card.locator(".rel-state.is-ok").waitFor();
    assert.match(await card.locator(".rel-files").innerText(),/\.tgz/);
    await release.getByRole("button",{name:"Run checks",exact:true}).click();
    await release.getByRole("tab",{name:/Pre-flight/}).click();
    await release.locator(".rel-checks").waitFor();
    const failed = release.locator(".rel-check.is-fail");
    const names = await failed.locator("strong").allTextContents();
    assert.ok(names.every(name=>/DRC|ERC/.test(name)),names.join(", "));
    for (const name of names) {
      const check = failed.filter({hasText:name});
      await check.getByRole("button",{name:"Override…",exact:true}).click();
      await check.getByRole("textbox",{name:`Reason for overriding ${name}`}).fill("Expected demo fixture findings.");
      await check.getByRole("button",{name:"Override",exact:true}).click();
    }
    await release.getByRole("button",{name:"Run pre-flight, then make the versioned release package"}).click();
    const published = release.getByRole("region",{name:"Released packages"});
    await published.getByText("Save single files (for upload forms)",{exact:true}).click();
    const download = page.waitForEvent("download");
    await published.getByRole("button",{name:/^Save .*\.tgz$/}).click();
    const output = await download;
    assert.match(output.suggestedFilename(),/\.tgz$/);
    const product = R.read(fs.readFileSync(await output.path()));
    assert.ok(product.entries.get("misc/info").includes(Buffer.from("ODB_VERSION_MINOR=1")));
    assert.ok(product.entries.has("steps/pcb/eda/data"));
    assert.ok(product.entries.has("steps/pcb/netlists/cadnet/netlist"));
    assert.ok(product.steps.get("pcb").layers.size>3);
    assert.deepEqual(errors,[]);
    console.log("ODB++ Release dialog " + JSON.stringify({preset,date,overrides:names,archive:output.suggestedFilename(),entries:product.entries.size}));
  } finally { await page.close(); }
}

if (require.main === module) {
  const {chromium} = require("../support/playwright.cjs");
  (async() => {
    const browser = await chromium.launch({...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"}),
      args:["--allow-file-access-from-files"]});
    try {
      const stage = process.env.WAFFLE_ODB_STAGE;
      if (!stage || stage === "worker") await probe(browser);
      if (!stage || stage === "release") await releaseProbe(browser);
    } finally { await browser.close(); }
  })().catch(error => {console.error(error);process.exitCode=1;});
}
module.exports = probe;
