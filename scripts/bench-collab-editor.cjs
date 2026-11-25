"use strict";
// Two real editors and the encrypted local transport. Set WAFFLE_BENCH_ROOT to compare a checkout.
// node scripts/bench-collab-editor.cjs [imported.waffle] [--sheet]
const fs = require("node:fs/promises"), path = require("node:path"), http = require("node:http");
const assert = require("node:assert/strict"), {chromium} = require("playwright-core");
const root = process.env.WAFFLE_BENCH_ROOT || path.resolve(__dirname, "..");
const kind = process.argv.includes("--sheet") ? "schematic" : "pcb";
const input = process.argv.slice(2).find(arg => arg !== "--sheet");
async function design() {
  if (input) return fs.readFile(input);
  for (const file of ["app/core/model.js", "app/library/parts.js", "tests/pcb/dense-board.js"]) require(path.join(root, file));
  const p = Atrium.project("Dense", AtriumParts.catalogue);
  p.documents[1] = makeAtriumBenchmarkBoard().d;
  return JSON.stringify(p);
}
async function serve() {
  const project = await design(), mime = {".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".wasm":"application/wasm", ".svg":"image/svg+xml"};
  const server = http.createServer(async (req, res) => {
    const name = new URL(req.url, "http://localhost").pathname;
    if (name === "/bench.waffle") return res.writeHead(200, {"Content-Type":"application/json"}).end(project);
    const file = path.resolve(root, "." + name);
    if (!["app", "extensions"].some(d => file.startsWith(path.join(root, d) + path.sep))) return res.writeHead(404).end();
    try { const bytes = await fs.readFile(file); res.writeHead(200, {"Content-Type":mime[path.extname(file)] || "application/octet-stream"}).end(bytes); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server;
}
// Observe callbacks that the application actually requested; never schedule a monitor frame.
function counters() {
  const totals = window.benchCounts = {publicationTimers:0, collaborationTimers:0, collaborationFrames:0, editorFrames:0, workerStarts:0};
  const timeout = window.setTimeout, raf = window.requestAnimationFrame, WorkerType = window.Worker;
  window.setTimeout = function (fn, ms, ...args) {
    const collab = (new Error().stack || "").includes("collab-");
    return timeout.call(this, collab ? function (...a) { totals.collaborationTimers++; if (ms === 16) totals.publicationTimers++; return fn.apply(this, a); } : fn, ms, ...args);
  };
  window.requestAnimationFrame = function (fn) {
    const collab = (new Error().stack || "").includes("collab-");
    return raf.call(this, t => { if (collab) totals.collaborationFrames++; return fn(t); });
  };
  window.Worker = class extends WorkerType { constructor(...args) { super(...args); totals.workerStarts++; } };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function quantiles(rows) {
  return Object.fromEntries(Object.keys(rows[0]).map(k => {
    const times = rows.map(row => row[k]).sort((a, b) => a - b);
    const at = p => +times[Math.ceil(times.length * p) - 1].toFixed(2);
    return [k, {n: times.length, p50: at(.5), p95: at(.95)}];
  }));
}
async function run() {
  const server = await serve(), url = "http://127.0.0.1:" + server.address().port + "/app/index.html";
  let browser;
  try {
    browser = await chromium.launch({headless:true, ...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"}),
      args:["--disable-background-timer-throttling", "--disable-renderer-backgrounding"]});
    const ctx = await browser.newContext({viewport:{width:1100, height:790}});
    await ctx.addInitScript(counters);
    const host = await ctx.newPage(), guest = await ctx.newPage(), pages = [host, guest];
    for (const page of pages) {
      await page.goto(url);
      await page.getByRole("button", {name:"Continue to editor"}).click();
      await page.evaluate(async () => { AtriumNavHost.canvas().focus(); await AtriumLazy.need("AtriumCollabPresence"); });
    }
    const key = "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456"; // ephemeral local test room
    const invite = await host.evaluate(async key => {
      const p = await (await fetch("/bench.waffle")).json();
      await AtriumNavHost.replaceProject(p, {force:true, copy:true, dirty:false});
      return AtriumCollabLive.start("local", key);
    }, key);
    await guest.evaluate(({key, invite}) => AtriumCollabLive.join("local", key, {host:invite.host, salt:invite.salt}), {key, invite});
    await guest.waitForFunction(() => !!AtriumCollabLive.session()?.r);
    const pick = await host.evaluate(kind => {
      const h = AtriumNavHost, objectKind = kind === "pcb" ? "via" : "wire";
      const doc = h.project().documents.find(d => d.kind === kind && d.items.some(i => i.kind === objectKind && !i.locked));
      const candidates = doc?.items.filter(i => i.kind === objectKind && !i.locked) || [];
      const item = candidates[0], lock = candidates[1] || doc?.items.find(i => !i.locked && i.id !== item?.id);
      if (!item || !lock) throw Error("The benchmark requires an editable " + objectKind + " and an unrelated lock target.");
      h.selectDocument(doc.id); h.select([item.id]); h.canvas().focus();
      return {id:item.id, doc:doc.id, lock:lock.id};
    }, kind);
    await guest.evaluate(doc => AtriumNavHost.selectDocument(doc), pick.doc);
    for (const page of pages) await page.evaluate(pick => {
      const h = AtriumNavHost;
      window.benchX = () => { const it = h.doc().items.find(i => i.id === pick.id); return it.points ? it.points[0][0] : it.x; };
      h.on("frame", () => benchCounts.editorFrames++);
    }, pick);
    async function lock() {
      await guest.evaluate(p => AtriumCollabLive.session().t.send("cursor", {doc:p.doc, act:"moving an object", lock:[p.lock]}), pick);
      await host.waitForFunction(id => AtriumCollabLive.peers().some(p => p.lock?.includes(id) && Date.now() - p.lockAt < 5000), pick.lock, {polling:15});
    }
    async function nudges(n, natural) {
      const rows = [];
      for (let i = 0; i < n; i++) {
        await lock();
        if (natural) await guest.evaluate(() => {
          const h = AtriumNavHost, was = benchX();
          window.receipt = {};
          const changed = h.on("change", () => {
            if (benchX() === was) return;
            changed(); receipt.apply = performance.timeOrigin + performance.now();
            const frame = h.on("frame", () => { frame(); receipt.frame = performance.timeOrigin + performance.now(); });
          });
        });
        const local = await host.evaluate(({i, natural, pick}) => {
          const h = AtriumNavHost, was = benchX(), now = () => performance.timeOrigin + performance.now();
          if (!AtriumCollabLive.peers().some(p => p.lock?.includes(pick.lock) && Date.now() - p.lockAt < 8000)) throw Error("The unrelated lock expired");
          if (natural) { window.localFrame = null; const off = h.on("frame", () => { off(); window.localFrame = now(); }); }
          const start = now(); h.executeKey("nudge", [i % 2 ? -1 : 1, 0]); const edited = now();
          if (!natural) AtriumCollabLive.flush();
          const end = now(), x = benchX();
          if (x === was) throw Error("The nudge did not move its target");
          return {start, edited, end, x};
        }, {i, natural, pick});
        await guest.waitForFunction(({x, natural}) => benchX() === x && (!natural || receipt.frame), {x:local.x, natural}, {polling:20});
        if (natural) {
          const peer = await guest.evaluate(() => receipt), frame = await host.evaluate(() => window.localFrame);
          rows.push({localFrame:frame - local.start, peerModel:peer.apply - local.start, peerFrame:peer.frame - local.start});
        } else rows.push({command:local.edited - local.start, publication:local.end - local.edited, throughPublication:local.end - local.start});
      }
      return quantiles(rows);
    }
    const active = await nudges(12, false), natural = await nudges(12, true);
    await Promise.all(pages.map(p => p.evaluate(() => AtriumPower.setMode("always"))));
    const efficiency = await nudges(8, false);
    await guest.evaluate(() => AtriumPower.host({occluded:true}));
    const occludedGuest = await nudges(8, false);
    assert.ok(await host.evaluate(id => {
      const h = AtriumNavHost, r = AtriumCollabLive.session().r, seq = r.ownSeq();
      h.edit(() => {}, "No change", [h.doc().items.find(it => it.id === id)]); AtriumCollabLive.flush();
      return r.ownSeq() === seq;
    }, pick.id));
    async function quiet() {
      const snapshot = () => Promise.all(pages.map(p => p.evaluate(() => ({...benchCounts}))));
      const before = await snapshot(); await sleep(2000); const after = await snapshot();
      return before.map((p, i) => Object.fromEntries(Object.keys(p).map(k => [k, after[i][k] - p[k]])));
    }
    await sleep(4500); const hiddenIdle = await quiet();
    await guest.evaluate(() => { AtriumPower.host({occluded:false}); AtriumPower.setMode("off"); });
    await host.evaluate(() => AtriumPower.setMode("off"));
    await sleep(2000); const visibleIdle = await quiet();
    console.log(JSON.stringify({chrome:browser.version(), kind, active, natural, efficiency, occludedGuest, hiddenIdle, visibleIdle}, null, 2));
  } finally { await browser?.close(); server.close(); }
}
run().catch(err => { console.error(err); process.exitCode = 1; });
