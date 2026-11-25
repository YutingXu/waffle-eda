"use strict";

const assert = require("node:assert/strict");
const {createHash}=require("node:crypto");
const path = require("node:path");
const fs = require("node:fs/promises");
const {pathToFileURL} = require("node:url");
const {chromium} = require("playwright-core");

async function scenario(browser, modern) {
  const page = await browser.newPage({viewport:{width:1260,height:880},deviceScaleFactor:2,acceptDownloads:true});
  const errors = [];
  page.on("pageerror",error=>errors.push(error.message));
  page.setDefaultTimeout(12000);
  const client = await page.context().newCDPSession(page);
  const filename = path.join(__dirname,"../fixtures/butter-acceptance/drop/input.csv");
  try {
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.waitForFunction(()=>!!globalThis.AtriumNavHost);
    const initial = await page.evaluate(async modern=>{
      AtriumPrefs.set("general.startPage","never");
      AtriumStartPage.close();
      AtriumPrefs.set("labs.notebook",true);
      const H=AtriumNavHost;
      await H.selectDocument(H.project().documents.find(doc=>doc.kind==="schematic").id);
      await AtriumLazy.need("AtriumSheetWidgets");
      const table=AtriumSheetWidgets.make("table",[-12,-10]);
      if (modern) {
        AtriumPrefs.set("butter.tables",true);
        table.widget.state=(await AtriumLazy.need("AtriumTableData")).create();
      }
      if(!H.edit(()=>H.doc().items.push(table),"Create the receiving table",[table]))
        throw Error("The fixture table could not be created.");
      H.act("fit-document");
      window.dropProof={id:table.id,drag:null,original:JSON.stringify(table.widget.state)};
      window.addEventListener("drop",event=>{
        dropProof.drag={trusted:event.isTrusted,files:event.dataTransfer.files.length,start:performance.now()};
      },true);
      return {enabled:AtriumPrefs.get("butter.drop"),module:typeof globalThis.AtriumDropEditor};
    },modern);
    assert.deepEqual(initial,{enabled:false,module:"undefined"});
    const position = async () => (await page.waitForFunction(()=>{
      const H=AtriumNavHost,T=H.doc().items.find(item=>item.id===dropProof.id);
      const b=H.canvas().getBoundingClientRect();
      for (const [dx,dy] of [[12,8],[10,2],[1,1],[28,15]]) {
        const [x,y]=H.view().worldToScreen([T.x+dx,T.y+dy]);
        const hit=H.hit(H.canvas(),x+b.left,y+b.top);
        if (hit?.item?.id===T.id && document.elementFromPoint(x+b.left,y+b.top)===H.canvas())
          return {x:x+b.left,y:y+b.top};
      }
      return null;
    },null,{timeout:5000})).jsonValue();
    const send = async (type,file=filename)=>client.send("Input.dispatchDragEvent",{
      type,...await position(),data:{items:[],files:[file],dragOperationsMask:1}
    });
    await page.evaluate(()=>AtriumPrefs.set("butter.drop",true));
    await page.waitForFunction(()=>!!globalThis.AtriumDropEditor);
    await send("dragEnter");
    await send("dragOver");
    await send("drop");
    await page.waitForFunction(()=>{
      const table=AtriumNavHost.doc().items.find(item=>item.id===dropProof.id);
      return table.widget.state.rows.length===2;
    });
    const observed = await page.evaluate(()=>{
      const state=AtriumNavHost.doc().items.find(item=>item.id===dropProof.id).widget.state, {columns,rows}=state;
      const original=JSON.parse(dropProof.original);
      return {trusted:dropProof.drag.trusted,files:dropProof.drag.files,ms:performance.now()-dropProof.drag.start,
        headers:columns.map(column=>column.title),stable:rows.every((row,i)=>row.id===original.rows[i]?.id) &&
          columns.every((column,i)=>column.id===original.columns[i]?.id),
        values:rows.map(row=>columns.map(column=>state.tableVersion===1
          ? AtriumTableData.get(state,row.id,column.id).content.text
          : row[AtriumWidgetCatalogue.keyFor(column.id)].text))};
    });
    assert.equal(observed.trusted,true);
    assert.equal(observed.files,1);
    assert.deepEqual(observed.headers,["Item","Value"]);
    assert.deepEqual(observed.values,[["AC, filter","=SUM(A1)"],["R3","12 Ω"]]);
    if (modern) {
      assert.equal(observed.stable,true);
      await send("dragEnter");
      await send("dragOver");
      await send("drop");
      await page.waitForFunction(()=>{
        const s=AtriumNavHost.doc().items.find(item=>item.id===dropProof.id).widget.state;
        return s.rows.length===4 && s.cells.length===8;
      });
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(item=>item.id===dropProof.id).widget.state.rows.length===2);
    }
    await page.evaluate(()=>AtriumNavHost.act("undo"));
    await page.waitForFunction(()=>JSON.stringify(AtriumNavHost.doc().items.find(item=>item.id===dropProof.id)?.widget.state)===dropProof.original);

    if (modern) {
      const component=path.join(__dirname,"../fixtures/butter-acceptance/drop/libraries/Resistor.wlib");
      const original=await page.evaluate(()=>{
        const H=AtriumNavHost;
        return {library:H.project().library.length,items:H.doc().items.length};
      });
      await send("dragEnter",component);
      await send("dragOver",component);
      await send("drop",component);
      await page.waitForFunction(({library,items})=>AtriumNavHost.project().library.length===library+1 &&
        AtriumNavHost.doc().items.length===items+1,original);
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      await page.waitForFunction(({library,items})=>AtriumNavHost.project().library.length===library &&
        AtriumNavHost.doc().items.length===items,original);
      const componentBytes=(await fs.readFile(component)).toString("base64");
      const definitionId=await page.evaluate(async componentBytes=>{
        const H=AtriumNavHost, L=AtriumLibrary;
        const member=await AtriumNativeMemberUI.readComponent(new File([Uint8Array.fromBase64(componentBytes)],"Resistor.wlib"));
        if (!L.sourceStore.save([member])) throw Error("Could not set up the linked library.");
        window.fixtureLibrary=member;
        H.act("library-panel");
        return member.defs[0].id;
      },componentBytes);
      await page.locator(".lib-row").first().waitFor();
      await page.evaluate(()=>AtriumLibrary.reveal(fixtureLibrary.defs[0],fixtureLibrary));
      const row=page.locator('.lib-row[data-def="'+definitionId+'"]');
      const bounds=await page.locator("#canvas").boundingBox();
      const point=await position();
      await row.dragTo(page.locator("#canvas"),{targetPosition:{x:point.x-bounds.x,y:point.y-bounds.y}});
      await page.waitForFunction(({library,items})=>AtriumNavHost.project().library.length===library+1 &&
        AtriumNavHost.doc().items.length===items+1,original);
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      await page.waitForFunction(({library,items})=>AtriumNavHost.project().library.length===library &&
        AtriumNavHost.doc().items.length===items,original);
      await page.evaluate(()=>AtriumNavHost.act("library-panel"));
    }

    // Hold the selected stream until Escape cancels the pending drop. The
    // production handler still receives a real Chromium file drop and key.
    await page.evaluate(()=>{
      const read=File.prototype.stream;
      dropProof.cancelled=false;
      File.prototype.stream=function() {
        if (this.name!=="input.csv") return read.call(this);
        dropProof.reading=performance.now();
        return new ReadableStream({cancel() {dropProof.cancelled=performance.now();}});
      };
    });
    await send("dragEnter");
    await send("dragOver");
    await send("drop");
    await page.waitForFunction(()=>dropProof.reading);
    await page.keyboard.press("Escape");
    await page.waitForFunction(()=>dropProof.cancelled);
    const cancelled = await page.evaluate(()=>({ms:dropProof.cancelled-dropProof.reading,
      rows:AtriumNavHost.doc().items.find(item=>item.id===dropProof.id).widget.state.rows.length}));
    assert.equal(cancelled.rows,modern ? 4 : 1);
    const [image] = await Promise.all([
      page.waitForEvent("download"),
      page.evaluate(async()=>{
        const editor=await AtriumLazy.need("AtriumButterEditor"),host=AtriumNavHost;
        const receipt=await editor.apply("butter.drop.export-selection",{
          documentId:host.doc().id,objectIds:[dropProof.id],format:"png",width:240});
        if(!receipt.saved)throw Error("PNG export did not finish.");
      })
    ]);
    const png=await fs.readFile(await image.path());
    assert.match(image.suggestedFilename(),/-selection\.png$/u);
    assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    assert.equal(png.readUInt32BE(16),240);
    assert.deepEqual(errors,[]);
    console.log("PASS trusted Chromium drag, literal CSV, one-step Undo, Escape cancellation and selection PNG",JSON.stringify({
      table:modern ? "sparse" : "legacy",
      dropThroughObservationMs:observed.ms,cancelSinceReadStartedMs:cancelled.ms
    }));
  } catch (error) {
    console.error(await page.evaluate(()=>{
      const H=AtriumNavHost, table=H.doc().items.find(item=>item.id===dropProof.id);
      const c=H.canvas(), b=c.getBoundingClientRect(), [x,y]=H.view().worldToScreen([table.x+12,table.y+8]);
      return {status:document.getElementById("status")?.textContent, kind:H.doc().kind, table,
        hit:H.hit(c,x+b.left,y+b.top)?.item?.id, over:document.elementFromPoint(x+b.left,y+b.top)?.outerHTML?.slice(0,200)};
    }));
    throw error;
  } finally {await page.close();}
}

