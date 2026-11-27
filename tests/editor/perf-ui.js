"use strict";
// UI-shell interaction probe for scripts/perf-ui.sh. Drives the real editor (app/index.html) on the
// 25.6k-object stress board (tests/pcb/dense-board.js) inside a project with 60 extra schematic sheets,
// and times every UI-shell interaction from input to the next painted frame:
//
//   t0 = just before the input is dispatched (a click, key, contextmenu, input or pointer event, or
//        the editor call a click makes), t1 = the first task after the next requestAnimationFrame,
//        i.e. after the frame that shows the result has run style, layout and paint.
//   next  = t1 - t0 (input to next paint; the budgeted value). Sash drags wait one more frame: the
//           canvas follows a resize through a ResizeObserver, which draws in the frame after.
//   sync  = time spent synchronously in the handler (the input event's own task)
//
// Long tasks (PerformanceObserver "longtask", over 50 ms) and long animation frames
// ("long-animation-frame", Chrome 123+) are attributed to the interaction whose window
// [t0, t1 + 100 ms] they start in; where neither entry type exists, a rAF gap monitor stands in
// (a frame gap over 50 ms counts as one long task).
//
// The canvas render loop is not this probe's subject (scripts/perf-canvas.sh budgets it); the
// interactions that redraw the board (selection, tab switch, theme, sash drag) include the frame
// that redraw lands in, because that is what the user waits for.
//
// atriumUiProbe({reps}) resolves to {metrics: {name: {n, p50, p95, p99, sync50, sync95, longTasks,
// longMaxMs, loafs}}, checks: {...}, env: {...}}.
globalThis.atriumUiProbe = async function(options = {}) {
  const REPS = options.reps || 1;
  // options.only: run just these sections (menus context palette props messages tree dialogs tabs dock theme).
  const want = name => !options.only || options.only.includes(name);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const H = () => globalThis.AtriumNavHost, L = globalThis.AtriumLazy;
  const act = a => window.dispatchEvent(new CustomEvent("atrium-command", {detail: a}));
  const nextPaint = () => new Promise(r => requestAnimationFrame(() => {const c = new MessageChannel(); c.port1.onmessage = () => r(performance.now()); c.port2.postMessage(0);}));
  const frames = async n => {for (let i = 0; i < n; i++) await nextPaint();};
  const settle = async (ms = 40) => {await wait(ms); await frames(2);};
  const pct = (a, p) => {if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)].toFixed(2);};
  const isMac = /Mac|iP(hone|ad)/.test(navigator.platform || "");
  const errors = [];
  addEventListener("error", e => errors.push(String(e.message)));

  // ---- long tasks
  const longs = [], loafs = [];
  let longKind = "none";
  try {new PerformanceObserver(l => {for (const e of l.getEntries()) longs.push({t: e.startTime, d: e.duration});}).observe({type: "longtask", buffered: false}); longKind = "longtask";} catch {}
  try {new PerformanceObserver(l => {for (const e of l.getEntries()) loafs.push({t: e.startTime, d: e.duration, block: e.blockingDuration || 0});}).observe({type: "long-animation-frame", buffered: false}); longKind += "+loaf";} catch {}
  if (longKind === "none") {
    // Fallback (WebKit): a rAF gap over 50 ms is one long task.
    let last = performance.now();
    const tick = t => {if (t - last > 50) longs.push({t: last, d: t - last}); last = t; requestAnimationFrame(tick);};
    requestAnimationFrame(tick); longKind = "raf-gap";
  }

  // ---- measurement
  const metrics = {}, windows = {};
  const record = (name, next, sync, t0, t1) => {
    const m = metrics[name] || (metrics[name] = {next: [], sync: []});
    m.next.push(next); m.sync.push(sync);
    (windows[name] || (windows[name] = [])).push([t0, t1 + 100]);
  };
  // One sample: fn() dispatches the input synchronously; the sample ends at the next painted frame.
  // paints > 1 when the result lands a frame later by design (a ResizeObserver schedules the canvas).
  async function sample(name, fn, paints = 1) {
    window.__uiStep = name;
    await frames(1);
    const t0 = performance.now();
    try {fn();} catch (e) {errors.push(name + ": " + e.message);}
    const ts = performance.now();
    let t1 = await nextPaint();
    for (let i = 1; i < paints; i++) t1 = await nextPaint();
    record(name, t1 - t0, ts - t0, t0, t1);
    return t1 - t0;
  }
  const key = (target, k, o = {}) => target.dispatchEvent(new KeyboardEvent("keydown", {key: k, code: o.code || (k.length === 1 ? "Key" + k.toUpperCase() : k), bubbles: true, cancelable: true, ...o}));
  const typeInto = (input, value) => {input.value = value; input.dispatchEvent(new Event("input", {bubbles: true}));};
  const escape = () => {const t = document.activeElement || document.body; key(t, "Escape", {code: "Escape"});};
  const closeDialogs = () => {for (const d of document.querySelectorAll("dialog[open]")) try {d.close();} catch {}};

  // ---- refresh rate (rAF deltas), before anything heavy
  const refreshHz = await new Promise(done => {const t = []; const tick = ts => {t.push(ts); if (t.length < 41) requestAnimationFrame(tick); else {
    const d = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b); done(+(1000 / d[d.length >> 1]).toFixed(1));}}; requestAnimationFrame(tick); setTimeout(() => done(null), 3000);});

  // ---- the stress project: 25.6k-object board (nets on vias, pads and parts) plus 60 sheets
  const A = globalThis.Atrium, p = A.project("Perf UI", AtriumParts.catalogue), old = p.documents.find(x => x.kind === "pcb");
  const {d} = makeAtriumBenchmarkBoard(); p.documents = p.documents.map(x => x === old ? d : x);
  let k = 0;
  for (const i of d.items) {if (i.kind === "part") i.pinNets = {"1": "N" + (k % 64), "2": "N" + ((k + 1) % 64)}; else if (i.kind !== "track") i.net = "N" + (k % 64); k++;}
  const sch = p.documents.find(x => x.kind === "schematic");
  for (let s = 0; s < 60; s++) {const x = A.sheet("schematic", "Sheet " + (s + 2)); p.documents.push(x);}
  await H().replaceProject(p, {force: true});
  H().selectDocument(d.id); act("fit");
  await settle(400);
  // Modules a user has by the time they interact (idle prefetches); first loads are not timed here.
  for (const m of ["AtriumPalette", "AtriumContextMenu", "AtriumMessages", "AtriumPrefs", "AtriumDock", "AtriumNavigatorPanel"])
    try {await L.need(m);} catch (e) {errors.push("load " + m + ": " + e.message);}
  // DRC markers (drc-markers.js) on this synthetic board number in the thousands and are budgeted
  // with their module; hidden here as in perf-canvas. MARKERS=1 (options.markers) keeps them.
  if (!options.markers) globalThis.AtriumDRCMarkers?.setVisible?.(false, H());
  // A first launch opens the start page (modal); close it as a user would before working.
  for (let i = 0; i < 3 && document.querySelector("dialog[open]"); i++) {closeDialogs(); await settle(100);}
  H().canvas().focus();
  await settle(600);
  const checks = {startPageClosed: !document.querySelector("dialog[open]"), items: H().doc().items.length, documents: H().project().documents.length, refreshHz, longTaskSource: longKind};

  // ---- menus: open each top menu by clicking its summary, close with a second click
  if (want("menus")) {
  const menus = [...document.querySelectorAll(".menubar > details.work-menu > summary")];
  for (let r = 0; r < 3 * REPS; r++) for (const s of menus) {
    await sample("menu-open", () => s.click());
    await sample("menu-close", () => s.click());
  }
  checks.menus = menus.length;

  }
  // ---- context menu on the board (part under the pointer and empty canvas)
  if (want("context")) {
  const cv = H().canvas(), cb = cv.getBoundingClientRect();
  const part = d.items.find(i => i.kind === "part");
  for (let r = 0; r < 12 * REPS; r++) {
    const at = r % 2 ? [cb.left + 30, cb.top + 30] : (() => {const s = H().view().worldToScreen([part.x, part.y]); return [cb.left + s[0], cb.top + s[1]];})();
    await sample("context-menu", () => cv.dispatchEvent(new MouseEvent("contextmenu", {bubbles: true, cancelable: true, button: 2, clientX: at[0], clientY: at[1], view: window})));
    checks.contextMenu = !!document.querySelector(".nav-menu") || checks.contextMenu || false;
    escape(); await settle(20);
    
  }

  }
  // ---- command palette: open (Cmd/Ctrl+Shift+P), type a command, close
  if (want("palette")) {
  const P = globalThis.AtriumPalette;
  for (let r = 0; r < 10 * REPS; r++) {
    H().canvas().focus(); await sample("palette-open", () => key(H().canvas(), "P", {code: "KeyP", shiftKey: true, metaKey: isMac, ctrlKey: !isMac}));
    if (!P.isOpen()) {P.open(">"); checks.paletteKey = false;} else checks.paletteKey ??= true;
    const input = document.querySelector("dialog.nav-palette input");
    let q = ">";
    for (const ch of "route") {q += ch; await sample("palette-type-command", () => typeInto(input, q));}
    await sample("palette-close", () => key(input, "Escape", {code: "Escape"}));
    await settle(20);
  }
  // Quick open (search everything) on the 25.6k board: designators, nets and library parts.
  if (P.index?.() == null) P.startIndex?.();
  try {P.readyIndex?.();} catch {}
  await settle(200);
  for (let r = 0; r < 4 * REPS; r++) {
    act("quick-open"); await settle(30);
    const input = document.querySelector("dialog.nav-palette input");
    for (const word of ["R1", "N12", "res", "gnd", "o2001"]) {
      let q = "";
      for (const ch of word) {q += ch; await sample("quick-open-type", () => typeInto(input, q));}
    }
    key(input, "Escape", {code: "Escape"}); await settle(20);
  }

  }
  // ---- Properties: single selection (each object kind) and 5,000 objects
  if (want("props")) {
  const kinds = ["part", "via", "track", "pad"].map(t => d.items.filter(i => i.kind === t));
  for (let r = 0; r < 10 * REPS; r++) for (const list of kinds) {
    const it = list[(r * 37) % list.length];
    await sample("props-single", () => H().select([it.id], it.id));
  }
  const five = d.items.slice(0, 5000).map(i => i.id);
  for (let r = 0; r < 6 * REPS; r++) {
    await sample("props-5k", () => H().select(five, five[0]));
    await sample("props-clear", () => H().select([]));
  }

  }
  // ---- Messages panel with 5,000 DRC rows: show, scroll, filter, sort, keyboard
  if (want("messages")) {
  const M = globalThis.AtriumMessages, ctx = H().messageContext();
  const rows = [];
  for (let n = 0; n < 5000; n++) {const it = d.items[(n * 5) % d.items.length];
    rows.push({class: n % 7 ? "Error" : "Warning", source: "DRC", document: d.name, objectId: it.id, point: it.x != null ? [it.x, it.y] : it.points[0],
      text: (n % 3 ? "Clearance Constraint: (0.127mm < 0.2mm) Between Track on Top and Via N" : "Short-Circuit Constraint: Between Pad R" ) + (n % 64)});}
  for (let r = 0; r < 4 * REPS; r++) {
    await sample("messages-show-5k", () => M.show(ctx, {title: "Design Rule Check", group: "DRC", messages: rows}));
    await settle(30);
    if (r < 3) {await sample("messages-close", () => M.close()); await settle(20);}
  }
  const grid = document.querySelector(".msg-panel .msg-grid");
  checks.messagesRowsInDom = grid ? grid.querySelectorAll("tbody tr").length : null;
  checks.messagesView = M.view(); checks.messagesListed = M.view() === "problems" ? M.problems().length : M.messages().length;
  if (grid) {
    for (let r = 0; r < 40 * REPS; r++) await sample("messages-scroll", () => {grid.scrollTop = (r % 20) * 1600 + (r > 19 ? 37 : 0); grid.dispatchEvent(new Event("scroll"));});
    grid.scrollTop = 0; grid.focus();
    for (let r = 0; r < 20 * REPS; r++) await sample("messages-arrow", () => key(grid, r % 5 === 4 ? "PageDown" : "ArrowDown", {code: "ArrowDown"}));
    const search = document.querySelector(".msg-panel input[type=search]");
    for (let r = 0; r < 2 * REPS; r++) {
      let q = "";
      for (const ch of "short") {q += ch; await sample("messages-filter", () => typeInto(search, q));}
      for (let i = q.length - 1; i >= 0; i--) await sample("messages-filter", () => typeInto(search, q.slice(0, i)));
    }
    const heads = [...document.querySelectorAll(".msg-panel thead button")];
    for (let r = 0; r < 4 * REPS; r++) for (const b of heads.slice(0, 4)) await sample("messages-sort", () => b.click());
  }
  M.close(); await settle(30);

  }
  // ---- project tree and navigator: 62 documents; switch sheets from the tree, open and filter the Navigator
  if (want("tree")) {
  const docRows = () => [...document.querySelectorAll("#documents [data-doc]")];
  checks.treeRows = docRows().length;
  const sheets = H().project().documents.filter(x => x.kind === "schematic").slice(0, 8);
  for (let r = 0; r < 3 * REPS; r++) for (const s of sheets) {
    const row = document.querySelector('#documents [data-doc="' + s.id + '"]');
    await sample("tree-switch-sheet", () => row ? row.click() : H().selectDocument(s.id));
  }
  H().selectDocument(d.id); await settle(200);
  for (let r = 0; r < 4 * REPS; r++) {
    await sample("navigator-toggle", () => act("navigator-panel"));
    await settle(80);
    const nsearch = document.querySelector(".panel-navp input[type=search]");
    if (nsearch && r === 0) {
      let q = "";
      for (const ch of "N12") {q += ch; await sample("navigator-filter", () => typeInto(nsearch, q));}
      await wait(120); await frames(2);
      typeInto(nsearch, ""); await wait(120);
    }
    await sample("navigator-toggle", () => act("navigator-panel"));
    await settle(40);
  }

  }
  // ---- dialogs: Preferences (open, page switch, search, close), Keyboard Shortcuts, Library
  if (want("dialogs")) {
  for (let r = 0; r < 4 * REPS; r++) {
    await sample("prefs-open", () => act("preferences-page"));
    await settle(30);
    const nav = [...document.querySelectorAll(".prf-dialog .prf-nav button")];
    for (const b of nav.slice(0, 8)) await sample("prefs-page", () => b.click());
    if (r === 0) {const s = document.querySelector(".prf-dialog .prf-search"); let q = ""; for (const ch of "grid") {q += ch; await sample("prefs-search", () => typeInto(s, q));} typeInto(s, "");}
    const dlg = document.querySelector(".prf-dialog");
    await sample("dialog-close", () => dlg?.close());
    await settle(30);
  }
  for (let r = 0; r < 4 * REPS; r++) {
    await sample("library-open", () => act("library"));
    await settle(30);
    const ld = document.getElementById("library-dialog");
    await sample("dialog-close", () => ld?.close());
    await settle(30);
  }

  }
  // ---- document tabs: schematic <-> 25.6k board
  if (want("tabs")) {
  const tabs = () => [...document.querySelectorAll("#document-tabs [data-tab]")];
  H().selectDocument(sch.id); await settle(100); H().selectDocument(d.id); await settle(300);
  for (let r = 0; r < 8 * REPS; r++) {
    const t = tabs().find(x => x.dataset.tab === (r % 2 ? d.id : sch.id));
    await sample(r % 2 ? "tab-to-pcb" : "tab-to-schematic", () => t ? t.click() : H().selectDocument(r % 2 ? d.id : sch.id));
    await settle(60);
  }
  H().selectDocument(d.id); await settle(200);

  }
  // ---- docking: drag the left side bar's sash, and the bottom dock's
  if (want("dock")) {
  for (const kind of ["left", "right"]) {
    const s = document.querySelector(".dock-sash-" + kind);
    if (!s) {checks["sash-" + kind] = "absent"; continue;}
    s.setPointerCapture = () => {}; s.releasePointerCapture = () => {};
    for (let r = 0; r < REPS; r++) {
      const b = s.getBoundingClientRect(), x0 = b.left + b.width / 2, y0 = b.top + b.height / 2;
      const pe = (type, x) => s.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 7, isPrimary: true, pointerType: "mouse", clientX: x, clientY: y0}));
      pe("pointerdown", x0);
      for (let i = 1; i <= 30; i++) await sample("sash-drag", () => pe("pointermove", x0 + (kind === "left" ? 1 : -1) * Math.sin(i / 30 * Math.PI) * 120), 2);
      await sample("sash-release", () => pe("pointerup", x0), 2);
      await settle(60);
    }
  }

  }
  // ---- theme switching (light <-> dark)
  if (want("theme")) {
  // Leave the full dock observation window open for delayed sash work before dispatching a theme.
  const dockTail = windows["sash-release"]?.at(-1)?.[1] ?? 0;
  while (performance.now() <= dockTail) await wait(dockTail - performance.now() + 1);
  for (let r = 0; r < 6 * REPS; r++) {
    await sample("theme-switch", () => act(r % 2 ? "theme-dark" : "theme-light"));
    await settle(60);
  }
  act("theme-dark"); await settle(60);

  }
  // ---- results
  await wait(300);
  const out = {};
  for (const [name, m] of Object.entries(metrics)) {
    const w = windows[name], inW = e => w.some(([a, b]) => e.t >= a && e.t <= b);
    const lt = longs.filter(inW), lf = loafs.filter(inW);
    out[name] = {n: m.next.length, p50: pct(m.next, .5), p95: pct(m.next, .95), p99: pct(m.next, .99), max: +Math.max(...m.next).toFixed(2),
      sync50: pct(m.sync, .5), sync95: pct(m.sync, .95), longTasks: lt.length, longMaxMs: lt.length ? Math.round(Math.max(...lt.map(e => e.d))) : 0,
      loafs: lf.length};
  }
  checks.longTasksTotal = longs.length; checks.loafsTotal = loafs.length;
  return {metrics: out, checks, env: {ua: navigator.userAgent, dpr: devicePixelRatio, w: innerWidth, h: innerHeight}, errors: errors.slice(0, 20)};
};
