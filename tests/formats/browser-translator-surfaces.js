"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {createHash} = require("node:crypto");
require("../../app/formats/sexpr.js");
require("../../app/core/zip.js");
const {pathToFileURL} = require("node:url");

const app = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;
const fixtures = path.join(__dirname, "../fixtures");
const view = page => page.locator(".import-report:visible");
async function pick(page, files, fromHome=true) {
  const command = fromHome
    ? page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Open…", exact:true})
    : page.getByRole("button", {name:"Open", exact:true});
  const [picker] = await Promise.all([page.waitForEvent("filechooser"),command.click()]);
  const accept = await picker.element().getAttribute("accept");
  assert.ok(accept.includes(".kicad_pcb") && accept.includes(".waffle") && accept.includes(".zip"));
  assert.ok(!accept.includes(".atrium"));
  await picker.setFiles(files);
}
async function open(page, files) {
  await pick(page,files);
  await view(page).waitFor();
}
const originalActions=["Compare with original","Re-import original…"];
const originalButton=(page,i)=>view(page).getByRole("button",{name:originalActions[i],exact:true});
async function checkOriginalLayout(page,{touch=false,wrapped=false}={}) {
  const controls=[];
  for(let i=0;i<originalActions.length;i++) {
    const control=originalButton(page,i);
    const rect=await control.evaluate(b=>{
      const r=b.getBoundingClientRect(),s=getComputedStyle(b);
      return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,border:parseFloat(s.borderTopWidth),
        hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===b,inside:r.left>=visualViewport.offsetLeft && r.right<=visualViewport.width+visualViewport.offsetLeft};
    });
    assert.ok(rect.hit && rect.inside && rect.border>=1,originalActions[i]+" is independently visible and clickable");
    assert.ok(rect.height >= (touch?44:24));controls.push(rect);
  }
  const [first,second]=controls;
  const gap=wrapped?second.top-first.bottom:second.left-first.right;
  assert.ok(gap>=8,"separation between the original-source controls: "+gap);
  const warningTop=await view(page).locator(".import-report-warnings").evaluate(e=>e.getBoundingClientRect().top);
  assert.ok(warningTop-Math.max(first.bottom,second.bottom)>=12);
  await view(page).locator("article").focus();
  for(let i=0;i<originalActions.length;i++){
    await page.keyboard.press("Tab");
    assert.ok(await originalButton(page,i).evaluate(b=>b===document.activeElement && b.matches(":focus-visible") &&
      getComputedStyle(b).outlineStyle!=="none" && parseFloat(getComputedStyle(b).outlineWidth)>0),originalActions[i]+" has visible keyboard focus");
  }
}
async function checkOriginalCommands(page,touch=false) {
  const handle=await page.evaluateHandle(()=>AtriumNavHost.fileSession());
  const state=()=>page.evaluate(async()=>{
    const h=AtriumNavHost,bytes=new TextEncoder().encode(JSON.stringify(h.project()));
    const entry=AtriumImportReports.recent(h.currentId());
    return {digest:Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))),revision:h.revision(),dirty:h.isDirty(),
      document:h.currentId(),selection:h.selection(),scope:entry.scopeId,originals:entry.provenance.files.map(f=>[f.name,f.sha256])};
  });
  const before=await state();
  async function click(control) {
    if(!touch)return control.click();
    await control.scrollIntoViewIfNeeded();
    const point=await control.evaluate(b=>{
      const r=b.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
      if(document.elementFromPoint(x,y)!==b)throw Error("Covered touch control: "+b.textContent);
      return [x-visualViewport.offsetLeft,y-visualViewport.offsetTop];
    });
    await page.touchscreen.tap(...point);
  }
  await click(originalButton(page,0));
  const close=page.locator(".dv-close");await close.waitFor();
  await close.click();await close.waitFor({state:"hidden"});
  const tab=page.getByRole("tab",{name:/Import Report/});await tab.click();
  await click(originalButton(page,1));
  const cancel=page.getByRole("dialog").getByRole("button",{name:"Cancel",exact:true});
  await cancel.waitFor();await click(cancel);await cancel.waitFor({state:"hidden"});
  await page.waitForFunction(()=>document.querySelector(".import-report:not([hidden]) .import-report-actions button:last-child:enabled"));
  assert.equal(await page.evaluate(s=>AtriumNavHost.fileSession()===s,handle),true);
  assert.deepEqual(await state(),before,"Compare and cancelled Re-import preserve the working design");
  await handle.dispose();
}
async function checkTouchReport(browser) {
  for(const width of [390,270]){
    const page=await browser.newPage({viewport:{width,height:844},hasTouch:true,isMobile:true,reducedMotion:"reduce"});
    try {
      await page.goto(app);await open(page,path.join(fixtures,"import/demo.kicad_pcb"));
      await checkOriginalLayout(page,{touch:true,wrapped:width===270});
      if(width===390)await checkOriginalCommands(page,true);
    } finally {await page.close();}
  }
  console.log("PASS Import Report touch hit targets, visible focus order, narrow wrapping, Compare and cancelled Re-import");
}
async function checkTabs(browser) {
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(app);
    await open(page, path.join(fixtures,"import/demo.kicad_pcb"));
    const firstTab = page.getByRole("tab", {name:/Import Report.*demo.kicad_pcb/});
    assert.equal(await firstTab.getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("dialog[open]").count(),0);
    assert.deepEqual(await view(page).getByRole("columnheader").allTextContents(),
      ["Object kind","Kept","Approximated","Dropped","Source references"]);
    const rows = view(page).locator("tbody tr");
    for (const [column,status] of [[1,"Kept"],[2,"Approximated"],[3,"Dropped"]]) {
      const row = rows.filter({has:page.locator("td:nth-child("+(column+1)+")", {hasText:/^[1-9]/})}).first();
      const details = row.locator("details");
      if (!await details.evaluate(d => d.open)) await details.locator("summary").click();
      const list = view(page).locator("#"+await details.locator("summary").getAttribute("aria-controls"));
      await list.locator("li").filter({hasText:new RegExp("^"+status+" · demo\\.kicad_pcb · ")}).first().waitFor();
    }
    // Opening the reference disclosures scrolls the report down to those rows.
    // Return to the header before checking its button geometry and hit targets.
    await view(page).evaluate(report => {report.scrollTop=0;});
    for (const theme of ["light","dark"]) {
      await page.evaluate(value => AtriumTheme.set({preset:value,followSystem:false},{persist:false}),theme);
      await page.waitForFunction(value => document.documentElement.dataset.theme===value && !document.documentElement.hasAttribute("data-theme-fading"),theme);
      await checkOriginalLayout(page);
      const contrast = await view(page).evaluate(el => {
        // Resolve any CSS colour (rgb(), color(srgb …), translucent soft fills) to 8-bit RGBA.
        const pixel = document.createElement("canvas").getContext("2d", {willReadFrequently:true});
        const rgba = color => {
          pixel.clearRect(0,0,1,1); pixel.fillStyle = color; pixel.fillRect(0,0,1,1);
          const [r,g,b,a] = pixel.getImageData(0,0,1,1).data; return [r,g,b,a/255];
        };
        // The painted background: translucent fills composite over the nearest ancestors' backgrounds.
        const painted = node => {
          const layers = [];
          for (let n = node; n; n = n.parentElement) {
            const c = rgba(getComputedStyle(n).backgroundColor); if (c[3]) layers.push(c);
            if (c[3] === 1) break;
          }
          return layers.reduceRight((under,[r,g,b,a]) => [r,g,b].map((v,i) => v*a + under[i]*(1-a)), [255,255,255]);
        };
        const luminance = rgb => {
          const channels = rgb.map(v => { const n=v/255; return n<=.04045?n/12.92:((n+.055)/1.055)**2.4; });
          return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
        };
        const ratio=(node,background)=>{
          const fg=luminance(rgba(getComputedStyle(node).color).slice(0,3)),bg=luminance(painted(background));
          return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
        };
        return [ratio(el.querySelector(".import-report-warnings h3"),el),
          ...[...el.querySelectorAll(".import-report-actions button")].map(button=>ratio(button,button))];
      });
      assert.ok(contrast.every(ratio=>ratio>=4.5),theme+" warning and original-action text contrast: "+contrast.join(", "));
    }
    const translated=await page.evaluate(async()=>{
      await AtriumI18n.setLocale("en-XA");
      return ["import_report.compare_with_original","import_report.reimport_original"].map(k=>AtriumI18n.t(k));
    });
    for(let i=0;i<translated.length;i++){
      assert.notEqual(translated[i],originalActions[i]);
      await view(page).getByRole("button",{name:translated[i],exact:true}).waitFor();
    }
    await page.evaluate(()=>AtriumI18n.setLocale("en"));
    await checkOriginalCommands(page);
    const boardId = await page.evaluate(() => AtriumNavHost.currentId());
    await page.locator('#document-tabs [data-tab="'+boardId+'"]').click();
    await page.locator('[data-menu="file"] > summary').click();
    await page.getByRole("menuitem",{name:"Fabrication Outputs…"}).click();
    const fab=page.getByRole("dialog",{name:"Fabrication outputs"});
    const manufacturing=page.waitForEvent("download");
    await fab.getByRole("button",{name:"Download all (.zip)"}).click();
    const packageFile=await manufacturing;
    assert.equal(await packageFile.failure(),null);
    const archive=AtriumImportFormats.unzip(await fs.readFile(await packageFile.path()));
    const members=[...archive.keys()];
    assert.ok(members.some(name=>/\.GTL$/i.test(name)) && members.some(name=>/\.(TXT|DRL)$/i.test(name)),"fabrication package includes copper and drill files");
    const expectedBottom = await page.evaluate(id => {
      const project = AtriumNavHost.project(), doc = project.documents.find(d => d.id === id);
      return AtriumFabOutputs.build(project, doc).files.find(f => f.name.endsWith(".GBL")).content;
    }, boardId);
    const regions = film => film.match(/G36\*[\s\S]*?G37\*/g) || [];
    const bottom = members.find(name => name.endsWith(".GBL"));
    assert.ok(regions(expectedBottom).length > 0, "the fixture has bottom copper to compare");
    assert.deepEqual(regions(Buffer.from(archive.get(bottom)).toString("utf8")), regions(expectedBottom), "the downloaded Gerber contains the complete bottom copper regions");
    await page.locator(".project-tree > summary").click({button:"right"});
    const choosing = page.waitForEvent("filechooser");
    await page.getByRole("menuitem",{name:"Add Existing to Project…"}).click();
    await (await choosing).setFiles(path.join(fixtures,"import/child.kicad_sch"));
    const sheetTab = page.getByRole("tab",{name:/Import Report.*child.kicad_sch/});
    await sheetTab.waitFor();
    assert.equal(await sheetTab.getAttribute("aria-selected"), "true");
    assert.equal(await firstTab.getAttribute("aria-selected"), "false");
    const ids = await page.evaluate(() => [AtriumNavHost.currentId(), AtriumNavHost.project().documents.find(d=>d.kind==="pcb").id]);
    assert.notEqual(ids[0],boardId);
    await firstTab.focus(); await page.keyboard.press("Delete");
    await page.locator('#document-tabs [data-tab="'+boardId+'"]').click();
    await page.locator('[data-menu="reports"] > summary').click();
    await page.getByRole("menuitem",{name:"Import Report",exact:true}).click();
    assert.equal(await firstTab.getAttribute("aria-selected"),"true");
    assert.ok((await view(page).innerText()).includes("demo.kicad_pcb"));
    assert.deepEqual(errors,[]);
    console.log("PASS Open and Add Existing keep separate document reports, exact source references and readable warnings in both themes");
  } finally { await page.close(); }
}

