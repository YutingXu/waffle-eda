"use strict";
const assert=require("node:assert/strict"), path=require("node:path"), fs=require("node:fs/promises"), {pathToFileURL}=require("node:url"),{chromium}=require("../support/playwright.cjs");
(async()=>{
  const browser=await chromium.launch(process.env.CHROME?{executablePath:process.env.CHROME}:{channel:"chrome"});
  const page=await browser.newPage({viewport:{width:1320,height:900},reducedMotion:"reduce",hasTouch:true});
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  // Rich engineering notes are part of the Notebook Experimental feature (labs.notebook); opt in.
  await require("../fixtures/notebook-labs.cjs").profile(page);
  const shot=async n=>{if(process.env.NOTEBOOK_SHOTS){await fs.mkdir(process.env.NOTEBOOK_SHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.NOTEBOOK_SHOTS,n+".png")});}};
  try {
    await page.clock.install();
    await page.goto(pathToFileURL(path.join(process.env.NOTEBOOK_APP_DIR || path.join(__dirname,"../../app"),"index.html")).href);await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name").filter({hasText:"Sensor board"}).waitFor();
    assert.equal(await page.evaluate(()=>!!window.AtriumRichText || !!window.AtriumNotebookFonts),false);
    await page.evaluate(async()=>{
      const h=AtriumNavHost,A=Atrium,p=A.project("Bench notebook",[]),d=p.documents[0],bank=h.project().library;
      const R=bank.find(x=>x.prefix==="R")||bank[0];p.library=[R];d.name="DC regulator";d.id="bench";
      d.items=[{id:"res",kind:"part",def:R.id,ref:"R1",x:22,y:42,value:"10k",angle:0}];
      await h.replaceProject(p,{force:true,dirty:false});h.selectDocument(d.id);AtriumTheme.setPreset("light");
      await AtriumLazy.need("AtriumRichText");await AtriumRichText.ready();d.items[0].value="10k";
      h.view().restoreCamera({cx:37,cy:26,scale:6,referenceScale:6});h.redraw();
    });
    await page.waitForFunction(()=>AtriumNavHost.currentId()==="bench" && AtriumNavHost.view().camera().scale===6 && !globalThis.AtriumMotion?.active());
    const insert=(style,argument)=>page.evaluate(async({style,argument})=>{
      const h=AtriumNavHost;const i=await AtriumRichText.insert({context:{host:h,docId:h.currentId(),point:[8,7]},argument},style);return i.id;
    },{style,argument});
    const id=await insert("paragraph","Power supply notebook");const h=page.locator('[role=textbox][aria-label="Engineering note"]');
    const pt=await page.evaluate(()=>{const h=AtriumNavHost,view=h.view();view.restoreCamera({cx:37,cy:26,scale:6,referenceScale:6});h.redraw();const p=view.worldToScreen([15,11]),r=h.canvas().getBoundingClientRect();return {x:p[0]+r.left,y:p[1]+r.top};});
    await page.mouse.dblclick(pt.x,pt.y);await h.waitFor();
    await page.keyboard.press("Meta+a");await page.keyboard.insertText("Bench result");
    await page.keyboard.press("End");await page.keyboard.press("Enter");
    await page.keyboard.type("# ");await page.keyboard.type("Regulator measurements");
    await page.keyboard.press("Enter");await page.keyboard.type("R1 is ");await page.keyboard.type("{R1.V");
    const option=page.getByRole("option",{name:/R1.Value/});await option.waitFor();assert.ok(await h.getAttribute("aria-activedescendant"));await page.keyboard.press("Enter");
    await h.locator("[data-expression]").waitFor();assert.equal(await h.locator("[data-expression]").textContent(),"10k");
    await page.keyboard.type(" and **measured**");await page.keyboard.type(String.raw` $\frac{1}{2}$`);await h.locator("[data-tex]").waitFor();if(process.env.NOTEBOOK_PALETTE_PROOF) await h.locator("[data-tex] canvas").waitFor();await page.getByRole("button",{name:"Formatting",exact:true}).click();await page.getByRole("button",{name:"Underline",exact:true}).waitFor();assert.ok(await h.evaluate(e=>document.querySelector(".rn-more").getBoundingClientRect().bottom<=e.getBoundingClientRect().top),"formatting keeps the note visible");
    await shot("note-edit-light");
    await page.getByRole("button",{name:"Finish editing"}).click();await h.waitFor({state:"detached"});
    const body=await page.evaluate(id=>AtriumNavHost.doc().items.find(i=>i.id===id).richText,id);
    assert.ok(body.blocks.some(b=>b.style==="h1"),"Markdown heading");assert.ok(body.blocks.some(b=>b.runs.some(r=>r.type==="field"&&r.binding?.itemId==="res")),"stable authored field");
    assert.ok(body.blocks.some(b=>b.runs.some(r=>r.bold&&r.text.includes("measured"))),"Markdown strong");
    assert.ok(body.blocks.some(b=>b.runs.some(r=>r.type==="math"&&r.tex===String.raw`\frac{1}{2}`)),"typed TeX groups survive in one inline math run");
    const project=()=>page.evaluate(id=>{const h=AtriumNavHost,n=h.doc().items.find(i=>i.id===id);return AtriumNotebook.describe(h.project(),h.doc(),n);},id);
    assert.match((await project()).text,/10k/);await page.evaluate(()=>{const h=AtriumNavHost,i=h.doc().items.find(i=>i.id==="res");h.edit(()=>{i.value="4k7";},"Set R1 value",[i]);});
    assert.match((await project()).text,/4k7/);
    await page.evaluate(()=>{const h=AtriumNavHost,i=h.doc().items.find(i=>i.id==="res");h.edit(()=>{h.doc().items=h.doc().items.filter(v=>v!==i);},"Delete R1",[]);});
    assert.equal((await project()).fields[0].broken,true);await shot("note-broken");
    await page.evaluate(()=>AtriumNavHost.act("undo"));assert.equal((await project()).fields[0].broken,false);
    await page.evaluate(()=>{AtriumTheme.setPreset("dark");AtriumNavHost.redraw();});
    await page.waitForFunction(()=>document.documentElement.dataset.theme==="dark");await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));await shot("note-canvas-dark");
    const second=await insert("check","Verify ripple");
    const c=await page.evaluate(id=>{const h=AtriumNavHost,i=h.doc().items.find(i=>i.id===id);h.edit(()=>{i.x=10;i.y=50;},"Place checklist",[i]);h.view().restoreCamera({cx:35,cy:34,scale:5,referenceScale:6});h.redraw();
      const p=h.view().worldToScreen([i.x+2,i.y+3]),r=h.canvas().getBoundingClientRect();return {x:r.left+p[0],y:r.top+p[1]};},second);
    if(process.env.NOTEBOOK_TRACE) await page.evaluate(()=>{window.noteInput=[];for(const type of ["pointerdown","pointerup","touchstart","touchend","click","dblclick","contextmenu"])window.addEventListener(type,e=>{const h=AtriumNavHost,r=h.canvas().getBoundingClientRect(),p=h.view().screenToWorld([e.clientX-r.left,e.clientY-r.top]),i=h.hitAt(p);noteInput.push([type,e.target.id,e.target.className,p,i?.id,i?.richText&&AtriumRichText.hit(h.project(),h.doc(),i,p)?.check]);},true);});
    await page.touchscreen.tap(c.x,c.y);await page.waitForFunction(id=>AtriumNavHost.doc().items.find(i=>i.id===id).richText.blocks[0].checked===true,second,{timeout:4500});
    if(process.env.NOTEBOOK_TRACE)console.log(await page.evaluate(()=>({events:noteInput,tool:AtriumNavHost.tool(),items:AtriumNavHost.doc().items.map(i=>[i.id,i.x,i.y])})));
    const cdp=await page.context().newCDPSession(page);
    await page.clock.runFor(410);
    await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",x:c.x,y:c.y,button:"left",buttons:1,clickCount:1,pointerType:"pen",force:.5});
    await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:c.x,y:c.y,button:"left",buttons:0,clickCount:1,pointerType:"pen",force:0});
    await page.waitForFunction(id=>!AtriumNavHost.doc().items.find(i=>i.id===id).richText.blocks[0].checked,second);
    const fieldPoint=()=>page.evaluate(id=>{const h=AtriumNavHost,n=h.doc().items.find(i=>i.id===id),v=h.view();v.restoreCamera({cx:37,cy:22,scale:6,referenceScale:6});h.redraw();
      const L=AtriumRichText.layout(h.project(),h.doc(),n);
      for (const b of L.blocks)for(const line of b.layout.lines)for(const run of line.runs)if(run.field){const p=v.worldToScreen([n.x+1.25+run.x+run.width/2,n.y+b.y+run.y-run.em*.5]),r=h.canvas().getBoundingClientRect();return [r.left+p[0],r.top+p[1]];}
    },id);
    await page.keyboard.down("Control");try{await page.mouse.click(...await fieldPoint());}finally{await page.keyboard.up("Control");}
    await page.waitForFunction(()=>AtriumNavHost.selection()[0]==="res",{},{timeout:6000});
    await page.clock.runFor(410);await page.evaluate(()=>AtriumNavHost.select([]));
    await page.touchscreen.tap(...await fieldPoint());await page.waitForFunction(()=>AtriumNavHost.selection()[0]==="res");
    await page.clock.runFor(410);
    const margin=await page.evaluate(id=>{const h=AtriumNavHost,i=h.doc().items.find(i=>i.id===id),v=h.view();v.restoreCamera({cx:37,cy:22,scale:6,referenceScale:6});h.redraw();
      const p=v.worldToScreen([i.x+i.w-2,i.y+2]),r=h.canvas().getBoundingClientRect();return [r.left+p[0],r.top+p[1]];},id);
    await page.touchscreen.tap(...margin);await page.getByRole("button",{name:"Edit rich text",exact:true}).tap();await h.waitFor();
    await page.setViewportSize({width:970,height:460});await page.waitForFunction(()=>{const e=document.querySelector(".rn-editor"),t=document.querySelector(".rn-tools"),v=visualViewport;
      return e.getBoundingClientRect().bottom<=v.offsetTop+v.height && t.getBoundingClientRect().top>=v.offsetTop;});
    await page.getByRole("button",{name:"Finish editing",exact:true}).tap();await h.waitFor({state:"detached"});await page.setViewportSize({width:1320,height:900});
    if(process.env.NOTEBOOK_PALETTE_PROOF) {
      const hostCanvas=page.locator("#canvas"),query=page.locator("#palette[open]").getByRole("combobox");
      await hostCanvas.focus();await page.keyboard.press("/");await query.waitFor();await query.fill("todo Probe output rail");
      await page.waitForFunction(()=>document.querySelector("#palette [aria-selected=true] .nav-palette-label")?.textContent==="Checklist");
      await query.press("Enter");await page.waitForFunction(()=>AtriumNavHost.doc().items.some(i=>i.richText?.blocks[0]?.style==="check" && i.text.includes("Probe output rail")));
      await hostCanvas.focus();await page.keyboard.press("/");await query.waitFor();await query.fill("Rich Text");
      const row=page.locator("#palette[open] [role=option]").filter({has:page.getByText("Rich Text",{exact:true})}).first();await row.click();
      await h.waitFor();await page.keyboard.type("Inserted with the palette");
      await page.getByRole("button",{name:"Finish editing"}).click();
      await page.waitForFunction(()=>AtriumNavHost.doc().items.some(i=>i.text==="Inserted with the palette"));
      await page.getByRole("button",{name:"Edit rich text",exact:true}).click();await h.waitFor();
      const selectAll=async()=>{await h.focus();await page.keyboard.press("Meta+a");};
      await selectAll();await page.keyboard.insertText("Amplifier");await selectAll();
      for(const name of ["Bold","Italic","Underline","Strikethrough","Inline code"]){await selectAll();await page.getByRole("button",{name,exact:true}).click();}
      await selectAll();await page.getByLabel("Text colour",{exact:true}).fill("#345678");
      await selectAll();await page.getByLabel("Text highlight",{exact:true}).fill("#ffeebb");
      await page.getByLabel("Paragraph style",{exact:true}).selectOption("h2");
      await selectAll();await page.getByLabel("Text alignment",{exact:true}).selectOption("center");
      await selectAll();await page.getByLabel("Notebook font",{exact:true}).selectOption("serif");
      await selectAll();await page.getByRole("button",{name:"Add link",exact:true}).click();
      await page.getByLabel("Link URL",{exact:true}).fill("https://example.org/notebook");await page.getByLabel("Link URL",{exact:true}).press("Enter");
      await page.getByRole("button",{name:"Finish editing",exact:true}).click();
      const formatted=await page.evaluate(()=>AtriumNavHost.doc().items.find(i=>i.text==="Amplifier")?.richText);
      assert.equal(formatted.font,"serif");assert.equal(formatted.blocks[0].style,"h2");assert.equal(formatted.blocks[0].align,"center");
      const word=formatted.blocks[0].runs.find(r=>r.text==="Amplifier");
      for(const key of ["bold","italic","underline","strike","code"])assert.equal(word[key],true,key);
      assert.equal(word.color,"#345678");assert.equal(word.highlight,"#ffeebb");assert.equal(word.href,"https://example.org/notebook");
      await page.waitForFunction(()=>!!globalThis.AtriumMath);
      const compiled=await page.evaluate(id=>{const H=AtriumNavHost,i=H.doc().items.find(o=>o.id===id),L=AtriumRichText.layout(H.project(),H.doc(),i);
        return L.blocks.flatMap(b=>b.layout.lines.flatMap(l=>l.runs.filter(r=>r.math).map(r=>r.math.plain)));},id);
      assert.ok(compiled.includes("(1)/(2)"),"the live editor and rich canvas share the STIX fraction");
    }
    assert.deepEqual(errors,[]);console.log("PASS mouse, keyboard, touch, pen, Markdown, field navigation, Undo and inline TeX"+(process.env.NOTEBOOK_PALETTE_PROOF?", licensed math rendering, slash insertion and palette editor focus":""));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
