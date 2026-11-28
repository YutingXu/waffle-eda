#!/usr/bin/env node
"use strict";

// Measure a trusted input through the frame displaying a specific editor result.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const {parseArgs} = require("node:util");
const {chromium} = require("../tests/support/playwright.cjs");
const serveApp = require("../tests/support/browser-app-server.cjs");
const {startTrace} = require("./ci/interaction_trace.cjs");
const {prepareProject} = require("../tests/editor/support/trace-interactions.cjs");
const {profile} = require("../tests/fixtures/notebook-labs.cjs");
const suites = {...require("../tests/editor/support/result-search.cjs"),
  ...require("../tests/editor/support/result-design.cjs"), ...require("../tests/editor/support/result-schematic.cjs"), ...require("../tests/editor/support/result-drawing.cjs"), ...require("../tests/editor/support/result-notebook.cjs")};

function arm({ready, event, name, observationMs}) {
  const state = window.waffleResult = {name, input:null, outcome:null};
  let start, lastKey;
  function key(e) { if (e.isTrusted) lastKey = e.timeStamp; }
  function sample() {
    if (window.waffleResult !== state) return;
    let detail;
    try { detail = ready(); } catch (e) { state.error = e.message; return; }
    if (!detail) {
      const elapsed = performance.now() - start;
      if (observationMs && elapsed >= observationMs) {
        performance.mark("waffle.result-missing." + name);
        state.outcome = {event:event.type,status:"no-result",observedMs:elapsed};
      } else requestAnimationFrame(sample);
      return;
    }
    const observed = performance.now();
    // A task posted from rAF runs after the frame's rendering steps.
    setTimeout(() => {
      const end = performance.now();
      performance.mark("waffle.result-frame." + name);
      state.outcome = {event:event.type,status:"completed", readyMs:observed-start, frameMs:end-start, detail};
    }, 0);
  }
  function input(e) {
    if (!e.isTrusted || (event.key && e.key !== event.key) ||
        (event.selector && !e.target.closest?.(event.selector)) ||
        (event.value != null && e.target.value !== event.value)) return;
    window.removeEventListener(event.type, input, true);
    window.removeEventListener("keydown", key, true);
    if (event.keyOrigin && lastKey == null) { state.error = "Missing trusted keydown before input"; return; }
    start = event.keyOrigin ? lastKey : e.timeStamp;
    state.input = {type:e.type, time:start, composing:e.isComposing};
    performance.mark("waffle.result-input." + name, {startTime:start});
    requestAnimationFrame(sample);
  }
  if (event.keyOrigin) window.addEventListener("keydown", key, true);
  window.addEventListener(event.type, input, true);
}

async function record(browser, url, name, out, repeat, trace) {
  const page = await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
  const errors = [], samples = {}, workload = {};
  page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(6500);
  const cleanup = [];
  let stop;
  try {
    await page.context().grantPermissions(["clipboard-read","clipboard-write"]);
    await profile(page, {"butter.query":true,"butter.datasheets":true,"butter.tables":true});
    await page.goto(url);
    await page.waitForFunction(() => globalThis.AtriumNavHost && document.readyState === "complete");
    await page.addScriptTag({path:path.resolve(__dirname,"../tests/schematic/sch-bench-project.js")});
    if (!["navigator","rename"].includes(name)) Object.assign(workload, await prepareProject(page));
    const cdp = await page.context().newCDPSession(page);
    if (trace) stop = await startTrace(cdp);
    async function measure(label, event, install, arg, action, observationMs) {
      const ready = await page.evaluateHandle(install, arg);
      try {
        await page.evaluate(arm, {ready,event,name:label,observationMs});
        await action();
        await page.waitForFunction(() => window.waffleResult.outcome || window.waffleResult.error, null, {timeout:6500});
        const state = await page.evaluate(() => window.waffleResult);
        assert.ifError(state.error ? Error(state.error) : null);
        (samples[label] ??= []).push(state.outcome);
        return state.outcome;
      } catch (e) {
        console.error(label, await page.evaluate(() => ({trace:window.waffleResult,
          focus:document.activeElement?.outerHTML.slice(0,240), visible:(document.querySelector("dialog[open]") || document.querySelector(".intel-panel:not([hidden]),.panel-datasheet:not([hidden]),.panel-navigator:not([hidden])"))?.innerText.slice(-800), extra:window.waffleDebug?.()})));
        throw e;
      } finally { await ready.dispose(); }
    }
    async function type(label, input, value, install, arg) {
      await input.focus();
      await input.press("ControlOrMeta+a");
      await measure(label, {type:"input",value,keyOrigin:true}, install, arg, () => page.keyboard.type(value));
    }
    async function clipboard(value) { await page.evaluate(s => navigator.clipboard.writeText(s), value); }
    await suites[name]({page,cdp,repeat,measure,type,clipboard,workload,cleanup});
    assert.deepEqual(errors, [], "editor page errors");
    for (const [label, rows] of Object.entries(samples)) assert.equal(rows.length, repeat, label);
    assert.ok(Object.keys(samples).length);
    const report = {suite:name,browser:browser.version(),platform:process.platform,arch:process.arch,viewport:page.viewportSize(),workload,samples};
    await fs.writeFile(path.join(out,name+".json"),JSON.stringify(report,null,2)+"\n",{flag:"wx"});
    for (const [label, rows] of Object.entries(samples)) {
      const ms = rows.filter(r=>r.status==="completed").map(r=>r.frameMs).sort((a,b)=>a-b);
      const q = p=>ms[Math.ceil(p*ms.length)-1].toFixed(1);
      console.log(label, ms.length+"/"+rows.length, ...(ms.length ? [q(.5),q(.95)] : ["no result"]));
    }
  } finally {
    try { if (stop) await stop(path.join(out,name+".trace.json.gz")); }
    finally { await page.close(); for (const fn of cleanup.reverse()) await fn(); }
  }
}

async function main() {
  const {values} = parseArgs({options:{suite:{type:"string",default:"all"},repeat:{type:"string",default:"20"},
    out:{type:"string"}, "no-trace":{type:"boolean"}, help:{type:"boolean"}}});
  if (values.help) { console.log("node scripts/perf-results.cjs [--suite all|"+Object.keys(suites).join("|")+"] [--repeat 20] [--out directory] [--no-trace]"); return; }
  const names = values.suite === "all" ? Object.keys(suites) : values.suite.split(",");
  assert.ok(names.every(n=>Object.hasOwn(suites,n)), "unknown suite");
  const repeat = Number(values.repeat);
  assert.ok(Number.isSafeInteger(repeat) && repeat > 0 && repeat <= 100);
  const out = values.out ? path.resolve(values.out) : await fs.mkdtemp(path.join(os.tmpdir(),"waffle-results-"));
  await fs.mkdir(out,{recursive:true});
  const existing = await fs.readdir(out);
  for (const n of names) assert.ok(!existing.includes(n+".json") && !existing.includes(n+".trace.json.gz"), "output already exists for "+n);
  console.log(out);
  const server = await serveApp({mime:{".html":"text/html",".css":"text/css",".js":"text/javascript",
    ".mjs":"text/javascript",".wasm":"application/wasm",".json":"application/json"}});
  try {
    const browser = await chromium.launch(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"});
    try { for (const n of names) { console.log("Running "+n); await record(browser,server.url,n,out,repeat,!values["no-trace"]); } }
    finally { await browser.close(); }
  } finally { await server.close(); }
}
main().catch(e=>{ console.error(e); process.exitCode=1; });
