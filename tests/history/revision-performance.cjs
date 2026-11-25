"use strict";

// Node 18+. An optional archive path compares two implementations on the same bytes.
// node tests/history/revision-performance.cjs --baseline /path/to/v0.3/app --runs 3
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const {appFileFrom} = require("../support/app-source-paths.cjs");
const currentApp = path.resolve(__dirname, "../../app");
const source = (app, name) => app === currentApp ? appFileFrom(app, name) : path.join(app, name);
const mib = 1024 * 1024;
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

function load(app) {
  for (const name of ["model","parts","rules","altium-rules","blocks","revision-review"]) {
    require(source(app, name + ".js"));
  }
}

function createFixtures(dir, dimension) {
  // This process never supplies its heap, CPU or RSS measurements to the report.
  load(currentApp);
  require("../pcb/dense-board.js");
  require(path.join(currentApp, "schematic/eco.js"));
  const { d } = makeAtriumBenchmarkBoard(dimension);
  d.id = "pcb-perf";
  const project = Atrium.project("Dense signal board", AtriumParts.catalogue);
  project.documents = [d];
  const firstTrack = d.items.find(i => i.kind === "track");
  const firstVia = d.items.find(i => i.kind === "via");
  const finalPart = d.items.slice().reverse().find(i => i.kind === "part");
  const counts = {};
  for (const i of d.items) counts[i.kind] = (counts[i.kind] || 0) + 1;
  const save = name => fs.writeFileSync(path.join(dir, name + ".json"), AtriumECO.serialize(project));
  save("before");
  firstTrack.width = 0.35;
  firstVia.drill = 0.2286;
  finalPart.value = "PDN_TRIM_501";
  save("sparse");
  const lastTrack = d.items.slice().reverse().find(i => i.kind === "track");
  const firstIndex = d.items.indexOf(firstTrack), lastIndex = d.items.indexOf(lastTrack);
  [d.items[firstIndex], d.items[lastIndex]] = [lastTrack, firstTrack];
  save("reordered");
  [d.items[firstIndex], d.items[lastIndex]] = [firstTrack, lastTrack];
  // Touch every item. The distinctive value is a component field, absent from row headers.
  for (const i of d.items) i.net = "EDITED_RAIL";
  save("dense");
  return { objects: d.items.length, dimensions: dimension, counts, finalPart:finalPart.id, header:finalPart.ref,
    bytes:Object.fromEntries(["before","sparse","dense","reordered"].map(n => [n,fs.statSync(path.join(dir,n+".json")).size])) };
}

async function measure(operation) {
  const began = performance.now(), cpuBefore = process.cpuUsage();
  let last = began, maxGap = 0, ticks = 0, peakUsed = process.memoryUsage().heapUsed;
  function sample() {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    peakUsed = Math.max(peakUsed, process.memoryUsage().heapUsed);
  }
  const timer = setInterval(() => { ++ticks; sample(); },1);
  let value;
  try { value = await operation(); } finally { clearInterval(timer); sample(); }
  const wall = last - began, cpu = process.cpuUsage(cpuBefore);
  return { value, stats:{wallMs:wall, cpuMs:(cpu.user+cpu.system)/1000, maxGapMs:maxGap, ticks, peakUsed} };
}

