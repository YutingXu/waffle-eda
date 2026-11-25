"use strict";
// Tiled live repour probe for scripts/perf-pour.sh, on the 25.6k-object board of tests/pcb/dense-board.js
// with nets and ten poured polygons (the board of tests/editor/perf-interact.js). Real clock: rAF, timers and
// workers run as in the app. atriumPourProbe() resolves to {metrics, checks}.
//   editToScreen   a single-object edit (move a part, a via or a track) to the first painted frame
//                  whose changed copper pixels match the exact fill (p50/p95 ms)
//   tileRepour     the legacy worker's affected-tile repour when it supplied a patch (p50/p95 ms)
//   editToExact    the same edits to the exact repour's commit (the copper Gerber reads)
//   dragFrame      frame intervals while a part is dragged (rAF deltas, p50/p95/max ms)
//   dragPatch      drag frames: move to its tile patch applied (p50/p95 ms); dragPatches = patches applied
//   dragLongTasks  main-thread long tasks (> 50 ms) during the drag: must be 0
//   dropToScreen   pointer-up to the first painted frame showing the new copper; dropToExact to the exact commit
//   repourAll      Repour All (AtriumPolygonPour.apply) on the main thread, for reference
//   tileInit       building the tile sessions (main-thread keyed prepare in slices + worker init)
globalThis.atriumPourProbe = function(options = {}) {
  return Promise.race([probe(options), new Promise((_, no) => setTimeout(() => no(Error("pour probe timed out after 300 s")), 300000))]);
};

// The reference uses the normal software renderer with the same geometry and camera on both sides.
// Only the stored copper changes. Compare high-contrast pixels where the two references disagree,
// so moved tracks, pads, selection and other editor overlays cannot count as updated copper.
function observeCopper(host, PP, doc, frame, wait) {
  const canvas = host.canvas(), view = host.view(), ctx = canvas.getContext("2d"), render = view.render;
  const reference = document.createElement("canvas"), referenceView = AtriumCanvas.create(reference);
  reference.getBoundingClientRect = () => canvas.getBoundingClientRect();
  let sample, lastOptions;
  view.render = function(board, defs, options) {
    render.call(this, board, defs, options);
    if (board !== doc) return;
    lastOptions = options;
    if (!sample || (!sample.captureAll && PP.tiles.last === sample.tile && doc.pcbDrawing.pours === sample.copper)) return;
    const pixels = ctx.getImageData(...sample.crop).data;
    sample.frames.push({pixels, at: performance.now(), tile: PP.tiles.last,
      exactCopper: doc.pcbDrawing.pours !== sample.copper});
  };
  const distance = (a, b, i) => Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
  const bounds = item => Atrium.bounds(Atrium.itemPoints(item, host.defs().get(item.def), "pcb"));
  const cropOf = (item, dx, dy) => {
    const [l, t, r, b] = bounds(item), margin = 1;
    const a = view.worldToScreen([l + Math.min(0, dx) - margin, t + Math.min(0, dy) - margin]);
    const z = view.worldToScreen([r + Math.max(0, dx) + margin, b + Math.max(0, dy) + margin]);
    const x = Math.max(0, Math.floor(Math.min(a[0], z[0]) * devicePixelRatio));
    const y = Math.max(0, Math.floor(Math.min(a[1], z[1]) * devicePixelRatio));
    const w = Math.min(canvas.width, Math.ceil(Math.max(a[0], z[0]) * devicePixelRatio)) - x;
    const h = Math.min(canvas.height, Math.ceil(Math.max(a[1], z[1]) * devicePixelRatio)) - y;
    if (w <= 0 || h <= 0) throw Error("Edited copper is outside the active canvas");
    return [x, y, w, h];
  };
  function references(old, crop) {
    if (!lastOptions) return [];
    const drawing = doc.pcbDrawing, exact = drawing.pours, defs = host.defs();
    const read = () => {
      referenceView.render(doc, defs, {...lastOptions, noReuse: true, reuseBase: false});
      return reference.getContext("2d").getImageData(...crop).data;
    };
    referenceView.restoreCamera(view.camera());
    try {
      // Keep the active board identity so the old copper is rendered with the same live visibility
      // rules. This reference renders only to the detached canvas, with no event or journal write.
      drawing.pours = old;
      const before = read();
      drawing.pours = exact;
      return [before, read()];
    } finally { drawing.pours = exact; }
  }
  return {
    async measure(change, item, dx, dy = 0, {manual = false} = {}) {
      const crop = item ? cropOf(item, dx, dy) : [canvas.width >> 1, canvas.height >> 1, 32, 32];
      const exactBefore = PP.live.last;
      const initial = ctx.getImageData(...crop).data;
      const capture = sample = {crop, copper: doc.pcbDrawing.pours, tile: PP.tiles.last, frames: [], captureAll: manual};
      const start = performance.now();
      let call, commit, exactMs;
      try {
        const done = change();
        call = performance.now() - start;
        if (manual) await done;
        if (!manual) {
          while (performance.now() - start < 8000) {
            const last = PP.live.last;
            if (last && last !== exactBefore && !PP.live.busy) {
              commit = last;
              exactMs = performance.now() - start;
              break;
            }
            await wait(5);
          }
        }
        // Watch normal paints through a short reveal after the commit. The first matching paint
        // keeps its original timestamp. Never ask the live view to repaint here.
        for (let i = 0; i < (manual ? 2 : 16); i++) await frame();
      } finally { sample = null; }
      const [before, exact] = references(capture.copper, crop), witnesses = [];
      if (before) for (let i = 0; i < before.length; i += 4) if (distance(before, exact, i) >= 24) witnesses.push(i);
      const agrees = test => witnesses.length >= 3 && witnesses.filter(test).length >= witnesses.length * .8;
      const settled = pixels => agrees(i => distance(pixels, exact, i) * 3 <= distance(pixels, before, i));
      // Crossfades already reveal the right shape before full opacity. Require a visible move
      // towards the exact colour at the same pixels and a later paint that confirms the fit.
      const visible = pixels => agrees(i => {
        const full = distance(before, exact, i);
        return distance(pixels, before, i) >= 8 && distance(pixels, exact, i) <= full - 6;
      });
      const alreadyVisible = settled(initial);
      const confirmed = capture.frames.some(f => settled(f.pixels));
      const shown = alreadyVisible || !confirmed ? null : capture.frames.find(f => visible(f.pixels));
      const tile = capture.frames.find(f => f.tile !== capture.tile)?.tile;
      return {call, at: shown ? shown.at - start : null, tile, editToTile: tile ? tile.t0 - start : null,
        paintedBy: shown ? shown.exactCopper ? "exact" : "tile" : null,
        exactMs, commit, alreadyVisible, confirmed, witnesses: witnesses.length, frames: capture.frames.length};
    },
    restore() { view.render = render; },
  };
}

