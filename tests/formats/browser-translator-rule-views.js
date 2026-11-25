"use strict";
const assert=require("node:assert/strict"), path=require("node:path"), {pathToFileURL}=require("node:url");

const startup=page=>page.locator("dialog.sp-dialog[open]");
const editor=page=>page.getByRole("dialog",{name:"Rules and Constraints Editor",exact:true});
async function openRules(page){
  const item=page.locator('details[data-menu="design"]');
  await item.locator(":scope > summary").click();
  await item.getByRole("menuitem",{name:"Rules…",exact:true}).click();
}
// A narrow Messages dock (the right dock) folds its header actions into ⋯ More actions (messages.js).
async function messageAction(page,label){
  const panel=page.locator(".msg-panel").filter({has:page.locator(".msg-extra > button",{hasText:label})});
  const inline=panel.locator(".msg-extra > button",{hasText:label});
  if(await inline.isVisible())return inline.click();
  await panel.getByRole("button",{name:"More actions",exact:true}).click();
  await page.getByRole("menuitem",{name:label,exact:true}).click();
}
async function stepHistory(page,redo=false){
  const primary=await page.evaluate(()=>AtriumKeymap.mac?"Meta":"Control");
  await page.locator("#canvas").focus();
  await page.keyboard.press(primary+(redo?"+Shift+Z":"+Z"));
}

async function chooseFile(page,trigger,file,extension){
  // Give the actual click time to report its actionability failure before an event timeout.
  const [picker]=await Promise.all([page.waitForEvent("filechooser",{timeout:17000}),trigger.click({timeout:15000})]);
  assert.ok((await picker.element().getAttribute("accept")).toLowerCase().split(",").includes(extension));
  await picker.setFiles(file);
}

async function eagleRules(browser){
  const page=await browser.newPage({viewport:{width:1440,height:960},reducedMotion:"reduce"});
  const errors=[];page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(15000);
  try {
    const fixture=path.join(__dirname,"../fixtures/import/demo-eagle.brd");
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await chooseFile(page,startup(page).getByRole("button",{name:"Open…",exact:true}),fixture,".brd");
    const report=page.getByRole("article",{name:"Import fidelity report",exact:true});
    const params=report.getByRole("row").filter({has:page.getByRole("rowheader",{name:"Param",exact:true})});
    await params.waitFor();
    assert.deepEqual((await params.getByRole("cell").allTextContents()).slice(0,3),["2","7","1"]);
    // The references open in a full-width row below (import-reports.js), so the columns keep their widths.
    await params.locator("summary").click();
    await report.getByRole("cell",{name:"Param source references",exact:true}).getByText(/Approximated · demo-eagle\.brd · <param> at character 2324 — Pair-specific rules contribute to one native clearance/).waitFor();

    const read=()=>page.evaluate(()=>{
      const project=AtriumNavHost.project(), board=project.documents.find(d=>d.kind==="pcb");
      const {defaults,nets}=AtriumRules.stored(board,project);
      return {book:project.rules,defaults,nets};
    });
    const before=await read();
    assert.deepEqual(before.defaults,{clearance:.2032,trackWidth:.254,viaDrill:.35});
    assert.deepEqual(before.nets,{GND:{clearance:.3,trackWidth:.5,viaDrill:.4}});
    await openRules(page);
    const rules=editor(page), defaults={...before.defaults,trackWidth:.31};
    await chooseFile(page,rules.getByRole("button",{name:"Import rules",exact:true}),
      {name:"Workshop.waffle-rules",mimeType:"application/json",buffer:Buffer.from(JSON.stringify({
        format:"atrium-rules",version:1,units:"mm",defaults,nets:before.nets
      }))},".waffle-rules");
    await rules.getByRole("status").filter({hasText:/Imported Workshop\.waffle-rules/}).waitFor();
    assert.deepEqual(await read(),before);
    await rules.getByRole("button",{name:"OK",exact:true}).click();
    await rules.waitFor({state:"hidden"});
    const changed=await read();
    assert.deepEqual(changed.defaults,defaults);
    assert.deepEqual(changed.nets,before.nets);
    await stepHistory(page);
    assert.deepEqual(await read(),before);
    assert.deepEqual(errors,[]);
    console.log("PASS EAGLE board chooser, source rule fidelity, native rule-file import and one Undo");
  } finally {await page.close();}
}

