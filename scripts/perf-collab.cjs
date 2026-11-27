"use strict";
// Live-session baseline on the shared benchmark board (tests/pcb/dense-board.js, 25,600 objects):
// two real editors in headless Chrome, per transport. Built from scripts/bench-collab-editor.cjs
// (page server, init-script counters, quantiles) and scripts/collab-smoke.cjs (relay paths); the
// relay is collab/relay/waffle_relay.py on 127.0.0.1. Numbers only, no budgets yet.
//
//   node scripts/perf-collab.cjs [--transports local,relay,relay-only] [--reps 8] [--idle 30]
//                                [--skip cost,latency,wire,idle,drop,stall,trim] [--insights] [--json] [--budgets]
//   scripts/perf-collab.sh ...   (finds node and playwright-core; RUNS=n repeats and reports spread)
//
// Measured, per transport:
//   cost     main-thread cost of each local edit kind on the host while the session is live:
//            the editor command, the publication (AtriumCollabLive.flush: Undo journal range,
//            CRDT commit, sealing and queueing), and the CRDT commit alone with whether the editor
//            passed scoped `updates` and whether the full diff(next) ran; and on the guest the cost
//            of applying it (receive, preparePatch with its project materialisation and validation,
//            the editor patch) and renderer CPU (DevTools TaskDuration) for both pages.
//   latency  local edit to the guest's first frame showing it, with the natural 16 ms publication.
//   join     guest join to adopted project, snapshot bytes and the bytes the host sent.
//   idle     after join and after the edits: time until both editors are quiet, then wake-ups per
//            second (every timer, interval, frame and idle callback, edit-pipeline jobs named) and
//            renderer CPU with both editors connected and nobody editing.
//   drop     the relay stops (SIGSTOP) with an edit from each side in a socket that still looks
//            open, then dies; both edit offline; the relay returns on the same port: reconnect and
//            convergence times, and whether every edit arrived on both sides.
//   stall    the relay stops for 25 s without closing (a half-open connection): does either editor
//            notice, and does an edit still arrive (it can on a direct data channel)?
//   trim     (relay-only) a guest that deletes 4,200 objects while disconnected, past the CRDT's
//            bounded log (LIMITS.log): whether the host receives them after reconnecting.
//   scope    (with cost) what each remote edit makes the guest's editor re-check: whether the patch
//            recorded the Undo journal with a full comparison (undo-store stats().full), how many
//            items the journal range names for the board (the change set online DRC, redraw,
//            minimap, pours and Design Insights read), and how many items online DRC passed to
//            AtriumRules.drc (25,600 = the whole board).
//   wire     messages and bytes the host sends: per edit kind (cost pass), and per second while the
//            pointer travels with no edit, while an object is dragged before the drop, and for a
//            burst of 20 nudges; plus the operation keys and bytes each edit kind publishes.
// --budgets fails the run (exit 3) when a per-edit budget is missed (scripts/perf-collab.sh applies
// the same budgets to the median of several runs).
// Design insights are switched off (--insights keeps them): on this board their idle pass alone keeps
// a renderer busy for minutes, with or without a session, which would hide the session's own cost.
// The local transport shares one renderer process between both pages: its CPU figures are combined.
// Nothing listens beyond 127.0.0.1 and nothing external is contacted.
const fs = require("node:fs/promises"), path = require("node:path"), http = require("node:http");
const {spawn} = require("node:child_process");
const {chromium} = require("playwright-core");
const root = process.env.WAFFLE_BENCH_ROOT || path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : d; };
const transports = opt("transports", "local,relay,relay-only").split(",").filter(Boolean);
const reps = Math.max(2, +opt("reps", 8) || 8), idleSeconds = Math.max(5, +opt("idle", 30) || 30);
const skip = new Set(opt("skip", "").split(",").filter(Boolean));
const asJSON = args.includes("--json"), insightsOn = args.includes("--insights");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...a) => { if (!asJSON) console.error("perf-collab:", ...a); };

