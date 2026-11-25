#!/usr/bin/env node
"use strict";
// Run from a product checkout with the pinned Altium corpus already cached.
// WAFFLE_BENCH_OUTPUT names a scratch directory for JSON and optional traces.
// WAFFLE_BENCH_TRACE=1 enables the compositor feedback used by the summary.
const assert=require("node:assert/strict"), fs=require("node:fs/promises"), path=require("node:path"), os=require("node:os");
const {createStaticServer}=require("../tests/support/browser-app-server.cjs");
const {createHash}=require("node:crypto"), {setTimeout:wait}=require("node:timers/promises");
const {chromium}=require(process.env.WAFFLE_PLAYWRIGHT_MODULE || "playwright-core");
const root=process.cwd(), app=path.join(root,"app"), out=process.env.WAFFLE_BENCH_OUTPUT;
const fixtures=require(path.join(root,"tests/altium-fidelity/fixtures.json")).projects;
const selected=process.argv.slice(2);
const ids=selected.length?selected:["pidp11-io-expander","snes-tap","garganturam"];
const dpr=Number(process.env.WAFFLE_BENCH_DPR || 1);
const inputHz=Number(process.env.WAFFLE_BENCH_HZ || 60);
const webglDisabled=process.env.WAFFLE_BENCH_NO_WEBGL==="1";
const testOccludedAnimation=process.env.WAFFLE_BENCH_OCCLUDE_ANIMATION==="1";
const runGpuTimer=process.env.WAFFLE_BENCH_GPU_TIMER==="1";
const expected={"pidp11-io-expander":23,"snes-tap":29,garganturam:235};
const timed=v=>v===undefined?null:Math.round(v*100)/100;
const server=createStaticServer({
  root: app,
  body: "buffer",
  mime: {".html":"text/html",".js":"application/javascript",".css":"text/css",".svg":"image/svg+xml",".wasm":"application/wasm"},
});
async function sourceOf(id) {
  const f=fixtures.find(f=>f.id===id), base=path.join(os.homedir(),".cache/waffle/altium-fidelity",id,f.revision);
  const sources=f.assets.flatMap(x=>x.members||[x]).filter(x=>x.role==="source");
  return Promise.all(sources.map(async spec=>{
    const file=path.join(base,path.basename(spec.path));
    assert.equal(createHash("sha256").update(await fs.readFile(file)).digest("hex"),spec.sha256);
    return file;
  }));
}
function setup(){
  const probe=globalThis.w3dProbe={stage:"setup", trace:false, frames:[], events:[], rafRequests:0, rafCallbacks:0, uploaded:0, updates:0, stats:{}};
  let liveFrame=null;
  function mark(name,t) { if(probe.trace) performance.mark(name, t===undefined ? undefined : {startTime:t}); }
  const viewer=()=>globalThis.Atrium3D?.viewers.values().next().value;
  const is3d=e=>e?.classList?.contains("v3d-canvas");
  const GL=WebGL2RenderingContext.prototype, own=fn=>GL[fn];
  const clear=own("clear"), draw=own("drawElementsInstanced"), upload=own("bufferData"), update=own("bufferSubData");
  GL.clear=function(...args){
    if(is3d(this.canvas)){
      const t=performance.now();
      liveFrame={t, stage:probe.stage, draw:0};
      if (probe.stage==="cold" || probe.stage==="reopen") {
        const scene=viewer()?.scene();
        Object.assign(liveFrame,{layers:!!scene?.hasLayers, bodies:scene?.parts?.filter(p=>p.bodyRecord&&!p.boundsOnly).length||0});
      }
      mark("3D-frame-"+probe.frames.length,t);
      probe.frames.push(liveFrame);
    }
    return clear.apply(this,args);
  };
  GL.drawElementsInstanced=function(...args){if(is3d(this.canvas)&&liveFrame) liveFrame.draw++; return draw.apply(this,args);};
  GL.bufferData=function(...args){if(is3d(this.canvas))probe.uploaded++; return upload.apply(this,args);};
  GL.bufferSubData=function(...args){if(is3d(this.canvas))probe.updates++; return update.apply(this,args);};
  const raf=window.requestAnimationFrame, known=new WeakMap();
  window.requestAnimationFrame=function(fn){
    if(!known.has(fn))known.set(fn,fn.name==="tick"&&new Error().stack.includes("/view3d.js:"));
    if(!known.get(fn))return raf.call(window,fn);
    probe.rafRequests++;
    return raf.call(window,t=>{probe.rafCallbacks++;fn(t);});
  };
  for(const type of ["pointermove","wheel","keydown","pointerdown","pointerup"]) window.addEventListener(type,e=>{
    const stage=probe.stage;
    const valid=(stage==="zoom"&&type==="wheel" || (stage==="orbit"||stage==="pan")&&type==="pointermove"&&e.buttons===1) && is3d(e.target);
    const open=(stage==="cold"||stage==="reopen")&&type==="keydown"&&e.key==="3";
    if(!valid&&!open)return;
    const t=performance.now();
    mark("3D-event-"+probe.events.length,e.timeStamp);
    probe.events.push({stage,type,t,time:e.timeStamp, trusted:e.isTrusted});
  },true);
  probe.read=()=>({rafRequests:probe.rafRequests,rafCallbacks:probe.rafCallbacks,frames:probe.frames.length,
    uploaded:probe.uploaded,updates:probe.updates,visible:globalThis.AtriumPower?.visible(),document:document.visibilityState});
}
function stat(xs, limit) {
  if(!xs.length)return null;
  const order=[...xs].sort((a,b)=>a-b), q=p=>order[Math.ceil(order.length*p)-1];
  return {n:order.length,p50:timed(q(.5)),p95:timed(q(.95)),worst:timed(order.at(-1)),overPct:timed(order.filter(x=>x>limit).length*100/order.length)};
}
async function readTrace(cdp) {
  const completed=new Promise(done=>cdp.once("Tracing.tracingComplete",done));
  await cdp.send("Tracing.end");
  const {stream}=await completed, chunks=[];
  for(;;){const row=await cdp.send("IO.read",{handle:stream});chunks.push(row.base64Encoded?Buffer.from(row.data,"base64"):Buffer.from(row.data));if(row.eof)break;}
  await cdp.send("IO.close",{handle:stream});
  return Buffer.concat(chunks);
}
// Measure the loaded viewport’s draw commands. Read completed queries on
// later animation frames.
async function sampleGpuDraws() {
  const viewer=Atrium3D.viewers.values().next().value, gl=viewer.R.gl;
  const ext=gl.getExtension("EXT_disjoint_timer_query_webgl2");
  if(!ext) return {available:false};
  const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
  const times=[];
  let disjoint=0;
  for(let i=0;i<30;i++) {
    await nextFrame();
    const query=gl.createQuery();
    try {
      gl.getParameter(ext.GPU_DISJOINT_EXT);
      gl.beginQuery(ext.TIME_ELAPSED_EXT,query);
      try { viewer.renderNow(); }
      finally { gl.endQuery(ext.TIME_ELAPSED_EXT); }
      for(let frames=0; !gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE); frames++) {
        if(frames>=120) throw Error("WebGL timer result did not arrive");
        await nextFrame();
      }
      if(gl.getParameter(ext.GPU_DISJOINT_EXT)) disjoint++;
      else times.push(gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6);
    } finally { gl.deleteQuery(query); }
  }
  return {available:true,draws:viewer.stats().draws,disjoint,times};
}
async function testBoard(browser,id) {
  const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:dpr,reducedMotion:"no-preference"});
  const cdp=await page.context().newCDPSession(page);
  const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  try {
    await page.addInitScript(setup);
    await page.goto("http://127.0.0.1:"+server.address().port+"/index.html");
    const sources=await sourceOf(id), opened=page.waitForEvent("filechooser");
    await page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Import from Altium or KiCad…", exact:true}).click();
    await(await opened).setFiles(sources);
    await page.locator("#document-tabs [data-kind=pcb]").first().waitFor({timeout:30000});
    await wait(900);
    await page.locator("#document-tabs [data-kind=pcb]").first().click();
    await page.waitForFunction(()=>AtriumNavHost.doc().kind==="pcb");
    await page.locator("#canvas").focus();
    assert(await page.evaluate(()=>AtriumNavHost.doc().kind==="pcb"));
    const stage=(name)=>page.evaluate(name=>{w3dProbe.stage=name;},name);
    const trace=!runGpuTimer&&process.env.WAFFLE_BENCH_TRACE==="1";
    if(trace) {
      await cdp.send("Tracing.start",{transferMode:"ReturnAsStream",traceConfig:{recordMode:"recordAsMuchAsPossible",
        includedCategories:["benchmark","cc","viz","devtools.timeline","blink.user_timing","input","latencyInfo"]}});
      await page.evaluate(()=>{w3dProbe.trace=true;});
    }
    await stage("cold");
    await page.keyboard.press("3");
    if(webglDisabled){
      const fallback=page.locator(".v3d-fallback");
      await fallback.waitFor();
      assert.match(await fallback.getAttribute("role"),/^alert$/);
      await fallback.getByRole("button",{name:"Export 3D STEP…"}).waitFor();
      await fallback.getByRole("button",{name:"Back to 2D"}).click();
      await page.locator(".v3d-canvas").waitFor({state:"detached"});
      assert.deepEqual(errors,[]);
      console.log(JSON.stringify({id, fallback:"STEP export offered and Back to 2D works"}));
      return;
    }
    await page.waitForFunction(n=>{
      const s=globalThis.Atrium3D?.viewers.values().next().value?.scene();
      return s?.hasLayers && s.parts.filter(p=>p.bodyRecord&&!p.boundsOnly).length>=n;
    },expected[id],{timeout:35000});
    await wait(220);
    const scene=await page.evaluate(()=>{
      const v=Atrium3D.viewers.values().next().value, c=v.canvas, s=v.scene(), d=AtriumNavHost.doc();
      const gl=v.R.gl, ext=gl.getExtension("WEBGL_debug_renderer_info");
      const stats=v.stats();
      return {stats, layerBuildMs:stats.layerBuildMs, bodyBuildMs:stats.bodyBuildMs, boardItems:d.items.length, cpuBytes:s.cpuBytes, heap:performance.memory?.usedJSHeapSize,
        renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null, backing:[c.width,c.height],
        css:[c.clientWidth,c.clientHeight], dpr:devicePixelRatio, bodies:s.parts.filter(p=>p.bodyRecord&&!p.boundsOnly).length,
        layerBatches:s.batches.filter(b=>b.kind==="silk"||b.kind==="copper").length,
        lighting:v.options(), camera:v.camera()};
    });
    assert.match(scene.renderer,/ANGLE.*Metal.*Apple/);
    assert.equal(scene.layerBatches,4);
    if(runGpuTimer) {
      const gpu=await page.evaluate(sampleGpuDraws);
      if(gpu.available) {
        assert(gpu.draws>0);
        assert(gpu.times.length&&gpu.times.every(t=>Number.isFinite(t)&&t>0));
      }
      assert.deepEqual(errors,[]);
      const result={id,scene,gpu,drawElapsedMs:stat(gpu.times||[],1000/inputHz)};
      await fs.writeFile(path.join(out,id+"-gpu.json"),JSON.stringify(result));
      console.log(JSON.stringify(result));
      return;
    }
    const box=await page.locator(".v3d-canvas").boundingBox(), origin=[box.x+box.width*.51,box.y+box.height*.51];
    let initial=await page.evaluate(()=>w3dProbe.read());
    await wait(500);
    const idle=await page.evaluate(()=>w3dProbe.read());
    await page.evaluate(()=>AtriumPower.host({occluded:true}));
    await wait(500);
    const hidden=await page.evaluate(()=>w3dProbe.read());
    await page.evaluate(()=>AtriumPower.host({occluded:false}));
    assert.equal(idle.frames,initial.frames);
    assert.equal(idle.rafRequests,initial.rafRequests);
    assert.equal(hidden.frames,idle.frames);
    assert.equal(hidden.rafRequests,idle.rafRequests);
    await wait(80);
    const bar=page.getByRole("toolbar",{name:"3D view",exact:true});
    const controls=await bar.getByRole("button").allTextContents();
    const top=bar.getByRole("button",{name:/View from top/});
    const bottom=bar.getByRole("button",{name:/View from bottom/});
    await stage("animation-top");
    await top.click(); await wait(340);
    await stage("animation-bottom");
    await bottom.click(); await wait(360);
    let hiddenAnimation=null;
    if(testOccludedAnimation){
      // Cover the visibility cancellation path with an animation already queued.
      await stage("hidden-animation");
      await top.click();
      const suspended=await page.evaluate(()=>{AtriumPower.host({occluded:true});return w3dProbe.read();});
      await wait(320);
      const quiet=await page.evaluate(()=>w3dProbe.read());
      hiddenAnimation={draws:quiet.frames-suspended.frames,raf:quiet.rafRequests-suspended.rafRequests};
      assert.deepEqual(hiddenAnimation,{draws:0,raf:0});
      await page.evaluate(()=>AtriumPower.host({occluded:false}));
      await wait(50);
    }
    const reset=async () => {
      await stage("setup");
      await page.evaluate(cam=>Atrium3D.viewers.values().next().value.camera(cam),scene.camera);
      await wait(180);
    };
    const warmStart=await page.evaluate(()=>w3dProbe.read());
    const pace=1000/inputHz, moves=Number(process.env.WAFFLE_BENCH_SAMPLES||90);
    async function series(send) {
      const t=performance.now(), pending=[];
      for(let i=1;i<=moves;i++){
        const due=t+i*pace;
        if (due>performance.now()) await wait(due-performance.now());
        pending.push(send(i));
      }
      await Promise.all(pending);
    }
    for(const drag of ["orbit","pan"]){
      await reset();
      await page.mouse.move(...origin);
      if (drag==="pan") await page.keyboard.down("Shift");
      await page.mouse.down({button:"left"});
      await stage(drag);
      await series(i=>page.mouse.move(origin[0]+90*Math.sin(i*.085),origin[1]+38*Math.sin(i*.088)));
      await wait(80);
      await page.mouse.up({button:"left"});
      if(drag==="pan") await page.keyboard.up("Shift");
    }
    await reset();
    const focus=await page.evaluate(()=>{
      const v=Atrium3D.viewers.values().next().value, r=v.canvas.getBoundingClientRect(), s=v.scene(), M=Atrium3D.math;
      const mat=M.matrices(v.camera(),r.width/r.height,s.sphere);
      const parts=s.parts.slice().sort((a,b)=>b.batch.indices.length-a.batch.indices.length);
      for(const q of parts){
        const p=M.project(mat.vp,q.box.slice(0,3).map((x,i)=>(x+q.box[i+3])/2),r.width,r.height);
        if(!p||p[0]<70||p[0]>r.width-70||p[1]<70||p[1]>r.height-70)continue;
        if(v.pickAt(...p,false).inst===q)return {x:p[0]+r.x,y:p[1]+r.y,ref:q.ref,triangles:q.batch.indices.length/3};
      }
      return {x:r.x+r.width*.61,y:r.y+r.height*.58,ref:null};
    });
    await page.mouse.move(focus.x,focus.y);
    await stage("zoom");
    await series(i=>cdp.send("Input.dispatchMouseEvent",{type:"mouseWheel",x:focus.x,y:focus.y,deltaX:0,deltaY:i%2?-12:12}));
    await wait(150);
    const warmEnd=await page.evaluate(()=>w3dProbe.read());
    await stage("setup");
    await page.keyboard.press("2");
    await page.locator(".v3d-canvas").waitFor({state:"detached"});
    await page.locator("#canvas").focus();
    await stage("reopen");
    await page.keyboard.press("3");
    await page.waitForFunction(n=>{
      const s=globalThis.Atrium3D?.viewers.values().next().value?.scene();
      return s?.hasLayers && s.parts.filter(p=>p.bodyRecord&&!p.boundsOnly).length>=n;
    },expected[id],{timeout:35000});
    await wait(250);
    if(trace) await fs.writeFile(path.join(out,id+"-trace.json"),await readTrace(cdp));
    const probe=await page.evaluate(()=>w3dProbe);
    const draw=probe.frames.filter(f=>f.draw);
    assert(probe.events.every(e=>e.trusted));
    const budget=1000/60;
    const loads={};
    for(const name of ["cold","reopen"]){
      const t=probe.events.find(e=>e.stage===name)?.time;
      const ready=draw.find(f=>f.stage===name&&f.layers&&f.bodies>=expected[id]);
      const first=draw.find(f=>f.stage===name);
      assert(t&&first&&ready,name);
      loads[name]={first:timed(first.t-t),details:timed(ready.t-t)};
    }
    const metrics={};
    for(const name of ["orbit","pan","zoom","animation-top","animation-bottom"]){
      const events=probe.events.filter(e=>e.stage===name), frames=draw.filter(f=>f.stage===name);
      if(!name.startsWith("animation"))assert(events.length>0,[name,events.length]);
      const sample=events.map(e=>{
        const f=frames.find(f=>f.t>=e.t); return f && f.t-e.time;
      }).filter(x=>x!=null);
      const gaps=frames.map((f,i)=>i?f.t-frames[i-1].t:0).filter(t=>t>0);
      metrics[name]={sent:name.startsWith("animation")?null:moves,events:events.length,frames:frames.length, firstDraw:stat(sample,budget),
        activeFps:timed(1000/gaps.reduce((n,t)=>n+t,0)*gaps.length), frameGaps:stat(gaps,budget+.75)};
    }
    assert.deepEqual(errors,[]);
    const result={id,scene,inputHz,loads,metrics,focus,controls,gesturesGL:{newBuffers:warmEnd.uploaded-warmStart.uploaded, bufferUpdates:warmEnd.updates-warmStart.updates},quiet:{
      idle:{draws:idle.frames-initial.frames,raf:idle.rafRequests-initial.rafRequests},
      occluded:{draws:hidden.frames-idle.frames,raf:hidden.rafRequests-idle.rafRequests,reportedVisible:hidden.visible,document:hidden.document},
      ...(hiddenAnimation?{hiddenAnimation}:{})}};
    console.log(JSON.stringify(result));
    await fs.writeFile(path.join(out,id+"-probe.json"),JSON.stringify({result,probe}));
  } finally {await page.close();}
}
(async()=>{
  assert(out,"WAFFLE_BENCH_OUTPUT must name a scratch directory");
  assert(ids.every(id=>Object.hasOwn(expected,id)),"Choose PiDP-11, SNES-Tap or GargantuRAM");
  await fs.mkdir(out,{recursive:true});
  await new Promise(done=>server.listen(0,"127.0.0.1",done));
  const browser=await chromium.launch({headless:true,channel:"chrome",
    args:["--enable-precise-memory-info", ...(webglDisabled?["--disable-webgl"]:[])]});
  try { for(const id of ids) await testBoard(browser,id); }
  finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
