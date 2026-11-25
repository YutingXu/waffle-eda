"use strict";
// Real app controls and workers, with native folder grants backed by an in-memory fixture.
// Run with installed Chrome and Playwright Core.
const assert=require("node:assert/strict"),path=require("node:path"),{pathToFileURL}=require("node:url");
const {chromium}=require("playwright-core"), app=path.resolve(__dirname,"../../app");
for(const name of ["model","source-file","format-2-codec","format-2-units","format-2-values","format-2-model"])
  require(require("../support/app-source-paths.cjs").appFileFrom(app, name+".js"));
function input() {
  const p=Atrium.project("Folder review",[]), [root,board]=p.documents;
  const child=Atrium.sheet("schematic","Child"), spare=Atrium.sheet("schematic","Spare");
  root.id="root";root.name="Parent";board.id="board";child.id="child";spare.id="spare";
  root.items.push({kind:"sheetsymbol",id:"symbol",name:"Receiver",sheet:child.id,x:36,y:-16,w:28,h:25,
    entries:[{id:"signal-entry",name:"SIG",side:"left",offset:5,io:"input"}]},
    {kind:"textframe",role:"frame",id:"module",text:"Module",x:-35,y:-25,w:25,h:20},
    {kind:"wire",id:"module-wire",points:[[-31,-15],[-22,-15]]},
    {kind:"netlabel",id:"module-label",text:"LOCAL",x:-31,y:-15});
  child.items.push({kind:"port",id:"signal-child",text:"SIG",x:11,y:-7,io:"input"});
  spare.items.push({kind:"offsheet",id:"isolated",text:"OTHER",x:7,y:4,io:"output"});
  p.library.push({id:"def",name:"Test land",footprint:{name:"Test land",shapes:[],pads:[
    {kind:"pad",number:"1",shape:"round",x:0,y:0,w:1,h:1,layer:"Top"}]}});
  board.items.push({kind:"track",id:"track",layer:"Top",points:[[0,0],[8,0]],width:.2},
    {kind:"part",id:"board-part",ref:"TP1",def:"def",x:5,y:2,angle:90,layer:"Bottom",
      designator:{x:0,y:-2,angle:0,height:.8}});
  p.documents.push(child,spare);
  p.rules={version:3,list:[{id:"scope",type:"ercNetScope",name:"Connections",enabled:true,priority:1,
    where:"schematic",scope:{languageVersion:1,source:"object"},netScope:"hierarchical"}]};
  const {files,manifestPath}=AtriumFormat2Model.fromEditor(p,{entryDocument:root.id});
  return {manifest:manifestPath,files:files.map(({path,file})=>{
    const bytes=AtriumFormat2.serialize(file);
    return {path,base64:Buffer.from(bytes).toString("base64"),sha256:AtriumFormat2.sha256(bytes)};
  })};
}
(async()=>{
 const browser=await chromium.launch({headless:true,args:["--allow-file-access-from-files"],
   ...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"})});
 const context=await browser.newContext({viewport:{width:1400,height:900}});
 const page=await context.newPage(), errors=[];
 page.on("pageerror",e=>errors.push(e.message));
 page.setDefaultTimeout(8000);
 try{
  await context.addInitScript(payload=>{
    const files=new Map(payload.files.map(f=>[f.path,f]));
    globalThis.storedReads=[];globalThis.exportsMade=[];globalThis.firstBoardPaint=null;
    Object.defineProperty(globalThis,"AtriumCanvas",{configurable:true,set(canvas){
      Object.defineProperty(globalThis,"AtriumCanvas",{configurable:true,writable:true,value:canvas});
      const create=canvas.create;
      canvas.create=(...args)=>{
        const view=create(...args), render=view.render;
        view.render=(doc,...options)=>{
          if(doc.id==="board" && firstBoardPaint===null) {
            const part=doc.items.find(i=>i.id==="board-part");
            firstBoardPaint=!!globalThis.AtriumDesignators?.label(part);
          }
          return render(doc,...options);
        };
        return view;
      };
    }});
    globalThis.AtriumHost={
      platform:"mac",async open(){return [{name:payload.manifest,folderProject:{grant:"root-grant",manifest:payload.manifest,name:"Folder review"}}];},
      async folderReadLease(){return {lease:"read-lease"};}, async folderRelease(){}, async folderAdopt(){return true;},
      async folderClose(){}, async folderLocalState(){return {};}, finishedOpening(){}, markOpened(){}, clearProjectPath(){}, setDirty(){},
      async exportFile(name,data){exportsMade.push({name,size:data.length});return true;},
      async folderRead({paths}){
        storedReads.push(...paths);
        return {files:paths.map(path=>{const f=files.get(path);if(!f)throw Error("Missing "+path);
          const bytes=Uint8Array.from(atob(f.base64),x=>x.charCodeAt(0));return {path,bytes,length:bytes.length,sha256:f.sha256};})};
      }
    };
  },input());
  await page.goto(pathToFileURL(path.join(app,"index.html")).href);
  await page.getByRole("button",{name:"Continue to editor",exact:true}).click();
  await page.evaluate(()=>{AtriumPower.setMode("always");AtriumNavHost.act("open");});
  await page.waitForFunction(()=>AtriumNavHost.folderProject()?.hasPresented("root"),null,{timeout:15000});
  const reads=()=>page.evaluate(()=>storedReads.slice());
  const data=await reads();
  assert.deepEqual(data,["Folder review.waffle","Parent.wsch"]);
  const child=page.locator('#documents [data-doc="child"]');
  await child.waitFor();
  assert.equal(await child.getAttribute("aria-level"),"2");
  assert.deepEqual(await reads(),data);
  await child.click();
  await page.waitForFunction(()=>AtriumNavHost.currentId()==="child");
  assert.deepEqual(await reads(),[...data,"Child.wsch"]);
  const point=await page.evaluate(async()=>{
    const h=AtriumNavHost;
    await AtriumLazy.need("AtriumConnectionPreview");
    h.select(["signal-child"]);
    const port=h.doc().items[0], canvas=h.canvas(), view=h.view();
    view.restoreCamera({...view.camera(),cx:port.x,cy:port.y,scale:15});
    h.redraw(true);
    const r=canvas.getBoundingClientRect(), p=view.worldToScreen([port.x,port.y]);
    return [r.left+p[0],r.top+p[1]];
  });
  await page.waitForFunction(()=>!!AtriumConnectionPreview.current());
  await page.mouse.move(5,5);
  await page.mouse.move(...point);
  const card=page.locator(".sheet-connection-card");
  await card.getByText("Showing connections on loaded sheets",{exact:true}).waitFor();
  assert.deepEqual(await reads(),[...data,"Child.wsch"],"hover consumes the loaded bodies");
  await page.keyboard.press("Escape");
  const clickMenu=async (menu,action,sub)=>{
    const m=page.locator('.menubar [data-menu="'+menu+'"]');
    await m.locator(":scope > summary").click();
    if(sub)await m.locator(".submenu-trigger").filter({hasText:sub}).click();
    await m.locator('[data-action="'+action+'"]').click();
  };
  await clickMenu("project","sheet-overview");
  const box=page.locator("#doc-view-sheet-overview");
  await box.getByText("2 loaded sheets",{exact:true}).waitFor();
  assert.deepEqual(await reads(),[...data,"Child.wsch"]);
  await box.getByRole("button",{name:"Load all sheets",exact:true}).click();
  await box.getByText("3 sheets",{exact:true}).waitFor();
  assert.deepEqual(await reads(),[...data,"Child.wsch","Spare.wsch"]);
  await box.locator(".sheet-overview-connection").filter({hasText:"SIG"}).click();
  await page.waitForFunction(()=>AtriumNavHost.currentId()==="root" && AtriumNavHost.selection().includes("symbol"));
  await clickMenu("view","view-back");
  await page.waitForFunction(()=>AtriumNavHost.currentId()==="child");
  await clickMenu("view","view-forward");
  await page.waitForFunction(()=>AtriumNavHost.currentId()==="root");
  console.log("PASS folder tree, hover on loaded sheets, explicit graph loading and View Back/Forward");
  await clickMenu("file","export",/^Export$/);
  const k=page.getByRole("dialog",{name:"Export Design",exact:true});
  await k.getByRole("button",{name:"Export",exact:true}).click();
  await page.waitForFunction(()=>exportsMade.some(f=>f.name.endsWith(".kicad_sch")));
  assert.ok(!(await reads()).some(p=>p.endsWith(".wpcb")));
  assert.equal(await page.evaluate(()=>firstBoardPaint),null);
  await clickMenu("file","export-altium",/^Export$/);
  const a=page.getByRole("dialog",{name:"Export Altium Project (ASCII)",exact:true});
  await a.getByRole("button",{name:"Export…",exact:true}).click();
  await page.waitForFunction(()=>exportsMade.some(f=>f.name.endsWith("-altium-ascii.zip")));
  assert.ok((await reads()).includes("Board layout.wpcb"));
  await page.locator('#documents [data-doc="board"]').click();
  await page.waitForFunction(()=>firstBoardPaint!==null);
  assert.equal(await page.evaluate(()=>firstBoardPaint),true,"the first visible board paint uses the authored designator");
  await page.locator('#documents [data-doc="root"]').click();
  await page.waitForFunction(()=>AtriumNavHost.currentId()==="root");
  console.log("PASS scoped exports preserve loading boundaries and the first board paint renders the authored designator");
  const frame=await page.evaluate(()=>{
    const h=AtriumNavHost, view=h.view(), canvas=h.canvas();
    view.restoreCamera({...view.camera(),cx:-22,cy:-15,scale:15});
    h.redraw(true);
    const p=view.worldToScreen([-35,-15]), r=canvas.getBoundingClientRect();
    return [r.left+p[0],r.top+p[1]];
  });
  await page.mouse.click(...frame,{button:"right"});
  await page.locator('[data-menu-action="sch-convert-frame"]').click();
  await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="module")?.kind==="sheetsymbol");
  const grouped=await page.evaluate(async()=>{
    const h=AtriumNavHost, child=h.docById(h.doc().items.find(i=>i.id==="module").sheet);
    const saved=await h.folderProject().save({documentId:h.currentId()});
    return {child:child.items.some(i=>i.id==="module-wire"),needsSaveAll:saved.needsSaveAll};
  });
  assert.deepEqual(grouped,{child:true,needsSaveAll:true});
  await page.evaluate(()=>AtriumNavHost.act("undo"));
  await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="module")?.role==="frame" &&
    AtriumNavHost.doc().items.some(i=>i.id==="module-wire"));
  assert.deepEqual(errors,[]);
  console.log("PASS frame conversion groups both folder owners and takes one Undo");
  const nets = await context.newPage();
  nets.on("pageerror",e=>errors.push(e.message));
  try {
    await nets.goto(pathToFileURL(path.join(app,"index.html")).href);
    await nets.getByRole("button",{name:"Continue to editor",exact:true}).click();
    await nets.evaluate(()=>{AtriumPower.setMode("always");AtriumNavHost.act("open");});
    await nets.waitForFunction(()=>AtriumNavHost.folderProject()?.hasPresented("root"));
    assert.deepEqual(await nets.evaluate(()=>storedReads),data,"opening the active sheet does not read peers");
    await nets.evaluate(()=>AtriumNavHost.act("nets-panel"));
    await nets.getByRole("grid",{name:"Nets",exact:true}).getByText("LOCAL",{exact:true}).waitFor();
    await nets.waitForFunction(()=>AtriumNavHost.folderProject().completeFor("schematic-connections"));
    assert.deepEqual(await nets.evaluate(()=>storedReads),[...data,"Child.wsch","Spare.wsch"],
      "the explicit Nets panel reads schematic owners through the folder grant without reading the board or its definitions");
    await nets.evaluate(()=>AtriumNavHost.act("navigator-panel"));
    await nets.getByRole("searchbox",{name:"Search the Navigator"}).fill("OTHER");
    await nets.getByRole("tree",{name:"Compiled design"}).locator('.navp-row[data-type="net"]').getByText("OTHER",{exact:true}).waitFor();
    assert.deepEqual(await nets.evaluate(()=>storedReads),[...data,"Child.wsch","Spare.wsch"]);
    assert.deepEqual(errors,[]);
    console.log("PASS opening Nets loads only the granted schematic closure and Navigator reuses the loaded owners");
  } finally {await nets.close();}
 } catch(error) {
  const state=await page.evaluate(()=>({reads:storedReads,status:document.querySelector("#status")?.textContent,
    document:globalThis.AtriumNavHost?.currentId()})).catch(()=>null);
  console.error(state);
  throw error;
 } finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
