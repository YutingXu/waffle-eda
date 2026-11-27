"use strict";
// Schematic and whole-project performance probe for scripts/perf-sch.sh (headless Chrome) and the
// macOS WKWebView harness (native/tests/macos-harness/sch.sh). It drives the real editor
// (app/index.html) on a synthetic hierarchical project from tests/schematic/sch-bench-project.js (30 or 100
// sheets: modules, sub-sheets, an 8-channel repeated sheet, buses with entries and ports) or on a
// real project opened through File › Open (options.files: [{name, url}], e.g. the private-project-03 project).
//
// Frames are timed synchronously, as tests/editor/perf-interact.js does: requestAnimationFrame is replaced
// by a queue that the probe flushes inside the timed block, then a 1-pixel getImageData forces the
// raster, so a sample is input -> handler -> render -> pixels with no vsync wait. Deferred work
// (timers, idle callbacks) runs between samples in settle(), which also flushes the frame queue.
//
// options.board measures idle energy on the PCB benchmark board instead (scripts/perf-sch.sh --board).
//
// atriumSchProbe({sheets, files, only, mark, board, efficiency}) resolves to {metrics, checks, env}:
//   metrics.name = ms, or {n, p50, p95, p99, max} for repeated samples.
//   mark(tag): optional hook the driver uses to read the browser's CPU counters at phase edges
//   (Runtime binding; see scripts/perf-sch.sh): "idle-start"/"idle-end", "edit-start"/"edit-end".
globalThis.atriumSchProbe = function(options = {}) {
  return Promise.race([schProbe(options), new Promise((_, no) => setTimeout(() => no(Error("schematic probe timed out after 600 s")), 600000))]);
};
async function schProbe(options) {
  const want = s => !options.only || options.only.includes(s);
  const realTimeout = window.setTimeout.bind(window);
  const wait = ms => new Promise(r => realTimeout(r, ms));
  const mark = tag => {try {options.mark?.(tag);} catch {}};
  HTMLCanvasElement.prototype.setPointerCapture = function() {}; HTMLCanvasElement.prototype.releasePointerCapture = function() {};
  const refreshHz = await new Promise(done => {const t = []; const tick = ts => {t.push(ts); if (t.length < 31) requestAnimationFrame(tick); else {
    const d = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b); done(+(1000 / d[d.length >> 1]).toFixed(1));}}; requestAnimationFrame(tick); realTimeout(() => done(null), 2000);});
  // ---- wake-up accounting (energy): every timer, interval, frame and idle callback that fires.
  const wake = {timeout: 0, interval: 0, raf: 0, idle: 0, sources: new Map()};
  const site = () => {const s = (new Error().stack || "").split("\n").slice(3, 5).map(l => l.trim().replace(/^at /, "").replace(/\(?(file|https?):\/\/[^)]*\/([^/)]+)\)?/, "$2")).join(" < "); return s.slice(0, 160);};
  let counting = false;
  const count = (kind, s) => {if (!counting) return; wake[kind]++; wake.sources.set(kind + " " + s, (wake.sources.get(kind + " " + s) || 0) + 1);};
  {
    const st = window.setTimeout, si = window.setInterval, ric = window.requestIdleCallback;
    window.setTimeout = function(f, ms, ...a) {const s = counting ? site() : ""; return st.call(window, typeof f === "function" ? (...x) => {count("timeout", s); return f(...x);} : f, ms, ...a);};
    window.setInterval = function(f, ms, ...a) {const s = site(); return si.call(window, typeof f === "function" ? (...x) => {count("interval", s); return f(...x);} : f, ms, ...a);};
    if (ric) window.requestIdleCallback = function(f, o) {const s = counting ? site() : ""; return ric.call(window, d => {count("idle", s); return f(d);}, o);};
  }
  const RQ = [];
  window.requestAnimationFrame = cb => {RQ.push({cb, s: counting ? site() : ""}); return RQ.length;}; window.cancelAnimationFrame = () => {};
  const flushRAF = () => {for (let k = 0; k < 5 && RQ.length; k++) for (const {cb, s} of RQ.splice(0)) {count("raf", s); cb(performance.now());}};
  const H = () => AtriumNavHost, cv = () => H().canvas(), g2 = () => cv().getContext("2d");
  // Which edit-pipeline jobs are staged while counting (an idle window should stage none).
  {const st = H().stageEdit; if (st) H().stageEdit = (phase, key, cb, o) => {if (counting) wake.sources.set("stage " + phase + " " + (typeof key === "string" ? key : key?.constructor?.name || typeof key) + " " + site(), (wake.sources.get("stage " + phase + " " + key) || 0) + 1); return st(phase, key, cb, o);};}
  const pct = (a, p) => {const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)].toFixed(2);};
  const stat = a => a.length ? {n: a.length, p50: pct(a, .5), p95: pct(a, .95), p99: pct(a, .99), max: +Math.max(...a).toFixed(2)} : null;
  const raster = () => {try {g2().getImageData(0, 0, 1, 1);} catch {}};
  const frame = fn => {const t = performance.now(); fn(); flushRAF(); raster(); return +(performance.now() - t).toFixed(2);};
  // The same frame split into handler, frame callbacks (render) and raster (pixel readback).
  const frameSplit = fn => {const t = performance.now(); fn(); const a = performance.now(); flushRAF(); const b = performance.now(); raster(); const c = performance.now(); return [a - t, b - a, c - b].map(v => +v.toFixed(2));};
  const scr = w => {const b = cv().getBoundingClientRect(), s = H().view().worldToScreen(w); return [s[0] + b.left, s[1] + b.top];};
  const pev = (type, [x, y], o = {}) => cv().dispatchEvent(new PointerEvent(type, {clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, bubbles: true, cancelable: true, isPrimary: true, pointerType: "mouse", ...o}));
  const mev = (type, [x, y], o = {}) => cv().dispatchEvent(new MouseEvent(type, {clientX: x, clientY: y, bubbles: true, cancelable: true, ...o}));
  const wheel = (x, y, o) => cv().dispatchEvent(new WheelEvent("wheel", {clientX: x, clientY: y, bubbles: true, cancelable: true, deltaMode: 0, ...o}));
  const key = (k, o = {}) => cv().dispatchEvent(new KeyboardEvent("keydown", {key: k, bubbles: true, cancelable: true, ...o}));
  const act = a => H().act(a);
  const settle = async ms => {const t = performance.now(); while (performance.now() - t < ms) {await wait(16); flushRAF();}};
  // Waits until two seconds pass with no wake-up at all (timers, frames, idle callbacks), at most
  // 30 s; returns the time the editor kept working and the sources counted meanwhile.
  // o.armed: also wait while a check client has a timer armed (an Efficiency-mode heavy pass to come).
  const armed = () => (globalThis.AtriumChecks?.scheduler?.stats?.().armed || []).length > 0;
  const untilQuiet = async (o = {}) => {
    const q0 = performance.now(); let quietSince = q0, total = 0;
    wake.timeout = wake.interval = wake.raf = wake.idle = 0; wake.sources.clear(); counting = true;
    while (performance.now() - q0 < 30000) {
      const before = wake.timeout + wake.interval + wake.raf + wake.idle;
      await idleFor(250);
      const after = wake.timeout + wake.interval + wake.raf + wake.idle;
      if (after !== before) {quietSince = performance.now(); total += after - before;}
      else if (performance.now() - quietSince >= 2000 && !(o.armed && armed())) break;
    }
    counting = false;
    return {ms: Math.round(quietSince - q0), total, top: [...wake.sources].sort((a, b) => b[1] - a[1]).slice(0, 8)};
  };
  // An idle window: the probe itself wakes 4 times a second (to run any frame the editor requested).
  const idleFor = async ms => {const t = performance.now(); while (performance.now() - t < ms) {await wait(250); flushRAF();}};
  const heap = () => {try {window.gc?.(); window.gc?.();} catch {} return performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;};
  const longs = [];
  try {new PerformanceObserver(l => {for (const e of l.getEntries()) longs.push({t: e.startTime, d: e.duration});}).observe({type: "longtask", buffered: false});} catch {}
  const longIn = (t0, t1) => {const L = longs.filter(l => l.t >= t0 && l.t < t1); return {count: L.length, max: +Math.max(0, ...L.map(l => l.d)).toFixed(1), total: +L.reduce((a, l) => a + l.d, 0).toFixed(1)};};
  const errors = [];
  addEventListener("error", e => errors.push(String(e.message)));
  const metrics = {}, checks = {errors};
  const closeDialogs = async () => {for (let i = 0; i < 3 && document.querySelector("dialog[open]"); i++) {for (const g of document.querySelectorAll("dialog[open]")) try {g.close();} catch {} await settle(60);}};
  await closeDialogs();
  globalThis.AtriumDRCMarkers?.setVisible?.(false, H());
  await settle(300);
  metrics.heapBootMB = heap();

  // ---------------------------------------------------------------- the PCB benchmark board (options.board)
  // Idle energy on the 25.6k-object board of tests/pcb/dense-board.js, one editor, no collaboration:
  // open, how long the editor keeps working (no wake-up for 2 s and no check timer armed, such as the
  // Efficiency-mode heavy insights pass 8 s after an edit; at most 30 s) and the CPU meanwhile, a 10 s
  // window that should be quiet, then one small edit (a track vertex) and the same again.
  // options.efficiency sets Preferences › Energy (auto | always | off) for the run.
  // options.board "nets" gives every pad, via and part pin one of 64 nets, "pours" also adds the ten
  // polygons of tests/editor/perf-interact.js and pours them once (25,610 objects). Both then measure a
  // series of small edits (editSeries below).
  if (options.board) {
    if (options.efficiency) globalThis.AtriumPower?.setMode?.(options.efficiency);
    const {d, defs} = makeAtriumBenchmarkBoard(), p = Atrium.project("Dense signal board");
    p.documents = [d]; p.library = [...defs.values()];
    const nets = options.board === "nets" || options.board === "pours", pours = options.board === "pours";
    if (nets) {
      let k = 0;
      for (const i of d.items) {if (i.kind === "part") i.pinNets = {"1": "N" + (k % 64), "2": "N" + ((k + 1) % 64)}; else if (i.kind !== "track") i.net = "N" + (k % 64); k++;}
    }
    if (pours) {
      await AtriumLazy.need("AtriumRules");
      const rect = (a, b, c, e) => [[a, b], [c, b], [c, e], [a, e]];
      const polys = [["Top", "GND", rect(1, 1, 180, 270)], ["Top", "VCC", rect(180, 1, 367, 270)], ["Bottom", "GND", rect(1, 1, 367, 140)], ["Bottom", "VCC", rect(1, 140, 367, 270)]];
      for (let j = 0; j < 6; j++) polys.push([j % 2 ? "Top" : "Bottom", "N" + j, rect(10 + j * 55, 10, 50 + j * 55, 40)]);
      polys.forEach(([layer, net, o], j) => d.items.push(AtriumPolygonPour.make(o, {layer, net, pourIndex: j, removeDeadCopper: false})));
    }
    const t0 = performance.now();
    await H().replaceProject(p, {force: true}); H().selectDocument(d.id);
    if (pours) H().edit(() => AtriumPolygonPour.apply(H().doc(), H().defs(), {project: H().project()}));
    metrics.openMs = +(performance.now() - t0).toFixed(1);
    checks.project = {sheets: 0, items: d.items.length, parts: d.items.filter(i => i.kind === "part").length, efficient: !!globalThis.AtriumPower?.efficient?.(),
      board: options.board === true ? "plain" : options.board, regions: d.pcbDrawing?.pours?.length || 0};
    const quietWindow = async () => {
      wake.timeout = wake.interval = wake.raf = wake.idle = 0; wake.sources.clear();
      mark("idle-start"); counting = true; const i0 = performance.now(); await idleFor(10000); const ms = performance.now() - i0; counting = false; mark("idle-end");
      return {perSec: +((wake.timeout + wake.interval + wake.raf + wake.idle) / (ms / 1000)).toFixed(2), wakes: {timeout: wake.timeout, interval: wake.interval, raf: wake.raf, idle: wake.idle, top: [...wake.sources].sort((a, b) => b[1] - a[1]).slice(0, 8)}};
    };
    mark("settle-start"); const open = await untilQuiet({armed: true}); mark("settle-end");
    metrics.openQuietAfterMs = Math.round(open.ms + metrics.openMs); checks.openSettleWakeups = {total: open.total, top: open.top};
    let w = await quietWindow(); metrics.idleWakeupsPerSec = w.perSec; checks.idleWakeups = w.wakes;
    const tr = d.items.find(i => i.kind === "track" && i.points[0][0] > 100);
    mark("edit-start");
    metrics.editFrame = frame(() => H().edit(() => { tr.points[1] = [tr.points[1][0], tr.points[1][1] - .2]; }, "probe", [tr]));
    const after = await untilQuiet({armed: true}); mark("edit-end");
    metrics.lastEditQuietAfterMs = after.ms; checks.lastEditSettleWakeups = {total: after.total, top: after.top};
    w = await quietWindow(); metrics.idleWakeupsAfterPerSec = w.perSec; checks.idleWakeupsAfter = w.wakes;
    // The edit series (options.board "nets" or "pours"): small edits inside the pours, away from their
    // outlines, each followed by the editor's own work until it is quiet again. Per edit: the edit's
    // frame, the longest main-thread task until quiet (editTaskMax: online DRC, pour checks, Insights,
    // the live repour's main-thread steps …) and its CPU (the driver's window "ed<n>": editSeriesCpuMs).
    if (nets) {
      const near = (kind, x, y, skip = new Set()) => d.items.filter(i => i.kind === kind && !skip.has(i)).reduce((a, i) => {
        const q = i.points ? i.points[0] : [i.x, i.y], s = Math.hypot(q[0] - x, q[1] - y); return !a || s < a.s ? {i, s} : a;}, null)?.i;
      const part = near("part", 90, 200), bend = near("track", 120, 210), gone = near("track", 130, 190), from = near("track", 100, 220);
      const copy = d.items.filter(i => ["track", "via", "part"].includes(i.kind) && Math.abs((i.x ?? i.points[0][0]) - 60) < 3 && Math.abs((i.y ?? i.points[0][1]) - 230) < 2).slice(0, 4);
      let n = 0;
      const series = [
        ["move part", () => H().edit(() => {part.x += .5; part.y += .3;}, "probe", [part])],
        ["bend track", () => H().edit(() => {bend.points[1] = [bend.points[1][0], bend.points[1][1] - .2];}, "probe", [bend])],
        ["add track", () => {const t = {id: "probe-t" + (++n), kind: "track", layer: from.layer, width: .22, net: from.net, points: [from.points[2].slice(), [from.points[2][0] + 1.2, from.points[2][1] + .4]]};
          H().edit(() => {d.items.push(t);}, "probe", [t]);}],
        ["delete track", () => H().edit(() => {d.items.splice(d.items.indexOf(gone), 1);}, "probe", [gone])],
        ["paste 4", () => H().edit(() => {for (const s of copy) {const c = JSON.parse(JSON.stringify(s)); c.id = "probe-p" + (++n); if (c.points) c.points = c.points.map(q => [q[0] + .4, q[1] + 6]); else {c.x += .4; c.y += 6;} if (c.ref) c.ref += "_" + n; d.items.push(c);}})],
        ["undo", () => act("undo")],
        ["redo", () => act("redo")]];
      const rows = [];
      for (const [name, run] of series) {
        const k = rows.length, t = performance.now();
        mark("ed" + k + "-start");
        const f = frame(run);
        const q = await untilQuiet({armed: true});
        mark("ed" + k + "-end");
        const L = longIn(t, performance.now());
        rows.push({name, frame: f, quietMs: q.ms, taskMax: L.max, longTasks: L.count, longMs: L.total});
      }
      checks.editSeries = rows;
      metrics.editSeriesFrame = Math.max(...rows.map(r => r.frame));
      metrics.editTaskMax = Math.max(...rows.map(r => r.taskMax));
      metrics.editSeriesQuietMs = Math.max(...rows.map(r => r.quietMs));
    }
    const pass = globalThis.AtriumInsightsUI?.lastPass?.();
    checks.insights = pass && {mode: pass.mode, why: pass.why, ms: Math.round(pass.ms)};
    checks.scheduler = globalThis.AtriumChecks?.scheduler?.stats?.();
    return {metrics, checks, env: {refreshHz, ua: navigator.userAgent, dpr: devicePixelRatio, canvas: [cv().width, cv().height]}};
  }

  // ---------------------------------------------------------------- open
  let project, stats;
  const t0 = performance.now();
  if (options.files) {
    const read = f => new Promise((ok, no) => {const x = new XMLHttpRequest(); x.open("GET", f.url); x.responseType = "arraybuffer"; x.onload = () => ok(new File([x.response], f.name)); x.onerror = () => no(Error("cannot read " + f.url)); x.send();});
    const files = await Promise.all(options.files.map(read));
    const tr = performance.now();
    metrics.openReadMs = +(tr - t0).toFixed(1);
    const before = H().project();
    await H().openFiles(files);
    for (let k = 0; k < 600 && H().project() === before; k++) await wait(50);
    metrics.openMs = +(performance.now() - tr).toFixed(1);
    await closeDialogs();
    project = H().project();
  } else {
    ({project, stats} = makeAtriumSchBenchProject({sheets: options.sheets || 30}));
    const t = performance.now();
    await H().replaceProject(project, {force: true});
    metrics.openSyncMs = +(performance.now() - t).toFixed(1);
    metrics.openMs = +(performance.now() - t).toFixed(1);
  }
  const sheets = project.documents.filter(d => d.kind === "schematic");
  const dense = sheets.slice().sort((a, b) => b.items.length - a.items.length)[0];
  // First paint of the densest sheet after open.
  metrics.openFirstPaintMs = frame(() => H().selectDocument(dense.id));
  metrics.openToSheetMs = +(performance.now() - t0).toFixed(1);
  checks.project = {sheets: sheets.length, items: sheets.reduce((a, d) => a + d.items.length, 0), parts: sheets.reduce((a, d) => a + d.items.filter(i => i.kind === "part").length, 0), denseItems: dense.items.length, ...(stats || {})};
  await settle(2500);
  metrics.heapOpenMB = heap();

  // ---------------------------------------------------------------- idle (energy)
  if (want("idle")) {
    // How long the editor keeps working after open: until two seconds pass with no wake-up at all
    // (timers, frames, idle callbacks), at most 30 s. Then a 5 s window that should be quiet.
    const q0 = performance.now(); let quietSince = performance.now(), total = 0, cpu0 = null;
    mark("settle-start");
    counting = true;
    while (performance.now() - q0 < 30000) {
      const before = wake.timeout + wake.interval + wake.raf + wake.idle;
      await idleFor(250);
      const after = wake.timeout + wake.interval + wake.raf + wake.idle;
      if (after !== before) {quietSince = performance.now(); total += after - before;}
      else if (performance.now() - quietSince >= 2000) break;
    }
    counting = false; mark("settle-end"); void cpu0;
    metrics.openQuietAfterMs = Math.round(quietSince - t0);
    checks.openSettleWakeups = {total, top: [...wake.sources].sort((a, b) => b[1] - a[1]).slice(0, 8)};
    wake.timeout = wake.interval = wake.raf = wake.idle = 0; wake.sources.clear();
    mark("idle-start"); counting = true;
    const i0 = performance.now(); await idleFor(5000); const ms = performance.now() - i0;
    counting = false; mark("idle-end");
    metrics.idleWakeupsPerSec = +((wake.timeout + wake.interval + wake.raf + wake.idle) / (ms / 1000)).toFixed(2);
    checks.idleWakeups = {timeout: wake.timeout, interval: wake.interval, raf: wake.raf, idle: wake.idle, top: [...wake.sources].sort((a, b) => b[1] - a[1]).slice(0, 8)};
    // The settle loop's own 16 ms timers are not counted (they are the probe's, created before counting).
  }

  (checks.heapMB ??= []).push(['before sheet switch', heap()]);
  // ---------------------------------------------------------------- sheet switch
  if (want("switch")) {
    const order = sheets.slice(0, 16);
    const cold = [], warm = [];
    for (const d of order) {if (d === dense) continue; cold.push(frame(() => H().selectDocument(d.id))); await settle(80);}
    for (let r = 0; r < 2; r++) for (const d of order) {warm.push(frame(() => H().selectDocument(d.id))); await settle(60);}
    metrics.sheetSwitchCold = stat(cold); metrics.sheetSwitchWarm = stat(warm);
    const lt = performance.now(); H().selectDocument(dense.id); flushRAF(); await settle(1500);
    checks.switchLong = longIn(lt - 20000, performance.now());
  }
  H().selectDocument(dense.id); flushRAF(); act("fit"); await settle(400);
  const box = cv().getBoundingClientRect(), mid = [box.left + box.width / 2, box.top + box.height / 2];

  (checks.heapMB ??= []).push(['before camera', heap()]);
  // ---------------------------------------------------------------- camera
  if (want("camera")) {
    const pan = [], zoom = [], panZoomed = [], drag = [], hover = [];
    for (let i = 0; i < 60; i++) pan.push(frame(() => wheel(mid[0], mid[1], {deltaX: (i % 20 < 10 ? 1 : -1) * 24, deltaY: 0})));
    await settle(200);
    for (let i = 0; i < 40; i++) zoom.push(frame(() => wheel(mid[0], mid[1], {deltaY: i < 20 ? -60 : 60, ctrlKey: true})));
    await settle(200);
    for (let i = 0; i < 10; i++) frame(() => wheel(mid[0], mid[1], {deltaY: -100, ctrlKey: true}));
    await settle(300);
    for (let i = 0; i < 60; i++) panZoomed.push(frame(() => wheel(mid[0], mid[1], {deltaX: 0, deltaY: (i % 20 < 10 ? 1 : -1) * 24})));
    await settle(200);
    // Right-drag pan (the Altium habit).
    let p = [...mid];
    pev("pointerdown", p, {button: 2, buttons: 2});
    for (let i = 0; i < 40; i++) {p = [p[0] + (i < 20 ? 6 : -6), p[1] + 2]; drag.push(frame(() => pev("pointermove", p, {button: -1, buttons: 2})));}
    pev("pointerup", p, {button: 2, buttons: 0}); mev("contextmenu", p, {button: 2}); await closeDialogs(); document.querySelector(".context-menu")?.remove?.();
    await settle(300);
    for (let i = 0; i < 60; i++) hover.push(frame(() => pev("pointermove", [mid[0] + (i % 30) * 4, mid[1] + (i % 7) * 3], {buttons: 0, button: -1})));
    metrics.panFit = stat(pan); metrics.zoomWheel = stat(zoom); metrics.panZoomed = stat(panZoomed); metrics.rightDragPan = stat(drag); metrics.hover = stat(hover);
    act("fit"); await settle(400);
  }
  const doc = () => H().doc();
  const at = (pt) => scr(pt);
  // A click on a check marker inspects it instead of selecting or dragging (sch-markers.js), and
  // "board out of sync" markers sit on part origins, so grab objects at a point that hits the object
  // and no marker.
  const markerFree = i => {const M = globalThis.AtriumSchMarkers, pane = H().panes?.().find(p => p.canvas === cv()); if (!M?.markerAt || !pane) return true; const [x, y] = at([i.x, i.y]); try {return !M.markerAt(pane, x, y);} catch {return true;}};
  const grab = item => {
    for (const [dx, dy] of [[0, 0], [-1.5, 0], [1.5, 0], [0, 1.2], [-3, 0], [3, 0], [-1, 1], [0, -1.2], [-4.5, 0]]) {
      const w = {x: item.x + dx, y: item.y + dy};
      if (H().hitAt([w.x, w.y])?.id === item.id && markerFree(w)) return [w.x, w.y];
    }
    return null;
  };
  const parts = () => doc().items.filter(i => i.kind === "part");
  const partAt = k => {const l = parts(); return l[k % Math.max(1, l.length)];};
  const zoomTo = async (item, z = 6) => {act("fit"); await settle(100); H().centerOn([item.x, item.y]); for (let i = 0; i < z; i++) frame(() => wheel(...at([item.x, item.y]), {deltaY: -100, ctrlKey: true})); await settle(300);};

  (checks.heapMB ??= []).push(['before part move-drag and w', heap()]);
  // ---------------------------------------------------------------- part move-drag and wire drag
  if (want("drag")) {
    const part = parts()[Math.floor(parts().length / 2)];
    await zoomTo(part, 4);
    const moves = [];
    let p = at(grab(part) || [part.x, part.y]);
    const x0 = part.x;
    checks.partGrab = !!grab(part);
    pev("pointerdown", p);
    for (let i = 0; i < 40; i++) {p = [p[0] + 3, p[1] + (i % 2)]; moves.push(frame(() => pev("pointermove", p)));}
    metrics.partDrop = frame(() => pev("pointerup", p, {buttons: 0}));
    metrics.partDrag = stat(moves);
    checks.partMoved = +(doc().items.find(i => i.id === part.id).x - x0).toFixed(2);
    await settle(1500);
    metrics.undo = frame(() => act("undo")); await settle(600);
    metrics.redo = frame(() => act("redo")); await settle(600);
    act("undo"); await settle(600);
    // Drag a wire segment (rubber-banding the attached wires).
    const mid = i => [(i.points[0][0] + i.points[1][0]) / 2, (i.points[0][1] + i.points[1][1]) / 2];
    const cands = doc().items.filter(i => i.kind === "wire" && i.points.length === 2 && i.points[0][1] === i.points[1][1] && Math.abs(i.points[0][0] - i.points[1][0]) > 5);
    let w = null, mp = null;
    for (const c of cands.slice(0, 12)) {
      await zoomTo({x: mid(c)[0], y: mid(c)[1]}, 4);
      for (const f of [.5, .3, .7]) {const m = [c.points[0][0] + (c.points[1][0] - c.points[0][0]) * f, c.points[0][1]]; if (H().hitAt(m)?.id === c.id && markerFree({x: m[0], y: m[1]})) {w = c; mp = m; break;}}
      if (w) break;
    }
    if (w) {
      checks.wireGrab = H().hitAt(mp)?.id === w.id && markerFree({x: mp[0], y: mp[1]});
      const wd = []; let q = at(mp);
      const was = JSON.stringify(w.points);
      pev("pointerdown", q);
      for (let i = 0; i < 30; i++) {q = [q[0], q[1] + 2]; wd.push(frame(() => pev("pointermove", q)));}
      metrics.wireDrop = frame(() => pev("pointerup", q, {buttons: 0}));
      checks.wireChanged = JSON.stringify(doc().items.find(i => i.id === w.id)?.points) !== was;
      metrics.wireDrag = stat(wd);
      await settle(800); act("undo"); await settle(600);
    }
  }

  (checks.heapMB ??= []).push(['before wire draw', heap()]);
  // ---------------------------------------------------------------- wire draw
  if (want("wire")) {
    act("fit"); await settle(200);
    const b = doc().items.reduce((m, i) => i.x != null ? [Math.min(m[0], i.x), Math.min(m[1], i.y), Math.max(m[2], i.x), Math.max(m[3], i.y)] : m, [1e9, 1e9, -1e9, -1e9]);
    const start = [b[0] - 10.16, b[3] + 10.16];
    await zoomTo({x: start[0], y: start[1]}, 3);
    const nw0 = doc().items.filter(i => i.kind === "wire").length;
    act("route"); await settle(100);
    let p = at(start);
    frame(() => {pev("pointerdown", p); pev("pointerup", p, {buttons: 0});});
    const moves = [];
    for (let i = 0; i < 40; i++) {p = [p[0] + 4, p[1] + (i % 3)]; moves.push(frame(() => pev("pointermove", p, {buttons: 0, button: -1})));}
    metrics.wireDrawMove = stat(moves);
    metrics.wireClick = frame(() => {pev("pointerdown", p); pev("pointerup", p, {buttons: 0});});
    const nw = doc().items.filter(i => i.kind === "wire").length;
    metrics.wireFinish = frame(() => {key("Escape"); key("Escape");});
    checks.wiresAdded = doc().items.filter(i => i.kind === "wire").length - nw0;
    act("select"); await settle(800);
  }

  (checks.heapMB ??= []).push(['before one edit: deferred w', heap()]);
  // ---------------------------------------------------------------- one edit: deferred work after it
  if (want("edit")) {
    act("fit"); await settle(1500);
    const part = partAt(3);
    const samples = [], after = [];
    for (let k = 0; k < 5; k++) {
      await settle(1200);
      mark("edit-start");
      const t = performance.now();
      samples.push(frame(() => H().edit(() => {part.y += 2.54 * (k % 2 ? -1 : 1);}, "probe nudge", [part])));   // with its touched set
      await settle(2500);
      mark("edit-end");
      after.push(longIn(t, performance.now()));
    }
    metrics.editFrame = stat(samples);
    metrics.editAfterLongMax = Math.max(...after.map(a => a.max));
    metrics.editAfterLongTotal = +Math.max(...after.map(a => a.total)).toFixed(1);
    // Keyboard nudge of one selected part (arrow key moves the selection).
    H().select([part.id], part.id); flushRAF(); await settle(200);
    const nudge = [];
    for (let k = 0; k < 10; k++) {nudge.push(frame(() => key(k % 2 ? "ArrowLeft" : "ArrowRight"))); await settle(150);}
    metrics.nudgeOne = stat(nudge);
    H().select([]); flushRAF(); await settle(1000);
  }

  (checks.heapMB ??= []).push(['before select all', heap()]);
  // ---------------------------------------------------------------- select all, move all
  if (want("selectAll")) {
    act("fit"); await settle(300);
    metrics.selectAll = frame(() => act("select-all"));
    await settle(500);
    const sel = H().selection().length;
    const part = parts().find(i => grab(i)) || partAt(0);
    const moves = [];
    let p = at(grab(part) || [part.x, part.y]);
    const x0 = part.x;
    pev("pointerdown", p);
    for (let i = 0; i < 20; i++) {p = [p[0] + 3, p[1] + 1]; moves.push(frame(() => pev("pointermove", p)));}
    metrics.moveAllDrop = frame(() => pev("pointerup", p, {buttons: 0}));
    checks.moveAllMoved = +(doc().items.find(i => i.id === part.id).x - x0).toFixed(2);
    metrics.moveAllDrag = stat(moves);
    checks.selectAllCount = sel;
    await settle(1500);
    metrics.undoMoveAll = frame(() => act("undo")); await settle(1500);
    metrics.deselect = frame(() => key("Escape")); H().select([]); await settle(500);
  }

  (checks.heapMB ??= []).push(['before net highlight', heap()]);
  // ---------------------------------------------------------------- net highlight
  if (want("highlight")) {
    const label = doc().items.find(i => i.kind === "netlabel" && /OUT/.test(i.text)) || doc().items.find(i => i.kind === "netlabel");
    if (label) {
      metrics.netHighlight = frame(() => H().setHighlight(label.text));
      await settle(300);
      const pan = [];
      for (let i = 0; i < 30; i++) pan.push(frame(() => wheel(mid[0], mid[1], {deltaX: (i % 10 < 5 ? 1 : -1) * 24, deltaY: 0})));
      metrics.panHighlighted = stat(pan);
      const part = partAt(5), ed = [];
      for (let k = 0; k < 4; k++) {ed.push(frame(() => H().edit(() => {part.x += k % 2 ? -2.54 : 2.54;}, "probe"))); await settle(800);}
      metrics.editHighlighted = stat(ed);
      metrics.netHighlightClear = frame(() => H().clearHighlight());
      await settle(500);
    }
  }

  (checks.heapMB ??= []).push(['before compile (ERC)', heap()]);
  // ---------------------------------------------------------------- compile (ERC), annotate, cross-probe, search
  if (want("compile")) {
    await AtriumLazy.need("AtriumERC").catch(() => {});
    const t = performance.now();
    const r = AtriumERC.run(H().project());
    metrics.compileErc = +(performance.now() - t).toFixed(1);
    checks.ercCounts = r.counts;
    const t2 = performance.now(); act("compile"); flushRAF(); raster();
    metrics.compileAction = +(performance.now() - t2).toFixed(1);
    await settle(1500); await closeDialogs();
    const tc = performance.now(); AtriumHierarchy.compile(H().project(), {defs: H().defs()});
    metrics.hierarchyCompile = +(performance.now() - tc).toFixed(1);
  }
  if (want("annotate")) {
    await AtriumLazy.need("AtriumAnnotate").catch(() => {});
    if (globalThis.AtriumAnnotate) {
      const t = performance.now();
      const plan = AtriumAnnotate.plan(H().project(), {action: "annotate", order: "across-down"});
      metrics.annotatePlan = +(performance.now() - t).toFixed(1);
      const prep = AtriumAnnotate.prepare(H().project(), plan, {});
      metrics.annotateApply = frame(() => H().edit(prep.execute, "Annotate"));
      checks.annotateChanges = plan.changes.length;
      await settle(2500);
      metrics.annotateUndo = frame(() => act("undo"));
      await settle(2500);
    }
  }
  if (want("crossprobe")) {
    const XP = globalThis.AtriumCrossProbe;
    if (XP) {
      const part = partAt(7);
      const samples = [];
      for (let k = 0; k < 5; k++) {
        const t = performance.now();
        try {const tg = XP.targetForSelection?.(H().doc(), H().defs(), [part]) || {kind: "part", partId: part.id, ref: part.ref, link: part.link || "", docId: doc().id}; XP.resolve?.(H().project(), H().defs(), tg, doc().id);} catch (e) {checks.crossprobeError = e.message;}
        samples.push(performance.now() - t);
      }
      metrics.crossProbeResolve = stat(samples);
      const sel = [];
      const split = [];
      // One select first (it loads the Properties panel's lazy parts), then twelve timed ones.
      {const pp = partAt(1); frame(() => H().select([pp.id], pp.id)); await settle(200);}
      for (let k = 0; k < 12; k++) {
        const pp = partAt(k * 3), f = frameSplit(() => H().select([pp.id], pp.id));
        sel.push(+(f[0] + f[1] + f[2]).toFixed(2)); split.push(f);
        await settle(200);
      }
      checks.selectOneSplit = {camera: H().view().camera?.(), canvas: [cv().width, cv().height], split};
      metrics.selectOne = stat(sel);
      H().select([]); await settle(300);
    }
  }
  if (want("search")) {
    await AtriumLazy.need("AtriumPalette").catch(() => {});
    const P = globalThis.AtriumPalette;
    if (P) {
      const t = performance.now();
      try {P.startIndex?.(); for (let k = 0; k < 400 && !P.readyIndex?.(); k++) await wait(10);} catch {}
      metrics.searchIndexReady = +(performance.now() - t).toFixed(1);
      const qs = ["R12", "OPA", "S3_OUT", "U1_CH", "100k", "D3", "GND", "Module"];
      const s = [];
      for (const q of qs) {const t1 = performance.now(); try {P.searchAll(q, "");} catch (e) {checks.searchError = e.message;} s.push(performance.now() - t1);}
      metrics.searchQuery = stat(s);
      // After one edit, the next query catches up (incremental).
      const part = partAt(9); H().edit(() => {part.value = "47k";}, "probe value"); await settle(600);
      const t2 = performance.now(); try {P.readyIndex?.(); P.searchAll("47k", "");} catch {} metrics.searchAfterEdit = +(performance.now() - t2).toFixed(1);
      act("undo"); await settle(600);
    }
  }

  (checks.heapMB ??= []).push(['before save (incremental se', heap()]);
  // ---------------------------------------------------------------- save (incremental serialisation)
  if (want("save")) {
    await AtriumLazy.need("AtriumSaveCache").catch(() => {});
    const SC = globalThis.AtriumSaveCache;
    if (SC) {
      const p = H().project();
      let t = performance.now(); const a = SC.state(p); metrics.saveStateFirst = +(performance.now() - t).toFixed(1);
      t = performance.now(); SC.state(p); metrics.saveStateUnchanged = +(performance.now() - t).toFixed(1);
      const part = partAt(11); H().edit(() => {part.x += 2.54;}, "probe"); await settle(300);
      t = performance.now(); const b = SC.state(p); metrics.saveStateOneEdit = +(performance.now() - t).toFixed(1);
      // The autosave pass (sliced, journal-certified sheets) after another one-part edit; the pass
      // before it certifies the sheets (autosave runs one after every quiet period).
      {const j = SC.job(p, {journal: true}); while (!j.step(Infinity));}
      H().edit(() => {part.x += 2.54;}, "probe"); await settle(700);
      t = performance.now(); {const j = SC.job(p, {journal: true}); while (!j.step(Infinity));} metrics.autosavePassOneEdit = +(performance.now() - t).toFixed(1);
      checks.autosaveCertified = SC.stats().certified;
      act("undo"); await settle(300);
      t = performance.now(); const d = SC.diff(a, b); metrics.saveDiff = +(performance.now() - t).toFixed(1);
      checks.savePatchBytes = d.bytes; checks.saveTotalBytes = b.total;
      act("undo"); await settle(600);
    }
  }
  metrics.heapEndMB = heap();
  if (want("idle")) {
    // After the last interaction: how long deferred work runs, then a window that should be quiet.
    const q = await untilQuiet();
    metrics.lastEditQuietAfterMs = q.ms; checks.lastEditSettleWakeups = {total: q.total, top: q.top};
    wake.timeout = wake.interval = wake.raf = wake.idle = 0; wake.sources.clear();
    counting = true; const i0 = performance.now(); await idleFor(4000); const ms = performance.now() - i0; counting = false;
    metrics.idleWakeupsAfterPerSec = +((wake.timeout + wake.interval + wake.raf + wake.idle) / (ms / 1000)).toFixed(2);
    checks.idleWakeupsAfter = {timeout: wake.timeout, interval: wake.interval, raf: wake.raf, idle: wake.idle, top: [...wake.sources].sort((a, b) => b[1] - a[1]).slice(0, 8)};
  }
  return {metrics, checks, env: {refreshHz, ua: navigator.userAgent, dpr: devicePixelRatio, canvas: [cv().width, cv().height]}};
}
