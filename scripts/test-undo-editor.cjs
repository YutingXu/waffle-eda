"use strict";
// Executed by test-undo-verified.py in the strict checkout.
const assert=require("node:assert/strict"), path=require("node:path"), {pathToFileURL}=require("node:url");
const {chromium}=require("playwright-core");
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME?{executablePath:process.env.CHROME}:{channel:"chrome"})});
  try {
    const test=await browser.newPage();
    for(const file of ["app/core/uuid-v7.js","app/core/model.js","app/history/undo-store.js","scripts/undo-verify-fault.js"])
      await test.addScriptTag({path:path.resolve(file)});
    assert.equal(await test.evaluate(()=>globalThis.undoVerificationProved),true);
    await test.close();
    const page=await browser.newPage({viewport:{width:1400,height:960}}), errors=[];
    page.on("pageerror",e=>errors.push(e.message));
    await page.goto(pathToFileURL(path.resolve("app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(()=>globalThis.AtriumNavHost?.doc().kind==="pcb");
    await page.evaluate(async()=>{
      await AtriumLazy.need(["AtriumUndoStore","AtriumGuides","AtriumSchPlace","AtriumSchObjects","AtriumPCBEdit",
        "AtriumProposal","AtriumAI","AtriumExtensions","AtriumPartInspector","AtriumRouter","AtriumDragReroute"]);
      const A=Atrium, h=AtriumNavHost, p=A.project("Verified editor",AtriumParts.catalogue), [s,b]=p.documents;
      s.id="sheet"; b.id="board"; s.grid=1;
      for (const [id,x,y] of [["R1",0,0],["R2",13,10],["R3",40,20]]) {
        s.items.push({id,kind:"part",ref:id,def:"std-r",value:"10k",x,y,angle:0,pinNets:{}});
      }
      const pin=A.pins(s.items[0],p.library.find(d=>d.id==="std-r"),"schematic")[0].at;
      s.items.push({id:"wire",kind:"wire",points:[pin,[pin[0]-10,pin[1]]]},
        {id:"frame",kind:"textframe",text:"Sheet note",x:18,y:-20,w:12,h:8});
      for (const [id,x,y,num] of [["br",10,10,1],["br2",26,20,2]]) {
        const item={id,kind:"part",ref:"R"+num,def:"std-r",value:"10k",x,y,angle:0,layer:"Top",pinNets:{1:"A"+num,2:"B"+num}};
        b.items.push(item);
        for (const pad of A.pins(item,p.library.find(d=>d.id===item.def),"pcb")) {
          const at=[pad.at[0]+(pad.at[0]<x?-4:4),pad.at[1]], net=item.pinNets[pad.number];
          b.items.push({kind:"track",id:"track"+net,net,layer:"Top",width:.25,points:[pad.at,at]},
            {kind:"via",id:"via"+net,net,layer:"Multi",x:at[0],y:at[1],diameter:.6,drill:.3});
        }
      }
      b.outline=[[0,0],[40,0],[40,30],[0,30]];
      await h.replaceProject(p,{force:true,dirty:false});h.selectDocument(s.id);h.setTool("select");
      globalThis.AtriumStartPage?.close();
      h.view().fit(s,h.defs());h.redraw();AtriumUndoStore.record(p);AtriumUndoStore.prime();
    });
    const snapshot=()=>page.evaluate(()=>JSON.stringify(AtriumNavHost.project()));
    const scoped=()=>page.evaluate(()=>{AtriumUndoStore.sync();return AtriumUndoStore.stats().scoped;});
    async function step(label,fn) {
      const initial=await snapshot(), was=await scoped();
      await fn();
      const final=await snapshot();
      assert.ok(final!==initial,label+" changed the design");
      assert.ok(await scoped()>was,label+" recorded a touched set");
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      assert.ok(await snapshot()===initial,label+" undo");
      await page.evaluate(()=>AtriumNavHost.act("redo"));
      assert.ok(await snapshot()===final,label+" redo");
    }
    const select=ids=>page.evaluate(ids=>AtriumNavHost.select(ids),ids);
    const act=cmd=>page.evaluate(cmd=>AtriumNavHost.act(cmd),cmd);
    await select(["R1"]);
    await step("inspector with attached wire",async()=>{
      const input=page.locator("#inspector label").filter({hasText:/^X \(/}).locator("input").first();
      await input.evaluate(i=>{i.value="3mm";i.dispatchEvent(new Event("change",{bubbles:true}));});
    });
    await select(["R1","R2","R3"]);
    await step("align",()=>act("align-top"));
    await step("distribute",()=>act("distribute-h"));
    await select(["R1"]);
    await step("MCP geometry proposal",()=>page.evaluate(()=>{
      const h=AtriumNavHost,d=h.doc(),i=d.items.find(x=>x.id==="R1");
      AtriumAI.apply({project:h.project(),defs:h.defs(),edit:h.edit},
        {format:"atrium-ai",version:1,project:h.project().name,changes:[{document:d.id,id:i.id,ref:i.ref,field:"x",before:i.x,after:i.x+2}]});
    }));
    await step("two script transactions in one step",()=>page.evaluate(async()=>{
      const r=await AtriumExtensions.runScript('await api.transaction("one", t=>t.update("R1",{value:"47k"})); await api.transaction("two", t=>t.update("R2",{value:"33k"}));');
      if(!r.ok)throw Error(r.error?.message||"script failed");
    }));
    await page.evaluate(async()=>{
      const h=AtriumNavHost, values=()=>["R1","R2","R3"].map(id=>h.doc().items.find(i=>i.id===id).value);
      const initial=values();
      const result=await AtriumExtensions.runScript('await api.transaction("Script first",t=>t.update("R1",{value:"A"})); console.log("interleave"); await api.transaction("Script second",t=>t.update("R3",{value:"C"}));',
        {onLog:(_,text)=>{if(text==="interleave"){const i=h.doc().items.find(o=>o.id==="R2");h.edit(()=>{i.value="B";},"Editor",[i]);}}});
      if(!result.ok||result.transactions!==2||result.undoSteps!==2)throw Error("Wrong script history ownership: "+JSON.stringify(result));
      const expected=[["A","B",initial[2]],["A",initial[1],initial[2]],initial];
      for(const row of expected){h.act("undo");if(JSON.stringify(values())!==JSON.stringify(row))throw Error("Interleaved Undo changed the wrong values.");}
      for(const row of [expected[1],expected[0],["A","B","C"]]){h.act("redo");if(JSON.stringify(values())!==JSON.stringify(row))throw Error("Interleaved Redo changed the wrong values.");}
      h.act("undo");h.act("undo");h.act("undo");
      const p=h.project(),board=p.documents.find(d=>d.kind==="pcb"),part=board.items.find(i=>i.id==="br"),sheet=h.doc().items.find(i=>i.id==="R1");
      const op=(d,i)=>({op:"set",target:"item",document:d.id,id:i.id,path:["value"],before:i.value,after:"reviewed"});
      const proposal={format:"atrium-ai",version:2,project:p.name,ops:[op(h.doc(),sheet),op(board,part)]};
      const ctx={project:p,currentProject:h.project,edit:h.edit,defs:h.defs()}, locks=globalThis.AtriumCollabLock;
      globalThis.AtriumCollabLock={...locks,guard:id=>id===board.id};
      try{
        const count=h.undoSteps().history.length;
        if(AtriumAI.apply(ctx,proposal,[0,1])!==0||h.undoSteps().history.length!==count||sheet.value!==initial[0]||part.value==="reviewed")
          throw Error("A background document lock must refuse the whole transaction.");
        if(AtriumAI.apply(ctx,proposal,[0])!==1||h.undoSteps().history.length!==count+1||sheet.value!=="reviewed")
          throw Error("A selected edit to the unlocked document must get its own checkpoint.");
        h.act("undo");
      }finally{globalThis.AtriumCollabLock=locks;}
    });
    await page.evaluate(()=>{const h=AtriumNavHost;AtriumAI.open({project:h.project(),currentProject:h.project,info:h.info,edit:h.edit,defs:h.defs()});});
    const ai=page.getByRole("dialog").filter({has:page.getByRole("heading",{name:"AI integration"})});
    const access=ai.getByRole("combobox",{name:"Saved project access"}),config=ai.locator("[data-config-preview]");
    await ai.getByText("Client configuration",{exact:true}).click();
    assert.equal(await access.inputValue(),"read");assert.match(await config.innerText(),/--read-only/);
    await access.selectOption("proposal");assert.doesNotMatch(await config.innerText(),/--read-only|--allow-write/);
    await access.selectOption("write");assert.match(await config.innerText(),/--allow-write/);
    await ai.getByRole("button",{name:"Close",exact:true}).click();
    const screen=point=>page.evaluate(p=>{const h=AtriumNavHost,r=h.canvas().getBoundingClientRect(),a=h.view().worldToScreen(p);return [r.left+a[0],r.top+a[1]];},point);
    async function startDrag(a,b) {
      await page.mouse.move(...await screen(a));await page.mouse.down();
      await page.mouse.move(...await screen(b),{steps:3});
      return page.evaluate(()=>AtriumNavHost.drag()?.kind);
    }
    async function dragFrame(cancel) {
      await select(["frame"]);
      const [x,y]=await page.evaluate(()=>{const i=AtriumNavHost.doc().items.find(i=>i.id==="frame");return [i.x+i.w,i.y+i.h];});
      assert.equal(await startDrag([x-.1,y-.1],[x+4,y+3]),"resize");
      if(cancel)await page.keyboard.press("Escape");await page.mouse.up();
    }
    await step("resize drag",()=>dragFrame(false));
    const beforeCancel=await snapshot();await dragFrame(true);assert.equal(await snapshot(),beforeCancel);
    async function mirror(cancel) {
      await select(["R1"]);
      const [x,y]=await page.evaluate(()=>{const i=AtriumNavHost.doc().items.find(i=>i.id==="R1");return [i.x,i.y];});
      assert.equal(await startDrag([x,y],[x+4,y+4]),"move");
      await act("mirror-x");if(cancel)await page.keyboard.press("Escape");await page.mouse.up();
    }
    await step("mirror during drag",()=>mirror(false));
    const was=await snapshot();await mirror(true);assert.equal(await snapshot(),was,"cancel a mirrored drag");
    await page.evaluate(()=>{const h=AtriumNavHost;h.selectDocument("board");h.setTool("select");h.view().fit(h.doc(),h.defs());h.redraw();});
    async function boardDrag(flip,cancel) {
      const [x,y]=await page.evaluate(()=>{const i=AtriumNavHost.doc().items.find(i=>i.id==="br");return [i.x,i.y];});
      assert.equal(await startDrag([x,y],[x+4,y+4]),"move");
      if(flip)await act("flip-side");if(cancel)await page.keyboard.press("Escape");await page.mouse.up();
    }
    // Escape clears selection and must restore the same board, connected copper and persistent router flags.
    const flags=world=>world.evaluate(w=>[w.n,w.pn,Array.from(w.dead.slice(0,w.nPersist))]);
    for (const ids of [["br"],["br","br2"]]) for (const flip of [false,true]) {
      await select(ids);
      const before=await snapshot(), world=await page.evaluateHandle(()=>{
        const h=AtriumNavHost;return AtriumRouter.world(h.doc(),h.defs(),{revision:h.revision(),project:h.project()});
      }), previous=await flags(world);
      await boardDrag(flip,true);
      assert.ok(await snapshot()===before,"cancelling restored the board and copper");
      assert.deepEqual(await page.evaluate(()=>AtriumNavHost.selection()),[]);
      assert.deepEqual(await flags(world),previous);await world.dispose();
    }
    await select(["br"]);await step("board flip during drag",()=>boardDrag(true,false));
    assert.deepEqual(await page.evaluate(()=>AtriumNavHost.selection()),["br"]);
    await page.evaluate(async()=>{
      await AtriumLazy.need("AtriumDynamicSymbol");
      const h=AtriumNavHost,p=Atrium.project("Dynamic connector edits"),first=p.documents[0];
      first.id="first";
      for(const id of ["first","second","untouched"]){
        const d=id===first.id?first:Atrium.sheet("schematic",id);
        if(d!==first){d.id=id;p.documents.push(d);}
        const {def,part}=AtriumDynamicSymbol.place(p,d,[20.32,20.32]);
        for(const [side,sign] of [["left",-1],["right",1]]){
          const edge=part.x+def.dynamic.body[sign<0?0:2],y=part.y,outer=edge+sign*5;
          // The untouched sheet has a wire on its connector already. Editing another
          // sheet should never settle its pending pin or change its library definition.
          const start=edge-(id==="untouched"?0:sign*.5);
          const wire=id+"-"+side;
          d.items.push({id:wire,kind:"wire",points:[[outer,y],[start,y]]},
            {id:wire+"-label",kind:"netlabel",text:wire,x:outer,y});
        }
      }
      await h.replaceProject(p,{force:true,dirty:false});h.selectDocument(first.id);
      AtriumUndoStore.record(p);AtriumUndoStore.prime();
    });
    const pinNames=()=>page.evaluate(()=>["first","second","untouched"].map(id=>{
      const h=AtriumNavHost,part=h.docById(id).items.find(i=>i.kind==="part");
      return h.defs().get(part.def).dynamic.pins.map(pin=>pin.name);
    }));
    assert.deepEqual(await pinNames(),[[],[],[]]);
    await step("dynamic pin on the active sheet",()=>page.evaluate(()=>{
      const h=AtriumNavHost,w=h.doc().items.find(i=>i.id==="first-left");
      h.edit(()=>{w.points[1][0]-=.5;},"Connect active sheet pin",[w]);
    }));
    assert.deepEqual(await pinNames(),[["first-left"],[],[]]);
    await page.evaluate(()=>{const h=AtriumNavHost;h.selectDocument(h.project().documents.find(d=>d.kind==="pcb").id);});
    await step("dynamic pins on two background sheets",()=>page.evaluate(()=>{
      const h=AtriumNavHost,p=h.project(),ops=[["first","right",.5],["second","left",-.5]].map(([document,side,offset])=>{
        const i=h.docById(document).items.find(i=>i.id===document+"-"+side);
        const [start,end]=i.points;
        return {op:"set",target:"item",document,id:i.id,path:["points"],before:i.points,after:[start,[end[0]+offset,end[1]]]};
      });
      if(AtriumAI.apply({project:p,currentProject:h.project,defs:h.defs(),edit:h.edit},{format:"atrium-ai",version:2,project:p.name,ops})!==2)
        throw Error("The two background wire edits were not accepted.");
    }));
    assert.deepEqual(await pinNames(),[["first-left","first-right"],["second-left"],[]]);
    async function addSheet() {
      await act("add-schematic");
      const dialog=page.getByRole("dialog",{name:"Add schematic sheet"});
      await dialog.getByRole("textbox").fill("Revision test sheet");
      await dialog.getByRole("button",{name:"Add",exact:true}).click();
    }
    const revisionState=()=>page.evaluate(()=>{
      const h=AtriumNavHost,{history,future}=h.undoSteps();
      return {project:h.project(),document:h.currentId(),selection:h.selection(),history:history.length,future:future.length};
    });
    await addSheet();
    assert.equal(await page.evaluate(()=>AtriumNavHost.doc().name),"Revision test sheet");
    await act("undo");
    await page.evaluate(async()=>{
      await AtriumLazy.need("AtriumRevisions");
      const h=AtriumNavHost,p=h.project();h.selectDocument("first");h.select(["first-left"]);
      AtriumRevisions.allow(()=>h.edit(()=>{AtriumRevisions.start(p);AtriumRevisions.freeze(p);},"Release revision A"));
    });
    const frozen=await revisionState();
    assert.equal(frozen.project.revision.status,"released");
    const refusal=await page.evaluate(()=>{
      const h=AtriumNavHost,w=h.doc().items.find(i=>i.id==="first-left");let calls=0;
      const change=()=>{calls++;w.points[0][0]++;};
      const ordinary=h.edit(change,"Move wire",[w]);
      const scoped=h.edit(change,"Move reviewed wire",[w],{documents:[h.currentId()],items:[w.id]});
      return {ordinary,scoped,calls};
    });
    assert.deepEqual(refusal,{ordinary:false,scoped:false,calls:0});
    assert.deepEqual(await revisionState(),frozen,"the frozen edit leaves the project and Undo/Redo history untouched");
    await addSheet(); // Direct placement checkpoints before adding the document and changing the active tab.
    assert.deepEqual(await revisionState(),frozen,"the direct checkpoint restores the frozen project, tab, selection and history");
    assert.deepEqual(await page.evaluate(()=>{const s=AtriumUndoStore.stats();return [globalThis.ATRIUM_UNDO_VERIFY,s.verified>0,s.missed,s.mismatch];}),["throw",true,0,0]);
    assert.deepEqual(errors,[]);
    await page.close();
    console.log("PASS Chrome caught the verification fault; editor edits, drag cancellations and undo/redo were exact");
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
