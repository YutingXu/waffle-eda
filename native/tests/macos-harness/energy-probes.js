"use strict";
// Energy probes for the WKWebView harness (energy.sh). The real Desktop class and
// WKWebView with window occlusion detection on (as in the shipping app), on a small project (the
// starter's schematic and board) and the big boards (the 25.6k-object board of tests/pcb/dense-board.js
// with ten pours, a 1,600-symbol schematic). Each scenario sets up a state, then the native side
// measures the app, WebContent, GPU and Networking processes over a fixed window (CPU % of one core,
// idle and interrupt wakeups a second, energy in mW from proc_pid_rusage, top's POWER). While a
// window runs the page counts the timer and animation-frame callbacks that fire (what runs at idle).
// After an edit, a pan or a route the run samples half-second windows until CPU is back at idle.
// ENERGY_ONLY=name,name runs a subset; ENERGY_SECONDS scales the idle windows (default 1).
globalThis.__uiProbes = {run: async only => {
  try { return "ENERGY " + JSON.stringify(await atriumEnergyProbe(only)); }
  catch (e) { return "JSERROR " + e.message + " " + e.stack; }
}};
async function atriumEnergyProbe(onlyText) {
  const post = (op, a = {}) => webkit.messageHandlers.harness.postMessage({op, ...a});
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const H = () => AtriumNavHost, cv = () => H().canvas();
  const act = a => window.dispatchEvent(new CustomEvent("atrium-command", {detail: a}));
  const note = text => post("note", {text});
  const only = new Set(String(onlyText || "").split(",").filter(Boolean));
  const scale = +(globalThis.__energyScale || 1);
  HTMLCanvasElement.prototype.setPointerCapture = function() {}; HTMLCanvasElement.prototype.releasePointerCapture = function() {};
  const settle = async ms => { await wait(ms); await Promise.race([new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))), wait(3000)]); };

  // Callback census: which timers and frames fire inside a measuring window (keyed by function source).
  const census = {on: false, map: new Map(), ms: 0};
  const key = f => {if (typeof f !== "function") return "?"; const s = String(f).replace(/\s+/g, " "); return (f.name ? f.name + ": " : "") + s.slice(0, 90);};
  const count = f => {if (!census.on) return; const k = key(f); census.map.set(k, (census.map.get(k) || 0) + 1);};
  for (const name of ["setTimeout", "setInterval"]) {
    const orig = globalThis[name];
    globalThis[name] = function(f, ...rest) { return orig.call(this, typeof f === "function" ? function(...a) { count(f); const t = performance.now(); try { return f.apply(this, a); } finally { if (census.on) census.ms += performance.now() - t; } } : f, ...rest); };
  }
  {const raf = globalThis.requestAnimationFrame; globalThis.requestAnimationFrame = function(f) { return raf.call(this, t => { count(f); const t0 = performance.now(); try { f(t); } finally { if (census.on) census.ms += performance.now() - t0; } }); };}
  // Workers alive (started and not terminated), and what WebKit animates on its own.
  const workers = new Set();
  let posts = 0;
  {const W = globalThis.Worker; if (W) {globalThis.Worker = function(...a) {const w = new W(...a); workers.add(w); const pm = w.postMessage.bind(w); w.postMessage = (...m) => {if (census.on) posts++; return pm(...m);}; const t = w.terminate.bind(w); w.terminate = () => {workers.delete(w); t();}; return w;}; globalThis.Worker.prototype = W.prototype;}}
  // Work that is not a timer: jobs posted to workers in the window, and a Design Insights pass in flight.
  const scene = () => ({workers: workers.size, posts, jsMs: +census.ms.toFixed(1), insights: !!globalThis.AtriumInsightsUI?.running?.(), anims: (document.getAnimations?.() || []).filter(a => a.playState === "running").map(a => (a.animationName || a.transitionProperty || "anim") + "@" + (a.effect?.target?.className || a.effect?.target?.tagName || "")).slice(0, 6),
    active: (document.activeElement?.tagName || "") + "." + (document.activeElement?.className || "")});
  const top = () => [...census.map].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => n + "× " + k);

  const R = {power: await post("power"), scenarios: {}};
  async function measure(name, seconds, extra = {}) {
    if (only.size && !only.has(name)) return;
    census.map.clear(); posts = 0; census.ms = 0; census.on = true;
    const m = await post("measure", {seconds: seconds * scale});
    census.on = false;
    R.scenarios[name] = {...m, fired: top(), visibility: document.visibilityState, ...scene(), ...extra};
    note(name + " cpu " + (m.total?.cpu ?? 0).toFixed(2) + " % idleW " + (m.total?.idleW ?? 0).toFixed(1) + "/s " + (m.total?.mW ?? 0).toFixed(0) + " mW top " + m.topPower +
      " web/gpu/app " + ["web", "gpu", "app"].map(p => (m[p]?.cpu ?? 0).toFixed(2)).join("/") + " " + JSON.stringify(scene()) + " fired " + R.scenarios[name].fired.slice(0, 4).join(" | "));
  }
  // Time to idle: half-second windows until two in a row are under 1.5 % CPU (all four processes).
  async function toIdle(name, start) {
    if (only.size && !only.has(name)) return;
    const t0 = performance.now(); census.map.clear(); census.on = true;
    await start();
    const tAct = performance.now(), trail = []; let calm = 0, idleAt = null;
    for (let i = 0; i < 60 && calm < 2; i++) {
      const t = performance.now(), m = await post("measure", {seconds: .5});
      trail.push(+m.total.cpu.toFixed(1));
      if (m.total.cpu < 1.5) {calm++; if (calm === 1) idleAt = t;} else {calm = 0; idleAt = null;}
    }
    census.on = false;
    R.scenarios[name] = {visible: globalThis.AtriumPower?.visible?.(), interaction: +(tAct - t0).toFixed(0), timeToIdleMs: idleAt == null ? null : +(idleAt - tAct).toFixed(0), trail, fired: top()};
    note(name + " time to idle " + R.scenarios[name].timeToIdleMs + " ms visible " + R.scenarios[name].visible + " trail " + trail.join(" ") + " fired " + R.scenarios[name].fired.slice(0, 4).join(" | "));
  }

  // The small project: the starter, behind the start page.
  // A visible, focused window: WebKit's occlusion detection stays off (as ui.sh and frame.sh run), so the
  // page renders and its timers run as in a window on screen even when the display sleeps or the screen
  // is locked (an unattended run). It is turned on only for the background, occluded, minimised and
  // hidden scenarios. AtriumPower is told the window is on screen to match.
  const onScreen = () => globalThis.AtriumPower?.host?.({occluded: false});
  await post("focusWindow"); onScreen();
  R.screen = await post("window", {act: "state"});
  for (let n = 0; n < 100 && !globalThis.AtriumNavHost; n++) await wait(100);
  document.querySelectorAll("dialog[open]").forEach(d => d.close());
  await settle(3000);
  // The small project is a saved one: the starter example opened from a file, as Finder opens it.
  {
    if (!globalThis.AtriumParts) await AtriumLazy.need("AtriumParts");
    const path = await post("openFile", {text: JSON.stringify(AtriumParts.example()), name: "Energy.waffle"});
    for (let n = 0; n < 150 && globalThis.AtriumHost?.projectPath !== path; n++) await wait(100);
    for (let n = 0; n < 100 && !globalThis.AtriumCollabLock?.manager?.(); n++) await wait(100);
    R.saved = {path: globalThis.AtriumHost?.projectPath === path, collab: !!globalThis.AtriumCollabLock?.manager?.()};
    note("saved project " + JSON.stringify(R.saved));
    document.querySelectorAll("dialog[open]").forEach(d => d.close());
    await settle(3000);
  }
  const docOf = k => H().project().documents.find(d => d.kind === k);
  const mid = () => {const r = cv().getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];};
  const wheel = o => {const [x, y] = mid(); cv().dispatchEvent(new WheelEvent("wheel", {clientX: x, clientY: y, bubbles: true, cancelable: true, deltaMode: 0, ...o}));};
  const pev = (type, [x, y], o = {}) => cv().dispatchEvent(new PointerEvent(type, {clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, bubbles: true, cancelable: true, isPrimary: true, pointerType: "mouse", ...o}));
  const esc = () => { for (const key of ["Escape", "Escape"]) cv().dispatchEvent(new KeyboardEvent("keydown", {key, code: key, bubbles: true})); act("select"); };
  // Input once per frame for ms; a 16 ms timer stands in when no frame comes (an occluded window).
  const nextFrame = () => new Promise(r => {let done = false; const go = () => {if (!done) {done = true; r();}}; requestAnimationFrame(go); setTimeout(go, 50);});
  const frames = async (ms, input) => {const t0 = performance.now(); let i = 0; for (; performance.now() - t0 < ms; i++) {input(i); await nextFrame();} note("frames driven " + i + " in " + ms + " ms");};

  if (docOf("schematic")) { H().selectDocument(docOf("schematic").id); act("fit"); await settle(2500); await measure("small.sch.idle", 60); }
  if (docOf("pcb")) {
    H().selectDocument(docOf("pcb").id); act("fit"); await settle(2500); await measure("small.pcb.idle", 60);
    await toIdle("small.pcb.edit", async () => {const it = H().doc().items.find(i => i.kind === "part"); if (it) H().edit(() => {it.x += 1;});});
  }

  // The big board, as frame-probes.js builds it (pours repoured once before measuring).
  await AtriumLazy.need("AtriumRules"); await AtriumLazy.need("AtriumPCBDraw"); await AtriumLazy.need("AtriumRouter"); await AtriumLazy.need("AtriumCanvasFast");
  const PP = AtriumPolygonPour, p = Atrium.project("Dense", AtriumParts.catalogue), old = p.documents.find(x => x.kind === "pcb");
  const {d} = makeAtriumBenchmarkBoard(); p.documents = p.documents.map(x => x === old ? d : x);
  let k = 0;
  for (const i of d.items) {if (i.kind === "part") i.pinNets = {"1": "N" + (k % 64), "2": "N" + ((k + 1) % 64)}; else if (i.kind !== "track") i.net = "N" + (k % 64); k++;}
  const rect = (a, b, c, e) => [[a, b], [c, b], [c, e], [a, e]];
  const polys = [["Top", "GND", rect(1, 1, 180, 270)], ["Top", "VCC", rect(180, 1, 367, 270)], ["Bottom", "GND", rect(1, 1, 367, 140)], ["Bottom", "VCC", rect(1, 140, 367, 270)]];
  for (let j = 0; j < 6; j++) polys.push([j % 2 ? "Top" : "Bottom", "N" + j, rect(10 + j * 55, 10, 50 + j * 55, 40)]);
  polys.forEach(([layer, net, o], j) => d.items.push(PP.make(o, {layer, net, pourIndex: j, removeDeadCopper: false})));
  // A big schematic: 1,600 resistors with a wire each, on the same project.
  const sch = p.documents.find(x => x.kind === "schematic");
  if (sch) for (let r = 0; r < 40; r++) for (let c = 0; c < 40; c++) {
    const x = c * 30, y = r * 20, id = "e" + r + "_" + c;
    sch.items.push({id: id + "p", kind: "part", def: "std-r", x, y, angle: 0, ref: "R" + (r * 40 + c + 1), value: "10k"});
    sch.items.push({id: id + "w", kind: "wire", points: [[x + 10, y], [x + 20, y]]});
  }
  await H().replaceProject(p, {force: true}); H().selectDocument(d.id); await settle(300);
  H().edit(() => PP.apply(H().doc(), H().defs(), {project: H().project()}));
  act("fit"); await settle(2500);
  for (let n = 0; n < 400 && PP.live?.busy; n++) await wait(50);
  await settle(3000);
  R.liveMode = PP.live?.mode?.() ?? null; R.drcOnline = globalThis.AtriumDRCView?.enabled?.() ?? null;
  await measure("big.pcb.idle", 60);
  if (sch) { H().selectDocument(sch.id); act("fit"); await settle(3000); await measure("big.sch.idle", 20); await toIdle("big.sch.edit", async () => {const it = H().doc().items.find(i => i.kind === "part"); H().edit(() => {it.x += 10;});}); H().selectDocument(d.id); act("fit"); await settle(2500); }

  // Idle with a selection, an armed tool, online DRC, live pours, the 3D view, the BOM.
  {const part = H().doc().items.find(i => i.kind === "part"); await toIdle("big.pcb.select", async () => H().select([part.id])); await measure("big.pcb.selection", 20); await measure("big.pcb.selection.later", 20); H().select([]); await settle(800);}
  {act("route"); const [x, y] = mid(); pev("pointermove", [x, y], {buttons: 0}); await settle(1500); await measure("big.pcb.toolArmed", 20); esc(); await settle(800);}
  {
    await AtriumLazy.need("AtriumDRCView").catch(() => null);
    const DV = globalThis.AtriumDRCView, was = DV?.enabled?.();
    if (DV && !was) act("drc-online");
    await settle(1500);
    await toIdle("big.pcb.edit.drcOnline", async () => {const it = H().doc().items.find(i => i.kind === "via"); H().edit(() => {it.x += .2;});});
    await settle(8000);
    await measure("big.pcb.drcOnline", 20, {drcOnline: DV?.enabled?.()});
    if (DV && DV.enabled() !== was) act("drc-online");
    await settle(800);
  }
  {
    const was = PP.live?.mode?.();
    if (was !== "live") PP.live?.setMode?.("live");
    await toIdle("big.pcb.edit.livePours", async () => {const it = H().doc().items.find(i => i.kind === "via"); H().edit(() => {it.x += .2;});});
    await settle(8000);
    await measure("big.pcb.livePours", 20, {live: PP.live?.mode?.()});
    if (was && was !== PP.live?.mode?.()) PP.live?.setMode?.(was);
    await settle(800);
  }
  if (!only.size || only.has("big.pcb.view3d")) {
    act("view-3d"); await settle(12000);
    await measure("big.pcb.view3d", 20, {open: !!document.querySelector(".v3d-dialog[open], dialog[open] canvas, .v3d")});
    document.querySelectorAll("dialog[open]").forEach(x => x.close()); act("view-2d"); await settle(1500);
  }
  if (!only.size || only.has("big.pcb.bom")) {
    act("bom"); await settle(12000);
    await measure("big.pcb.bom", 20, {open: !!document.querySelector("dialog[open]")});
    document.querySelectorAll("dialog[open]").forEach(x => x.close()); await settle(1500);
  }

  // Interaction then stop: pan/zoom 10 s, route 10 s.
  await post("focusWindow");
  await toIdle("big.pcb.panZoom", () => frames(10000, i => i % 120 < 60 ? wheel({deltaX: i % 60 < 30 ? 6 : -6, deltaY: i % 60 < 30 ? 4 : -4}) : wheel({deltaY: (i >> 3) % 2 ? 3 : -3, deltaMode: 1})));
  act("fit"); await settle(2000);
  {
    H().zoomTo([150, 110, 210, 150]); await settle(1500);
    const r = cv().getBoundingClientRect(), via = H().doc().items.filter(i => i.kind === "via").find(i => {const q = H().view().worldToScreen([i.x, i.y]); return q[0] > 150 && q[1] > 150 && q[0] < r.width - 150 && q[1] < r.height - 150;});
    const s = H().view().worldToScreen([via.x, via.y]), q = [s[0] + r.left, s[1] + r.top];
    await toIdle("big.pcb.route", async () => {
      act("route"); pev("pointermove", q, {buttons: 0}); pev("pointerdown", q); pev("pointerup", q);
      await frames(10000, i => pev("pointermove", [q[0] + (i % 60) * 2, q[1] + (i % 40)], {buttons: 0}));
    });
    esc(); await settle(1500);
  }
  await toIdle("big.pcb.edit", async () => {const it = H().doc().items.find(i => i.kind === "via"); H().edit(() => {it.x += .2;});});
  // Efficiency mode Always (power.js): the same interactions, and idle.
  if (globalThis.AtriumPower) {
    R.powerState = AtriumPower.state();
    AtriumPower.setMode("always"); await settle(10000);   // the switch restyles the page once
    R.powerStateEfficient = AtriumPower.state();
    await measure("eff.big.pcb.idle", 20);
    {const part = H().doc().items.find(i => i.kind === "part"); await toIdle("eff.big.pcb.select", async () => H().select([part.id])); H().select([]); await settle(1500);}
    await toIdle("eff.big.pcb.edit", async () => {const it = H().doc().items.find(i => i.kind === "via"); H().edit(() => {it.x += .2;});});
    await toIdle("eff.big.pcb.panZoom", () => frames(10000, i => i % 120 < 60 ? wheel({deltaX: i % 60 < 30 ? 6 : -6, deltaY: i % 60 < 30 ? 4 : -4}) : wheel({deltaY: (i >> 3) % 2 ? 3 : -3, deltaMode: 1})));
    AtriumPower.setMode("auto");
  }
  // Background, occluded, minimised, hidden: last, since with the screen locked (an unattended run) the
  // window stays occluded for WebKit once detection has been on.
  for (const [name, on, off] of [["big.pcb.background", "deactivate", "restore"], ["big.pcb.occluded", "cover", "uncover"], ["big.pcb.minimised", "minimize", "restore"], ["big.pcb.hidden", "hide", "unhide"]]) {
    if (only.size && !only.has(name)) continue;
    await post("occlusionDetection", {on: true});
    const w = await post("window", {act: on}); await wait(1000);
    await measure(name, 20, {window: w, power: globalThis.AtriumPower?.state?.()});
    await post("window", {act: off}); await post("occlusionDetection", {on: false}); await post("focusWindow"); onScreen(); await settle(2000);
  }

  H().setDirty?.(false);
  return R;
}
