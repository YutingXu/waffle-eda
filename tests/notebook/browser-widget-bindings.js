"use strict";
const assert=require("node:assert/strict"),path=require("node:path");
const {createStaticServer}=require("../support/browser-app-server.cjs");
async function run(browser,{appURL}={}) {
  const root=path.resolve(__dirname,"../../app"),server=createStaticServer({root,requireFile:true,mime:{".js":"text/javascript",".html":"text/html",".css":"text/css",".svg":"image/svg+xml"}});
  if(!appURL) {await new Promise(r=>server.listen(0,"127.0.0.1",r));appURL="http://127.0.0.1:"+server.address().port+"/index.html";}
  const page=await browser.newPage({viewport:{width:1280,height:850}}),errors=[];
  try {
    // Notebook widgets are an Experimental feature (labs.notebook); this fixture opts in.
    await require("../fixtures/notebook-labs.cjs").profile(page);
    page.on("pageerror",e=>errors.push(e.message));await page.goto(appURL);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();await page.locator("#doc-name",{hasText:"Sensor board"}).waitFor();
    const out=await page.evaluate(async()=>{
      await AtriumLazy.need(["AtriumSheetWidgetRuntime","AtriumCalculations","AtriumNoteFields"]);
      const h=AtriumNavHost,p=h.project(),d=p.documents.find(d=>d.kind==="schematic"),W=AtriumSheetWidgets,R=AtriumSheetWidgetRuntime;
      h.selectDocument(d.id);
      const signal={id:Atrium.id(),name:"WIDGET_RAIL",kind:"single",legs:[{nets:["WIDGET_RAIL"]}],intent:{voltage:3.3,confirmed:"2026-01-01"}};
      h.edit(()=>{p.signals ||= {version:1,signals:[],tags:[],nets:{}};p.signals.signals.push(signal);},"Add confirmed test rail");
      const block=AtriumCalculationRecords.backing({kind:"calculation",id:Atrium.id(),x:0,y:110,source:"10 mA",bindings:[],assertions:[]});
      const table=W.make("table",[40,105]),s=table.widget.state,c0=W.keyFor(s.columns[0].id),c1=W.keyFor(s.columns[1].id);
      const f=AtriumNoteFields.resolve(p,d,"R1.Value"),sheet=AtriumNoteFields.resolve(p,d,"sheet.Title");
      s.rows[0][c0]={kind:"field",expression:"R1.Value",binding:f.binding};
      s.rows[0][c1]={kind:"calculation",documentId:d.id,blockId:block.id};
      s.rows.push({id:Atrium.id(),[c0]:{kind:"field",expression:"sheet.Title",binding:sheet.binding}});
      const voltage=AtriumNoteFields.resolve(p,d,"net WIDGET_RAIL.voltage");
      s.rows[1][c1]={kind:"field",expression:"net WIDGET_RAIL.voltage",binding:voltage.binding};
      const budget=W.make("power-budget",[80,105]);budget.widget.state.sources=[{id:Atrium.id(),rail:"VDD",use:"load",input:s.rows[0][c1]},
        {id:Atrium.id(),rail:"VDD",use:"rating",input:{kind:"literal",text:"15 mA"}}];
      h.edit(()=>d.items.push(block,table,budget),"Add notebook test",[block,table,budget]);
      const make=async()=>{const ctx={host:h,revision:h.revision(),defs:h.defs()};const [t,b]=await Promise.all([R.prepare(p,d,table,ctx),R.prepare(p,d,budget,ctx)]);
        const cached=AtriumCalculations.peek(p,{documentId:d.id,blockId:block.id,revision:ctx.revision});return {t:t.rows,b:b.rows,quantity:cached?.result};};
      const before=await make();h.edit(()=>{block.text="20 mA";},"Revise load",[block]);const after=await make();
      const pin=d.items.find(i=>i.kind==="part" && i.ref==="R1");h.edit(()=>{pin.value="47k";},"Change resistance",[pin]);const field=await make();
      const valid=W.valid(table);h.edit(()=>{block.text="20 V";},"Change dimension",[block]);const dimension=await make();
      h.edit(()=>{signal.name="RENAMED_RAIL";signal.intent.voltage=5;},"Rename confirmed test rail");const renamed=await make();
      return {before,after,field,dimension,valid,renamed,worker:AtriumCalculations.stats()};
    });
    assert(out.valid);assert.equal(out.before.quantity.value,.01);assert.equal(out.after.quantity.value,.02);
    assert.equal(out.before.b[1].cells[1].text,"10 mA");assert.equal(out.after.b[1].cells[3].text,"Over rating");
    assert.equal(out.field.t[1].cells[0].text,"47k");assert(out.field.t[2].cells[0].token!=="broken");
    assert.equal(out.before.t[2].cells[1].text,"3.3");assert.equal(out.renamed.t[2].cells[1].text,"5");
    assert(out.worker.started>0 && out.worker.jobs>0 && out.worker.local===0);
    assert.equal(out.dimension.b[1].cells[3].text,"1 unavailable");assert.deepEqual(errors,[]);
  } finally {await page.close();if(server.listening)await new Promise(r=>server.close(r));}
  console.log("browser-widget-bindings: real calculation worker, stable part and sheet fields, current units and regulator warning passed");
}
module.exports=run;
if(require.main===module)(async()=>{const b=await require("../support/playwright.cjs").chromium.launch({channel:"chrome"});try{await run(b,{appURL:process.argv[2]});}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
