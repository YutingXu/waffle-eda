"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),{pathToFileURL}=require("node:url");
const {openProjectZIP}=require("../support/browser-native-project.cjs");
async function insert(page,name) {
  await page.locator("#canvas").focus();await page.keyboard.press("/");
  const dialog=page.locator("dialog[open]").last();
  await dialog.locator("input").first().fill(name);await dialog.getByRole("option",{name:new RegExp(name,"i")}).first().click();
  await dialog.waitFor({state:"hidden"});
}
async function gesture(page,{type="pen",y=85,id=53,tail=false,cancel=false}={}) {
  await page.evaluate(({type,y,id,tail,cancel})=>{
    const h=AtriumNavHost,c=h.canvas(),r=c.getBoundingClientRect();
    [[0,"down",.2],[18,"move",.72],[42,"move",.93],[56,cancel?"cancel":"up",0]].forEach(([dx,phase,pressure])=>{
      c.dispatchEvent(new PointerEvent("pointer"+phase,{bubbles:true,cancelable:true,pointerId:id,pointerType:type,isPrimary:true,
        clientX:r.left+95+dx,clientY:r.top+y+dx/5,button:phase==="move"?-1:tail?5:0,buttons:["up","cancel"].includes(phase)?0:tail?32:1,pressure}));
    });
  },{type,y,id,tail,cancel});
}
async function checkPanelTheme(page,panel) {
  await panel.getByLabel("Note colour",{exact:true}).focus();
  await page.keyboard.press("Tab");
  const result=await panel.evaluate(el=>{
    const reference=document.createElement("span");
    reference.style.boxShadow="var(--elev-2)";
    el.append(reference);
    const elevation=getComputedStyle(reference).boxShadow;
    reference.remove();
    const field=document.activeElement,control=getComputedStyle(field),panel=getComputedStyle(el);
    const {contrast}=AtriumTheme.color;
    return {shadow:panel.boxShadow,elevation,panelText:contrast(panel.color,panel.backgroundColor),
      fieldText:contrast(control.color,control.backgroundColor),focus:contrast(control.outlineColor,control.backgroundColor),
      ring:el.contains(field)&&field.matches(":focus-visible")&&control.outlineStyle==="solid"&&parseFloat(control.outlineWidth)>=2};
  });
  assert.notEqual(result.elevation,"none","floating-panel elevation resolves in this theme");
  assert.equal(result.shadow,result.elevation,"Notes uses the shared floating-panel elevation");
  assert.ok(result.panelText>=4.5 && result.fieldText>=4.5,"readable Notes controls: "+JSON.stringify(result));
  assert.ok(result.ring && result.focus>=3,"visible keyboard focus: "+JSON.stringify(result));
}
async function test(browser) {
  for(const theme of ["light","dark"]) {
    const step=s=>{if(process.env.NOTES_DEBUG)console.log(theme,s);};
    const page=await browser.newPage({viewport:{width:1460,height:900},hasTouch:true}),errors=[];
    page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(9000);
    // Sticky notes and the / palette belong to the Notebook Experimental feature (labs.notebook); opt in.
    await require("../fixtures/notebook-labs.cjs").profile(page);
    try{
      await page.goto(pathToFileURL(path.resolve(__dirname,"../../app/index.html")).href);
      await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();await page.locator("#doc-name",{hasText:"Sensor board"}).waitFor();
      await page.evaluate(t=>{
        AtriumTheme.set({preset:t},{persist:false});
        const h=AtriumNavHost;h.selectDocument(h.project().documents.find(d=>d.kind==="schematic").id);
      },theme);
      step("sticky");await insert(page,"Sticky note");
      const panel=page.locator("#review-notes-panel");
      const area=page.getByRole("textbox",{name:"Engineering note"});
      await area.fill("Inspect sensor");await page.getByRole("button",{name:"Finish editing"}).click();
      await panel.getByLabel("Note colour",{exact:true}).selectOption("green");
      const sid=await page.evaluate(()=>AtriumNavHost.selection()[0]);
      const hit=()=>page.evaluate(id=>{const h=AtriumNavHost,i=h.doc().items.find(v=>v.id===id);return AtriumMarkup.hit(i,h.doc(),[i.x+i.w*.7,i.y+i.h*.7],.01);},sid);
      assert.equal(await hit(),0);
      await panel.getByRole("button",{name:"Minimize note",exact:true}).click();assert(await hit()>1);
      await panel.getByRole("button",{name:"Restore note",exact:true}).click();assert.equal(await hit(),0);
      await panel.getByLabel("Show on this sheet").uncheck();assert.equal(await hit(),Infinity);
      await panel.getByLabel("Show on this sheet").check();
      await panel.locator("summary",{hasText:"Filter note types"}).click();
      await panel.getByRole("checkbox",{name:"Sticky note",exact:true}).uncheck();assert.equal(await hit(),Infinity);
      await panel.getByRole("checkbox",{name:"Sticky note",exact:true}).check();
      await panel.getByLabel("Print with this sheet").uncheck();
      step("print");const printed=await page.evaluate(async()=>{
        const h=AtriumNavHost,d=h.doc(),p=h.project();await AtriumLazy.need("AtriumPrint");
        return [undefined,true,false].map(includeNotes=>AtriumPrint.build(p,{documents:[d.id],includeNotes}).pages.flatMap(pg=>pg.list).some(o=>o.u?.includes("Inspect")));
      });assert.deepEqual(printed,[false,true,false]);
      await panel.getByLabel("Print with this sheet").check();
      const target=await page.evaluate(()=>{const h=AtriumNavHost,i=h.doc().items.find(v=>v.kind==="part");h.select([i.id]);return i.id;});
      step("callout");await insert(page,"Callout");
      await page.getByRole("button",{name:"Finish editing"}).click();
      const call=await page.evaluate(()=>{const h=AtriumNavHost,i=h.doc().items.find(v=>v.callout);return {id:i.id,target:i.callout.anchor.itemId,at:i.callout.anchor.at};});
      assert.equal(call.target,target);
      const anchor=()=>page.evaluate(id=>{const h=AtriumNavHost,i=h.doc().items.find(v=>v.id===id);return AtriumMarkup.read(h.project(),h.doc(),i).anchor;},call.id);
      const before=await anchor();
      await page.evaluate(id=>{const h=AtriumNavHost,i=h.doc().items.find(v=>v.id===id);h.edit(()=>{i.x+=12;},"Move component",[i]);h.select([id]);h.act("delete");},target);
      assert.equal((await anchor()).live,false);assert.deepEqual((await anchor()).at,call.at);
      await page.evaluate(()=>AtriumNavHost.act("undo"));assert.equal((await anchor()).live,true);assert(Math.abs((await anchor()).at[0]-before.at[0]-12)<.01);
      await page.evaluate(()=>AtriumNavHost.act("undo"));assert.deepEqual((await anchor()).at,before.at);
      step("checklist");await insert(page,"Review checklist");const cid=await page.evaluate(()=>AtriumNavHost.selection()[0]);
      const check=panel.getByRole("checkbox",{name:"Review item",exact:true});
      await check.check();await panel.getByRole("button",{name:"Open in Comments",exact:true}).click();
      const reopen=page.getByRole("button",{name:"Reopen",exact:true});await reopen.click();await check.waitFor();assert.equal(await check.isChecked(),false);
      await panel.getByRole("button",{name:"Edit checklist",exact:true}).click();
      const widget=page.locator("dialog.sw-editor");
      await widget.getByRole("button",{name:"Add item",exact:true}).click();const field=widget.locator("fieldset").filter({has:page.getByRole("checkbox",{name:"New item"})}).last();
      await field.getByRole("button",{name:"Create Review thread"}).click();
      await page.waitForFunction(id=>AtriumNavHost.doc().items.find(i=>i.id===id).widget.state.rows.every(r=>r.threadId),cid);
      await widget.getByRole("button",{name:"Done",exact:true}).click();
      step("sketch");await insert(page,"Sketch");
      const count=()=>page.evaluate(()=>AtriumNavHost.doc().items.filter(i=>i.ink).length);
      await gesture(page,{cancel:true});assert.equal(await count(),0);
      await gesture(page,{});assert.equal(await count(),1);
      const pressure=await page.evaluate(()=>{const i=AtriumNavHost.doc().items.find(v=>v.ink);return AtriumMarkup.points(i).map(p=>p[2]);});assert(Math.max(...pressure)>Math.min(...pressure));
      await panel.getByLabel("Drawing tool").selectOption("highlighter");await panel.getByLabel("Ink colour").selectOption("violet");
      await gesture(page,{y:145,type:"touch",id:61});assert.equal(await count(),2);
      assert(await page.evaluate(()=>AtriumNavHost.doc().items.some(i=>i.ink?.brush==="highlighter"&&i.ink.colour==="violet")));
      await gesture(page,{tail:true});assert.equal(await count(),1);await page.evaluate(()=>AtriumNavHost.act("undo"));assert.equal(await count(),2);
      await page.evaluate(()=>AtriumNavHost.act("redo"));assert.equal(await count(),1);
      await panel.getByLabel("Drawing tool").selectOption("eraser");await gesture(page,{y:145,type:"mouse",id:5});assert.equal(await count(),0);
      await page.evaluate(()=>AtriumNavHost.act("undo"));assert.equal(await count(),1);
      await page.locator("#canvas").focus();await page.keyboard.press("Escape");
      step("save");const download=page.waitForEvent("download");await page.evaluate(()=>AtriumNavHost.saveProject({as:true}));
      // The browser saves a Format 2 project ZIP; reopen those bytes through File › Open.
      const saved=await download,copy={name:saved.suggestedFilename(),mimeType:"application/zip",buffer:fs.readFileSync(await saved.path())};
      assert.match(copy.name,/\.zip$/);
      step("reopen");const docId=await page.evaluate(()=>AtriumNavHost.doc().id);
      await page.evaluate(()=>{const h=AtriumNavHost;globalThis.__reviewProject=h.project();});
      await openProjectZIP(page,copy);
      const here=page.getByRole("button",{name:"Open here",exact:true});
      if(await here.isVisible().catch(()=>false))await here.click();
      await page.waitForFunction(()=>AtriumNavHost.project()!==globalThis.__reviewProject);
      await page.evaluate(id=>AtriumNavHost.selectDocument(id),docId);
      assert.equal(await page.evaluate(()=>AtriumNavHost.doc().items.filter(i=>AtriumMarkup.kind(i)).length),4);
      step("descriptors");const after=await page.evaluate(()=>{const h=AtriumNavHost;return AtriumNotebook.read(h.project(),{docId:h.doc().id}).rows.map(r=>r.type);});
      for(const k of ["sticky","callout","inkStroke","widget"])assert(after.includes(k),k+" notebook descriptor");
      await page.evaluate(id=>{
        const h=AtriumNavHost,d=h.doc(),p=h.project(),sticky=d.items.find(i=>i.id===id),callout=d.items.find(i=>i.callout),list=d.items.find(i=>i.widget?.type==="todo"),ink=d.items.find(i=>i.ink);
        h.edit(()=>{
          Object.assign(sticky,{x:65,y:26,w:45,h:15});sticky.text="Inspect sensor return";sticky.richText=AtriumMarkup.body(sticky.text,p,d);
          Object.assign(callout,{x:111,y:27,w:40,h:15});callout.text="Check connector polarity";callout.richText=AtriumMarkup.body(callout.text,p,d);
          Object.assign(list,{x:81,y:88,w:58,h:18});list.widget.state.rows[0].text="Trace sensor return";list.widget.state.rows[1].text="Check rail voltage";
          ink.x=69;ink.y=45;
        },"Arrange review example");
        h.view().restoreCamera({...h.view().camera(),cx:122,cy:65,scale:5.25,referenceScale:5.25});
        h.select([id]);AtriumReviewNotes.open();h.redraw(true);
      },sid);
      await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
      if(process.env.NOTES_SCREENSHOTS){fs.mkdirSync(process.env.NOTES_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.NOTES_SCREENSHOTS,"editor-"+theme+".png")});}
      await checkPanelTheme(page,panel);
      assert.deepEqual(errors,[]);console.log("PASS "+theme+" editor, palette, anchors, local layer, print, Review, full-stroke erasure, Undo, Redo and reopen");
    }finally{await page.close();}
  }
}
module.exports=test;
if(require.main===module)(async()=>{const b=await require("../support/playwright.cjs").chromium.launch({channel:"chrome",args:["--allow-file-access-from-files"]});try{await test(b);}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