async function interactiveCase(app, dir, dom, fixture) {
  // Exercise the workbench's actual DOM handlers separately from the engine sample.
  const {pathToFileURL} = require("node:url");
  const {parseHTML} = await import(pathToFileURL(dom).href);
  const {window,document} = parseHTML("<html><body></body></html>");
  globalThis.document = document;
  globalThis.Option = class {
    constructor(label,value) {
      const option = document.createElement("option");
      option.textContent=label; option.value=value; return option;
    }
  };
  window.HTMLElement.prototype.showModal = function(){this.open=true;};
  window.HTMLElement.prototype.close = function(){this.open=false;this.onclose();};
  window.HTMLSelectElement.prototype.add = function(o){this.append(o);};
  Object.defineProperty(window.HTMLSelectElement.prototype,"value",{
    configurable:true,get(){return this._v || "";},set(v){this._v=v;}
  });
  load(app);
  for(const name of ["revision-present","revision-geometry","revision-panel"]){
    const file=source(app,name+".js");
    if(fs.existsSync(file))require(file);
  }
  const project = JSON.parse(fs.readFileSync(path.join(dir,"dense.json"),"utf8"));
  global.gc();
  const head = async() => ({revision:"0123456789abcdef",text:await fs.promises.readFile(path.join(dir,"before.json"),"utf8")});
  AtriumRevisionReview.open({project,gitHead:head});
  const dialog=document.querySelector("dialog"), buttons=()=>[...dialog.querySelectorAll("button")];
  const compare=buttons().find(b=>b.textContent.includes("HEAD"));
  assert.ok(compare);
  const opening = await measure(()=>compare.onclick());
  const rowSummaries = () => [...dialog.querySelectorAll('[role="option"], details > summary')];
  const firstSummaries = rowSummaries();
  assert.ok(firstSummaries.length > 0 && firstSummaries.length <= 40,"visible changes should be paged");
  const search = dialog.querySelector('input[type="search"]');
  assert.ok(search);
  const type = text => {search.value=text; search.dispatchEvent(new window.Event("input",{bubbles:true}));};
  const delay = t=>new Promise(done=>setTimeout(done,t));
  const input = await measure(async()=>{
    // A user replaces the partial search while its results may still be pending.
    type("pdn_"); await delay(8);
    type("pdn_trim_501");
    const deadline=performance.now()+5000;
    for(;;){
      const summaries=rowSummaries();
      if(summaries.length===1 && summaries[0].textContent.includes(fixture.header))return;
      if(performance.now()>deadline)assert.fail("typed field search did not display the single matching component");
      await delay(1);
    }
  });
  return {opening:opening.stats,typing:input.stats,initiallyRendered:firstSummaries.length};
}

async function runCase(app, dir, scenario, fixture) {
  load(app);
  const review = AtriumRevisionReview, read = name => JSON.parse(fs.readFileSync(path.join(dir,name+".json"),"utf8"));
  const baseline = read("before");
  const current = read(scenario);
  assert.notEqual(baseline.documents[0].items[0],current.documents[0].items[0]);
  globalThis.performanceInputs = [baseline,current]; // Keep both inputs alive across every post-phase GC.
  global.gc();
  const resident = process.memoryUsage();
  const initialPeakRSS = process.resourceUsage().maxRSS * 1024;
  const phases = {};
  async function phase(name, operation) {
    const {value,stats} = await measure(operation);
    const peakRSS = process.resourceUsage().maxRSS * 1024;
    global.gc();
    const live = process.memoryUsage();
    phases[name] = {
      wallMs:stats.wallMs, cpuMs:stats.cpuMs, maxGapMs:stats.maxGapMs, ticks:stats.ticks,
      sampledExtraHeapMiB:Math.max(0,stats.peakUsed - resident.heapUsed) / mib,
      retainedExtraHeapMiB:(live.heapUsed - resident.heapUsed) / mib,
      growthInPeakRssMiB:(peakRSS - initialPeakRSS) / mib,
    };
    return value;
  }
  const report = await phase("compare",() => review.compareAsync(baseline,current));
  const rowCount = scenario === "dense" ? fixture.objects : scenario === "reordered" ? 4 : 3;
  assert.equal(report.rows.length,rowCount);
  const search = (q,area="PCB",type="Changed") => review.findRowsAsync(report,area,type,q);
  const targetId = fixture.finalPart;
  function one(hit) { assert.deepEqual(hit.map(r=>r.locate),[targetId]); return hit[0]; }
  const part = report.rows.find(r=>r.locate===targetId);
  assert.ok(part);
  const fields = await phase("drillDown",() => Array.from(review.fields(report,part)));
  assert.ok(fields.some(f=>f.label==="Value" && f.before==="10 kΩ" && f.after==="PDN_TRIM_501"));
  one(await phase("fieldSearch",() => search("pdn_trim")));
  one(await phase("refinedFieldSearch",() => search("pdn_trim_501")));
  one(await phase("headerSearch",() => search(fixture.header)));
  assert.equal((await phase("absentFieldSearch",() => search("definitely_absent"))).length,0);
  assert.equal((await phase("statusFilter",() => search("","PCB","Removed"))).length,0);
  if(scenario==="reordered"){
    const order = report.rows.find(r=>r.name==="Drawing order");
    assert.ok(order);
    const diffs = await phase("orderDetails",() => Array.from(review.fields(report,order)));
    assert.equal(diffs.length,2);
  }
  return { scenario, rows:rowCount, inputHeapMiB:resident.heapUsed/mib, inputRssMiB:resident.rss/mib,
    peakRssAfterInputsMiB:initialPeakRSS/mib, phases };
}