async function mediaScenario(browser) {
  const page = await browser.newPage({viewport:{width:1260,height:880}});
  page.setDefaultTimeout(12000);
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  const client = await page.context().newCDPSession(page);
  const filename = path.join(__dirname,"../fixtures/altium/notebook-outputs/clip/notebook-4e730000627afacfa5dfad6cfac9bb9675b395cb9046ddce424effcdecccfca1.png");
  const bytes = await fs.readFile(filename), name=path.basename(filename);
  const assetRef = {sha256:createHash("sha256").update(bytes).digest("hex"),byteLength:bytes.length,mediaType:"image/png"};
  const expected = bytes.toString("base64");
  try {
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.waitForFunction(()=>!!globalThis.AtriumNavHost);
    await page.evaluate(async ({name,assetRef,expected})=>{
      AtriumPrefs.set("general.startPage","never");
      AtriumStartPage.close();
      AtriumPrefs.set("labs.notebook",true);
      AtriumPrefs.set("butter.drop",true);
      const H = AtriumNavHost;
      await H.selectDocument(H.project().documents.find(doc=>doc.kind==="schematic").id);
      await AtriumLazy.need("AtriumDropEditor");
      const reads = File.prototype.stream, buffers=File.prototype.arrayBuffer;
      const probe = window.mediaProof = {streams:0,buffers:0,previewReads:0,transfers:0,staged:0,released:0};
      File.prototype.stream=function(){if(this.name===name)probe.streams++;return reads.call(this);};
      File.prototype.arrayBuffer=function(){if(this.name===name)probe.buffers++;return buffers.call(this);};
      const session = {grant:"fixture",canEdit:()=>true,
        stageAttachment(){probe.staged++;},
        releaseAsset(){probe.released++;},
        readAsset({purpose}) {
          if (purpose==="preview") probe.previewReads++;
          return {bytes:Uint8Array.fromBase64(expected)};
        }};
      H.folderProject = ()=>session;
      window.webkit = {messageHandlers:{atriumHost:{postMessage(json) {
        const packet = JSON.parse(json);
        if (packet.action!=="notebookTransfer") return;
        probe.transfers++;
        probe.origin=packet.origin;
        probe.match=packet.name===name && packet.data===expected && packet.mediaType==="image/png" && packet.grant===session.grant;
        const reply=()=>window.__atriumReceive(packet.id,{assetToken:"drop-"+probe.transfers,assetRef,ownerId:packet.ownerId},null);
        if (probe.hold) probe.resume=reply; else reply();
      }}}};
    },{name,assetRef,expected});
    await page.addScriptTag({path:path.join(__dirname,"../../native/bridge.js")});
    const point = await page.evaluate(()=>{
      const c=AtriumNavHost.canvas(), b=c.getBoundingClientRect();
      return {x:b.left+b.width/2,y:b.top+b.height/2};
    });
    const drop = async () => {
      for (const type of ["dragEnter","dragOver","drop"])
        await client.send("Input.dispatchDragEvent",{type,...point,data:{items:[],files:[filename],dragOperationsMask:1}});
    };
    await drop();
    await page.waitForFunction(()=>mediaProof.staged===1);
    assert.deepEqual(await page.evaluate(()=>({
      streams:mediaProof.streams,buffers:mediaProof.buffers,previewReads:mediaProof.previewReads,
      transfers:mediaProof.transfers,origin:mediaProof.origin,match:mediaProof.match,
      hash:AtriumNavHost.doc().items.find(item=>item.kind==="image")?.asset.sha256
    })),{streams:1,buffers:0,previewReads:0,transfers:1,origin:"drop",match:true,hash:assetRef.sha256});
    await page.evaluate(()=>{AtriumNavHost.act("undo");mediaProof.hold=true;});
    await page.waitForFunction(()=>!AtriumNavHost.doc().items.some(item=>item.kind==="image"));
    await drop();
    await page.waitForFunction(()=>!!mediaProof.resume);
    await page.keyboard.press("Escape");
    await page.evaluate(()=>mediaProof.resume());
    await page.waitForFunction(()=>mediaProof.released===1);
    assert.equal(await page.evaluate(()=>AtriumNavHost.doc().items.some(item=>item.kind==="image")),false);
    console.log("PASS approved media read once, exact staged bytes, one-step Undo and cancellation during native staging");
  } catch (error) {
    console.error(await page.evaluate(()=>({media:mediaProof,status:document.getElementById("status")?.textContent})),errors);
    throw error;
  } finally {await page.close();}
}

(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless:true,args:["--allow-file-access-from-files"]});
  try {await scenario(browser,false);await scenario(browser,true);await mediaScenario(browser);} finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
