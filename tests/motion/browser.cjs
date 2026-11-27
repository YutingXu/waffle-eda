"use strict";
// Run from the checkout root. The optional capture directory holds presentation frames and their times.
// node tests/motion/browser.cjs light|dark live|controlled [capture-directory] [checkout]
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), {pathToFileURL} = require("node:url");
const {chromium} = require("../support/playwright.cjs");
const [theme = "light", mode = "live", directory, root = path.resolve(__dirname, "../..")] = process.argv.slice(2);
const controlled = mode === "controlled", sample = 1000 / 120;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const width = 1120, height = 720;

function instrument() {
  const real = performance.now.bind(performance), frame = requestAnimationFrame.bind(window), cancel = cancelAnimationFrame.bind(window);
  const pending = new Map(), animations = new Map(), work = new Map(), intervals = [], gaps = [], longFrames = [];
  let action = 0;
  let id = 0, virtual = false, measuring = false, previous = 0, clock = real(), monitor = 0;
  function invoke(fn, t) {
    const start = real();
    try { fn(t); } finally { if (measuring) work.set(t, (work.get(t) || 0) + real() - start); }
  }
  window.requestAnimationFrame = fn => {
    if (!virtual) return frame(t => invoke(fn,t));
    pending.set(--id, fn); return id;
  };
  window.cancelAnimationFrame = key => { if (key < 0) pending.delete(key); else cancel(key); };
  function heartbeat(t) {
    if (previous) { const dt=t-previous; intervals.push(dt); if(dt>25)gaps.push({action,ms:+dt.toFixed(1)}); }
    previous=t; if (measuring) monitor=frame(heartbeat);
  }
  if (window.PerformanceObserver?.supportedEntryTypes?.includes("long-animation-frame"))
    new PerformanceObserver(list=>{if(measuring)for(const e of list.getEntries())
      longFrames.push({action,ms:+e.duration.toFixed(1),blocking:+e.blockingDuration.toFixed(1)});}).observe({type:"long-animation-frame"});
  window.motionMeasure = {
    start(control) {
      measuring=true; clock=real(); performance.mark("butter.start");
      if (control) { virtual=true; Object.defineProperty(performance,"now",{configurable:true,value:()=>clock}); }
      else monitor=frame(heartbeat);
    },
    mark(n) { action=n; performance.mark("butter.action."+n); },
    advance(ms) {
      clock += ms;
      const batch = [...pending]; pending.clear();
      for (const [,fn] of batch) invoke(fn, clock);
      // CSS animations and transitions use the same manual presentation time as the canvas.
      // Each source image is rendered by Chromium, including text, menus, the board and its overlays.
      for (const a of document.getAnimations()) {
        if (!animations.has(a)) { animations.set(a,clock); a.pause(); }
        const elapsed=clock-animations.get(a), end=a.effect?.getComputedTiming().endTime;
        if (Number.isFinite(end) && elapsed>=end) { a.finish(); } else a.currentTime=elapsed;
      }
    },
    end() {
      measuring=false; cancel(monitor); performance.mark("butter.end");
      function stats(values) {
        const sorted=[...values].sort((a,b)=>a-b),value=p=>+(sorted[Math.floor((sorted.length-1)*p)]||0).toFixed(3);
        return {n:sorted.length,p50:value(.5),p95:value(.95),p99:value(.99),max:value(1)};
      }
      return {frameWorkMs:stats(work.values()),cadenceMs:stats(intervals),pendingMotion:AtriumMotion.active(),
        gaps,longFrames,over16:[...work.values()].filter(n=>n>16).length,over8:[...work.values()].filter(n=>n>8).length};
    },
  };
}

