"use strict";
// Read-only Waffle preview inside a VS Code webview. Draws with the editor's own renderer
// (app/canvas.js and its modules, bundled into media/app by scripts/bundle-viewer.py).
// The extension resolves the native records and sends a read-only project projection.
// This view reports readiness and rendering errors.
(function () {
  const host = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : {postMessage() {}, getState() { return null; }, setState() {}};
  const $ = id => document.getElementById(id);
  const canvas = $("view"), select = $("doc"), status = $("status"), errorBox = $("error"), fitButton = $("fit");
  const saved = host.getState() || {};
  let project = null, defs = null, view = null, docId = saved.docId || null, frame = 0;
  const cameras = new Map();

  function fail(message) {
    errorBox.textContent = message; errorBox.hidden = false; canvas.hidden = true; status.textContent = "";
    host.postMessage({type: "error", message: String(message).slice(0, 300)});
  }
  const current = () => project?.documents.find(d => d.id === docId) || null;
  function draw() {
    frame = 0;
    const doc = current();
    if (!doc || !view) return;
    view.render(doc, defs, {project, grid: false, origin: false, hidden: new Set(), showUnrouted: true, selectedIds: new Set()});
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
  function show(id, fit) {
    const prev = current();
    if (prev && view) cameras.set(prev.id, view.camera());
    docId = id; host.setState({docId});
    const doc = current();
    if (!doc) return;
    select.value = id;
    const parts = doc.items.filter(i => i.kind === "part").length;
    status.textContent = (doc.kind === "pcb" ? "Board" : doc.kind === "schematic" ? "Sheet" : "Panel") + " · " + doc.items.length + " objects · " + parts + " parts";
    if (fit || !cameras.has(id)) { view.fit(doc, defs, doc.kind === "pcb" ? "board" : undefined); }
    else view.restoreCamera(cameras.get(id));
    draw();
  }
  function load(p, name) {
    try { if (globalThis.Atrium?.validate) Atrium.validate(p); else throw Error("The viewer files are missing."); }
    catch (e) { return fail("Waffle cannot show this file: " + e.message); }
    if (!globalThis.AtriumCanvas) return fail("The viewer files are missing.");
    errorBox.hidden = true; canvas.hidden = false;
    const first = !project;
    project = p; defs = new Map(p.library.map(d => [d.id, d]));
    view ??= AtriumCanvas.create(canvas);
    document.title = name || p.name;
    select.replaceChildren(...p.documents.filter(d => d.kind === "pcb" || d.kind === "schematic").map(d => new Option((d.kind === "pcb" ? "Board · " : "Sheet · ") + d.name, d.id)));
    if (!select.options.length) return fail("This project has no sheet or board to show.");
    const keep = p.documents.some(d => d.id === docId) ? docId : select.options[0].value;
    show(keep, first);
  }

  window.addEventListener("message", e => {
    const m = e.data;
    if (m?.type === "error") fail(String(m.message));
    else if (m?.type === "project" && m.project) load(m.project, typeof m.name === "string" ? m.name : "");
  });
  select.addEventListener("change", () => show(select.value, false));
  fitButton.addEventListener("click", () => show(docId, true));

  // Navigation only: drag to pan, wheel or pinch to zoom, F to fit, +/- to zoom.
  let drag = null;
  canvas.addEventListener("pointerdown", e => { drag = {x: e.clientX, y: e.clientY}; canvas.setPointerCapture(e.pointerId); canvas.focus(); });
  canvas.addEventListener("pointermove", e => {
    if (!drag || !view) return;
    view.pan(e.clientX - drag.x, e.clientY - drag.y); drag = {x: e.clientX, y: e.clientY}; schedule();
  });
  const end = () => { drag = null; };
  canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("wheel", e => {
    if (!view) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    view.zoom(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), [e.clientX - r.left, e.clientY - r.top]); schedule();
  }, {passive: false});
  canvas.addEventListener("keydown", e => {
    if (!view) return;
    if (e.key === "f" || e.key === "F") show(docId, true);
    else if (e.key === "+" || e.key === "=") { view.zoom(1.25); schedule(); }
    else if (e.key === "-") { view.zoom(0.8); schedule(); }
    else return;
    e.preventDefault();
  });
  if (typeof ResizeObserver === "function") new ResizeObserver(() => { if (view) { view.resized(); schedule(); } }).observe(canvas);
  host.postMessage({type: "ready"});
})();
