"use strict";

// Run with the CI playwright-core and Chrome: node tests/editor/browser-editing-soak.js [--ci] [--pressure] [--report FILE].
// Two isolated editors stay open for the entire measured session. All pauses use the real clock.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {setTimeout: sleep} = require("node:timers/promises");
const {performance} = require("node:perf_hooks");
const {once} = require("node:events");
const {parseArgs} = require("node:util");
const {chromium} = require("../support/playwright.cjs");
const {openSoakPage, collectHeap} = require("./browser-soak.js");
const {assess, percentile} = require("./soak-trends.js");
const {projectZIP, readProjectZIP} = require("../support/browser-native-project.cjs");
const {projectFromRecords} = require("../support/native-cad.cjs");

const models = ["board", "schematic"];
const frameCount = 24;
const mib = 1048576;

async function openModel(browser, model, dir, pressure) {
  const state = await openSoakPage(browser, pressure), {page} = state;
  const workers = {started: 0, closed: 0, peak: 0};
  page.on("worker", worker => {
    workers.started++;
    workers.peak = Math.max(workers.peak, page.workers().length);
    worker.on("close", () => workers.closed++);
  });
  await page.getByRole("button", {name: "Continue to editor", exact: true}).click();
  const fixture = model === "board" ? "../pcb/dense-board.js" : "../schematic/sch-bench-project.js";
  await page.addScriptTag({path: path.join(__dirname, fixture)});
  const info = await page.evaluate(async model => {
    const h = AtriumNavHost;
    await AtriumLazy.need("AtriumUndoStore");
    let project, focus, stats;
    if (model === "board") {
      await AtriumLazy.need("AtriumPolygonPour");
      const {d} = makeAtriumBenchmarkBoard();
      project = Atrium.project("Soak board", AtriumParts.catalogue);
      project.documents = [d];
      stats = {boardObjects: d.items.length, pours: 1};
      d.items.push(AtriumPolygonPour.make([[1, 1], [18, 1], [18, 16], [1, 16]], {id: "soak-pour", layer: "Top", net: "GND", removeDeadCopper: false}));
      focus = d.id;
      // Exercise the explicit Repour All transaction on a changed board.
      AtriumPolygonPour.live.setMode("manual");
    } else {
      const generated = makeAtriumSchBenchProject({sheets: 100});
      project = generated.project;
      stats = generated.stats;
      focus = "sheet-s1";
    }
    await h.replaceProject(project, {force: true});
    h.selectDocument(focus);
    h.zoomTo(model === "board" ? [0, 0, 50, 40] : [10, 10, 190, 135]);
    return {stats, name: project.name, baseline: JSON.stringify(project)};
  }, model);
  // Compare reads its baseline revision as a Format 2 project ZIP.
  const baseline = path.join(dir, model + "-baseline.zip");
  await fs.writeFile(baseline, (await projectZIP(JSON.parse(info.baseline))).buffer);
  if (model === "board") assert.equal(info.stats.boardObjects, 25600);
  else assert.equal(info.stats.sheets, 100);
  const budget = await page.evaluate(() => AtriumUndoStore.stats().budget);
  assert.equal(budget, (pressure ? 4 : 64) * mib, "editor undo budget");
  return {...state, pressure, model, baseline, name: info.name, fixture: info.stats, workers, visited: new Set(),
    counts: {edits: 0, undos: 0, redos: 0, repours: 0, drcs: 0, comparisons: 0, saves: 0, autosaves: 0, frames: 0, sheetPasses: 0}, samples: []};
}

