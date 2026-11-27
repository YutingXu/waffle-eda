"use strict";
// Exercise the visible frame context menu, scope choice and editor undo journal.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

module.exports = async function checkFrameConversion(browser) {
  for (const theme of ["light","dark"]) {
    const page = await browser.newPage({viewport:{width:1400,height:960}}), errors=[];
    page.on("pageerror", e => errors.push(e.message));
    page.setDefaultTimeout(8000);
    try {
      await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
      await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
      await page.locator("#doc-name",{hasText:"Sensor board"}).waitFor();
      for (const [scope,choice,expected,scenario] of [["automatic","Switch","hierarchical"],["automatic","Keep Global","global"],
        ["flat",null,"flat"],["flat","Switch","hierarchical","repeat"],["automatic","Keep Global","global","unrelated"]]) {
        const before = await page.evaluate(async ({theme,scope,scenario}) => {
          const A=Atrium,S=AtriumSchObjects,h=AtriumNavHost;
          await AtriumLazy.need(["AtriumNetlist","AtriumRules","AtriumUndoStore","AtriumContextMenu"]);
          AtriumTheme.setPreset(theme);
          const R=AtriumParts.catalogue.find(d => d.id==="std-r"), p=A.project("Conversion",[R]),d=p.documents[0];
          const a=A.instantiate(p,R,[0,0]),b=A.instantiate(p,R,[35,0]);b.ref="R2";
          const one=A.pins(a,R,"schematic")[1].at,two=A.pins(b,R,"schematic")[0].at;
          const f=S.make("frame",[-12,-10],{w:24,h:20,text:"Filter"});
          const w={kind:"wire",id:A.id(),points:[one,two]};
          d.items.push(a,b,w,f);
          if (scenario === "repeat") {
            const root=A.sheet("schematic","Repeated channels");
            root.items.push(S.make("sheetsymbol",[40,0],{name:"Repeat(CH,1,2)",sheet:d.id}));p.documents.unshift(root);
          }
          if (scenario === "unrelated") for (let i=0;i<2;i++) {
            const other=A.sheet("schematic","Unrelated "+i),part=A.instantiate(p,R,[10,10]);part.ref="T"+i;
            const [x,y]=A.pins(part,R,"schematic")[0].at;other.items.push(part,{id:A.id(),kind:"netlabel",x,y,text:"SHARED"});p.documents.push(other);
          }
          const sheet=d.id;
          AtriumProjectRules.setNetScope(p,scope);
          await h.replaceProject(p,{force:true,copy:true,dirty:false});h.selectDocument(sheet);h.act("fit-objects");
          AtriumUndoStore.sync(h.project());
          return {docs:p.documents.length,sheet,frame:f.id,part:a.id,netlist:AtriumNetlist.extract(p,{source:"schematic"}).nets,
            history:h.undoSteps().history.length,items:JSON.stringify(d.items),rules:JSON.stringify(p.rules)};
        },{theme,scope,scenario});
        const hit = await page.evaluate(async id => {
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          const h=AtriumNavHost,b=h.canvas().getBoundingClientRect(),frame=h.doc().items.find(i=>i.id===id);
          const [x,y]=h.view().worldToScreen([frame.x+2,frame.y+.35]);
          return {x:b.left+x,y:b.top+y};
        },before.frame);
        await page.mouse.click(hit.x,hit.y,{button:"right"});
        await page.getByRole("menuitem",{name:"Convert Frame to Sheet"}).click();
        const notice=page.locator("#project-scope-notice");
        if (choice) {
          await notice.getByRole("button",{name:choice,exact:true}).waitFor();
          assert.equal(await page.evaluate(()=>AtriumNavHost.project().documents.length),before.docs,"choosing a scope is outside the journal");
          if (scenario === "unrelated") assert.equal(await notice.getByRole("button",{name:"Switch",exact:true}).count(),0);
          if (scenario === "repeat") assert.equal(await notice.getByRole("button",{name:"Keep Flat",exact:true}).count(),0);
          await notice.getByRole("button",{name:choice,exact:true}).click();
        } else {
          assert.match(await notice.innerText(),/Flat/);
          await notice.getByRole("button",{name:"Dismiss"}).click();
        }
        const state=await page.evaluate(({frame,sheet,part})=>{
          const h=AtriumNavHost,p=h.project(),symbol=h.docById(sheet).items.find(i=>i.id===frame);
          Atrium.validate(p);
          return {child:symbol.sheet,contains:h.docById(symbol.sheet).items.some(i=>i.id===part),entries:symbol.entries,
            netlist:AtriumNetlist.extract(p,{source:"schematic"}).nets,history:h.undoSteps().history.length,
            scope:AtriumHierarchy.effectiveScope(p,AtriumHierarchy.scopeSetting(p)),data:JSON.stringify(p.documents)};
        },before);
        assert.equal(state.scope,expected);assert.equal(state.contains,true);assert.equal(state.entries.length,1);
        assert.deepEqual(state.netlist,before.netlist);assert.equal(state.history,before.history+1);
        const undo=await page.evaluate(id=>{
          const h=AtriumNavHost;h.act("undo");
          return {items:JSON.stringify(h.docById(id).items),rules:JSON.stringify(h.project().rules),docs:h.project().documents.length};
        },before.sheet);
        assert.equal(undo.docs,before.docs);assert.equal(undo.items,before.items);assert.equal(undo.rules,before.rules);
        const redo=await page.evaluate(()=>{AtriumNavHost.act("redo");return JSON.stringify(AtriumNavHost.project().documents);});
        assert.equal(redo,state.data,"Redo restores every generated ID and association");
      }
      assert.deepEqual(errors,[]);
    } finally {await page.close();}
  }
  console.log("PASS frame context menu, compiled nets, Automatic Switch/Keep, explicit Flat and single Undo/Redo in both themes");
};

if (require.main===module) (async () => {
  const browser=await require("../support/playwright.cjs").chromium.launch({channel:"chrome"});
  try {await module.exports(browser);} finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