function fresh(args) {
  const r = spawnSync(process.execPath,["--expose-gc",__filename,...args],{encoding:"utf8",maxBuffer:10*mib});
  if(r.status!==0)throw Error(r.stderr || r.stdout || String(r.error));
  return JSON.parse(r.stdout);
}

function median(values) {
  const a = values.slice().sort((x,y)=>x-y);
  const mid = Math.floor(a.length/2);
  return a.length % 2 ? a[mid] : (a[mid-1]+a[mid])/2;
}

function display(result) {
  const {implementation,scenario,runs} = result;
  console.log("\n"+implementation+" / "+scenario+" ("+runs[0].rows+" change rows)");
  console.log("Post-parse baseline: "+median(runs.map(r=>r.inputHeapMiB)).toFixed(1)+" MiB heap, "+
    median(runs.map(r=>r.inputRssMiB)).toFixed(1)+" MiB resident.");
  console.log("phase                 wall ms    CPU ms    gap ms   ticks  peak heap+ MiB  retained+ MiB  peak RSS growth MiB");
  for(const name of Object.keys(runs[0].phases)) {
    const col = field => median(runs.map(r => r.phases[name][field]));
    const row = ["wallMs","cpuMs","maxGapMs","ticks","sampledExtraHeapMiB","retainedExtraHeapMiB","growthInPeakRssMiB"]
        .map((m,i)=>col(m).toFixed(i===3?0:2).padStart([9,10,10,8,16,15,21][i]));
    console.log(name.padEnd(19)+row.join(""));
  }
}

async function main() {
  if(arg("--ui-child")){
    const result=await interactiveCase(arg("--ui-child"),arg("--dir"),arg("--dom"),JSON.parse(arg("--fixture")));
    process.stdout.write(JSON.stringify(result));
    return;
  }
  if(arg("--child")) {
    const result = await runCase(arg("--child"),arg("--dir"),arg("--scenario"),JSON.parse(arg("--fixture")));
    process.stdout.write(JSON.stringify(result));
    return;
  }
  const runs = Number(arg("--runs","3")), dimension = Number(arg("--dimension","160"));
  assert.ok(Number.isInteger(runs) && runs > 0 && Number.isInteger(dimension) && dimension >= 4);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"atrium-revision-perf-"));
  try {
    const fixture = createFixtures(dir,dimension), cases = [], ui = [], base = arg("--baseline");
    const versions = base ? [["baseline",path.resolve(base)]] : [];
    if(!process.argv.includes("--baseline-only"))versions.push(["current",currentApp]);
    assert.ok(versions.length);
    const environment = {node:process.version,platform:os.platform(),arch:os.arch(),cpu:os.cpus()[0]?.model,runs};
    console.log(JSON.stringify({environment, fixture}));
    for(const scenario of ["sparse","dense","reordered"]){
      const results=versions.map(([implementation,app])=>({implementation,app,scenario,runs:[]}));
      // Alternate order within the pair so thermal drift needn't systematically favour a version.
      for(let i=0;i<runs;i++)for(const result of (i%2?results.slice().reverse():results)){
        result.runs.push(fresh(["--child",result.app,"--dir",dir,"--scenario",scenario,"--fixture",JSON.stringify(fixture)]));
      }
      for(const result of results){cases.push(result);display(result);}
    }
    const dom=arg("--dom");
    if(dom){
      for(const [implementation,app] of versions)ui.push({implementation,app,runs:[]});
      for(let i=0;i<runs;i++)for(const result of (i%2?ui.slice().reverse():ui)){
        result.runs.push(fresh(["--ui-child",result.app,"--dir",dir,"--dom",path.resolve(dom),"--fixture",JSON.stringify(fixture)]));
      }
    }
    for(const {implementation,runs:samples} of ui){
      for(const [name,label] of [["opening","HEAD to first page"],["typing","Two input events to filtered result"]]){
        const value = f=>median(samples.map(s=>s[name][f])).toFixed(2);
        console.log(implementation+" / "+label+": "+value("wallMs")+" ms wall, "+value("cpuMs")+" ms CPU, "+value("maxGapMs")+" ms max foreground gap (LinkeDOM)");
      }
    }
    const out = arg("--json");
    if(out)fs.writeFileSync(out,JSON.stringify({environment,fixture,cases,ui},null,2)+"\n");
    console.log("\nMedians across fresh processes. Peak heap sampled each 1 ms timer and at operation return. Extra heap is relative to both parsed inputs after GC. Peak RSS growth is above the process high-water mark after parsing. Forced GCs are outside phase timings. Gap includes foreground work and GC pauses.");
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
