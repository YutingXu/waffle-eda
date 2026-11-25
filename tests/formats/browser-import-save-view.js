"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path");
const {pathToFileURL} = require("node:url");
const app = pathToFileURL(path.join(__dirname,"../../app/index.html")).href;
const capture = process.env.IMPORT_SAVE_REVIEW_DIR;
const body = format => `This design was imported from ${format}. Saving as a Waffle project keeps everything you add and makes saves instant and Git-friendly. Your original ${format} files stay untouched.`;

async function picture(page,theme,touch,name) {
  if (!capture) return;
  await fs.mkdir(capture,{recursive:true});
  await page.screenshot({path:path.join(capture,[theme,touch?"touch":"desktop",name].join("-")+".png")});
}

async function touchControl(page,control) {
  await control.scrollIntoViewIfNeeded();
  const point=await control.evaluate(el=>{
    const rect=el.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
    if(!el.contains(document.elementFromPoint(x,y))) throw Error("Another element covers this control.");
    // Hit testing uses layout coordinates; a real touchscreen tap uses the visible viewport.
    return {x:x-visualViewport.offsetLeft,y:y-visualViewport.offsetTop};
  });
  await page.touchscreen.tap(point.x,point.y);
}

async function requireClosedSheets(page) {
  const interaction = await page.evaluate(() => {
    const selector = ".import-save-sheet";
    const sheets = [...document.querySelectorAll(selector)];
    return {
      open:sheets.some(sheet=>sheet.open),
      focused:!!document.activeElement?.closest(selector),
      intercepts:sheets.some(sheet=>{
        const {left, top, width, height}=sheet.getBoundingClientRect();
        return width>0 && height>0 &&
          !!document.elementFromPoint(left+width/2,top+height/2)?.closest(selector);
      })
    };
  });
  assert.deepEqual(interaction,{open:false,focused:false,intercepts:false});
  // The closing action resolves before the browser dispatches its close event.
  // The Save and ZIP sheets can briefly both be mounted as closed elements.
  await page.waitForFunction(()=>!document.querySelector(".import-save-sheet"),undefined,{timeout:2000});
  assert.equal(await page.locator(".import-save-sheet").count(),0);
}

