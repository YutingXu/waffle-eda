"use strict";
const assert = require("node:assert/strict");
const {mkdtemp,writeFile,readFile,rm} = require("node:fs/promises");
const os = require("node:os"), path = require("node:path");
const {pathToFileURL} = require("node:url");
const {fixture} = require("../support/datasheet-pdf.cjs");

module.exports = async function datasheets(browser) {
  const stage = await mkdtemp(path.join(os.tmpdir(),"waffle-datasheet-browser-"));
  // The trailing slash makes the base the app folder itself, not its parent.
  const app = pathToFileURL(path.join(__dirname,"../../app/")).href;
  const entry = path.join(stage,"reader.html");
  const probe = await readFile(path.join(__dirname,"../support/datasheet-probe.js"),"utf8");
  await writeFile(entry, '<!doctype html><meta charset="utf-8"><base href="'+app+
    '"><script src="datasheet-worker-source.js"></script><script src="notebook/datasheet-record.js"></script><script src="notebook/datasheets.js"></script>'+
    '<script src="notebook/notebook-image-format.js"></script><script src="notebook/notebook-media.js"></script>'+
    '<script>globalThis.AtriumLazy={need:async name=>window[name]};\n'+probe+'</script>');
  const page = await browser.newPage(), errors = [];
  page.on("pageerror",error=>errors.push(error.message));
  try {
    await page.goto(pathToFileURL(entry).href);
    const data = await page.evaluate(pdf=>window.runDatasheetProbe(pdf),fixture(300).toString("base64"));
    assert.equal(data.unopened,true);
    assert.deepEqual(data.untouched,{parseRequests:0,liveReaders:0});
    assert.equal(data.pages,300);
    assert.equal(data.colored,true,"the PDF worker rasterized real page drawing operators");
    assert.deepEqual(data.rows,[["Pin","Name","Function"],["1","VCC","Power"],["2","GND","Ground"]]);
    assert.deepEqual(data.current,[4]);
    assert.equal(data.cancelled,"AbortError");
    assert.ok(data.snip[0]===240 && data.snip[1]<240);
    assert.deepEqual(data.occurrences,[1]);
    assert.deepEqual(data.ended,{parseRequests:2,liveReaders:0});
    assert.equal(data.warmMs.length,10);
    assert.ok(data.warmMs.every((time,i)=>Number.isFinite(time) && time>0 && time<=data.presentedMs[i]));
    const lifecycle = await page.evaluate(async ({regular,annotated})=>{
      const service = AtriumDatasheets, bytes = Uint8Array.from(atob(regular),c=>c.charCodeAt(0));
      const raster = Uint8Array.from(atob(annotated),c=>c.charCodeAt(0));
      const RealWorker = Worker;
      let workers=0, live=0, peak=0, pause;
      globalThis.Worker = class extends RealWorker {
        constructor(...args) {super(...args);workers++;peak=Math.max(peak,++live);}
        terminate() {live--;super.terminate();}
        postMessage(message,transfer) {
          if (message.op==="open" && pause) {pause(()=>super.postMessage(message,transfer));return;}
          super.postMessage(message,transfer);
        }
      };
      const settle = promise=>Promise.race([promise.then(()=>null,e=>e.name),
        new Promise(resolve=>setTimeout(()=>resolve("pending"),750))]);
      // Cancel one wait for an in-flight open while another reader still needs
      // it, then repeat with no remaining demand and no parser reply.
      const pair = await Promise.all([service.createReaderFromBytes(bytes),service.createReaderFromBytes(bytes)]);
      let queued = Promise.withResolvers();
      pause=queued.resolve;
      const first=pair[0].visible([1]), remaining=pair[1].info();
      const proceed=await queued.promise;
      await pair[0].visible([]);
      const oneCancelled=await settle(first), stillLive=live;
      pause=undefined;
      proceed();
      const sharedPages=(await remaining).pages, sharedWorkers=workers;
      pair.forEach(reader=>reader.close());

      queued=Promise.withResolvers();
      pause=queued.resolve;
      const lone=await service.createReaderFromBytes(bytes);
      const opening=lone.visible([1]);
      await queued.promise;
      await lone.visible([]);
      const allCancelled=await settle(opening), stopped=live;
      pause=undefined;
      const retry=(await lone.info()).pages;
      lone.close();

      const many = await Promise.all(Array.from({length:10},(_,i)=>{
        const distinct=Uint8Array.from([...bytes,10,37,48+i,10]);
        return service.createReaderFromBytes(distinct);
      }));
      const completed = await Promise.all(many.map(reader=>reader.info()));
      const capacity=peak;
      many.forEach(reader=>reader.close());

      const region=[100000,50000,900000,950000], side=320;
      const source=await service.createReaderFromBytes(raster);
      const notebook=await AtriumNotebookMedia.pdf(raster);
      const library=await source.snip({page:1,region,side}), sheet=await notebook.render(1,region,side);
      const samePNG=library.png.length===sheet.png.length && library.png.every((value,i)=>value===sheet.png[i]);
      const image=await createImageBitmap(new Blob([sheet.png],{type:"image/png"})), canvas=document.createElement("canvas");
      canvas.width=image.width;canvas.height=image.height;
      const ctx=canvas.getContext("2d");
      ctx.drawImage(image,0,0);image.close();
      const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      const red=rgba.some((value,i)=>i%4===0 && value>180 && rgba[i+1]<100 && rgba[i+2]<100);
      const blue=rgba.some((value,i)=>i%4===0 && value<100 && rgba[i+2]>100);
      source.close();notebook.close();
      return {oneCancelled,stillLive,sharedPages,sharedWorkers,allCancelled,stopped,retry,capacity,
        completed:completed.length,live,samePNG,red,blue,dimensions:[sheet.width,sheet.height],physical:sheet.physical};
    },{regular:fixture().toString("base64"),annotated:fixture(1,{annotated:true}).toString("base64")});
    assert.deepEqual(lifecycle,{oneCancelled:"AbortError",stillLive:1,sharedPages:2,sharedWorkers:1,
      allCancelled:"AbortError",stopped:0,retry:2,capacity:4,completed:10,live:0,samePNG:true,red:false,blue:true,
      dimensions:[203,320],physical:[200,280]});
    await page.reload();
    const embedding = await page.evaluate(async base64=>{
      const raw=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
      const sha256=new Uint8Array(await crypto.subtle.digest("SHA-256",raw)).toHex();
      Object.defineProperty(globalThis,"indexedDB",{value:undefined});
      const project={id:"018cc251-f400-7001-8000-000000000099"};
      const stage={assetToken:"staged",ownerId:project.id,assetRef:{sha256,byteLength:raw.byteLength,mediaType:"application/pdf"}};
      globalThis.AtriumPrefs={get:()=>true};
      globalThis.Atrium={id:()=>"018cc251-f400-7001-8000-000000000090"};
      let edited=false,staged=false,released=false;
      const session={grant:"granted",readAsset:async()=>({bytes:raw}),stageAttachment:()=>{staged=true;},
        releaseAsset:async()=>{released=true;}};
      globalThis.AtriumHost={folderPickAsset:async()=>({sourceToken:"chosen",name:"Exact.pdf"}),
        folderStageAsset:async()=>stage,folderDropAsset:async()=>null};
      globalThis.AtriumButterEditor={apply:async(command,{grant},options)=>{
        options.beforeCommit();
        edited=command==="butter.datasheets.reference";
        return {changes:1,result:{reference:AtriumDatasheets.input(grant,project.id)}};
      }};
      const result=await AtriumDatasheets.chooseEmbedded({host:{project:()=>project,folderProject:()=>session},confirm:()=>true});
      return {edited,staged,released,exact:result.asset.sha256===sha256 && result.asset.byteLength===raw.byteLength,
        ipv6:AtriumDatasheets.safeURL("HTTPS://[2001:0DB8:0:0:0:0:0:1]:443"),origin:AtriumDatasheets.safeURL("HTTPS://EXAMPLE.COM")};
    },Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),fixture()]).toString("base64"));
    assert.deepEqual(embedding,{edited:true,staged:true,released:false,exact:true,ipv6:"https://[2001:db8::1]/",origin:"https://example.com/"});
    assert.deepEqual(errors,[]);
    console.log("Shared PDF worker",JSON.stringify(lifecycle));
    console.log("PDF.js file-origin worker",JSON.stringify(data));
  } finally {await page.close();await rm(stage,{recursive:true,force:true});}
};

if (require.main===module) {
  const {chromium} = require("../support/playwright.cjs");
  (async()=>{
    const browser = await chromium.launch({channel:"chrome"});
    try {await module.exports(browser);} finally {await browser.close();}
  })().catch(error=>{console.error(error);process.exitCode=1;});
}
