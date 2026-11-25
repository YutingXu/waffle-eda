"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const {pathToFileURL} = require("node:url");
const {projectZIP,openProjectZIP} = require("../support/browser-native-project.cjs");

async function coldFrameExports(browser) {
  for (const [action,dialogTitle,ext,includesBoard] of [
    ["export","Export Design","kicad_sch",false],
    ["export-altium","Export Altium Project (ASCII)","SchDoc",true]
  ]) {
    const page = await browser.newPage({viewport:{width:1400,height:900},acceptDownloads:true}), errors = [];
    page.on("pageerror",error=>errors.push(error.message));
    try {
      await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
      await page.getByRole("button",{name:"Continue to editor",exact:true}).click();
      const before = await page.evaluate(async ()=>{
        const h=AtriumNavHost, p=Atrium.project("Wide drawing",[]), [sheet, board]=p.documents;
        sheet.sheet={infinite:true};
        for (const [n,x] of [10,4200].entries()) {
          sheet.items.push(AtriumSchObjects.make("frame",[x-5,5],{text:"Channel "+n,w:30,h:20}),
            {id:"wire"+n,kind:"wire",points:[[x,10],[x+10,10]]},
            {id:"label"+n,kind:"netlabel",text:"Signal"+n,x,y:10});
        }
        board.items.push({id:"track",kind:"track",layer:"Top",width:.2,points:[[0,0],[2,0]]});
        await h.replaceProject(p,{force:true,dirty:false}); h.selectDocument(sheet.id);
        if (globalThis.AtriumSchematicOutput) throw Error("Expected the page export service to start cold.");
        return JSON.stringify(h.project());
      });
      const file = page.locator('.menubar [data-menu="file"]');
      await file.locator(":scope > summary").click();
      await file.locator(".submenu-trigger").filter({hasText:/^Export$/}).click();
      await file.locator('[data-action="'+action+'"]').click();
      const dialog = page.getByRole("dialog",{name:dialogTitle,exact:true});
      await dialog.getByRole("button",{name:"One sheet per frame",exact:true}).click({timeout:8000});
      const download = page.waitForEvent("download");
      await dialog.getByRole("button",{name:/^Export…?$/}).click({timeout:15000});
      const artifact = await download;
      assert.match(artifact.suggestedFilename(),/\.zip$/i);
      const zip = await fs.readFile(await artifact.path());
      assert.ok(zip.includes(Buffer.from("Channel 0."+ext)) && zip.includes(Buffer.from("Channel 1."+ext)));
      assert.equal(zip.includes(Buffer.from(ext==="SchDoc"?".PcbDoc":".kicad_pcb")),includesBoard);
      assert.equal(await page.evaluate(()=>JSON.stringify(AtriumNavHost.project())),before);
      assert.deepEqual(errors,[]);
    } finally { await page.close(); }
  }
  console.log("PASS cold menu exports offer the reported frame split and preserve the selected export scope");
}

