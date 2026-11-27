"use strict";
// Canvas hover cards on an imported multi-sheet Altium project and on the demo: an off-sheet
// connector loads its destinations by itself (Efficiency mode and a fresh edit included), only one
// card shows at a time, and every card sits next to the hovered object inside the window.
// The project is generated here and round-tripped through the Altium exporter and importer.
const assert=require("node:assert/strict");
const path=require("node:path"), fs=require("node:fs/promises"), {pathToFileURL}=require("node:url");
const {chromium}=require("../support/playwright.cjs");
const NEAR=40; // px from the hovered object's box to the card's box

async function main() {
  const browser=await chromium.launch(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome",args:["--allow-file-access-from-files"]});
  const page=await browser.newPage({viewport:{width:1280,height:800},reducedMotion:"reduce"});
  page.setDefaultTimeout(8000);
  const errors=[]; page.on("pageerror",e=>errors.push(e.message));
  const shots=process.env.CONNECTION_SCREENSHOTS;
  if (shots) await fs.mkdir(shots,{recursive:true});
  const shot=async name=>{
    if (!shots) return;
    await page.locator(".sheet-connection-card:visible, .ui-tooltip.is-card:visible").evaluateAll(async cards=>{
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const entrance=cards.flatMap(card=>card.getAnimations({subtree:true}));
      await Promise.allSettled(entrance.map(animation=>animation.finished));
    });
    await page.screenshot({path:path.join(shots,name+".png")});
  };
  try {
    await page.clock.install();
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name").filter({hasText:"Sensor board"}).waitFor();
    const cards=page.locator(".sheet-connection-card, .ui-tooltip.is-card:visible");
    // Screen box of an item on the current pane, and the point to hover.
    const locate=(match)=>page.evaluate(match=>{
      const h=AtriumNavHost, d=h.doc(), defs=h.defs(), A=Atrium;
      const i=d.items.find(i=>match.kind ? i.kind===match.kind && (!match.text || i.text===match.text) : i.id===match.id);
      if (!i) throw Error("no item for "+JSON.stringify(match));
      const view=h.view(), r=h.canvas().getBoundingClientRect();
      const look=AtriumSchAppearance;
      const world=i.kind==="netlabel" || i.kind==="label" && d.kind!=="pcb" ? look.labelBox(look.displayItem(d,i))
        : AtriumSchObjects.KINDS.has(i.kind) ? AtriumSchObjects.box(i) : A.bounds(A.itemPoints(i,defs.get(i.def),d.kind));
      const corners=[[world[0],world[1]],[world[2],world[3]]].map(p=>view.worldToScreen(p)).map(([x,y])=>[r.left+x,r.top+y]);
      const box=[Math.min(corners[0][0],corners[1][0]),Math.min(corners[0][1],corners[1][1]),Math.max(corners[0][0],corners[1][0]),Math.max(corners[0][1],corners[1][1])];
      if (i.kind==="part") return {id:i.id,box,x:(box[0]+box[2])/2,y:(box[1]+box[3])/2};
      const [px,py]=view.worldToScreen([i.x,i.y]);
      return {id:i.id,box,x:r.left+px,y:r.top+py};
    },match);
    async function hover(target) {
      await page.mouse.move(target.x-9,target.y+3); await page.mouse.move(target.x,target.y,{steps:3});
    }
    async function settle() {await page.mouse.move(2,780); await page.locator(".sheet-connection-card").waitFor({state:"detached"});}
    async function checkCard(card,target,what) {
      const b=await card.boundingBox(), vp=page.viewportSize();
      assert.ok(b, what+": card has a box");
      assert.ok(b.x>=0 && b.y>=0 && b.x+b.width<=vp.width && b.y+b.height<=vp.height, what+": card inside the window "+JSON.stringify(b));
      const [l,t,r,bottom]=target.box;
      const dx=Math.max(0,l-(b.x+b.width),b.x-r), dy=Math.max(0,t-(b.y+b.height),b.y-bottom);
      assert.ok(Math.hypot(dx,dy)<=NEAR, what+": card within "+NEAR+" px of the object "+JSON.stringify({card:b,object:target.box}));
      const pointerInside=target.x>b.x && target.x<b.x+b.width && target.y>b.y && target.y<b.y+b.height;
      assert.ok(!pointerInside, what+": card leaves the pointer uncovered");
      assert.equal(await cards.count(),1, what+": one hover card at a time");
    }

    // Demo: a schematic component and a PCB component.
    for (const kind of ["schematic","pcb"]) {
      await page.evaluate(kind=>{const h=AtriumNavHost; h.selectDocument(h.project().documents.find(d=>d.kind===kind).id); h.setTool("select");},kind);
      await page.waitForFunction(kind => AtriumNavHost.doc().kind === kind && !globalThis.AtriumMotion?.active(), kind);
      const id=await page.evaluate(()=>{
        const h=AtriumNavHost, r=h.canvas().getBoundingClientRect(), v=h.view();
        const parts=h.doc().items.filter(i=>i.kind==="part").map(i=>({i,p:v.worldToScreen([i.x,i.y])}));
        return parts.find(({p})=>p[0]>120 && p[1]>120 && p[0]<r.width-120 && p[1]<r.height-120)?.i.id || parts[0].i.id;
      });
      const target=await locate({id});
      await hover(target);
      const tip=page.locator(".ui-tooltip.is-card:visible"); await tip.waitFor();
      await checkCard(tip,target,"demo "+kind+" component");
      await shot("demo-"+kind+"-component");
      await settle();
    }

    // Generate a three-sheet project with off-sheet connectors, export it to Altium and import it.
    const files=await page.evaluate(async()=>{
      await AtriumLazy.need(["AtriumAltiumExport","AtriumPrefs"]);
      AtriumPrefs.set("checks.liveErc",false);
      const h=AtriumNavHost, A=Atrium, S=AtriumSchObjects, p=A.clone(h.project());
      p.name="Offsheet hover";
      const top=p.documents.find(d=>d.kind==="schematic");
      const radio=A.sheet("schematic","Radio"), bus=A.sheet("schematic","Sensor bus");
      const make=(kind,x,y,text)=>S.make(kind,[x,y],{text});
      radio.items=[make("offsheet",40,40,"SPI_MOSI"),make("offsheet",40,60,"SPI_MISO"),{id:"w-mosi",kind:"wire",points:[[20,40],[40,40]]},{id:"w-miso",kind:"wire",points:[[20,60],[40,60]]}];
      bus.items=[make("offsheet",60,40,"SPI_MOSI"),{id:"w-bus",kind:"wire",points:[[60,40],[90,40]]}];
      p.documents.splice(p.documents.indexOf(top)+1,0,radio,bus);
      return AtriumAltiumExport.exportProject(p).files.map(f=>[f.name,Array.from(f.bytes)]);
    });
    await page.evaluate(files=>{window.opening=AtriumNavHost.openFiles(files.map(([n,b])=>new File([new Uint8Array(b)],n)));},files);
    const replace=page.locator("dialog[open]").getByRole("button",{name:"Open here",exact:true});
    if (await replace.count() || await replace.waitFor({timeout:3000}).then(()=>true,()=>false)) await replace.click();
    assert.equal(await page.evaluate(()=>window.opening),true,"the exported Altium project opens");
    await page.waitForFunction(()=>AtriumNavHost.project().documents.some(d=>d.kind==="schematic" && d.items.some(i=>AtriumHierarchy.sourceType(i)==="offsheet")));
    // Efficiency mode (a laptop on battery) and an edit after import: nothing compiles until a hover asks.
    await page.evaluate(async()=>{
      await AtriumLazy.need(["AtriumConnectionPreview","AtriumCanvasInput"]); AtriumPower.setMode("always");
      const h=AtriumNavHost, d=h.project().documents.find(d=>d.kind==="schematic" && d.items.some(i=>AtriumHierarchy.sourceType(i)==="offsheet" && i.text==="SPI_MISO"));
      h.selectDocument(d.id); h.setTool("select");
      const i=d.items.find(i=>i.text==="SPI_MOSI");
      AtriumCamera.setPref("camera.animate",false); h.view().restoreCamera({...h.view().camera(),cx:i.x+20,cy:i.y,scale:8});
      const wire=d.items.find(i=>i.kind==="wire"); h.edit(()=>{wire.points=wire.points.map(p=>[...p]);},undefined,[wire]);
      h.redraw();
    });
    await page.clock.runFor(400);
    assert.equal(await page.evaluate(()=>!!AtriumConnectionPreview.current()),false,"Efficiency mode does not compile on an edit");
    const connector=await locate({kind:"offsheet",text:"SPI_MOSI"}).catch(()=>locate({kind:"netlabel",text:"SPI_MOSI"}));
    await hover(connector);
    const card=page.locator(".sheet-connection-card"); await card.waitFor();
    await card.locator(".sheet-connection-target").waitFor({timeout:1500});
    assert.match(await card.innerText(),/Sensor bus/,"the destination sheet shows without a click");
    assert.equal(await card.getByRole("button",{name:"Load connections"}).count(),0);
    await card.locator("canvas[data-ready]").waitFor();
    await page.clock.runFor(500); // past the tooltip's own dwell: it must not add a second card
    await checkCard(card,connector,"off-sheet connector");
    await shot("imported-offsheet");
    const camera=await page.evaluate(()=>AtriumNavHost.view().camera());
    const setCamera=camera=>page.evaluate(camera=>{
      const h=AtriumNavHost; h.view().restoreCamera(camera); h.redraw();
    },camera);
    await setCamera({...camera,rotation:Math.PI/6});
    await card.waitFor({state:"detached",timeout:1000});
    await setCamera(camera);
    await page.clock.runFor(400);
    assert.equal(await card.isVisible(),false,"an off-sheet hover does not reopen at a resting pointer after rotating");
    await hover(connector);
    await card.waitFor();
    await settle();
    // A wire on the imported sheet gets the ordinary card, also next to it.
    await page.evaluate(()=>AtriumPower.setMode("off"));
    const wire=await page.evaluate(()=>AtriumNavHost.doc().items.find(i=>i.kind==="wire").id);
    const wireTarget=await locate({id:wire});
    await hover({...wireTarget,x:(wireTarget.box[0]+wireTarget.box[2])/2,y:(wireTarget.box[1]+wireTarget.box[3])/2});
    const tip=page.locator(".ui-tooltip.is-card:visible");
    await tip.waitFor();
    await checkCard(tip,wireTarget,"imported wire");
    // Imported components on the imported sheet and board.
    for (const kind of ["schematic","pcb"]) {
      await settle();
      await page.evaluate(kind=>{const h=AtriumNavHost; h.selectDocument(h.project().documents.find(d=>d.kind===kind && d.items.some(i=>i.kind==="part")).id);},kind);
      await page.evaluate(kind=>{const h=AtriumNavHost,i=h.doc().items.find(i=>i.kind==="part");h.view().restoreCamera({...h.view().camera(),cx:i.x,cy:i.y,scale:kind==="pcb"?30:10});h.redraw();},kind);
      await page.waitForFunction(() => !globalThis.AtriumMotion?.active());
      const id=await page.evaluate(()=>AtriumNavHost.doc().items.find(i=>i.kind==="part").id);
      const target=await locate({id});
      await hover(target);
      const card=page.locator(".ui-tooltip.is-card:visible");
      await card.waitFor();
      await checkCard(card,target,"imported "+kind+" component");
      await shot("imported-"+kind+"-component");
    }
    assert.deepEqual(errors,[]);
    console.log("connection-preview hover cards: ok");
  } finally {await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
