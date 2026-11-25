"use strict";
// GPU board renderer experiment (app/canvas/canvas-gpu.js): 2D canvas against
// WebGL2 on the 25.6k-object board of tests/pcb/dense-board.js with 64 nets and ten poured polygons, in the
// real editor. Runs in Chrome (scripts/perf-gpu.sh, over the DevTools protocol) and in WKWebView
// (native/tests/macos-harness/gpu.sh). For each renderer:
//   real time (rAF-paced input, no readback): dt (rAF interval), work (main-thread ms in render),
//     lat (input to the frame after the render) for pan and notched-wheel zoom at fit and zoomed in,
//     and one-shots: click select and an edit (a via moved, input to paint).
//   synchronous with a flush (getImageData / readPixels: the time until the pixels exist): first draw
//     (GPU: scene build and every upload), exact redraw at fit and zoomed, edit to pixels.
//   memory: GPU buffer bytes, JS heap (Chrome).
//   pixels: the composited GPU frame against the 2D frame at fit and zoomed (channels differing by
//     more than 8 and 48 levels, mean absolute difference), with the images for inspection.
globalThis.atriumGpuBench = async function (o = {}) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const H = () => AtriumNavHost, cv = () => H().canvas(), GPU = () => globalThis.AtriumCanvasGPU;
  const act = a => window.dispatchEvent(new CustomEvent("atrium-command", {detail: a}));
  HTMLCanvasElement.prototype.setPointerCapture = function () {}; HTMLCanvasElement.prototype.releasePointerCapture = function () {};
  const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))].toFixed(2); };
  const refreshHz = await new Promise(done => { const t = []; const tick = ts => { t.push(ts); if (t.length < 61) requestAnimationFrame(tick); else {
    const d = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b); done(+(1000 / d[d.length >> 1]).toFixed(1)); } }; requestAnimationFrame(tick); setTimeout(() => done(null), 4000); });
  const interval = refreshHz ? 1000 / refreshHz : 16.7;

  await AtriumLazy.need("AtriumRules"); await AtriumLazy.need("AtriumPCBDraw"); await AtriumLazy.need("AtriumCanvasFast"); await AtriumLazy.need("AtriumCanvasGPU");
  if (o.undo !== false) await AtriumLazy.need("AtriumUndoStore");
  const PP = AtriumPolygonPour, p = Atrium.project("Dense", AtriumParts.catalogue), old = p.documents.find(x => x.kind === "pcb");
  const {d} = makeAtriumBenchmarkBoard(); p.documents = p.documents.map(x => x === old ? d : x);
  let k = 0;
  for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 64), "2": "N" + ((k + 1) % 64)}; else if (i.kind !== "track") i.net = "N" + (k % 64); k++; }
  const rect = (a, b, c, e) => [[a, b], [c, b], [c, e], [a, e]];
  const polys = [["Top", "GND", rect(1, 1, 180, 270)], ["Top", "VCC", rect(180, 1, 367, 270)], ["Bottom", "GND", rect(1, 1, 367, 140)], ["Bottom", "VCC", rect(1, 140, 367, 270)]];
  for (let j = 0; j < 6; j++) polys.push([j % 2 ? "Top" : "Bottom", "N" + j, rect(10 + j * 55, 10, 50 + j * 55, 40)]);
  polys.forEach(([layer, net, ol], j) => d.items.push(PP.make(ol, {layer, net, pourIndex: j, removeDeadCopper: false})));
  await H().replaceProject(p, {force: true}); H().selectDocument(d.id); await wait(300);
  H().edit(() => PP.apply(H().doc(), H().defs(), {project: H().project()}));
  act("fit"); await wait(2500);
  for (let n = 0; n < 200 && PP.live.busy; n++) await wait(50);
  globalThis.AtriumDRCMarkers?.setVisible?.(false, H());
  document.documentElement.setAttribute("data-motion", "off");
  const pours = H().doc().pcbDrawing?.pours || [];
  const pourVerts = pours.reduce((a, r) => a + (r.count || 0), 0);

  const renders = []; let lastArgs = null;
  { const v = H().view(), r = v.render; v.render = (...a) => { lastArgs = a; const t = performance.now(); const x = r(...a); renders.push([t, performance.now()]); return x; }; }
  const b = () => cv().getBoundingClientRect();
  const mid = () => { const r = b(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const wheel = w => { const [x, y] = mid(); cv().dispatchEvent(new WheelEvent("wheel", {clientX: x, clientY: y, bubbles: true, cancelable: true, deltaMode: 0, ...w})); };
  const pev = (type, [x, y], e = {}) => cv().dispatchEvent(new PointerEvent(type, {clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, bubbles: true, cancelable: true, isPrimary: true, pointerType: "mouse", ...e}));
  const scr = w => { const r = b(), s = H().view().worldToScreen(w); return [s[0] + r.left, s[1] + r.top]; };
  const visible = (i, m = 60) => { const r = b(), q = H().view().worldToScreen(i.x != null ? [i.x, i.y] : i.points[0]); return q[0] > m && q[1] > m && q[0] < r.width - m && q[1] < r.height - m; };
  const settle = async ms => { await wait(ms); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); };
  const run = (n, input) => new Promise(done => {
    const ts = [], ins = []; let i = 0; renders.length = 0;
    const tick = t => {
      ts.push(t);
      if (i >= n) {
        const dt = ts.slice(2).map((v, j) => v - ts[j + 1]), work = renders.map(([a, z]) => z - a), lat = [];
        for (const t0 of ins) { const r = renders.find(([a]) => a >= t0); if (!r) continue; const f = ts.find(v => v >= r[1]); if (f != null) lat.push(f - t0); }
        done({dt50: pct(dt, .5), dt95: pct(dt, .95), slow: dt.filter(x => x > interval * 1.5).length, frames: dt.length, work50: pct(work, .5), work95: pct(work, .95), lat50: pct(lat, .5), lat95: pct(lat, .95)});
        return;
      }
      setTimeout(() => { ins.push(performance.now()); input(i++); }, 0);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const once = async (n, input, between) => {
    const lat = [], work = [];
    for (let i = 0; i < n; i++) {
      await between?.(i); await settle(80); renders.length = 0;
      const t0 = performance.now(); input(i);
      const f = await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const rr = renders.find(([a]) => a >= t0); if (!rr) continue;
      work.push(rr[1] - rr[0]); lat.push(f - t0);
    }
    return {work50: pct(work, .5), work95: pct(work, .95), lat50: pct(lat, .5), lat95: pct(lat, .95), n: work.length};
  };
  const flush = () => { if (GPU().enabled() && GPU().stats()) GPU().finish(); cv().getContext("2d").getImageData(0, 0, 1, 1); };
  const T = f => { const t = performance.now(); f(); flush(); return performance.now() - t; };
  const exact = () => { const [dd, df, oo] = lastArgs; H().view().render(dd, df, {...oo, noReuse: true}); };
  const zoomedAt = async (x, y) => { H().setLayer("Top"); H().zoomTo([x - 30, y - 20, x + 30, y + 20]); await settle(400); };
  const views = {fit: async () => { act("fit"); await settle(700); }, zoomed: () => zoomedAt(180, 130)};
  const heap = () => performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
  const gc = () => { try { globalThis.gc?.(); } catch {} };

  if (o.setupOnly) return null;
  const out = {refreshHz, items: H().doc().items.length, pourVerts, ua: navigator.userAgent, results: {}};
  const modes = o.modes || ["2d", "gpu"];
  for (const m of o.pixelsOnly ? [] : modes) {
    GPU().reset(); GPU().enable(m === "gpu"); if (o.mode) GPU().mode(o.mode);
    const R = out.results[m] = {};
    await views.fit(); gc(); await settle(500);
    const h0 = heap();
    GPU().reset();
    R.firstDraw = +T(exact).toFixed(2);
    if (m === "gpu") R.gpuStats = GPU().stats();
    await settle(1500); // canvas-fast's pour ring index (2D) builds when idle
    const fitEx = []; for (let i = 0; i < 12; i++) fitEx.push(T(exact)); R.fitExact = {p50: pct(fitEx, .5), p95: pct(fitEx, .95)};
    gc(); await settle(300); R.heapMB = heap(); R.heapDeltaMB = h0 != null ? +(R.heapMB - h0).toFixed(1) : null;
    const split = () => m === "gpu" ? GPU().stats(null, true)?.acc : undefined;
    split(); R.fitPan = await run(90, i => wheel({deltaX: i % 60 < 30 ? 6 : -6, deltaY: i % 60 < 30 ? 4 : -4})); R.fitPan.split = split();
    await views.fit(); await settle(300);
    split(); R.fitZoom = await run(64, i => wheel({deltaY: (i >> 2) % 2 ? 3 : -3, deltaMode: 1})); R.fitZoom.split = split();
    await views.zoomed(); await settle(1500);
    const zEx = []; for (let i = 0; i < 12; i++) zEx.push(T(exact)); R.zoomedExact = {p50: pct(zEx, .5), p95: pct(zEx, .95)};
    split(); R.zoomedPan = await run(90, i => wheel({deltaX: i % 60 < 30 ? 6 : -6, deltaY: i % 60 < 30 ? 4 : -4})); R.zoomedPan.split = split();
    await views.zoomed(); await settle(300);
    R.zoomedZoom = await run(64, i => wheel({deltaY: (i >> 2) % 2 ? 3 : -3, deltaMode: 1}));
    for (const [name, go] of Object.entries(views)) {
      await go(); await settle(300);
      const vias = H().doc().items.filter(i => i.kind === "via" && visible(i)).slice(0, 8);
      split(); R[name + "Click"] = await once(vias.length, i => { const q = scr([vias[i].x, vias[i].y]); pev("pointerdown", q); pev("pointerup", q); },
        i => { pev("pointermove", scr([vias[i].x, vias[i].y]), {buttons: 0}); }); R[name + "Click"].split = split();
      H().select([]); await settle(300);
      // Edit to pixels: a via moved (as a property edit or a nudge), input to the frame after the render.
      const via = vias[0];
      split(); R[name + "Edit"] = await once(8, i => H().edit(() => { via.x += i % 2 ? -.1 : .1; }), () => settle(150)); R[name + "Edit"].split = split();
      // Synchronous: the edit call, then the render with a flush.
      const call = [], rep = [];
      for (let i = 0; i < 10; i++) { call.push(T(() => H().edit(() => { via.y += i % 2 ? -.1 : .1; }))); rep.push(T(exact)); }
      R[name + "EditSync"] = {call50: pct(call, .5), repaint50: pct(rep, .5), repaint95: pct(rep, .95)};
      if (m === "gpu") R[name + "GpuStats"] = GPU().stats();
    }
  }
  // Pixels: the composited GPU frame against the 2D frame, at fit and zoomed in.
  if (o.pixels !== false && modes.length === 2) {
    lastArgs || (H().redraw(), await settle(100));
    out.pixels = {};
    for (const [name, go] of Object.entries(views)) {
      GPU().enable(false); await go(); await settle(1600); exact();
      const g2 = cv().getContext("2d"), W = cv().width, Hh = cv().height, a = g2.getImageData(0, 0, W, Hh);
      const url2 = o.images ? cv().toDataURL("image/png") : null;
      GPU().enable(true); exact();
      const comp = GPU().composite(); const c = comp.getContext("2d").getImageData(0, 0, W, Hh);
      const urlG = o.images ? comp.toDataURL("image/png") : null;
      let n8 = 0, n48 = 0, sum = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const dmax = Math.max(Math.abs(a.data[i] - c.data[i]), Math.abs(a.data[i + 1] - c.data[i + 1]), Math.abs(a.data[i + 2] - c.data[i + 2]));
        if (dmax > 8) n8++; if (dmax > 48) n48++; sum += dmax;
      }
      const px = a.data.length / 4;
      out.pixels[name] = {pixels: px, over8: +(n8 / px * 100).toFixed(2), over48: +(n48 / px * 100).toFixed(2), meanAbs: +(sum / px).toFixed(2)};
      if (o.images) {
        out.images ??= {}; out.images[name + ".2d"] = url2; out.images[name + ".gpu"] = urlG;
        // Where they differ: white over 48 levels, grey over 8.
        const dc = document.createElement("canvas"); dc.width = W; dc.height = Hh; const dg = dc.getContext("2d"), di = dg.createImageData(W, Hh);
        for (let i = 0; i < a.data.length; i += 4) {
          const dmax = Math.max(Math.abs(a.data[i] - c.data[i]), Math.abs(a.data[i + 1] - c.data[i + 1]), Math.abs(a.data[i + 2] - c.data[i + 2]));
          di.data[i] = di.data[i + 1] = di.data[i + 2] = dmax > 48 ? 255 : dmax > 8 ? 90 : 0; di.data[i + 3] = 255;
        }
        dg.putImageData(di, 0, 0); out.images[name + ".diff"] = dc.toDataURL("image/png");
      }
    }
  }
  GPU().enable(false); GPU().reset();
  return out;
};
