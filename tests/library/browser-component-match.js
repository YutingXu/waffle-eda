"use strict";
const assert=require("node:assert/strict"),path=require("node:path"),{pathToFileURL}=require("node:url");
module.exports=async function componentMatch(browser){
  const page=await browser.newPage({viewport:{width:1380,height:900}}),errors=[];
  page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(8000);
  try{
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name").filter({hasText:"Sensor board"}).waitFor();
    await page.evaluate(async()=>{
      await AtriumLazy.need(["AtriumECO","AtriumComponentMatch","AtriumPrefs"]);
      AtriumPrefs.set("schematic.afterUpdatePcb","stay");
      const p=Atrium.project("Review fixture",AtriumParts.catalogue),[sch,pcb]=p.documents;
      const part=(id,ref,x)=>({id,ref,x,y:10,kind:"part",value:"10k",def:"std-r",link:"copied",angle:0,pinNets:{1:"P",2:"GND"}});
      sch.items=[part("s1","R1",20),part("s2","R2",40)];pcb.items=[part("p1","R1",60),part("p2","R2",80)];
      sch.items[0].value="47k";
      globalThis.matchFixture={p,sch,pcb,reopen(doc){return AtriumECO.open({project:p,doc,info(){},edit:f=>f()});}};
      matchFixture.reopen(sch);
    });
    const dlg=page.getByRole("dialog",{name:"Engineering change order"}),rows=dlg.locator(".eco-matches tbody tr");
    const execute=dlg.locator(".eco-actions button").last();
    await rows.nth(1).waitFor();assert.ok(await execute.isDisabled());
    assert.doesNotMatch(await rows.first().locator("td").first().innerText(),/ mm\)/);
    assert.ok((await rows.first().locator("option").allTextContents()).every(label=>!label.includes(" mm)")));
    const colours=[];
    for(const preset of ["light","dark"]){
      await page.evaluate(preset=>AtriumTheme.set({preset,followSystem:false},{persist:false}),preset);
      await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,preset);
      colours.push(await rows.first().locator("button").evaluate(b=>getComputedStyle(b).getPropertyValue("--button").trim()));
    }
    assert.notEqual(colours[0],colours[1],"review buttons follow both theme palettes");
    const source=ref=>rows.filter({has:page.getByRole("combobox",{name:"Footprint for "+ref,exact:true})});
    const pair=async(ref,target)=>{
      const row=source(ref),pick=row.getByRole("combobox");await pick.selectOption(target);
      await row.getByRole("button").click();await row.getByRole("button",{name:"Confirmed"}).waitFor();
    };
    await pair("R1","p2");await pair("R2","");
    assert.ok(await execute.isDisabled());
    await dlg.getByRole("combobox",{name:"Unpaired footprint R1"}).selectOption("remove");
    await page.waitForFunction(()=>!document.querySelector(".eco-actions button:last-child").disabled);
    await execute.click();
    if(await execute.getAttribute("class").then(c=>c?.includes("is-armed")))await execute.click();
    await dlg.locator(".eco-report h3").waitFor();assert.deepEqual(await page.evaluate(()=>matchFixture.pcb.items.map(p=>[p.ref,p.value,p.id==="p2"]).sort()),[["R1","47k",true],["R2","10k",false]]);
    await page.keyboard.press("Escape");await dlg.waitFor({state:"hidden"});
    await page.evaluate(()=>matchFixture.reopen(matchFixture.pcb));await dlg.locator(".eco-matches summary").click();
    await dlg.getByText(/100%\s*Same component link/).first().waitFor();
    await page.keyboard.press("Escape");await dlg.waitFor({state:"hidden"});
    await page.evaluate(async()=>{
      await AtriumLazy.need("AtriumDiffView");
      const after=matchFixture.p,before=Atrium.clone(after);
      before.documents[0].items[0].ref="R22";
      await AtriumDiffView.start({project:before,label:"Before"},{project:after,label:"After"});
    });
    await page.getByRole("button",{name:"Component matches",exact:true}).click();
    await page.locator('.dv-pop[aria-label="Component matches"] table').waitFor();
    assert.ok(await page.locator('.dv-pop[aria-label="Component matches"] table').getByText("Same object ID").count()>=2);
    await page.keyboard.press("Escape");
    await page.locator('.dv-pop[aria-label="Component matches"]').waitFor({state:"hidden"});
    await page.evaluate(()=>AtriumDiffView.close());
    await page.evaluate(async()=>{
      const after=Atrium.clone(matchFixture.p), before=Atrium.clone(after);
      for(const [n,i] of before.documents[0].items.entries()) { i.id="old-"+n; i.link="copied"; }
      for(const i of after.documents[0].items) i.link="copied";
      await AtriumDiffView.start({project:before,label:"Before"},{project:after,label:"After"});
    });
    await page.getByRole("button",{name:/Component matches.*to review/}).click();
    const alternatives=page.locator('.dv-matches details').first();
    assert.equal(await alternatives.locator("li").count(),0);
    await alternatives.locator("summary").focus();await page.keyboard.press("Enter");
    await alternatives.locator("li").nth(1).waitFor();
    assert.ok(await page.locator(".dv-matches .is-review").getByText("Needs review").count());
    await page.keyboard.press("Escape");
    await page.evaluate(()=>AtriumDiffView.close());
    await page.evaluate(async()=>{
      const before=Atrium.project("Board translation",AtriumParts.catalogue), a=before.documents[1];
      a.outline=[[0,0],[20,0],[20,20],[0,20]];
      a.items=[[2,2],[10,3],[3,10]].map(([x,y],i)=>({kind:"part",id:"p"+i,ref:"R"+i,value:"10k",def:"std-r",link:"l"+i,x,y,angle:0,layer:"Top",pinNets:{}}));
      const after=Atrium.clone(before), b=after.documents[1];
      b.outline=b.outline.map(([x,y])=>[x+15,y+5]);
      for(const i of b.items){i.x+=15;i.y+=5;}
      await AtriumDiffView.start({project:before,label:"Before"},{project:after,label:"After"});
    });
    const motion=page.locator("summary").filter({hasText:/^Objects that moved with the board$/});
    await motion.waitFor();
    await motion.press("Enter");
    await page.locator("details[open]").filter({has:motion}).locator("li").filter({hasText:/\bR1\b/}).waitFor();
    assert.ok(await motion.evaluate(async summary => {
      // A previously queued partial refresh must not replace the completed inspector.
      await new Promise(resolve => setTimeout(resolve, 150));
      return summary.isConnected && summary.parentElement.open && document.activeElement === summary;
    }), "the completed comparison keeps its disclosure and keyboard focus");
    await page.evaluate(()=>AtriumDiffView.close());
    // Unique links can resolve two identically named symbols and footprints automatically.
    await page.evaluate(()=>{
      const f=matchFixture;
      f.sch.items.forEach((p,i)=>{p.ref="R5";p.link="unique-"+i;});
      f.pcb.items.forEach((p,i)=>{p.ref="R5";p.link="unique-"+i;});
      f.reopen(f.sch);
    });
    await dlg.locator(".eco-matches summary").click();
    await rows.nth(1).waitFor();
    for(const row of await rows.all()){
      assert.match(await row.locator("td").nth(0).innerText(),/R5.+ mm\)/);
      assert.match(await row.locator("td").nth(1).innerText(),/R5.+ mm\)/);
    }
    await page.keyboard.press("Escape");await dlg.waitFor({state:"hidden"});
    // A large ambiguous assignment uses the real worker, and a cancelled request returns no result.
    assert.ok(await page.evaluate(async()=>{
      const C=AtriumComponentMatch,d={id:"d",name:"Test",footprint:{name:"0603"}};
      const side=k=>Array.from({length:75},(_,i)=>C.describe({id:k+i,ref:"R?",value:"10k",pinNets:{"1":"GND"}},d));
      const run=()=>C.steps(side("a"),side("b"),{background:true});
      const m=await C.inSlices(run());
      let active=true;const again=C.inSlices(run(),()=>active);active=false;
      return await again===null && m.reviewSources.size===75 && AtriumWorkerPool.find("component-matching").stats().jobs>0;
    }));
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
};
