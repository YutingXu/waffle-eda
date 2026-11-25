"use strict";
// Real-time frame probes for the WKWebView harness (frame.sh). On the 25.6k-object
// board of tests/pcb/dense-board.js (64 nets, ten poured polygons) it drives the editor with DOM input once per
// real animation frame and measures, with no pixel readback (getImageData would force WebKit's GPU process
// to finish every queued command and distort the frame):
//   dt      rAF-to-rAF interval (the frame rate the user sees; a 60 Hz display gives about 16.7 ms)
//   work    main-thread time in the editor's render call (the part the page controls)
//   lat     input to paint: from the event to the first animation frame after the render that drew it
//   slow    frames whose interval is over 1.5 refresh intervals (dropped frames)
// Scenarios at fit and zoomed in: trackpad pan, notched-wheel zoom, pinch zoom, right-drag pan, hover,
// box marquee, part move-drag, interactive routing; one-shots: click select, layer toggle, undo and redo.
// Checks: at rest the canvas equals a full repaint of the same inputs (after a click, whose selection
// frame repaints only the changed boxes). frame.sh applies the budgets and writes frame-probes.json.
// Run: native/tests/macos-harness/frame.sh   (HARNESS_INSTALL as for ui.sh)
globalThis.__uiProbes = {run: async () => {
  try { return "FRAME " + JSON.stringify(await atriumFrameProbe()); }
  catch (e) { return "JSERROR " + e.message + " " + e.stack; }
}};
async function atriumFrameProbe() {
  const post = (op, a = {}) => webkit.messageHandlers.harness.postMessage({op, ...a});
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const H = () => AtriumNavHost, cv = () => H().canvas();
  const act = a => window.dispatchEvent(new CustomEvent("atrium-command", {detail: a}));
  HTMLCanvasElement.prototype.setPointerCapture = function() {}; HTMLCanvasElement.prototype.releasePointerCapture = function() {};
  const pct = (a, p) => {if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))].toFixed(1);};

  // The display's refresh rate from real rAF deltas.
  const refreshHz = await new Promise(done => {const t = []; const tick = ts => {t.push(ts); if (t.length < 91) requestAnimationFrame(tick); else {
    const d = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b); done(+(1000 / d[d.length >> 1]).toFixed(1));}}; requestAnimationFrame(tick); setTimeout(() => done(null), 4000);});
  const interval = refreshHz ? 1000 / refreshHz : 16.7;

  // The board, as tests/editor/perf-interact.js builds it.
  await AtriumLazy.need("AtriumRules"); await AtriumLazy.need("AtriumPCBDraw"); await AtriumLazy.need("AtriumRouter"); await AtriumLazy.need("AtriumCanvasFast");
  const PP = AtriumPolygonPour, p = Atrium.project("Dense", AtriumParts.catalogue), old = p.documents.find(x => x.kind === "pcb");
  const {d} = makeAtriumBenchmarkBoard(); p.documents = p.documents.map(x => x === old ? d : x);
  let k = 0;
  for (const i of d.items) {if (i.kind === "part") i.pinNets = {"1": "N" + (k % 64), "2": "N" + ((k + 1) % 64)}; else if (i.kind !== "track") i.net = "N" + (k % 64); k++;}
  const rect = (a, b, c, e) => [[a, b], [c, b], [c, e], [a, e]];
  const polys = [["Top", "GND", rect(1, 1, 180, 270)], ["Top", "VCC", rect(180, 1, 367, 270)], ["Bottom", "GND", rect(1, 1, 367, 140)], ["Bottom", "VCC", rect(1, 140, 367, 270)]];
  for (let j = 0; j < 6; j++) polys.push([j % 2 ? "Top" : "Bottom", "N" + j, rect(10 + j * 55, 10, 50 + j * 55, 40)]);
  polys.forEach(([layer, net, o], j) => d.items.push(PP.make(o, {layer, net, pourIndex: j, removeDeadCopper: false})));
  await H().replaceProject(p, {force: true}); H().selectDocument(d.id); await wait(300);
  H().edit(() => PP.apply(H().doc(), H().defs(), {project: H().project()}));
  act("fit"); await wait(2500);
  for (let n = 0; n < 200 && PP.live.busy; n++) await wait(50);
  // DRC markers are measured on their own below.
  globalThis.AtriumDRCMarkers?.setVisible?.(false, H());
  // Motion off: route-feel and camera flights ease over time.
  document.documentElement.setAttribute("data-motion", "off");

  // Render timing: every call of the active view's render.
  const renders = [];
  {const v = H().view(), r = v.render; v.render = (...a) => {const t = performance.now(); const x = r(...a); renders.push([t, performance.now()]); return x;};}
  const b = () => cv().getBoundingClientRect();
  const mid = () => {const r = b(); return [r.left + r.width / 2, r.top + r.height / 2];};
  const wheel = o => {const [x, y] = mid(); cv().dispatchEvent(new WheelEvent("wheel", {clientX: x, clientY: y, bubbles: true, cancelable: true, deltaMode: 0, ...o}));};
  const pev = (type, [x, y], o = {}) => cv().dispatchEvent(new PointerEvent(type, {clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, bubbles: true, cancelable: true, isPrimary: true, pointerType: "mouse", ...o}));
  const scr = w => {const r = b(), s = H().view().worldToScreen(w); return [s[0] + r.left, s[1] + r.top];};
  const visible = (i, m = 60) => {const r = b(), q = H().view().worldToScreen(i.x != null ? [i.x, i.y] : i.points[0]); return q[0] > m && q[1] > m && q[0] < r.width - m && q[1] < r.height - m;};
  const settle = async ms => { await wait(ms); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); };

  // n frames of real rAF; input(i) runs just after frame i starts (as real input arrives between frames).
  const run = (n, input) => new Promise(done => {
    const ts = [], ins = []; let i = 0; renders.length = 0;
    const tick = t => {
      ts.push(t);
      if (i >= n) {
        const dt = ts.slice(2).map((v, j) => v - ts[j + 1]);
        const work = renders.map(([a, z]) => z - a);
        // Input to paint: the first render that starts after the input, then the next frame start after it.
        const lat = [];
        for (const t0 of ins) {const r = renders.find(([a]) => a >= t0); if (!r) continue; const f = ts.find(v => v >= r[1]); if (f != null) lat.push(f - t0);}
        done({dt50: pct(dt, .5), dt95: pct(dt, .95), dtMax: pct(dt, 1), slow: dt.filter(x => x > interval * 1.5).length, frames: dt.length,
              work50: pct(work, .5), work95: pct(work, .95), renders: work.length, lat50: pct(lat, .5), lat95: pct(lat, .95)});
        return;
      }
      setTimeout(() => {ins.push(performance.now()); input(i++);}, 0);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // A one-shot action: input to paint and the render's main-thread time, n times.
  const once = async (n, input, between) => {
    const lat = [], work = [];
    for (let i = 0; i < n; i++) {
      await between?.(i); await settle(60); renders.length = 0;
      const t0 = performance.now(); input(i);
      const f = await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const rr = renders.find(([a]) => a >= t0); if (!rr) continue;
      work.push(rr[1] - rr[0]); lat.push(f - t0);
    }
    return {work50: pct(work, .5), work95: pct(work, .95), lat50: pct(lat, .5), lat95: pct(lat, .95), renders: work.length};
  };
  // Bytes that differ between the canvas now and a full repaint of the last render's inputs (a
  // check, not timed: it reads the pixels back).
  let lastArgs = null;
  {const v = H().view(), r = v.render; v.render = (...a) => {lastArgs = a; return r(...a);};}
  const diffFull = () => {
    const g = cv().getContext("2d"), W = cv().width, Hh = cv().height, a = g.getImageData(0, 0, W, Hh).data;
    const [dd, df, o] = lastArgs; H().view().render(dd, df, {...o, noReuse: true}); // a full repaint (no board-layer copy)
    const c = g.getImageData(0, 0, W, Hh).data; let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== c[i]) n++;
    return n;
  };
  const zoomedAt = async (x, y) => {H().setLayer("Top"); H().zoomTo([x - 30, y - 20, x + 30, y + 20]); await settle(400);};
  const M = {};
  const views = {fit: async () => {act("fit"); await settle(700);}, zoomed: () => zoomedAt(180, 130)};
  for (const [name, go] of Object.entries(views)) {
    await go(); await settle(1500); // pour ring indexes build in idle time
    M[name + ".pan"] = await run(90, i => wheel({deltaX: i % 60 < 30 ? 6 : -6, deltaY: i % 60 < 30 ? 4 : -4}));
    await go(); await settle(300);
    // A notched wheel: four notches in, four out.
    M[name + ".zoomWheel"] = await run(64, i => wheel({deltaY: (i >> 2) % 2 ? 3 : -3, deltaMode: 1}));
    await go(); await settle(300);
    // Pinch: Ctrl+wheel with fractional pixel deltas, in then out.
    M[name + ".pinch"] = await run(90, i => wheel({deltaY: (i % 30 < 15 ? -1 : 1) * 2.5, ctrlKey: true}));
    await go(); await settle(300);
    {
      const [x, y] = mid(); let s = [x, y];
      pev("pointermove", s, {buttons: 0}); pev("pointerdown", s, {button: 2, buttons: 2});
      M[name + ".dragPan"] = await run(90, i => {s = [s[0] + (i % 60 < 30 ? 5 : -5), s[1] + (i % 60 < 30 ? 3 : -3)]; pev("pointermove", s, {buttons: 2});});
      pev("pointerup", s, {button: 2, buttons: 0}); await settle(400);
      document.querySelectorAll(".context-menu, .ctx-menu").forEach(m => m.remove?.());
      cv().dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", code: "Escape", bubbles: true}));
    }
    await go(); await settle(300);
    {const [x, y] = mid(); M[name + ".hover"] = await run(60, i => pev("pointermove", [x + (i % 30) * 4, y + (i % 30)], {buttons: 0}));}
  }
  // Box marquee across a quarter of the board, at fit.
  await views.fit(); await settle(300);
  {
    const r = b(); let e = null;
    for (let q = 4; q < 120 && !e; q += 2) for (const [x, y] of [[q, q], [q, 8], [8, q]]) if (!e && !H().hitAt(H().view().screenToWorld([x, y]))) e = [r.left + x, r.top + y];
    if (e) {
      pev("pointermove", e, {buttons: 0}); pev("pointerdown", e);
      M["fit.boxDrag"] = await run(40, i => pev("pointermove", [e[0] + (i + 1) * 10, e[1] + (i + 1) * 6]));
      pev("pointerup", [e[0] + 400, e[1] + 240]); H().select([]); await settle(300);
    }
  }
  // Move-drag of a part with tracks on its pads, zoomed in.
  {
    await zoomedAt(180, 130);
    const part = H().doc().items.find(i => i.kind === "part" && visible(i, 200)), pins = Atrium.pins(part, H().defs().get(part.def), "pcb");
    H().edit(() => {for (const pin of pins) H().doc().items.push({id: "fp" + pin.number, kind: "track", layer: "Top", width: .2, net: part.pinNets[pin.number],
      points: [pin.at, [pin.at[0] + 1, pin.at[1] + 1.2], [pin.at[0] + 3, pin.at[1] + 1.2]]});});
    await settle(800);
    const q = scr([part.x, part.y]); H().select([part.id]); pev("pointermove", q, {buttons: 0}); pev("pointerdown", q);
    M["zoomed.moveDrag"] = await run(40, i => pev("pointermove", [q[0] + (i + 1) * 2, q[1] + (i + 1)]));
    pev("pointerup", [q[0] + 80, q[1] + 40]); await settle(1500); H().select([]); act("undo"); await settle(1500);
  }
  // Interactive routing from a via (walkaround), zoomed in.
  {
    await zoomedAt(180, 130);
    const via = H().doc().items.filter(i => i.kind === "via" && visible(i, 150))[3], q = scr([via.x, via.y]);
    act("route"); pev("pointermove", q, {buttons: 0}); pev("pointerdown", q); pev("pointerup", q); await settle(200);
    M["zoomed.route"] = await run(40, i => pev("pointermove", [q[0] + (i + 1) * 6, q[1] + (i + 1) * (i % 3)], {buttons: 0}));
    for (const key of ["Escape", "Escape"]) cv().dispatchEvent(new KeyboardEvent("keydown", {key, code: key, bubbles: true}));
    act("select"); await settle(300);
  }
  // One-shots: click select of vias and layer toggles, at fit and zoomed.
  for (const [name, go] of Object.entries(views)) {
    await go(); await settle(300);
    const vias = H().doc().items.filter(i => i.kind === "via" && visible(i)).slice(0, 10);
    M[name + ".click"] = await once(vias.length, i => {const q = scr([vias[i].x, vias[i].y]); pev("pointerdown", q); pev("pointerup", q);},
      i => {pev("pointermove", scr([vias[i].x, vias[i].y]), {buttons: 0});});
    // A click repaints only the changed boxes; the exact frame follows on idle, so at rest the canvas
    // must equal a full repaint of the same inputs (rest diffs 0). The dirty frame's own difference
    // (anti-aliasing at the clip edges, a level or two) is reported as clickDirtyBytes.
    await settle(300); M[name + ".clickRestDiff"] = diffFull();
    {const q = scr([vias[0].x, vias[0].y]); pev("pointerdown", q); pev("pointerup", q); await new Promise(r => requestAnimationFrame(r)); M[name + ".clickDirtyBytes"] = diffFull();}
    H().select([]); await settle(300);
    M[name + ".clearRestDiff"] = diffFull();
    await AtriumLazy.need("AtriumAltiumKeys");
    const layer0 = H().activeLayer();
    M[name + ".layerToggle"] = await once(8, i => act(i % 4 === 3 ? "layer-next" : "layer-mode"));
    H().setLayerMode?.("all"); H().setLayer(layer0 || "Top"); await settle(200);
    // Undo and redo of a one-via move (Ctrl+Z / Ctrl+Y): the frame after the command.
    {
      const it = H().doc().items.find(i => i.kind === "via" && visible(i, 100));
      for (let j = 0; j < 4; j++) {H().edit(() => {it.x += .1;}); await settle(150);}
      await settle(800);
      M[name + ".undo"] = await once(4, () => act("undo"), () => settle(300));
      M[name + ".redo"] = await once(4, () => act("redo"), () => settle(300));
    }
  }
  // DRC markers: 1,000 violations over the board (drc-markers.js, as drc-view.js feeds it), pan and an
  // exact frame at fit and zoomed.
  {
    const DM = globalThis.AtriumDRCMarkers || (await AtriumLazy.need("AtriumDRCMarkers").catch(() => null), globalThis.AtriumDRCMarkers);
    if (DM?.renderFor) {
      const vias = H().doc().items.filter(i => i.kind === "via");
      const list = [];
      for (let j = 0; j < 1000; j++) {
        const v = vias[(j * 7) % vias.length], w = vias[(j * 7 + 1) % vias.length], pair = j % 3 !== 0;
        list.push({type: pair ? "clearance" : "holeSize", id: v.id, otherId: pair ? w.id : undefined, at: [v.x, v.y], otherAt: pair ? [w.x, w.y] : undefined,
          actual: .15, required: .2, warning: j % 7 === 0, title: "Via ↔ Via"});
      }
      const was = DM.visible(); DM.setVisible(true, H());
      const off = H().addRenderer(dd => dd?.kind === "pcb" ? DM.renderFor(H(), dd, list, {}) : null);
      try {
        for (const [name, go] of Object.entries(views)) {
          await go(); await settle(400);
          M[name + ".drcPan"] = await run(60, i => wheel({deltaX: i % 60 < 30 ? 6 : -6, deltaY: i % 60 < 30 ? 4 : -4}));
          await settle(300);
          M[name + ".drcHover"] = await run(40, i => {const [x, y] = mid(); pev("pointermove", [x + (i % 20) * 4, y + (i % 20)], {buttons: 0});});
          M[name + ".drcExact"] = await once(6, () => H().redraw());
        }
      } finally { off(); DM.setVisible(was, H()); }
    }
  }
  return {refreshHz, intervalMs: +interval.toFixed(2), metrics: M};
}
