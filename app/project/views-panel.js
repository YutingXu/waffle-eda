"use strict";
// Views panel: one dock panel with
// a Saved views tab (butter.savedViews) and a Slides tab (butter.slides). Both present through the
// documents family's one presentation mode, step with its one pager and preview with its one strip.
globalThis.AtriumViewsPanel = (() => {
  const G = globalThis, F = () => G.AtriumDocsFamily;
  const enabled = feature => G.AtriumButter?.state(feature)?.enabled === true;
  const read = (id, args = {}) => G.AtriumButter.run(id, args, {mode: "read"}).then(r => r.result);
  const write = (id, args = {}) => G.AtriumButterEditor.apply(id, args).then(r => r.result);
  const PAGE = 50, KIND_ICON = {schematic: "schematic", pcb: "board", drawing: "drawing", panel: "board"};
  let K, host, panel, tabs, frame = 0, tab = "views", closing = false;
  const ui = {};
  const views = {rows: [], total: 0, shown: PAGE, selected: new Set(), focus: null, current: null, renaming: null, busy: null, notice: null};
  const slides = {rows: [], total: 0, current: null, notice: null, busy: null, deck: null};

  // ------------------------------------------------------------------ shell
  async function open(which) {
    if (!enabled("savedViews") && !enabled("slides")) return false;
    K = await G.AtriumLazy.need("AtriumUIKit");
    await G.AtriumLazy.need("AtriumHistoryArtwork").catch(() => {});
    host = G.AtriumNavHost;
    if (!panel) build();
    choose(which || (enabled(tab === "views" ? "savedViews" : "slides") ? tab : enabled("savedViews") ? "views" : "slides"));
    panel.hidden = false;
    schedule();
    return true;
  }
  function close() { if (panel) panel.hidden = true; }
  function toggle(which) { if (panel && !panel.hidden && (!which || which === tab)) close(); else void open(which); }

  function build() {
    panel = K.el("section", "panel panel-views docs-panel"); panel.hidden = true;
    panel.setAttribute("aria-labelledby", "views-heading");
    const head = K.el("header", "pane-heading"), h2 = K.el("h2", null, "Views"); h2.id = "views-heading";
    head.append(h2, K.closeButton(close, "Close Views"));
    tabs = K.tabs([["views", "Saved views"], ["slides", "Slides"]], {strip: true, label: "Views", value: tab, onChange: id => choose(id)});
    ui.views = buildViews(); ui.slides = buildSlides();
    panel.append(head, tabs, ui.views.pane, ui.slides.pane);
    (document.getElementById("properties") || document.body).append(panel);
    const spec = {id: "views", title: "Views", element: panel, area: "right", action: "views-panel"};
    if (G.AtriumDock?.register) G.AtriumDock.register(spec); else (G.AtriumDockPending ||= []).push(spec);
    host.on?.("change", schedule); host.on?.("document", schedule);
  }
  function choose(id, repaint = true) {
    tab = id;
    for (const b of tabs.querySelectorAll(".ui-tab")) {
      const feature = b.value === "views" ? "savedViews" : "slides";
      b.hidden = !enabled(feature);
      const on = b.value === id; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1;
    }
    tabs.hidden = !(enabled("savedViews") && enabled("slides"));
    ui.views.pane.hidden = id !== "views"; ui.slides.pane.hidden = id !== "slides";
    if (repaint) schedule();
  }
  function schedule() { if (!frame && panel && !panel.hidden) frame = requestAnimationFrame(() => { frame = 0; void paint(); }); }
  async function paint() {
    if (!panel || panel.hidden) return;
    if (!enabled("savedViews") && !enabled("slides")) { close(); return; }
    choose(enabled(tab === "views" ? "savedViews" : "slides") ? tab : tab === "views" ? "slides" : "views", false);
    try {
      if (tab === "views") await paintViews(); else await paintSlides();
    } catch (error) { showNotice(tab === "views" ? views : slides, {tone: "danger", text: error.message}); }
  }
  const docOf = id => host.docById?.(id) || host.documentRefs?.().find(d => d.id === id) || null;
  const toast = (text, kind) => G.AtriumToast?.show(text, {kind});
  // AtriumContextMenu entries: enabled unless said otherwise; a submenu is {sub, items}.
  const menu = list => list.map(e => e === "-" ? e : e.items ? {sub: e.label, items: menu(e.items)} : {...e, enabled: e.enabled ?? true});
  function showNotice(model, spec) { model.notice = spec; (model === views ? ui.views : ui.slides).notice(); }

  function noticeSlot(model) {
    const slot = K.el("div", "docs-notice-slot");
    return {slot, paint() {
      const n = model.notice;
      slot.replaceChildren(...(n ? [K.notice({tone: n.tone, title: n.title, text: n.text, live: true,
        actions: [...(n.actions || []), K.button("Dismiss", {variant: "quiet", size: "sm", run: () => { model.notice = null; slot.replaceChildren(); }})]})] : []));
      slot.hidden = !n;
    }};
  }
  function busyLine(pane, model, label) {
    const node = label ? K.progress({label}) : K.statusLine("");
    model.busy?.remove?.(); model.busy = label ? node : null;
    if (label) pane.querySelector(":scope > .ui-status-line")?.before(node);
    return node;
  }

  // ------------------------------------------------------------------ saved views
  function buildViews() {
    const pane = K.el("div", "docs-pane"); pane.dataset.pane = "views";
    const capture = K.button("Save view", {variant: "quiet", size: "sm", run: () => void captureView()});
    capture.title = "Save the current camera, layers, selection and filter as a view";
    const present = K.button("Present", {variant: "quiet", size: "sm", run: () => void presentViews()});
    const exportPdf = K.button("Export PDF…", {variant: "quiet", size: "sm", run: () => void exportViews()});
    const bar = K.toolbar([capture, "->", present, exportPdf], {label: "Saved views"});
    const notice = noticeSlot(views);
    const list = K.list([], {label: "Saved views"}); list.tabIndex = 0;
    const status = K.statusLine("");
    const empty = K.empty({title: "No saved views", text: "Save the camera, layers, selection and filter you are looking at, then come back to it in one step.",
      actions: [K.button("Save current view", {run: () => void captureView()})]});
    pane.append(bar, notice.slot, list, empty, status);
    list.addEventListener("keydown", viewKeys);
    return {pane, list, empty, status, present, exportPdf, notice: notice.paint};
  }
  async function paintViews() {
    const r = await read("butter.savedViews.list", {offset: 0, limit: Math.min(views.shown, 100)});
    views.rows = r.views; views.total = r.total;
    const keep = new Set(views.rows.map(v => v.id));
    for (const id of views.selected) if (!keep.has(id)) views.selected.delete(id);
    const {list, empty, status, present, exportPdf} = ui.views;
    const nodes = views.rows.map(viewRow);
    if (views.total > views.rows.length) {
      const more = K.row({title: "Show " + Math.min(PAGE, views.total - views.rows.length) + " more", detail: views.rows.length + " of " + views.total, run: () => { views.shown += PAGE; schedule(); }});
      more.classList.add("docs-more"); nodes.push(more);
    }
    const hadFocus = list.contains(document.activeElement);
    list.replaceChildren(...nodes);
    list.hidden = !views.total; empty.hidden = !!views.total;
    present.disabled = exportPdf.disabled = !views.total;
    const sel = views.selected.size;
    status.querySelector(".ui-status-text").textContent = !views.total ? "" :
      views.total + (views.total === 1 ? " view" : " views") + (sel > 1 ? " · " + sel + " selected" : "");
    if (hadFocus) (list.querySelector('[aria-selected="true"]') || list.firstElementChild)?.focus({preventScroll: true});
    ui.views.notice();
  }
  function viewRow(v) {
    const doc = docOf(v.documentId), kind = doc?.kind;
    const meta = K.el("span", "ui-row-meta");
    if (v.status === "loading-document") meta.append(K.spinner({size: "sm", label: "Loading document"}));
    if (v.hasFilter) { const b = K.badge("Filter"); b.title = "Applies a saved filter"; meta.append(b); }
    if (v.selectionCount) { const c = K.count(v.selectionCount); c.title = v.selectionCount + " selected " + (v.selectionCount === 1 ? "object" : "objects"); meta.append(c); }
    const detail = v.status === "missing-document" ? "Document missing" : v.status === "loading-document" ? (v.documentName || "Document") + " · Loading…" : v.documentName || "";
    const remove = K.iconButton("delete", "Remove view", {size: "sm", run: e => { e.stopPropagation(); void removeView(v.id); }});
    const r = K.row({title: v.name, detail, icon: KIND_ICON[kind] || "dview", meta, actions: [remove],
      selected: views.selected.has(v.id), current: views.current === v.id,
      state: v.status === "missing-document" ? "broken" : v.status === "loading-document" ? "pending" : undefined});
    r.dataset.id = v.id; r.tabIndex = -1; r.title = v.name + (detail ? " · " + detail : "");
    if (views.renaming === v.id) {
      const title = r.querySelector(".ui-row-title"), field = K.field({value: v.name, label: "View name"});
      field.classList.add("docs-rename"); title.replaceWith(field);
      const done = commit => {
        if (views.renaming !== v.id) return;
        views.renaming = null;
        const keyboard = field.matches(":focus");
        if (commit && field.value.trim() && field.value.trim() !== v.name) void renameView(v.id, field.value); else schedule();
        if (keyboard) ui.views.list.focus({preventScroll: true});
      };
      field.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") done(true); else if (e.key === "Escape") done(false); });
      field.addEventListener("blur", () => done(true));
      requestAnimationFrame(() => { field.focus(); field.select(); });
    }
    r.addEventListener("click", e => {
      if (e.target.closest(".ui-row-actions,input")) return;
      if (e.metaKey || e.ctrlKey) { views.selected.has(v.id) ? views.selected.delete(v.id) : views.selected.add(v.id); views.focus = v.id; schedule(); return; }
      if (e.shiftKey && views.focus) { rangeSelect(v.id); schedule(); return; }
      views.selected = new Set([v.id]); views.focus = v.id; void applyView(v.id);
    });
    r.addEventListener("dblclick", e => { if (!e.target.closest("input")) { views.renaming = v.id; schedule(); } });
    r.addEventListener("contextmenu", e => { e.preventDefault(); if (!views.selected.has(v.id)) { views.selected = new Set([v.id]); views.focus = v.id; } viewMenu(v, e.clientX, e.clientY, r); });
    return r;
  }
  function rangeSelect(id) {
    const ids = views.rows.map(v => v.id), a = ids.indexOf(views.focus), b = ids.indexOf(id);
    views.selected = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
  }
  async function viewMenu(v, x, y, anchor) {
    const M = await G.AtriumLazy.need("AtriumContextMenu"), many = views.selected.size > 1;
    M.popup({host}, menu([
      {label: "Go to view", run: () => applyView(v.id), enabled: v.status !== "missing-document"},
      {label: "Rename", run: () => { views.renaming = v.id; schedule(); }, shortcut: "F2"},
      {label: "Copy link", run: () => copyLink(v.id)},
      "-",
      {label: "Present from here", run: () => presentViews(v.id)},
      {label: many ? "Export " + views.selected.size + " views as PDF…" : "Export PDF…", run: () => exportViews()},
      "-",
      {label: many ? "Remove " + views.selected.size + " views" : "Remove", run: () => removeSelectedViews()}
    ]), v.name, x, y, anchor, {pointer: true});
  }
  function viewKeys(e) {
    if (e.target.matches("input")) return;
    const ids = views.rows.map(v => v.id); if (!ids.length) return;
    let at = ids.indexOf(views.focus);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      at = Math.max(0, Math.min(ids.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
      if (e.shiftKey && views.focus) { rangeSelect(ids[at]); views.focus = ids[at]; } else { views.focus = ids[at]; views.selected = new Set([ids[at]]); }
    } else if (e.key === "Home" || e.key === "End") { views.focus = ids[e.key === "Home" ? 0 : ids.length - 1]; views.selected = new Set([views.focus]); }
    else if (e.key === "Enter" && views.focus) void applyView(views.focus);
    else if (e.key === "F2" && views.focus) views.renaming = views.focus;
    else if ((e.key === "Delete" || e.key === "Backspace") && views.selected.size) void removeSelectedViews();
    else if (e.key.toLowerCase() === "c" && (e.metaKey || e.ctrlKey) && views.focus) { void copyLink(views.focus); }
    else return;
    e.preventDefault(); schedule();
  }
  async function captureView() {
    const d = host.doc?.(), n = (host.project().savedViews?.length || 0) + 1;
    try {
      const r = await write("butter.savedViews.capture", {name: (d?.name || "View") + " " + n});
      views.selected = new Set([r.view.id]); views.focus = views.current = r.view.id; views.renaming = r.view.id;
      views.shown = Math.max(views.shown, views.total + 1);
      choose("views");
    } catch (error) { showNotice(views, {tone: "danger", text: error.message}); }
  }
  async function renameView(id, name) {
    try { await write("butter.savedViews.rename", {id, name: name.trim()}); }
    catch (error) { showNotice(views, {tone: "danger", text: error.message}); }
    schedule();
  }
  async function removeView(id) {
    try {
      const name = views.rows.find(v => v.id === id)?.name;
      await write("butter.savedViews.remove", {id});
      views.selected.delete(id); if (views.current === id) views.current = null;
      toast("Removed “" + name + "”. Undo brings it back.");
    } catch (error) { showNotice(views, {tone: "danger", text: error.message}); }
  }
  async function removeSelectedViews() { for (const id of [...views.selected]) await removeView(id); }
  async function copyLink(id) {
    const link = G.AtriumSavedViews?.pageSourceLink?.(host.project(), id) || "waffle://" + host.project().id + "/" + id;
    try { await navigator.clipboard.writeText(link); toast("Copied the link to this view."); }
    catch { toast("Couldn't copy the link.", "warn"); }
  }
  function viewProblem(r) {
    const view = r?.view || r;
    if (!view) return null;
    if (view.status === "missing-document") return {tone: "danger", label: "Document missing", text: "This view's document is no longer in the project."};
    if (view.status === "missing-view") return {tone: "danger", label: "View removed", text: "This saved view was removed."};
    if (view.status === "loading-document") return {tone: undefined, label: "Loading…", text: "Opening the view's document."};
    const missing = view.missingSelection?.length ?? view.missingSelectionCount ?? 0, filter = view.filter?.status;
    if (filter && filter !== "complete") return {tone: "warning", label: "Filter incomplete", text: "The saved filter couldn't finish, so nothing is dimmed."};
    if (missing) return {tone: "warning", label: missing + " missing", text: missing + (missing === 1 ? " highlighted object is" : " highlighted objects are") + " no longer in the design."};
    return null;
  }
  async function applyView(id) {
    views.current = id; schedule();
    try {
      const r = await write("butter.savedViews.apply", {id});
      const p = viewProblem(r);
      views.notice = p?.tone ? {tone: p.tone, title: p.label + ".", text: p.text} : null;
    } catch (error) { views.notice = {tone: "danger", text: error.message}; }
    schedule();
  }
  async function presentViews(fromId) {
    const ids = views.selected.size > 1 ? views.rows.filter(v => views.selected.has(v.id)).map(v => v.id) : undefined;
    const list = ids || views.rows.map(v => v.id), index = Math.max(0, fromId ? list.indexOf(fromId) : 0);
    let deck;
    const render = r => {
      views.current = r.current?.id || views.current;
      deck?.update({index: r.index ?? 0, total: r.total ?? 0, title: r.current?.name || "", problem: viewProblem(r.view || r.current),
        next: r.next?.name});
      schedule();
    };
    try {
      deck = await F().present({kind: "views", unit: "view", label: "Saved views presentation",
        step: async to => { try { render(await write("butter.savedViews.step", {index: to})); } catch (error) { toast(error.message, "error"); } },
        resume: async () => { if (views.current) { await write("butter.savedViews.apply", {id: views.current}); deck.unmoved(); } },
        end: () => schedule()});
      render(await write("butter.savedViews.present", {...(ids ? {ids} : {}), index}));
    } catch (error) { deck?.end("error"); showNotice(views, {tone: "danger", text: error.message}); }
  }
  async function exportViews() {
    await paintViews();
    const ids = views.selected.size > 1 ? views.rows.filter(v => views.selected.has(v.id)).map(v => v.id) : views.rows.map(v => v.id);
    if (!ids.length) return;
    views.notice = null; ui.views.notice();
    const bar = busyLine(ui.views.pane, views, "Exporting " + ids.length + (ids.length === 1 ? " view" : " views"));
    ui.views.exportPdf.disabled = true;
    try {
      const plan = (await G.AtriumButter.run("butter.savedViews.export-pdf", {ids}, {mode: "plan"})).result;
      bar.set(null, "Preparing " + plan.pageCount + (plan.pageCount === 1 ? " page" : " pages"));
      const r = await write("butter.savedViews.export-pdf", {ids});
      const notes = r.notes || [];
      toast("Exported " + (r.name || plan.name) + " · " + (r.pageCount ?? plan.pageCount) + " pages", "ok");
      views.notice = notes.length ? {tone: "warning", title: "Exported with gaps.", text: notes.join(" ")} : null;
    } catch (error) {
      views.notice = {tone: "danger", title: "Not exported.", text: error.message};
    } finally { bar.remove(); views.busy = null; ui.views.exportPdf.disabled = false; schedule(); }
  }

  // ------------------------------------------------------------------ slides
  function buildSlides() {
    const pane = K.el("div", "docs-pane"); pane.dataset.pane = "slides";
    const add = K.button("Add slide…", {variant: "quiet", size: "sm", run: () => void addMenu(add)});
    add.setAttribute("aria-haspopup", "menu");
    const present = K.button("Present", {variant: "quiet", size: "sm", run: () => void presentSlides()});
    const exportPdf = K.button("Export PDF…", {variant: "quiet", size: "sm", run: () => void exportSlides()});
    const bar = K.toolbar([add, "->", present, exportPdf], {label: "Slides"});
    const notice = noticeSlot(slides);
    const strip = F().strip(K, {label: "Slides", ratio: "16 / 9", orientation: "row", onPick: (id, how) => pickSlide(id, how), onKey: slideKeys});
    const detail = K.el("div", "docs-detail");
    const status = K.statusLine("");
    const empty = K.el("div", "docs-empty-slot");
    pane.append(bar, notice.slot, strip.node, empty, detail, status);
    strip.node.addEventListener("pointerdown", dragStart);
    return {pane, add, present, exportPdf, strip, detail, status, empty, notice: notice.paint};
  }
  function frameChoices() {
    const d = host.doc?.(), S = G.AtriumSchObjects;
    if (d?.kind !== "schematic" || !Array.isArray(d.items) || !S) return [];
    return d.items.filter(i => S.isFrame(i)).map((f, i) => ({documentId: d.id, frameId: f.id, name: f.title || f.name || f.text || "Frame " + (i + 1), docName: d.name}));
  }
  function addEntries(apply) {
    const frames = frameChoices(), saved = host.project().savedViews || [];
    return [
      ...(frames.length ? frames.map(f => ({label: "Frame · " + f.name, run: () => apply({name: f.name, source: {kind: "frame", documentId: f.documentId, frameId: f.frameId}})}))
        : [{label: "No frames on this sheet", enabled: false}]),
      "-",
      saved.length ? {label: "Saved view", items: saved.slice(0, 40).map(v => ({label: v.name, run: () => apply({name: v.name, source: {kind: "savedView", savedViewId: v.id}})}))}
        : {label: enabled("savedViews") ? "No saved views yet" : "Saved views are off", enabled: false}
    ];
  }
  async function addMenu(anchor) {
    const M = await G.AtriumLazy.need("AtriumContextMenu");
    M.dropdown(anchor, menu(addEntries(spec => void addSlide(spec))));
  }
  async function addSlide({name, source}) {
    try {
      const r = await write("butter.slides.add", {name: String(name).slice(0, 200) || "Slide", source});
      slides.current = r.slide.id; choose("slides");
      ui.slides.strip.select(r.slide.id);
    } catch (error) { showNotice(slides, {tone: "danger", text: error.message}); }
  }
  async function paintSlides() {
    const r = await read("butter.slides.list", {offset: 0, limit: 128});
    // The list reports document state; a removed frame or view shows only once its document is read.
    slides.rows = r.slides.map(x => ({...x, status: localStatus(x)})); slides.total = r.total;
    if (!slides.rows.some(s => s.id === slides.current)) slides.current = slides.rows[0]?.id || null;
    const {strip, detail, status, present, exportPdf, empty} = ui.slides;
    const project = host.project();
    strip.update(slides.rows.map((s, i) => ({
      id: s.id, label: (i + 1) + "  " + s.name, title: s.name + " · " + statusText(s), version: s.documentId + s.aspect + s.status + JSON.stringify(s.source) + (host.revision?.() ?? ""),
      ratio: s.aspect === "4:3" ? "4 / 3" : "16 / 9",
      state: s.status.startsWith("missing") || s.status === "invalid-frame" ? "failed" : s.status === "loading-document" ? "pending" : undefined,
      draw: s.status === "ready" ? (canvas => drawSlide(project, s, canvas)) : null,
      menu: (e, node) => { e.preventDefault(); slides.current = s.id; strip.select(s.id); void slideMenu(s, e.clientX, e.clientY, node); }
    })), slides.current);
    strip.node.hidden = !slides.total;
    empty.replaceChildren(...(slides.total ? [] : [emptySlides()])); empty.hidden = !!slides.total;
    present.disabled = exportPdf.disabled = !slides.total;
    status.querySelector(".ui-status-text").textContent = slides.total ? slides.total + (slides.total === 1 ? " slide" : " slides") + (slides.total >= 120 ? " of 128" : "") : "";
    paintDetail();
    ui.slides.notice();
  }
  function emptySlides() {
    const frames = frameChoices(), saved = host.project().savedViews || [];
    const actions = [];
    if (frames.length) actions.push(K.button("Add current frame", {run: () => void addSlide({name: frames[0].name, source: {kind: "frame", documentId: frames[0].documentId, frameId: frames[0].frameId}})}));
    if (saved.length) { const b = K.button("Add saved view…", {variant: frames.length ? "quiet" : "secondary"}); b.onclick = () => void G.AtriumLazy.need("AtriumContextMenu").then(M => M.dropdown(b, menu(addEntries(spec => void addSlide(spec)).slice(-1)[0].items))); actions.push(b); }
    return K.empty({title: "No slides", text: frames.length || saved.length ? "Each slide shows a schematic frame or a saved view. Present them in order or export them as one PDF."
      : "Draw a frame on a schematic sheet, or save a view, then add it here as the first slide.", actions});
  }
  function localStatus(s) {
    if (s.status !== "ready") return s.status;
    if (s.source.kind === "savedView") return (host.project().savedViews || []).some(v => v.id === s.source.savedViewId) ? "ready" : "missing-view";
    const d = docOf(s.documentId);
    return !Array.isArray(d?.items) || d.items.some(i => i.id === s.source.frameId) ? "ready" : "missing-frame";
  }
  function statusText(s) {
    return {ready: "Ready", "loading-document": "Document loading", "missing-document": "Document missing", "missing-view": "Saved view removed",
      "missing-frame": "Frame removed", "invalid-frame": "Frame has no area"}[s.status] || s.status;
  }
  function drawSlide(project, s, canvas) {
    const d = docOf(s.documentId);
    if (!d?.items) return;
    let bounds;
    if (s.source.kind === "frame") {
      const f = d.items.find(i => i.id === s.source.frameId);
      if (!f) return;
      bounds = G.AtriumSchObjects?.frameBounds?.(f) || [f.x, f.y, f.x + f.w, f.y + f.h];
    } else {
      const v = (project.savedViews || []).find(x => x.id === s.source.savedViewId);
      if (!v) return;
      bounds = F().cameraBounds(v.camera, v.viewport);
    }
    F().drawRegion(canvas, d, host.defs?.(), bounds);
  }
  function paintDetail() {
    const box = ui.slides.detail, s = slides.rows.find(x => x.id === slides.current), raw = (host.project().slides || []).find(x => x.id === slides.current);
    if (!s || !raw) { box.replaceChildren(); box.hidden = true; return; }
    box.hidden = false;
    if (box.dataset.id === s.id && box.contains(document.activeElement)) return;
    box.dataset.id = s.id;
    const index = slides.rows.indexOf(s);
    const title = K.field({value: raw.name, label: "Slide title"});
    const commit = (field, key) => { const value = field.value.trim(); if (key === "name" && !value) { field.value = raw.name; return; } if (value !== String(raw[key] ?? "").trim()) void updateSlide(s.id, {[key]: key === "notes" ? field.value : value}); };
    title.addEventListener("change", () => commit(title, "name"));
    title.addEventListener("keydown", e => { if (e.key === "Enter") title.blur(); });
    const aspect = K.segmented([["16:9", "16:9"], ["4:3", "4:3"]], {value: raw.aspect, label: "Aspect", size: "sm", onChange: v => void updateSlide(s.id, {aspect: v})});
    const notes = K.el("textarea", "ui-field"); notes.rows = 4; notes.value = raw.notes || ""; notes.setAttribute("aria-label", "Speaker notes");
    notes.placeholder = "What to say on this slide";
    notes.addEventListener("change", () => commit(notes, "notes"));
    const view = s.source.kind === "savedView" ? (host.project().savedViews || []).find(v => v.id === s.source.savedViewId) : null;
    const d = docOf(s.documentId);
    const frame = s.source.kind === "frame" ? d?.items?.find(i => i.id === s.source.frameId) : null;
    const sourceTitle = s.source.kind === "frame" ? "Frame" + (frame ? " · " + (frame.title || frame.name || frame.text || "untitled") : "") : "Saved view" + (view ? " · " + view.name : "");
    const change = K.button("Change…", {variant: "quiet", size: "sm"});
    change.onclick = () => void G.AtriumLazy.need("AtriumContextMenu").then(M => M.dropdown(change, menu(addEntries(spec => void updateSlide(s.id, {source: spec.source})))));
    const problem = s.status !== "ready" && s.status !== "loading-document";
    const source = K.row({title: sourceTitle, detail: d?.name || (problem ? statusText(s) : ""), icon: KIND_ICON[d?.kind] || "dview",
      state: problem ? "broken" : s.status === "loading-document" ? "pending" : undefined, role: null, actions: [change], reveal: false});
    const remove = K.iconButton("delete", "Remove slide", {size: "sm", run: () => void removeSlide(s.id)});
    const go = K.button("Show", {variant: "quiet", size: "sm", run: () => void showSlide(s.id)});
    box.replaceChildren(K.section("Slide " + (index + 1) + " of " + slides.total, {actions: [go, remove], quiet: true},
      ...(problem ? [K.notice({tone: "danger", title: statusText(s) + ".", text: s.status === "loading-document" ? "" : "Choose another source to keep this slide.", actions: [K.button("Change source…", {size: "sm", run: () => change.click()})]})] : []),
      K.propRow("Title", title), K.propRow("Aspect", aspect), K.propRow("Source", source, {stacked: true}), K.propRow("Notes", notes, {stacked: true})));
  }
  async function updateSlide(id, changes) {
    try { await write("butter.slides.update", {id, ...changes}); }
    catch (error) { showNotice(slides, {tone: "danger", text: error.message}); }
    ui.slides.detail.dataset.id = ""; schedule();
  }
  async function removeSlide(id) {
    const name = slides.rows.find(s => s.id === id)?.name, at = slides.rows.findIndex(s => s.id === id);
    try {
      await write("butter.slides.remove", {id});
      slides.current = slides.rows[at + 1]?.id || slides.rows[at - 1]?.id || null;
      toast("Removed slide “" + name + "”. Undo brings it back.");
    } catch (error) { showNotice(slides, {tone: "danger", text: error.message}); }
  }
  async function reorderSlides(ids) {
    try { await write("butter.slides.reorder", {ids}); } catch (error) { showNotice(slides, {tone: "danger", text: error.message}); }
  }
  function move(id, delta) {
    const ids = slides.rows.map(s => s.id), at = ids.indexOf(id), to = at + delta;
    if (at < 0 || to < 0 || to >= ids.length) return;
    ids.splice(at, 1); ids.splice(to, 0, id);
    void reorderSlides(ids);
  }
  function slideKeys(e) {
    if (!slides.current) return false;
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); move(slides.current, e.key === "ArrowLeft" ? -1 : 1); return true; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); void removeSlide(slides.current); return true; }
    if (e.key === "F5" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); void presentSlides(slides.current); return true; }
    return false;
  }
  async function slideMenu(s, x, y, anchor) {
    const M = await G.AtriumLazy.need("AtriumContextMenu"), at = slides.rows.indexOf(s);
    M.popup({host}, menu([
      {label: "Show slide", run: () => showSlide(s.id), enabled: s.status === "ready"},
      {label: "Present from here", run: () => presentSlides(s.id)},
      "-",
      {label: "Move earlier", run: () => move(s.id, -1), enabled: at > 0, shortcut: "Alt+ArrowLeft"},
      {label: "Move later", run: () => move(s.id, 1), enabled: at < slides.rows.length - 1, shortcut: "Alt+ArrowRight"},
      "-",
      {label: "Remove", run: () => removeSlide(s.id)}
    ]), s.name, x, y, anchor, {pointer: true});
  }
  function pickSlide(id) { slides.current = id; ui.slides.strip.select(id, {reveal: true}); ui.slides.detail.dataset.id = ""; paintDetail(); }
  async function showSlide(id) {
    try {
      const r = await write("butter.slides.apply", {id});
      const p = slideProblem(r);
      slides.notice = p?.tone ? {tone: p.tone, title: p.label + ".", text: p.text} : null;
    } catch (error) { slides.notice = {tone: "danger", text: error.message}; }
    schedule();
  }
  function slideProblem(r) {
    const s = r?.view || r?.current || r;
    if (!s) return null;
    if (s.status === "missing-frame" || s.status === "invalid-frame") return {tone: "danger", label: "Frame removed", text: "Its frame is no longer on the sheet. Change the slide's source to keep it."};
    if (s.status === "missing-view") return {tone: "danger", label: "View removed", text: "Its saved view was removed. Change the slide's source to keep it."};
    return viewProblem(s);
  }
  function presenterBlock() {
    if (G.AtriumPrefs?.get("butter.windows") !== true) return "Turn on Project windows in Experimental features to use a second window";
    if (!host.folderProject?.()) return "Save the project as a folder to use a second window";
    return "";
  }
  async function presentSlides(fromId) {
    const index = Math.max(0, fromId ? slides.rows.findIndex(s => s.id === fromId) : 0);
    let deck, startedAt = Date.now(), at = index;
    const render = r => {
      if (!r || r.status === "empty" || r.status === "inactive") return;
      slides.current = r.current?.id || slides.current; at = r.index ?? at;
      deck?.update({index: r.index ?? 0, total: r.total ?? 0, title: r.current?.name || "", notes: r.notes, next: r.next?.name,
        problem: slideProblem(r.view ? {...r.view, status: r.view.status || r.status} : r.current), startedAt,
        presenterUnavailable: presenterBlock()});
      ui.slides.strip.select(slides.current);
    };
    try {
      deck = await F().present({kind: "slides", unit: "slide", label: "Slide presentation", notes: true,
        step: async to => { try { render(await write("butter.slides.step", {index: to})); } catch (error) { toast(error.message, "error"); } },
        resume: async () => { try { render(await write("butter.slides.resume", {})); deck.unmoved(); } catch (error) { toast(error.message, "error"); } },
        presenterWindow: async () => {
          try {
            const r = await write("butter.slides.start", {index: at, presenter: true});
            const w = r.presenterWindow;
            if (w?.status === "open") toast("Presenter window is open."); else toast("The second window isn't available. Notes stay in this window.", "warn");
          } catch (error) { toast(error.message, "error"); }
        },
        end: async reason => {
          if (reason === "replaced") return;
          try {
            const r = await write("butter.slides.stop", {});
            if (r.status === "partial") toast("Ended. The previous view couldn't be fully restored.", "warn");
          } catch (error) { toast(error.message, "error"); }
          schedule();
        }});
      const r = await write("butter.slides.start", {index});
      startedAt = Date.now() - (r.elapsedMs || 0);
      render(r);
    } catch (error) { deck?.end("error"); showNotice(slides, {tone: "danger", text: error.message}); }
  }
  async function exportSlides() {
    const total = slides.total;
    if (!total) return;
    slides.notice = null; ui.slides.notice();
    const bar = busyLine(ui.slides.pane, slides, "Exporting " + total + (total === 1 ? " slide" : " slides"));
    ui.slides.exportPdf.disabled = true;
    try {
      const r = await write("butter.slides.export-pdf", {});
      toast("Exported " + r.name + " · " + r.pageCount + (r.pageCount === 1 ? " page" : " pages"), "ok");
      slides.notice = r.notes?.length ? {tone: "warning", title: "Exported with gaps.", text: r.notes.join(" ")} : null;
    } catch (error) { slides.notice = {tone: "danger", title: "Not exported.", text: error.message}; }
    finally { bar.remove(); slides.busy = null; ui.slides.exportPdf.disabled = false; schedule(); }
  }
  // Drag a slide along the strip to reorder (mouse and pen). On touch, a long press opens Move earlier and Move later.
  function dragStart(e) {
    const tile = e.target.closest(".ui-thumb");
    if (!tile || e.button || e.pointerType === "touch") return;
    const id = tile.dataset.id, startX = e.clientX, strip = ui.slides.strip.node;
    let line = null, target = -1, dragging = false;
    const move = ev => {
      if (!dragging && Math.abs(ev.clientX - startX) < 6) return;
      dragging = true; tile.classList.add("ui-drag-lift");
      const tiles = [...strip.querySelectorAll(".ui-thumb")];
      target = tiles.findIndex(t => { const r = t.getBoundingClientRect(); return ev.clientX < r.left + r.width / 2; });
      if (target < 0) target = tiles.length;
      line ||= K.el("div", "ui-drop-line");
      tiles[target] ? tiles[target].before(line) : strip.append(line);
    };
    const up = () => {
      removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up);
      tile.classList.remove("ui-drag-lift"); line?.remove();
      if (!dragging) return;
      const ids = slides.rows.map(s => s.id), from = ids.indexOf(id);
      if (target < 0 || target === from || target === from + 1) return;
      ids.splice(from, 1); ids.splice(target > from ? target - 1 : target, 0, id);
      tile.addEventListener("click", ev => ev.stopPropagation(), {capture: true, once: true});
      void reorderSlides(ids);
    };
    addEventListener("pointermove", move); addEventListener("pointerup", up); addEventListener("pointercancel", up);
  }

  // A flag turned off closes its tab and any presentation of it.
  G.AtriumPrefs?.on?.("butter.", ({key}) => {
    if (key !== "butter.savedViews" && key !== "butter.slides") return;
    const deck = F()?.active?.();
    if (deck && !enabled(deck.kind === "views" ? "savedViews" : "slides")) deck.end("disabled");
    if (panel) { if (!enabled("savedViews") && !enabled("slides")) close(); else schedule(); }
  });
  return Object.freeze({open, close, toggle, isOpen: () => !!panel && !panel.hidden, captureView, presentSlides, presentViews});
})();