async function probe(options) {
  const wait = ms => new Promise(r => setTimeout(r, ms)), frame = () => new Promise(r => requestAnimationFrame(r));
  HTMLCanvasElement.prototype.setPointerCapture = function() {}; HTMLCanvasElement.prototype.releasePointerCapture = function() {};
  const H = () => AtriumNavHost, cv = () => H().canvas();
  const pct = (a, p) => {const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))].toFixed(2) : null;};
  const stat = a => a.length ? {p50: pct(a, .5), p95: pct(a, .95), max: pct(a, 1), n: a.length} : null;
  const long = [];
  try {new PerformanceObserver(l => {for (const e of l.getEntries()) long.push({at: e.startTime, ms: Math.round(e.duration)});}).observe({type: "longtask"});} catch {}
  const metrics = {}, checks = {};
  // Refresh rate from rAF deltas.
  {const t = []; for (let i = 0; i < 31; i++) t.push(await frame()); const d = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b); checks.refreshHz = +(1000 / d[d.length >> 1]).toFixed(1);}
  await AtriumLazy.need("AtriumRules"); await AtriumLazy.need("AtriumPCBDraw"); await AtriumLazy.need("AtriumRouter"); await AtriumLazy.need("AtriumPolygonPour");
  try {await AtriumLazy.need("AtriumEngine");} catch {}
  const PP = AtriumPolygonPour, p = Atrium.project("Dense", AtriumParts.catalogue), old = p.documents.find(x => x.kind === "pcb");
  const {d} = makeAtriumBenchmarkBoard(); p.documents = p.documents.map(x => x === old ? d : x);
  let k = 0;
  for (const i of d.items) {if (i.kind === "part") i.pinNets = {"1": "N" + (k % 64), "2": "N" + ((k + 1) % 64)}; else if (i.kind !== "track") i.net = "N" + (k % 64); k++;}
  const rect = (a, b, c, e) => [[a, b], [c, b], [c, e], [a, e]];
  const polys = [["Top", "GND", rect(1, 1, 180, 270)], ["Top", "VCC", rect(180, 1, 367, 270)], ["Bottom", "GND", rect(1, 1, 367, 140)], ["Bottom", "VCC", rect(1, 140, 367, 270)]];
  for (let j = 0; j < 6; j++) polys.push([j % 2 ? "Top" : "Bottom", "N" + j, rect(10 + j * 55, 10, 50 + j * 55, 40)]);
  polys.forEach(([layer, net, o], j) => d.items.push(PP.make(o, {layer, net, pourIndex: j, removeDeadCopper: false})));
  await H().replaceProject(p, {force: true}); H().selectDocument(d.id); await wait(300);
  PP.live.setMode("live"); PP.tiles.setPref(options.drag || "always"); PP.tiles.enable(options.tiles !== false);
  {const t = performance.now(); H().edit(() => PP.apply(H().doc(), H().defs(), {project: H().project()})); metrics.repourAll = +(performance.now() - t).toFixed(1);}
  // The tile sessions build after the first edit (in idle slices, then in the worker).
  const t0 = performance.now(); PP.tiles.schedule();
  while (options.tiles !== false && !PP.tiles.state && performance.now() - t0 < 60000) await wait(50);
  metrics.tileInit = +(performance.now() - t0).toFixed(0); checks.tileState = !!PP.tiles.state; checks.tileInitWorker = PP.tiles.state?.initMs ? +PP.tiles.state.initMs.toFixed(0) : null;
  checks.sessions = PP.tiles.state?.specs?.length || 0;
  const settle = async () => {for (let n = 0; n < 600 && (PP.live.busy || PP.tiles.busy); n++) await wait(20);};
  await settle();
  H().setLayer("Top"); H().zoomTo([150, 100, 210, 140]); await wait(500);
  if (options.setupOnly) return {metrics, checks};
  // Single-object edits: part, via, track in turn, around the view.
  const doc = H().doc(), pick = kind => doc.items.filter(i => i.kind === kind && (i.x ?? i.points[0][0]) > 152 && (i.x ?? i.points[0][0]) < 208 && (i.y ?? i.points[0][1]) > 102 && (i.y ?? i.points[0][1]) < 138);
  const pool = [...pick("part").slice(0, 8), ...pick("via").slice(0, 8), ...pick("track").slice(0, 8)];
  const copper = observeCopper(H(), PP, doc, frame, wait);
  const toScreen = [], tileMs = [], toExact = [], exactMain = [], exactLongest = [], exactWall = [], replyMs = [], editCall = [], toStart = [], diffMs = [], roundTrip = [];
  checks.editCopper = [];
  for (let n = 0; n < pool.length; n++) {
    const it = pool[n], dx = n % 2 ? .3 : -.3;
    const result = await copper.measure(() => H().edit(() => {
      if (it.points) it.points = it.points.map(q => [q[0] + dx, q[1]]); else it.x += dx;
    }, undefined, [it]), it, dx);
    const {call, at, tile, editToTile, paintedBy, exactMs, commit, alreadyVisible, confirmed, witnesses, frames} = result;
    editCall.push(call);
    if (at != null) toScreen.push(at);
    if (tile) {
      if (tile.reply != null) replyMs.push(tile.reply);
      tileMs.push(tile.worker); toStart.push(editToTile); diffMs.push(tile.diff); roundTrip.push(tile.ms);
    }
    if (commit) {
      toExact.push(exactMs); exactMain.push(commit.main); exactLongest.push(commit.longest); exactWall.push(commit.ms);
    }
    checks.editCopper.push({id: it.id, kind: it.kind, at, exactMs: exactMs ?? null, alreadyVisible, confirmed, witnesses, frames,
      paintedBy, committedBy: commit?.transport ? "mirror" : commit ? "legacy" : null});
    await wait(60);
  }
  metrics.editCall = stat(editCall); metrics.editToDiff = stat(toStart); metrics.diff = stat(diffMs); metrics.tileRoundTrip = stat(roundTrip); metrics.tileReply = stat(replyMs);
  metrics.editToScreen = stat(toScreen); metrics.tileRepour = stat(tileMs); metrics.editToExact = stat(toExact); metrics.exactJobWall = stat(exactWall); metrics.exactJobMain = stat(exactMain); metrics.exactSliceMax = stat(exactLongest);
  checks.editsVisible = toScreen.length;
  checks.editsExact = toExact.length;
  checks.editsExpected = pool.length;
  checks.editsPatched = checks.editCopper.filter(row => row.paintedBy === "tile").length + "/" + pool.length;
  checks.patchesAfterExact = PP.tiles.patches.size;
  {const L = PP.live.last, by = {}; for (const [w, ms] of L?.slices || []) {by[w] = by[w] || [0, 0]; by[w][0]++; by[w][1] += ms;} checks.lastExact = {ms: L && +L.ms.toFixed(0), main: L && +L.main.toFixed(0), slices: by};}
  // Drag a part for about 2 s with a pointer event every frame, then drop it.
  {
    const pev = (type, [x, y], o = {}) => cv().dispatchEvent(new PointerEvent(type, {clientX: x, clientY: y,
      button: 0, buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1, pointerId: 1,
      bubbles: true, cancelable: true, isPrimary: true, pointerType: "mouse", ...o}));
    const offsets = [[0, 0], [-.4, 0], [.4, 0], [0, -.4], [0, .4], [-.8, 0], [.8, 0]];
    let part, q;
    for (const candidate of pick("part").slice(8, 28)) {
      const at = offsets.map(([x, y]) => [candidate.x + x, candidate.y + y]).find(p => H().hitAt(p)?.id === candidate.id);
      if (!at) continue;
      H().select([candidate.id]); await frame();
      const rect = cv().getBoundingClientRect(), [x, y] = H().view().worldToScreen(at);
      q = [x + rect.left, y + rect.top];
      if (x < 16 || y < 16 || x + 112 >= rect.width || y + 64 >= rect.height) continue;
      pev("pointermove", q, {buttons: 0}); pev("pointerdown", q);
      const drag = H().drag();
      if (drag?.kind === "move" && drag.item === candidate) {part = candidate; break;}
      pev("pointercancel", q);
    }
    if (!part) throw Error("The drag probe could not pick up a visible part");
    const original = [part.x, part.y];
    let tile = PP.tiles.last;
    const drags = [], stamps = [], longFrom = performance.now();
    for (let i = 0; i < 120; i++) {
      pev("pointermove", [q[0] + i * .8, q[1] + i * .4]); stamps.push(await frame());
      const last = PP.tiles.last;
      if (last?.drag && last !== tile) drags.push(last);
      tile = last;
    }
    const longDuring = long.filter(e => e.at >= longFrom).map(e => e.ms);
    checks.dragLongTaskAt = long.filter(e => e.at >= longFrom).map(e => [Math.round(e.at - longFrom), e.ms]);
    metrics.dragFrame = stat(stamps.slice(1).map((v, i) => v - stamps[i]));
    metrics.dragPatch = stat(drags.map(h => h.ms)); metrics.dragPatches = drags.length; metrics.dragLongTasks = longDuring.length;
    checks.dragLongestTask = longDuring.reduce((a, v) => Math.max(a, v), 0);
    checks.dragPoursVisible = !!PP.tiles.dragVisible(H().doc());
    const point = [q[0] + 120 * .8, q[1] + 120 * .4];
    const drop = await copper.measure(() => pev("pointerup", point), part, 0);
    metrics.dropHandler = +drop.call.toFixed(1);
    metrics.dropToScreen = drop.at == null ? null : +drop.at.toFixed(1);
    metrics.dropToExact = drop.exactMs == null ? null : +drop.exactMs.toFixed(1);
    checks.dropCopper = {witnesses: drop.witnesses, frames: drop.frames, alreadyVisible: drop.alreadyVisible};
    checks.dropMoved = Math.hypot(part.x - original[0], part.y - original[1]) > .1;
  }
  const project = H().project(), defs = H().defs();
  checks.staleAtEnd = PP.stale(doc, defs, {project}).length;
  const fresh = PP.repourAll(doc, defs, {project, reuse: false});
  const canonical = regions => JSON.stringify(regions.map(r => Object.keys(r).sort().map(k => [k, r[k]])));
  checks.fullCopperMatches = canonical(fresh.regions) === canonical(doc.pcbDrawing.pours);
  if (options.noChange) {
    const messages = [];
    const unchanged = await copper.measure(() => PP.repour(doc, defs, {project},
      fn => H().edit(fn), message => messages.push(message)), null, 0, 0, {manual: true});
    checks.unchangedRepour = {at: unchanged.at, witnesses: unchanged.witnesses, frames: unchanged.frames, messages};
  }
  copper.restore();
  checks.longTasksTotal = long.length;
  return {metrics, checks};
}
