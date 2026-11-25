"use strict";
// Trackpad pan in WKWebView (pan.sh): real macOS scroll events (continuous pixel deltas with scroll and
// momentum phases, 120 Hz, mixed axes; the "trackpad" harness op) sent to the web view while the page
// measures, with no pixel readback while timing:
//   frame   rAF-to-rAF interval p50/p95/max and dropped frames (over 1.5 refresh intervals) over the pan
//   work    our main-thread ms (pan-early.js) charged to the wheel event each callback follows
//   upload  bytes sent to WebGL textures per pan frame; labels: pan frames that placed the net labels afresh
//   wide    GPU wide copies (text and overlay layers drawn again) made during the pan
//   blank   a second, captured run: the last pan frame against the exact frame that follows it at rest
// For each board (input.files: an Altium project's files as base64, or the PiDP-11 fixture), renderer
// (gpu where WebGL2 is hardware-backed, then 2d) and zoom (fit, mid x4, close x14).
globalThis.__uiProbes = {run: async (only, input) => {
  try { return "PAN " + JSON.stringify(await atriumPanProbe(input || {})); }
  catch (e) { return "JSERROR " + e.message + " " + e.stack; }
}};
async function atriumPanProbe(input) {
  const post = (op, a = {}) => webkit.messageHandlers.harness.postMessage({op, ...a});
  const wait = ms => new Promise(r => window.__rawTimeout(r, ms));
  const frame = () => new Promise(r => requestAnimationFrame(() => r()));
  const H = () => AtriumNavHost;
  const pct = (a, f) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))].toFixed(2); };
  HTMLCanvasElement.prototype.setPointerCapture = function () {}; HTMLCanvasElement.prototype.releasePointerCapture = function () {};
  const refresh = await new Promise(done => { const t = []; const tick = ts => { t.push(ts); if (t.length < 91) requestAnimationFrame(tick); else {
    const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b); done(d[d.length >> 1]); } }; requestAnimationFrame(tick); });
  // The stream: four swipes (fingers 200 ms, a 150 ms momentum tail, then the fingers rest 180 ms: long
  // enough for the exact frame at rest, as a user lifts and swipes again), each in a new direction.
  const stream = [];
  for (const a of [25, 205, 118, 298]) {
    const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180);
    let m = 0;
    for (let i = 0; i < 24; i++) { m = i < 8 ? 2 + i * 1.6 : 14 - (i - 8) * .25; stream.push([+(m * c).toFixed(2), +(m * s).toFixed(2), 0]); }
    for (let i = 0; i < 18; i++) { m *= .9; stream.push([+(m * c).toFixed(2), +(m * s).toFixed(2), 1]); }
    for (let i = 0; i < 22; i++) stream.push([0, 0, 2]);
  }
  const out = {refreshHz: +(1000 / refresh).toFixed(1), boards: {}};
  const boards = input.boards || [];
  for (const board of boards) {
    const files = board.files.map(f => new File([Uint8Array.from(atob(f.data), c => c.charCodeAt(0))], f.name));
    // Not awaited: an import may end in a question (save the design as a Waffle project) the probe closes.
    const pcbName = board.name.replace(/\.pcbdoc$/i, "").toLowerCase(), before = H().project();
    const imported = () => {
      if (H().project() === before) return null;
      const list = H().project().documents.filter(d => d.kind === "pcb" && d.items.length > 20);
      return list.find(d => (d.name || "").toLowerCase().includes(pcbName)) || list[0];
    };
    const opening = H().openFiles(files);
    for (let n = 0; n < 1200 && !imported(); n++) await wait(100);
    await Promise.race([opening, wait(3000)]);
    post("cancelSavePanel");
    for (const d of document.querySelectorAll("dialog[open]")) d.close();
    const pcb = imported();
    if (!pcb) { out.boards[board.name] = {error: "no board: " + H().project().documents.map(d => d.kind + ":" + d.name + ":" + d.items?.length).join(", ") + " same " + (H().project() === before)}; continue; }
    // The import report opens as a view over the board: closed, so the board is on screen.
    for (const b of document.querySelectorAll(".view-tab-close")) b.click();
    H().selectDocument(pcb.id);
    await AtriumLazy.need("AtriumCanvasGPU").catch(() => null);
    await wait(6000);
    const B = out.boards[board.name] = {items: pcb.items.length};
    if (input.shots) await post("shot", {name: "pan-" + board.name});
    const cv = () => H().canvas(), v = () => H().view();
    // Where WebKit places the harness's scroll events relative to the page (an offscreen window offsets them).
    let ox = 0, oy = 0;
    {
      const r = cv().getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      window.__wheels.length = 0;
      await post("trackpad", {x, y, steps: [[0, .4, 0]], ms: 8});
      await wait(200);
      const w = window.__wheels.find(e => e[5] != null);
      if (w) { ox = x - w[5]; oy = y - w[6]; }
      B.offset = [ox, oy];
      const top = document.elementFromPoint(x, y);
      B.rect = [r.left, r.top, r.width, r.height];
      B.target = [w?.[7], top?.tagName + "." + (top?.className?.baseVal ?? top?.className), cv().tagName + "." + cv().className, [...document.querySelectorAll("dialog[open], .sheet, [role=dialog]")].map(d => d.className).join("|")];
    }
    for (const which of input.renderers || ["gpu", "2d"]) {
      const G = globalThis.AtriumCanvasGPU;
      if (which === "gpu" && !(G && AtriumCanvasGPUPref?.decision?.().use)) { B[which] = {skipped: "no hardware-accelerated WebGL2"}; continue; }
      G?.enable?.(which === "gpu");
      const R = B[which] = [];
      for (const [name, zoom] of [["fit", 1], ["mid", 4], ["close", 14]].filter(([n]) => !input.zooms || input.zooms.includes(n))) {
        const row = {name, zoom};
        for (const capture of [false, true]) {
          window.dispatchEvent(new CustomEvent("atrium-command", {detail: "fit"})); H().redraw(true); await wait(500); H().redraw(true); await wait(300);
          const I = v().internals(), gpu = G?.status?.(I).renderer === "gpu";
          if ((which === "gpu") !== !!gpu) { row.error = "renderer " + G?.status?.(I).renderer; break; }
          const r = cv().getBoundingClientRect();
          if (zoom > 1) { v().zoom(zoom, [r.width * .47, r.height * .53]); H().redraw(true); }
          await wait(900); await frame();
          const renders = [], view = v();
          let moving = false, shots = [];
          const Wd = 480, Hh = Math.round(Wd * cv().height / cv().width), probe = document.createElement("canvas");
          probe.width = Wd; probe.height = Hh;
          const g = probe.getContext("2d", {willReadFrequently: true});
          const render = view.render, move = view.moving, settle = view.settle;
          view.moving = function (...a) { moving = true; return move.apply(this, a); };
          view.settle = function (...a) { moving = false; return settle.apply(this, a); };
          view.render = function (...a) {
            const gesture = moving; moving = false;
            const u0 = window.__uploads, l0 = I.netLabels?.(), t = performance.now(), res = render.apply(this, a);
            renders.push({t, ms: performance.now() - t, bytes: window.__uploads - u0, labels: I.netLabels?.() !== l0 ? 1 : 0, gesture});
            if (capture) {
              const src = (gpu && G.composite?.(I)) || cv();
              g.clearRect(0, 0, Wd, Hh); g.drawImage(src, 0, 0, Wd, Hh);
              shots.push({gesture, camera: JSON.stringify(view.camera()), data: g.getImageData(0, 0, Wd, Hh).data});
              if (shots.length > 3) shots.shift();
            }
            return res;
          };
          const ticks = []; let ticking = true;
          const tick = t => { ticks.push(t); if (ticking) requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
          const wide0 = gpu ? G.stats(I)?.wideBuilds || 0 : 0;
          const before = view.camera();
          window.__work.length = 0; window.__wheels.length = 0;
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          try {
            await post("trackpad", {x, y, ox, oy, steps: stream, ms: 1000 / 120});
            await frame(); ticking = false;
            const end = performance.now();
            const wheels = window.__wheels.slice(), work = window.__work.slice(); window.__work.length = 0;
            const times = wheels.map(w => w[0]); times.push(end);
            const per = new Array(Math.max(0, times.length - 1)).fill(0);
            for (let k = 0; k < work.length; k += 2) {
              const t = work[k];
              if (!times.length || t < times[0] || t >= end) continue;
              let lo = 0, hi = times.length - 1;
              while (lo < hi - 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
              // Up to two frames after the event: the exact frame once the fingers rest is not the pan's.
              if (t - times[lo] <= 34) per[lo] += work[k + 1];
            }
            const wide = gpu ? (G.stats(I)?.wideBuilds || 0) - wide0 : 0;
            const moved = view.camera();
            await wait(500); await frame(); await frame();
            if (capture && shots[shots.length - 1]?.gesture) { H().redraw(true); await frame(); await frame(); }
            if (capture) {
              const exact = shots[shots.length - 1], last = shots.slice(0, -1).reverse().find(s => s.gesture && s.camera === exact?.camera);
              row.blank = exact && last && !exact.gesture ? unmatched(last.data, exact.data, Wd, Hh) : null;
              continue;
            }
            const t0 = times[0] ?? end, dt = ticks.slice(1).map((x, i) => [ticks[i], x - ticks[i]]).filter(([a]) => a >= t0 && a <= end).map(([, d]) => d);
            const gest = renders.filter(x => x.gesture);
            const gaps = wheels.slice(1).map((w, i) => w[0] - wheels[i][0]);
            Object.assign(row, {events: wheels.length, cancelable: wheels.filter(w => w[3]).length, eventGap: {p50: pct(gaps, .5), p95: pct(gaps, .95), max: pct(gaps, 1)},
              moved: [+(moved.cx - before.cx).toFixed(3), +(moved.cy - before.cy).toFixed(3)], sum: [wheels.reduce((a, w) => a + w[1], 0).toFixed(1), wheels.reduce((a, w) => a + w[2], 0).toFixed(1)],
              frame: {p50: pct(dt, .5), p95: pct(dt, .95), max: pct(dt, 1), dropped: dt.filter(x => x > refresh * 1.5).length, frames: dt.length},
              work: {p50: pct(per, .5), p95: pct(per, .95), max: pct(per, 1)},
              renders: renders.length, exactDuring: renders.filter(x => !x.gesture).length, render: {p50: pct(renders.map(x => x.ms), .5), p95: pct(renders.map(x => x.ms), .95), max: pct(renders.map(x => x.ms), 1)},
              uploadKB: +(gest.reduce((a, x) => a + x.bytes, 0) / Math.max(1, gest.length) / 1024).toFixed(1),
              labelFrames: gest.filter(x => x.labels).length, wideBuilds: wide});
          } finally { view.render = render; view.moving = move; view.settle = settle; ticking = false; }
        }
        R.push(row);
      }
    }
    globalThis.AtriumCanvasGPU?.enable?.(null);
  }
  return out;
}
// The share of pixels of frame b that no pixel within one pixel of it in frame a matches within 64 levels per channel.
function unmatched(a, b, w, h) {
  let n = 0;
  const near = (k, j) => Math.max(Math.abs(b[k] - a[j]), Math.abs(b[k + 1] - a[j + 1]), Math.abs(b[k + 2] - a[j + 2])) <= 64;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const k = (y * w + x) * 4;
    let ok = false;
    for (let dy = -1; dy <= 1 && !ok; dy++) for (let dx = -1; dx <= 1 && !ok; dx++) ok = near(k, k + (dy * w + dx) * 4);
    if (!ok) n++;
  }
  return +(n / ((w - 2) * (h - 2))).toFixed(5);
}
