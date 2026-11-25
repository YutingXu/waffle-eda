"use strict";
globalThis.AtriumFrameBenchmark = (() => {
  const settings = {baselineMs:1500, warmupMs:1500, measurementMs:8000, workload:"dense-board-v1"};
  const round = n => Number(n.toFixed(4));
  function percentiles(values){
    if(!values.length || values.some(x=>!Number.isFinite(x)||x<0))throw Error("Missing or invalid timing samples.");
    const sorted=[...values].sort((a,b)=>a-b);
    function sample(p){
      const x=p*(sorted.length-1), lo=Math.floor(x);
      return round(sorted[lo]+(sorted[Math.ceil(x)]-sorted[lo])*(x-lo));
    }
    return {p50:sample(.5),p95:sample(.95),p99:sample(.99)};
  }
  function summarize(baseline, intervals, render, probe, total){
    if(intervals.length!==render.length || intervals.length!==probe.length || intervals.length!==total.length)throw Error("Incomplete frame samples.");
    const reference=percentiles(baseline), cadence=reference.p50;
    if(cadence<=0 || baseline.length<5)throw Error("The refresh baseline could not be measured.");
    const missed=intervals.reduce((sum,dt)=>sum+Math.max(0,Math.round(dt/cadence)-1),0);
    return {refresh_baseline_ms:reference,baseline_intervals:baseline.length,baseline_hz:round(1000/cadence),
      measured_frames:intervals.length,elapsed_ms:round(intervals.reduce((a,b)=>a+b,0)),
      frame_interval_ms:percentiles(intervals),render_call_ms:percentiles(render),pointer_probe_ms:percentiles(probe),
      total_main_thread_ms:percentiles(total),estimated_missed_refresh_slots:missed,
      estimated_missed_refresh_percent:round(100*missed/(intervals.length+missed))};
  }
  const encode = report=>JSON.stringify(report,null,2)+"\n";
  function controls(phase, hasReport){
    const busy=["baseline","warmup","measuring"].includes(phase);
    return {start:!busy,stop:busy,export:!busy && hasReport};
  }
  // Each recorded interval ends after the preceding draw, including the last draw in the phase.
  function timeline(duration,{schedule,cancel,signal},frame){
    return new Promise((resolve,reject)=>{
      let first=null,previous=null,id;
      function finish(error){cancel(id);signal.removeEventListener("abort",stop);if(error)reject(error);else resolve();}
      function stop(){finish(Error(signal.reason || "Benchmark stopped."));}
      function tick(timestamp){
        try{
          if(first===null)first=timestamp;
          const elapsed=timestamp-first, dt=previous===null?null:timestamp-previous;
          const last=elapsed>=duration;
          frame(elapsed/duration,dt,last);
          if(last)return finish();
          previous=timestamp;id=schedule(tick);
        }catch(error){finish(error);}
      }
      if(signal.aborted)return stop();
      signal.addEventListener("abort",stop,{once:true});id=schedule(tick);
    });
  }
  return {settings,percentiles,summarize,encode,controls,timeline};
})();

