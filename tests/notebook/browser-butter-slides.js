"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const {createHash} = require("node:crypto");
const {pathToFileURL} = require("node:url");
const serveApp = require("../support/browser-app-server.cjs");
const fixture = path.join(__dirname,"../fixtures/butter-acceptance/slides");
const names = ["Slide study.waffle","Top.wsch","Sensor.wsch"];
const files = Object.fromEntries(names.map(name => [name,fs.readFileSync(path.join(fixture,name),"utf8")]));

async function test(browser) {
  const page = await browser.newPage({viewport:{width:1360,height:960},reducedMotion:"reduce"}), errors = [];
  page.on("pageerror",error => errors.push(error.message));
  try {
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.getByRole("button",{name:"Continue to editor",exact:true}).click();
    await page.waitForFunction(() => globalThis.AtriumNavHost?.captureViewState?.());
    const outcome = await page.evaluate(async fixture => {
      const G = globalThis, host = G.AtriumNavHost;
      await G.AtriumLazy.need("AtriumFormat2Closure");
      const M = G.AtriumFormat2Model, bytes = name => new TextEncoder().encode(fixture[name]);
      const {project,members} = M.manifest(M.parse(bytes("Slide study.waffle")));
      for (const member of members) project.documents.push(M.document(M.parse(bytes(member.path)),{name:member.name}));
      await host.replaceProject(project,{force:true,dirty:false});
      const [top,sensor] = host.project().documents, [first,second] = host.project().slides;
      const toggle = value => G.AtriumPrefs.set("butter.slides",value);
      const off = !G.AtriumKeymap.commands().some(command => command.id.startsWith("butter.slides."));
      toggle(true);
      G.AtriumPrefs.set("butter.query",true);
      await G.AtriumLazy.need("AtriumButterEditor");
      const apply = (command,args = {}) => G.AtriumButterEditor.apply("butter.slides." + command,args);
      const read = (command,args = {}) => G.AtriumButter.run("butter.slides." + command,args);
      await host.selectDocument(sensor.id);
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      const live = () => ({...host.captureViewState(),selection:host.selection(),net:host.highlight()});
      host.view().restoreCamera({...host.view().camera(),cx:13.125,cy:-16.25,scale:8.75});
      host.select([sensor.items[0].id]); host.setHighlight("SENSE");
      await G.AtriumLazy.need("AtriumQuery");
      G.AtriumQuery.apply("object",{highlight:true},{quiet:true});
      const snapshot = live(), journal = host.undoSteps().history.length;
      const plan = (await read("start",{presenter:true})).result;
      const plannedWithoutNavigation = host.currentId() === sensor.id && host.view().camera().cx === 13.125;
      const firstSlide = (await apply("start",{presenter:true})).result;
      const liveFirst = live();
      const secondSlide = (await apply("step",{direction:1})).result;
      const liveSecond = live();
      // Leave the slide to inspect the live design, change it, and then resume from the saved camera.
      await host.selectDocument(top.id);
      const note = {id:G.Atrium.id(),kind:"netlabel",x:31,y:16,text:"LIVE_EDIT"};
      host.edit(() => host.doc().items.push(note),"Live presentation edit",new Set([note.id]));
      host.view().restoreCamera({...host.view().camera(),cx:45,cy:55,scale:2});
      const resumed = (await apply("resume")).result;
      const resumedView = live();
      const presenter = (await read("presenter")).result;
      const stop = (await apply("stop")).result, restored = live();
      const filter = G.AtriumQuery.applied();
      const retainedEdit = host.project().documents.find(doc => doc.id === top.id).items.some(item => item.id === note.id);
      const update = await apply("update",{id:first.id,notes:"One guarded slide edit"});
      const changed = host.project().slides[0].notes;
      host.act("undo");
      const restoredNote = host.project().slides[0].notes, history = host.undoSteps().history.length;
      const maskedId = sensor.items[0].id;
      G.AtriumQuery.applyIds(sensor.id,[maskedId],[],{mask:true,highlight:false});
      await apply("start");
      await apply("stop");
      const navigatorMask = G.AtriumQuery.applied();
      toggle(false);
      const hidden = (await read("list").catch(error => error.code)) === "butter_disabled";
      return {off,hidden,plan,plannedWithoutNavigation,firstSlide,secondSlide,resumed,presenter,stop,
        liveFirst,liveSecond,resumedView,snapshot,restored,restoredFilter:filter?.text,retainedEdit,
        changed,restoredNote,journal,history,changes:update.changes,top:top.id,sensor:sensor.id,first:first.id,second:second.id,
        navigatorMask,maskedId};
    },files);
    assert.ok(outcome.off && outcome.hidden && outcome.plannedWithoutNavigation);
    assert.equal(outcome.plan.current.id,outcome.first);
    assert.equal(outcome.plan.presenterWindow.status,"planned");
    assert.equal(outcome.firstSlide.presenterWindow.status,"unavailable");
    assert.equal(outcome.liveFirst.documentId,outcome.top);
    assert.equal(outcome.liveFirst.camera.cx,24);
    assert.equal(outcome.liveFirst.camera.cy,13.5);
    assert.equal(outcome.liveSecond.documentId,outcome.sensor);
    assert.equal(outcome.secondSlide.status,"partial");
    assert.equal(outcome.secondSlide.view.filter.status,"complete","The target document owns the enabled query during navigation");
    assert.equal(outcome.resumed.current.id,outcome.second);
    assert.deepEqual(outcome.resumedView,outcome.liveSecond);
    assert.equal(outcome.presenter.notes,"Walk through the linked input.");
    assert.equal(outcome.stop.restoredDocumentId,outcome.sensor);
    assert.deepEqual(outcome.restored,outcome.snapshot);
    assert.equal(outcome.restoredFilter,"object");
    assert.deepEqual(outcome.navigatorMask,{docId:outcome.sensor,ids:[outcome.maskedId],modes:{mask:true,highlight:false},text:""});
    assert.ok(outcome.retainedEdit);
    assert.equal(outcome.changed,"One guarded slide edit");
    assert.match(outcome.restoredNote,/Begin on SENSE/);
    assert.equal(outcome.history,outcome.journal+1,"Only the surviving live design edit should remain in Undo history");
    assert.equal(outcome.changes,1);
    assert.deepEqual(errors,[]);
    console.log("PASS editor slide opt-in, plan, cross-document navigation, active design editing, camera/filter/selection return and one Undo");
  } finally {
    await page.close();
  }
}