const rejection = "This file is from a pre-release Waffle build; re-import the design from its source EDA";
async function checkObsolete(browser) {
  const dir=path.join(fixtures,"compat/projects"), page=await browser.newPage(), errors=[];
  const waffle=path.join(dir,"v1.5-altium-geometry.waffle"), atrium=path.join(dir,"v1.4-import-kicad.atrium");
  const original=await fs.readFile(atrium), oldWaffle=await fs.readFile(waffle);
  page.on("pageerror",error=>errors.push(error.message));
  try {
    await page.goto(app);
    const home=page.getByRole("button",{name:"Continue to editor"});
    await home.click();
    await home.waitFor({state:"hidden"});
    const starting=await page.evaluate(()=>{
      const h=AtriumNavHost;
      window.beforeOpen={project:h.project(),session:h.fileSession(),revision:h.revision()};
      return h.currentId();
    });
    await pick(page,waffle,false);
    const assertRejected=async()=>{
      const d=page.getByRole("dialog",{name:"Couldn’t open this file"});
      await d.getByText(rejection,{exact:true}).waitFor();
      assert.equal(await page.evaluate(current=>{
        const h=AtriumNavHost, before=window.beforeOpen;
        return h.project()===before.project && h.fileSession()===before.session &&
          h.revision()===before.revision && h.currentId()===current;
      },starting),true);
      await d.getByRole("button",{name:"Done"}).click();
      await d.waitFor({state:"hidden"});
    };
    await assertRejected();
    await page.evaluate(({name,bytes})=>{
      const transfer=new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(bytes),c=>c.charCodeAt(0))],name));
      window.dispatchEvent(new DragEvent("drop",{bubbles:true,dataTransfer:transfer}));
    },{name:path.basename(atrium),bytes:original.toString("base64")});
    await assertRejected();
    const wrapped=AtriumZip.create([{name:path.basename(atrium),data:original}]);
    await pick(page,{name:"Old projects.zip",mimeType:"application/zip",buffer:Buffer.from(wrapped)},false);
    await assertRejected();
    assert.deepEqual(await fs.readFile(atrium),original);
    assert.deepEqual(await fs.readFile(waffle),oldWaffle);
    assert.deepEqual(errors,[]);
    console.log("PASS browser picker, drop and ZIP reject both historical extensions and preserve the open editor");
  } finally {await page.close();}
}