if(typeof document!=="undefined") {
  const B=AtriumFrameBenchmark, $=id=>document.getElementById(id), canvas=$("surface");
  let controller=null,report=null;
  function update(phase,message){
    $("status").textContent=message;
    const enabled=B.controls(phase,!!report);
    $("start").disabled=!enabled.start;$("stop").disabled=!enabled.stop;
    $("download").disabled=!enabled.export;$("copy").disabled=!enabled.export;
  }
  const size=()=>{const b=canvas.getBoundingClientRect();return [b.width,b.height,window.devicePixelRatio||1];};
  function result(){
    const s=report.timing;
    $("results").hidden=false;
    $("summary").textContent=s.measured_frames+" measured frames · "+s.baseline_hz.toFixed(1)+" Hz idle cadence · "+
      s.estimated_missed_refresh_slots+" estimated missed refresh slots ("+s.estimated_missed_refresh_percent.toFixed(1)+"%)";
    $("rows").replaceChildren();
    for(const [label,v] of [["Idle frame interval",s.refresh_baseline_ms],["Workload frame interval",s.frame_interval_ms],["Render call",s.render_call_ms],["Hit and snap",s.pointer_probe_ms],["Total main-thread work",s.total_main_thread_ms]]){
      const tr=document.createElement("tr");for(const text of [label,...["p50","p95","p99"].map(p=>v[p].toFixed(2)+" ms")]){
        const td=document.createElement("td");td.textContent=text;tr.append(td);
      }$("rows").append(tr);
    }
    $("raw").value=B.encode(report);
  }
  async function run(){
    if(controller)return;
    controller=new AbortController();const control=controller, signal=control.signal;
    report=null;$("results").hidden=true;
    const startSize=size(),[w,h,dpr]=startSize, started=new Date().toISOString();
    const baseline=[],intervals=[],render=[],probe=[],total=[];
    const api={signal,schedule:cb=>requestAnimationFrame(cb),cancel:id=>cancelAnimationFrame(id)};
    function guard(){
      if(document.hidden)throw Error("Visibility changed. Run again with the window visible.");
      if(size().some((n,i)=>Math.abs(n-startSize[i])>.01))throw Error("Viewport or pixel ratio changed. Run again.");
    }
    function onHidden(){if(document.hidden)control.abort("Window hidden. Run again when visible.");}
    document.addEventListener("visibilitychange",onHidden);
    try{
      update("baseline","Measuring idle refresh cadence…");
      await B.timeline(B.settings.baselineMs,api,(_,dt)=>{guard();if(dt!==null)baseline.push(dt);});
      update("warmup","Warming the renderer…");
      const setupAt=performance.now(),{d,defs}=makeAtriumBenchmarkBoard(),view=AtriumCanvas.create(canvas);
      const opts={grid:true,layer:"Top",routing:true,hidden:new Set()};
      const b=Atrium.bounds(d.outline),bw=b[2]-b[0],bh=b[3]-b[1];
      view.fit(d,defs);const fit=view.scale();view.query(d,defs,b);
      const setupMs=performance.now()-setupAt;
      function draw(t, sample){
        const start=performance.now(),angle=2*Math.PI*t;
        const zoom=2*Math.pow(6,(1-Math.cos(angle))/2);
        view.zoom(fit*zoom/view.scale(),[w/2,h/2]);
        const target=view.worldToScreen([b[0]+bw*(.5+.24*Math.sin(angle)),b[1]+bh*(.5+.2*Math.sin(2*angle))]);
        view.pan(w/2-target[0],h/2-target[1]);
        const p=view.screenToWorld([w*(.5+.27*Math.cos(3*angle)),h*(.5+.23*Math.sin(4*angle))]);
        const beforeProbe=performance.now(),hit=view.hit(d,defs,p,opts),snap=view.snapPoint(d,defs,p,opts);
        const beforeRender=performance.now();view.render(d,defs,{...opts,selected:hit?.id,snapAt:snap});const afterRender=performance.now();
        if(sample){probe.push(beforeRender-beforeProbe);render.push(afterRender-beforeRender);total.push(afterRender-start);}
      }
      await B.timeline(B.settings.warmupMs,api,(t,dt,last)=>{guard();if(!last)draw(t,false);});
      update("measuring","Measuring eight seconds of pan, zoom and pointer probes…");
      await B.timeline(B.settings.measurementMs,api,(t,dt,last)=>{guard();if(dt!==null)intervals.push(dt);if(!last)draw(t,true);});
      const counts={};for(const item of d.items)counts[item.kind]=(counts[item.kind]||0)+1;
      report={format:"atrium-frame-benchmark",version:1,started_utc:started,settings:{...B.settings,zoom_fit_multiples:[2,12],hit_tests_per_frame:1,snap_tests_per_frame:1},
        dataset:{objects:d.items.length,by_kind:counts,board_mm:[bw,bh]},environment:{user_agent:navigator.userAgent,platform:navigator.platform||"",
          logical_processors:navigator.hardwareConcurrency??null,css_viewport:[w,h],backing_pixels:[canvas.width,canvas.height],device_pixel_ratio:dpr},
        setup_ms:Number(setupMs.toFixed(3)),timing:B.summarize(baseline,intervals,render,probe,total),
        samples_ms:{baseline,intervals,render,probe,total}};
      result();update("complete","Complete");
    }catch(error){report=null;update("stopped",error.message || String(error));}
    finally{document.removeEventListener("visibilitychange",onHidden);controller=null;}
  }
  $("start").onclick=run;$("stop").onclick=()=>controller?.abort("Stopped. Run again to collect a complete sample.");
  $("download").onclick=()=>{
    if(!report)return;const url=URL.createObjectURL(new Blob([B.encode(report)],{type:"application/json"}));
    const a=document.createElement("a");a.href=url;a.download="atrium-frame-benchmark.json";document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),5000);
  };
  $("copy").onclick=async()=>{
    if(!report)return;
    try {await navigator.clipboard.writeText(B.encode(report));$("status").textContent="Copied JSON";}
    catch{$("raw").parentElement.open=true;$("raw").focus();$("raw").select();$("status").textContent="Press ⌘C or Ctrl+C to copy the selected report.";}
  };
}
