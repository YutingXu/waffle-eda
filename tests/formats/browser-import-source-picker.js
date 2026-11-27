"use strict";

// Exercise File Open and first Save with Chromium's real file handles and storage.
// The harness supplies only the user's file picker selections.
const assert = require("node:assert/strict"), fs = require("node:fs/promises");
const {createStaticServer} = require("../support/browser-app-server.cjs");
const path = require("node:path"), {createHash} = require("node:crypto");
const ROOT = path.resolve(__dirname, "../.."), p = name => path.join(ROOT,"tests/fixtures/import",name);
const pickerButton = page => page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Open…", exact:true});
const saveButton = page => page.getByRole("button",{name:"Save",exact:true});
const firstSave = page => page.locator("dialog.import-save-sheet").filter({has:page.locator("h2",{hasText:/as a Waffle project/})});
const editorSource = page => page.evaluate(()=>AtriumNavHost.fileSession().imported.sourceFile.name);

async function run(browser) {
  const app = createStaticServer({
    base: ROOT,
    roots: [path.join(ROOT,"app"), path.join(ROOT,"extensions")],
    body: "buffer",
    mime: {".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",
      ".wasm":"application/wasm",".svg":"image/svg+xml"},
  });
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  const url = "http://127.0.0.1:"+app.address().port+"/app/index.html";
  const context = await browser.newContext(), original = await fs.readFile(p("demo.kicad_pcb"));
  await context.addInitScript(() => {
    const state = globalThis.childOpening = {events:[], progress:[], welcome:false};
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.target.matches?.("dialog.sp-dialog[open]")) state.welcome = true;
        for (const node of record.addedNodes) {
          if (node.matches?.(".status-progress")) state.progress.push(node.getAttribute("aria-label"));
          if (node.matches?.("dialog.sp-dialog[open]")) state.welcome = true;
        }
      }
    });
    addEventListener("DOMContentLoaded", () => {
      state.welcome = !!document.querySelector("dialog.sp-dialog[open]");
      observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:["open"]});
    }, {once:true});
    addEventListener("atrium-opening", event => state.events.push(event.detail.into));
  });
  const rootSheet = await fs.readFile(p("root.kicad_sch")), childSheet = await fs.readFile(p("child.kicad_sch"));
  const historical = await fs.readFile(path.join(ROOT,"tests/fixtures/compat/projects/v1.4-generic-parts.atrium"));
  const output = "outputs/design-export.zip", otherOutput = "outputs/copy-export.zip";
  const digest = body => createHash("sha256").update(body).digest("hex");
  async function open(files,mode,destination=output) {
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    await page.addInitScript(({files,mode,destination})=>{
      const input=HTMLInputElement.prototype.click;
      window.openCalls=[];
      window.fileReads=[];
      window.headerReads=[];
      window.fullReads=0;
      window.htmlFallback=0;
      const get=FileSystemFileHandle.prototype.getFile;
      FileSystemFileHandle.prototype.getFile=async function(){
        fileReads.push(this.name);
        const file=await get.call(this), bytes=file.arrayBuffer.bind(file), range=file.slice.bind(file);
        Object.defineProperty(file,"arrayBuffer",{value:()=>{fullReads++;return bytes();}});
        Object.defineProperty(file,"slice",{value:(...args)=>{
          const header=range(...args), read=header.arrayBuffer.bind(header);
          return Object.defineProperty(header,"arrayBuffer",{value:()=>{headerReads.push(header.size);return read();}});
        }});
        if(mode==="oversize")Object.defineProperty(file,"size",{value:512*1024*1024});
        return file;
      };
      HTMLInputElement.prototype.click=function(){if(this.id==="file-input")htmlFallback++;return input.call(this);};
      function entry(file) {
        return navigator.storage.getDirectory().then(async root => {
          const folders=file.split("/"), name=folders.pop();
          for (const directory of folders) root=await root.getDirectoryHandle(directory,{create:true});
          return root.getFileHandle(name,{create:true});
        });
      }
      window.proof={
        entry,
        async write(file,b64) {
          const handle=await entry(file), stream=await handle.createWritable();
          await stream.write(Uint8Array.from(atob(b64),ch=>ch.charCodeAt(0)));
          await stream.close();
        },
        async read(file) {
          const data=new Uint8Array(await (await (await entry(file)).getFile()).arrayBuffer());
          return Array.from(data);
        }
      };
      window.showOpenFilePicker=async options=>{
        openCalls.push(options);
        if(mode==="cancel")throw new DOMException("Cancelled","AbortError");
        if(mode==="unavailable")throw new DOMException("Unavailable","NotSupportedError");
        return Promise.all(files.map(entry));
      };
      window.saveCalls=0;
      window.showSaveFilePicker=async()=>{saveCalls++;return entry(destination);};
    },{files,mode,destination});
    await page.goto(url);
    return page;
  }
  const settle = page => page.waitForFunction(()=>globalThis.AtriumNavHost?.importSession()?.state==="unsaved");
  const saved = page => page.waitForFunction(()=>AtriumNavHost.importSession()?.state==="export-preferred"&&!AtriumNavHost.isDirty());
  const outputHash = async (page,file) => digest(Buffer.from(await page.evaluate(file=>proof.read(file),file)));
  async function remember(page) {
    await saveButton(page).click();
    await firstSave(page).getByRole("button",{name:"Export to KiCad…",exact:true}).click();
    const review=page.locator("dialog.import-save-sheet").filter({has:page.locator("h2",{hasText:/^Export/})});
    await review.getByRole("checkbox",{name:/Remember for this project/}).check();
    await review.locator("button.is-primary").click();
    await saved(page);
    assert.equal(await page.evaluate(()=>saveCalls),1);
  }
  async function saveAgain(page,delta) {
    await page.evaluate(delta=>{
      const h=AtriumNavHost, trace=h.doc().items.find(item=>item.kind==="track");
      h.edit(()=>{trace.width+=delta;},"Change routed track width");
    },delta);
    await saveButton(page).click();
    await saved(page);
    assert.equal(await page.evaluate(()=>saveCalls),0);
    assert.equal(await firstSave(page).count(),0);
  }
  async function downloadWaffle(page) {
    await saveButton(page).click();
    await firstSave(page).getByRole("button",{name:"Save as Waffle Project…",exact:true}).click();
    const [archive]=await Promise.all([page.waitForEvent("download"),
      page.getByRole("button",{name:"Download Format 2 ZIP",exact:true}).click()]);
    await page.waitForFunction(()=>AtriumNavHost.folderProject()?.temporary && !AtriumNavHost.importSession());
    return fs.readFile(await archive.path());
  }
  try {
    const a = "source-a/Board.kicad_pcb", b = "source-b/Board.kicad_pcb";
    const initial=await open([a]);
    await initial.evaluate(async ({a,b,original,rootSheet,childSheet,historical})=>{
      await proof.write(a,original);await proof.write(b,original);
      await proof.write("source-a/unrecognised.txt",btoa("Plain project notes outside the design."));
      await proof.write("source-a/renamed.data",original);
      await proof.write("source-a/old-build.kicad_pcb",historical);
      await proof.write("source-a/root.kicad_sch",rootSheet);await proof.write("source-a/child.kicad_sch",childSheet);
    },{a,b,original:original.toString("base64"),rootSheet:rootSheet.toString("base64"),childSheet:childSheet.toString("base64"),
      historical:historical.toString("base64")});
    await pickerButton(initial).click();await settle(initial);
    assert.deepEqual(await initial.evaluate(()=>openCalls),[{multiple:true}]);
    assert.deepEqual(await initial.evaluate(()=>fileReads),["Board.kicad_pcb"]);
    assert.equal(await editorSource(initial),"Board.kicad_pcb");
    const sourceKey=await initial.evaluate(()=>AtriumNavHost.importSession().sourceKey);
    await remember(initial);
    const first=await outputHash(initial,output);
    await initial.close();

    const reopened=await open([a]);
    await pickerButton(reopened).click();await settle(reopened);
    await saveAgain(reopened,.15);
    const second=await outputHash(reopened,output);
    assert.notEqual(second,first);
    await reopened.getByRole("button",{name:"Open",exact:true}).click();
    const [otherWindow]=await Promise.all([reopened.waitForEvent("popup"),
      reopened.getByRole("button",{name:"Open in new window",exact:true}).click()]);
    await settle(otherWindow);
    await otherWindow.locator(".status-progress").waitFor({state:"detached"});
    const childOpening = await otherWindow.evaluate(() => globalThis.childOpening);
    assert.deepEqual(childOpening.events,[false],"the transferred selection announces the child's project open once");
    assert.match(childOpening.progress[0],/^Opening Board…/,"the new editor window shows opening progress");
    assert.equal(childOpening.welcome,false,"the explicit project window skips Welcome");
    assert.equal(await otherWindow.evaluate(()=>AtriumNavHost.fileSession().imported.sourceFile.fileHandle instanceof FileSystemFileHandle),true);
    await reopened.close();

    const separate=await open([b],undefined,otherOutput);
    await pickerButton(separate).click();await settle(separate);
    assert.equal(await separate.evaluate(()=>AtriumNavHost.importSession().sourceKey),sourceKey,"copies share identical source bytes");
    await saveButton(separate).click();
    await firstSave(separate).waitFor();
    await separate.keyboard.press("Escape");
    await firstSave(separate).waitFor({state:"hidden"});
    await settle(separate);
    assert.equal(await separate.evaluate(()=>saveCalls),0);
    const verify=await separate.evaluate(async({a,b,output})=>Promise.all([a,b,output].map(proof.read)),{a,b,output});
    assert.equal(digest(Buffer.from(verify[0])),digest(original));
    assert.equal(digest(Buffer.from(verify[1])),digest(original));
    assert.equal(digest(Buffer.from(verify[2])),second);
    await remember(separate);
    const otherFirst=await outputHash(separate,otherOutput);
    assert.equal(await outputHash(separate,output),second);
    await separate.close();

    const otherAgain=await open([b]);
    await pickerButton(otherAgain).click();await settle(otherAgain);
    await saveAgain(otherAgain,.25);
    const otherSecond=await outputHash(otherAgain,otherOutput);
    assert.notEqual(otherSecond,otherFirst);
    assert.equal(await outputHash(otherAgain,output),second);
    await otherAgain.close();

    const firstAgain=await open([a]);
    await pickerButton(firstAgain).click();await settle(firstAgain);
    await saveAgain(firstAgain,.35);
    assert.notEqual(await outputHash(firstAgain,output),second);
    assert.equal(await outputHash(firstAgain,otherOutput),otherSecond);
    await firstAgain.close();

    const multi=await open(["source-a/root.kicad_sch","source-a/child.kicad_sch"]);
    await pickerButton(multi).click();await settle(multi);
    assert.equal(await multi.evaluate(()=>AtriumNavHost.fileSession().imported.sourceFiles.length),2);
    assert.equal(await multi.evaluate(()=>AtriumNavHost.fileSession().imported.sourceFiles.every(f=>f.fileHandle instanceof FileSystemFileHandle)),true);
    const portable="saved/Project.zip", archiveBytes=await downloadWaffle(multi);
    await multi.evaluate(({portable,bytes})=>proof.write(portable,bytes),{portable,bytes:archiveBytes.toString("base64")});
    await multi.close();

    const fromZip=await open([portable]);
    await pickerButton(fromZip).click();
    await fromZip.getByRole("dialog",{name:"Open project ZIP"}).getByRole("button",{name:"Open project",exact:true}).click();
    await fromZip.waitForFunction(()=>AtriumNavHost.folderProject()?.temporary && !AtriumNavHost.importSession());
    await fromZip.close();

    const nativeFolder=path.join(ROOT,"mcp/examples/sensor-interface"), manifest=await fs.readFile(path.join(nativeFolder,"Board.waffle"));
    const fromManifest=await open(["saved/Board.waffle"]);
    await fromManifest.evaluate(bytes=>proof.write("saved/Board.waffle",bytes),manifest.toString("base64"));
    await pickerButton(fromManifest).click();
    const [folder]=await Promise.all([fromManifest.waitForEvent("filechooser"),
      fromManifest.getByRole("dialog",{name:"Open project folder"}).getByRole("button",{name:"Choose folder…"}).click()]);
    await folder.setFiles(nativeFolder);
    await fromManifest.waitForFunction(()=>AtriumNavHost.folderProject()?.temporary && !AtriumNavHost.importSession());
    await fromManifest.close();

    const cancel=await open([],"cancel");
    await pickerButton(cancel).click();
    await cancel.waitForFunction(()=>openCalls.length===1);
    // A cancelled pick leaves the modal Welcome open, so Open… is tried again from there.
    await pickerButton(cancel).click();
    await cancel.waitForFunction(()=>openCalls.length===2);
    assert.deepEqual(await cancel.evaluate(()=>[openCalls.length,htmlFallback,AtriumNavHost.isStarter()]),[2,0,true]);
    await cancel.close();

    const oversized=await open([a],"oversize");
    await pickerButton(oversized).click();
    await oversized.getByRole("dialog",{name:"Couldn’t open this file"}).getByText(/size or file count limit/).waitFor();
    assert.deepEqual(await oversized.evaluate(()=>[fileReads,headerReads,fullReads,AtriumNavHost.isStarter()]),[["Board.kicad_pcb"],[],0,true]);
    await oversized.close();

    const unrelated=await open([a,"source-a/unrecognised.txt"]);
    await pickerButton(unrelated).click();
    await unrelated.getByRole("dialog",{name:"Couldn’t open this file"}).getByText(/Unrecognised input/).waitFor();
    const discovery=await unrelated.evaluate(()=>({headers:headerReads,full:fullReads,starter:AtriumNavHost.isStarter()}));
    assert.equal(discovery.headers.length,2);
    assert.ok(discovery.headers.every(size=>size<=65536));
    assert.deepEqual([discovery.full,discovery.starter],[0,true]);
    await unrelated.close();

    const old=await open(["source-a/old-build.kicad_pcb"]);
    await pickerButton(old).click();
    await old.getByRole("dialog",{name:"Couldn’t open this file"}).getByText("This file is from a pre-release Waffle build; re-import the design from its source EDA",{exact:true}).waitFor();
    assert.equal(await old.evaluate(()=>fullReads),0);
    await old.close();

    const renamed=await open(["source-a/renamed.data"]);
    await pickerButton(renamed).click();await settle(renamed);
    assert.equal(await editorSource(renamed),"renamed.data");

    const html=await open([],"unavailable");
    const [fallback]=await Promise.all([html.waitForEvent("filechooser"),pickerButton(html).click()]);
    await fallback.setFiles(p("demo.kicad_pcb"));await settle(html);
    assert.equal(await html.evaluate(()=>AtriumNavHost.fileSession().imported.sourceFile.fileHandle),undefined);

    const abandoned=await open([b]);
    await pickerButton(abandoned).click();await settle(abandoned);
    const beforeRecovery=await abandoned.evaluate(async()=>{
      const host=AtriumNavHost, track=host.doc().items.find(item=>item.kind==="track");
      host.edit(()=>{track.width=.79;},"Change routed track width");
      await AtriumForeignDrafts.flush(host);
      return {id:host.importSession().id,track:track.id};
    });
    await abandoned.close();
    const recovery=await open([],"cancel");
    await recovery.getByRole("dialog",{name:"Recover imported projects"})
      .getByRole("button",{name:"Restore Draft",exact:true}).click();
    await settle(recovery);
    const restored=await recovery.evaluate(id=>{
      const host=AtriumNavHost;
      return {id:host.importSession().id,width:host.doc().items.find(item=>item.id===id).width,
        handle:!!host.fileSession().imported.sourceFile.fileHandle,dirty:host.isDirty()};
    },beforeRecovery.track);
    assert.deepEqual(restored,{id:beforeRecovery.id,width:.79,handle:false,dirty:true});
    assert.ok((await downloadWaffle(recovery)).length>0);
    await recovery.waitForFunction(async id=>!(await AtriumFolderDrafts.storage.list("foreign-import-v1")).some(draft=>draft.writer===id),beforeRecovery.id);
    assert.equal(await recovery.evaluate(()=>saveCalls),0);
    assert.equal(await outputHash(recovery,otherOutput),otherSecond);
    console.log("PASS actual Open, multi-select, cross-window handle, current manifest and ZIP, cancel, bounded discovery, historical and renamed inputs, HTML fallback, independent remembered destinations for byte-identical copies, and ordinary recovered draft");
  } finally {
    await context.close();
    await new Promise(resolve=>app.close(resolve));
  }
}
module.exports=run;
if(require.main===module)(async()=>{
  const browser=await require("../support/playwright.cjs").chromium.launch(process.env.CHROME?{executablePath:process.env.CHROME}:{channel:"chrome"});
  try{await run(browser);}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
