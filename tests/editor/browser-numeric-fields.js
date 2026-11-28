"use strict";
const assert=require("node:assert/strict"),path=require("node:path");
const {pathToFileURL}=require("node:url"),{chromium}=require("../support/playwright.cjs");
async function run() {
  const browser=await chromium.launch({channel:"chrome",headless:true});
  const themes=process.env.WAFFLE_NUMERIC_THEME?[process.env.WAFFLE_NUMERIC_THEME]:["light","dark"];
  try {
    for(const theme of themes) {
      const page=await browser.newPage({viewport:{width:1280,height:850},reducedMotion:"reduce",colorScheme:theme});
      page.setDefaultTimeout(8000);
      const pageErrors=[];page.on("pageerror",e=>pageErrors.push(e.message));
      await page.clock.install();
      await page.addInitScript(()=>{globalThis.ATRIUM_UNDO_VERIFY="throw";});
      await page.goto(pathToFileURL(path.resolve(__dirname,"../../app/index.html")).href);
      assert.equal(await page.evaluate(()=>!!globalThis.AtriumNumericFields || !!globalThis.AtriumCalculationCore),false);
      await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
      await page.waitForFunction(()=>!!globalThis.AtriumNavHost?.doc());
      await page.evaluate(async theme=>{
        await AtriumLazy.need(["AtriumUndoStore","AtriumTheme","AtriumConnectionPreview","AtriumInsightsUI"]);AtriumTheme.setPreset(theme);
        AtriumPref.set("labs.notebook",true);
        const resistor={id:"res",name:"Resistor",category:"Resistors",prefix:"R",symbol:{pins:[],shapes:[]}};
        const project=Atrium.project("Numeric fields",[resistor]),sheet=project.documents[0];sheet.id="s";sheet.grid=1;
        sheet.items=[{id:"r5",kind:"part",def:"res",ref:"R5",value:"10k",x:2,y:3},
          {id:"r7",kind:"part",def:"res",ref:"R7",value:"1k",x:10,y:10}];
        await AtriumNavHost.replaceProject(project,{force:true,dirty:false});AtriumNavHost.selectDocument("s");AtriumNavHost.select(["r7"]);
      },theme);
      const x=page.locator('#inspector input[aria-label^="X ("]').first(),source=page.getByRole("textbox",{name:"Comment",exact:true});
      await x.waitFor();
      const snap=()=>page.evaluate(()=>({h:AtriumNavHost.undoSteps().history.length,f:AtriumNavHost.undoSteps().future.length,x:AtriumNavHost.doc().items.find(i=>i.id==="r7")?.x,active:document.activeElement?.outerHTML.slice(0,95)}));
      assert.equal(await page.evaluate(()=>AtriumPref.get("butter.numericFields") === true),false);
      await x.focus();
      await page.waitForFunction(()=>!!globalThis.AtriumNumericFields);
      await x.evaluate(input=>{
        window.numericTrustedKeystrokes=0;
        document.addEventListener("input",event=>{
          if (event.isTrusted && event.target.id===input.id &&
              event.target.getAttribute("aria-label")===input.getAttribute("aria-label")) window.numericTrustedKeystrokes++;
        },true);
        input.focus();
        input.select();
      });
      await x.pressSequentially("10mil + 0.1mm");
      assert.equal(await x.inputValue(),"10mil + 0.1mm");
      assert.equal(await page.evaluate(()=>window.numericTrustedKeystrokes),13);
      await x.press("Enter");
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").x===.354);
      assert.equal(await page.locator(".numeric-field-preview,.numeric-field-chip").count(),0);
      assert.equal(await page.locator('link[href$="/numeric-fields.css"]').count(),0);
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").x===10);
      assert.equal(await page.evaluate(()=>!!AtriumKeymap.command("butter.numericFields.evaluate")),false);
      const broker=await page.evaluate(async()=>{
        await AtriumLazy.need("AtriumPrefs");
        AtriumPrefs.set("butter.numericFields",true);
        await AtriumLazy.need("AtriumButterEditor");
        const target={scope:"item",documentId:"s",itemId:"r7",path:["x"]};
        const commands=["evaluate","inspect","set","clear"].map(id=>!!AtriumKeymap.command("butter.numericFields."+id));
        const measured=await AtriumButter.run("butter.numericFields.evaluate", {source:"10mil + 0.1mm",target});
        const macro=await AtriumButter.run("butter.numericFields.set", {source:"0.425 mm",target},{source:"macro",mode:"plan"});
        const before=AtriumNavHost.doc().items.find(i=>i.id==="r7").x;
        const applied=await AtriumButterEditor.apply("butter.numericFields.set",{source:"0.425 mm",target});
        return {commands,measured:measured.result.value,plan:macro.changes,applied:applied.changes,before};
      });
      assert.deepEqual(broker,{commands:[true,true,true,true],measured:.354,plan:1,applied:1,before:10});
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").x===.425);
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").x===10);
      const before=await snap();
      await x.fill("10mil + 0.1mm");
      await page.waitForFunction(()=>document.querySelector("#inspector .numeric-field-preview")?.textContent.includes("0.354"));
      assert.equal(await x.inputValue(),"10mil + 0.1mm");
      await x.press("Enter");
      const item=(k,id="r7")=>page.evaluate(([id,k])=>AtriumNavHost.doc().items.find(i=>i.id===id)[k],[id,k]);
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").x===.354);
      assert.equal((await snap()).h,before.h+1);
      await page.evaluate(()=>AtriumNavHost.act("undo"));await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").x===10);
      await page.evaluate(()=>AtriumNavHost.act("redo"));await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").x===.354);
      await x.fill("=1 V");await x.press("Enter");
      await page.waitForFunction(()=>document.querySelector('#inspector input[aria-label^="X ("]')?.getAttribute("aria-invalid")==="true");
      assert.equal(await x.getAttribute("data-error-start"),"1");assert.equal(await item("x"),.354);
      await x.press("Escape");
      await page.evaluate(async()=>{
        const h=AtriumNavHost,r=h.doc().items.find(i=>i.id==="r5");
        h.select([]);
        const target={scope:"item",documentId:"s",itemId:"r7",path:["value"]};
        const applied=await AtriumButterEditor.apply("butter.numericFields.set",{source:"= R5.Value",target});
        if(!applied.result.ok)throw Error(applied.result.diagnostic.message);
        h.edit(()=>{r.value="22k";},"Edit source without selecting target",[r]);
      });
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").value==="22000");
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").value==="10000");
      await page.evaluate(()=>{AtriumNavHost.act("undo");AtriumNavHost.select(["r7"]);});
      await source.fill("10k ±1%");await source.press("Tab");
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").value==="10k ±1%");
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      await source.fill("47 kΩ");await source.press("Tab");
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").value==="47 kΩ");
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").value==="1k");
      await source.fill("= R5.Value");await source.press("Enter");
      await page.waitForFunction(()=>AtriumNavHost.project().numericExpressions?.length===1);
      assert.equal(await item("value"),"10000");
      await page.getByRole("button",{name:/Edit live expression/}).waitFor();
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").value==="1k");assert.equal(await page.evaluate(()=>AtriumNavHost.project().numericExpressions?.length || 0),0);
      await page.evaluate(()=>AtriumNavHost.act("redo"));
      await page.waitForFunction(()=>AtriumNavHost.project().numericExpressions?.length===1);
      await page.evaluate(()=>{const h=AtriumNavHost,r=h.doc().items.find(i=>i.id==="r5");h.edit(()=>{r.ref="R8";r.value="22k";},"Change source",[r]);});
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").value==="22000");
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").value==="10000");
      assert.equal(await item("ref","r5"),"R5");
      const idle=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
      await idle();const scans=await page.evaluate(()=>AtriumNumericFields.stats(AtriumNavHost).evaluations);
      await page.evaluate(()=>{const h=AtriumNavHost,i=h.doc().items.find(r=>r.id==="r7");h.edit(()=>{i.x=3;},"Unrelated position",[i]);});
      await idle();assert.equal(await page.evaluate(()=>AtriumNumericFields.stats(AtriumNavHost).evaluations),scans);
      await page.evaluate(()=>{const h=AtriumNavHost,d=h.doc(),i=d.items.find(r=>r.id==="r5");
        h.edit(()=>{d.items.splice(d.items.indexOf(i),1,{...i,id:"other-r5",value:"99k"});},"Replace reference");});
      await page.waitForFunction(()=>{const h=AtriumNavHost,e=h.project().numericExpressions?.[0];return e && AtriumNumericFields.issue(h.project(),e.target)?.code==="missing";});
      assert.equal(await item("value"),"10000");
      assert.ok(await page.locator("#inspector .numeric-field-preview.is-error").count());
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      await page.waitForFunction(()=>{const h=AtriumNavHost,e=h.project().numericExpressions?.[0];return e && !AtriumNumericFields.issue(h.project(),e.target);});
      await page.evaluate(async()=>{await AtriumLazy.need("AtriumKeymapPresets");await AtriumLazy.need("AtriumCommandBar");AtriumCommandBar.show();});
      const command=page.getByRole("textbox",{name:"Command",exact:true});
      await command.fill("x 10mil + 0.1mm, 2 mm");await command.press("Enter");
      await page.waitForFunction(()=>document.querySelector(".cmdbar-note")?.textContent.includes("0.354 mm, 2 mm"));
      await command.fill("ix 1 V");await command.press("Enter");
      await page.waitForFunction(()=>document.querySelector(".cmdbar-input")?.getAttribute("aria-invalid")==="true");
      assert.equal(await command.inputValue(),"ix 1 V");
      await command.press("Escape");
      assert.equal(await page.evaluate(()=>!!globalThis.AtriumDesignQuery),false);
      await x.fill("count(part) * 0.1 mm");await x.press("Enter");
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").x===.2);
      assert.equal(await page.evaluate(()=>!!globalThis.AtriumDesignQuery),true);
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      const cycle=await page.evaluate(async()=>{
        const h=AtriumNavHost,project=h.project(),r7=h.doc().items.find(i=>i.id==="r7");
        const target={scope:"item",documentId:"s",itemId:"r7",path:["value"]};
        const before=r7.value,entries=project.numericExpressions.length;
        const applied=await AtriumButterEditor.apply("butter.numericFields.set",{source:"=count(part where value < 5 kΩ) * 10 kΩ + 1 kΩ",target});
        return {code:applied.result.diagnostic?.code,unchanged:r7.value===before && project.numericExpressions.length===entries};
      });
      assert.deepEqual(cycle,{code:"cycle",unchanged:true});
      const indirect=await page.evaluate(async()=>{
        const target={scope:"item",documentId:"s",itemId:"r5",path:["value"]};
        const applied=await AtriumButterEditor.apply("butter.numericFields.set",{
          source:'=count(part where designator = "R7" and value < 5 kΩ) * 10 kΩ + 1 kΩ',target});
        return applied.result.diagnostic?.code;
      });
      assert.equal(indirect,"cycle");
      await x.fill("=count(part where value < 5 kΩ) * 0.1 mm");await x.press("Enter");
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").x===0);
      await page.evaluate(()=>{const h=AtriumNavHost,r=h.doc().items.find(i=>i.id==="r5");h.edit(()=>{r.value="2k";},"Move source below threshold",[r]);});
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").x===.2);
      await idle();const stabilized=await page.evaluate(()=>AtriumNumericFields.stats(AtriumNavHost).evaluations);
      await page.clock.runFor(650);
      assert.equal(await page.evaluate(()=>AtriumNumericFields.stats(AtriumNavHost).evaluations),stabilized);
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r7").x===0);
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      const oldGrid=await page.evaluate(()=>AtriumNavHost.doc().grid);
      await page.evaluate(()=>AtriumNavHost.executeKey("grid-custom"));
      const grid=page.getByRole("dialog",{name:"Schematic snap grid"});
      await grid.getByLabel(/Custom grid spacing/).fill("=2mil + 0.1mm");
      await grid.getByRole("button",{name:"Apply"}).click();
      await page.waitForFunction(()=>AtriumNavHost.doc().grid===.1508);
      assert.equal(await page.evaluate(()=>AtriumNavHost.project().numericExpressions.find(e=>e.target.path[0]==="grid")?.source),"2mil + 0.1mm");
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      await page.waitForFunction(grid=>AtriumNavHost.doc().grid===grid,oldGrid);
      const calcId=await page.evaluate(async()=>{
        await AtriumLazy.need(["AtriumSheetWidgetEditor","AtriumCalc"]);
        const h=AtriumNavHost,i=AtriumSheetWidgets.make("calculator",[15,25],{calculator:"voltage_divider"});
        h.edit(()=>h.doc().items.push(i),"Place calculator");AtriumSheetWidgetEditor.open(i.id,h);return i.id;
      });
      const widget=page.locator(".sw-editor"),volts=widget.getByLabel("Input voltage (V)");
      await volts.focus();await volts.fill("500 mV + 1 V");
      await widget.getByRole("status").filter({hasText:"1.5 V"}).first().waitFor();
      await volts.press("Enter");
      await page.waitForFunction(id=>AtriumNavHost.doc().items.find(i=>i.id===id)?.widget.state.vin===1.5,calcId);
      await widget.getByRole("button",{name:"Done"}).click();
      await page.evaluate(async()=>{
        const h=AtriumNavHost;await AtriumLazy.need(["AtriumProjectRules","AtriumRules"]);
        const board=h.project().documents.find(d=>d.kind==="pcb");h.selectDocument(board.id);h.act("rules");
      });
      const rules=page.getByRole("dialog",{name:"Rules and Constraints Editor"});
      await rules.locator('[data-key^="rule:"]').filter({hasText:/^Clearance$/}).first().click();
      const gap=rules.getByLabel(/^Minimum clearance \(/);
      await gap.fill("=10mil + 0.1mm");await rules.getByRole("button",{name:"OK",exact:true}).click();
      await page.waitForFunction(()=>AtriumNavHost.project().numericExpressions?.some(e=>e.target.scope==="rule"));
      assert.ok(await page.evaluate(()=>AtriumNavHost.project().rules.list.some(r=>r.type==="clearance" && r.gap===.354)));
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      await page.waitForFunction(()=>!AtriumNavHost.project().numericExpressions?.some(e=>e.target.scope==="rule"));
      await page.evaluate(()=>{
        const h=AtriumNavHost;
        h.edit(()=>h.doc().items.push({kind:"pad",id:"field-pad",x:5,y:5,w:1,h:1,shape:"round",layer:"Top"}),"Place pad");
        h.select(["field-pad"]);
      });
      const padWidth=page.getByRole("textbox",{name:/^X size/}),padHole=page.getByRole("textbox",{name:/^Hole/});
      await padWidth.fill("=2*h");await padWidth.press("Enter");
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="field-pad").w===2);
      assert.ok(await page.evaluate(()=>AtriumNavHost.project().numericExpressions.some(e=>e.target.itemId==="field-pad" && e.target.path[0]==="w")));
      await padHole.fill("=3 mm");await padHole.press("Enter");
      await page.waitForFunction(()=>{const pad=AtriumNavHost.doc().items.find(i=>i.id==="field-pad");return pad.drill===1 && pad.layer==="Multi";});
      await padHole.focus();await padHole.fill("0 mm");await padHole.press("Enter");
      await page.waitForFunction(()=>{const pad=AtriumNavHost.doc().items.find(i=>i.id==="field-pad");return pad.drill===undefined && pad.layer==="Top";});
      // A module that arrives in the background (here rich PCB text, which the board requests on first
      // draw) does not rebuild Properties under a draft: the field, its text and its caret stay until focus leaves.
      await padWidth.focus();await padWidth.fill("3 mm");
      const draft=await padWidth.evaluate(input=>{window.draftField=input;AtriumNavHost.moduleLoaded("AtriumPCBTextRich");
        return {same:document.activeElement===input && input.isConnected,value:input.value,caret:input.selectionStart};});
      assert.deepEqual(draft,{same:true,value:"3 mm",caret:4},"a background module load keeps the field being typed in");
      await padWidth.press("Escape");
      await page.locator("#canvas").focus();
      await page.waitForFunction(()=>!window.draftField.isConnected); // the held rebuild runs once focus leaves Properties
      assert.equal(await page.evaluate(()=>AtriumNavHost.doc().items.find(i=>i.id==="field-pad").w),2,"Escape discarded the draft");
      // A length typed under a held rebuild commits when focus leaves at once, before the calculation answers:
      // the held rebuild waits for that commit instead of replacing the field under it.
      await padWidth.focus();await padWidth.fill("3 mm");
      await padWidth.evaluate(()=>AtriumNavHost.moduleLoaded("AtriumPCBTextRich"));
      await page.locator("#canvas").focus();
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="field-pad").w===3,null,{timeout:5000})
        .catch(()=>assert.fail("a length committed on blur under a held rebuild was dropped"));
      await padWidth.focus();await padWidth.fill("2 mm");await padWidth.press("Enter");
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="field-pad").w===2);
      await page.evaluate(()=>{
        const h=AtriumNavHost;
        h.edit(()=>{
          h.doc().items.push({kind:"track",id:"width-a",layer:"Top",width:.2,points:[[4,10],[5,10]]},
            {kind:"track",id:"width-b",layer:"Top",width:.3,points:[[9,10],[10,10]]});
        },"Place tracks");
        h.select(["width-a","width-b"]);
      });
      const shared=page.getByRole("textbox",{name:"Width",exact:true});
      await shared.fill("10mil + 0.1mm");await shared.press("Enter");
      await page.waitForFunction(()=>AtriumNavHost.doc().items.filter(i=>i.id.startsWith("width-")).every(i=>i.width===.354));
      await page.evaluate(async()=>{await AtriumLazy.need("AtriumGuides");AtriumNavHost.act("make-row");});
      const pitch=page.getByRole("textbox",{name:"Row pitch",exact:true});
      await pitch.fill("1 mm + 1 mm");await pitch.press("Enter");
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="width-b").points[0][0]===6);
      const manifest={id:"test.numeric-form",name:"Numeric form fixture",publisher:"Fixture",version:"1.0.0",apiVersion:1,main:"main.js",
        description:"A deterministic numeric form.",activationEvents:["onCommand:numbers.open"],permissions:["ui:panel","ui:command"],
        contributes:{commands:[{command:"numbers.open",title:"Open numeric form"},{command:"numbers.accept",title:"Accept numeric form"}],
          panels:[{id:"numericForm",title:"Numeric form fixture",location:"dialog"}]}};
      const main=`exports.activate=api=>{
        api.commands.register("numbers.open",async()=>{await api.ui.showPanel("numericForm");return api.ui.setPanel("numericForm",[{type:"form",
          fields:[{key:"supply",label:"Fixture voltage",type:"number",unit:"V",value:2,required:true}],submit:{label:"Evaluate numeric form",command:"numbers.accept"}}]);});
        api.commands.register("numbers.accept",values=>api.ui.setPanel("numericForm",[{type:"text",text:"Received "+typeof values.supply+" "+values.supply}]));
      };`;
      await page.evaluate(async()=>{await AtriumLazy.need("AtriumExtensions");});
      const install=page.evaluate(files=>AtriumExtensions.install(files).then(r=>r.id),{"waffle-extension.json":JSON.stringify(manifest),"main.js":main});
      await page.getByRole("button",{name:"Install",exact:true}).click();await install;
      await page.evaluate(()=>AtriumExtensions.execute("numbers.open"));
      const ext=page.getByLabel("Fixture voltage");await ext.focus();await ext.fill("R5.Value");
      await page.getByRole("button",{name:"Evaluate numeric form"}).click();
      await page.waitForFunction(()=>document.querySelector(".ext-form input")?.getAttribute("aria-invalid")==="true");
      assert.match(await page.locator(".ext-form").innerText(),/cannot read design fields/);
      await ext.fill("500 mV + 1 V");await page.getByRole("button",{name:"Evaluate numeric form"}).click();
      try{await page.getByText("Received number 1.5",{exact:true}).waitFor();}catch(e){
        console.error(await page.locator(".ext-form").count()?await page.locator(".ext-form").innerText():"submitted",
          await page.evaluate(()=>[AtriumExtensions._panel("test.numeric-form","numericForm"),AtriumExtensions.logs("test.numeric-form"),
            [...document.querySelectorAll(".ext-form input")].map(i=>[i.value,i.type,i.validationMessage])]),pageErrors);throw e;}
      assert.deepEqual(pageErrors,[]);
      await page.close();
      console.log("PASS "+theme+" numeric Properties, inline previews/errors, Undo/Redo, binding updates and cycles, geometry and placement dialogs, rules, widgets and extension forms");
    }
  } finally {await browser.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