async function preparedExports(browser) {
  const sha = "7f2f9088c8f90652a6aaa45e69623b55316b6d080c2213d29819976b71454840";
  const photo = fs.readFileSync(path.join(__dirname,"../fixtures/format-2/notebook/assets",sha));
  const second = fs.readFileSync(path.join(__dirname,"../fixtures/altium/notebook-outputs/clip/notebook-4e730000627afacfa5dfad6cfac9bb9675b395cb9046ddce424effcdecccfca1.png"));
  const digest = data => createHash("sha256").update(data).digest("hex");
  const photoRecord = {kind:"image",id:"photo-in-frame",asset:{byteLength:photo.length,mediaType:"image/png",sha256:sha},
    angle:345000000000,crop:[0,0,950000,1000000],extent:[1,1],h:4000000,name:"Photo.png",order:"o",w:5000000,x:18000000,y:12000000};
  const top = names[1], root = names[0];
  const viewId = "018cc251-f400-7001-8000-000000000024";
  const manifest = [files[root].trimEnd(), JSON.stringify({kind:"savedView",id:viewId,order:"k",value:{id:viewId,
    documentId:"018cc251-f400-7001-8000-000000000002",name:"Photo view",
    camera:{center:[20000000,14000000],flipped:false,referenceScale:30,rotationRadians:{$number:"0.7853981633974483"},scale:30},
    viewport:{pixelHeight:360,pixelWidth:520},selection:[]}}),
    JSON.stringify({kind:"document",id:"spare",docKind:"schematic",name:"Spare",order:"z",path:"Spare.wsch"}),""].join("\n");
  const inFolder = {...files,[root]:manifest,[top]:[files[top].trimEnd(),JSON.stringify(photoRecord),JSON.stringify({...photoRecord,
    id:"photo-off-page",asset:{...photoRecord.asset,sha256:digest(second),byteLength:second.length},
    order:"p",x:80000000,y:80000000}),""].join("\n"),["assets/"+sha]:photo,["assets/"+digest(second)]:second};
  const payload = Object.entries(inFolder).map(([path,data]) => ({path,sha256:digest(data),bytes:Buffer.from(data).toString("base64")}));
  const server = await serveApp(), page = await browser.newPage({viewport:{width:1360,height:960}}), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.addInitScript(({root,payload}) => {
      const members = new Map(payload.map(row => [row.path,row]));
      globalThis.outputProof = {reads:[],pdfs:[],prints:[]};
      globalThis.AtriumHost = {
        platform:"mac",
        async open(){return [{name:root,folderProject:{grant:"local-project",manifest:root,name:"Slide study"}}];},
        async folderReadLease(){return {lease:"read"};},
        async folderRelease(){}, async folderClose(){}, async folderLocalState(){return {};}, async folderAdopt(){return true;},
        finishedOpening(){}, markOpened(){}, clearProjectPath(){}, setDirty(){},
        async folderRead({paths}){
          outputProof.reads.push(...paths);
          return {files:paths.flatMap(path => {
            const row = members.get(path);
            if (!row) return [];
            const bytes=Uint8Array.from(atob(row.bytes),c=>c.charCodeAt(0));
            return [{path,sha256:row.sha256,length:bytes.length,bytes}];
          })};
        },
        async exportFile(name,data) {
          const parts = [];
          for (let i=0;i<data.length;i+=8192) parts.push(String.fromCharCode(...data.subarray(i,i+8192)));
          outputProof.pdfs.push({name,data:parts.join("")});
          return true;
        },
        async printPDF(name,data) {
          const header = String.fromCharCode(...data.subarray(0,5));
          outputProof.prints.push({name,header,mounted:!!document.getElementById("atrium-print-root")});
          return true;
        }
      };
    },{root,payload});
    await page.goto(server.url);
    await page.getByRole("button",{name:"Continue to editor",exact:true}).click();
    await page.evaluate(async () => {
      AtriumPower.setMode("always");
      AtriumNavHost.act("open");
    });
    await page.waitForFunction(() => AtriumNavHost.folderProject()?.hasPresented("018cc251-f400-7001-8000-000000000002"));
    const result = await page.evaluate(async viewId => {
      const G = globalThis, host = G.AtriumNavHost;
      for (const feature of ["slides","savedViews","drop","links"]) AtriumPrefs.set("butter."+feature,true);
      const B = await AtriumLazy.need("AtriumButterEditor");
      const list = async command => (await AtriumButter.run(command)).result;
      const [first, second] = host.project().slides, [sensor] = host.project().savedViews;
      const before = {view:(await list("butter.savedViews.list")).views[0].status,slide:(await list("butter.slides.list")).slides[1].status};
      const frame = await B.apply("butter.drop.export-frame", {documentId:host.currentId(),frameId:first.source.frameId});
      const saved = await B.apply("butter.savedViews.export-pdf",{ids:[viewId]});
      const slide = await B.apply("butter.slides.export-pdf",{ids:[first.id]});
      const printReads = host.folderProject().metrics().reads.filter(row => row.purpose === "print").map(row => row.path);
      const prepared = await AtriumPrint.prepareDocument(host.project(),{documents:[first.source.documentId],attachments:false},{},result => result);
      await AtriumPrint.output(prepared,"Prepared source.pdf");
      const stayedOnTop = host.currentId() === first.source.documentId;
      const reads = outputProof.reads.slice(), pdfs = outputProof.pdfs.slice();
      const started = await B.apply("butter.savedViews.present",{ids:[sensor.id]});
      await B.apply("butter.slides.stop");
      const command = AtriumKeymap.commands().find(row => row.id === "butter.slides.start");
      command.run();
      return {before,outputs:[frame.result,saved.result,slide.result],stayedOnTop,reads,printReads,pdfs,started:started.result,
        prints:outputProof.prints,
        firstId:first.id, secondId:second.id, projectId:host.project().id};
    },viewId);
    assert.deepEqual(result.before,{view:"loading-document",slide:"loading-document"});
    assert.equal(result.started.status,"partial");
    assert.equal(result.started.current.status,"ready");
    assert.ok(result.stayedOnTop);
    assert.deepEqual(result.prints,[{name:"Prepared source.pdf",header:"%PDF-",mounted:true}]);
    await page.waitForFunction(() => !document.getElementById("atrium-print-root"));
    assert.ok(!result.reads.includes("Spare.wsch") && !result.reads.includes("Sensor.wsch"));
    assert.ok(result.reads.includes("assets/"+sha));
    assert.ok(!result.printReads.includes("assets/"+digest(second)));
    assert.equal(result.pdfs.length,3);
    for (const [i,{data}] of result.pdfs.entries()) {
      assert.match(data,/^%PDF-/);
      assert.equal((data.match(/\/Subtype \/Image\b/g)||[]).length,1, "only the photo inside this source is embedded");
      assert.deepEqual(result.outputs[i].notes,[]);
    }
    assert.ok(result.pdfs[1].data.includes("waffle://"+result.projectId+"/"+viewId));
    assert.ok(result.pdfs[2].data.includes("waffle://"+result.projectId+"/"+result.firstId));
    await page.waitForFunction(async firstId =>
      (await AtriumButter.run("butter.slides.presenter")).result.current?.id === firstId,result.firstId);
    await page.evaluate(() => AtriumKeymap.commands().find(row => row.id === "butter.slides.step").run());
    await page.waitForFunction(async id => (await AtriumButter.run("butter.slides.presenter")).result.current?.id === id,result.secondId);
    await page.evaluate(() => AtriumKeymap.commands().find(row => row.id === "butter.slides.stop").run());
    await page.waitForFunction(async () => (await AtriumButter.run("butter.slides.presenter")).result.status === "inactive");
    assert.deepEqual(errors,[]);
    console.log("PASS cold folder view, three prepared image PDFs, bounded asset reads, source links and palette playback");
  } finally {
    await page.close();
    await server.close();
  }
}

if (require.main === module) {
  const {chromium} = require("../support/playwright.cjs");
  (async() => {
    const browser = await chromium.launch({...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"}),
      args:["--allow-file-access-from-files"]});
    try { await module.exports(browser); } finally { await browser.close(); }
  })().catch(error => {console.error(error);process.exitCode=1;});
}
module.exports = async browser => {
  await test(browser);
  await preparedExports(browser);
};