module.exports = async function infiniteFrames(browser) {
  for (const theme of ["light","dark"]) {
    const page=await browser.newPage({viewport:{width:1400,height:900}}), errors=[];
    page.on("pageerror",e=>errors.push(e.message));
    try {
      await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
      await page.waitForFunction(()=>globalThis.AtriumStartPage?.isOpen());
      await page.evaluate(theme=>{
        AtriumTheme.set({preset:theme,followSystem:false,motion:"off"},{persist:false});
        AtriumStartPage.close();AtriumStartPage.open({focus:"templates"});
      },theme);
      for(const id of ["a4","a3","letter","infinite"])assert.ok(await page.locator('[data-template="sheet-'+id+'"]').isVisible());
      await page.locator('[data-template="sheet-infinite"]').click();
      await page.waitForFunction(()=>!AtriumStartPage.isOpen() && AtriumNavHost.doc().sheet?.infinite);
      const before=await page.evaluate(async()=>{
        const h=AtriumNavHost,d=h.doc();
        await AtriumLazy.need(["AtriumUndoStore","AtriumCamera"]);
        const inside={id:"test-pin",kind:"junction",x:0,y:0},outside={id:"outside",kind:"junction",x:65,y:30};
        h.edit(()=>d.items.push(inside,outside),"Seed",[inside,outside]);
        h.view().restoreCamera({...h.view().camera(),cx:0,cy:0,scale:6});h.redraw();
        return [d.id,h.project().documents.find(x=>x.kind==="pcb").id];
      });
      const xy=point=>page.evaluate(p=>{const h=AtriumNavHost,b=h.canvas().getBoundingClientRect(),q=h.view().worldToScreen(p);return [b.left+q[0],b.top+q[1]];},point);
      await page.locator('[data-menu="place"] > summary').click();
      await page.locator('[data-menu="place"] [data-action="sch-frame"]').click();
      await page.waitForFunction(()=>AtriumNavHost.tool()==="sch-place");
      await page.mouse.click(...await xy([-25.4,-20.32]));await page.mouse.click(...await xy([25.4,20.32]));
      const form=page.getByRole("dialog",{name:"Place frame"});
      await form.getByRole("textbox",{name:"Name"}).fill("Channel A");
      await form.getByRole("button",{name:"OK"}).click();
      const state=()=>page.evaluate(()=>{
        const h=AtriumNavHost,d=h.doc(),f=d.items.find(AtriumSchObjects.isFrame),pin=d.items.find(i=>i.id==="test-pin");
        return f&&{id:f.id,x:f.x,y:f.y,w:f.w,h:f.h,text:f.text,pin:[pin.x,pin.y]};
      });
      await page.waitForFunction(()=>AtriumNavHost.doc().items.some(AtriumSchObjects.isFrame));
      const inserted=await state();
      assert.ok(inserted.x<0 && inserted.y<0 && inserted.text==="Channel A");
      const name=page.locator('#inspector [aria-label="Name"]');await name.fill("Channel B");await name.press("Tab");
      assert.equal((await state()).text,"Channel B");
      const modifier=await page.evaluate(()=>AtriumKeymap.mac?"Meta":"Control");
      const drag=async(alone)=>{
        const f=await state(), point=[f.x,f.y+f.h*.4], [x,y]=await xy(point), [tx,ty]=await xy([point[0]+10.16,point[1]+5.08]);
        if(alone)await page.keyboard.down(modifier);
        await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(tx,ty,{steps:5});await page.mouse.up();
        if(alone)await page.keyboard.up(modifier);
        return state();
      };
      const grouped=await drag(false);
      assert.ok(grouped.x>inserted.x && grouped.y>inserted.y);
      assert.ok(Math.abs(grouped.pin[0]-(grouped.x-inserted.x))<1e-5 && Math.abs(grouped.pin[1]-(grouped.y-inserted.y))<1e-5);
      const alone=await drag(true);assert.ok(alone.x>grouped.x,JSON.stringify({modifier,grouped,alone}));assert.deepEqual(alone.pin,grouped.pin);
      await page.evaluate(()=>AtriumNavHost.act("undo"));assert.deepEqual(await state(),grouped);
      await page.evaluate(()=>AtriumNavHost.act("redo"));assert.deepEqual(await state(),alone);
      await page.evaluate(()=>AtriumNavHost.select([]));
      const settings=page.locator('#inspector summary').filter({hasText:"Document settings"});await settings.click();
      const paper=page.locator('#inspector [aria-label="Sheet size"]'),title=page.locator('#inspector [aria-label="Title block"]');
      assert.equal(await paper.inputValue(),"none");await title.selectOption("standard");
      await paper.selectOption("A4");assert.equal(await page.evaluate(()=>AtriumSchAppearance.sheetOf(AtriumNavHost.doc()).size),"A4");
      await paper.selectOption("none");assert.equal(await page.evaluate(()=>AtriumNavHost.doc().sheet.size),"A4");
      await page.evaluate(id=>AtriumNavHost.selectDocument(id),before[1]);
      await page.evaluate(()=>AtriumNavHost.act("navigator-panel"));
      await page.getByRole("searchbox",{name:"Search the Navigator"}).fill("Channel B");
      await page.locator('.navp-row[data-type="frame"]:visible').filter({hasText:"Channel B"}).click();
      await page.waitForFunction(id=>AtriumNavHost.doc().id===id,before[0]);
      assert.equal(await page.evaluate(()=>AtriumNavHost.selection()[0]),inserted.id);
      assert.deepEqual(errors,[]);
    } finally {await page.close();}
  }
  const boardPage=await browser.newPage({viewport:{width:1200,height:800}});
  try {
    await boardPage.addInitScript(()=>{
      window.denseBoardPaints=[];
      Object.defineProperty(window,"AtriumCanvas",{configurable:true,set(C){
        Object.defineProperty(window,"AtriumCanvas",{configurable:true,writable:true,value:C});
        const create=C.create;
        C.create=(canvas,...args)=>{
          const view=create(canvas,...args),render=view.render;
          view.render=(doc,...paint)=>{
            const result=render(doc,...paint);
            if(doc.name==="Dense board")window.denseBoardPaints.push({loaded:!!window.AtriumCanvasBoardBatches,batches:view.internals().lodUsed});
            return result;
          };
          return view;
        };
      }});
    });
    await boardPage.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await boardPage.waitForFunction(()=>globalThis.AtriumStartPage?.isOpen());
    assert.equal(await boardPage.evaluate(()=>!!globalThis.AtriumCanvasBoardBatches),false);
    const project=await boardPage.evaluate(()=>{
      const p=Atrium.project("Dense board",[]),b=p.documents.find(d=>d.kind==="pcb");b.name="Dense board";p.documents=[b];
      for(let y=0;y<40;y++)for(let x=0;x<50;x++)b.items.push({kind:"track",id:"t"+x+"-"+y,points:[[x,y],[x+.5,y]],width:.1,layer:"Top",net:""});
      return p;
    });
    await openProjectZIP(boardPage,await projectZIP(project,{entryDocument:project.documents[0].id}));
    await boardPage.waitForFunction(()=>AtriumNavHost.project().name==="Dense board" && AtriumNavHost.folderProject()?.temporary);
    await boardPage.evaluate(()=>AtriumStartPage.close());
    await boardPage.waitForFunction(()=>denseBoardPaints.length,null,{timeout:4500}).catch(async e=>{
      const details=await boardPage.evaluate(()=>({project:AtriumNavHost.project().name,active:AtriumNavHost.doc().name,dialogs:[...document.querySelectorAll("dialog[open]")].map(d=>d.innerText.slice(0,200)),status:document.querySelector("#status")?.innerText,loaded:!!window.AtriumCanvasBoardBatches}));
      throw Error(e.message+" "+JSON.stringify(details));
    });
    assert.deepEqual(await boardPage.evaluate(()=>denseBoardPaints[0]),{loaded:true,batches:true},"first visible paint already batches the opened dense board");
  } finally {await boardPage.close();}
  console.log("PASS real light/dark template, frame placement, Properties, grouped and modifier drag, Undo/Redo, paper and Navigator from board");
  await coldFrameExports(browser);
};
