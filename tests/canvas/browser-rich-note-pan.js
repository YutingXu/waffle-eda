"use strict";
const assert=require("node:assert/strict"),path=require("node:path"),fs=require("node:fs/promises"),{pathToFileURL}=require("node:url"),{chromium}=require("playwright-core");
function stats(list){const s=list.slice().sort((a,b)=>a-b),v=q=>Number(s[Math.min(s.length-1,Math.floor(s.length*q))].toFixed(3));return {n:s.length,p50:v(.5),p95:v(.95),max:v(1),over16:s.filter(n=>n>16).length};}
async function trace(cdp){const done=new Promise(r=>cdp.once("Tracing.tracingComplete",r));await cdp.send("Tracing.end");const {stream}=await done,parts=[];for(;;){const p=await cdp.send("IO.read",{handle:stream});parts.push(p.base64Encoded?Buffer.from(p.data,"base64").toString():p.data);if(p.eof)break;}await cdp.send("IO.close",{handle:stream});return JSON.parse(parts.join("")).traceEvents;}
(async()=>{
  const browser=await chromium.launch(process.env.CHROME?{executablePath:process.env.CHROME}:{channel:"chrome"});
  const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:"reduce"});
  try {
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();await page.locator("#doc-name").filter({hasText:"Sensor board"}).waitFor();
    await page.evaluate(async()=>{
      const H=AtriumNavHost,A=Atrium,P=A.project("Notebook pan",[]),d=P.documents[0];
      await AtriumLazy.need("AtriumPrefs");AtriumPrefs.set("checks.liveErc",false);
      d.id="bench";P.documents=[d];P.parameters={Owner:"Analog team",Gain:"4k7",Temperature:"23 °C"};const size=2.2;
      for(let n=0;n<500;n++) {
        const key=n?"owner":"gain";
        d.items.push({id:"n"+n,kind:"textframe",x:(n%25)*65,y:Math.floor(n/25)*24,w:63,h:22,size,border:false,text:"Bench "+n,richText:{font:["sans","serif","mono","hand"][n%4],blocks:[
          {style:"h2",runs:[{type:"text",text:"Measurement "+n}]},{style:"paragraph",runs:[{type:"text",text:"Probe at "},{type:"field",expression:"project."+key,binding:{scope:"project",field:key}},{type:"text",text:" before enabling output.",italic:true}]},
          {style:"check",checked:n%3===0,runs:[{type:"text",text:"Record DC offset",bold:true}]}]}});
      }
      await H.replaceProject(P,{force:true,dirty:false});H.selectDocument(d.id);await AtriumLazy.need("AtriumRichText");await AtriumRichText.ready();
      for(const item of d.items)AtriumRichText.layout(P,d,item);
      window.benchNotes={n:d.items.length,initial:{...AtriumRichText.stats}};
      H.edit(()=>{P.parameters.Gain="8k2";},"Change amplifier gain",[]);
      for(const item of d.items)AtriumRichText.layout(P,d,item);
      benchNotes.edited={...AtriumRichText.stats};
    });
    await page.waitForFunction(() => !!globalThis.benchNotes?.edited && !globalThis.AtriumMotion?.active());
    const setup=await page.evaluate(async()=>{
      const h=AtriumNavHost;h.view().restoreCamera({cx:635,cy:226,scale:2.6,referenceScale:1.5});h.redraw();
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=h.canvas().getBoundingClientRect();
      return {cx:b.left+b.width/2,cy:b.top+b.height/2,revision:h.revision(),camera:h.view().camera(),bench:benchNotes};
    });
    assert.equal(setup.bench.edited.paragraphs-setup.bench.initial.paragraphs,1,"only the changed field's paragraph relays out");
    await page.mouse.move(setup.cx,setup.cy);await page.mouse.down({button:"middle"});
    const cdp=await page.context().newCDPSession(page);await cdp.send("Tracing.start",{categories:"toplevel,blink.user_timing,devtools.timeline",transferMode:"ReturnAsStream"});
    await page.evaluate(()=>{window.frames=[];window.recording=true;performance.mark("notes-start");requestAnimationFrame(function loop(t){if(recording){frames.push(t);performance.mark("notes-frame");requestAnimationFrame(loop);}});});
    for(let i=0;i<140;i++) {await page.mouse.move(setup.cx+150*Math.sin(i/16),setup.cy+75*Math.cos(i/19));await page.waitForTimeout(11);}
    await page.mouse.up({button:"middle"});
    const out=await page.evaluate(()=>{window.recording=false;performance.mark("notes-end");return {frames:window.frames,stats:{...AtriumRichText.stats},cam:AtriumNavHost.view().camera()};});
    assert.notEqual(out.cam.cx,setup.camera.cx,"trusted middle-button drag pans the live editor");
    const t=await trace(cdp),start=t.find(x=>x.name==="notes-start"),end=t.find(x=>x.name==="notes-end"),main=t.filter(e=>e.pid===start.pid&&e.tid===start.tid&&e.ts<=end.ts&&e.ts+(e.dur||0)>=start.ts);
    const marks=main.filter(e=>e.name==="notes-frame").sort((a,b)=>a.ts-b.ts),tasks=main.filter(e=>e.ph==="X"&&["RunTask","ThreadControllerImpl::RunTask"].includes(e.name)&&e.dur>0),wall=[],cpu=[];
    for(let i=1;i<marks.length;i++){const a=marks[i-1].ts,b=marks[i].ts;
      wall.push(tasks.reduce((sum,t)=>sum+Math.max(0,Math.min(b,t.ts+t.dur)-Math.max(a,t.ts)),0)/1000);
      cpu.push((marks[i].tts-marks[i-1].tts)/1000);}
    const dispatch=main.filter(e=>e.name==="EventDispatch"&&e.args?.data?.type==="pointermove");
    const report={chromium:browser.version(),owners:500,paragraphs:1500,editedParagraphLayouts:setup.bench.edited.paragraphs-setup.bench.initial.paragraphs,
      panParagraphLayouts:out.stats.paragraphs-setup.bench.edited.paragraphs,rendererCPUPerFrameMs:stats(cpu),rendererTaskWallPerFrameMs:stats(wall),pointerDispatchMs:stats(dispatch.map(e=>e.dur/1000)),
      headlessRefreshMs:stats(out.frames.slice(1).map((n,i)=>n-out.frames[i]))};
    console.log(JSON.stringify(report,null,2));if(process.env.NOTEBOOK_PERF_JSON)await fs.writeFile(process.env.NOTEBOOK_PERF_JSON,JSON.stringify(report,null,2)+"\n");
    assert.ok(cpu.length>75&&dispatch.length>80);assert.equal(report.panParagraphLayouts,0);assert.ok(report.rendererCPUPerFrameMs.max<=16&&report.rendererTaskWallPerFrameMs.max<=16);
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