// Open the licensed board through the File chooser. The imported rule rows
// belong to the current file session; Apply and Undo change the native book.
module.exports=async function sourceRuleViews(browser){
  const fixture=path.join(__dirname,"../fixtures/altium/pidp11-io-expander/PiDP11IOExpander.PcbDoc");
  for(const theme of ["light","dark"]){
    const page=await browser.newPage({viewport:{width:1440,height:960},colorScheme:theme,reducedMotion:"reduce"});
    const errors=[];page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(15000);
    try{
      await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
      await page.evaluate(theme=>AtriumTheme.set({preset:theme,followSystem:false},{persist:false}),theme);
      // This view tests the Ask flow; the default (use) is covered in tests/import-rules.cjs.
      await page.evaluate(async()=>{const P=globalThis.AtriumPrefs||await AtriumLazy.need("AtriumPrefs");P.set("pcb.importRules","ask");});
      await chooseFile(page,startup(page).getByRole("button",{name:"Import from Altium or KiCad…",exact:true}),fixture,".pcbdoc");
      await page.waitForFunction(()=>globalThis.AtriumImportRules?.pending(AtriumNavHost.project()).some(r=>r.count===41));
      const check=()=>page.evaluate(()=>{
        const project=AtriumNavHost.project(),board=project.documents.find(d=>d.kind==="pcb");
        const view=AtriumImportReports.sourceDocument(board), rows=view.sourceRules.map(AtriumAltiumRules.describe);
        const width=rows.find(r=>r.name==="Width_1A");
        return {count:rows.length,scope:width?.first,priority:width?.priority,clean:!("sourceRules" in board)&&!("sourceClasses" in board),
          adopted:board.appliedSourceRuleRecords?.length||0,linked:project.rules?.list.filter(r=>r.origin?.board===board.id).length||0,
          checks:!!board.ruleCheckSelection};
      });
      const kept={count:41,scope:"InNetClass('1A')",priority:"1",clean:true,adopted:0,linked:0,checks:false};
      assert.deepEqual(await check(),kept);
      await page.locator(".msg-panel .msg-extra > button",{hasText:"Use the board's rules"}).waitFor({state:"attached"});
      if(theme==="light"){
        await messageAction(page,"Keep Waffle defaults");
        assert.deepEqual(await check(),kept);
        await openRules(page);
        await editor(page).getByRole("treeitem",{name:/^Altium Source Rules\b/}).click();
      }else{
        await messageAction(page,"Review…");
      }
      const rules=editor(page);
      await rules.getByRole("searchbox",{name:"Find Altium rules"}).fill("Width_1A");
      const sourceRow=rules.locator("details.source-rule").filter({hasText:"Width_1A"});
      await sourceRow.locator("summary").first().click();
      assert.ok((await sourceRow.innerText()).includes("InNetClass('1A')"));
      await sourceRow.getByText("Source fields",{exact:true}).click();
      await sourceRow.getByText("PREFEREDWIDTH",{exact:true}).waitFor();
      if(theme==="light"){
        await rules.getByRole("button",{name:"Replace with supported rules",exact:true}).click();
        await rules.getByRole("button",{name:"OK",exact:true}).click();
      }else{
        await rules.getByRole("button",{name:"Close",exact:true}).click();
        await rules.waitFor({state:"hidden"});
        await messageAction(page,"Use the board's rules");
      }
      await rules.waitFor({state:"hidden"});
      assert.deepEqual(await check(),{...kept,adopted:28,linked:28,checks:true});
      assert.equal(await page.evaluate(async()=>{
        await AtriumLazy.need("AtriumConnectivity");
        const p=AtriumNavHost.project(),b=p.documents.find(d=>d.kind==="pcb"),defs=AtriumNavHost.defs();
        return AtriumRules.drc(b,defs,AtriumRules.stored(b,p),{project:p,connections:()=>AtriumConnectivity.inspect(b,defs)}).total;
      }),2,"the same two stub-track findings occur under the board's own rules");
      await stepHistory(page);
      assert.deepEqual(await check(),kept);
      await stepHistory(page,true);
      assert.deepEqual(await check(),{...kept,adopted:28,linked:28,checks:true});
      const replacement=await page.evaluate(()=>{
        const board=AtriumNavHost.project().documents.find(d=>d.kind==="pcb");
        return AtriumAltiumRules.write(AtriumImportReports.sourceDocument(board).sourceRules.filter(line=>["Width_1A","BoardOutlineClearance"].includes(AtriumAltiumRules.describe(line).name)));
      });
      await openRules(page);
      const trigger=rules.getByRole("button",{name:"Import rules",exact:true});
      await trigger.waitFor();
      if(theme==="dark") await openRules(page);
      await chooseFile(page,trigger,{name:"Selected.RUL",mimeType:"application/octet-stream",buffer:Buffer.from(replacement)},".rul");
      await rules.getByRole("status").filter({hasText:/2 source rules loaded/}).waitFor();
      assert.equal(await page.getByRole("tab",{name:"Rules and Constraints",exact:true}).count(),1);
      assert.deepEqual(await check(),{...kept,adopted:28,linked:28,checks:true});
      await rules.getByRole("button",{name:"OK",exact:true}).click();
      await rules.waitFor({state:"hidden"});
      assert.deepEqual(await check(),{...kept,count:2,adopted:2,linked:2,checks:true});
      assert.equal(await page.evaluate(()=>AtriumNavHost.project().documents.find(d=>d.kind==="pcb").sourceRulesReplaced),true);
      await stepHistory(page);
      assert.deepEqual(await check(),{...kept,adopted:28,linked:28,checks:true});
      assert.equal(await page.evaluate(()=>AtriumNavHost.project().documents.find(d=>d.kind==="pcb").sourceRulesReplaced),undefined);
      assert.deepEqual(errors,[]);
      console.log("PASS "+theme+" imported rule views, source scopes, Apply and Undo");
    }finally{await page.close();}
  }
  await eagleRules(browser);
};
