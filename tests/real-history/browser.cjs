"use strict";
// A real File › Open, native bridge, history worker, IndexedDB and Compare. Only the native
// file chooser and its transport are adapted to headless Chrome. Git uses the installed host helper.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const {createStaticServer} = require("../support/browser-app-server.cjs");
const path = require("node:path");
const {createHash} = require("node:crypto");
const {promisify} = require("node:util");
const exec = promisify(require("node:child_process").execFile);
const {chromium} = require("playwright-core");
const root = path.resolve(__dirname, "../..");
const [design, rowsPath, output, shots, publicRevision] = process.argv.slice(2);

async function query(op,args) {
  const {stdout} = await exec("python3", ["-I", "-B", path.join(root,"native/git_head.py"), "--project", design,
    "--query", op, "--args=" + JSON.stringify(args)], {maxBuffer: 96 * 1024 * 1024});
  return JSON.parse(stdout);
}
async function workingFiles(files) {
  return Promise.all(files.map(async (file,i) => {
    let data = file.data;
    // Public LFS working copies may be materialised. Verify the original pointer's SHA and
    // declared byte count before using the pre-existing, explicitly supplied public release.
    const pointer = Buffer.from(data,"base64").toString("utf8",0,220).match(/^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\s*$/);
    if (pointer && process.env.WAFFLE_HISTORY_PUBLIC_LFS) {
      const bytes = await fs.readFile(path.join(process.env.WAFFLE_HISTORY_PUBLIC_LFS,path.basename(file.name)));
      assert.equal(bytes.length,Number(pointer[2]));
      assert.equal(createHash("sha256").update(bytes).digest("hex"),pointer[1]);
      data = bytes.toString("base64");
    }
    return {name:file.name,data,altiumPath:file.altiumPath,...(i ? {} : {historyToken:"selected-design"})};
  }));
}
async function main() {
  const rows = (await fs.readFile(rowsPath,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
  const listing = await query("projectLog",{limit:1000});
  const head = await query("sourceRevision",{revision:listing.head});
  const files = await workingFiles(head.files);
  const publicSources = JSON.parse(await fs.readFile(path.join(__dirname,"sources.json"),"utf8"));
  const publicDesign = publicSources.find(r=>r.design && r.head===listing.head && design.endsWith(path.sep+r.design.split("/").join(path.sep)));
  if (shots && !publicDesign) throw Error("Screenshots require a pinned public design from the manifest.");
  if (publicRevision && (!publicDesign || !/^[a-f0-9]{8,64}$/.test(publicRevision)))
    throw Error("A selected screenshot revision must identify a pinned public design commit.");
  const server = createStaticServer({
    base: root,
    roots: [path.join(root,"app"), path.join(root,"extensions")],
    body: "buffer",
    mime: {".html":"text/html",".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml",".wasm":"application/wasm"},
  });
  const browser = await chromium.launch({headless:true,...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"})});
  const page = await browser.newPage({viewport:{width:1380,height:880}});
  page.setDefaultTimeout(90000);
  const metrics = {commits:listing.commits.length,merges:listing.commits.filter(c=>c.parents.length>1).length};
  const errors = [], queries = [];
  page.on("pageerror",e=>errors.push(e.message));
  try {
    await new Promise(done=>server.listen(0,"127.0.0.1",done));
    await page.exposeFunction("nativeCall",async raw=>{
      const m = JSON.parse(raw);
      if (m.action==="open") return files;
      if (m.action==="gitQuery") {
        assert.equal(m.token,"selected-design");
        queries.push(m.op);
        return query(m.op,m.args);
      }
      return null;
    });
    const bridge = await fs.readFile(path.join(root,"native/bridge.js"),"utf8");
    await page.addInitScript({content:'window.__waffleTopFramePost = raw => {const m = JSON.parse(raw); window.nativeCall(raw).then(v => window.__atriumReceive(m.id,v), e => window.__atriumReceive(m.id,null,e.message));};\n'+bridge});
    const url = "http://127.0.0.1:"+server.address().port+"/app/index.html";
    const open = async ()=>{
      await page.goto(url);
      await page.locator("#canvas").waitFor();
      await page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Open…", exact:true}).click();
      await page.waitForFunction(()=>!!window.AtriumHost.historyPath);
      assert.equal(await page.evaluate(()=>AtriumHost.projectPath),null);
    };
    await open();
    const view=page.locator(".hv-view"), scroll=view.locator(".hv-scroll"), details=view.locator(".hv-details");
    const commits=view.locator('.hv-row[data-type="commit"]');
    const history=()=>page.locator('#sub-project-git [data-action="project-history"]').evaluate(b=>b.click());
    const firstResult=()=>details.locator(".hv-headline, .hv-changes .ui-empty, .hv-changes .ui-notice").first().waitFor();
    const start=performance.now();
    await history(); await commits.first().waitFor();
    metrics.historyMs=Math.round(performance.now()-start);
    await commits.first().click();
    await firstResult();
    metrics.firstSummaryMs=Math.round(performance.now()-start);
    await page.waitForFunction(n=>AtriumHistoryView.state()?.commits >= n, rows.length);
    const samples=await scroll.evaluate(async s=>{
      const frames=[]; let previous;
      for(let i=0;i<=75;i++){
        const stamp=await new Promise(requestAnimationFrame);
        if(previous!==undefined) frames.push(stamp-previous);
        previous=stamp;s.scrollTop=(s.scrollHeight-s.clientHeight)*i/75;
      }
      return {frames,dom:document.querySelectorAll(".hv-row").length};
    });
    const p95=a=>a.length ? +a.sort((x,y)=>x-y)[Math.floor(a.length*.95)].toFixed(2) : null;
    metrics.frameP95Ms=p95(samples.frames);metrics.longestRowPaintMs=await page.evaluate(()=>AtriumHistoryView.perf().longest);metrics.domRows=samples.dom;
    const target=publicRevision ? rows.find(r=>r.revision?.startsWith(publicRevision)) :
      rows.find(r=>r.total>0 && r.beforeInk && r.afterInk) || rows.find(r=>r.total>0 && (r.beforeInk || r.afterInk)) || rows.find(r=>r.total>0) || rows.find(r=>r.error);
    if (publicRevision) assert.ok(target?.total,"The requested public revision must have a semantic change");
    if(target){
      const revision=listing.commits[target.index-1].revision;
      const row=view.locator('[data-key="'+revision+'"]');
      await page.evaluate(rev=>AtriumHistoryView.instance().select(rev),revision);
      await row.waitFor(); await firstResult();
      if(target.total>0){
        const visible=await details.locator(".hv-changes .ui-badge, .ui-section-head .ui-badge").evaluateAll(elements=>
          Object.fromEntries(["electrical","mechanical","cosmetic"].map(severity=>{
            const badge=elements.find(e=>e.textContent.endsWith(" "+severity));
            return [severity,parseInt(badge?.textContent||"0",10)];
          })));
        assert.deepEqual(visible,target.counts,"Rendered History details give the measured severity counts");
        metrics.historyCounts=visible;
        metrics.thumbnailTiles=await details.locator(".hv-tile .hv-changed").count();
        const privacy=".hv-who, .hv-byline-name {visibility:hidden}";
        if(shots && publicDesign && target.regions){
          await fs.mkdir(shots,{recursive:true});
          if (publicRevision) {
            await page.evaluate(()=>AtriumTheme.setPreset("light"));
            await details.screenshot({path:path.join(shots,"row-"+publicDesign.id+"-"+target.revision.slice(0,8)+".png"),style:privacy});
          } else await details.locator(".hv-pair").screenshot({path:path.join(shots,"preview-"+publicDesign.id+".png"),style:privacy});
        }
        if(shots && publicDesign?.id==="snes-tap"){
          await fs.mkdir(shots,{recursive:true});
          await page.evaluate(()=>AtriumTheme.setPreset("light"));
          await view.screenshot({path:path.join(shots,"history-light.png"),style:privacy});
        }
        await details.getByRole("button",{name:"Compare",exact:true}).click();
        await page.waitForFunction(()=>window.AtriumDiffView?.session()?.metrics.diffDone!==undefined);
        const c=await page.evaluate(()=>{
          const s=AtriumDiffView.session(), counts={electrical:0,mechanical:0,cosmetic:0};
          for (const change of s.model.changes) {
            const severity=change.severity==="layout" ? "mechanical" : change.severity;
            counts[severity]++;
          }
          return {total:s.model.changes.length, counts, b:s.b.label, a:s.a.label};
        });
        metrics.compareTotal=c.total;
        if (publicDesign?.id==="garganturam") {
          assert.match(await page.locator(".dv-source-notice").textContent(),/3 referenced libraries unavailable/);
          metrics.unavailableLibraries=3;
        }
        assert.equal(c.total,target.total,"Compare and the visible history row agree");
        assert.deepEqual(c.counts,visible,"Compare and History agree in each severity");
        assert.ok(c.a.startsWith(revision.slice(0,7)));
        if(shots && publicDesign?.id==="snes-tap"){
          await page.evaluate(()=>AtriumTheme.setPreset("dark"));
          await page.screenshot({path:path.join(shots,"compare-dark.png")});
        }
        await page.locator(".dv-close").click();
      }
    }
    // The walkthrough visits changed commits explicitly after measuring scroll. This fills the
    // real persistent store without asking the graph to prefetch any off-screen rows.
    const measured = rows.filter(r=>r.sourceChanged ?? (r.total>0));
    const changed = measured.map(r=>listing.commits[r.index-1]);
    const actual = await page.evaluate(async list=>{
      AtriumHistoryView.close();
      const data=AtriumProjectHistoryData.source(AtriumGit), signal=new AbortController().signal, results=[];
      try {
        for (const row of list) {
          const r=await data.summary(row,signal), first=r.regions[0];
          results.push({counts:r.counts,total:r.total,regions:r.regions.length,
            beforeChangedInk:!!first?.before?.changed,afterChangedInk:!!first?.after?.changed});
        }
      } finally { data.close(); }
      return results;
    },changed);
    metrics.sourcePairsChecked=measured.length;
    for (const [i, result] of actual.entries()) for (const [key,value] of Object.entries(result)) {
      if (key in measured[i]) assert.deepEqual(value,measured[i][key],"Browser source row "+measured[i].index+" field "+key);
    }
    metrics.cache=await page.evaluate(async()=>{
      const db=await new Promise((yes,no)=>{const r=indexedDB.open("atrium-project-history",1);r.onsuccess=()=>yes(r.result);r.onerror=()=>no(r.error);});
      if (!db.objectStoreNames.contains("summaries")) return {entries:0,encodedBytes:0};
      return new Promise((yes,no)=>{
        let entries=0,bytes=0;
        const e=new TextEncoder(),c=db.transaction("summaries").objectStore("summaries").openCursor();
        c.onsuccess=()=>{const cur=c.result;if(!cur){db.close();yes({entries,encodedBytes:bytes});return;}
          entries++;bytes+=e.encode(cur.key).length+e.encode(JSON.stringify(cur.value)).length;cur.continue();};c.onerror=()=>no(c.error);
      });
    });
    if (changed.length) {
      await page.reload();
      await page.evaluate(async()=>{const pick=await AtriumHost.open();AtriumHost.acceptHistorySource(pick);});
      const before=queries.filter(x=>x==="sourceRevision").length;
      await page.evaluate(async c=>{
        await AtriumLazy.need("AtriumProjectHistory");
        const data=AtriumProjectHistoryData.source(AtriumGit);
        try { await data.summary(c,new AbortController().signal); } finally { data.close(); }
      },changed[0]);
      metrics.reloadSourceReads=queries.filter(x=>x==="sourceRevision").length-before;
      assert.equal(metrics.reloadSourceReads,0,"Reload reuses the immutable blob-pair summary");
    }
    metrics.sourceReads=queries.filter(x=>x==="sourceRevision").length;
    metrics.pageErrors=errors.length;
    assert.deepEqual(errors,[]);
  } finally {
    await fs.writeFile(output,JSON.stringify(metrics,null,2)+"\n");
    await browser.close();await new Promise(done=>server.close(done));
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
