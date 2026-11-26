"use strict";
const assert=require("node:assert/strict"),path=require("node:path"),{pathToFileURL}=require("node:url");

// Welcome stays up while New, Open and Import wait on their prompt or file chooser, and a
// cancelled chooser leaves it as it was. Opening a multi-document project shows a determinate
// accent bar in the status bar that is gone once the project is open.
module.exports=async function welcomeOpen(browser){
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  const welcome=()=>page.evaluate(()=>!!document.querySelector("dialog.sp-dialog[open]"));
  const action=name=>page.locator(`dialog.sp-dialog[open] [data-start-action="${name}"]`);
  try{
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await action("import").waitFor();
    const status=await page.evaluate(()=>document.getElementById("status").textContent);
    for(const name of ["open","import"]){
      const choosing=page.waitForEvent("filechooser");
      await action(name).click();
      const chooser=await choosing;
      assert.equal(await welcome(),true,`${name}: Welcome stays up while the chooser is open`);
      await chooser.setFiles([]);
      assert.equal(await welcome(),true,`${name}: a cancelled chooser keeps Welcome`);
      assert.equal(await page.evaluate(()=>document.getElementById("status").textContent),status);
      assert.equal(await page.locator(".status-progress").count(),0);
    }
    await action("new").click();
    const prompt=page.locator('dialog[open] input[aria-label="New project"]');
    await prompt.waitFor();
    assert.equal(await welcome(),true,"New Project keeps Welcome behind its prompt");
    await page.keyboard.press("Escape");
    await prompt.waitFor({state:"detached"});
    assert.equal(await welcome(),true,"a cancelled New Project prompt keeps Welcome");

    await page.evaluate(()=>{globalThis.__progress=[];
      const probe=document.createElement("i");probe.style.color="var(--accent)";document.body.append(probe);
      const accent=getComputedStyle(probe).color;probe.remove();
      new MutationObserver(()=>{
      const n=document.querySelector(".status-progress");if(!n)return;
      const bar=n.getBoundingClientRect(),fill=getComputedStyle(n,"::before"),foot=document.querySelector("footer.statusbar").getBoundingClientRect();
      __progress.push({label:n.getAttribute("aria-label"),now:n.getAttribute("aria-valuenow"),max:n.getAttribute("aria-valuemax"),
        indeterminate:n.hasAttribute("data-indeterminate"),fill:Math.round(parseFloat(fill.width)*100)/100,width:bar.width,height:bar.height,top:bar.top,foot:foot.height,
        status:document.getElementById("status").textContent,color:fill.backgroundColor,
        accent,
        events:getComputedStyle(n).pointerEvents});
    }).observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});});
    const directory=path.join(__dirname,"../fixtures/altium/pidp11-io-expander");
    const choosing=page.waitForEvent("filechooser");
    await action("import").click();
    const chooser=await choosing;
    await chooser.setFiles(["PCB-PiDP11IOExpander.PrjPcb","PiDP11IOExpander.SchDoc","PiDP11IOExpander.PcbDoc"].map(n=>path.join(directory,n)));
    await page.waitForFunction(()=>globalThis.AtriumNavHost?.project().name==="PCB-PiDP11IOExpander",null,{timeout:30000});
    await page.waitForFunction(()=>!document.querySelector(".status-progress"));
    assert.equal(await welcome(),false,"Welcome closes once the project opens");
    const states=await page.evaluate(()=>__progress);
    assert.ok(states.length,"the status bar showed opening progress");
    const counted=states.filter(s=>!s.indeterminate);
    assert.ok(counted.length,"progress turns determinate once file counts are known");
    // The bar shows the whole open: reading files fills only the first part, later stages fill the
    // rest, and it never moves backwards (it used to sit at 100% once the files were read).
    let last=-1;
    for(const s of counted){
      assert.equal(s.max,"100");
      assert.equal(s.status,s.label);
      assert.ok(Number(s.now)>=last,"opening progress never moves backwards");last=Number(s.now);
      assert.ok(Math.abs(s.fill-s.width*Number(s.now)/100)<=1,"determinate fill matches the overall fraction");
      assert.equal(s.fill,Math.round(s.fill),"determinate fill is whole pixels");
    }
    const reading=counted.filter(s=>/^Opening PCB-PiDP11IOExpander… [1-3] of 3$/.test(s.label));
    assert.ok(reading.length,"file reading reports its counts");
    for(const s of reading)assert.ok(Number(s.now)<=55,"reading files fills only the first part of the bar, not all of it");
    assert.ok(counted.some(s=>!reading.includes(s)&&Number(s.now)>55),"the later stages of the open advance the bar");
    for(const s of states){
      assert.equal(s.color,s.accent,"the bar fills with the accent colour");
      assert.equal(s.foot,24);assert.equal(s.height,4);assert.equal(s.top,Math.round(s.top));assert.equal(s.events,"none");
    }
    const documentId = await page.evaluate(() => AtriumNavHost.currentId());
    const help = page.locator('details[data-menu="help"]');
    await help.locator("summary").click();
    await help.getByRole("menuitem", {name:"Customise Waffle",exact:true}).click();
    const setup = page.getByRole("dialog", {name:"Customise Waffle",exact:true});
    const finish = setup.getByRole("button", {name:"Finish setup",exact:true});
    await finish.waitFor();
    assert.equal(await setup.getByRole("navigation", {name:"Start",exact:true}).count(), 0,
      "Help opens setup without project navigation");
    await page.evaluate(() => AtriumNavHost.act("start-page"));
    await action("customise").click();
    const startSetup = page.locator("dialog.sp-dialog[open] .wl-panel");
    await startSetup.waitFor({timeout:3000});
    await setup.waitFor({state:"hidden"});
    assert.equal(await startSetup.locator(".wl-head:focus").count(), 1, "setup focus follows the Start Page");
    await startSetup.getByRole("button", {name:"Finish setup",exact:true}).click();
    await startSetup.waitFor({state:"detached"});
    await page.keyboard.press("Escape");
    assert.equal(await welcome(),false,"closing Start returns to the project");
    assert.equal(await page.evaluate(() => AtriumNavHost.currentId()), documentId);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
};
