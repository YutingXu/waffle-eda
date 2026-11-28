"use strict";
// Datasheet reader: a dock panel with the documents family's page
// strip, pager and status line. It renders only the pages and thumbnails in view, through two readers
// on one shared worker (pages and strip never cancel each other). Lazy, behind butter.datasheets.
globalThis.AtriumDatasheetReader = (() => {
  const G = globalThis, D = () => G.AtriumDatasheets, F = () => G.AtriumDocsFamily;
  const enabled = () => G.AtriumButter?.state("datasheets")?.enabled === true;
  const ZOOMS = [["fit", "Fit width"], ["0.5", "50 %"], ["0.75", "75 %"], ["1", "100 %"], ["1.5", "150 %"], ["2", "200 %"]];
  let K, host, panel, ui = {}, frame = 0;
  // The open document: ref, page count, page aspect, current page, rendered page cache, readers.
  let open_ = null;

  async function ensure() {
    if (!enabled()) return false;
    K = await G.AtriumLazy.need("AtriumUIKit");
    host = G.AtriumNavHost;
    if (!panel) build();
    panel.hidden = false;
    return true;
  }
  async function toggle() { if (panel && !panel.hidden) close(); else { await ensure(); paint(); } }
  function close() { if (panel) panel.hidden = true; release(); }

  function build() {
    panel = K.el("section", "panel panel-datasheet docs-panel"); panel.hidden = true;
    panel.setAttribute("aria-labelledby", "datasheet-heading");
    const head = K.el("header", "pane-heading"), h2 = K.el("h2", null, "Datasheet"); h2.id = "datasheet-heading";
    head.append(h2, K.closeButton(close, "Close Datasheet"));
    const pane = K.el("div", "docs-pane");
    const pager = K.pager({unit: "page", label: "Pages", onStep: d => step(d)});
    const zoom = K.select(ZOOMS, {value: "fit", label: "Zoom", onChange: v => setZoom(v)});
    zoom.classList.add("docs-zoom");
    const find = K.iconButton("search", "Find in datasheet", {pressed: false, run: () => toggleFind()});
    find.dataset.tooltipShortcut = "Mod+F";
    const snip = K.button("Snip", {variant: "quiet", size: "sm", pressed: false, run: () => toggleSnip()});
    snip.title = "Drag over a page to copy a region with its page link";
    const more = K.button("More…", {variant: "quiet", size: "sm"});
    more.setAttribute("aria-haspopup", "menu");
    more.onclick = () => void G.AtriumLazy.need("AtriumContextMenu").then(M => M.dropdown(more, menuEntries().map(e => e === "-" ? e : {...e, enabled: e.enabled ?? true})));
    // Tools on top; the pager sits with the status line at the foot, as in a page viewer.
    const bar = K.toolbar([zoom, "->", find, snip, more], {label: "Datasheet"});
    const findRow = K.el("div", "docs-find");
    const search = K.search({placeholder: "Find text", label: "Find in datasheet", onInput: v => findText(v)});
    const matches = K.pager({unit: "match", label: "Matches", onStep: d => stepMatch(d)});
    findRow.append(search, matches); findRow.hidden = true;
    search.input.addEventListener("keydown", e => {
      if (e.defaultPrevented || e.isComposing) return;
      if (e.key === "Enter") { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape" && !search.input.value) toggleFind(false);
    });
    const notice = K.el("div", "docs-notice-slot");
    const reader = K.el("div", "docs-reader");
    const strip = F().strip(K, {label: "Pages", ratio: "1 / 1.294", onPick: n => goTo(Number(n), true)});
    const pages = K.el("div", "docs-pages"); pages.tabIndex = 0; pages.setAttribute("role", "document"); pages.setAttribute("aria-label", "Datasheet pages");
    reader.append(strip.node, K.splitter({label: "Resize page strip", onResize: d => { const w = Math.max(56, Math.min(200, strip.node.getBoundingClientRect().width + d)); reader.style.setProperty("--docs-rail", w + "px"); }}), pages);
    const library = K.el("div", "docs-scroll");
    const status = K.statusLine("");
    const foot = K.el("div", "docs-foot"); foot.append(pager, status);
    pane.append(bar, findRow, notice, reader, library, foot);
    panel.append(head, pane);
    (document.getElementById("properties") || document.body).append(panel);
    const spec = {id: "datasheet", title: "Datasheet", element: panel, area: "right", action: "datasheet-reader"};
    if (G.AtriumDock?.register) G.AtriumDock.register(spec); else (G.AtriumDockPending ||= []).push(spec);
    ui = {pane, bar, pager, zoom, find, snip, more, findRow, search, matches, notice, reader, strip, pages, library, status};
    pages.addEventListener("scroll", () => schedule(), {passive: true});
    pages.addEventListener("keydown", pageKeys);
    panel.addEventListener("keydown", e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") { e.preventDefault(); toggleFind(true); } });
    new ResizeObserver(() => { if (open_) { relayout(); schedule(); } }).observe(pages);
    host.on?.("change", () => { if (!panel.hidden && !open_) paint(); });
  }

  // ------------------------------------------------------------------ library (nothing open)
  const refs = () => host.project().datasheets || [];
  function paint() {
    if (!panel || panel.hidden) return;
    const has = !!open_;
    ui.reader.hidden = !has; ui.library.hidden = has; ui.bar.hidden = !has; ui.pager.hidden = !has; ui.findRow.hidden = !has || ui.find.getAttribute("aria-pressed") !== "true";
    if (has) return;
    setNotice(null);
    const list = refs();
    const openPdf = K.button("Open PDF…", {variant: list.length ? "quiet" : "secondary", run: () => void choose()});
    if (!list.length) {
      ui.library.replaceChildren(K.empty({title: "No datasheets", text: "Open a supplier PDF to add it to this project, or follow a part's datasheet link from its Properties.", actions: [openPdf]}));
    } else {
      const rows = list.map(r => {
        const row = K.row({title: r.title || "Datasheet", detail: [r.version && "Rev " + r.version, r.pageCount && r.pageCount + " pages", r.asset ? "Embedded" : "Local copy"].filter(Boolean).join(" · "),
          icon: "book", meta: r.asset ? K.badge("Embedded") : undefined});
        row.tabIndex = 0; row.dataset.id = r.id;
        row.addEventListener("click", () => void show(r.id));
        row.addEventListener("keydown", e => { if (e.key === "Enter") void show(r.id); });
        return row;
      });
      ui.library.replaceChildren(K.section("In this project", {actions: [openPdf]}, K.list(rows, {label: "Datasheets"})));
    }
    status("");
  }
  function status(text, busy) {
    const s = ui.status, t = s.querySelector(".ui-status-text");
    const spinner = s.querySelector(".ui-spinner");
    if (!busy) spinner?.remove();
    else if (!spinner) s.prepend(K.spinner({size: "sm", label: text}));
    else if (spinner.getAttribute("aria-label") !== text) spinner.setAttribute("aria-label", text);
    if (t.textContent !== text) t.textContent = text;
  }
  function setNotice(spec) {
    ui.notice.replaceChildren(...(spec ? [K.notice({live: true, ...spec})] : []));
    ui.notice.hidden = !spec;
  }

  // ------------------------------------------------------------------ opening
  /** Open a project datasheet reference at a 1-based page. */
  async function show(id, page = 1) {
    if (!await ensure()) return false;
    const ref = refs().find(r => r.id === id);
    if (!ref) { setNotice({tone: "danger", title: "Unavailable.", text: "This datasheet is no longer in the project."}); paint(); return false; }
    release();
    const project = host.project();
    const load = D().loadFor(project.id), current = () => enabled() && host.project() === project && !panel.hidden;
    const pagesReader = D().createReader(ref, {load, current}), thumbsReader = D().createReader(ref, {load, current});
    open_ = {ref, project, pagesReader, thumbsReader, pages: 0, page, aspect: 1.294, zoom: ui.zoom.value,
      cache: new Map(), failed: new Set(), matches: [], match: -1};
    const mine = open_;
    panel.querySelector("h2").textContent = ref.title || "Datasheet";
    paint();
    setNotice(null);
    status("Opening " + (ref.title || "datasheet") + "…", true);
    ui.pages.replaceChildren(...Array.from({length: 3}, () => K.el("div", "ui-skeleton docs-page")));
    try {
      const info = await pagesReader.info();
      if (open_ !== mine) return false;
      mine.pages = info.pages;
      mine.aspect = info.aspect || mine.aspect;
      layout(); goTo(page);
      status(statusText());
      if (!ui.findRow.hidden && ui.search.input.value) findText(ui.search.input.value);
      return true;
    } catch (error) {
      if (open_ !== mine) return false;
      failOpen(error);
      return false;
    }
  }
  function statusText() {
    const o = open_;
    return [o.pages + (o.pages === 1 ? " page" : " pages"), o.ref.version && "Rev " + o.ref.version, o.ref.asset ? "Embedded in project" : "Local copy"].filter(Boolean).join(" · ");
  }
  function failOpen(error) {
    const o = open_, code = error?.code, ref = o?.ref;
    ui.pages.replaceChildren();
    ui.strip.update([]);
    status("");
    const pick = K.button("Select PDF…", {size: "sm", run: () => void choose({expected: ref})});
    const download = ref?.sourceURL ? K.button("Download", {size: "sm", variant: "quiet", run: () => void fetchSource(ref)}) : null;
    const spec = {
      missing_datasheet: {tone: "warning", title: "Not on this computer.", text: "Select the original PDF to verify it" + (ref?.sourceURL ? ", or download it from the supplier." : "."), actions: [pick, ...(download ? [download] : [])]},
      source_changed: {tone: "danger", title: "Different PDF.", text: "The file doesn't match this datasheet's recorded copy. Select the exact original.", actions: [pick]},
      pdf_timeout: {tone: "danger", title: "Took too long.", text: "The PDF reader stopped after 20 seconds.", actions: [K.button("Retry", {size: "sm", run: () => void show(ref.id, o.page)})]},
      pdf_unavailable: {tone: "danger", title: "Reader unavailable.", text: "This computer can't start the PDF reader."},
      cache_unavailable: {tone: "danger", title: "Cache unavailable.", text: error.message, actions: [pick]},
      cancelled: null
    }[code];
    if (spec === null) return;
    const password = /password/i.test(error?.message || "");
    const chosen = password ? {tone: "warning", title: "Password-protected.", text: "Waffle opens unprotected PDFs only. Save an unprotected copy from the supplier's file, then select it.", actions: [pick]}
      : spec || {tone: "danger", title: "Can't open.", text: error?.message || "The PDF couldn't be read.", actions: [pick]};
    // A narrow dock has no room for actions beside the text: the notice states it, the actions follow.
    const {actions = [], ...said} = chosen;
    setNotice(said);
    ui.reader.hidden = ui.pager.hidden = true; ui.library.hidden = false;
    const back = K.button("All datasheets", {size: "sm", variant: "quiet", run: () => { release(); panel.querySelector("h2").textContent = "Datasheet"; paint(); }});
    ui.library.replaceChildren(K.empty({actions: [...actions, back]}));
  }
  function release() {
    if (!open_) return;
    clearMatches(open_);
    ui.search.input.value = "";
    open_.pagesReader.close(); open_.thumbsReader.close();
    for (const p of open_.cache.values()) URL.revokeObjectURL(p.url);
    open_ = null;
    ui.pages.replaceChildren();
    ui.strip?.update([]);
    cancelAnimationFrame(frame); frame = 0;
  }
  /** Open PDF…: a file the user chose becomes a project reference (one Undo step). With expected, the
   *  chosen bytes only verify an existing reference into this user's cache. */
  async function choose({expected} = {}) {
    if (!await ensure()) return;
    const input = Object.assign(document.createElement("input"), {type: "file", accept: "application/pdf,.pdf"});
    input.onchange = async () => {
      const file = input.files?.[0]; if (!file) return;
      status("Reading " + file.name + "…", true);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (expected) {
          const ref = await D().openBytes({bytes, name: file.name});
          if (ref.sha256 !== expected.sha256 || ref.byteLength !== expected.byteLength) throw Object.assign(Error("This PDF differs from the recorded datasheet."), {code: "source_changed"});
          await show(expected.id, open_?.page || 1);
        } else {
          const ref = await D().referenceBytes({bytes, name: file.name});
          await show(ref.id, 1);
          G.AtriumToast?.show("Added “" + (ref.title || file.name) + "” to the project.");
        }
      } catch (error) { status(""); if (open_) failOpen(error); else setNotice({tone: "danger", title: "Not added.", text: error.message}); }
    };
    input.click();
  }
  async function fetchSource(ref) {
    status("Downloading from the supplier…", true);
    try {
      await D().download({url: ref.sourceURL, expected: ref, authorizeURL: url => confirmDownload(url)});
      await show(ref.id, open_?.page || 1);
    } catch (error) {
      status("");
      setNotice(error.code === "consent_required" ? null : {tone: "danger", title: error.code === "source_changed" ? "Different PDF." : "Offline or refused.", text: error.message,
        actions: [K.button("Select PDF…", {size: "sm", run: () => void choose({expected: ref})})]});
    }
  }
  function confirmDownload(url) {
    return new Promise(resolve => {
      const host_ = new URL(url).host;
      G.AtriumShell.dialog({title: "Download datasheet", body: [K.el("p", null, "Download the PDF from " + host_ + "? Waffle sends no cookies or referrer, and checks the file against this datasheet's recorded copy.")],
        actions: [{label: "Cancel", run: () => resolve(false)}, {label: "Download", primary: true, run: () => resolve(true)}], onClose: () => resolve(false)});
    });
  }

  // ------------------------------------------------------------------ pages
  function layout() {
    const o = open_;
    const nodes = document.createDocumentFragment();
    for (let n = 1; n <= o.pages; n++) {
      const p = K.el("div", "docs-page"); p.dataset.page = String(n); p.dataset.state = "pending";
      p.setAttribute("aria-label", "Page " + n);
      nodes.append(p);
    }
    ui.pages.replaceChildren(nodes);
    ui.pages.style.setProperty("--docs-page-ratio", "1 / " + o.aspect);
    ui.strip.node.style.setProperty("--ui-thumb-ratio", "1 / " + o.aspect);
    relayout();
    ui.strip.update(Array.from({length: o.pages}, (_, i) => ({id: String(i + 1), label: String(i + 1), title: "Page " + (i + 1),
      draw: (canvas, signal) => drawThumb(o, i + 1, canvas, signal)})), String(o.page));
  }
  function relayout() {
    const o = open_; if (!o) return;
    const fit = Math.max(120, ui.pages.clientWidth - 24), w = Math.round(o.zoom === "fit" ? fit : fit * Number(o.zoom));
    if (w === o.width) return;
    o.width = w;
    ui.pages.style.setProperty("--docs-page-w", w + "px");
  }
  function schedule() { if (open_ && !frame) frame = requestAnimationFrame(() => { frame = 0; void renderVisible(); }); }
  function inView() {
    const el = ui.pages, nodes = el.children, box = el.getBoundingClientRect(), seen = [];
    // Page slots are ordered. Skip the pages above the viewport without walking the document.
    let low = 0, high = nodes.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (nodes[mid].getBoundingClientRect().bottom < box.top) low = mid + 1;
      else high = mid;
    }
    let best = null, bestArea = 0;
    for (let i = Math.max(0, low - 1); i < nodes.length; i++) {
      const r = nodes[i].getBoundingClientRect(), n = i + 1;
      if (r.top > box.bottom + r.height) break;
      const a = Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top));
      if (seen.length < 6 && r.bottom >= box.top - r.height) seen.push(n);
      if (a > bestArea) { bestArea = a; best = n; }
    }
    // At either end of the scroll the end page is current, even when a neighbour shows more of itself.
    if (el.scrollTop <= 0) best = 1;
    else if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) best = nodes.length;
    return {seen, best};
  }
  async function renderVisible() {
    const o = open_; if (!o || !o.pages) return;
    const {seen, best} = inView();
    const scrollTop = ui.pages.scrollTop;
    if (scrollTop !== o.scrollTop && best && best !== o.page) selectPage(o, best);
    o.scrollTop = scrollTop;
    const side = Math.min(4096, Math.round(Math.min(2400, o.width * Math.min(2, G.devicePixelRatio || 1)) * Math.max(1, o.aspect)));
    for (const [n, entry] of o.cache) if (Math.abs(n - o.page) > 12 && !seen.includes(n)) {
      URL.revokeObjectURL(entry.url); o.cache.delete(n);
      const node = pageNode(n); node.replaceChildren(); node.dataset.state = "pending";
    }
    const n = [o.page, ...seen].find(n => !o.failed.has(n) && (o.cache.get(n)?.side || 0) < side * .9);
    if (o.render?.page === n && o.render?.side >= side * .9) return;
    if (!n) {
      if (o.render) { o.render = null; await o.pagesReader.visible([]); }
      return;
    }
    const render = o.render = {page: n, side};
    let continueRendering = false;
    try {
      const {pages} = await o.pagesReader.visible([n], {side});
      if (open_ === o && o.render === render) { place(o, pages, side); continueRendering = true; }
    } catch (error) {
      if (open_ !== o || o.render !== render || error?.name === "AbortError" || error?.code === "cancelled") return;
      // Keep an existing image and let the next viewport change retry its resolution upgrade.
      if (o.cache.has(n)) return;
      o.failed.add(n);
      markFailed(n, error);
      continueRendering = true;
    } finally {
      if (open_ === o && o.render === render) { o.render = null; if (continueRendering) schedule(); }
    }
  }
  const pageNode = n => ui.pages.children[n - 1];
  function place(o, rendered, side) {
    for (const r of rendered) {
      const url = URL.createObjectURL(new Blob([r.png], {type: "image/png"}));
      const old = o.cache.get(r.page); if (old) URL.revokeObjectURL(old.url);
      o.cache.set(r.page, {url, side});
      const node = pageNode(r.page); if (!node) continue;
      const img = new Image(); img.alt = "Page " + r.page; img.src = url; img.draggable = false;
      node.replaceChildren(img); delete node.dataset.state;
    }
  }
  function markFailed(n, error) {
    const node = pageNode(n); if (!node) return;
    node.dataset.state = "failed";
    node.replaceChildren(K.empty({text: "Page " + n + " couldn't be drawn.", actions: [K.button("Retry", {size: "sm", run: () => { open_?.failed.delete(n); node.dataset.state = "pending"; node.replaceChildren(); schedule(); }})]}));
    const t = ui.strip.tile(String(n)); if (t) t.dataset.state = "failed";
    node.title = error?.message || "";
  }
  async function drawThumb(o, n, canvas, signal) {
    if (open_ !== o) return;
    const r = await o.thumbsReader.visible([n], {side: 160, signal});
    const page = r.pages[0]; if (!page || signal.aborted) return;
    const bitmap = await createImageBitmap(new Blob([page.png], {type: "image/png"}));
    if (!signal.aborted) {
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      canvas.dataset.ready = "true";
    }
    bitmap.close?.();
  }
  function selectPage(o, n) {
    o.page = n; ui.pager.set(n - 1, o.pages); ui.strip.select(String(n));
  }
  function goTo(n, manual = false) {
    const o = open_; if (!o || !o.pages) return;
    n = Math.max(1, Math.min(o.pages, n));
    selectPage(o, n);
    const behavior = manual && G.AtriumMotionUI?.moves() ? "smooth" : "instant";
    pageNode(n)?.scrollIntoView({block: "start", behavior});
    o.scrollTop = ui.pages.scrollTop;
    schedule();
  }
  function step(d) { const o = open_; if (o) goTo(d === -Infinity ? 1 : d === Infinity ? o.pages : o.page + d, true); }
  function setZoom(v) { const o = open_; if (!o) return; o.zoom = v; relayout(); goTo(o.page); }
  function pageKeys(e) {
    if (e.target !== ui.pages) return;
    const map = {PageDown: 1, PageUp: -1, Home: -Infinity, End: Infinity};
    if (map[e.key] != null && !e.shiftKey) { e.preventDefault(); step(map[e.key]); }
    else if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "-" || e.key === "0")) {
      e.preventDefault();
      const levels = ZOOMS.map(z => z[0]), at = levels.indexOf(open_.zoom);
      const next = e.key === "0" ? "fit" : levels[Math.max(1, Math.min(levels.length - 1, (at < 1 ? 3 : at) + (e.key === "=" ? 1 : -1)))];
      ui.zoom.value = next; setZoom(next);
    }
  }

  // ------------------------------------------------------------------ find
  function toggleFind(on = ui.findRow.hidden) {
    const wasHidden = ui.findRow.hidden;
    ui.findRow.hidden = !on; ui.find.setAttribute("aria-pressed", String(on));
    if (on) {
      ui.search.input.focus();
      if (wasHidden && ui.search.input.value) findText(ui.search.input.value);
    } else {
      ui.pages.focus();
      if (open_) { clearMatches(open_); if (open_.pages) status(statusText()); }
    }
  }
  function clearMatches(o) {
    o.search?.abort();
    o.matches = []; o.match = -1; ui.matches.set(0, 0); ui.search.setCount("");
  }
  function findText(text) {
    const o = open_; if (!o) return;
    clearMatches(o);
    if (!o.pages) return;
    const query = text.trim();
    if (!query) { status(statusText()); return; }
    const search = o.search = new AbortController();
    ui.search.setCount("…");
    void runSearch(o, query, search.signal);
  }
  async function runSearch(o, query, signal) {
    try {
      for (let start = 1; start && !signal.aborted;) {
        status("Searching page " + start + " of " + o.pages + "…", true);
        // Yield the shared worker between batches so a jump or snip can get a turn.
        const r = await o.pagesReader.search({query, start, maxPages: 8, signal});
        if (signal.aborted) return;
        start = r.nextPage;
        if (!r.matches.length) continue;
        o.matches.push(...r.matches);
        if (o.match < 0) { o.match = 0; goTo(o.matches[0].page); }
        ui.search.setCount(o.matches.length);
        ui.matches.set(o.match, o.matches.length);
      }
      if (signal.aborted) return;
      if (!o.matches.length) ui.search.setCount("0");
      status(o.matches.length ? statusText() : "No matches for “" + query + "”");
    } catch (error) {
      if (!signal.aborted && error?.name !== "AbortError") status(error.message);
    }
  }
  function stepMatch(d) {
    const o = open_; if (!o?.matches.length) return;
    o.match = d === -Infinity ? 0 : d === Infinity ? o.matches.length - 1 : (o.match + d + o.matches.length) % o.matches.length;
    ui.matches.set(o.match, o.matches.length); goTo(o.matches[o.match].page);
  }

  // ------------------------------------------------------------------ snip
  function toggleSnip(on = ui.snip.getAttribute("aria-pressed") !== "true") {
    ui.snip.setAttribute("aria-pressed", String(on));
    ui.pages.dataset.snip = on ? "true" : "";
    status(on ? "Drag over a page to snip a region. Esc cancels." : open_ ? statusText() : "");
  }
  function snipStart(e) {
    if (ui.pages.dataset.snip !== "true" || e.button) return;
    const page = e.target.closest(".docs-page"); if (!page || page.dataset.state) return;
    e.preventDefault();
    const box = page.getBoundingClientRect(), x0 = e.clientX - box.left, y0 = e.clientY - box.top;
    const mark = K.el("div", "docs-snip-mark"); page.append(mark);
    const at = ev => [Math.max(0, Math.min(box.width, ev.clientX - box.left)), Math.max(0, Math.min(box.height, ev.clientY - box.top))];
    const move = ev => { const [x, y] = at(ev); Object.assign(mark.style, {left: Math.min(x, x0) + "px", top: Math.min(y, y0) + "px", width: Math.abs(x - x0) + "px", height: Math.abs(y - y0) + "px"}); };
    const up = ev => {
      removeEventListener("pointermove", move); removeEventListener("pointerup", up);
      const [x, y] = at(ev);
      if (Math.abs(x - x0) < 8 || Math.abs(y - y0) < 8) { mark.remove(); return; }
      const region = [Math.min(x, x0) / box.width, Math.min(y, y0) / box.height, Math.max(x, x0) / box.width, Math.max(y, y0) / box.height].map(v => Math.round(v * 1e6));
      void snipPreview(Number(page.dataset.page), region, mark);
    };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  }
  async function snipPreview(page, region, mark) {
    const o = open_; if (!o) return;
    const card = K.el("div", "ui-popover docs-snip-card"); card.setAttribute("role", "dialog"); card.setAttribute("aria-label", "Snip");
    const art = K.el("div", "ui-skeleton docs-snip-art");
    const meta = K.statusLine("Page " + page, {busy: true});
    const done = () => { card.remove(); mark.remove(); removeEventListener("keydown", esc, true); };
    const esc = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(); } };
    addEventListener("keydown", esc, true);
    const save = K.button("Save…", {size: "sm", disabled: true});
    const copy = K.button("Copy", {size: "sm", variant: "primary", disabled: true});
    const actions = K.el("div", "docs-snip-actions"); actions.append(K.button("Cancel", {size: "sm", variant: "quiet", run: done}), save, copy);
    card.append(art, meta, actions);
    mark.after(card);
    try {
      const r = await o.pagesReader.snip({page, region, side: 640});
      const blob = new Blob([r.png], {type: "image/png"}), img = new Image(); img.src = URL.createObjectURL(blob); img.alt = "Snip of page " + page;
      art.className = "docs-snip-art"; art.replaceChildren(img);
      const mm = r.physical ? r.physical.map((v, i) => Math.round(v * (region[i + 2] - region[i]) / 1e6 * 25.4 / 72)) : null;
      meta.replaceWith(K.statusLine("Page " + page + (mm ? " · " + mm[0] + " × " + mm[1] + " mm" : "") + " · keeps its page link"));
      copy.disabled = save.disabled = false;
      copy.onclick = async () => {
        try { await navigator.clipboard.write([new ClipboardItem({"image/png": blob})]); G.AtriumToast?.show("Copied the snip. Paste it on a sheet to place it."); done(); }
        catch { G.AtriumToast?.show("Couldn't copy the image.", {kind: "warn"}); }
      };
      save.onclick = async () => {
        try { await G.AtriumButterEditor.apply("butter.datasheets.snip", {id: o.ref.id, page, region}); done(); }
        catch (error) { G.AtriumToast?.show(error.message, {kind: "error"}); }
      };
      copy.focus();
    } catch (error) { meta.replaceWith(K.statusLine(error.message, {tone: "danger"})); }
  }

  // ------------------------------------------------------------------ menu
  function menuEntries() {
    const o = open_;
    return [
      {label: "Open PDF…", run: () => choose()},
      {label: "Show all datasheets", run: () => { release(); panel.querySelector("h2").textContent = "Datasheet"; paint(); }},
      "-",
      {label: "Copy link to page " + (o?.page || ""), enabled: !!o, run: () => copyPageLink()},
      {label: "Extract pin table from this page…", enabled: !!o, run: () => pinTable()},
      {label: "Embed in project…", enabled: !!o && !o.ref.asset && !!host.folderProject?.(), run: () => embed()}
    ];
  }
  async function copyPageLink() {
    const o = open_; if (!o) return;
    try {
      const r = (await G.AtriumButter.run("butter.datasheets.page-link", {id: o.ref.id, page: o.page}, {mode: "read"})).result;
      await navigator.clipboard.writeText(r.url); G.AtriumToast?.show("Copied the link to page " + o.page + ".");
    } catch (error) { G.AtriumToast?.show(error.message, {kind: "warn"}); }
  }
  async function pinTable() {
    const o = open_; if (!o) return;
    status("Reading the pin table on page " + o.page + "…", true);
    try {
      const r = (await G.AtriumButter.run("butter.datasheets.pin-table", {id: o.ref.id, page: o.page}, {mode: "read"})).result;
      status(statusText());
      if (!r.rows?.length) { setNotice({tone: "info", title: "No table found.", text: "Page " + o.page + " has no table Waffle can read. Try the page with the pin list, or copy the rows by hand."}); return; }
      if (r.partial) setNotice({tone: "warning", title: "Partial table.", text: "Only the first rows fit. Check the wizard's preview before you build the symbol."});
      host.act?.("symbol-wizard");
      const field = await waitFor(() => document.querySelector("dialog[open] .sw-paste"));
      if (field) { field.value = r.wizardInput.table; field.dispatchEvent(new Event("input", {bubbles: true})); }
    } catch (error) { status(statusText()); setNotice({tone: "danger", title: "Not extracted.", text: error.message}); }
  }
  function waitFor(fn, ms = 3000) {
    return new Promise(resolve => { const t0 = performance.now(); const tick = () => { const v = fn(); if (v || performance.now() - t0 > ms) resolve(v); else requestAnimationFrame(tick); }; tick(); });
  }
  async function embed() {
    const o = open_; if (!o) return;
    try {
      const ref = await D().chooseEmbedded({expected: o.ref, confirm: () => new Promise(resolve => G.AtriumShell.dialog({title: "Embed datasheet",
        body: [K.el("p", null, "Copy this PDF into the project so everyone who opens it can read it offline. Embed only datasheets whose licence allows redistribution.")],
        actions: [{label: "Cancel", run: () => resolve(false)}, {label: "Choose PDF…", primary: true, run: () => resolve(true)}], onClose: () => resolve(false)}))});
      if (ref) { G.AtriumToast?.show("Embedded “" + (ref.title || "datasheet") + "” in the project.", {kind: "ok"}); o.ref = ref; status(statusText()); }
    } catch (error) {
      const text = {source_changed: "The chosen PDF differs from this datasheet. Choose the exact original.", unsupported_surface: "Open the project as an editable folder to embed files."}[error.code] || error.message;
      setNotice({tone: "danger", title: "Not embedded.", text});
    }
  }

  /** Follow a waffle://…#datasheet:page=N link or a part's Datasheet link. */
  async function openLink({id, page = 1}) { return show(id, page); }
  async function openForSelection() {
    const p = host.project(), sel = host.selection?.() || [], d = host.doc?.();
    const item = d?.items?.find(i => sel.includes(i.id)), def = item?.def;
    const link = Object.values(p.links || {}).find(l => l.source?.objectId === def && l.label === "Datasheet");
    if (!link) { await ensure(); paint(); setNotice({tone: "info", title: "No datasheet.", text: "This part has no datasheet link. Open a PDF, then assign it to the part."}); return; }
    const page = Number(/page=(\d+)/.exec(link.target.fragment || "")?.[1] || 1);
    return show(link.target.objectId, page);
  }

  G.AtriumPrefs?.on?.("butter.datasheets", ({value}) => { if (value !== true) close(); });
  if (G.document) G.document.addEventListener("pointerdown", e => { if (panel && ui.pages?.contains(e.target)) snipStart(e); }, true);
  return Object.freeze({toggle, close, show, choose, openLink, openForSelection, isOpen: () => !!panel && !panel.hidden, current: () => open_ && {id: open_.ref.id, page: open_.page, pages: open_.pages}});
})();
