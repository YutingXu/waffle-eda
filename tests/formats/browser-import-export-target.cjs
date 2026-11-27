"use strict";
// Use Chromium's real OPFS file handles, exclusive streams, structured handle persistence
// and SHA verification. Only the human's system-picker selection is supplied by the harness.
const assert = require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require('../support/playwright.cjs');
(async()=>{
  const allowed = new Set(['import-export.js','import-export-browser.js','zip.js']);
  const server=http.createServer((req,res)=>{
    const name=req.url.slice(1);
    if (!name) {res.setHeader('Content-Type','text/html');res.end('<!doctype html><script src="/zip.js"></script><script src="/import-export.js"></script><script src="/import-export-browser.js"></script>');return;}
    if (!allowed.has(name)) {res.writeHead(404).end();return;}
    res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(require("../support/app-source-paths.cjs").appFile(name)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:'chrome'});
    const context=await browser.newContext(),page=await context.newPage(),url='http://127.0.0.1:'+server.address().port+'/';
    const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);
    async function init() {
      window.testRoot=await navigator.storage.getDirectory();
      window.service=AtriumBrowserImportExport;
      window.create=async function(name,text){const h=await testRoot.getFileHandle(name,{create:true});const w=await h.createWritable();await w.write(text);await w.close();return h;};
      window.makeSource=async h=>Object.assign(await h.getFile(),{handle:h});
      window.read=async h=>(await h.getFile()).text();
      window.b=s=>new TextEncoder().encode(s);
      window.check={current:()=>true};
      window.sourceHandle=await testRoot.getFileHandle('original.sch',{create:true});
      window.file=await makeSource(sourceHandle);
      window.req={file,sources:[file],sourceKey:'verified-synthetic-source'};
    }
    await page.evaluate(init);
    const first=await page.evaluate(async()=>{
      await create('original.sch','immutable input');
      const target=await create('Board export.zip','');
      const selections=[];
      window.showSaveFilePicker=async o=>{selections.push(o.suggestedName);return sourceHandle;};
      let same=false;try{await service.writeImportExport({...req,name:'original.sch',bytes:b('wrong')},check);}catch(e){same=e.message.includes('imported source');}
      window.showSaveFilePicker=async o=>{selections.push(o.suggestedName);return target;};
      const receipt=await service.writeImportExport({...req,name:'Board export',files:[{name:'a.sch',bytes:b('sheet')},{name:'b.brd',bytes:b('board')}]},check);
      const chosenBefore=await service.recalledImportExport(req), scope=service.rememberScope(req);
      await service.rememberImportExport({...req,destination:receipt.destination});
      const zipped=new Uint8Array(await(await target.getFile()).arrayBuffer());
      return {same,scope,before:chosenBefore,original:await read(sourceHandle),magic:[...zipped.slice(0,4)],members:new TextDecoder().decode(zipped).includes('b.brd'),selections,receipt};
    });
    assert.equal(first.same,true);assert.equal(first.scope,'project');assert.equal(first.before,null);assert.equal(first.original,'immutable input');
    assert.deepEqual(first.magic,[80,75,3,4]);assert.equal(first.members,true);assert.deepEqual(first.selections,['original-export.sch','Board export.zip']);
    // Existing installs stored a single row per digest. Reopen one of those exact
    // rows, then let the normal committed update migrate it to the multi-source form.
    await page.evaluate(async()=>{
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('waffle-import-export',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      await new Promise((resolve,reject)=>{
        const tx=db.transaction('destinations','readwrite'),table=tx.objectStore('destinations'),r=table.get(req.sourceKey);
        r.onsuccess=()=>table.put(r.result.rows[0],req.sourceKey);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
      });
      db.close();
    });
    await page.reload();await page.evaluate(init);
    const restored=await page.evaluate(async()=>{
      const old=await service.recalledImportExport(req);
      if (!old) throw Error('The verified source and remembered browser file did not reopen.');
      const other=await makeSource(await create('other.sch','immutable input'));
      const separate=await service.recalledImportExport({file:other,sources:[other],sourceKey:req.sourceKey});
      const target=await testRoot.getFileHandle(old.name);
      await service.writeImportExport({...req,name:old.name,bytes:b('live edited output'),destination:old.destination},check);
      const edited=await read(target);
      let calls=0, cancelled=false;
      try{await service.writeImportExport({...req,name:old.name,bytes:b('cancelled'),destination:old.destination},{current:()=>++calls<2});}catch(e){cancelled=e.code==='stale_destination';}
      const untouched=await read(target);
      await create(old.name,'externally changed');let stale=false;
      try{await service.writeImportExport({...req,name:old.name,bytes:b('must not replace'),destination:old.destination},check);}catch(e){stale=e.code==='stale_destination';}
      const external=await read(target), cleared=await service.recalledImportExport(req);
      const next=await create('deletable.sch','');window.showSaveFilePicker=async()=>next;
      const saved=await service.writeImportExport({...req,name:next.name,bytes:b('one')},check);
      await service.rememberImportExport({...req,destination:saved.destination});
      await testRoot.removeEntry(next.name);
      return {old,separate,edited,cancelled,untouched,stale,external,cleared,removed:await service.recalledImportExport(req)};
    });
    assert.equal(restored.old.destination,first.receipt.destination);assert.equal(restored.separate,null);assert.equal(restored.edited,'live edited output');
    assert.ok(restored.cancelled);assert.equal(restored.untouched,restored.edited);assert.ok(restored.stale);assert.equal(restored.external,'externally changed');assert.equal(restored.cleared,null);assert.equal(restored.removed,null);
    const updated=await page.evaluate(async()=>{
      const target=await create('warning.sch','');window.showSaveFilePicker=async()=>target;
      const initial=await service.writeImportExport({...req,name:target.name,bytes:b('old')},check);
      await service.rememberImportExport({...req,destination:initial.destination});
      const put=IDBObjectStore.prototype.put;
      let saved;
      try {
        IDBObjectStore.prototype.put=function(){throw new DOMException('Preference quota exhausted','QuotaExceededError');};
        saved=await service.writeImportExport({...req,destination:initial.destination,bytes:b('verified completed export'),name:target.name},check);
      } finally {IDBObjectStore.prototype.put=put;}
      return {saved,actual:await read(target),remembered:await service.recalledImportExport(req)};
    });
    assert.ok(updated.saved.destination);assert.match(updated.saved.preferenceError,/quota/);assert.equal(updated.actual,'verified completed export');assert.equal(updated.remembered,null);
    const secondPage=await context.newPage();await secondPage.goto(url);
    const pages=[page,secondPage];
    async function sameBytes(side) {
      const folder=await testRoot.getDirectoryHandle(side,{create:true});
      const source=await folder.getFileHandle('Same.sch',{create:true});
      const w=await source.createWritable();await w.write('identical source');await w.close();
      const file=await makeSource(source);
      window.twins={file,sources:[file],sourceKey:'same-name-and-digest'};
      window.destination=await create(side+' output.sch','');
      window.showSaveFilePicker=async()=>destination;
    }
    await Promise.all(pages.map((p,i)=>p.evaluate(init).then(()=>p.evaluate(sameBytes,'copy'+i))));
    const savedTwins=await Promise.all(pages.map((p,i)=>p.evaluate(async n=>{
      const saved=await service.writeImportExport({...twins,name:destination.name,bytes:b('export '+n)},check);
      await service.rememberImportExport({...twins,destination:saved.destination});
      return saved.destination;
    },i)));
    assert.notEqual(savedTwins[0],savedTwins[1]);
    for (const [i,p] of pages.entries()) {
      await p.reload();await p.evaluate(init);
      const reopened=await p.evaluate(async n=>{
        const dir=await testRoot.getDirectoryHandle('copy'+n),file=await makeSource(await dir.getFileHandle('Same.sch'));
        window.twins={file,sources:[file],sourceKey:'same-name-and-digest'};
        const old=await service.recalledImportExport(twins);
        const result=await service.writeImportExport({...twins,name:old.name,bytes:b('editing '+n),destination:old.destination},check);
        return [result.destination,await read(await testRoot.getFileHandle(old.name))];
      },i);
      assert.deepEqual(reopened,[savedTwins[i],'editing '+i]);
    }
    await secondPage.evaluate(()=>service.forgetImportExport(twins));
    assert.equal(await secondPage.evaluate(()=>service.recalledImportExport(twins)),null);
    assert.equal(await page.evaluate(async()=>(await service.recalledImportExport(twins)).destination),savedTwins[0]);
    const replacement=await secondPage.evaluate(async()=>{
      const dir=await testRoot.getDirectoryHandle('copy0'),file=await makeSource(await dir.getFileHandle('Same.sch'));
      const group={file,sources:[file],sourceKey:'same-name-and-digest'},updated=await create('alternate.sch','');
      window.showSaveFilePicker=async()=>updated;
      const saved=await service.writeImportExport({...group,name:updated.name,bytes:b('alternate')},check);
      await service.rememberImportExport({...group,destination:saved.destination});
      return saved.destination;
    });
    // An older tab cannot erase a later confirmed grant for the same physical source.
    await page.evaluate(()=>service.forgetImportExport(twins));
    assert.equal(await page.evaluate(async()=>(await service.recalledImportExport(twins)).destination),replacement);
    await secondPage.close();
    const limits=await page.evaluate(async()=>{
      const plain=await sourceHandle.getFile(), unsafe={file:plain,sources:[plain],sourceKey:req.sourceKey};
      const fresh=await create('fresh.sch','');window.showSaveFilePicker=async()=>fresh;
      const receipt=await service.writeImportExport({...unsafe,name:'ordinary.sch',bytes:b('ordinary draft')},check);
      await service.rememberImportExport({...unsafe,destination:receipt.destination});
      const open=!!await service.recalledImportExport(unsafe), sameBytes=await sourceHandle.getFile();
      const freshOpen=await service.recalledImportExport({...unsafe,file:sameBytes,sources:[sameBytes]});
      const limited=service.rememberScope(unsafe);
      const lookalike=service.rememberScope({sources:[{name:'copy.sch',handle:{kind:'file',isSameEntry:async()=>true}}]});
      window.showSaveFilePicker=undefined;let fileName;
      globalThis.AtriumIO={exportFile:async n=>{fileName=n;return true;}};
      const download=await service.writeImportExport({...unsafe,name:'original.sch',bytes:b('ordinary draft')},check);
      return {open,freshOpen,limited,lookalike,download,fileName,canRemember:service.canRemember(),original:await read(sourceHandle)};
    });
    assert.ok(limits.open);assert.equal(limits.freshOpen,null);assert.equal(limits.limited,'session');assert.equal(limits.lookalike,'session');assert.equal(limits.download.downloaded,true);
    assert.equal(limits.fileName,'original-export.sch');assert.equal(limits.canRemember,false);assert.equal(limits.original,'immutable input');
    assert.deepEqual(errors,[]);console.log('PASS remembered browser export, immutable input, stale destination, cancellation, scoped ZIP and download-only fallback');
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
