"use strict";
// Interaction frame probe for scripts/perf-canvas.sh (stage 2), on the 25.6k-object board of
// tests/pcb/dense-board.js with nets and ten poured polygons. It drives the real editor: pointer,
// wheel and key events go to the canvas, and each frame is timed synchronously (rAF is queued and
// flushed inside the timed block, then getImageData forces the raster). atriumInteractionProbe()
// resolves to {metrics: {name: ms | {p50, p95}}, checks: {name: value}}.
//   Frame metrics (ms): pan, zoom and exact redraws; hover; click-select; box marquee drag; part
//   move-drag with tracks; interactive routing (walkaround, push); undo, redo; Ctrl+click net
//   highlight and its pan; Filter mask apply and pan; Navigator net click.
//   Undo: the store's per-step record (undoRecord). Heap: growth over 180 scripted edits, undos and
//   redos after a 60-edit warm-up, with the undo history at its smallest budget (heapEditGrowthMB).
//   After an edit: the editor's own edit() frame, the longest live-pour slice, the live commit
//   slice, and the longest main-thread task in the 2 s after the edit (online DRC, airwires …).
//   Checks: frames that reuse the board layer are compared with a full repaint of the same state
//   (differing bytes must be 0); the live repour must finish with no stale pour.
globalThis.atriumInteractionProbe = function(options = {}) {
  // A probe that stalls (a broken page) fails instead of hanging the caller.
  return Promise.race([probeAll(options), new Promise((_, no) => setTimeout(() => no(Error("interaction probe timed out after 300 s")), 300000))]);
};
async function probeAll(options) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  HTMLCanvasElement.prototype.setPointerCapture = function() {}; HTMLCanvasElement.prototype.releasePointerCapture = function() {};
  // The display's refresh rate from real rAF deltas, before rAF is replaced by the queue below.
  const refreshHz = await new Promise(done => {const t = []; const tick = ts => {t.push(ts); if (t.length < 61) requestAnimationFrame(tick); else {
    const d = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b); done(+(1000 / d[d.length >> 1]).toFixed(1));}}; requestAnimationFrame(tick); setTimeout(() => done(null), 3000);});
  const RQ = [];
  window.requestAnimationFrame = cb => {RQ.push(cb); return RQ.length;}; window.cancelAnimationFrame = () => {};
  const flushRAF = () => {for (let k = 0; k < 5 && RQ.length; k++) for (const cb of RQ.splice(0)) cb(performance.now());};
  const H = () => AtriumNavHost, cv = () => H().canvas(), g2 = () => cv().getContext("2d");
  const pixels = () => g2().getImageData(0, 0, cv().width, cv().height).data;
  // The last frame against a full repaint of exactly the same inputs (the captured render call with
  // board-layer reuse off): the count of differing bytes, 0 when the reuse is exact.
  let lastRender = null;
  // full: the exact-frame series measure a full repaint (noReuse: no board-layer copy from canvas-fast.js).
  let full = false;
  {const v = H().view(), r = v.render; v.render = (...a) => {lastRender = a; return full ? r(a[0], a[1], {...a[2], noReuse: true}) : r(...a);};}
  const identity = () => {
    flushRAF(); const a = pixels(); if (!lastRender) return -1;
    const [d, defs, o] = lastRender; H().view().render(d, defs, {...o, reuseBase: false, noReuse: true});
    // Cursor feedback near the pointer changes with time (two full repaints differ there too), so
    // a 48 px square around the pointer is left out.
    const b = pixels(), W = cv().width, dpr = W / cv().getBoundingClientRect().width;
    const at = o.pointer ? H().view().worldToScreen(o.pointer).map(v => v * dpr) : null, r = 48 * dpr;
    let n = 0, box = null;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) {
      if (at) {const q = i >> 2, x = q % W, y = (q / W) | 0; if (Math.abs(x - at[0]) < r && Math.abs(y - at[1]) < r) continue;}
      n++; const q = i >> 2, x = q % W, y = (q / W) | 0; box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];}
    if (n) (checks.diffAt ??= []).push(box.concat(lastRender[2].pointer ? H().view().worldToScreen(lastRender[2].pointer).map(Math.round) : []));
    return n;
  };
  const pct = (a, p) => {const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))].toFixed(2);};
  const stat = a => a.length ? {p50: pct(a, .5), p95: pct(a, .95), p99: pct(a, .99)} : null;
  const frame = fn => {const t = performance.now(); fn(); flushRAF(); g2().getImageData(0, 0, 1, 1); return +(performance.now() - t).toFixed(2);};
  const scr = w => {const b = cv().getBoundingClientRect(), s = H().view().worldToScreen(w); return [s[0] + b.left, s[1] + b.top];};
  const pev = (type, [x, y], o = {}) => cv().dispatchEvent(new PointerEvent(type, {clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, bubbles: true, cancelable: true, isPrimary: true, pointerType: "mouse", ...o}));
  const wheel = (x, y, o) => cv().dispatchEvent(new WheelEvent("wheel", {clientX: x, clientY: y, bubbles: true, cancelable: true, deltaMode: 0, ...o}));
  const act = a => window.dispatchEvent(new CustomEvent("atrium-command", {detail: a}));
  const settle = async ms => {const t = performance.now(); while (performance.now() - t < ms) {await wait(20); flushRAF();}};
  const heap = () => {try {window.gc?.(); window.gc?.();} catch {} return performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;};
  const long = [];
  try {new PerformanceObserver(l => {for (const e of l.getEntries()) long.push(Math.round(e.duration));}).observe({type: "longtask"});} catch {}
  const visible = (i, m = 60) => {const b = cv().getBoundingClientRect(), q = H().view().worldToScreen(i.x != null ? [i.x, i.y] : i.points[0]); return q[0] > m && q[1] > m && q[0] < b.width - m && q[1] < b.height - m;};
  // A 60 x 40 mm view around (x, y), about 1/30 of the board.
  const zoomedAt = async (x, y) => {H().setLayer("Top"); H().zoomTo([x - 30, y - 20, x + 30, y + 20]); await settle(150);};
  const metrics = {}, checks = {refreshHz, frameBudgetMs: refreshHz ? +(1000 / refreshHz).toFixed(2) : null};

  // The board: dense-board.js, vias, pads and parts on 64 nets, ten pours poured once.
  await AtriumLazy.need("AtriumRules"); await AtriumLazy.need("AtriumPCBDraw"); await AtriumLazy.need("AtriumRouter");
  await AtriumLazy.need("AtriumCanvasFast"); // board-layer copy, selection frames, pour index
  const PP = AtriumPolygonPour, p = Atrium.project("Dense", AtriumParts.catalogue), old = p.documents.find(x => x.kind === "pcb");
  const {d} = makeAtriumBenchmarkBoard(); p.documents = p.documents.map(x => x === old ? d : x);
  let k = 0;
  for (const i of d.items) {if (i.kind === "part") i.pinNets = {"1": "N" + (k % 64), "2": "N" + ((k + 1) % 64)}; else if (i.kind !== "track") i.net = "N" + (k % 64); k++;}
  const rect = (a, b, c, e) => [[a, b], [c, b], [c, e], [a, e]];
  const polys = [["Top", "GND", rect(1, 1, 180, 270)], ["Top", "VCC", rect(180, 1, 367, 270)], ["Bottom", "GND", rect(1, 1, 367, 140)], ["Bottom", "VCC", rect(1, 140, 367, 270)]];
  for (let j = 0; j < 6; j++) polys.push([j % 2 ? "Top" : "Bottom", "N" + j, rect(10 + j * 55, 10, 50 + j * 55, 40)]);
  polys.forEach(([layer, net, o], j) => d.items.push(PP.make(o, {layer, net, pourIndex: j, removeDeadCopper: false})));
  await H().replaceProject(p, {force: true}); H().selectDocument(d.id);
  globalThis.AtriumStartPage?.close();
  await settle(300);
  H().edit(() => PP.apply(H().doc(), H().defs(), {project: H().project()}));
  act("fit"); await settle(2500);
  checks.items = H().doc().items.length; checks.heapLoadedMB = heap();
  // DRC markers are drawn by drc-markers.js (budgeted with it); here they are hidden.
  if (options.markers === false) globalThis.AtriumDRCMarkers?.setVisible?.(false, H());
  const b = cv().getBoundingClientRect(), mid = [b.left + b.width / 2, b.top + b.height / 2];
  const series = (n, f) => {const s = []; for (let i = 0; i < n; i++) s.push(frame(() => f(i))); return stat(s);};
  const exact = n => {full = true; try {return series(n, () => H().redraw());} finally {full = false;}};

  // Pan and zoom (gesture frames) and exact redraws, at fit and zoomed in.
  metrics.panFit = series(30, () => wheel(...mid, {deltaX: 6, deltaY: 4}));
  metrics.exactFit = exact(8);
  await zoomedAt(180, 130);
  metrics.panZoomed = series(30, () => wheel(...mid, {deltaX: 6, deltaY: 4}));
  metrics.exactZoomed = exact(8);
  metrics.zoomZoomed = series(30, i => wheel(...mid, {deltaY: i % 2 ? -40 : 40, deltaMode: 1}));
  metrics.hover = series(30, i => pev("pointermove", [mid[0] + i * 3, mid[1] + i], {buttons: 0}));
  // Layer toggles: single-layer view cycles (Shift+S) and the active layer (+ / -).
  await AtriumLazy.need("AtriumAltiumKeys");
  const layer0 = H().activeLayer();
  metrics.layerToggle = series(12, i => act(i % 4 === 3 ? "layer-next" : "layer-mode"));
  H().setLayerMode?.("all"); H().setLayer(layer0 || "Top"); flushRAF(); await settle(100);
  {
    const vias = H().doc().items.filter(i => i.kind === "via" && visible(i)).slice(0, 15), s = [];
    for (const it of vias) {const q = scr([it.x, it.y]); pev("pointermove", q, {buttons: 0}); s.push(frame(() => {pev("pointerdown", q); pev("pointerup", q);}));}
    metrics.click = stat(s); H().select([]); flushRAF();
  }
  // Box marquee from the empty corner of the fit view across a quarter of the board.
  {
    act("fit"); await settle(700); // Fit is a camera flight (up to 320 ms)
    let e = null; for (let q = 4; q < 120 && !e; q += 2) for (const [x, y] of [[q, q], [q, 8], [8, q]]) if (!e && !H().hitAt(H().view().screenToWorld([x, y]))) e = [b.left + x, b.top + y];
    checks.boxStart = !!e;
    if (e) {
      pev("pointermove", e, {buttons: 0}); frame(() => pev("pointerdown", e));
      metrics.boxDrag = series(25, i => pev("pointermove", [e[0] + (i + 1) * 16, e[1] + (i + 1) * 10]));
      checks.boxReuseDiff = identity();
      metrics.boxUp = frame(() => pev("pointerup", [e[0] + 400, e[1] + 250])); H().select([]); flushRAF();
    }
  }
  // Move-drag of a part whose pads have tracks (re-routed while dragging), and the drop.
  {
    await zoomedAt(180, 130);
    const part = H().doc().items.find(i => i.kind === "part" && visible(i, 200)), pins = Atrium.pins(part, H().defs().get(part.def), "pcb");
    H().edit(() => {for (const pin of pins) H().doc().items.push({id: "mv" + pin.number, kind: "track", layer: "Top", width: .2, net: part.pinNets[pin.number],
      points: [pin.at, [pin.at[0] + 1, pin.at[1] + 1.2], [pin.at[0] + 3, pin.at[1] + 1.2]]});});
    await settle(400);
    const q = scr([part.x, part.y]); H().select([part.id]); flushRAF(); pev("pointermove", q, {buttons: 0}); frame(() => pev("pointerdown", q));
    metrics.moveDrag = series(25, i => pev("pointermove", [q[0] + (i + 1) * 2, q[1] + (i + 1)]));
    metrics.moveDrop = frame(() => pev("pointerup", [q[0] + 50, q[1] + 25]));
    await settle(1500); H().select([]); flushRAF();
  }
  // Interactive routing from a via, walkaround then push. Motion is off here: route-feel eases
  // shoves and halos over time, which would make two renders of one state differ.
  const R = document.documentElement, motion = R.getAttribute("data-motion");
  R.setAttribute("data-motion", "off");
  for (const mode of ["walkaround", "push"]) {
    await zoomedAt(180, 130);
    const via = H().doc().items.filter(i => i.kind === "via" && visible(i, 150))[3], q = scr([via.x, via.y]);
    act("route");
    const deadline = performance.now() + 5000;
    while (H().tool() !== "route" && performance.now() < deadline) await settle(20);
    if (H().tool() !== "route") throw Error("The editor did not arm interactive routing.");
    flushRAF(); pev("pointermove", q, {buttons: 0});
    frame(() => {pev("pointerdown", q); pev("pointerup", q);});
    while (!H().routeTool?.() && performance.now() < deadline) await settle(20);
    for (let g = 0; g < AtriumRouter.modes.length && H().routeTool?.() && H().routeTool().state().mode !== mode; g++) {
      cv().dispatchEvent(new KeyboardEvent("keydown", {key: "R", code: "KeyR", shiftKey: true, bubbles: true, cancelable: true}));
      flushRAF();
    }
    checks[mode + "Mode"] = H().routeTool?.()?.state?.().mode || "none";
    metrics[mode] = series(25, i => pev("pointermove", [q[0] + (i + 1) * 6, q[1] + (i + 1) * (i % 3)], {buttons: 0}));
    checks[mode + "ReuseDiff"] = identity();
    for (const key of ["Escape", "Escape"]) cv().dispatchEvent(new KeyboardEvent("keydown", {key, code: key, bubbles: true}));
    act("select"); flushRAF(); await settle(100);
  }
  if (motion == null) R.removeAttribute("data-motion"); else R.setAttribute("data-motion", motion);
  // An edit: the edit frame, then live pours (sliced) and the after-edit work.
  {
    for (let n = 0; n < 200 && PP.live.busy; n++) await settle(20);
    const it = H().doc().items.find(i => i.kind === "track" && i.points[0][0] > 100); long.length = 0;
    metrics.editFrame = frame(() => H().edit(() => {it.points = it.points.map(q => [q[0] + .05, q[1]]);}));
    for (let n = 0; n < 400 && (PP.live.busy || n < 100); n++) await settle(20);
    const L = PP.live.last;
    metrics.liveSliceMax = L ? +L.longest.toFixed(2) : null; metrics.liveCommit = L ? +L.commit.toFixed(2) : null;
    metrics.afterEditTaskMax = long.slice(1).reduce((a, v) => Math.max(a, v), 0);
    checks.liveStale = PP.stale(H().doc(), H().defs()).length; checks.liveSlices = L?.slices?.length ?? 0;
  }
  // Undo and redo of single edits.
  {
    const it = H().doc().items.find(i => i.kind === "via" && i.x > 100);
    for (let i = 0; i < 3; i++) {H().edit(() => {it.x += .1;}); await settle(150);}
    const u = [], r = [];
    for (let i = 0; i < 3; i++) {u.push(frame(() => act("undo"))); await settle(200);}
    for (let i = 0; i < 3; i++) {r.push(frame(() => act("redo"))); await settle(200);}
    metrics.undo = stat(u); metrics.redo = stat(r);
    for (let n = 0; n < 200 && PP.live.busy; n++) await settle(20);
    // Recording a step: the undo store's mark when the editor is idle (undo-store.js; the change
    // itself is recorded later, when idle).
    const U = globalThis.AtriumUndoStore, rec = [];
    if (U?.mark) for (let i = 0; i < 20; i++) {const t = performance.now(); U.mark(H().project(), {}); rec.push(+(performance.now() - t).toFixed(3));}
    metrics.undoRecord = stat(rec);
  }
  // Heap over scripted edits (moves, undo, redo), after a 60-edit warm-up: what edits retain beyond
  // the undo history must stay small. The history is bounded by history.undoBudgetMB (64 by default;
  // tests/history/undo-store.cjs), and on this board one live repour's step holds megabytes of old copper, so
  // where a 180-edit window falls in the history's fill-and-trim cycle would move the heap by tens of
  // MB with nothing leaking. The budget is at its floor (4 MB) for this measurement, then restored.
  {
    const its = H().doc().items.filter(i => i.kind === "via" || i.kind === "track");
    const one = n => {const it = its[(n * 7919) % its.length]; if (n % 6 === 4) act("undo"); else if (n % 6 === 5) act("redo");
      else H().edit(() => {if (it.points) it.points = it.points.map(q => [q[0] + .01, q[1]]); else it.x += .01;});};
    const U = globalThis.AtriumUndoStore, undoMB = () => {const s = U?.stats?.(); return s ? +(s.bytes / 1048576).toFixed(1) : null;};
    const P = globalThis.AtriumPref, had = P?.get?.("history.undoBudgetMB");
    P?.set?.("history.undoBudgetMB", 4);
    try {
      for (let n = 0; n < 60; n++) {one(n); flushRAF(); await settle(40);}
      for (let n = 0; n < 200 && PP.live.busy; n++) await settle(20);
      await settle(500); checks.heapWarmMB = heap(); checks.undoWarmMB = undoMB();
      for (let n = 60; n < 240; n++) {one(n); flushRAF(); await settle(40);}
      for (let n = 0; n < 200 && PP.live.busy; n++) await settle(20);
      await settle(500); checks.heapEditsMB = heap(); checks.undoEditsMB = undoMB();
    } finally {P?.set?.("history.undoBudgetMB", had ?? 64);}
    metrics.heapEditGrowthMB = checks.heapWarmMB != null ? +(checks.heapEditsMB - checks.heapWarmMB).toFixed(1) : null;
  }
  // Ctrl+click net highlight (Altium): the click, then pan and exact frames with the mask.
  {
    await zoomedAt(180, 130); await AtriumLazy.need("AtriumAltiumKeys");
    const it = H().doc().items.find(i => i.kind === "via" && visible(i, 100) && H().hitAt([i.x, i.y])?.net);
    if (!it) throw Error("no via to Ctrl+click: " + JSON.stringify({vias: H().doc().items.filter(i => i.kind === "via" && visible(i, 100)).length, hit: (v => v && H().hitAt([v.x, v.y]))(H().doc().items.find(i => i.kind === "via" && visible(i, 100)))?.kind, layer: H().activeLayer(), cam: H().view().camera(), status: document.getElementById("status")?.textContent}));
    const q = scr([it.x, it.y]);
    pev("pointermove", q, {buttons: 0});
    frame(() => {pev("pointerdown", q, {ctrlKey: true}); pev("pointerup", q, {ctrlKey: true});});
    checks.netHighlighted = H().highlight();
    const vias = H().doc().items.filter(i => i.kind === "via" && visible(i, 100) && H().hitAt([i.x, i.y])?.net).slice(1, 13), nc = [];
    for (const v of vias) {const r = scr([v.x, v.y]); pev("pointermove", r, {buttons: 0}); nc.push(frame(() => {pev("pointerdown", r, {ctrlKey: true}); pev("pointerup", r, {ctrlKey: true});}));}
    metrics.netClick = stat(nc);
    metrics.netExact = exact(8);
    metrics.netPan = series(25, () => wheel(...mid, {deltaX: 6, deltaY: 4}));
    H().clearHighlight(); flushRAF();
  }
  // Filter panel, Mask mode.
  {
    const Q = globalThis.AtriumQuery || await AtriumLazy.need("AtriumQuery"), m = {select: false, zoom: false, mask: true, highlight: false};
    metrics.maskApply = frame(() => Q.apply("InNet('N5') Or InNet('N6')", m, {quiet: true}));
    metrics.maskExact = exact(8);
    metrics.maskPan = series(25, () => wheel(...mid, {deltaX: 6, deltaY: 4}));
    metrics.maskApplyAllTracks = frame(() => Q.apply("IsTrack", m, {quiet: true}));
    metrics.maskPanAllTracks = series(20, () => wheel(...mid, {deltaX: 6, deltaY: 4}));
    Q.clear(true); flushRAF();
  }
  // Navigator: click net rows (highlight, mask, zoom).
  {
    await zoomedAt(180, 130);
    const N = globalThis.AtriumNavigatorPanel || await AtriumLazy.need("AtriumNavigatorPanel");
    N.toggle(true); await settle(200);
    const rows = t => [...document.querySelectorAll(".navp-row:not([hidden])")].filter(n => n.dataset.type === t);
    rows("group").find(g => /^Components/.test(g.textContent))?.click(); flushRAF();
    const s = []; for (let j = 0; j < 8; j++) {const r = rows("net")[j]; if (!r) break; s.push(frame(() => r.click())); await settle(30);}
    metrics.navClick = stat(s); checks.navRows = s.length;
    N.toggle(false); globalThis.AtriumQuery?.clear(true); H().clearHighlight(); flushRAF();
  }
  checks.heapEndMB = heap();
  return {metrics, checks};
}