async function design() {
  for (const file of ["app/core/model.js", "app/library/parts.js", "tests/pcb/dense-board.js"]) require(path.join(root, file));
  const p = Atrium.project("Dense", AtriumParts.catalogue);
  p.documents[1] = makeAtriumBenchmarkBoard().d;
  return JSON.stringify(p);
}
async function serve(project) {
  const mime = {".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".wasm":"application/wasm", ".svg":"image/svg+xml", ".json":"application/json"};
  const server = http.createServer(async (req, res) => {
    const name = new URL(req.url, "http://localhost").pathname;
    if (name === "/bench.waffle") return res.writeHead(200, {"Content-Type":"application/json"}).end(project);
    const file = path.resolve(root, "." + decodeURIComponent(name));
    if (!["app", "extensions"].some(d => file.startsWith(path.join(root, d) + path.sep))) return res.writeHead(404).end();
    try { const bytes = await fs.readFile(file); res.writeHead(200, {"Content-Type":mime[path.extname(file)] || "application/octet-stream"}).end(bytes); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server;
}
// The relay on loopback; restartable on the same port for the outage check.
function relay(port = 0) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-B", path.join(root, "collab/relay/waffle_relay.py"), "--host", "127.0.0.1", "--port", String(port), "--quiet"], {stdio: ["ignore", "pipe", "pipe"]});
    let out = "";
    const fail = setTimeout(() => { proc.kill("SIGKILL"); reject(Error("the relay did not start: " + out)); }, 10000);
    proc.stdout.on("data", d => {
      out += d;
      const m = /ws:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) { clearTimeout(fail); resolve({proc, port: +m[1], url: "ws://127.0.0.1:" + m[1]}); }
    });
    proc.stderr.on("data", d => { out += d; });
    proc.on("exit", code => { clearTimeout(fail); if (!/ws:\/\//.test(out)) reject(Error("the relay exited (" + code + "): " + out)); });
  });
}
const killRelay = r => new Promise(resolve => { if (r.proc.exitCode !== null) return resolve(); r.proc.once("exit", resolve); r.proc.kill("SIGKILL"); });

// Init script: every wake-up the page's code requests (as tests/integration/perf-sch.js counts them,
// but without replacing requestAnimationFrame) and the bytes this page sends on any carrier.
function counters() {
  const wake = window.pcWake = {counting: false, timeout: 0, interval: 0, raf: 0, idle: 0, sources: new Map()};
  const site = () => (new Error().stack || "").split("\n").slice(3, 4).map(l => l.trim().replace(/^at /, "").replace(/\(?https?:\/\/[^)]*\/([^/)]+)\)?/, "$1")).join("").slice(0, 120);
  const count = (kind, s) => { if (!wake.counting) return; wake[kind]++; wake.sources.set(kind + " " + s, (wake.sources.get(kind + " " + s) || 0) + 1); };
  const st = window.setTimeout, si = window.setInterval, raf = window.requestAnimationFrame, ric = window.requestIdleCallback;
  window.setTimeout = function (f, ms, ...a) { const s = wake.counting ? site() : ""; return st.call(window, typeof f === "function" ? (...x) => { count("timeout", s); return f(...x); } : f, ms, ...a); };
  window.setInterval = function (f, ms, ...a) { const s = site(); return si.call(window, typeof f === "function" ? (...x) => { count("interval", s); return f(...x); } : f, ms, ...a); };
  window.requestAnimationFrame = function (f) { const s = wake.counting ? site() : ""; return raf.call(window, t => { count("raf", s); return f(t); }); };
  if (ric) window.requestIdleCallback = function (f, o) { const s = wake.counting ? site() : ""; return ric.call(window, d => { count("idle", s); return f(d); }, o); };
  const bytes = window.pcBytes = {ws: 0, dc: 0, bc: 0}, sent = window.pcMessages = {ws: 0, dc: 0, bc: 0};
  const size = d => typeof d === "string" ? d.length : d?.byteLength || 0;
  const wrap = (proto, key) => { if (!proto?.send && !proto?.postMessage) return; const name = proto.send ? "send" : "postMessage", f = proto[name];
    proto[name] = function (d, ...a) { sent[key]++; bytes[key] += size(typeof d === "object" && d && !d.byteLength ? JSON.stringify(d) : d); return f.call(this, d, ...a); }; };
  wrap(window.WebSocket?.prototype, "ws"); wrap(window.RTCDataChannel?.prototype, "dc"); wrap(window.BroadcastChannel?.prototype, "bc");
  // Name the edit pipeline's jobs (app/editor/edit-pipeline.js) among the wake-up sources.
  let pipeline;
  Object.defineProperty(window, "AtriumEditPipeline", {configurable: true, get: () => pipeline, set(v) {
    pipeline = v && typeof v.create === "function" ? Object.freeze({...v, create(...a) {
      const p = v.create(...a);
      return {...p, stage(phase, key, callback, o) {
        const name = "job " + phase + " " + (typeof key === "string" ? key : key?.constructor?.name || typeof key);
        return p.stage(phase, key, (...x) => { if (wake.counting) wake.sources.set(name, (wake.sources.get(name) || 0) + 1); return callback(...x); }, o);
      }};
    }}) : v;
  }});
}
// In-page instrumentation of the live session (installed after start or join; again after a replica swap).
function instrument() {
  const S = AtriumCollabLive.session(), r = S.r, H = AtriumNavHost, now = () => performance.timeOrigin + performance.now();
  const pc = window.pc ||= {commits: [], receives: [], patches: [], frames: [], snapshots: []};
  if (r.pcWrapped) return Object.isFrozen(H);
  r.pcWrapped = true;
  const commit = r.commit, receive = r.receive, preparePatch = r.preparePatch, snapshot = r.snapshot, diff = r.diff;
  r.commit = function (next, o = {}) {
    const t = performance.now(), b = commit.call(this, next, o), ms = performance.now() - t;
    // What each operation key publishes (bytes of its JSON), to see derived data on the wire.
    const keys = {};
    for (const op of b?.ops || []) { const k = op.t + (op.k ? ":" + op.k : ""), n = JSON.stringify(op).length; keys[k] = (keys[k] || 0) + n; }
    pc.commits.push({at: now(), ms, scoped: Array.isArray(o.updates), structure: o.structure?.length ?? 0, updates: o.updates?.length ?? null, ops: b?.ops.length || 0, keys});
    return b;
  };
  r.receive = function (b, o) {
    const t = performance.now(), res = receive.call(this, b, o);
    pc.receives.push({at: now(), ms: performance.now() - t, ops: b?.ops?.length || 0, applied: res.applied});
    return res;
  };
  r.preparePatch = function (target, touched, observers) {
    const t = performance.now(), plan = preparePatch.call(this, target, touched, observers), rec = {at: now(), prepareMs: performance.now() - t, scoped: !!plan.scopes, applyMs: 0};
    pc.patches.push(rec);
    const apply = plan.apply;
    plan.apply = function () { const t2 = performance.now(); try { return apply.call(this); } finally { rec.applyMs = performance.now() - t2; rec.applied = true; } };
    return plan;
  };
  r.snapshot = function () { const t = performance.now(), s = snapshot.call(this); pc.snapshots.push({ms: performance.now() - t}); return s; };
  r.pcDiff = diff;
  if (!pc.frameHook) { pc.frameHook = true; H.on("frame", () => pc.frames.push(now())); }
  pc.drc ||= {calls: 0, items: 0};
  return Object.isFrozen(H);
}
// The guest's change-set reading after an edit: journal syncs (a full one compares every object),
// the board's journal range (what online DRC, redraw, minimap, pours and Design Insights read), and
// the items online DRC hands to AtriumRules.drc (wrapped once the rules module has loaded).
function scopeMark() {
  const R = globalThis.AtriumRules;
  if (R && !R.pcWrapped && !Object.isFrozen(R)) {
    const drc = R.drc;
    R.drc = function (doc, ...a) { pc.drc.calls++; pc.drc.items += doc?.items?.length || 0; return drc.call(this, doc, ...a); };
    R.pcWrapped = true;
  }
  const U = AtriumUndoStore, board = AtriumNavHost.project().documents.find(d => d.kind === "pcb" && d.items.length > 1000);
  const seq = U.changed(board, null).seq, st = U.stats();
  return {full: st.full, scoped: st.scoped, seq, drcCalls: pc.drc.calls, drcItems: pc.drc.items, drcWrapped: !!globalThis.AtriumRules?.pcWrapped};
}
function scopeSince(m) {
  const U = AtriumUndoStore, board = AtriumNavHost.project().documents.find(d => d.kind === "pcb" && d.items.length > 1000);
  const range = U.changed(board, m.seq), st = U.stats();
  return {fullSyncs: st.full - m.full, scopedSyncs: st.scoped - m.scoped, journalIds: range.ids ? range.ids.size : "unknown",
    drcCalls: pc.drc.calls - m.drcCalls, drcItems: pc.drc.items - m.drcItems, drcWrapped: m.drcWrapped};
}
function stat(xs) {
  xs = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const at = p => +xs[Math.max(0, Math.ceil(xs.length * p) - 1)].toFixed(2);
  return {n: xs.length, p50: at(.5), p95: at(.95), max: +xs.at(-1).toFixed(2)};
}

// saveFirst: save the project before hosting (in a browser that makes it a folder project, whose
// later saves keep the project and the session; tests/project/collab-remote-scope-browser.cjs).
async function session(browser, base, mode, relayInfo, {saveFirst = false} = {}) {
  const separate = mode !== "local";
  const contexts = separate ? [await browser.newContext({viewport:{width:1100, height:790}}), await browser.newContext({viewport:{width:1100, height:790}})]
    : [await browser.newContext({viewport:{width:1100, height:790}})];
  for (const c of contexts) await c.addInitScript(counters);
  const host = await contexts[0].newPage(), guest = await contexts.at(-1).newPage(), pages = [host, guest];
  const errors = [];
  for (const page of pages) {
    page.on("pageerror", e => errors.push(e.message));
    // Notebook features (tables) are a preview preference; set it, then load the editor again.
    await page.goto(base + "/app/index.html");
    // Design insights (app/checks/insights-ui.js) run a long idle pass on this board with or without a
    // session; they are off unless --insights, so that idle and cost numbers are the session's own.
    await page.evaluate(insights => { AtriumPref.set("labs.notebook", true); AtriumPref.set("insights.enabled", insights); }, insightsOn);
    await page.goto(base + "/app/index.html");
    await page.getByRole("button", {name:"Continue to editor"}).click();
    await page.evaluate(async relayOnly => {
      AtriumNavHost.canvas().focus();
      AtriumPref.set("collab.path", relayOnly ? "relay" : "auto");
      await AtriumLazy.need("AtriumCollabPresence");
    }, mode === "relay-only");
  }
  const cdp = await Promise.all(pages.map(async p => { const c = await p.context().newCDPSession(p); await c.send("Performance.enable"); return c; }));
  const cpu = async i => { const m = await cdp[i].send("Performance.getMetrics"); return Object.fromEntries(m.metrics.map(x => [x.name, x.value])).TaskDuration * 1000; };
  const url = mode === "local" ? "local" : relayInfo.url;
  const key = "PERF-COLLAB-LOOPBACK-ROOM-KEY-" + Math.random().toString(36).slice(2, 10).toUpperCase();
  const invite = await host.evaluate(async ({url, key, saveFirst}) => {
    const p = await (await fetch("/bench.waffle")).json();
    await AtriumNavHost.replaceProject(p, {force:true, copy:true, dirty:false});
    if (saveFirst) {
      AtriumNavHost.act("save");
      for (let k = 0; k < 200 && !(AtriumNavHost.folderProject?.() && !AtriumNavHost.isDirty?.()); k++) await new Promise(r => setTimeout(r, 50));
      if (!AtriumNavHost.folderProject?.()) throw Error("the first save did not make a folder project");
    }
    return AtriumCollabLive.start(url, key);
  }, {url, key, saveFirst});
  await host.evaluate(instrument);
  // ---- join ----
  const sentBefore = await host.evaluate(() => ({...pcBytes}));
  const joined = await guest.evaluate(async ({url, key, invite}) => {
    const t0 = performance.now();
    await AtriumCollabLive.join(url, key, {host: invite.host, salt: invite.salt});
    const deadline = t0 + 120000;
    while (!(AtriumCollabLive.session()?.r && AtriumCollabLive.session().editProject === AtriumNavHost.project())) {
      if (performance.now() > deadline) throw Error("join timed out: " + AtriumCollabLive.session()?.status);
      await new Promise(r => setTimeout(r, 10));
    }
    const adopted = performance.now();
    await new Promise(r => requestAnimationFrame(() => r()));
    return {joinMs: adopted - t0, firstFrameMs: performance.now() - t0, items: AtriumNavHost.project().documents.reduce((n, d) => n + d.items.length, 0)};
  }, {url, key, invite});
  const join = {...joined, ...(await host.evaluate(before => {
    const S = AtriumCollabLive.session(), snap = JSON.stringify(S.r.snapshot());
    return {snapshotBytes: snap.length, hostSnapshotMs: pc.snapshots[0]?.ms ?? null,
      hostSentBytes: pcBytes.ws + pcBytes.dc + pcBytes.bc - (before.ws + before.dc + before.bc)};
  }, sentBefore))};
  await guest.evaluate(instrument);
  // The editors' paths once settled (WebRTC may need a moment on loopback).
  await sleep(mode === "relay" ? 3000 : 500);
  const pathOf = async p => p.evaluate(() => { const S = AtriumCollabLive.session(); return [...(S.t.paths?.() || new Map()).values()].join(",") || S.url; });
  join.paths = {host: await pathOf(host), guest: await pathOf(guest)};
  return {host, guest, pages, contexts, cdp, cpu, errors, join, invite, url, key};
}

// Host-side edit kinds. Each returns timings measured synchronously inside the page.
async function setupKinds(page) {
  return page.evaluate(async () => {
    const H = AtriumNavHost, board = H.project().documents.find(d => d.kind === "pcb" && d.items.length > 1000);
    H.selectDocument(board.id);
    const part = board.items.find(i => i.kind === "part" && !i.locked), track = board.items.find(i => i.kind === "track" && !i.locked);
    const vias = board.items.filter(i => i.kind === "via" && !i.locked).slice(0, 32).map(i => i.id);
    const big = board.items.filter(i => i.kind === "via" && !i.locked).slice(32, 32 + 4200).map(i => i.id);
    // A table on the schematic sheet for the cell edit (as app/notebook/table-editor.js edits one).
    let table = null;
    try {
      await AtriumLazy.need(["AtriumTableData"]);
      const T = AtriumTableData, sch = H.project().documents.find(d => d.kind === "schematic");
      let n = 0; const state = T.create(8, 6, () => "pc-t" + (++n));
      H.selectDocument(sch.id);
      H.edit(() => sch.items.push({kind:"textframe", id:"pc-table", x:0, y:0, w:40, h:25, text:"Input", widget:{type:"table", state, fallback:{type:"text", text:"Input"}}}), "Add table");
      AtriumCollabLive.flush();
      const made = H.project().documents.find(d => d.id === sch.id)?.items.find(i => i.id === "pc-table");
      table = {doc: sch.id, rows: state.rows.map(r => r.id), cols: state.columns.map(c => c.id), ok: !!made?.widget, exists: !!made, keys: made ? Object.keys(made) : null,
        notebook: globalThis.AtriumLabs?.notebookEnabled?.() ?? null};
      H.selectDocument(board.id);
    } catch (e) { table = {error: e.message}; }
    // Load the duplicate/paste modules once, outside the measurement.
    H.select(vias.slice(0, 1)); H.act("duplicate"); await new Promise(r => setTimeout(r, 300)); H.setTool("select"); H.select([]);
    window.pcTargets = {board: board.id, part: part.id, track: track.id, vias, big, table, added: []};
    return {part: part.id, track: track.id, vias: vias.length, table};
  });
}
// kind, i -> in-page action. flush: publish explicitly (cost pass) or leave the 16 ms timer (latency pass).
function runKind({kind, i, flush}) {
  const H = AtriumNavHost, L = AtriumCollabLive, T = window.pcTargets, now = () => performance.timeOrigin + performance.now();
  const docOf = id => H.project().documents.find(d => d.id === id);
  if (kind === "table") { if (H.currentId() !== T.table.doc) H.selectDocument(T.table.doc); }
  else if (H.currentId() !== T.board) H.selectDocument(T.board);
  const board = docOf(T.board), find = id => board.items.find(x => x.id === id);
  pc.commits.length = 0;
  let prepare = null;
  if (kind === "delete") { const id = T.added.pop(); if (!id) throw Error("nothing to delete"); H.select([id]); }
  if (kind === "paste") { H.select(T.vias); H.act("duplicate"); }
  const start = now(), t0 = performance.now();
  if (kind === "move") { H.select([T.part]); H.executeKey("nudge", [i % 2 ? -1 : 1, 0]); }
  else if (kind === "vertex") { const t = find(T.track); H.edit(() => { t.points[1] = [t.points[1][0] + (i % 2 ? -.1 : .1), t.points[1][1]]; }, "Move vertex", [t]); }
  else if (kind === "add") {
    const id = "pc-add-" + Date.now().toString(36) + "-" + i, x = 5 + i * .7;
    H.edit(() => board.items.push({id, kind:"track", layer:"Top", width:.22, points:[[x, -3], [x + 1, -3], [x + 1, -4]]}), "Add track");
    T.added.push(id);
  }
  else if (kind === "delete") H.act("delete");
  else if (kind === "property") { const p = find(T.part); H.edit(() => { p.value = "pc-" + i + "-" + Date.now() % 100000; }, "Edit value", [p]); }
  else if (kind === "paste") { H.executeKey("place-at-pointer", [10 + i * 3, -20]); }
  else if (kind === "undo") H.act("undo");
  else if (kind === "table") {
    const TD = AtriumTableData, doc = H.doc(), item = doc.items.find(x => x.id === "pc-table"), prev = item.widget.state;
    const next = TD.change(prev, T.table.rows[i % T.table.rows.length], T.table.cols[i % T.table.cols.length], {content:{kind:"literal", text:"v" + i}});
    H.edit(() => { item.widget = {...item.widget, state: next}; }, "Edit table cell", [TD.cellUndoScope(doc, item, prev, next)]);
  }
  const t1 = performance.now();
  if (flush) L.flush();
  const t2 = performance.now();
  if (kind === "paste") H.setTool("select");
  const c = pc.commits.at(-1) || null;
  return {start, editMs: t1 - t0, publishMs: t2 - t1, commit: c && {ms: c.ms, scoped: c.scoped, structure: c.structure, updates: c.updates, ops: c.ops, keys: c.keys}, commits: pc.commits.length};
}
async function guestSaw(guest, since, timeout = 20000) {
  // The first frame after a patch that applied a received batch at or after `since`.
  await guest.waitForFunction(since => {
    const p = pc.patches.find(x => x.at >= since && x.applied), r = pc.receives.find(x => x.at >= since && x.applied);
    return r && p && pc.frames.some(f => f >= p.at);
  }, since, {timeout, polling: 10});
  return guest.evaluate(since => {
    const r = pc.receives.filter(x => x.at >= since), p = pc.patches.filter(x => x.at >= since);
    const firstPatch = p.find(x => x.applied);
    return {receiveMs: r.reduce((a, x) => a + x.ms, 0), prepareMs: p.reduce((a, x) => a + x.prepareMs, 0), applyMs: p.reduce((a, x) => a + x.applyMs, 0),
      scopedPatch: p.every(x => x.scoped), batches: r.length, arrive: r[0].at, frame: pc.frames.find(f => f >= firstPatch.at)};
  }, since);
}

const KINDS = ["move", "vertex", "property", "add", "delete", "paste", "undo", "table"];
async function costPass(s) {
  const out = {};
  const fullDiff = [];
  for (let k = 0; k < 3; k++) fullDiff.push(await s.host.evaluate(() => { const S = AtriumCollabLive.session(), t = performance.now(); const ops = S.r.pcDiff(AtriumNavHost.project()); return {ms: performance.now() - t, ops: ops.length}; }));
  out.fullDiffMs = stat(fullDiff.map(x => x.ms)); out.fullDiffOps = fullDiff[0].ops;
  const rows = Object.fromEntries(KINDS.map(k => [k, []]));
  // The guest looks at the board, so its online DRC and redraw follow the remote edits.
  await s.guest.evaluate(() => { const H = AtriumNavHost, b = H.project().documents.find(d => d.kind === "pcb" && d.items.length > 1000); H.selectDocument(b.id); });
  await sleep(2000);
  // Order: two warm-ups (a structural edit sets verifyNextDiff, so the following scoped edit runs
  // the full diff too: recorded as "afterStructural"), then reps per kind.
  for (let i = 0; i < reps; i++) {
    for (const kind of KINDS) {
      if (kind === "table" && !s.tableOk) continue;
      if (kind === "undo" && !rows.paste.length) continue;
      const c0 = [await s.cpu(0), await s.cpu(1)], mark = await s.guest.evaluate(scopeMark), wire0 = await s.host.evaluate(wireNow);
      const r = await s.host.evaluate(runKind, {kind, i, flush: true});
      let g = null;
      try { g = await guestSaw(s.guest, r.start); } catch (e) { g = {error: e.message.split("\n")[0]}; }
      // Online DRC on the guest runs right after the patch's frame (or when idle).
      await sleep(700);
      const c1 = [await s.cpu(0), await s.cpu(1)], scope = await s.guest.evaluate(scopeSince, mark), wire1 = await s.host.evaluate(wireNow);
      rows[kind].push({...r, guest: g, scope, wire: {messages: wire1.messages - wire0.messages, bytes: wire1.bytes - wire0.bytes}, hostCpuMs: c1[0] - c0[0], guestCpuMs: c1[1] - c0[1]});
    }
  }
  for (const [kind, list] of Object.entries(rows)) {
    if (!list.length) continue;
    const ok = list.filter(x => !x.guest?.error);
    out[kind] = {
      editMs: stat(list.map(x => x.editMs)), publishMs: stat(list.map(x => x.publishMs)), commitMs: stat(list.map(x => x.commit?.ms)),
      scopedUpdates: list.map(x => x.commit ? (x.commit.scoped ? "updates" : "none") : "no-commit").join(","),
      ops: stat(list.map(x => x.commit?.ops ?? 0)),
      guestReceiveMs: stat(ok.map(x => x.guest.receiveMs)), guestPrepareMs: stat(ok.map(x => x.guest.prepareMs)), guestApplyMs: stat(ok.map(x => x.guest.applyMs)),
      guestRemoteTotalMs: stat(ok.map(x => x.guest.receiveMs + x.guest.prepareMs + x.guest.applyMs)),
      guestScopedPatch: ok.every(x => x.guest.scopedPatch),
      // The change set a remote edit gives the guest's checks and redraw (see scope above).
      guestFullSyncs: list.reduce((n, x) => n + (x.scope?.fullSyncs || 0), 0),
      guestJournalIds: stat(list.map(x => typeof x.scope?.journalIds === "number" ? x.scope.journalIds : 1e9)),
      guestDrcItems: stat(list.map(x => x.scope?.drcItems ?? 0)), guestDrcCalls: stat(list.map(x => x.scope?.drcCalls ?? 0)), guestDrcWatched: list.some(x => x.scope?.drcWrapped),
      structure: list.map(x => x.commit?.structure ?? 0).join(","),
      wireMessages: stat(list.map(x => x.wire.messages)), wireBytes: stat(list.map(x => x.wire.bytes)),
      opKeys: Object.fromEntries(Object.entries(list.reduce((acc, x) => { for (const [k, n] of Object.entries(x.commit?.keys || {})) acc[k] = (acc[k] || 0) + n; return acc; }, {}))
        .map(([k, n]) => [k, Math.round(n / list.length)])),
      hostCpuMs: stat(list.map(x => x.hostCpuMs)), guestCpuMs: stat(list.map(x => x.guestCpuMs)),
      errors: list.filter(x => x.guest?.error).map(x => x.guest.error).slice(0, 2)
    };
  }
  // Whole-project audits (they run only at save and before leaving) and the repairs they published.
  const audits = page => page.evaluate(() => { const {audits, repairs, repairedOps, refreshed, rebuilt} = AtriumCollabLive.session().r.stats(); return {audits, repairs, repairedOps, refreshed, rebuilt}; });
  out.replicaStats = {host: await audits(s.host), guest: await audits(s.guest)};
  return out;
}
async function latencyPass(s) {
  const out = {};
  for (const kind of ["move", "add", "delete"]) {
    const xs = [], arrive = [];
    for (let i = 0; i < reps; i++) {
      await sleep(150);
      const r = await s.host.evaluate(runKind, {kind, i: i + 100, flush: false});
      try { const g = await guestSaw(s.guest, r.start); xs.push(g.frame - r.start); arrive.push(g.arrive - r.start); } catch (e) { out.error = e.message.split("\n")[0]; }
    }
    out[kind] = {toGuestFrameMs: stat(xs), toGuestArrivalMs: stat(arrive)};
  }
  return out;
}
// Messages and bytes this page has sent on every carrier.
function wireNow() { const m = pcMessages, b = pcBytes; return {messages: m.ws + m.dc + m.bc, bytes: b.ws + b.dc + b.bc}; }
// The host's traffic while (a) the pointer travels over the board with no edit, (b) an object is
// dragged before the drop (then the drop itself), (c) 20 nudges in a burst; per second, and what one
// message carries at most.
async function wirePass(s, seconds = 3) {
  const out = {};
  const box = await s.host.evaluate(() => {
    const H = AtriumNavHost, T = window.pcTargets, board = H.project().documents.find(d => d.id === T.board);
    if (H.currentId() !== T.board) H.selectDocument(T.board);
    H.select([]); H.setTool("select");
    const rect = H.canvas().getBoundingClientRect(), part = board.items.find(x => x.id === T.part);
    const [x, y] = H.view().worldToScreen([part.x, part.y]);
    return {left: rect.left, top: rect.top, width: rect.width, height: rect.height, part: [rect.left + x, rect.top + y]};
  });
  const measure = async (name, act) => {
    const w0 = await s.host.evaluate(wireNow), t0 = Date.now();
    await act();
    const ms = Date.now() - t0, w1 = await s.host.evaluate(wireNow);
    out[name] = {seconds: +(ms / 1000).toFixed(2), messages: w1.messages - w0.messages, bytes: w1.bytes - w0.bytes,
      messagesPerSec: +((w1.messages - w0.messages) / (ms / 1000)).toFixed(2), bytesPerSec: Math.round((w1.bytes - w0.bytes) / (ms / 1000))};
  };
  const steps = seconds * 60;
  await s.host.mouse.move(box.left + 40, box.top + 40);
  await sleep(500);
  await measure("pointerTravel", async () => {
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      await s.host.mouse.move(box.left + 40 + t * (box.width - 80), box.top + box.height / 2 + Math.sin(t * 12) * box.height / 3);
      await sleep(1000 / 60);
    }
  });
  await sleep(800);
  await s.host.mouse.move(box.part[0], box.part[1]);
  await sleep(300);
  await s.host.mouse.down();
  await measure("dragBeforeDrop", async () => {
    for (let k = 0; k < steps; k++) {
      await s.host.mouse.move(box.part[0] + 120 * Math.sin(k / steps * Math.PI * 2), box.part[1] + 60 * Math.cos(k / steps * Math.PI * 2));
      await sleep(1000 / 60);
    }
  });
  await measure("drop", async () => { await s.host.mouse.up(); await sleep(1000); });
  await sleep(500);
  await measure("nudgeBurst20", async () => {
    await s.host.evaluate(async () => {
      const H = AtriumNavHost; H.select([window.pcTargets.part]);
      for (let k = 0; k < 20; k++) { H.executeKey("nudge", [k % 2 ? -1 : 1, 0]); await new Promise(r => setTimeout(r, 25)); }
    });
    await sleep(1000);
  });
  await s.host.evaluate(() => AtriumNavHost.select([]));
  return out;
}
// Every wake-up on both pages: first until two seconds pass with none (at most 60 s, as
// tests/integration/perf-sch.js waits for quiet), then a fixed idle window.
const resetWake = s => Promise.all(s.pages.map(p => p.evaluate(() => { const w = pcWake; w.timeout = w.interval = w.raf = w.idle = 0; w.sources.clear(); w.counting = true; })));
const readWake = (p, stop = true) => p.evaluate(stop => { const w = pcWake; if (stop) w.counting = false; return {total: w.timeout + w.interval + w.raf + w.idle, timeout: w.timeout, interval: w.interval, raf: w.raf, idle: w.idle, top: [...w.sources].sort((a, b) => b[1] - a[1]).slice(0, 5)}; }, stop);
async function untilQuiet(s, maxMs = 60000) {
  await resetWake(s);
  const t0 = Date.now(), quietSince = [t0, t0], last = [0, 0];
  while (Date.now() - t0 < maxMs) {
    await sleep(250);
    const now = Date.now(), totals = await Promise.all(s.pages.map(p => readWake(p, false)));
    totals.forEach((w, i) => { if (w.total !== last[i]) { last[i] = w.total; quietSince[i] = now; } });
    if (quietSince.every(q => now - q >= 2000)) break;
  }
  const wake = await Promise.all(s.pages.map(p => readWake(p)));
  return {host: {quietAfterMs: quietSince[0] - t0, wakeups: wake[0].total, top: wake[0].top}, guest: {quietAfterMs: quietSince[1] - t0, wakeups: wake[1].total, top: wake[1].top},
    reachedQuiet: Date.now() - t0 < maxMs};
}
async function idlePass(s) {
  const settle = await untilQuiet(s);
  const c0 = [await s.cpu(0), await s.cpu(1)];
  await resetWake(s);
  const t0 = Date.now();
  await sleep(idleSeconds * 1000);
  const secs = (Date.now() - t0) / 1000;
  const c1 = [await s.cpu(0), await s.cpu(1)];
  const wake = await Promise.all(s.pages.map(p => readWake(p)));
  const out = {settle};
  ["host", "guest"].forEach((who, i) => {
    out[who] = {seconds: +secs.toFixed(1), wakeupsPerSec: +(wake[i].total / secs).toFixed(2), cpuPct: +(100 * (c1[i] - c0[i]) / (secs * 1000)).toFixed(3), ...wake[i]};
  });
  return out;
}
const state = p => p.evaluate(() => { const S = AtriumCollabLive.session(); return {connection: S.connection, vv: S.r.vv(), paths: [...(S.t.paths?.() || new Map()).values()]}; });
// One known value per object, so each edit can be checked on the other side.
const mark = (page, which, field, value) => page.evaluate(({which, field, value}) => {
  const H = AtriumNavHost, board = H.project().documents.find(d => d.kind === "pcb" && d.items.length > 1000);
  if (H.currentId() !== board.id) H.selectDocument(board.id);
  const [kind, n] = which.split(":"), it = board.items.filter(i => i.kind === kind && !i.locked)[+n || 0];
  H.edit(() => { it[field] = value; }, "Mark", [it]);
  AtriumCollabLive.flush();
  return it.id;
}, {which, field, value});
const read = (page, id, field) => page.evaluate(({id, field}) => { for (const d of AtriumNavHost.project().documents) { const it = d.items.find(i => i.id === id); if (it) return it[field]; } return null; }, {id, field});
async function arrived(checks) { const out = {}; for (const c of checks) out[c.name] = await read(c.page, c.id, c.field) === c.value; return out; }
async function waitOpen(s, since, ms = 70000) {
  while (Date.now() - since < ms) {
    const [h, g] = [await state(s.host), await state(s.guest)];
    if (h.connection === "open" && g.connection === "open") return Date.now() - since;
    await sleep(100);
  }
  return null;
}
async function waitAll(checks, since, ms = 30000) {
  while (Date.now() - since < ms) { const a = await arrived(checks); if (Object.values(a).every(Boolean)) return Date.now() - since; await sleep(100); }
  return null;
}
// Outage of the network both editors use (the relay dies). In flight: edits written into a socket
// that still looks open (the relay is stopped with SIGSTOP first, as after sleep or a change of
// address), then the relay dies; offline: edits made while the editors know they are offline.
async function dropPass(s, relayRef) {
  const checks = [];
  const add = async (page, who, which, field, value, name) => checks.push({name, page: who === "host" ? s.guest : s.host, id: await mark(page, which, field, value), field, value});
  const pathsBefore = (await state(s.host)).paths;
  relayRef.current.proc.kill("SIGSTOP");
  await add(s.host, "host", "part:0", "value", "inflight-host-" + Date.now() % 1e5, "hostInFlight");
  await add(s.guest, "guest", "track:0", "width", 0.29, "guestInFlight");
  await sleep(600);
  await killRelay(relayRef.current);
  const killedAt = Date.now();
  await sleep(1500);
  const during = {host: (await state(s.host)).connection, guest: (await state(s.guest)).connection};
  await add(s.host, "host", "via:0", "diameter", 0.61, "hostOffline");
  await add(s.guest, "guest", "via:1", "drill", 0.29, "guestOffline");
  await sleep(1000);
  const whileDown = await arrived(checks);
  await sleep(Math.max(0, 3000 - (Date.now() - killedAt)));
  relayRef.current = await relay(relayRef.current.port);
  const back = Date.now(), reopen = await waitOpen(s, back), converged = reopen === null ? null : await waitAll(checks, back);
  const final = await arrived(checks);
  const after = {name: "liveAfterReturn", page: s.guest, id: await mark(s.host, "part:1", "value", "after-" + Date.now() % 1e5), field: "value"};
  after.value = await read(s.host, after.id, "value");
  const liveMs = await waitAll([after], Date.now(), 15000);
  return {downMs: back - killedAt, connectionWhileDown: during, deliveredWhileDown: whileDown, reopenMsAfterReturn: reopen,
    convergedMsAfterReturn: converged, arrived: final, liveEditAfterReturnMs: liveMs, pathsBefore, pathsAfter: (await state(s.host)).paths};
}
// The relay stalls (SIGSTOP) without closing: a half-open connection, as when a sleeping host's
// network vanishes. Does either editor notice, and do edits still arrive (on a direct data channel)?
async function stallPass(s, relayRef, seconds = 25) {
  relayRef.current.proc.kill("SIGSTOP");
  const t0 = Date.now();
  const id = await mark(s.host, "via:2", "diameter", 0.62);
  const deliveredMs = await waitAll([{page: s.guest, id, field: "diameter", value: 0.62}], t0, seconds * 1000);
  await sleep(Math.max(0, seconds * 1000 - (Date.now() - t0)));
  const during = {host: (await state(s.host)).connection, guest: (await state(s.guest)).connection};
  relayRef.current.proc.kill("SIGCONT");
  const resumed = Date.now(), afterResume = deliveredMs === null ? await waitAll([{page: s.guest, id, field: "diameter", value: 0.62}], resumed, 30000) : null;
  return {stallSeconds: seconds, connectionAfterStall: during, deliveredDuringStallMs: deliveredMs, deliveredAfterResumeMs: afterResume};
}
// A guest falls behind the CRDT's bounded log (LIMITS.log 4,000 operations; trim keeps 2,000):
// it deletes 4,200 objects while disconnected. The session heartbeat trims every 20 s; it is called
// directly here. Variants: noTrim (control: the same delete, no trim), offlineKnown (made after the
// drop is known; a failed reconnect attempt follows, which empties the transport's relay queue),
// inFlight (written into a socket that still looks open, which then dies).
async function trimPass(s, relayRef) {
  const count = p => p.evaluate(() => AtriumNavHost.project().documents.reduce((n, d) => n + d.items.length, 0));
  const bigDelete = (page, kind, from, trim) => page.evaluate(({kind, from, trim}) => {
    const H = AtriumNavHost, board = H.project().documents.find(d => d.kind === "pcb" && d.items.length > 1000);
    if (H.currentId() !== board.id) H.selectDocument(board.id);
    const ids = board.items.filter(i => i.kind === kind && !i.locked).slice(from, from + 4200).map(i => i.id);
    H.select(ids); H.act("delete"); AtriumCollabLive.flush();
    const r = AtriumCollabLive.session().r, before = r.stats().log, trimmed = trim ? r.trim() : false;
    return {deleted: ids.length, logBefore: before, trimmed, logAfter: r.stats().log};
  }, {kind, from, trim});
  const out = {};
  for (const [variant, kind, from] of [["noTrim", "track", 5000], ["offlineKnown", "via", 40], ["inFlight", "track", 100]]) {
    const start = {host: await count(s.host), guest: await count(s.guest)};
    let res;
    if (variant === "inFlight") { relayRef.current.proc.kill("SIGSTOP"); res = await bigDelete(s.guest, kind, from, true); await sleep(600); await killRelay(relayRef.current); await sleep(1200); }
    else { await killRelay(relayRef.current); await sleep(1200); res = await bigDelete(s.guest, kind, from, variant !== "noTrim"); await sleep(4500); }
    relayRef.current = await relay(relayRef.current.port);
    const back = Date.now(), reopen = await waitOpen(s, back);
    let end;
    for (let k = 0; k < 15; k++) { await sleep(1000); end = {host: await count(s.host), guest: await count(s.guest)}; if (end.host === end.guest) break; }
    out[variant] = {...res, reopenMs: reopen, itemsBefore: start, itemsAfter: end,
      missingOnHost: (end.host - end.guest) - (start.host - start.guest),
      vvAgree: JSON.stringify((await state(s.host)).vv) === JSON.stringify((await state(s.guest)).vv)};
  }
  return out;
}

