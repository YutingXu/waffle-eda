"use strict";

async function clippedMergedImage(page) {
  const before = await page.evaluate(async () => {
    await AtriumPrefs.set("butter.tables", true);
    const host = AtriumNavHost;
    const doc = host.project().documents.find(d => d.kind === "schematic");
    host.selectDocument(doc.id);
    const editor = await AtriumLazy.need("AtriumTableEditor");
    const T = AtriumTableData;
    let state = T.create(24, 20);
    const [sort, , c0, , c2] = state.columns;
    const make = (row, column) => ({rowId: row.id, columnId: column.id});
    const head = make(state.rows[2], c0), tail = make(state.rows[4], c2);
    const sha256 = "b".repeat(64);
    const picture = {kind: "image", alt: "Merged inspection mark", assetRef: {sha256, byteLength: 17, mediaType: "image/png"}};
    state = T.batch(state, [
      ...state.rows.map((row, i) => ({...make(row, sort), content: {kind: "literal", text: i === 0 ? "hide" : "keep " + (i === 2 ? 0 : i)}})),
      {...head, content: picture}, {...tail, content: picture},
    ]);
    state = T.join(state, head, tail);
    state = {...state, columns: state.columns.map((column, i) => i === 0 ? {...column, sortDirection: "asc", filter: "keep"} : column)};
    const item = AtriumSheetWidgets.make("table", [0, 0]);
    item.w = 250;
    item.h = 100;
    item.widget.state = state;
    host.edit(() => doc.items.push(item), "Add synthetic table", [item]);
    const V = AtriumTableVisual;
    const view = V.view(host.project(), doc, item);
    const surface = document.createElement("canvas");
    const ctx = surface.getContext("2d");
    const paints = [];
    ctx.drawImage = (...args) => paints.push(args.slice(1));
    const clip = [35, 6, 50, 12];
    V.draw(ctx, view, {viewport: clip, assets: new Map([[sha256, {surface, width: 8, height: 4}]])});
    const requests = V.imageRequests(host.project(), doc, item, [clip]);
    const outside = V.imageRequests(host.project(), doc, item, [[0,0,5,5]]);
    editor.open(host, doc.id, item.id);
    return {head, paints, requests: requests.map(r => [r.ref.sha256, r.w, r.h]), outside, sha256};
  });
  assert.equal(before.paints.length, 1);
  assert.deepEqual(before.requests, [[before.sha256,42,13.5]]);
  assert.deepEqual(before.outside, []);
  const grid = page.getByRole("grid", {name: "Table cells"});
  const cell = grid.locator('[data-row="' + before.head.rowId + '"][data-column="' + before.head.columnId + '"]');
  await cell.waitFor({state: "attached"});
  const initial = await cell.evaluate(node => [node.getAttribute("aria-rowindex"), node.getAttribute("aria-colindex")]);
  assert.deepEqual(initial, ["1", "3"]);
  await grid.evaluate(async node => {
    node.scrollLeft = 320;
    node.scrollTop = 80;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.equal(await cell.count(), 1);
  const info = await cell.evaluate(node => ["aria-rowindex", "aria-colindex", "aria-rowspan", "aria-colspan"]
    .map(name => node.getAttribute(name)).concat(node.closest('[role="row"]').getAttribute("aria-rowindex")));
  assert.deepEqual(info, ["1", "3", "3", "3", "1"], "a clipped cell retains the anchor's accessible coordinates and spans");
  const rowIndices = await grid.getByRole("row").evaluateAll(rows => rows.filter(row => row.hasAttribute("aria-rowindex"))
    .map(row => Number(row.getAttribute("aria-rowindex"))));
  assert.deepEqual(rowIndices, rowIndices.slice().sort((a,b) => a-b), "offscreen anchors precede later rows in the accessibility tree");
  await page.getByRole("dialog", {name: "Edit table"}).getByRole("button", {name: "Done", exact: true}).click();
}

async function checkGuardedConfigure(page) {
  const result = await page.evaluate(async () => {
    await AtriumLazy.need("AtriumButterEditor");
    const host = AtriumNavHost, documentId = host.currentId();
    const itemId = host.doc().items.find(item => item.widget?.state?.tableVersion === 1).id;
    const read = () => JSON.stringify(host.doc().items.find(item => item.id === itemId).widget.state);
    const before = read(), command = "butter.tables.configure";
    const args = {documentId, itemId, headerRows:1, banded:true};
    const drafted = await AtriumButter.run(command, args);
    const changed = await AtriumButterEditor.apply(command, args);
    let stale;
    try { AtriumProposal.prepare(host.project(), drafted.proposal, Atrium.validate); }
    catch (error) {stale = error.message;}
    await host.act("undo");
    const operation = drafted.proposal.ops[0];
    return {path:drafted.proposal.ops.map(op => op.path), changes:changed.changes, stale, restored:read() === before,
      fields:[operation.before.headerRows, operation.after.headerRows, operation.before.banded, operation.after.banded]};
  });
  assert.deepEqual(result.path, [["widget", "state"]]);
  assert.equal(result.changes, 1);
  assert.deepEqual(result.fields, [0,1,false,true]);
  assert.match(result.stale, /has changed/);
  assert.equal(result.restored, true);
}

const assert=require("node:assert/strict"),path=require("node:path"),{pathToFileURL}=require("node:url");
module.exports=async function(browser){
  const page=await browser.newPage({viewport:{width:1250,height:900},hasTouch:true});const errors=[],tableRequests=[];
  page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(10000);
  page.on("request",r=>{if(/\/(?:table-[a-z-]+|butter-tables)\.(?:js|css)$/.test(r.url()))tableRequests.push(r.url());});
  try{
    await require("../fixtures/notebook-labs.cjs").profile(page);
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.getByRole("button",{name:/^(Try the Demo|Load a demo)$/i}).click();
    await page.locator("#doc-name",{hasText:"Sensor board"}).waitFor();
    assert.deepEqual(await page.evaluate(()=>[AtriumPrefs.get("butter.tables")===true,!!globalThis.AtriumTableData,
      !!globalThis.AtriumTableVisual,!!globalThis.AtriumTableEditor]),[false,false,false,false]);
    await page.evaluate(async()=>{
      const h=AtriumNavHost;h.selectDocument(h.project().documents.find(d=>d.kind==="schematic").id);
      const editor=await AtriumLazy.need("AtriumSheetWidgetEditor"),i=AtriumSheetWidgets.make("table",[12,20]);
      h.edit(()=>{h.doc().items.push(i);},"Place table",[i]);h.select([i.id],i.id);editor.open(i.id,h);
    });
    assert.equal(await page.getByRole("button",{name:"Upgrade to full table"}).count(),0);
    assert.deepEqual(tableRequests,[]);
    await page.getByRole("dialog").last().getByRole("button",{name:"Done",exact:true}).click();
    await page.evaluate(async()=>{
      const h=AtriumNavHost, item=h.doc().items.find(entry=>entry.widget?.type==="table");
      await AtriumPrefs.set("butter.tables",true);
      AtriumSheetWidgetEditor.open(item.id,h);
    });
    await page.getByRole("button",{name:"Upgrade to full table"}).click();
    const dialog=page.getByRole("dialog",{name:"Edit table",exact:true}),grid=dialog.getByRole("grid");
    await grid.waitFor();
    await dialog.getByRole("button",{name:"Done",exact:true}).click();
    await checkGuardedConfigure(page);
    await page.evaluate(() => {
      const host = AtriumNavHost, item = host.doc().items.find(i => i.widget?.state?.tableVersion === 1);
      AtriumSheetWidgetEditor.open(item.id, host);
    });
    await grid.waitFor();
    const formula=dialog.getByRole("textbox",{name:"Cell contents or formula"});
    async function paste(data,format){await grid.evaluate((element,{data,format})=>{const dt=new DataTransfer();dt.setData(format,data);element.dispatchEvent(new ClipboardEvent("paste",{bubbles:true,clipboardData:dt}));},{data,format});}
    await paste('2\t3\t4\n8\t9\t10',"text/plain");
    await grid.getByRole("gridcell",{name:"3",exact:true}).click();await formula.fill("=A1*C1");await formula.press("Enter");
    assert.equal(await page.evaluate(()=>{const s=AtriumNavHost.doc().items.find(i=>i.widget?.state?.tableVersion===1).widget.state;return AtriumTableData.get(s,s.rows[0].id,s.columns[1].id).content.source;}),"=A1*C1");
    await grid.getByRole("gridcell",{name:"8",exact:true}).first().click();await grid.press("Shift+ArrowDown");await grid.press("Control+d");
    const applied=await page.evaluate(()=>{const s=AtriumNavHost.doc().items.find(i=>i.widget?.state?.tableVersion===1).widget.state;
      return AtriumTableData.get(s,s.rows[1].id,s.columns[1].id)?.content.source;});assert.equal(applied,"=A2*C2");
    await grid.getByRole("gridcell",{name:"2",exact:true}).click();await paste('<style>th.xl53{background-color:#eab402;vertical-align:middle;white-space:normal}</style><table><tr><th class="xl53" colspan="2">Firmware</th><td data-formula="=4+2">6</td></tr><tr><td>a</td><td>b</td><td>c</td></tr></table>',"text/html");
    const copied=await grid.evaluate(element=>{const dt=new DataTransfer();element.dispatchEvent(new ClipboardEvent("copy",{bubbles:true,clipboardData:dt}));return {types:[...dt.types],html:dt.getData("text/html")};});
    assert.deepEqual(copied.types.sort(),["text/html","text/plain"]);assert.match(copied.html,/vertical-align:middle/);assert.match(copied.html,/white-space:pre-wrap/);
    assert.deepEqual(await page.evaluate(()=>{
      const T=AtriumTableData,X=AtriumTableExchange;let id=0;
      const make=()=>T.create(2,2,()=>"html"+(++id));
      const source={...make(),headerRows:1,headerColumns:1}, target=make();
      const result=X.paste(target,{rowId:target.rows[0].id,columnId:target.columns[0].id},X.html(X.render(source).html),()=>"html"+(++id));
      return [result.headerRows,result.headerColumns];
    }),[1,1]);
    assert.deepEqual(await page.evaluate(()=>{const s=AtriumNavHost.doc().items.find(i=>i.widget?.state?.tableVersion===1).widget.state;
      return [s.merges[0].columns.length,AtriumTableData.get(s,s.rows[0].id,s.columns[0].id).style.fill,AtriumTableData.get(s,s.rows[0].id,s.columns[2].id).content];}),[2,"#eab402",{kind:"literal",text:"6"}]);
    await grid.getByRole("gridcell",{name:"b",exact:true}).click();
    await dialog.getByRole("combobox",{name:"Cell type",exact:true}).selectOption("Rich text");
    const richSource="**Gain** $a^2$ {sheet.Title}";
    await formula.fill(richSource);await formula.press("End");await formula.press("Alt+Enter");await formula.pressSequentially("Second line");await formula.press("Enter");
    const body=()=>page.evaluate(()=>{
      const s=AtriumNavHost.doc().items.find(i=>i.widget?.state?.tableVersion===1).widget.state;
      return AtriumTableData.get(s,s.rows[1].id,s.columns[1].id).content.richText;
    });
    const authored=await body();assert.equal(authored.blocks.length,2);
    assert(authored.blocks[0].runs.some(r=>r.bold));assert(authored.blocks[0].runs.some(r=>r.type==="field"&&r.expression==="sheet.Title"));
    await grid.getByRole("gridcell",{name:/Gain/}).click();await grid.press("F2");
    assert.equal(await formula.inputValue(),richSource+"\nSecond line");await formula.press("Enter");assert.deepEqual(await body(),authored);
    await grid.getByRole("gridcell",{name:/Gain/}).click();await dialog.locator("summary").click();
    await dialog.getByRole("combobox",{name:"Border edge",exact:true}).selectOption("left");
    await dialog.getByLabel("Custom border colour",{exact:true}).fill("#b46081");
    await dialog.getByRole("button",{name:"Apply border",exact:true}).click();
    await dialog.getByRole("combobox",{name:"Border edge",exact:true}).selectOption("top");
    await dialog.getByRole("combobox",{name:"Border colour",exact:true}).selectOption("accent");
    await dialog.getByRole("button",{name:"Apply border",exact:true}).click();
    const borders=()=>page.evaluate(()=>{const s=AtriumNavHost.doc().items.find(i=>i.widget?.state?.tableVersion===1).widget.state;
      return AtriumTableData.get(s,s.rows[1].id,s.columns[1].id).style.borders;});
    assert.deepEqual(await borders(),{left:"#b46081",top:"accent"});await dialog.getByRole("button",{name:"Clear border",exact:true}).click();
    assert.deepEqual(await borders(),{left:"#b46081"});
    const order=dialog.getByRole("combobox",{name:"Sort column",exact:true}),filter=dialog.getByRole("searchbox",{name:"Column filter",exact:true});
    await order.selectOption("1");await filter.fill("Gain");await filter.press("Tab");
    const column=()=>page.evaluate(()=>AtriumNavHost.doc().items.find(i=>i.widget?.state?.tableVersion===1).widget.state.columns[1]);
    assert.equal((await column()).sortDirection,"asc");assert.equal((await column()).filter,"Gain");
    await filter.fill("");await filter.press("Tab");await order.selectOption("");await dialog.locator("summary").click();
    const art=await page.evaluate(async()=>{
      const h=AtriumNavHost,d=h.doc(),item=d.items.find(i=>i.widget?.state?.tableVersion===1);
      const foreign=await AtriumLazy.need("AtriumNotebookForeign");
      const [image]=await foreign.prepare(h.project(),{documentIds:[d.id],preparedAssets:{get:()=>null},scale:10});
      return [image.type,image.itemId===item.id,image.width,image.height];
    });
    assert.equal(art[0],"image");assert.equal(art[1],true);assert(art[2]>0&&art[3]>0);
    const measure=await page.evaluate(async()=>{
      const h=AtriumNavHost,i=h.doc().items.find(i=>i.widget?.state?.tableVersion===1);let n=0;
      const s=AtriumTableData.create(1000,50,()=>"v"+(++n));
      h.edit(()=>{i.widget.state=s;i.w=400;i.h=400;},"Resize table for viewport check",[i]);
      const project=h.project(),doc=h.doc(),v=AtriumTableVisual.view(project,doc,i),canvas=document.createElement("canvas");
      const ctx=canvas.getContext("2d"),cost=[],args={x:i.x,y:i.y,w:i.w,h:i.h,viewport:[i.x,i.y,i.x+70,i.y+40]};
      const painted=AtriumTableVisual.draw(ctx,v,args);
      for(let n=0;n<100;n++){const before=performance.now();AtriumTableVisual.draw(ctx,v,args);cost.push(performance.now()-before);}
      const runtime=await AtriumLazy.need("AtriumSheetWidgetRuntime");
      const fill=ctx.fillText.bind(ctx);let prepared=0;
      ctx.fillText=(...values)=>{prepared++;fill(...values);};
      const options={project,doc,defs:h.defs(),scale:1,viewport:args.viewport};
      runtime.paint(ctx,i,options);
      for(let j=0;j<30&&!runtime.preparedView(project,doc,i,h.revision());j++)await new Promise(resolve=>setTimeout(resolve,10));
      prepared=0;runtime.paint(ctx,i,options);
      const diagnostic=runtime.preparedView(project,doc,i,h.revision())?.rows[0]?.cells[0]?.text;
      cost.sort((a,b)=>a-b);return {painted,prepared,diagnostic,p50:(cost[49]+cost[50])/2,p95:cost[94],max:cost.at(-1)};
    });
    await page.waitForFunction(()=>document.querySelector('dialog.table-editor [role=grid]')?.getAttribute("aria-rowcount")==="1000");
    const nodeCount=await grid.getByRole("gridcell").count();assert(nodeCount<220&&nodeCount>5);assert(measure.painted>0&&measure.painted<80);assert(measure.p95<16);
    assert.equal(measure.prepared,measure.painted,measure.diagnostic);
    await grid.evaluate(el=>{el.scrollTop=20000;el.scrollLeft=1400;});await page.waitForFunction(()=>+document.querySelector(".table-cell")?.getAttribute("aria-rowindex")>50);
    assert((await grid.getByRole("gridcell").count())<220);
    await grid.evaluate(el=>{el.scrollTop=0;el.scrollLeft=0;});
    assert.equal(await page.evaluate(()=>!!globalThis.AtriumTableQuery),false);
    await dialog.locator("summary").click();
    const requested=await page.evaluate(()=>{
      const h=AtriumNavHost,d=h.doc(),id="butter-query-probe";
      h.edit(()=>{d.items.push({kind:"part",id,ref:"RTEST53",value:"8 kΩ",pins:[],x:5,y:8});},"Place query subject",[]);
      return id;
    });
    await dialog.getByRole("textbox",{name:"Query",exact:true}).fill('part where designator like "RTEST*"');
    await dialog.getByRole("textbox",{name:"Query fields",exact:true}).fill("designator, value");
    await dialog.getByRole("button",{name:"Bind query",exact:true}).click();
    await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.widget?.state?.query)?.widget.state.rows.some(r=>r.object?.itemId==="butter-query-probe"));
    const cached=await page.evaluate(async()=>{
      const h=AtriumNavHost,doc=h.doc(),item=doc.items.find(i=>i.widget?.state?.query),state=item.widget.state;
      const stale={...item,widget:{...item.widget,state:{...state,query:{...state.query,documentId:"missing-source"}}}};
      const view=await AtriumSheetWidgetRuntime.prepare(h.project(),doc,stale,{purpose:"screen"});
      const ctx=document.createElement("canvas").getContext("2d"),text=[];
      ctx.fillText=(value,x,y)=>text.push([value,ctx.getTransform().f+y]);
      AtriumTableVisual.draw(ctx,view);
      return {rows:view.table?.value(state.rows[0].id,state.columns[0].id),fallback:view.fallback.text,text:text.slice(0,2)};
    });
    assert.equal(cached.rows,"RTEST53");assert.match(cached.fallback,/query document is unavailable/i);
    assert.match(cached.text[0][0],/query document is unavailable/i);
    assert.equal(cached.text[1][0],"RTEST53");assert(cached.text[1][1]>cached.text[0][1]);
    const history=()=>page.evaluate(id=>{
      const h=AtriumNavHost,{history,future}=h.undoSteps(),t=h.doc().items.find(i=>i.widget?.state?.query);
      return {undo:history.length,redo:future.length,stored:t.widget.state.rows.find(r=>r.object?.itemId===id)?.removed??false};
    },requested);
    const before=await history();
    await page.evaluate(id=>{const h=AtriumNavHost,d=h.doc(),i=d.items.find(i=>i.id===id);
      h.edit(()=>{i.ref="REMOVED";},"Rename query subject",[i]);},requested);
    const removed=grid.getByRole("gridcell",{name:"Removed · RTEST53",exact:true});
    await removed.waitFor();
    assert.deepEqual(await history(),{undo:before.undo+1,redo:0,stored:false});
    await page.evaluate(()=>AtriumNavHost.act("undo"));
    await grid.getByRole("gridcell",{name:"RTEST53",exact:true}).waitFor();
    assert.deepEqual(await history(),{undo:before.undo,redo:1,stored:false});
    await page.evaluate(()=>AtriumNavHost.act("redo"));
    await removed.waitFor();
    assert.deepEqual(await history(),{undo:before.undo+1,redo:0,stored:false});
    await dialog.getByRole("button",{name:"Clear removed rows"}).tap();
    await page.waitForFunction(()=>!AtriumNavHost.doc().items.find(i=>i.widget?.state?.query)?.widget.state.rows.some(r=>r.object?.itemId==="butter-query-probe"));
    await dialog.getByRole("button",{name:"Add row",exact:true}).tap();
    await grid.press("ArrowDown");
    await dialog.getByRole("button",{name:"Edit cell",exact:true}).tap();await formula.fill("Touch keyboard");await formula.press("Enter");
    await grid.getByRole("gridcell",{name:"Touch keyboard",exact:true}).waitFor();
    await dialog.getByRole("button",{name:"Done",exact:true}).click();
    await verifySavedBindings(page);
    await verifyGridUpdates(page);
    await clippedMergedImage(page);
    assert.deepEqual(errors,[]);console.log("Butter editor: copy/paste, formula entry, relative fill, merged HTML, cold load, 50,000 positions; "+nodeCount+" DOM cells, "+measure.painted+" canvas cells, 100 draws p50/p95/max "+[measure.p50,measure.p95,measure.max].map(n=>n.toFixed(2)).join("/")+" ms.");
  }finally{await page.close();}
};