async function downloadProject(page, imported = false) {
  const next=page.waitForEvent("download");
  await page.getByRole("button",{name:"Save",exact:true}).click();
  if(imported){
    await page.getByRole("dialog",{name:/^Save “.*” as a Waffle project\?$/})
      .getByRole("button",{name:"Save as Waffle Project…",exact:true}).click();
    await page.getByRole("button",{name:"Download Format 2 ZIP",exact:true}).click();
  }
  const file=await next, name=file.suggestedFilename();
  assert.match(name,/\.zip$/);
  assert.equal(await file.failure(),null);
  const buffer=await fs.readFile(await file.path());
  return {name,buffer,files:AtriumImportFormats.unzip(buffer)};
}

async function checkFormat2(browser) {
  const source=path.join(fixtures,"import/demo.kicad_pcb"), original=await fs.readFile(source);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"waffle-browser-zip-"));
  const page=await browser.newPage(), restored=await browser.newPage(), fromFolder=await browser.newPage(), errors=[];
  for(const window of [page,restored,fromFolder])window.on("pageerror",error=>errors.push(error.message));
  const ready=page=>page.waitForFunction(()=>AtriumNavHost.folderProject()?.temporary && AtriumNavHost.doc().items.some(o=>o.id==="browser-save-label"));
  try {
    await page.goto(app);
    await open(page,source);
    await page.waitForFunction(()=>AtriumNavHost.importSession()?.state==="unsaved");
    const pending=await page.evaluate(()=>({pending:AtriumNavHost.importSession(),dirty:AtriumNavHost.isDirty(),
      folder:!!AtriumNavHost.folderProject()}));
    assert.equal(pending.folder,false);
    assert.equal(pending.dirty,true);
    assert.equal(pending.pending.translator,"kicad");
    await page.getByRole("button",{name:"Save",exact:true}).click();
    await page.getByRole("dialog",{name:/Save “.*” as a Waffle project/}).waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction(()=>AtriumNavHost.importSession()?.state==="unsaved");
    assert.equal(await page.evaluate(()=>AtriumNavHost.importSession().id),pending.pending.id);
    assert.equal(await page.getByRole("button",{name:"Save",exact:true}).evaluate(button=>button===document.activeElement),true);
    await page.evaluate(async()=>{
      const h=AtriumNavHost, sheet=h.documentRefs().find(d=>d.kind==="schematic");
      await h.selectDocument(sheet.id);
      const doc=h.doc();
      h.edit(()=>doc.items.push({id:"browser-save-label",kind:"netlabel",text:"SNAPSHOT_A",x:5.08,y:2.54}),"Place net label");
    });
    const first=await downloadProject(page,true);
    assert.equal(await page.evaluate(()=>AtriumNavHost.importSession()),null);
    const manifest=[...first.files.keys()].find(name=>name.endsWith(".waffle"));
    const sourceDigest=createHash("sha256").update(original).digest("hex");
    const sourcePath=[...first.files.keys()].find(name=>name.endsWith("/.waffle/imports/"+sourceDigest+"/source"));
    assert.ok(manifest && sourcePath);
    assert.deepEqual(Buffer.from(first.files.get(sourcePath)),original);
    const header=JSON.parse(Buffer.from(first.files.get(manifest)).toString("utf8").split("\n")[0]);
    assert.equal(header.formatVersion,"2.0");
    assert.equal(header.kind,"project");

    const input={name:first.name,mimeType:"application/zip",buffer:first.buffer};
    await restored.goto(app);
    await pick(restored,input);
    await restored.getByRole("dialog",{name:"Open project ZIP"}).getByRole("button",{name:"Open project",exact:true}).click();
    await ready(restored);
    await restored.evaluate(()=>{
      const h=AtriumNavHost, label=h.doc().items.find(o=>o.id==="browser-save-label");
      h.edit(()=>{label.text="SNAPSHOT_B";},"Edit net label");
      h.act("undo");
      if(h.doc().items.find(o=>o.id==="browser-save-label").text!=="SNAPSHOT_A")throw Error("Undo did not restore the saved label.");
      h.act("redo");
    });
    const second=await downloadProject(restored);
    const changed=[...second.files].filter(([name,data])=>!first.files.has(name) ||
      !Buffer.from(first.files.get(name)).equals(Buffer.from(data))).map(([name])=>name);
    assert.equal(second.files.size,first.files.size);
    assert.equal(changed.length,1);
    assert.match(changed[0],/\.wsch$/);
    assert.match(Buffer.from(second.files.get(changed[0])).toString("utf8"),/SNAPSHOT_B/);

    const referenceFile=restored.waitForEvent("filechooser");
    const compared=restored.evaluate(async()=>{
      await AtriumLazy.need("AtriumGitPicker");
      const active=AtriumNavHost.project();
      const reference=await AtriumGit.readSpec({type:"file"},AtriumNavHost);
      return {text:reference.project.documents.flatMap(d=>d.items).find(o=>o.id==="browser-save-label").text,
        active:AtriumNavHost.project()===active};
    });
    await (await referenceFile).setFiles(input);
    assert.deepEqual(await compared,{text:"SNAPSHOT_A",active:true});

    for(const [name,bytes] of first.files){
      const dest=path.join(root,name);
      await fs.mkdir(path.dirname(dest),{recursive:true});
      await fs.writeFile(dest,bytes);
    }
    const selected=path.join(root,manifest);
    await fromFolder.goto(app);
    await pick(fromFolder,selected);
    const folderPick=fromFolder.waitForEvent("filechooser");
    await fromFolder.getByRole("dialog",{name:"Open project folder"}).getByRole("button",{name:"Choose folder…"}).click();
    await (await folderPick).setFiles(path.dirname(selected));
    await ready(fromFolder);
    await fromFolder.evaluate(async()=>{
      const h=AtriumNavHost;await h.selectDocument(h.documentRefs().find(d=>d.kind==="pcb").id);
      const track=h.doc().items.find(i=>i.kind==="track");h.edit(()=>{track.width+=.05;},"Change trace width");
      h.select([track.id]);
    });
    await fromFolder.locator('[data-menu="reports"] summary').click();
    await fromFolder.getByRole("menuitem",{name:"Import Report",exact:true}).click();
    await checkOriginalLayout(fromFolder);await checkOriginalCommands(fromFolder);
    assert.deepEqual(await fs.readFile(source),original);
    assert.deepEqual(errors,[]);
    console.log("PASS native ZIP save and verified Open, scoped edit/Undo, saved ZIP comparison, folder report Compare and cancelled Re-import, exact retained KiCad input");
  } finally {
    await Promise.all([page.close(),restored.close(),fromFolder.close()]);
    await fs.rm(root,{recursive:true,force:true});
  }
}

