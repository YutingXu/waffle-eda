"use strict";
// Real Chromium input and trace on a dense multi-sheet project. The compositor's
// refresh period, renderer main-thread work and input dispatch are separate metrics.
const assert=require("node:assert/strict"), path=require("node:path"), fs=require("node:fs/promises");
const {pathToFileURL}=require("node:url"), {chromium}=require("playwright-core");
function stats(samples) {
  const s=samples.slice().sort((a,b)=>a-b), at=q=>+(s[Math.min(s.length-1,Math.floor(s.length*q))] || 0).toFixed(3);
  return {n:s.length,p50:at(.5),p95:at(.95),max:at(1),over16:s.filter(v=>v>16).length};
}
async function readTrace(cdp) {
  const done=new Promise(resolve=>cdp.once("Tracing.tracingComplete",resolve));
  await cdp.send("Tracing.end");
  const {stream}=await done, parts=[];
  for (;;) {const r=await cdp.send("IO.read",{handle:stream});parts.push(r.base64Encoded?Buffer.from(r.data,"base64").toString():r.data);if(r.eof)break;}
  await cdp.send("IO.close",{handle:stream});return JSON.parse(parts.join("")).traceEvents;
}
async function main() {
  const browser=await chromium.launch(process.env.CHROME?{executablePath:process.env.CHROME}:{channel:"chrome"});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(20000);
  try {
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name").filter({hasText:"Sensor board"}).waitFor();
    await page.evaluate(async()=>{
      const h=AtriumNavHost, A=Atrium, p=A.project("Dense sheet connections",[]), d=p.documents[0];
      await AtriumLazy.need("AtriumPrefs");AtriumPrefs.set("checks.liveErc",false);
      d.id="dense";d.name="Interfaces";p.documents=[d,A.sheet("schematic","Sensor"),A.sheet("schematic","Display")];
      // Independent signals give the ports real destinations without a bus marker claiming their hover.
      const ports=["SDA","SCL","SCK","MISO","MOSI","READY","ENABLE","FAULT","RESET","ALERT","WAKE","SENSE"];
      for (const [s,doc] of p.documents.entries()) {
        const n=s?1200:20000;
        for(let i=0;i<n;i++) doc.items.push({id:"label"+i,kind:"netlabel",x:(i%160)*5,y:Math.floor(i/160)*3,text:"N"+i%128});
        for(const [i,text] of ports.entries()) doc.items.push({...AtriumSchObjects.make("port",[i*8,-7],{text,io:"input"}),id:"port"+i});
        doc.items.push({...AtriumSchObjects.make("power",[0,-40],{text:"GND"}),id:"rail"});
      }
      if (!await h.replaceProject(p,{force:true,dirty:false})) throw Error("The connection fixture did not open");
      await AtriumLazy.need(["AtriumConnectionPreview","AtriumInsightsUI"]);
    });
    await page.waitForFunction(()=>{
      const doc=AtriumNavHost.currentId(), insights=AtriumInsightsUI;
      return doc==="dense" && !!AtriumConnectionPreview.current() && !globalThis.AtriumMotion?.active() &&
        (!insights.enabled() || insights.lastPass()?.docId===doc && !insights.running());
    });
    const points=await page.evaluate(async()=>{
      const h=AtriumNavHost, view=h.view(), canvas=h.canvas(), pose={cx:52,cy:4,scale:5.5,referenceScale:4};
      await new Promise(resolve=>{
        const off=h.on("frame",()=>{off();resolve();});
        AtriumCamera.land();view.restoreCamera(pose);h.redraw();
      });
      const painted=view.camera(), graph=AtriumConnectionPreview.current();
      if (painted.cx!==pose.cx || painted.cy!==pose.cy || painted.scale!==pose.scale || !h.allowsHover(canvas) || !graph)
        throw Error("Expected the connection fixture's rendered camera and current index");
      const r=canvas.getBoundingClientRect(), screen=(x,y)=>{const [a,b]=view.worldToScreen([x,y]);return [r.left+a,r.top+b];};
      const dwell=[0,2,4,6,8,10].map(i=>{
        const point=screen(8*i,-7), id="port"+i;
        const source=AtriumConnectionPreview.sourceOf(h.hit(canvas,...point));
        if(source?.item.id!==id || source.kind!=="port") throw Error("Expected an admitted port hit for "+id);
        const row=graph.targetsFor(source.doc.id,id);
        if(row?.targets.length!==2 || !row.targets.every(t=>t.doc!==source.doc && t.item.id===id)) throw Error("Expected two other-sheet targets for "+id);
        return {point,id};
      });
      return {sweep:Array.from({length:30},(_,i)=>screen(5*(i%21),3*Math.floor(i/21))),dwell,off:[r.left+6,r.top+42]};
    });
    const card=page.locator(".sheet-connection-card");
    await page.mouse.move(...points.off);
    await card.waitFor({state:"detached"});
    const cdp=await page.context().newCDPSession(page);
    await cdp.send("Tracing.start",{categories:"toplevel,blink.user_timing,devtools.timeline,cc,viz",transferMode:"ReturnAsStream"});
    await page.evaluate(()=>{
      window.bench={running:true,times:[],compiles:0};
      const old=AtriumHierarchy.compileCached;
      AtriumHierarchy.compileCached=(...a)=>{bench.compiles++;return old(...a);};
      performance.mark("sheet-hover-start");
      requestAnimationFrame(function frame(t) {if(bench.running){bench.times.push(t);performance.mark("sheet-hover-frame");requestAnimationFrame(frame);}});
    });
    for (let i=0;i<3;i++) for (const p of points.sweep) await page.mouse.move(...p);
    const dwells=[], cards=[];
    for(const {point,id} of points.dwell) {
      const target=`.sheet-connection-target[data-item="${id}"]`;
      await page.evaluate(target=>{
        bench.nextPreview=new Promise(done=>{
          let start,shown,hasTarget;
          document.addEventListener("pointermove",()=>{start=performance.now();},{capture:true,once:true});
          const o=new MutationObserver(()=>{
            const card=document.querySelector(".sheet-connection-card");
            if (start==null || !card) return;
            const row=card.querySelector(target);
            if (shown==null) {shown=performance.now()-start;hasTarget=!!row;}
            if (row?.querySelector("canvas[data-ready]")) {o.disconnect();done([shown,performance.now()-start,hasTarget]);}
          });
          o.observe(document.body,{subtree:true,attributes:true,attributeFilter:["data-ready"],childList:true});
        });
      },target);
      await page.mouse.move(...point);
      await card.locator(target+" canvas[data-ready]").first().waitFor();
      const [shown,ready,hasTarget]=await page.evaluate(()=>bench.nextPreview);
      assert.ok(hasTarget,"Expected a linked destination when the card first appeared for "+id);
      cards.push(shown);dwells.push(ready);
      await page.mouse.move(...points.off);
      await card.waitFor({state:"detached"});
    }
    const bench=await page.evaluate(()=>{bench.running=false;performance.mark("sheet-hover-end");return bench;});
    const trace=await readTrace(cdp), start=trace.find(x=>x.name==="sheet-hover-start"), end=trace.find(x=>x.name==="sheet-hover-end");
    if(process.env.CONNECTION_TRACE_GZ) await fs.writeFile(process.env.CONNECTION_TRACE_GZ,require("node:zlib").gzipSync(JSON.stringify(trace)));
    assert.ok(start && end);
    const main=trace.filter(x=>x.pid===start.pid && x.tid===start.tid && x.ts<=end.ts && x.ts+(x.dur||0)>=start.ts);
    const marks=main.filter(e=>e.name==="sheet-hover-frame").sort((a,b)=>a.ts-b.ts);
    const tasks=main.filter(e=>e.ph==="X" && (e.name==="RunTask" || e.name==="ThreadControllerImpl::RunTask") && e.dur>0);
    const dispatch=main.filter(e=>e.name==="EventDispatch" && e.args?.data?.type==="pointermove");
    assert.ok(marks.length>50 && tasks.length && dispatch.length>30,
      JSON.stringify({frames:marks.length,tasks:tasks.length,dispatch:dispatch.length,
        timing:[...new Set(main.filter(x=>x.ph==="X" && (x.cat?.includes("toplevel") || /task|frame/i.test(x.name))).map(x=>x.name))].slice(0,40)}));
    // Chrome's per-thread timestamps give actual CPU elapsed on the renderer
    // main thread between consecutive rAF marks, including unrelated editor JS.
    const wall=[], cpu=[];
    for(let i=1;i<marks.length;i++){
      const a=marks[i-1].ts,b=marks[i].ts, inside=tasks.filter(t=>t.ts<b && t.ts+t.dur>a);
      wall.push(inside.reduce((n,t)=>n+Math.min(b,t.ts+t.dur)-Math.max(a,t.ts),0)/1000);
      if(Number.isFinite(marks[i].tts) && Number.isFinite(marks[i-1].tts))cpu.push((marks[i].tts-marks[i-1].tts)/1000);
    }
    const report={editor:"Chromium "+browser.version(),sheets:3,activeItems:20013,totalItems:22439,
      trustedPointerDispatchMs:stats(dispatch.map(e=>e.dur/1000)),
      rendererMainTaskWallPerFrameMs:stats(wall),rendererMainCPUPerFrameMs:stats(cpu),
      headlessRefreshIntervalMs:stats(bench.times.slice(1).map((t,i)=>t-bench.times[i])),
      dwellToCardMs:stats(cards),dwellToFirstThumbnailMs:stats(dwells),hoverCompileRequests:bench.compiles};
    console.log(JSON.stringify(report,null,2));
    if(process.env.CONNECTION_PERF_JSON) await fs.writeFile(process.env.CONNECTION_PERF_JSON,JSON.stringify(report,null,2)+"\n");
    assert.deepEqual(errors,[]);assert.equal(bench.compiles,0);
    assert.ok(cpu.length===wall.length && report.rendererMainCPUPerFrameMs.max<=16,"renderer main-thread CPU exceeded 16 ms or unavailable");
    assert.ok(report.trustedPointerDispatchMs.max<=16,"pointer input exceeded 16 ms");
    assert.ok(report.rendererMainTaskWallPerFrameMs.max<=16,"renderer main-thread work exceeded 16 ms");
  } finally {await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