async function verifySavedBindings(page){
  const fixture=await page.evaluate(()=>{
    const h=AtriumNavHost,d=h.doc(),T=AtriumTableData,item=AtriumSheetWidgets.make("table",[12,25]);
    let id=0,s=T.create(2,2,()=>"saved"+(++id));
    const row=s.rows[0].id,[col,other]=s.columns.map(c=>c.id);
    s={...s,columns:s.columns.map(c=>({...c,unit:"Ω"}))};
    s=T.change(s,row,col,{content:{kind:"literal",text:"17"}});
    const bindings=[col,other].map((c,i)=>({target:T.target(d.id,item.id,row,c),source:i?"6":"8+9",unit:"Ω",storageUnit:"Ω",bindings:[]}));
    h.edit(()=>{item.widget={...item.widget,state:s};d.items.push(item);h.project().numericExpressions=bindings;},"Open table with saved bindings",[item]);
    h.select([item.id],item.id);AtriumTableEditor.open(h,d.id,item.id);
    return {id:item.id,row,col,other,before:h.undoSteps().history.length};
  });
  const dialog=page.getByRole("dialog",{name:"Edit table",exact:true});
  await dialog.getByRole("gridcell",{name:"17",exact:true}).click();
  const input=dialog.getByRole("textbox",{name:"Cell contents or formula"});
  await input.fill("=4+5");await input.press("Enter");
  const snapshot=()=>page.evaluate(({id,row,col})=>{
    const h=AtriumNavHost,s=h.doc().items.find(i=>i.id===id).widget.state,cell=AtriumTableData.get(s,row,col).content;
    return [cell.source||cell.text,h.project().numericExpressions.map(e=>e.target.path[2]),h.undoSteps().history.length];
  },fixture);
  assert.deepEqual(await snapshot(),["=4+5",[fixture.other],fixture.before+1]);
  await page.evaluate(()=>AtriumNavHost.act("undo"));
  assert.deepEqual(await snapshot(),["17",[fixture.col,fixture.other],fixture.before]);
  await page.evaluate(()=>AtriumNavHost.act("redo"));
  assert.deepEqual(await snapshot(),["=4+5",[fixture.other],fixture.before+1]);
}

