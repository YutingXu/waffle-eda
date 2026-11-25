"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs");
const {boot, run} = require("../support/butter-design.cjs");
const source = __dirname + "/../../extensions/developer/motion-inspector/";
const manifest = JSON.parse(fs.readFileSync(source + "waffle-extension.json","utf8")), id = manifest.id;
const bundle = process.env.WAFFLE_MOTION_EXTENSION ? fs.readFileSync(process.env.WAFFLE_MOTION_EXTENSION)
  : Buffer.from(JSON.stringify({manifest, files:{"main.js":fs.readFileSync(source + "main.js","utf8")}}));

run("motion", async ({browser, profile, shot}) => {
  const viewport = process.argv.includes("--compact") ? {width:760,height:520} : profile.viewport;
  const {page, errors} = await boot(browser, {...profile, viewport});
  const worker = () => page.evaluate(id=>AtriumExtensions.workers.some(w=>w.pool==="ext:"+id),id);
  const manager = page.getByRole("dialog",{name:"Extensions",exact:true});
  const inspector = page.locator('dialog.ext-dialog[data-extension="' + id + '"]');
  const open = () => page.evaluate(()=>AtriumKeymap.command("motion-inspector.open").run());
  const manage = async (select = true) => {
    await page.evaluate(async()=>{(await AtriumLazy.need("AtriumExtensions")).openManager();});
    if (select) await manager.locator(".ext-card").filter({hasText:"Motion Inspector"}).click();
  };
  const close = () => inspector.getByRole("button",{name:"Close Motion Inspector"}).click();
  try {
    await page.clock.install();
    await page.evaluate(() => AtriumPrefs.open("appearance"));
    const prefs = page.getByRole("dialog",{name:"Preferences",exact:true});
    for (const name of ["System","Full","Reduced","Off"]) await prefs.getByRole("radio",{name,exact:true}).waitFor();
    assert.equal(await prefs.getByRole("button",{name:/Motion inspector/i}).count(),0);
    await page.keyboard.press("Escape");
    await manage(false);
    assert.equal(await page.evaluate(id=>AtriumExtensions.list().some(e=>e.id===id),id),false);
    await manager.locator('input[type=file]:not([webkitdirectory])').setInputFiles({name:"Motion-Inspector.waffle-extension",mimeType:"application/json",buffer:bundle});
    const consent = page.getByRole("dialog",{name:"Install Motion Inspector?"});
    await consent.getByRole("checkbox",{name:/read:motion/}).uncheck();
    await consent.getByRole("button",{name:"Install",exact:true}).click();
    await manager.getByRole("button",{name:"Enable",exact:true}).click();
    assert.equal(await worker(),false);
    await manager.getByRole("button",{name:"Close",exact:true}).click();
    await page.evaluate(()=>{
      const after=setTimeout;
      globalThis.setTimeout=(fn,delay,...args)=>{
        if (delay===60000 && fn.name==="sweep") globalThis.__testIdleSweep=fn;
        return after(fn,delay,...args);
      };
    });
    await open();
    await inspector.getByText(/needs the read:motion permission/).waitFor();
    await close();
    await manage();
    await manager.getByRole("checkbox",{name:"read:motion",exact:true}).check();
    await manager.getByRole("button",{name:"Close",exact:true}).click();
    await open();
    await inspector.getByText("Reduced · the system asks for less motion").waitFor();
    await inspector.getByRole("row",{name:/--motion-slow.*Camera flights.*At once/}).waitFor();
    const elapsed=inspector.getByRole("spinbutton",{name:/Elapsed visible time/});
    await elapsed.fill("-5");
    await page.emulateMedia({reducedMotion:"no-preference"});
    await inspector.getByRole("row",{name:/--motion-slow.*Camera flights.*320 ms.*Animates/}).waitFor();
    assert.equal(await elapsed.inputValue(),"-5","policy refresh preserves an unfinished sample");
    await elapsed.press("Enter");
    await inspector.getByText("Elapsed time is out of range.").waitFor();
    await shot(inspector,"inspector-error");
    await elapsed.fill("320");
    await elapsed.press("Enter");
    await inspector.getByText("100 % · finished").waitFor();
    await inspector.getByText(/^Retarget to 40$/).waitFor();
    // Enter suppresses motion. Use trusted pointer input and keep one real track active across the poll.
    await inspector.getByRole("heading",{name:"Live",exact:true}).click();
    const running = await page.evaluate(()=>{
      const start = () => {
        if (AtriumMotion.level() === "full") globalThis.__motionTrack = AtriumMotion.animate({ms:320,camera:true,done:start});
      };
      start();
      return globalThis.__motionTrack?.running === true;
    });
    assert.equal(running,true,"the camera track was actually scheduled");
    await inspector.getByText("1 track running", {exact:true}).waitFor();
    await page.evaluate(()=>__motionTrack.cancel());
    await inspector.getByText("No track running. The clock is idle.").waitFor();
    await page.evaluate(id=>AtriumExtensions.grant(id,"read:motion",false),id);
    await inspector.getByText(/needs the read:motion permission/).waitFor();
    await page.evaluate(id=>{
      const d = AtriumMotionDiagnostics;
      globalThis.__motionReads=0;
      globalThis.AtriumMotionDiagnostics={inspect(...args){globalThis.__motionReads++;return d.inspect(...args);}};
      return AtriumExtensions.grant(id,"read:motion",true);
    },id);
    await inspector.getByText("Always lands at once").waitFor();
    assert.ok(await page.evaluate(()=>__motionReads)>0);
    await close();
    await inspector.waitFor({state:"hidden"});
    const reads = await page.evaluate(()=>__motionReads);
    await page.clock.runFor(500);
    assert.equal(await page.evaluate(()=>__motionReads),reads,"a closed panel stops reading diagnostics");
    await page.evaluate(()=>{const now=Date.now;Date.now=()=>now()+601000;try{__testIdleSweep();}finally{Date.now=now;}});
    await page.waitForFunction(id=>!AtriumExtensions.workers.some(w=>w.pool==="ext:"+id),id);
    await open();
    await inspector.getByText("Always lands at once").waitFor();
    await close();
    await manage();
    await manager.locator(".ext-detail").getByRole("heading",{name:"Motion Inspector",exact:true}).waitFor();
    await manager.getByRole("button",{name:"Disable",exact:true}).click();
    await manager.getByRole("button",{name:"Enable",exact:true}).waitFor();
    await page.waitForFunction(id=>!AtriumExtensions.workers.some(w=>w.pool==="ext:"+id),id);
    assert.equal(await page.evaluate(()=>!!AtriumKeymap.command("motion-inspector.open")),false);
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
}, ["--disable-gpu","--disable-background-networking"]).then(()=>console.log("PASS motion developer extension"),error=>{console.error(error);process.exit(1);});