async function check(browser, theme, touch = false) {
  const page=await browser.newPage({viewport:touch ? {width:390,height:760} : {width:1140,height:790},
    hasTouch:touch,isMobile:touch,reducedMotion:"reduce"});
  const requests=[], errors=[];
  page.on("request",r=>requests.push(r.url()));page.on("pageerror",e=>errors.push(e.message));
  if (touch) await page.addInitScript(()=>{
    window.importSaveTouches=[];
    document.addEventListener("pointerdown",event=>{
      if (event.isTrusted && event.pointerType==="touch" && event.target.closest(".import-save-hint,.import-save-sheet"))
        importSaveTouches.push(event.target.type || event.target.tagName);
    },true);
  });
  const accessible=async selector=>{
    if (!await page.evaluate(()=>!!globalThis.axe)) await page.addScriptTag({path:require.resolve("axe-core/axe.min.js")});
    const failed=await page.evaluate(async selector=>{
      const report=await axe.run(selector,{runOnly:["wcag2a","wcag2aa","wcag21a","wcag21aa"]});
      return report.violations.map(rule=>[rule.id,rule.nodes.map(n=>n.target)]);
    },selector);
    assert.deepEqual(failed,[]);
  };
  const screenshot=name=>picture(page,theme,touch,name);
  try {
    await page.goto(app);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name",{hasText:"Sensor board"}).waitFor();
    assert.ok(!requests.some(url=>/import-save-view\.(js|css)/.test(url)));
    const loaded=await page.evaluate(async theme=>{
      AtriumTheme.set({preset:theme,followSystem:false,motion:"off"},{persist:false});
      const ui=await AtriumLazy.need("AtriumImportSaveView");
      const data={name:"Signal & Power",format:"kicad",formatLabel:"KiCad"};
      const launch=()=>{window.choice=ui.firstSave({...data,anchor:document.querySelector(".import-save-link")});};
      ui.hint({formatLabel:data.formatLabel,onSave:launch});
      const link=document.querySelector(".import-save-link");
      ui.hint({formatLabel:data.formatLabel,onSave:launch});
      return {same:link===document.querySelector(".import-save-link"),
        under:document.querySelector(".editor-tabbar").nextElementSibling===link.parentElement};
    },theme);
    assert.deepEqual(loaded,{same:true,under:true});
    const hint=page.locator(".import-save-hint"), link=hint.getByRole("button",{name:"Save as Waffle Project…"});
    await hint.getByText("Imported from KiCad",{exact:true}).waitFor();
    assert.equal(await page.locator(".import-save-sheet[open]").count(),0);
    await screenshot("hint");
    const pressLink=()=>touch?touchControl(page,link):link.click();
    await pressLink();
    const sheet=page.getByRole("dialog",{name:"Save “Signal & Power” as a Waffle project?"});
    const save=sheet.getByRole("button",{name:"Save as Waffle Project…",exact:true});
    const exp=sheet.getByRole("button",{name:"Export to KiCad…",exact:true});
    await sheet.getByText(body("KiCad"),{exact:true}).waitFor();
    assert.equal(await sheet.getAttribute("aria-describedby"),"import-save-description");
    assert.ok(await save.evaluate(node=>node===document.activeElement));
    const touchLabels=["Save as Waffle Project…","Export to KiCad…","Cancel"];
    assert.deepEqual(await sheet.getByRole("button").allTextContents(),touch?touchLabels:touchLabels.slice().reverse());
    if (touch) {
      const tops=await sheet.getByRole("button").evaluateAll(buttons=>buttons.map(b=>b.getBoundingClientRect().top));
      assert.ok(tops[0]<tops[1] && tops[1]<tops[2]);
      for (const label of ["Export to KiCad…","Cancel","Save as Waffle Project…"]) {
        await page.keyboard.press("Tab");
        assert.ok(await sheet.getByRole("button",{name:label,exact:true}).evaluate(button=>button===document.activeElement));
      }
      for(const target of [link,save,exp])assert.ok((await target.boundingBox()).height>=44);
      assert.ok(await sheet.evaluate(d=>{
        const rect=d.getBoundingClientRect(),v=visualViewport;
        return rect.left>=v.offsetLeft && rect.right<=v.offsetLeft+v.width+1 &&
          rect.top>=v.offsetTop && rect.bottom<=v.offsetTop+v.height+1;
      }));
    }
    await accessible(".import-save-sheet");await screenshot("first-save");
    if (theme==="dark" && !touch) {
      await page.keyboard.press("Tab");
      assert.ok(await sheet.getByRole("button",{name:"Cancel",exact:true}).evaluate(n=>n===document.activeElement));
      await page.keyboard.press("Shift+Tab");
      assert.ok(await save.evaluate(n=>n===document.activeElement));
    }
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(()=>choice),"cancel");assert.ok(await link.evaluate(n=>n===document.activeElement));
    await link.press("Enter");await sheet.waitFor();await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(()=>choice),"waffle");
    await pressLink();if(touch)await touchControl(page,exp);else await exp.click();assert.equal(await page.evaluate(()=>choice),"export");

    await page.evaluate(()=>{
      window.result=AtriumImportSaveView.report({name:"Signal & Power",formatLabel:"KiCad",allowRemember:true,
        anchor:document.querySelector(".import-save-link"),kept:[{label:"Tracks",count:8}],
        converted:[],lost:[{label:"Rule",count:2,detail:"Clearance overrides for selected pads."}]});
    });
    const report=page.getByRole("dialog",{name:"Export “Signal & Power” to KiCad"});
    assert.equal(await report.getAttribute("aria-describedby"),"import-save-totals");
    assert.deepEqual(await report.locator("dt").allTextContents(),["Kept","Converted","Lost"]);
    assert.deepEqual(await report.locator("dd").allTextContents(),["8","0","2"]);
    assert.deepEqual(await report.locator("h3").allTextContents(),["Kept","Lost"]);
    assert.deepEqual(await report.locator("li").allTextContents(),["Tracks×8","Rule×2Clearance overrides for selected pads."]);
    const remember=report.getByRole("checkbox",{name:"Remember for this project"});
    assert.equal(await remember.isChecked(),false);
    if (touch) await touchControl(page,remember);
    else if (theme==="dark") {
      await page.keyboard.press("Shift+Tab");await page.keyboard.press("Shift+Tab");
      assert.ok(await remember.evaluate(n=>n===document.activeElement));await page.keyboard.press("Space");
    } else await remember.click();
    assert.ok(await remember.isChecked());await accessible(".import-save-sheet");await screenshot("report");
    await report.getByRole("button",{name:"Export",exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>result),{proceed:true,remember:true});
    for (const allowed of [true,false]) {
      await page.evaluate(allowRemember=>{window.result=AtriumImportSaveView.report({
        name:"Signal & Power",formatLabel:"KiCad",converted:[{label:"Graphic",count:18,detail:"×12 Layer A · ×4 Layer B",
          additionalDetails:["×2 Layer C"]}],allowRemember,rememberScope:"session"
      });},allowed);
      assert.deepEqual(await report.locator("h3").allTextContents(),["Converted"]);
      assert.deepEqual(await report.locator("dd").allTextContents(),["0","18","0"]);
      const reasons=report.locator("details");
      assert.equal(await reasons.evaluate(el=>el.open),false);
      assert.equal(await reasons.locator("div").count(),0);
      await reasons.locator("summary",{hasText:"More details (1)"}).press("Enter");
      await reasons.getByText("×2 Layer C",{exact:true}).waitFor({state:"visible"});
      assert.equal(await report.getByRole("checkbox",{name:"Remember while this import is open"}).count(),allowed?1:0);
      await page.keyboard.press("Escape");
      assert.deepEqual(await page.evaluate(()=>result),{proceed:false,remember:false});
    }
    await page.evaluate(()=>{
      const opts={name:"Signal & Power",formatLabel:"EAGLE",canExport:false};
      window.scope=new AbortController();opts.signal=scope.signal;
      window.inFlight=AtriumImportSaveView.firstSave(opts);
      window.coalesced=inFlight===AtriumImportSaveView.firstSave(opts);
    });
    assert.equal(await page.locator(".import-save-sheet[open]").count(),1);
    assert.equal(await page.locator(".import-save-sheet").getByRole("button",{name:/Export/}).count(),0);
    assert.ok(await page.evaluate(()=>coalesced));await page.evaluate(()=>scope.abort());assert.equal(await page.evaluate(()=>inFlight),"cancel");
    await page.evaluate(()=>{window.zip=AtriumImportSaveView.confirmPortable({name:"Signal & Power"});});
    await page.getByRole("button",{name:"Download Format 2 ZIP",exact:true}).click();assert.ok(await page.evaluate(()=>zip));

    const native=await page.evaluate(async()=>{
      const original=globalThis.AtriumHost, file=new File(["sample"],"board.kicad_pcb");
      let given, release;
      globalThis.AtriumHost={canConvertSibling:f=>f===file,importSaveChoice(args){given=args;return new Promise(done=>{release=done;});}};
      try {
        const result=AtriumImportSaveView.firstSave({file,name:"Board A",format:"kicad",formatLabel:"KiCad",canExport:false});
        const count=document.querySelectorAll(".import-save-sheet[open]").length;
        release("waffle");
        const first={choice:await result,count,same:given.file===file,format:given.format,labels:given.labels};
        const scope=new AbortController();
        const recovery=AtriumImportSaveView.firstSave({id:"import-2",sourceKey:"retained-key",name:"Recovered board",
          format:"kicad",formatLabel:"KiCad",signal:scope.signal});
        const restored={id:given.id,sourceKey:given.sourceKey,hasFile:"file" in given,title:given.labels.title,
          duplicates:document.querySelectorAll(".import-save-sheet[open]").length};
        scope.abort();release("export");
        return {first,restored:{...restored,choice:await recovery}};
      } finally {globalThis.AtriumHost=original;}
    });
    assert.deepEqual(native,{first:{choice:"waffle",count:0,same:true,format:"kicad",
      labels:{title:"Save “Board A” as a Waffle project?",detail:body("KiCad"),save:"Save as Waffle Project…",cancel:"Cancel"}},
      restored:{id:"import-2",sourceKey:"retained-key",hasFile:false,title:"Save “Recovered board” as a Waffle project?",duplicates:0,choice:"cancel"}});
    if (theme==="dark" && !touch) {
      const labels=await page.evaluate(async()=>{
        await AtriumI18n.setLocale("en-XA");
        return {source:AtriumI18n.t("import_save.source",{format:"KiCad"}),save:AtriumI18n.t("import_save.waffle"),
          title:AtriumI18n.t("import_save.question",{name:"Signal & Power"}),detail:AtriumI18n.t("import_save.detail",{format:"KiCad"})};
      });
      assert.notEqual(labels.save,"Save as Waffle Project…");
      assert.notEqual(labels.detail,body("KiCad"));
      await hint.getByText(labels.source,{exact:true}).waitFor();
      await hint.getByRole("button",{name:labels.save}).click();
      await page.getByRole("dialog",{name:labels.title}).getByText(labels.detail,{exact:true}).waitFor();
      await page.keyboard.press("Escape");assert.equal(await page.evaluate(()=>choice),"cancel");
      await page.evaluate(()=>AtriumI18n.setLocale("en"));
    }
    const closed=await page.evaluate(()=>{
      AtriumImportSaveView.clearHint();
      const surfaces=".import-save-hint,.import-save-sheet";
      const canvas=AtriumNavHost.canvas(), {left,top,width,height}=canvas.getBoundingClientRect();
      const onCanvas=document.elementFromPoint(left+width/2,top+height/2);
      return {hint:!!document.querySelector(".import-save-hint"),
        open:!!document.querySelector(".import-save-sheet[open]"),
        focusTrapped:!!document.activeElement.closest(surfaces),
        clickTrapped:!!onCanvas?.closest(surfaces)};
    });
    assert.deepEqual(closed,{hint:false,open:false,focusTrapped:false,clickTrapped:false});
    await requireClosedSheets(page);
    assert.equal(await page.locator(".import-save-hint,.import-save-sheet").count(),0);
    if (touch) assert.ok(await page.evaluate(()=>importSaveTouches.includes("button") && importSaveTouches.includes("checkbox")));
    assert.deepEqual(errors,[]);
    console.log(theme+" "+(touch?"touch":"desktop")+" imported Save, export report, native routing and keyboard focus");
  } finally {await page.close();}
}
async function firstImport(browser, theme, touch=false) {
  const page=await browser.newPage({viewport:touch?{width:390,height:760}:{width:1140,height:790},hasTouch:touch,isMobile:touch}),
    errors=[],requests=[],click=control=>touch?touchControl(page,control):control.click();
  page.setDefaultTimeout(10000);
  page.on("pageerror",error=>errors.push(error.message));page.on("request",req=>requests.push(req.url()));
  await page.addInitScript(()=>{
    window.Worker=new Proxy(window.Worker,{construct(target,args) {
      const worker=Reflect.construct(target,args);
      worker.addEventListener("message",({data})=>{
        const report=data?.value?.report;
        if(report?.direction==="export" && report.translator==="kicad") window.importSaveWriterKinds=report.kinds;
      });
      return worker;
    }});
  });
  try {
    await page.goto(app);
    const open=page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Import from Altium or KiCad…", exact:true});
    await open.waitFor();
    assert.ok(!requests.some(url=>/import-save-view\.(js|css)|import-export-browser\.js/.test(url)));
    await page.evaluate(theme=>AtriumTheme.set({preset:theme,followSystem:false,motion:"off"},{persist:false}),theme);
    const [picker]=await Promise.all([page.waitForEvent("filechooser"),click(open)]);
    await picker.setFiles(path.join(__dirname,"../fixtures/import/demo.kicad_pcb"));
    const hint=page.locator(".import-save-hint"), link=hint.getByRole("button",{name:"Save as Waffle Project…"});
    await hint.getByText("Imported from KiCad",{exact:true}).waitFor();
    assert.equal(await page.locator("dialog[open]").count(),0);
    await picture(page,theme,touch,"import-banner");
    const name=await page.evaluate(()=>AtriumNavHost.project().name);
    const first=page.getByRole("dialog",{name:"Save “"+name+"” as a Waffle project?"});
    await click(link);await first.getByText(body("KiCad"),{exact:true}).waitFor();await picture(page,theme,touch,"import-first-save");
    await page.keyboard.press("Escape");
    await requireClosedSheets(page);
    assert.ok(await link.evaluate(el=>el===document.activeElement));
    const file=page.locator('.menubar [data-menu="file"]');
    if (touch) await click(link);
    else if (theme==="dark") await page.keyboard.press("ControlOrMeta+s");
    else {await file.locator("summary").click();await file.locator('[data-action="save"]').click();}
    await click(first.getByRole("button",{name:"Export to KiCad…"}));
    const report=page.getByRole("dialog",{name:"Export “"+name+"” to KiCad"});
    await report.waitFor();
    const counts=await page.evaluate(()=>{
      const rows=window.importSaveWriterKinds.filter(row=>!row.references?.length ||
        row.references.some(ref=>ref.reason!=="Records written from this document."));
      const totals=["kept","approximated","dropped"].map(status=>rows.reduce((sum,row)=>sum+(row[status] || 0),0));
      return {totals,rows:rows.map(({kind,kept,approximated,dropped})=>({kind,kept,approximated,dropped}))};
    });
    assert.deepEqual(await report.locator("dd").allTextContents(),counts.totals.map(String));
    console.log("KiCad writer totals",counts.totals.join(" / "));
    assert.ok(counts.totals[0]>0,"the real export keeps design features");
    const group = name => report.locator("section").filter({has:page.getByRole("heading",{name,exact:true})});
    const kept = group("Kept"), converted = group("Converted"), lost = group("Lost");
    const omitted = "Graphic on unsupported layer Mechanical 15 omitted.";
    const keepout = "Keepout objects became KiCad keep-out rule areas.";
    assert.deepEqual(await lost.locator(".import-save-feature").allTextContents(),["Footprint graphic"]);
    assert.deepEqual(await lost.locator(".import-save-detail").allTextContents(),[omitted]);
    assert.equal(counts.totals[2],1);
    const keepoutRow = converted.locator("li").filter({has:page.getByText("Keepout",{exact:true})});
    assert.equal(await keepoutRow.locator(".import-save-count").textContent(),"×2");
    assert.equal(await keepoutRow.locator(".import-save-detail").textContent(),keepout);
    assert.equal(await converted.getByText(omitted,{exact:true}).count(),0);
    assert.equal(await converted.getByText("Component",{exact:true}).count(),0);
    assert.equal(await kept.locator("li").filter({has:page.getByText("Component",{exact:true})}).locator(".import-save-count").textContent(),"×3");
    assert.deepEqual(await page.evaluate(reason=>importSaveWriterKinds.find(row=>row.kind==="Footprint graphic")
      .references.filter(ref=>ref.reason===reason).map(({status,count})=>({status,count})),omitted),[{status:"dropped",count:1}]);
    const visibleTotals=await report.evaluate(dialog=>{
      const totals=dialog.querySelector(".import-save-totals").getBoundingClientRect();
      const details=dialog.querySelector(".import-save-report").getBoundingClientRect(),v=visualViewport;
      return totals.top>=v.offsetTop && totals.bottom<=details.top+1 && totals.bottom<=v.offsetTop+v.height &&
        totals.left>=v.offsetLeft && totals.right<=v.offsetLeft+v.width+1;
    });
    assert.ok(visibleTotals,"all three writer totals precede the scrollable details on the first presentation");
    if (capture && touch) await fs.writeFile(path.join(capture,"kicad-writer-counts.json"),JSON.stringify(counts,null,2)+"\n");
    assert.ok((await report.locator("li").count())>0);
    assert.ok(await report.locator("section").evaluateAll(groups=>groups.every(group=>group.querySelector("li"))));
    if (theme==="dark" && !touch) {
      const details=report.getByRole("region",{name:"Export “"+name+"” to KiCad"});
      await page.keyboard.press("Tab");
      assert.ok(await details.evaluate(el=>el===document.activeElement));
      if (await details.evaluate(el=>el.scrollHeight>el.clientHeight)) {
        await page.keyboard.press("End");
        await page.waitForFunction(()=>document.querySelector(".import-save-report").scrollTop>0);
        await page.keyboard.press("Home");
      }
    }
    await picture(page,theme,touch,"import-export-report");
    const lossReason = lost.getByText(omitted,{exact:true});
    await lossReason.scrollIntoViewIfNeeded();
    assert.ok(await lossReason.evaluate(el=>{
      const reason=el.getBoundingClientRect(), region=el.closest(".import-save-report").getBoundingClientRect();
      return reason.top>=region.top-1 && reason.bottom<=region.bottom+1;
    }),"the dropped feature and its note can be read under Lost");
    await picture(page,theme,touch,"import-export-report-loss");
    await page.keyboard.press("Escape");
    await requireClosedSheets(page);
    await click(link);await first.getByRole("button",{name:"Save as Waffle Project…"}).press("Enter");
    const portable=page.getByRole("dialog",{name:"Download “"+name+"” as a Waffle project ZIP?"});
    await portable.getByRole("button",{name:"Download Format 2 ZIP"}).waitFor();
    await picture(page,theme,touch,"import-portable");
    await page.keyboard.press("Escape");
    await requireClosedSheets(page);
    assert.ok(await link.isVisible());
    if (theme==="light" && !touch) {
      await click(link);
      await first.getByRole("button",{name:"Save as Waffle Project…",exact:true}).press("Enter");
      const [download] = await Promise.all([page.waitForEvent("download"),
        portable.getByRole("button",{name:"Download Format 2 ZIP",exact:true}).click()]);
      assert.match(download.suggestedFilename(),/\.zip$/i);
      const bytes = await fs.readFile(await download.path());
      const header = await page.evaluate(async data => {
        const archive = await AtriumLazy.need("AtriumProjectArchive");
        const zip = archive.zipDirectory(Uint8Array.from(atob(data),value=>value.charCodeAt(0)));
        const projects = await zip.projects();
        if (projects.length !== 1) throw Error("Expected one portable Waffle project.");
        const root = projects[0], manifest = await zip.read(root.prefix+root.manifest);
        return JSON.parse(new TextDecoder().decode(manifest).split("\n")[0]);
      },bytes.toString("base64"));
      assert.equal(header.kind,"project");
      assert.equal(header.formatVersion,"2.0");
      await requireClosedSheets(page);
      await page.waitForFunction(()=>AtriumNavHost.folderProject()?.temporary && !AtriumNavHost.importSession());
    }
    assert.deepEqual(errors,[]);
    console.log(theme+" "+(touch?"touch":"desktop")+" real KiCad picker, under-tab banner, Save, writer-derived report and portable choice");
  } finally {await page.close();}
}
module.exports=async browser=>{
  for(const [theme,touch] of [["light",false],["dark",false],["light",true]]) {
    await check(browser,theme,touch);await firstImport(browser,theme,touch);
  }
};
if (require.main===module) (async()=>{
  const browser=await require("playwright-core").chromium.launch(process.env.CHROME ?
    {executablePath:process.env.CHROME} : {channel:"chrome"});
  try {await module.exports(browser);} finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