async function verifyGridUpdates(page){
  const itemId=await page.evaluate(()=>{
    const h=AtriumNavHost,d=h.doc(),T=AtriumTableData,item=AtriumSheetWidgets.make("table",[20,40]);
    const base=T.create(800,40),columnId=base.columns[0].id;
    const cells=["Keep first","Skip this","Keep last"].map((text,i)=>({rowId:base.rows[i].id,columnId,content:{kind:"literal",text}}));
    item.widget={...item.widget,state:T.batch(base,cells)};
    h.edit(()=>d.items.push(item),"Place table to check grid updates",[item]);
    AtriumTableEditor.open(h,d.id,item.id);
    return item.id;
  });
  const dialog=page.getByRole("dialog",{name:"Edit table",exact:true}),grid=dialog.getByRole("grid");
  const input=dialog.getByRole("textbox",{name:"Cell contents or formula"});
  const apply=dialog.getByRole("button",{name:"Apply",exact:true});
  const watch=()=>grid.evaluate((viewport,id)=>{
    let builds=0;
    const observer=new MutationObserver(records=>{builds+=records.length;});
    observer.observe(viewport.querySelector(".table-grid"),{childList:true});
    globalThis.tableGridProbe={reset(){observer.takeRecords();builds=0;},read(){
      builds+=observer.takeRecords().length;
      const h=AtriumNavHost,s=h.doc().items.find(i=>i.id===id).widget.state,active=viewport.querySelector(".table-cell.current");
      return {builds,undo:h.undoSteps().history.length,rows:Number(viewport.getAttribute("aria-rowcount")),
        left:viewport.scrollLeft,top:viewport.scrollTop,row:active?.getAttribute("aria-rowindex"),col:active?.getAttribute("aria-colindex"),
        value:AtriumTableData.get(s,s.rows[0].id,s.columns[0].id)?.content.text};
    }};
  },itemId);
  const reset=()=>page.evaluate(()=>tableGridProbe.reset());
  const read=()=>page.evaluate(async()=>{
    // Include any scroll event queued by keyboard movement in the count.
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return tableGridProbe.read();
  });
  const check=async expected=>{
    const actual=await read();
    for(const [key,value] of Object.entries(expected))assert.equal(actual[key],value,key);
    return actual;
  };
  await grid.getByRole("gridcell",{name:"Keep first",exact:true}).click();
  await watch();const {undo}=await read();
  await input.fill("Keep applied");await reset();await apply.click();
  await check({builds:1,undo:undo+1,row:"1",value:"Keep applied"});
  await reset();await apply.click();
  await check({builds:0,undo:undo+1,row:"1",value:"Keep applied"});

  await input.fill("Keep entered");await reset();await input.press("Enter");
  await check({builds:1,undo:undo+2,row:"2",value:"Keep entered"});
  await input.focus();await reset();await input.press("Enter");
  await check({builds:1,undo:undo+2,row:"3",value:"Keep entered"});
  await reset();await page.evaluate(()=>AtriumNavHost.act("undo"));
  await check({builds:1,undo:undo+1,row:"3",value:"Keep applied"});
  await reset();await page.evaluate(()=>AtriumNavHost.act("redo"));
  await check({builds:1,undo:undo+2,row:"3",value:"Keep entered"});

  await dialog.locator("summary").click();
  const filter=dialog.getByRole("searchbox",{name:"Column filter",exact:true});
  await filter.fill("Keep");await reset();await filter.press("Tab");
  await check({builds:1,rows:2,row:"2"});
  await reset();await grid.press("End");
  assert((await check({builds:1,rows:2,row:"2",col:"40",top:0})).left>0);
  await reset();await grid.press("Home");
  await check({builds:1,col:"1",left:0});
  await filter.fill("");await reset();await filter.press("Tab");
  await check({builds:1,rows:800,row:"3"});
  await reset();await grid.evaluate(viewport=>{viewport.scrollTop=1800;});
  const scrolled=await check({builds:1,top:1800,row:undefined});
  await reset();await grid.press("ArrowDown");
  const revealed=await check({builds:1,row:"4",col:"1"});
  assert(revealed.top<scrolled.top);
  await filter.fill("Keep");await reset();await filter.press("Tab");
  await check({builds:1,rows:2,row:"1",top:0});

  await page.evaluate(id=>{
    const h=AtriumNavHost;
    // A delayed host can complete the edit without a local change notification.
    const delayed={...h,on(type,listener){return type==="change"?()=>{}:h.on(type,listener);},
      async edit(...args){await new Promise(resolve=>{globalThis.finishTableEdit=resolve;});return h.edit(...args);}};
    AtriumTableEditor.open(delayed,h.currentId(),id);
  },itemId);
  await grid.getByRole("gridcell",{name:"Keep entered",exact:true}).click();
  await watch();await input.fill("Keep delayed");await reset();await apply.click();
  await page.waitForFunction(()=>typeof globalThis.finishTableEdit==="function");
  await page.evaluate(()=>{const finish=globalThis.finishTableEdit;delete globalThis.finishTableEdit;finish();});
  await grid.getByRole("gridcell",{name:"Keep delayed",exact:true}).waitFor();
  await check({builds:1,row:"1",rows:2,value:"Keep delayed"});
  await page.evaluate(()=>AtriumNavHost.selectDocument(AtriumNavHost.project().documents.find(d=>d.kind==="pcb").id));
  await dialog.waitFor({state:"hidden"});
}

if(require.main===module){
  const {chromium}=require("playwright-core"),executablePath=process.env.CHROME;
  (async()=>{const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{channel:"chrome"}),args:["--allow-file-access-from-files"]});
    try{await module.exports(browser);}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
}