async function position(page,kind) {
  return page.evaluate(kind=>{
    const h=AtriumNavHost,doc=h.doc(),c=h.canvas(),r=c.getBoundingClientRect();
    for (const item of doc.items.filter(i=>i.kind===kind)) {
      for(let j=1;j<(item.points?.length||0);j++) for(const f of [.38,.61,.21,.75]) {
        const a=item.points[j-1],b=item.points[j],p=a.map((v,n)=>v+(b[n]-v)*f);
        const s=h.view().worldToScreen(p),x=s[0]+r.left,y=s[1]+r.top;
        if(x<r.left+40||x>r.right-40||y<r.top+40||y>r.bottom-40)continue;
        if(document.elementFromPoint(x,y)===c && h.hit(c,x,y)?.item?.id===item.id)
          return {x,y,id:item.id,points:JSON.stringify(item.points)};
      }
    }
    throw Error("No visible "+kind+" segment on "+doc.name);
  },kind);
}
async function start() {
  assert.ok(["light","dark"].includes(theme) && ["live","controlled"].includes(mode));
  if(directory)fs.mkdirSync(directory,{recursive:true});
  const browser=await chromium.launch({channel:"chrome",args:["--allow-file-access-from-files"]});
  try {
    const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1}), errors=[];
    page.on("pageerror",error=>errors.push(error.message)); await page.addInitScript(instrument);
    await page.goto(pathToFileURL(path.join(root,"app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(()=>globalThis.AtriumNavHost?.doc()?.kind==="pcb");
    await page.evaluate(async theme=>{
      await AtriumLazy.need(["AtriumMotion","AtriumCamera","AtriumDock","AtriumPalette"]);
      AtriumTheme.setPreset(theme); AtriumNavHost.act("fit");
    },theme);
    if(process.env.WAFFLE_MOTION_WARM_PALETTE) {
      await page.evaluate(()=>AtriumNavHost.act("quick-open"));
      await page.waitForFunction(()=>document.querySelector(".nav-palette [role=option]"));
      await page.keyboard.press("Escape");
    }
    await page.waitForFunction(() => !globalThis.AtriumMotion?.active() && !document.querySelector("#palette[open]"));
    const frames=[], cdp=await page.context().newCDPSession(page);
    const traceFile=process.env.WAFFLE_MOTION_TRACE;
    if(traceFile)await cdp.send("Tracing.start",{categories:"devtools.timeline,blink.user_timing,toplevel",transferMode:"ReturnAsStream"});
    let firstPTS=0, capture=false, board, wire, dock;
    const write=(bytes,ms)=>{
      const file=String(frames.length).padStart(5,"0")+".jpg";
      if(frames.length && ms<=frames.at(-1).ms)return;
      fs.writeFileSync(path.join(directory,file),bytes);frames.push({file,ms});
    };
    if(directory && !controlled) {
      cdp.on("Page.screencastFrame",async f=>{
        await cdp.send("Page.screencastFrameAck",{sessionId:f.sessionId}).catch(()=>{});
        if(capture) { firstPTS ||= f.metadata.timestamp; write(Buffer.from(f.data,"base64"),(f.metadata.timestamp-firstPTS)*1000); }
      });
      await cdp.send("Page.startScreencast",{format:"jpeg",quality:85,maxWidth:width,maxHeight:height,everyNthFrame:1});
    }
    const act=id=>page.evaluate(id=>AtriumNavHost.act(id),id);
    const render=()=>page.evaluate(ms=>motionMeasure.advance(ms),sample);
    const click=selector=>page.evaluate(selector=>{const target=document.querySelector(selector);if(!target)throw Error(selector);target.click();},selector);
    const boardData=()=>page.evaluate(id=>JSON.stringify(AtriumNavHost.doc().items.find(i=>i.id===id)?.points),board.id);
    // Each step addresses an ordinary editor command, control or trusted pointer gesture.
    const events=[
      [12,()=>click('.work-menu[data-menu="view"] > summary')],
      [44,()=>click('.work-menu[data-menu="view"] > summary')],
      [48,()=>act("quick-open")],
      [72,()=>page.locator(".nav-palette[open] input").fill("R1",{timeout:1500})],
      [100,()=>page.keyboard.press("Escape")],
      [105,()=>act("zoom-in")],[113,()=>act("zoom-in")],[146,()=>act("fit")],
      [184,async()=>{board=await position(page,"track");await page.mouse.move(board.x,board.y);await page.mouse.down();}],
      [187,()=>page.mouse.move(board.x+8,board.y+4)],
      [189,()=>page.mouse.move(board.x+16,board.y+9)],
      [192,()=>page.mouse.move(board.x+24,board.y+13)],
      [195,async()=>{assert.ok(await page.evaluate(()=>!!AtriumNavHost.drag()),"PCB drag follows pointer");await page.mouse.up();}],
      [210,async()=>{assert.notEqual(await boardData(),board.points,"copper moved");await act("undo");assert.equal(await boardData(),board.points);}],
      [240,async()=>{await act("redo");assert.notEqual(await boardData(),board.points);}],
      [268,()=>click('.document-tab[data-kind="schematic"]')],
      [293,async()=>{wire=await position(page,"wire");await page.mouse.move(wire.x,wire.y);await page.mouse.down();}],
      [296,()=>page.mouse.move(wire.x+7,wire.y+4)],
      [298,()=>page.mouse.move(wire.x+14,wire.y+7)],
      [300,()=>page.mouse.move(wire.x+22,wire.y+10)],
      [303,async()=>{assert.ok(await page.evaluate(()=>!!AtriumNavHost.drag()),"wire drag follows pointer");await page.mouse.up();}],
      [316,()=>act("undo")],
      [342,()=>click('.dock-tab[data-dock-tab="components"]')],
      [373,()=>click('.dock-tab[data-dock-tab="properties"]')],
      [390,()=>page.evaluate(()=>{const h=AtriumNavHost,part=h.doc().items.find(i=>i.kind==="part");h.select([part.id]);h.act("camera-zoom-selection");})],
      [438,async()=>{
        dock=await page.evaluate(()=>{
          const tab=document.querySelector('.dock-tab[data-dock-tab="components"]').getBoundingClientRect();
          const c=AtriumNavHost.canvas().getBoundingClientRect();
          return {tab:[tab.left+tab.width/2,tab.top+tab.height/2],left:[c.left+5,c.top+c.height/2],bottom:[c.left+c.width/2,c.bottom-5]};
        });
        await page.mouse.move(...dock.tab);await page.mouse.down();
      }],
      [445,()=>page.mouse.move(dock.tab[0]-55,dock.tab[1]+35,{steps:3})],
      [458,()=>page.mouse.move(...dock.left,{steps:3})],
      [480,()=>page.mouse.move(...dock.bottom,{steps:3})],
      [500,async()=>{
        assert.equal(await page.locator(".dock-preview:visible").count(),1,"the current drop zone is visible");
        await page.mouse.up();
        assert.equal(await page.locator(".dock-ghost").count(),0,"drop completes on pointer release");
      }],
      [530,()=>act("camera-pan-right")],[542,()=>act("camera-pan-right")],
      [576,()=>page.evaluate(()=>AtriumNavCommon.toast("View changed."))],
    ];
    const schedule=new Map(events);
    capture=true;await page.evaluate(c=>motionMeasure.start(c),controlled);
    const start=performance.now();
    for(let n=0;n<=638;n++) {
      if(!controlled) {const wait=start+n*sample-performance.now();if(wait>0)await sleep(wait);}
      if(schedule.has(n)){await page.evaluate(n=>motionMeasure.mark(n),n);await schedule.get(n)();}
      if(controlled) {
        await render();
        if(directory)write(Buffer.from((await cdp.send("Page.captureScreenshot",{format:"jpeg",quality:85,fromSurface:true})).data,"base64"),n*sample);
      }
    }
    if(directory&&!controlled)await cdp.send("Page.stopScreencast");capture=false;
    const stats=await page.evaluate(()=>motionMeasure.end());
    if(traceFile) {
      const complete=new Promise(resolve=>cdp.once("Tracing.tracingComplete",resolve));
      await cdp.send("Tracing.end"); const {stream}=await complete;
      const file=fs.openSync(traceFile,"w");
      try {
        while(true) {const chunk=await cdp.send("IO.read",{handle:stream});fs.writeSync(file,chunk.data);if(chunk.eof)break;}
      } finally {fs.closeSync(file);await cdp.send("IO.close",{handle:stream});}
    }
    assert.deepEqual(errors,[]);assert.equal(stats.pendingMotion,0,"motion scheduler is idle after all effects");
    if(directory){assert.ok(frames.length>20);fs.writeFileSync(path.join(directory,"frames.json"),JSON.stringify(frames));}
    console.log(JSON.stringify({theme,mode,browser:browser.version(),frames:frames.length,...stats}));
  }finally{await browser.close();}
}
start().catch(e=>{console.error(e);process.exitCode=1;});
