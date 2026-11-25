"use strict";
const assert=require("node:assert/strict"),{pathToFileURL}=require("node:url"),path=require("node:path");
const {chromium}=require("playwright-core");
async function main() {
  const browser=await chromium.launch({channel:"chrome",headless:true});
  try {
    for(const theme of ["light","dark"]) {
      const page=await browser.newPage({viewport:{width:1250,height:840},colorScheme:theme,reducedMotion:"reduce"});
      const errors=[];page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(8000);
      await page.goto(pathToFileURL(path.resolve(__dirname,"../../app/index.html")).href);
      assert.equal(await page.evaluate(()=>!!globalThis.AtriumQueryFields || !!globalThis.AtriumCalculationCore),false);
      await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
      await page.waitForFunction(()=>!!globalThis.AtriumNavHost?.doc());
      const longName="Manufacturer Package Compliance Threshold";
      await page.evaluate(async ({theme,longName})=>{
        await AtriumLazy.need(["AtriumUndoStore","AtriumTheme"]);AtriumTheme.setPreset(theme);
        const resistor={id:"rdef",prefix:"R",name:"Resistor",parameters:{Ripple:10,[longName]:25},symbol:{pins:[],shapes:[]}};
        const p=Atrium.project("Declaration bench",[resistor]),d=p.documents[0];d.items=[{id:"p1",kind:"part",ref:"R1",def:"rdef",value:"10k",x:2,y:2}];
        await AtriumNavHost.replaceProject(p,{force:true,dirty:false});AtriumNavHost.selectDocument(d.id);AtriumNavHost.select(["p1"]);
      },{theme,longName});
      const longUnit=page.getByRole("button",{name:"Unit for "+longName,exact:true});
      await longUnit.waitFor();
      // Measure the field the inspector settles on: the first selection's fields are replaced once their lazy controls attach.
      const layout=await (await page.waitForFunction(label=>{
        const button=[...document.querySelectorAll("#inspector button")].find(b=>b.getAttribute("aria-label")===label);
        if(!button?.isConnected || !button.getClientRects().length)return null;
        const name=button.previousElementSibling, value=button.parentElement.nextElementSibling;
        const labelBox=name.getBoundingClientRect(), buttonBox=button.getBoundingClientRect(), valueBox=value.getBoundingClientRect();
        return {unclipped:name.scrollWidth<=name.clientWidth+1, wraps:labelBox.height>1.5*parseFloat(getComputedStyle(name).lineHeight),
          distinct:buttonBox.top>=labelBox.bottom && buttonBox.right<=valueBox.left, border:parseFloat(getComputedStyle(button).borderTopWidth)};
      },"Unit for "+longName)).jsonValue();
      assert.ok(layout.unclipped && layout.wraps && layout.distinct && layout.border>=1,JSON.stringify(layout));
      const unit=page.getByRole("button",{name:"Unit for Ripple",exact:true});
      await unit.click();
      const editor=page.getByLabel("Library parameter Ripple unit");
      await editor.fill("badUnit");await editor.press("Enter");
      assert.equal(await editor.getAttribute("aria-invalid"),"true");
      await editor.fill("mV");await editor.press("Enter");
      await page.waitForFunction(()=>AtriumNavHost.project().library.find(d=>d.id==="rdef").parameters.Ripple.unit==="mV");
      assert.equal(await page.getByLabel("Ripple value").inputValue(),"10");
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      assert.equal(await page.evaluate(()=>AtriumNavHost.project().library.find(d=>d.id==="rdef").parameters.Ripple),10);
      await page.evaluate(async()=>{
        await AtriumLazy.need("AtriumQuery");AtriumQuery.toggle(true);
        const input=document.querySelector(".query-input"),h=AtriumNavHost;
        const ui=AtriumQueryFieldUI.attach(input,{project:h.project,host:h});
        input.value="resistor where power < 1m";ui.update({hints:[{code:"inferred-unit",field:"power",unit:"W",span:[23,25]}]},{kind:"resistor"});
      });
      assert.equal(await page.locator(".query-field-ghost").textContent(),"Power uses W");
      assert.equal(await page.locator(".query-input").inputValue(),"resistor where power < 1m");
      await page.evaluate(()=>{
        const input=document.querySelector(".query-input"),h=AtriumNavHost,def=h.project().library.find(d=>d.id==="rdef");
        input.value="part where Ripple < 10";AtriumQueryFieldUI.attach(input).update({hints:[{code:"declare-unit",field:"Ripple",span:[11,17]}]},{kind:"part",definition:def});
      });
      await page.getByRole("button",{name:"Declare unit for Ripple"}).click();
      const fix=page.getByLabel("Library parameter Ripple unit");await fix.fill("mV");await fix.press("Enter");
      assert.equal(await page.locator(".query-input").inputValue(),"part where Ripple < 10");
      assert.equal(await page.evaluate(()=>AtriumNavHost.project().library.find(d=>d.id==="rdef").parameters.Ripple.unit),"mV");
      const query=page.locator(".query-input");
      await page.evaluate(()=>{const input=document.querySelector(".query-input");
        input.value='part where designator = "r1"';const start=input.value.indexOf("r1");
        AtriumQueryFieldUI.attach(input).update({hints:[{code:"case-alternative",label:"Use R1",replacement:"R1",span:[start,start+2]}]});});
      assert.equal(await query.inputValue(),'part where designator = "r1"');
      await page.getByRole("button",{name:"Use R1",exact:true}).click();
      assert.equal(await query.inputValue(),'part where designator = "R1"');
      assert.deepEqual(errors,[]);await page.close();
      console.log("PASS "+theme+" actual Parameters declaration and Undo, Filter ghost and permission-limited source edit");
    }
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