async function checkLocalizedExport(browser) {
  const page=await browser.newPage();
  try {
    await page.addInitScript(()=>{window.showSaveFilePicker=undefined;});
    await page.goto(app);
    await open(page,path.join(fixtures,"import/demo.kicad_pcb"));
    await page.getByRole("button",{name:"Save",exact:true}).click();
    await page.getByRole("button",{name:"Export to KiCad…",exact:true}).click();
    const review=page.locator("dialog.import-save-sheet").filter({has:page.locator("h2",{hasText:/Export.*KiCad/})});
    await review.waitFor();
    await page.evaluate(()=>AtriumI18n.setLocale("en-XA"));
    const [download]=await Promise.all([page.waitForEvent("download"),review.locator("button.is-primary").click()]);
    const name=download.suggestedFilename();
    await page.waitForFunction(()=>AtriumNavHost.importSession()?.state==="unsaved");
    const message=await page.locator("#status").textContent();
    const translated=await page.evaluate(name=>AtriumI18n.t("import_save.editor.downloaded",{name}),name);
    assert.equal(message,translated);
    assert.notEqual(message,"Downloaded "+name+". The working design still needs a save.");
    assert.ok(message.includes(name));
    assert.equal(await page.evaluate(()=>AtriumNavHost.isDirty()&&!AtriumNavHost.folderProject()),true);
    console.log("PASS actual KiCad export download remains unsaved and preserves the filename in the pseudo-locale");
  } finally {await page.close();}
}

