#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {parseArgs} = require("node:util");
const {setTimeout:wait} = require("node:timers/promises");
const {createInterface} = require("node:readline/promises");
const serveApp = require("../tests/support/browser-app-server.cjs");
const {observeInput, startTrace, summarizeFile} = require("./ci/interaction_trace.cjs");
const {prepareProject, canvasInputs, messageInputs, navigatorInputs} = require("../tests/editor/support/trace-interactions.cjs");
const {shellInputs, bomInputs, notebookInputs} = require("../tests/editor/support/trace-workflows.cjs");
const root = path.resolve(__dirname, "..");

async function record(browser, url, suite, directory) {
  const page = await browser.newPage({viewport:{width:1440, height:900}, deviceScaleFactor:1, hasTouch:suite === "canvas"});
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(10000);
  try {
    await page.addInitScript(observeInput);
    if (suite === "notebook") await require("../tests/fixtures/notebook-labs.cjs").profile(page, {"butter.tables":true});
    await page.goto(url);
    await page.waitForFunction(() => !!globalThis.AtriumNavHost && document.readyState === "complete");
    await page.addScriptTag({path:path.join(root, "tests/schematic/sch-bench-project.js")});
    const workload = await prepareProject(page);
    const cdp = await page.context().newCDPSession(page);
    const file = path.join(directory, suite + ".trace.json.gz");
    const stop = await startTrace(cdp);
    const components = {};
    async function measure(name, action, ready) {
      await page.evaluate(name => {
        window.traceLease = AtriumDiagnostics.startPerformance();
        window.waffleTraceActive = name;
        performance.mark("waffle.start." + name);
      }, name);
      try {
        await action();
        await page.evaluate(name => performance.mark("waffle.actionsEnd." + name), name);
        if (ready) await ready();
        // Include the editor's queued redraw, camera settling and deferred UI work.
        await wait(240);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      } finally {
        const rows = await page.evaluate(name => {
          performance.mark("waffle.end." + name);
          window.waffleTraceActive = false;
          window.traceLease.stop();
          return AtriumDiagnostics.performanceSnapshot().rows;
        }, name);
        (components[name] ??= []).push(rows);
      }
    }
    try {
      if (suite === "canvas") {
        await canvasInputs(page, cdp, measure, "schematic");
        await canvasInputs(page, cdp, measure, "drawing");
      } else if (suite === "notebook") {
        Object.assign(workload, await notebookInputs(page, cdp, measure));
      } else if (suite === "shell") {
        await shellInputs(page, measure);
        workload.bomLines = await bomInputs(page, measure);
        await messageInputs(page, cdp, measure);
        workload.messageRows = 5000;
        await navigatorInputs(page, measure);
      } else {
        await page.evaluate(() => { window.waffleTraceActive = "manual"; performance.mark("waffle.start.manual"); });
        const terminal = createInterface({input:process.stdin, output:process.stdout});
        try { await terminal.question("Recording the editor. Press Enter here to finish.\n"); }
        finally { terminal.close(); }
        await page.evaluate(() => { performance.mark("waffle.end.manual"); window.waffleTraceActive = false; });
      }
      await wait(150);
    } finally {
      await stop(file);
      console.log(file);
    }
    assert.deepEqual(errors, [], "editor page errors");
    const interactions = await summarizeFile(file);
    for (const name of Object.keys(components)) {
      assert.ok(Object.keys(interactions[name]?.captureDelayMs || {}).length, name + " received no trusted input");
    }
    if (suite === "shell") for (const name of ["messages-filter-type", "messages-filter-delete"]) {
      for (const type of ["keydown", "beforeinput", "input", "keyup"]) assert.equal(interactions[name].dispatchMs[type]?.n, 25, name + " " + type);
      assert.equal(interactions[name].captureDelayMs["search.input"]?.n, 25, "trusted filter input");
      assert.equal(interactions[name].resultMs["message-count"]?.n, 25, "rendered message count per keystroke");
    }
    if (suite === "shell") {
      assert.equal(interactions["bom-column-filter"].resultMs["line-count"]?.n, 10);
      // A burst can also produce intermediate counts as each character narrows the result.
      for (const [name, counter] of [["bom-search", "line-count"], ["navigator-find-component", "match-count"]]) {
        const row = interactions[name], updates = row.resultMs[counter]?.n;
        assert.ok(updates >= row.windows && updates <= row.dispatchMs.input.n, name + " rendered counts");
      }
      assert.equal(interactions["navigator-filter-result"].resultMs["match-count"]?.n, 12);
    }
    if (suite === "notebook") {
      assert.equal(interactions["notebook-column-filter-type"].captureDelayMs["search.input"]?.n, 4 * workload.filterEdits);
      for (const action of ["commit", "reset"]) {
        assert.equal(interactions["notebook-column-filter-" + action].resultMs["row-count"]?.n, workload.filterEdits, action);
      }
    }
    const report = {suite, browser:browser.version(), platform:process.platform, arch:process.arch,
      viewport:page.viewportSize(), workload, interactions, ...(suite !== "manual" && {components})};
    const summary = path.join(directory, suite + ".json");
    await fs.writeFile(summary, JSON.stringify(report, null, 2) + "\n", {flag:"wx"});
    console.log(summary + " (" + Object.keys(interactions).length + " interaction groups)");
  } finally { await page.close(); }
}

async function main() {
  const {values} = parseArgs({options:{suite:{type:"string", default:"all"}, out:{type:"string"}, help:{type:"boolean"}}});
  if (values.help) {
    console.log("node scripts/perf-interactions.cjs [--suite all|canvas|notebook|shell|manual] [--out directory]"); return;
  }
  assert.ok(["all", "canvas", "notebook", "shell", "manual"].includes(values.suite), "unknown suite " + values.suite);
  const {chromium} = require("../tests/support/playwright.cjs");
  const directory = values.out ? path.resolve(values.out) : await fs.mkdtemp(path.join(os.tmpdir(), "waffle-interactions-"));
  await fs.mkdir(directory, {recursive:true});
  const suites = values.suite === "all" ? ["canvas", "notebook", "shell"] : [values.suite];
  const existing = new Set(await fs.readdir(directory));
  for (const suite of suites) for (const ext of [".trace.json.gz", ".json"]) {
    if (existing.has(suite + ext)) throw Error("Output already exists: " + path.join(directory, suite + ext));
  }
  const server = await serveApp();
  try {
    const browser = await chromium.launch({headless:values.suite !== "manual",
      ...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"})});
    try {
      for (const suite of suites) await record(browser, server.url, suite, directory);
    } finally { await browser.close(); }
  } finally { await server.close(); }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