async function main() {
  const project = await design(), server = await serve(project), base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({headless: true, ...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: "chrome"}),
    args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
      "--disable-features=WebRtcHideLocalIpsWithMdns", "--no-first-run"]});
  const result = {chrome: browser.version(), board: "makeAtriumBenchmarkBoard() 25,600 objects + default project", reps, idleSeconds, insights: insightsOn, transports: {}};
  const relayRef = {current: null};
  try {
    for (const mode of transports) {
      log(mode, "…");
      if (mode !== "local" && !relayRef.current) relayRef.current = await relay();
      const s = await session(browser, base, mode, relayRef.current);
      const t = result.transports[mode] = {join: s.join, frozenNavHost: await s.host.evaluate(instrument)};
      try {
        if (!skip.has("idle") && mode !== "local") t.idleAfterJoin = await idlePass(s);
        const kinds = await setupKinds(s.host);
        s.tableOk = !!kinds.table?.ok; t.table = kinds.table;
        if (!skip.has("cost") && mode === (transports.includes("relay") ? "relay" : transports[0])) t.cost = await costPass(s);
        if (!skip.has("latency")) t.latency = await latencyPass(s);
        if (!skip.has("wire") && mode === (transports.includes("relay") ? "relay" : transports[0])) t.wire = await wirePass(s);
        if (!skip.has("idle") && mode !== "local") t.idleAfterEdits = await idlePass(s);
        if (!skip.has("drop") && mode !== "local") t.drop = await dropPass(s, relayRef);
        if (!skip.has("stall") && mode !== "local") t.stall = await stallPass(s, relayRef);
        if (!skip.has("trim") && mode === "relay-only") t.trim = await trimPass(s, relayRef);
      } catch (e) { t.error = e.stack?.split("\n").slice(0, 3).join(" | "); }
      t.pageErrors = s.errors.slice(0, 5);
      for (const p of s.pages) await p.evaluate(() => AtriumCollabLive.leave()).catch(() => {});
      for (const c of s.contexts) await c.close();
    }
  } finally {
    await browser.close(); server.close();
    if (relayRef.current) { try { relayRef.current.proc.kill("SIGCONT"); } catch { /* gone */ } await killRelay(relayRef.current); }
  }
  console.log(JSON.stringify(result, null, asJSON ? 1 : 2));
  if (args.includes("--budgets")) {
    const failed = budgets(result);
    for (const f of failed) console.error("perf-collab: over budget: " + f);
    if (failed.length) process.exitCode = 3;
  }
}
// Per-edit budgets (docs/collaboration.md, the live-session targets on this board), on one run's p95.
// scripts/perf-collab.sh applies the same table to the median of RUNS runs.
const BUDGETS = {
  remoteTotalMs: 4,                                                   // receive + view + patch, any kind
  publishStructuralMs: 4, structural: ["add", "delete", "paste"],     // local add, delete, paste: flush
  publishInPlaceMs: 1, inPlace: ["move", "vertex", "property", "table"],
  undoEditMs: 16,                                                     // personal undo on the host
  scoped: ["move", "property", "add", "delete"], drcItems: 2000       // a remote edit re-checks its neighbourhood
};
function budgets(result) {
  const failed = [];
  for (const [mode, t] of Object.entries(result.transports)) {
    const c = t.cost;
    if (!c) continue;
    for (const who of ["host", "guest"]) if (c.replicaStats?.[who]?.audits) failed.push(mode + " " + who + " ran " + c.replicaStats[who].audits + " whole-project audits without a save or leave");
    for (const [kind, row] of Object.entries(c)) {
      if (!row?.guestRemoteTotalMs) continue;
      if (row.guestRemoteTotalMs.p95 > BUDGETS.remoteTotalMs) failed.push(mode + " " + kind + " guest remote p95 " + row.guestRemoteTotalMs.p95 + " ms > " + BUDGETS.remoteTotalMs);
      if (BUDGETS.structural.includes(kind) && row.publishMs.p95 > BUDGETS.publishStructuralMs) failed.push(mode + " " + kind + " publish p95 " + row.publishMs.p95 + " ms > " + BUDGETS.publishStructuralMs);
      if (BUDGETS.inPlace.includes(kind) && row.publishMs.p95 > BUDGETS.publishInPlaceMs) failed.push(mode + " " + kind + " publish p95 " + row.publishMs.p95 + " ms > " + BUDGETS.publishInPlaceMs);
      if (kind === "undo" && row.editMs.p95 > BUDGETS.undoEditMs) failed.push(mode + " undo p95 " + row.editMs.p95 + " ms > " + BUDGETS.undoEditMs);
      if (kind === "replicaStats") continue;
      if (BUDGETS.scoped.includes(kind) && (row.guestFullSyncs || row.guestDrcItems?.max > BUDGETS.drcItems || row.guestJournalIds?.max >= 1e9))
        failed.push(mode + " " + kind + " re-checked more than the edit: " + JSON.stringify({fullSyncs: row.guestFullSyncs, drcItems: row.guestDrcItems, journalIds: row.guestJournalIds}));
    }
  }
  return failed;
}
module.exports = {BUDGETS, budgets, design, serve, relay, killRelay, session, setupKinds, runKind, guestSaw, instrument, scopeMark, scopeSince};
if (require.main === module) main().catch(err => { console.error(err); process.exitCode = 1; });