async function checkReferenceColumns(browser) {
  // Opening or closing a source-reference list must not resize the report's columns.
  const fixture=path.join(fixtures,"altium/pidp11-io-expander"), page=await browser.newPage({viewport:{width:900,height:800}});
  try {
    await page.goto(app);
    await pick(page,["PCB-PiDP11IOExpander.PrjPcb","PiDP11IOExpander.SchDoc","PiDP11IOExpander.PcbDoc"].map(name=>path.join(fixture,name)));
    await view(page).waitFor();
    await page.getByRole("tab",{name:/Import Report/}).first().click();
    const table=view(page).locator("table");
    const widths=()=>table.evaluate(t=>[...t.tHead.rows[0].cells].map(c=>Math.round(c.getBoundingClientRect().width*10)/10));
    const tableWidth=()=>table.evaluate(t=>t.getBoundingClientRect().width);
    const toggles=table.locator("summary");
    const toggle=async (i,open)=>{
      await toggles.nth(i).click();
      await toggles.nth(i).evaluate((s,open)=>new Promise(done=>{
        const ready=()=>s.parentElement.open===open && s.closest("tr").nextElementSibling.hidden===!open;
        if (ready()) done(); else s.parentElement.addEventListener("toggle",()=>done(),{once:true});
      }),open);
    };
    const before=await widths(), width=await tableWidth();
    assert.ok(await toggles.count()>0,"the Altium report lists source references");
    for (let i=0;i<await toggles.count();i++) {
      await toggle(i,true);
      assert.deepEqual(await widths(),before,"columns keep their widths with references "+i+" shown");
      assert.equal(await tableWidth(),width);
    }
    const rows=await view(page).locator("tr.import-report-references:not([hidden])").evaluateAll(rows=>rows.map(row=>{
      const cell=row.cells[0], table=row.closest("table").getBoundingClientRect(), r=cell.getBoundingClientRect();
      return {span:cell.colSpan,full:Math.abs(r.width-table.width)<1,items:cell.querySelectorAll("li").length,
        inside:[...cell.querySelectorAll("li")].every(li=>li.getBoundingClientRect().right<=r.right+0.5),
        controlled:row.previousElementSibling.querySelector("summary").getAttribute("aria-controls")===cell.id};
    }));
    assert.equal(rows.length,await toggles.count());
    for (const row of rows) assert.deepEqual(row,{...row,span:5,full:true,inside:true,controlled:true}),assert.ok(row.items>0);
    for (let i=0;i<await toggles.count();i++) await toggle(i,false);
    assert.deepEqual(await widths(),before,"columns keep their widths with references hidden again");
    assert.equal(await view(page).locator("tr.import-report-references:not([hidden])").count(),0);
    await page.setViewportSize({width:820,height:700});
    const narrow=await widths();
    await toggle(0,true);
    assert.deepEqual(await widths(),narrow,"columns stay put in a narrow pane");
    assert.ok(await table.evaluate(t=>[...t.tHead.rows[0].cells].every(c=>c.scrollWidth<=c.clientWidth)),"headers fit their columns");
    if (process.env.IMPORT_REPORT_REVIEW_DIR) {
      await table.evaluate(t=>t.scrollIntoView({block:"start",inline:"start"}));
      await page.screenshot({path:path.join(process.env.IMPORT_REPORT_REVIEW_DIR,"import-report-references.png")});
    }
    console.log("PASS Import Report source references expand without changing column widths");
  } finally {await page.close();}
}

module.exports = async browser => {
  await checkReferenceColumns(browser);
  await checkTabs(browser);
  await checkTouchReport(browser);
  await checkObsolete(browser);
  await checkFormat2(browser);
  await checkLocalizedExport(browser);
};
