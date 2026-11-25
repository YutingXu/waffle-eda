"use strict";

// Run against an assembled notebook editor: node tests/editor/browser-palette-notebook.js [checkout].
const assert = require("node:assert/strict");
const path = require("node:path");
const {createStaticServer} = require("../support/browser-app-server.cjs");
const {chromium} = require("playwright-core");
const root = path.resolve(process.argv[2] || path.join(__dirname,"../.."));

function localPDF() {
  const stream = "0 0 1 rg 12 12 52 34 re f\n";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 75] /Resources << >> /Contents 4 0 R >>",
    "<< /Length "+stream.length+" >>\nstream\n"+stream+"endstream"];
  let file = "%PDF-1.4\n", offsets = [];
  objects.forEach((object,i) => {offsets.push(file.length); file+=(i+1)+" 0 obj\n"+object+"\nendobj\n";});
  const start = file.length;
  file+="xref\n0 5\n0000000000 65535 f \n"+offsets.map(n => String(n).padStart(10,"0")+" 00000 n \n").join("");
  return file+"trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n"+start+"\n%%EOF\n";
}

async function check(browser, origin) {
  const page = await browser.newPage({viewport:{width:1300,height:880},hasTouch:true});
  await require("../fixtures/notebook-labs.cjs").profile(page);
  page.setDefaultTimeout(7000);
  const errors = []; page.on("pageerror",error => errors.push(error.message));
  const palette = page.locator("#palette[open]"), input = palette.getByRole("combobox");
  const anchor=[13.25,17.5], wait = (fn,arg) => page.waitForFunction(fn,arg);
  const model = () => page.evaluate(() => JSON.stringify(AtriumNavHost.project()));
  async function open(q) {
    const xy = await page.evaluate(at => {
      const h=AtriumNavHost,v=h.view(),c=h.canvas(),r=c.getBoundingClientRect();
      v.restoreCamera({...v.camera(),cx:at[0],cy:at[1],scale:8});h.redraw();c.focus();
      const p=v.worldToScreen(at);return [p[0]+r.left,p[1]+r.top];
    },anchor);
    await page.mouse.move(...xy); await page.keyboard.press("/");
    await input.waitFor(); await input.fill(q); await wait(() => globalThis.AtriumPalette?.context());
  }
  async function choose(name,touch=false) {
    const row = palette.getByRole("option").filter({has:page.locator(".nav-palette-label",{hasText:name})}).first();
    await row.waitFor();
    if (touch) {
      await row.tap();
      if (await palette.isVisible()) await palette.getByRole("button",{name:"Insert",exact:true}).tap();
    } else {
      const n=Number(await row.getAttribute("data-i"));
      for (let i=0;i<n;i++) await input.press("ArrowDown");
      await input.press("Enter");
    }
    await palette.waitFor({state:"hidden"});
  }
  async function undo(before) {await page.evaluate(()=>AtriumNavHost.act("undo")); assert.equal(await model(),before);}
  try {
    await page.goto(origin+"/app/index.html");
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name",{hasText:"Sensor board"}).waitFor();
    const png = await page.evaluate(async pdf => {
      const h=AtriumNavHost,p=Atrium.project("Notebook palette",[]),[sheet,board]=p.documents;
      sheet.grid=.25; await h.replaceProject(p,{force:true,dirty:false});h.selectDocument(sheet.id);
      const c=document.createElement("canvas");c.width=32;c.height=24;const g=c.getContext("2d");
      g.fillStyle="#174363";g.fillRect(0,0,32,24);
      const png=new Uint8Array(await (await new Promise(resolve=>c.toBlob(resolve))).arrayBuffer());
      const bytes = {"image/png":png,"application/pdf":new TextEncoder().encode(pdf)};
      const refs={}; for (const [mediaType,b] of Object.entries(bytes)) {
        const digest=await crypto.subtle.digest("SHA-256",b);
        refs[mediaType]={mediaType,byteLength:b.length,sha256:[...new Uint8Array(digest)].map(c=>c.toString(16).padStart(2,"0")).join("")};
      }
      const fixture=globalThis.mediaFixture={folder:false,writable:true,selected:"image/png",history:[],staged:[],released:[],hold:false,ids:[sheet.id,board.id],hydrations:0,assetReads:0};
      let sequence=0;
      const receipt=(ownerId,mediaType)=>({ownerId,assetToken:"fixture-"+ ++sequence,assetRef:refs[mediaType]});
      const session={grant:"fixture-grant",canEdit:id=>fixture.writable&&id===sheet.id,completeFor:()=>true,
        requireClosure:async()=>{fixture.hydrations++;throw Error("Both notebook fixture documents are already loaded.");},
        readAsset:async ({assetRef,signal})=>{fixture.assetReads++;signal?.throwIfAborted();return {bytes:bytes[assetRef.mediaType].slice()};},
        releaseAsset:({assetToken})=>fixture.released.push(assetToken),stageAttachment:r=>fixture.staged.push(r.assetRef)};
      // The picker, clipboard, camera and retained token are privileged native boundaries.
      // The JS image importer, PDF picker, decoder, owner validation and editor Undo stay real.
      Object.assign(globalThis.AtriumHost ||= {}, {
        async folderPickAsset(o){fixture.history.push(["pick",o]);if(fixture.hold)await new Promise(r=>fixture.resume=r);
          return {sourceToken:"source",name:fixture.selected==="application/pdf"?"Example.pdf":"Example.png",mediaType:fixture.selected};},
        async folderStageAsset(o){fixture.history.push(["stage",o]);return receipt(o.ownerId,o.mediaType);},
        async notebookPaste(o){fixture.history.push(["paste",o]);return {...receipt(o.ownerId,"image/png"),name:"Clipboard image"};},
        async notebookTransfer(o){fixture.history.push(["camera",{ownerId:o.ownerId,grant:o.grant,type:o.file.type}]);return receipt(o.ownerId,o.file.type);},
        async notebookClip(o){fixture.history.push(["clip",o]);return {...receipt(o.ownerId,"image/png"),width:32,height:24};}
      });
      h.folderProject=()=>fixture.folder?session:null;
      return Array.from(png);
    },localPDF());

    await open("Image from Clipboard");
    assert.equal(await page.evaluate(()=>!!AtriumPalette.index().get("insert:media-clipboard")),false);
    await input.press("Escape");
    await page.evaluate(()=>{mediaFixture.folder=true;mediaFixture.writable=false;});
    await open("PDF Datasheet Clip"); assert.equal(await page.evaluate(()=>!!AtriumPalette.index().get("insert:media-pdf")),false);
    await input.press("Escape");
    await page.evaluate(()=>{mediaFixture.writable=true;});
    await open("Image from File");
    const sources = await page.evaluate(()=>["image","pdf","clipboard","camera"].map(k=>!!AtriumPalette.index().get("insert:media-"+k)));
    const capture = await page.evaluate(()=>navigator.maxTouchPoints>0 && "capture" in HTMLInputElement.prototype);
    assert.deepEqual(sources,[true,true,true,capture]);
    if (!capture) await page.evaluate(()=>{
      // The desktop Chromium binary can expose touch input without the mobile camera property.
      // Supply that platform capability only for the positive capture-picker test.
      Object.defineProperty(HTMLInputElement.prototype,"capture",{configurable:true,get(){return this.getAttribute("capture");}});
    });
    assert.equal(await page.evaluate(()=>!!globalThis.AtriumNotebookImageUI||!!globalThis.AtriumNotebookMedia),false);
    assert.deepEqual(await page.evaluate(()=>[mediaFixture.hydrations,mediaFixture.assetReads,mediaFixture.history.length]),[0,0,0]);
    await input.press("Escape");

    for (const [title,operation] of [["Image from File","pick"],["Image from Clipboard","paste"],["PDF Datasheet Clip","clip"],["Take Photo","camera"]]) {
      await page.evaluate(typ=>{mediaFixture.selected=typ;mediaFixture.history.length=0;},operation==="clip"?"application/pdf":"image/png");
      const before=await model(); await open(title);
      const camera = operation==="camera"?page.waitForEvent("filechooser"):null;
      await choose(title,operation==="paste");
      if(camera) await (await camera).setFiles({name:"Camera.png",mimeType:"image/png",buffer:Buffer.from(png)});
      if(operation==="clip") {
        const crop=page.locator("dialog.notebook-image-dialog[open]");
        await crop.getByRole("button",{name:"Use region"}).click();
      }
      await wait(()=>AtriumNavHost.doc().items.some(i=>i.asset));
      const placed = await page.evaluate(()=>({item:AtriumNavHost.doc().items.at(-1),ids:AtriumNavHost.selection(),log:mediaFixture.history}));
      assert.deepEqual([placed.item.x,placed.item.y],anchor); assert.ok(placed.ids.includes(placed.item.id));
      assert.equal(placed.item.asset.mediaType,"image/png"); assert.ok(placed.log.some(([op])=>op===operation));
      if(operation==="pick") assert.ok(!placed.log[0][1].mediaTypes.includes("application/pdf"));
      if(operation==="clip") {assert.deepEqual(placed.log[0][1].mediaTypes,["application/pdf"]);assert.equal(placed.item.clip.page,1);}
      if(operation==="paste") assert.ok(!placed.log.some(([op])=>op==="pick"));
      await undo(before); console.log("  "+title+" placement and Undo");
    }
    const before=await model(); await page.evaluate(()=>{mediaFixture.hold=true;mediaFixture.history.length=0;});
    await open("Image from File"); await choose("Image from File"); await wait(()=>!!mediaFixture.resume);
    await page.evaluate(()=>{const f=mediaFixture,h=AtriumNavHost;h.selectDocument(f.ids[1]);h.selectDocument(f.ids[0]);f.resume();});
    await wait(()=>mediaFixture.released.length>0 || /cancel|abort|changed|switch/i.test(document.getElementById("status").textContent));
    assert.equal(await model(),before);

    await page.evaluate(()=>{mediaFixture.folder=false;});
    await open("/calc 3 V * 2"); await choose("Calculation");
    const composer=page.getByRole("dialog",{name:"Place calculation"});
    assert.equal(await composer.getByLabel("Expression",{exact:true}).inputValue(),"3 V * 2");
    await composer.getByRole("button",{name:"Insert calculation",exact:true}).click();
    await wait(()=>AtriumNavHost.doc().items.some(i=>i.calculation));
    const block=await page.evaluate(()=>{
      const item=AtriumNavHost.doc().items.at(-1);
      return {point:[item.x,item.y],source:AtriumCalculationRecords.read(item).source};
    });
    assert.deepEqual(block.point,anchor);assert.equal(block.source,"3 V * 2");
    await undo(before);
    console.log("  Tab-switch cancellation, calculation composer and Undo");
    for (const [text,name] of [["/todo Inspect LED","Checklist"],["/todo-list Verify regulator","To-do list"]]) {
      await open(text); await choose(name, name==="To-do list");
      await wait(()=>AtriumNavHost.doc().items.some(i=>i.richText||i.widget));
      const item=await page.evaluate(()=>AtriumNavHost.doc().items.at(-1));
      if (name==="Checklist") {
        assert.equal(item.richText.blocks[0].style,"check"); assert.match(item.text,/Inspect LED/);
      } else {
        assert.equal(item.widget.type,"todo"); assert.equal(item.widget.state.rows[0].text,"Verify regulator");
      }
      assert.deepEqual([item.x,item.y],anchor); await undo(before);
    }
    await open("/math x^2"); await choose("Equation");
    const equation=page.getByRole("dialog",{name:"Insert equation"});
    assert.equal(await equation.getByLabel("TeX source").inputValue(),"x^2");
    await equation.getByRole("button",{name:"Insert equation",exact:true}).click();
    await wait(()=>AtriumNavHost.doc().items.some(i=>i.math));
    const item=await page.evaluate(()=>AtriumNavHost.doc().items.at(-1));
    assert.deepEqual([item.x,item.y],anchor); assert.equal(item.text,"x^2"); await undo(before);
    console.log("  Rich checklist, To-do list widget and TeX editor with Undo");
    for (const [action,label] of [["Print","Print…"],["Export PDF","Export: PDF…"]]) {
      await open(">"+action); await choose(label);
      const output=page.getByRole("dialog",{name:action,exact:true});
      await output.getByLabel("Attach portable project ZIP",{exact:true}).waitFor();
      await output.getByRole("button",{name:"Close",exact:true}).click();
      assert.equal(await model(),before);
    }
    if (await page.evaluate(()=>AtriumLazy.modules().includes("AtriumReviewNotes"))) {
      for (const [title,kind] of [["Sticky note","sticky"],["Callout","callout"],["Review checklist","reviewChecklist"]]) {
        await open(title); await choose(title);
        await wait(kind=>AtriumNavHost.doc().items.some(i=>AtriumMarkup.kind(i)===kind),kind);
        const card=await page.evaluate(kind=>AtriumNavHost.doc().items.find(i=>AtriumMarkup.kind(i)===kind&&AtriumNavHost.selection().includes(i.id)),kind);
        assert.deepEqual([card.x,card.y],anchor);
        if (kind!=="reviewChecklist") await page.getByRole("button",{name:"Finish editing",exact:true}).click();
        await undo(before);
      }
      await open("Sketch"); await choose("Sketch"); await wait(()=>AtriumNavHost.tool()==="sketch");
      await page.keyboard.press("Escape"); assert.equal(await model(),before);
    }
    assert.deepEqual(errors,[]);console.log("  Existing Print, Export PDF and installed Review Notes actions");
  } catch(error) {
    console.error(await page.locator("dialog[open]").allTextContents(),await page.locator("#status").textContent(),errors);
    throw error;
  } finally {await page.close();}
}

if(require.main===module) (async()=>{
  const server=createStaticServer({root,requireFile:true,mime:{".js":"text/javascript",".mjs":"text/javascript",".html":"text/html",".css":"text/css",".svg":"image/svg+xml",".png":"image/png"}});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const browser=await chromium.launch({channel:"chrome",headless:true});
  try{await check(browser,"http://127.0.0.1:"+server.address().port);}finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
module.exports=check;
