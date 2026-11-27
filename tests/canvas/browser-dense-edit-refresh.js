"use strict";
const assert = require("node:assert/strict");
const {pathToFileURL} = require("node:url");
const path = require("node:path");

module.exports = async function denseEditRefresh(browser) {
  const context = await browser.newContext({viewport:{width:1420,height:940},reducedMotion:"reduce"});
  let releaseRichText;
  const richText = new Promise(resolve=>{releaseRichText=resolve;});
  try {
    await context.route(/^https?:/,route=>route.abort());
    await context.route("**/pcb/pcb-text-rich.js",async route=>{await richText;await route.continue();},{times:1});
    const page = await context.newPage(), errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.addInitScript(()=>{globalThis.__atriumPowerState={occluded:true};});
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name",{hasText:"Sensor board"}).waitFor();
    const initial = await page.evaluate(async()=>{
      const panel=document.getElementById("inspector"), h=AtriumNavHost;
      const before=panel.childElementCount, c=h.canvas(), ctx=c.getContext("2d");
      const top=AtriumPCBAppearance.color("Top").match(/[\da-f]{2}/gi).map(hex=>parseInt(hex,16));
      const hasCopper=()=>{
        const data=ctx.getImageData(0,0,c.width,c.height).data;
        for(let i=0;i<data.length;i+=4)
          if(data[i]===top[0]&&data[i+1]===top[1]&&data[i+2]===top[2]&&data[i+3]===255)return true;
        return false;
      };
      const paintedBefore=hasCopper();
      h.act("toggle-right");await h.prepareLaunch();
      const closed=panel.childElementCount;
      h.act("toggle-right");h.redraw();await h.prepareLaunch();
      const controls=!!panel.querySelector("#selection-filter"), board=panel.textContent.includes("Board"), copper=hasCopper();
      const visible=AtriumPower.visible();
      AtriumPower.host({occluded:false});
      return {before,closed,controls,board,paintedBefore,copper,visible};
    });
    assert.deepEqual(initial,{before:0,closed:0,controls:true,board:true,paintedBefore:false,copper:true,visible:false},
      "the first native paint prepares the board and visible Properties dock while the window is still occluded");
    await page.evaluate(async()=>{
      const h=AtriumNavHost, A=Atrium, p=h.project(), d=h.doc();
      await AtriumLazy.need(["AtriumUndoStore","AtriumSyncStatus","AtriumNavigator","AtriumDock"]);
      AtriumPower.setMode("always");
      const [left,top,right,bottom]=A.bounds(d.outline)||[0,0,36,22];
      const def=p.library.find(item=>item.footprint?.pads?.length);
      const parts=Array.from({length:4},(_,i)=>({...A.instantiate(p,def,[right+4+i*4,top+5]),id:"audit-part-"+i,ref:"Z"+(i+1),value:"Audit component"}));
      const tracks=Array.from({length:25600-d.items.length-parts.length},(_,i)=>({id:"audit-track-"+i,kind:"track",layer:"Top",width:.2,
        points:[[110+(i%200)*.2,100+Math.floor(i/200)*.2],[110.15+(i%200)*.2,100+Math.floor(i/200)*.2]]}));
      if (!h.edit(()=>{
        d.items.push(...parts,...tracks);
        d.sync={...d.sync,clusters:[{name:"Audit sheet",ids:parts.map(i=>i.id)}]};
      },"Create dense edit regression board",[...parts,...tracks])) throw Error("Could not set up the test board.");
      h.select([]);
      h.view().restoreCamera({...h.view().camera(),cx:(left+right)/2+3,cy:(top+bottom)/2,scale:7});
      h.redraw();
      const probe=window.denseEdit={reads:[],inspectorReplacements:0,frames:0,rects:[]};
      h.on("frame",()=>probe.frames++);
      const moduleLoaded=h.moduleLoaded;
      h.moduleLoaded=(...args)=>{
        moduleLoaded(...args);
        if(args[0]&&globalThis.AtriumPCBTextRich)probe.richTextRefresh=true;
      };
      for(const method of ["find","filter","map",Symbol.iterator]){
        const original=d.items[method];
        Object.defineProperty(d.items,method,{value:function(fn,...args){
          const caller=new Error().stack.split("\n")[2];
          if (/inspectBody|documentItems|groupArtwork|at clusters|navigator\.js/.test(caller) ||
              method==="find" && typeof fn==="function" && String(fn).includes("===selected")) probe.reads.push(this.length);
          return method===Symbol.iterator ? original.call(this) : original.call(this,fn,...args);
        }});
      }
      const replace=Element.prototype.replaceChildren;
      Element.prototype.replaceChildren=function(...args){
        if(this.id==="inspector")probe.inspectorReplacements++;
        return replace.apply(this,args);
      };
      const stroke=CanvasRenderingContext2D.prototype.strokeRect;
      CanvasRenderingContext2D.prototype.strokeRect=function(...args){
        if(this.canvas===h.canvas() && Math.abs(this.globalAlpha-.55)<.01 && this.getLineDash().length===2)probe.rects.push(args);
        return stroke.apply(this,args);
      };
      const fill=CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...args){
        if(this.canvas===h.canvas()&&text==="Audit sheet · 4")probe.label=[x+2,y];
        return fill.call(this,text,x,y,...args);
      };
      Object.assign(probe,{
        overview(){
          const value=label=>[...document.querySelectorAll("#inspector .ui-prop-row")].find(n=>n.firstElementChild.textContent===label)?.lastElementChild.textContent;
          return [value("Components"),value("Tracks")].map(Number);
        },
        fullCounts:()=>["part","track"].map(kind=>Array.prototype.filter.call(d.items,item=>item.kind===kind).length),
        async frame(run){
          const before=this.frames; run();
          const deadline=performance.now()+4000;
          while(this.frames===before&&performance.now()<deadline)await new Promise(done=>requestAnimationFrame(done));
          if(this.frames===before)throw Error("No editor frame after input");
        },
        reset(){this.reads=[];this.rects=[];this.inspectorReplacements=0;},
        reshape(){if(!h.edit(()=>{tracks[0].points[1][0]+=.01;},"Move track endpoint",[tracks[0]]))throw Error("Reshape failed");},
        append(suffix=""){
          const track={...tracks[0],id:"new-audit-track"+suffix,points:[[110,105],[111,105]]};
          if(!h.edit(()=>d.items.push(track),"Append a track",[track]))throw Error("Append failed");
        },
        comment(){if(!h.edit(()=>{parts[0].value="Changed audit component";},"Rename a component comment",[parts[0]]))throw Error("Comment edit failed");},
        position:()=>parts.map(i=>[i.x,i.y]),
        expectedRect(){
          const [x,y,r,b]=AtriumSyncStatus.clusters(d,h.defs())[0].box;
          return [x-1.2,y-1.2,r-x+2.4,b-y+2.4];
        },
        output(){
          const out={reads:this.reads.slice(),replacements:this.inspectorReplacements,overview:this.overview(),fresh:this.fullCounts(),
            painted:this.rects.at(-1),label:this.label};
          out.expected=this.expectedRect();
          return out;
        }
      });
    });
    const showPanel=async id=>{
      await page.locator('details[data-menu="window"] > summary').click();
      const panels=page.locator("#sub-window-panels");
      await panels.getByRole("menuitem",{name:"Panels",exact:true}).click();
      await panels.locator('[data-dock-target="'+id+'"]').click();
    };
    const openProps=()=>showPanel("properties");
    const closeDock=()=>page.evaluate(()=>{if(!document.body.classList.contains("hide-right"))AtriumNavHost.act("toggle-right");});
    const read=()=>page.evaluate(()=>denseEdit.output());
    const settle=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
    const edit=method=>page.evaluate(async method=>{denseEdit.reset();await denseEdit.frame(()=>denseEdit[method]());},method);
    const sameCount=async()=>{
      await page.waitForFunction(()=>JSON.stringify(denseEdit.overview())===JSON.stringify(denseEdit.fullCounts()));
      const state=await read();
      assert.deepEqual(state.overview,state.fresh);
    };
    if(!await page.locator("#inspector").isVisible())await openProps();
    await sameCount();
    await page.waitForFunction(()=>denseEdit.label);
    const toggle=page.locator("#inspector .pcb-edit-filter-section .section-toggle");
    if(await toggle.getAttribute("aria-expanded")==="false")await toggle.click();
    const chip=page.locator("#selection-filter button").first();
    await chip.focus();
    await edit("reshape");
    // Let the real lazy notification run while the filter is still focused.
    releaseRichText();
    await page.evaluate(()=>AtriumLazy.need("AtriumPCBTextRich"));
    await page.waitForFunction(()=>denseEdit.richTextRefresh);
    const visible=await read();
    assert.deepEqual(visible.overview,visible.fresh);
    assert.deepEqual(visible.reads,[],"a visible settled reshape performs no full panel or group reads");
    assert.equal(visible.replacements,0,"a collapsed overview keeps its DOM for a same-net reshape");
    assert.equal(await chip.evaluate(node=>node===document.activeElement),true,"the selection filter keeps focus");
    const forced=await page.evaluate(()=>{
      const h=AtriumNavHost, defs=h.defs();
      denseEdit.reset();
      h.moduleLoaded();
      return {replacements:denseEdit.inspectorReplacements,definitionsReplaced:h.defs()!==defs};
    });
    assert.deepEqual(forced,{replacements:1,definitionsReplaced:true},"an explicit no-name refresh rebuilds Properties and definitions");
    assert.equal(await chip.evaluate(node=>node===document.activeElement),true,"a full refresh restores filter focus");
    const pressed=await chip.getAttribute("aria-pressed");
    await chip.click();
    assert.notEqual(await chip.getAttribute("aria-pressed"),pressed,"an explicit filter change still takes effect");
    assert.equal(await chip.evaluate(node=>node===document.activeElement),true,"changing a focused filter keeps focus");
    await chip.click();
    const layers=page.locator("#inspector summary").filter({hasText:/^Layers$/});
    await layers.click();
    const topLayer=page.locator("#inspector details[open] .layer-row").filter({hasText:"Top copper"});
    await topLayer.click();
    assert.equal(await topLayer.getAttribute("aria-pressed"),"false","the open Layers section hides Top copper");
    await chip.focus();
    await edit("reshape");
    assert.ok((await read()).replacements>0,"the open Layers section refreshes normally");
    assert.equal(await topLayer.getAttribute("aria-pressed"),"false","the refreshed Layers section keeps the live visibility");
    assert.equal(await chip.evaluate(node=>node===document.activeElement),true,"a needed rebuild restores filter focus");
    await topLayer.click();
    await layers.click();

    await closeDock();
    await page.locator("#inspector").waitFor({state:"hidden"});
    await settle();
    await edit("append");
    const closed=await read();
    assert.equal(closed.replacements,0,"the closed Properties dock did not build DOM");
    assert.deepEqual(closed.reads,[]);
    assert.equal(closed.fresh[1],closed.overview[1]+1,"the fixture changed a count while hidden");
    await openProps();
    await sameCount();
    for (const [action, expected] of [["undo",closed.fresh[1]-1],["redo",closed.fresh[1]]]) {
      await page.evaluate(action=>AtriumNavHost.act(action),action);
      await page.waitForFunction(count=>denseEdit.fullCounts()[1]===count,expected);
      await sameCount();
    }
    await page.evaluate(()=>{AtriumPower.host({occluded:true});denseEdit.reset();denseEdit.append("-covered");});
    await settle();
    const covered=await read();
    assert.equal(covered.replacements,0,"the covered editor deferred Properties");
    assert.equal(covered.painted,undefined,"the covered editor deferred the canvas frame");
    assert.equal(covered.fresh[1],covered.overview[1]+1);
    await page.evaluate(()=>AtriumPower.host({occluded:false}));
    await sameCount();

    await showPanel("components");
    const part=page.locator('#parts [data-part="audit-part-0"]');
    await part.waitFor();
    const old=await part.textContent();
    await edit("reshape");
    assert.deepEqual((await read()).reads,[],"visible Components use the unchanged component projection");
    assert.equal(await part.textContent(),old);
    await edit("comment");
    await part.filter({hasText:"Changed audit component"}).waitFor();
    await page.evaluate(()=>AtriumNavHost.act("undo"));
    await part.filter({hasText:"Audit component",hasNotText:"Changed"}).waitFor();
    await page.evaluate(()=>AtriumNavHost.act("redo"));
    await part.filter({hasText:"Changed audit component"}).waitFor();

    await closeDock();await settle();
    const canvas=await page.locator("#canvas").boundingBox(), point=(x,y)=>[canvas.x+x,canvas.y+y];
    await page.evaluate(()=>AtriumNavHost.act("measure"));
    await page.mouse.click(...point(canvas.width*.33,canvas.height*.65));
    await settle();
    await page.evaluate(()=>denseEdit.reset());
    for(let i=0;i<8;i++){
      const before=await page.evaluate(()=>denseEdit.frames);
      await page.mouse.move(...point(canvas.width*.44+i*7,canvas.height*.65));
      await page.waitForFunction(frame=>denseEdit.frames>frame,before);
    }
    const duringMeasure=await read();
    assert.deepEqual(duringMeasure.reads,[],"Measure restores the same group geometry without a board walk");
    assert.deepEqual(duringMeasure.painted,duringMeasure.expected);
    await page.evaluate(()=>AtriumNavHost.act("select"));await settle();

    const start=await page.evaluate(()=>denseEdit.position());
    await page.mouse.move(...point(...duringMeasure.label));
    await page.mouse.down();
    await page.mouse.move(...point(duringMeasure.label[0]+35,duringMeasure.label[1]),{steps:5});
    await page.mouse.up();
    await page.waitForFunction(before=>JSON.stringify(denseEdit.position())!==JSON.stringify(before),start);
    await settle();
    const placed=await read(), end=await page.evaluate(()=>denseEdit.position());
    assert(placed.expected[0]>duringMeasure.expected[0]);
    assert.deepEqual(placed.painted,placed.expected,"the committed group move renders the same new geometry as a full evaluation");
    assert.deepEqual(end.map(([x,y],i)=>[x-start[i][0],y-start[i][1]]),start.map(()=>[5,0]));
    await page.evaluate(()=>AtriumNavHost.act("undo"));
    await page.waitForFunction(before=>JSON.stringify(denseEdit.position())===JSON.stringify(before),start);
    await settle();
    const restored=await read();
    assert.deepEqual(restored.painted,duringMeasure.painted);
    await page.mouse.move(...point(...restored.label));
    await page.mouse.down();
    await page.mouse.move(...point(restored.label[0]+35,restored.label[1]),{steps:3});
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await settle();
    assert.deepEqual(await page.evaluate(()=>denseEdit.position()),start,"cancelled group drag preserves members");
    assert.deepEqual(errors,[]);
    console.log("PASS first-paint copper and Properties, dense board panel visibility, journal counts, component edits, Measure, and ECO group drag with Undo");
  } finally {releaseRichText();await context.close();}
};