async function edit(s, round, ci) {
  const result = await s.page.evaluate(async ({model, round, ci, pressure}) => {
    const h = AtriumNavHost, sheets = h.project().documents.filter(d => d.kind === "schematic");
    // Visit all 100 sheets in the hour. CI revisits 12 evenly spread sheets in the same full project.
    const working = ci && sheets.length ? Array.from({length: 12}, (_, i) => sheets[Math.round(i * (sheets.length - 1) / 11)]) : sheets;
    const docs = model === "board" ? [h.doc().id] : Array.from({length: 3}, (_, i) => working[(round * 3 + i) % working.length].id);
    // After the first Save the project is a Format 2 folder session: its private drafts keep the edits.
    const beforeSave = h.folderProject?.() ? {drafts: h.folderProject().draftMetrics().writes} : {saves: AtriumAutosave.stats().saves};
    let marker, operations = 0, depth = 0;
    const position = i => i.points ? i.points[0][0] : i.x;
    for (const id of docs) {
      const previousPass = globalThis.AtriumInsightsUI?.lastPass();
      h.selectDocument(id);
      const items = h.doc().items;
      let targets;
      if (model === "board") {
        const via = items.find(i => i.kind === "via" && i.x > 1 && i.x < 15 && i.y > 1 && i.y < 12);
        targets = pressure ? [via] : [via, ...items.slice(0, 9)];
      } else {
        targets = items.filter(i => i.kind === "part").slice(0, pressure ? 1 : 3);
      }
      const moves = [];
      function verify(move, expected, action) {
        const item = h.doc().items.find(i => i.id === move.item);
        if (!item || position(item) !== expected) throw Error(action + " did not restore " + move.item);
      }
      for (const [index, target] of targets.entries()) {
        h.select([target.id]);
        const x = position(target), sign = (round + index) % 2 ? -1 : 1;
        // Eleven via positions ensure each six-round Repour All starts with different copper.
        const next = model === "board" && index === 0 ? (24 + round % 11) / 10 : Math.round((x + sign * .2) * 100) / 100;
        h.edit(() => {
          if (target.points) target.points = target.points.map(([px, py]) => [Math.round((px + next - x) * 1000) / 1000, py]);
          else target.x = next;
        }, "Move " + (target.ref || target.kind), [target]);
        const move = {doc: id, item: target.id, x: next, before: x};
        verify(move, next, "Move");
        moves.push(move);
      }
      for (const move of [...moves].reverse()) { h.act("undo"); verify(move, move.before, "Undo"); }
      for (const move of moves) { h.act("redo"); verify(move, move.x, "Redo"); }
      if (model === "schematic") {
        // Stay on the sheet while the editor finishes its normal deferred analysis.
        const end = performance.now() + 20000;
        while (true) {
          const pass = globalThis.AtriumInsightsUI?.lastPass();
          if (pass?.docId === id && pass !== previousPass) break;
          if (performance.now() >= end) throw Error("Sheet analysis did not finish on " + id);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      marker = moves.at(-1);
      operations += moves.length;
      depth = Math.max(depth, moves.length);
    }
    h.select([]);
    return {docs, marker, beforeSave, operations, depth};
  }, {model: s.model, round, ci, pressure: s.pressure});
  result.docs.forEach(id => s.visited.add(id));
  if (s.model === "schematic") s.counts.sheetPasses += result.docs.length;
  s.maxUndoChain = Math.max(s.maxUndoChain || 0, result.depth);
  for (const key of ["edits", "undos", "redos"]) s.counts[key] += result.operations;
  return result;
}

async function repour(s) {
  const page = s.page;
  const previous = await page.evaluate(() => {
    const h = AtriumNavHost, pp = AtriumPolygonPour;
    if (pp.current(h.doc(), h.defs(), {project: h.project()})) throw Error("Repour workload must start with stale copper");
    const at = pp.reuse.last?.at ?? 0;
    h.act("repour");
    return at;
  });
  await page.waitForFunction(previous => {
    const h = AtriumNavHost, d = h.doc();
    return AtriumPolygonPour.reuse.last?.at > previous && d.pcbDrawing?.pours?.some(p => p.polygon === "soak-pour") &&
      AtriumPolygonPour.current(d, h.defs(), {project: h.project()});
  }, previous, {timeout: 60000, polling: 300});
  s.counts.repours++;
}

async function drc(s) {
  const page = s.page;
  await page.evaluate(() => AtriumNavHost.act("drc"));
  await page.waitForFunction(() => globalThis.AtriumMessages?.isOpen() &&
    AtriumMessages.messages().some(m => m.group === "DRC") && /rule violation/.test(document.querySelector("#status").textContent),
    null, {timeout: 60000, polling: 250});
  await page.evaluate(() => AtriumMessages.close());
  s.counts.drcs++;
}

async function compare(s) {
  const page = s.page;
  await page.evaluate(() => AtriumNavHost.act("compare"));
  const dialog = page.getByRole("dialog", {name: "Change table"});
  // Give the native file picker its real baseline file. A short-lived DevTools session releases
  // the browser-side reference to the removed input after every selection.
  const picker = await page.context().newCDPSession(page);
  try {
    await picker.send("Page.enable");
    await picker.send("Page.setInterceptFileChooserDialog", {enabled: true});
    const [opened] = await Promise.all([
      once(picker, "Page.fileChooserOpened", {signal: AbortSignal.timeout(15000)}),
      dialog.getByRole("button", {name: "Choose project ZIP…"}).click()
    ]);
    await picker.send("DOM.setFileInputFiles", {backendNodeId: opened[0].backendNodeId, files: [s.baseline]});
  } finally { await picker.detach(); }
  const status = dialog.getByRole("status");
  await status.filter({hasText: /Working design · \d+–\d+ of \d+ changes?/}).waitFor({timeout: 120000});
  await dialog.getByRole("button", {name: "Done", exact: true}).click();
  s.counts.comparisons++;
}

function verifySaved(project, s, marker) {
  assert.equal(project.name, s.name);
  const d = project.documents.find(d => d.id === marker.doc);
  const item = d?.items.find(i => i.id === marker.item);
  assert.equal(item?.points?.[0][0] ?? item?.x, marker.x, "saved file contains the actual edit");
  if (s.model === "board") assert.equal(d.items.length, 25601);
  else assert.equal(project.documents.filter(d => d.kind === "schematic").length, 100);
}

async function autosave(s, editResult, readBack) {
  const page = s.page;
  // Editing starts the app's debounce and its IndexedDB writer; never force a flush.
  await page.waitForFunction(before => {
    if (before.drafts !== undefined) {
      const d = AtriumNavHost.folderProject().draftMetrics();
      if (d.error) throw Error(d.error);
      // The first edit writes a draft after the debounce; later drafts follow the autosave interval
      // (Preferences › General), so a queued write also counts.
      return d.writes > before.drafts || d.pending;
    }
    const a = AtriumAutosave.stats();
    if (a.error) throw Error(a.error);
    return a.saves > before.saves && a.urgent === false;
  }, editResult.beforeSave, {timeout: 60000, polling: 350});
  // A recovery snapshot reads back as the edited project; a folder draft is confirmed by its write or queued write.
  if (readBack && editResult.beforeSave.drafts === undefined) {
    const recovered = await page.evaluate(async () => {
      const list = (await AtriumAutosave.list()).filter(m => m.slot === AtriumAutosave.slot() && m.reason === "auto");
      const latest = list.sort((a, b) => b.ts - a.ts)[0];
      if (!latest) throw Error("Missing automatic recovery snapshot");
      return (await AtriumAutosave.read(latest.id)).text;
    });
    verifySaved(JSON.parse(recovered), s, editResult.marker);
  }
  s.counts.autosaves++;
}

async function save(s, marker) {
  const [download] = await Promise.all([
    s.page.waitForEvent("download", {timeout: 60000}),
    // Save All: once the project is a folder session, Save writes only the active document (as in Altium).
    s.page.evaluate(() => AtriumNavHost.act("save-all"))
  ]);
  // A browser Save downloads the project as a Format 2 ZIP; read it back through the native records.
  assert.match(download.suggestedFilename(), /\.zip$/);
  const {manifest, files} = await readProjectZIP(await fs.readFile(await download.path()));
  verifySaved(projectFromRecords(manifest, name => files.get(name), {nativeAssets: true}), s, marker);
  await download.delete();
  await s.page.waitForFunction(() => !AtriumNavHost.isDirty());
  s.counts.saves++;
}

async function sample(s, start) {
  const {page, cdp} = s;
  // Render the same view and alternating pan at every checkpoint, with a real refresh between moves.
  const frames = await page.evaluate(async ({model, frameCount}) => {
    const h = AtriumNavHost;
    if (model === "schematic") h.selectDocument("sheet-s1");
    if (document.visibilityState !== "visible") throw Error("Cannot sample a hidden canvas");
    const next = () => new Promise(resolve => requestAnimationFrame(resolve));
    await next();
    let last = await next();
    const result = [];
    for (let i = 0; i < frameCount; i++) {
      h.view().pan(i % 2 ? -2 : 2, 0);
      h.redraw();
      const now = await next();
      result.push(Math.round((now - last) * 100) / 100);
      last = now;
    }
    return result;
  }, {model: s.model, frameCount});
  const heapBytes = await collectHeap(cdp);
  const dom = await cdp.send("Memory.getDOMCounters");
  // Detach the inspector immediately so its node identifiers cannot retain objects into the next round.
  const inspector = await page.context().newCDPSession(page);
  let detached;
  try {
    await inspector.send("DOM.enable");
    const {detachedNodes} = await inspector.send("DOM.getDetachedDomNodes");
    detached = detachedNodes.reduce((count, tree) => count + tree.retainedNodeIds.length, 0);
  } finally { await inspector.detach(); }
  const u = await page.evaluate(model => {
    const {bytes, shadow, budget, records} = AtriumUndoStore.stats(), {history, future} = AtriumNavHost.undoSteps();
    const result = {undoBytes: bytes, shadowBytes: shadow, undoBudget: budget, records, steps: history.length, redoSteps: future.length};
    if (model === "schematic") {
      const engine = AtriumInsightsUI.engine();
      result.indexedSheets = AtriumNavHost.project().documents.filter(d => d.kind === "schematic" && engine.state(d.id)).length;
    }
    return result;
  }, s.model);
  const row = {t: (performance.now() - start) / 1000, heapMiB: heapBytes / mib,
    domNodes: dom.nodes, detachedNodes: detached, documents: dom.documents, listeners: dom.jsEventListeners,
    workers: page.workers().length, ...u, frames, frameP95: percentile(frames, .95)};
  if (s.model === "schematic") row.settledSheets = s.visited.size;
  s.samples.push(row);
  s.counts.frames += frames.length;
  return row;
}

async function exercise(s, round, start, ci) {
  const change = await edit(s, round, ci);
  const phase = round % 6;
  if (s.model === "board" && phase === 0) await repour(s);
  if (s.model === "board" && phase === 1) await drc(s);
  await autosave(s, change, phase === 2);
  if (phase === 2) await save(s, change.marker);
  if (phase === (s.model === "board" ? 3 : 4)) await compare(s);
  const row = await sample(s, start);
  console.log(s.model, "round", round + 1, "elapsed", row.t.toFixed(1), "heap MiB", row.heapMiB.toFixed(1),
    "DOM", row.domNodes, "detached", row.detachedNodes, "undo bytes", row.undoBytes, "workers", row.workers, "frame p95 ms", row.frameP95);
}

async function main() {
  const {values: {ci, pressure = false, report: output, help}} = parseArgs({options: {
    ci: {type: "boolean"}, pressure: {type: "boolean"}, report: {type: "string"}, help: {type: "boolean", short: "h"}
  }});
  if (help) { console.log("node tests/editor/browser-editing-soak.js [--ci] [--pressure] [--report FILE]   (60 minutes, or 5 with --ci)"); return; }
  const seconds = ci ? 300 : 3600, cadence = ci ? 12000 : 30000;
  const browser = await chromium.launch({headless: true, ...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: "chrome"}),
    args: ["--allow-file-access-from-files"]});
  let dir;
  const sessions = [];
  const report = {chrome: browser.version(), requestedSeconds: seconds, cadenceSeconds: cadence / 1000, undoBudgetMiB: pressure ? 4 : 64, fixtures: {}, results: {}};
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "waffle-editing-soak-"));
    for (const model of models) {
      const s = await openModel(browser, model, dir, pressure);
      sessions.push(s);
      report.fixtures[model] = s.fixture;
    }
    const start = performance.now(), end = start + seconds * 1000;
    report.started = new Date().toISOString();
    console.log("START", report.started, JSON.stringify(report.fixtures), "Chrome", report.chrome, "duration", seconds);
    let round = 0;
    while (true) {
      for (const s of sessions) await exercise(s, round, start, ci);
      round++;
      if (sessions.every(s => s.samples.at(-1).t >= seconds)) break;
      const next = Math.max(start + round * cadence, performance.now() + 1000);
      await sleep(Math.max(0, Math.min(next, end) - performance.now()));
    }
    report.elapsedSeconds = (performance.now() - start) / 1000;
    report.ended = new Date().toISOString();
    for (const s of sessions) {
      const stepLimit = await s.page.evaluate(() => AtriumUndoStore.limits.MAX_STEPS);
      const summary = assess(s.samples, seconds, s.model, stepLimit);
      report.results[s.model] = {...summary, counts: s.counts, visitedDocuments: s.visited.size, maxUndoChain: s.maxUndoChain, workerLifecycle: s.workers};
      const {failures} = summary;
      for (const key of ["edits", "undos", "redos", "comparisons", "saves", "autosaves", "frames",
        ...(s.model === "board" ? ["repours", "drcs"] : [])]) if (!s.counts[key]) failures.push("no completed " + key);
      if (s.workers.started - s.workers.closed !== s.page.workers().length) failures.push("worker lifecycle count disagrees with active workers");
      if (s.model === "schematic") {
        const expected = ci ? 12 : 100;
        const full = s.samples.find(v => v.settledSheets === expected && v.indexedSheets >= expected);
        report.results[s.model].allSheetsSettledSecond = full?.t ?? null;
        if (!full || full.t > seconds / 2) failures.push("the working sheets did not finish analysis before the measured final half");
      }
      if (s.model === "board" && !s.workers.started) failures.push("no dedicated worker was observed");
      if (s.samples.at(-1).t < seconds) failures.push("model stopped before the requested duration");
      failures.push(...s.errors);
    }
    console.log("RESULT", JSON.stringify(report));
    const failures = Object.entries(report.results).flatMap(([model, v]) => v.failures.map(x => model + ": " + x));
    assert.deepEqual(failures, []);
  } finally {
    try {
      if (output) await fs.writeFile(output, JSON.stringify({...report, samples: Object.fromEntries(sessions.map(s => [s.model, s.samples]))}, null, 2) + "\n");
    } finally {
      try { await browser.close(); }
      finally { if (dir) await fs.rm(dir, {recursive: true, force: true}); }
    }
  }
}

if (require.main === module) main().catch(e => {console.error(e); process.exitCode = 1;});
