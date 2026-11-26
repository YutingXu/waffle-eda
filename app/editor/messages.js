"use strict";
// An Altium-style Messages panel. Features feed it groups of messages:
//   AtriumMessages.show(ctx, {title, group, messages:[{class, source, text, document, documentId, objectId, point, time, activate}]})
// Showing a group replaces that group's earlier messages and keeps the others.
// The panel is a docked region, not a <dialog>, so editor shortcuts keep working.
//
// Two views (docs/design/unified-rules-and-checks.md §2.7):
//   Problems  the live state of every check for the whole project, from the check store (checks.js):
//             DRC, ERC, DFM and Design Insights in one list, with chips for domain (Schematic,
//             Layout), Fab sign-off (checks against the fab's limits), Waived, and the stale
//             "Waivers to review". A single click on a row goes to it (both editors).
//   Log       one-shot outputs: import notes, ECO reports, output jobs, imported-rules prompts.
// Showing one of the check groups (DRC, Compiler, DFM, Insights) opens Problems, filtered to its
// domain, so Compile (C C) and Design Rule Check (T D R) are filtered views of Check Design. The
// groups' rows stay readable through messages() for scripts and tests.
globalThis.AtriumMessages = (() => {
  const AtriumI18n = globalThis.AtriumI18n || {define: m => (k, a) => m[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s)};
  const t = AtriumI18n.define({
    "messages.net_pair": "{a} ↔ {b}",
    "messages.net_pair.show": "Show all ({count})",
    "messages.net_pair.hide": "Collapse",
    "messages.net_pair.show_label": "Show all {count} findings for {pair}",
    "messages.net_pair.hide_label": "Collapse findings for {pair}"
  });
  const CLASSES = ["Fatal", "Error", "Warning", "Info"];
  const LABEL = {Fatal:"Fatal Error", Error:"Error", Warning:"Warning", Info:"Info"};
  const PLURAL = {Fatal:"fatal errors", Error:"errors", Warning:"warnings", Info:"info"};
  const RANK = {Fatal:0, Error:1, Warning:2, Info:3};
  const COLUMNS = [["class", "Class"], ["document", "Document"], ["source", "Source"], ["text", "Message"], ["time", "Time"], ["no", "No."]];
  const ROW_LIMIT = 5000;
  let store = [], panel = null, ui = null;
  const state = {ctx:null, title:"", rerun:null, options:null, classes:new Set(CLASSES), query:"", sort:{key:"no", dir:1}, selected:null,
    view:"log", domain:null, fab:false, waived:false, expandedPairs:new Set(), selectedPair:null};
  // The check groups Problems replaces, and the domain each one filters Problems to.
  const PROBLEM_GROUPS = {DRC:"layout", Compiler:"schematic", DFM:"layout", Insights:null};
  const K = () => globalThis.AtriumChecks;
  const isProblemGroup = g => Object.hasOwn(PROBLEM_GROUPS, g) && !!K();

  // ---- Data -----------------------------------------------------------------
  const pad = n => String(n).padStart(2, "0");
  const timeText = t => t ? pad(t.getHours()) + ":" + pad(t.getMinutes()) + ":" + pad(t.getSeconds()) : "";
  const dateText = t => t ? t.getFullYear() + "-" + pad(t.getMonth() + 1) + "-" + pad(t.getDate()) : "";
  function normalize(m, group, time) {
    const cls = CLASSES.includes(m?.class) ? m.class : /fatal/i.test(m?.class || "") ? "Fatal" : "Info";
    const t = m?.time instanceof Date ? m.time : m?.time != null ? new Date(m.time) : time;
    return {...m, class:cls, source:String(m?.source ?? group ?? ""), text:String(m?.text ?? ""), document:String(m?.document ?? ""),
      time:Number.isNaN(t?.getTime?.()) ? time : t, group};
  }
  function renumber() {store.forEach((m, n) => {m.no = n + 1;});}
  function set(group, list, time = new Date(), reuseKeys = false) {
    const prior = reuseKeys ? new Map() : null;
    if (prior) for (const m of store) {
      if (m.group !== group || !messageKeys.has(m)) continue;
      const signature = messageSignature(m), ids = prior.get(signature) || [];
      ids.push(messageKeys.get(m)); prior.set(signature, ids);
    }
    const entries = (list || []).map(m => normalize(m, group, time));
    if (prior?.size) for (const m of entries) {
      const id = prior.get(messageSignature(m))?.shift();
      if (id != null) messageKeys.set(m, id);
    }
    store = store.filter(m => m.group !== group).concat(entries);
    renumber();
    if (typeof CustomEvent === "function") globalThis.document?.dispatchEvent?.(new CustomEvent("atrium-messages-changed", {detail:group}));
    return store;
  }
  function clear(group, {replacement = false} = {}) {
    if (replacement) {
      state.ctx = state.rerun = state.options = state.onChoose = state.onActivate = null;
      state.title = ""; state.actions = []; state.labels = null; state.detail = null; state.status = null;
      state.selected = state.selectedKey = state.selectedPair = null;
      state.expandedPairs.clear();
      problemCache = {key:null, rows:[]};
    }
    if (group == null || group === state.detail) {
      state.status = null;
      if (state.detail) {state.actions = []; state.onActivate = null;}
    }
    store = group == null ? [] : store.filter(m => m.group !== group);
    renumber(); render(true);
  }
  const messageKeys = new WeakMap();
  let nextMotionKey = 0;
  function messageSignature(m) {
    const point = Array.isArray(m.point) ? m.point : [];
    return JSON.stringify([m.class,m.document,m.source,m.text,typeof m.objectId === "string" ? m.objectId : "",
      Number.isFinite(point[0]) ? point[0] : null,Number.isFinite(point[1]) ? point[1] : null]);
  }
  function motionKey(message) {
    const identity = message.problem?.key || message.staleWaiver?.id || message.netGroup?.key;
    if (identity) return "known-" + identity;
    if (!messageKeys.has(message)) messageKeys.set(message, ++nextMotionKey);
    return "entry-" + messageKeys.get(message);
  }
  const messages = () => store.slice();
  function counts(list) {
    const c = {Fatal:0, Error:0, Warning:0, Info:0};
    for (const m of list) c[m.class]++;
    return c;
  }
  function summarize(list) {
    const c = counts(list);
    const parts = CLASSES.filter(k => c[k]).map(k => c[k] + " " + (c[k] === 1 ? LABEL[k].toLowerCase() : PLURAL[k]));
    return {counts:c, text:list.length ? list.length + " message" + (list.length === 1 ? "" : "s") + " · " + parts.join(", ") : "No messages"};
  }
  // perf-ui: the lower-case search text of a message is built once, not on every keystroke.
  const HAY = new WeakMap();
  const hay = m => {let h = HAY.get(m); if (h === undefined) {h = [m.text, m.document, m.source, LABEL[m.class]].join(" ").toLowerCase(); HAY.set(m, h);} return h;};
  function filter(list, {classes = new Set(CLASSES), query = ""} = {}) {
    const q = query.trim().toLowerCase();
    return list.filter(m => classes.has(m.class) && (!q || hay(m).includes(q)));
  }
  const natural = new Intl.Collator("en", {numeric:true});
  function sort(list, key = "no", dir = 1) {
    const value = {class:m => RANK[m.class], time:m => m.time?.getTime?.() || 0, no:m => m.no};
    return list.slice().sort((a, b) => {
      const f = value[key];
      const r = f ? f(a) - f(b) : natural.compare(String(a[key] ?? ""), String(b[key] ?? ""));
      return (r || a.no - b.no) * dir;
    });
  }
  const csvCell = v => /[",\n\r]/.test(v) || /^[=+\-@\t\r]/.test(v) ? '"' + (/^[=+\-@\t\r]/.test(v) ? "'" : "") + v.replace(/"/g, '""') + '"' : v;
  function toCSV(list) {
    const rows = [["Class", "Document", "Source", "Message", "Date", "Time", "No."]];
    for (const m of list) rows.push([LABEL[m.class], m.document, m.source, m.text, dateText(m.time), timeText(m.time), String(m.no ?? "")]);
    return rows.map(r => r.map(v => csvCell(String(v))).join(",")).join("\r\n") + "\r\n";
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"})[c]);
  function toHTML(list, {title = "Messages"} = {}) {
    const s = summarize(list), when = new Date();
    const rows = list.map(m => "<tr class=\"" + m.class.toLowerCase() + "\"><td>" + esc(LABEL[m.class]) + "</td><td>" + esc(m.document) + "</td><td>" + esc(m.source) +
      "</td><td>" + esc(m.text) + "</td><td>" + esc(dateText(m.time) + " " + timeText(m.time)) + "</td><td>" + esc(m.no ?? "") + "</td></tr>").join("\n");
    return "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + esc(title) + "</title>\n" +
      "<style>:root{color-scheme:light dark}body{font:13px/1.45 system-ui,sans-serif;margin:24px}h1{font-size:18px;margin:0 0 4px}p{margin:0 0 16px;opacity:.75}" +
      "table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #8884;padding:4px 8px;text-align:left;vertical-align:top}th{font-weight:600}" +
      "td:first-child{font-weight:600;white-space:nowrap}tr.fatal td:first-child,tr.error td:first-child{color:#d33}tr.warning td:first-child{color:#c80}tr.info td:first-child{color:#37c}</style></head>\n" +
      "<body><h1>" + esc(title) + "</h1><p>" + esc(s.text) + " · Generated " + esc(dateText(when) + " " + timeText(when)) + "</p>\n" +
      "<table><thead><tr><th>Class</th><th>Document</th><th>Source</th><th>Message</th><th>Time</th><th>No.</th></tr></thead><tbody>\n" + rows + "\n</tbody></table></body></html>\n";
  }

  // ---- Problems (the check store) ------------------------------------------------------
  const SEV_CLASS = {fatal:"Fatal", error:"Error", warning:"Warning", hint:"Info"};
  let problemCache = {key:null, rows:[]};
  function unitOf() {try {return state.ctx?.units?.() || globalThis.AtriumNavHost?.units?.() || "mm";} catch {return "mm";}}
  function problemText(v, unit) {
    if (v.source !== "drc" || !v.raw || !globalThis.AtriumDRC?.message) return v.text;
    try {
      const message = AtriumDRC.message(v.raw, unit), original = v.member?.text;
      // Keep the limit attribution added by the merge while formatting the rule's measurements in the user's units.
      return original && v.text.startsWith(original) ? message + v.text.slice(original.length) : message;
    } catch {return v.text;}
  }
  // Rows for the Problems view, cached by the store's revision and the chips.
  function problemRows() {
    const C = K();
    if (!C) return [];
    const p = project(), unit = unitOf(), report = C.problemReport(p);
    const key = [report.revision, report.stamp, state.domain, state.fab, state.waived, unit, p?.documents?.length].join("|");
    if (problemCache.key === key && problemCache.project === p) return problemCache.rows;
    if (problemCache.project !== p) {state.expandedPairs.clear(); state.selectedPair = null;}
    const docs = new Map((p?.documents || []).map(d => [d.id, d.name])), time = new Date();
    const inDomain = v => !state.domain || v.domain === state.domain;
    const all = report.active.filter(v => inDomain(v) && (!state.fab || v.origin?.kind === "fab" || v.fab));
    const waived = state.waived ? report.waived.filter(inDomain) : [];
    const stale = report.stale.filter(r => !state.domain || (r.check || "").startsWith(state.domain === "layout" ? "layout." : "schematic."));
    const rows = all.map(v => ({class:SEV_CLASS[v.severity] || "Info", source:C.title(v.check) + (v.ruleName && v.ruleName !== C.title(v.check) ? " · " + v.ruleName : ""),
      text:(v.source === "erc" && v.hint && v.severity === "hint" ? "[" + v.hint + " after Compile] " : "") + problemText(v, unit), document:docs.get(v.doc) || "", documentId:v.doc,
      objectId:v.objects[0]?.id || null, point:v.at[0]?.point || null, time, problem:v, ...(v.source === "drc" ? {drc:v.raw} : {})}));
    if (state.waived) for (const v of waived) rows.push({class:"Info", source:"Waived · " + C.title(v.check), text:problemText(v, unit) + (v.raw?.waived?.note ? " · " + v.raw.waived.note : ""),
      document:docs.get(v.doc) || "", documentId:v.doc, objectId:v.objects[0]?.id || null, point:v.at[0]?.point || null, time, problem:v, waivedRow:true});
    for (const r of stale) rows.push({class:"Warning", source:"Waiver to review", text:(r.title || C.title(r.check)) + (r.note ? " · " + r.note : "") + " · its objects changed or the value got worse",
      document:docs.get(r.doc) || "", documentId:r.doc, objectId:r.objects[0]?.id || null, point:r.record?.at || null, time, staleWaiver:r});
    rows.forEach((m, n) => {m.no = n + 1; m.group = "Problems";});
    problemCache = {key, rows, project:p};
    return rows;
  }
  function pairOf(row) {
    const p = row.problem, pair = p?.raw?.netPair;
    if (p?.source !== "insights" || !Array.isArray(pair) || pair.length !== 2 ||
        !pair.every(n => typeof n === "string" && n) || pair[0] === pair[1]) return null;
    const [a, b] = pair.slice().sort();
    return {a, b, key:JSON.stringify([row.documentId, p.check, !!row.waivedRow, a, b])};
  }
  // Group only the visible Problems rows. The check store, exports and locating a
  // particular finding still use the individual rows and their original identities.
  function groupNetPairs(rows, expanded) {
    const groups = new Map(), membership = new Map();
    for (const m of rows) {
      const pair = pairOf(m);
      if (!pair) continue;
      let g = groups.get(pair.key);
      if (!g) groups.set(pair.key, g = {pair, members:[]});
      g.members.push(m); membership.set(m, g);
    }
    const display = [];
    for (const m of rows) {
      const g = membership.get(m);
      if (!g || g.members.length < 2) {display.push(m); continue;}
      if (g.members[0] !== m) continue;
      const {a, b, key} = g.pair, open = expanded.has(key);
      display.push({...m, no:-m.no, objectId:null, problem:null, text:t("messages.net_pair", {a, b}),
        netGroup:{key, count:g.members.length, open}});
      if (open) for (const child of g.members) display.push({...child, netGroupChild:true});
    }
    return display;
  }
  const viewList = () => state.view === "problems" ? problemRows() : state.detail ? store.filter(m => m.group === state.detail) : K() ? store.filter(m => !isProblemGroup(m.group)) : store;
  let liveOff = null, repaint = 0, painted = null;
  // What the Problems view shows (not the row times): a check publish that leaves it unchanged (most of
  // them: a re-check that found the same) does not repaint the panel.
  const shownOf = rows => rows.map(m => [m.class, m.source, m.text, m.document, m.objectId, m.point?.join?.(",") ?? "", pairOf(m)?.key || ""].join("\u0001")).join("\u0002");
  function listenChecks() {
    if (liveOff || !K()) return;
    liveOff = K().on(() => {
      if (!panel || panel.hidden || repaint || state.view !== "problems" && state.detail !== "DRC") return;
      const go = () => {
        repaint = 0;
        if (ui.drcStatus !== displayedStatus() || state.view === "problems" && shownOf(problemRows()) !== painted) render();
      };
      repaint = typeof requestAnimationFrame === "function" ? requestAnimationFrame(go) : setTimeout(go, 16);
    });
  }

  // ---- Panel ------------------------------------------------------------------
  const SVG = "http://www.w3.org/2000/svg";
  function svg(tag, attrs) {const n = document.createElementNS(SVG, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n;}
  function icon(cls) {
    const s = svg("svg", {viewBox:"0 0 12 12", class:"msg-icon msg-icon-" + cls.toLowerCase(), "aria-hidden":"true"});
    if (cls === "Fatal") s.append(svg("path", {d:"M4 .5h4L11.5 4v4L8 11.5H4L.5 8V4z", class:"msg-shape"}), svg("path", {d:"M6 3v3.6M6 8.3v.3", class:"msg-glyph"}));
    else if (cls === "Error") s.append(svg("circle", {cx:6, cy:6, r:5.5, class:"msg-shape"}), svg("path", {d:"M4 4l4 4M8 4l-4 4", class:"msg-glyph"}));
    else if (cls === "Warning") s.append(svg("path", {d:"M6 .7l5.6 10.3H.4z", class:"msg-shape"}), svg("path", {d:"M6 4.3v3.3M6 9v.2", class:"msg-glyph"}));
    else s.append(svg("circle", {cx:6, cy:6, r:5.5, class:"msg-shape"}), svg("path", {d:"M6 5.3v3.6M6 3.2v.2", class:"msg-glyph"}));
    return s;
  }
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  // perf-ui: one icon per class, cloned per row.
  const ICONS = {};
  const iconFor = cls => (ICONS[cls] || (ICONS[cls] = icon(cls))).cloneNode(true);
  function button(text, fn, cls, title) {const b = el("button", text, cls); b.type = "button"; b.onclick = fn; if (title) b.title = title; return b;}
  function build() {
    panel = el("section", null, "msg-panel"); panel.setAttribute("role", "region"); panel.setAttribute("aria-label", "Messages");
    // Mod+P with the focus in Messages prints the listed messages (editor.js printTarget).
    panel.dataset.printTarget = ""; panel.addEventListener("atrium-print", e => {e.stopPropagation(); printReport(e.detail?.mode === "pdf" ? "pdf" : "print");});
    const grip = el("div", null, "msg-grip"); grip.setAttribute("aria-hidden", "true");
    const head = el("header", null, "msg-head ui-toolbar ui-toolbar-actions"), heading = el("h2", "Messages"), context = el("span", null, "msg-context"); head.dataset.table = "";
    const tabs = el("div", null, "msg-filters msg-tabs ui-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Messages view");
    const tab = {};
    for (const [v, label] of [["problems", "Problems"], ["log", "Log"]]) {
      const b = button(label, () => setView(v), "msg-filter msg-tab ui-tab"); b.dataset.size = "sm"; b.setAttribute("role", "tab"); b.id = "msg-tab-" + v; tab[v] = b; tabs.append(b);
    }
    tabs.addEventListener("keydown", e => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault(); e.stopPropagation();
      setView(state.view === "problems" ? "log" : "problems"); tab[state.view].focus();
    });
    // Problems chips: domain, Fab sign-off, Waived.
    const chips = el("div", null, "msg-filters msg-chips"); chips.setAttribute("role", "group"); chips.setAttribute("aria-label", "Show problems");
    const chip = {};
    for (const [k, label, title] of [["schematic", "Schematic", "Only schematic problems (ERC)"], ["layout", "Layout", "Only layout problems (DRC, DFM)"],
      ["fab", "Fab sign-off", "Only checks against the fab's limits"], ["waived", "Waived", "Also list waived problems"]]) {
      const b = button(label, () => {
        if (k === "fab") state.fab = !state.fab; else if (k === "waived") state.waived = !state.waived; else state.domain = state.domain === k ? null : k;
        render();
      }, "msg-chip ui-chip", title);
      chip[k] = b; chips.append(b);
    }
    const filters = el("div", null, "msg-filters ui-toolbar-filter-actions"); filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "Show message classes");
    const toggles = {};
    for (const c of CLASSES) {
      const b = button("", () => {
        if (state.classes.has(c)) state.classes.delete(c); else state.classes.add(c);
        render();
      }, "msg-filter", "Show " + PLURAL[c]);
      b.append(icon(c), el("span", "0")); toggles[c] = b; filters.append(b);
    }
    const search = el("input", null, "ui-field"); search.type = "search"; search.placeholder = "Filter"; search.setAttribute("aria-label", "Filter messages");
    search.oninput = () => {state.query = search.value; render();};
    // The library search field: static .ui-search markup that AtriumUIKit adopts (clear button, count, Escape).
    const find = el("div", null, "ui-search msg-search"); find.dataset.size = "compact"; find.append(AtriumNavCommon.icon("search"), search); globalThis.AtriumUIKit?.adoptSearch(search);
    const locateButton = button("Locate", () => state.view === "problems" ? goTo(selectedMessage()) : locate(selectedMessage()), null, "Show the selected object (double-click a row)");
    const rerun = button("Recompile", () => state.rerun?.(), null, "Compile the project again");
    const options = button("Options…", () => state.options?.(), null, "Error reporting options");
    const exportMenu = el("details", null, "msg-export"), exportItems = el("div", null, "msg-export-items ui-menu-buttons");
    const exportSummary = el("summary", "Export");
    exportMenu.append(exportSummary, exportItems);
    exportMenu.addEventListener("toggle", () => {
      if (!exportMenu.open) return;
      // Fixed positioning needs the summary's own coordinates when the dock header has scrolled.
      const anchor = exportSummary.getBoundingClientRect(), viewport = document.documentElement, gap = 4;
      const width = exportItems.offsetWidth, height = exportItems.offsetHeight;
      const left = Math.max(gap, Math.min(anchor.left, viewport.clientWidth - width - gap));
      const below = anchor.bottom + gap;
      const top = below + height + gap <= viewport.clientHeight ? below : Math.max(gap, anchor.top - height - gap);
      exportItems.style.left = left + "px";
      exportItems.style.top = top + "px";
      const menu = globalThis.AtriumContextMenu;
      if (menu) menu.fitMenu(exportItems);
      else globalThis.AtriumLazy?.need("AtriumContextMenu").then(menu => {
        if (exportMenu.open) menu.fitMenu(exportItems);
      }, error => state.ctx?.info?.(error.message));
    });
    exportItems.append(button("Print…", () => {exportMenu.open = false; printReport("print");}), button("Export PDF…", () => {exportMenu.open = false; printReport("pdf");}),
      button("Report (.html)", () => {exportMenu.open = false; save("html");}), button("Spreadsheet (.csv)", () => {exportMenu.open = false; save("csv");}));
    const clearButton = button("Clear", () => clear(), null, "Remove all messages");
    const close = button("×", () => hide(), "ui-close msg-close", "Close Messages");
    close.setAttribute("aria-label", "Close Messages");
    const extra = el("span", null, "msg-extra ui-toolbar-actions"); extra.dataset.featureActions = "";
    // Where the header has no room for its actions (a side dock), they move into this menu.
    const more = button("", () => moreMenu(more), "msg-more ui-button", "More actions");
    more.dataset.variant = "quiet"; more.dataset.size = "sm"; more.setAttribute("aria-label", "More actions"); more.setAttribute("aria-haspopup", "menu"); more.setAttribute("aria-expanded", "false");
    const dots = svg("svg", {class:"icon", viewBox:"0 0 24 24", "aria-hidden":"true"}), g = svg("g", {fill:"currentColor", stroke:"none"});
    for (const cx of [5, 12, 19]) g.append(svg("circle", {cx, cy:12, r:1.7}));
    dots.append(g); more.append(dots);
    head.append(heading, tabs, context, filters, chips, find, el("span", null, "ui-toolbar-spacer"), locateButton, rerun, options, extra, exportMenu, clearButton, more, close);
    const grid = el("div", null, "msg-grid"); grid.tabIndex = 0; grid.setAttribute("aria-label", "Message list");
    const table = el("table"), colgroup = el("colgroup"), thead = el("thead"), hr = el("tr"), tbody = el("tbody");
    table.setAttribute("role", "grid");
    const sorters = {}, cols = {};
    for (const [key, label] of COLUMNS) {
      const th = el("th", null, "msg-col-" + key), b = button(label, e => {
        state.sort = {key, dir:state.sort.key === key ? -state.sort.dir : 1}; render(e?.detail > 0);
      });
      // The divider on a column's end edge resizes it (Message fills the rest, so its divider resizes the next column).
      const grip = el("span", null, "msg-col-grip"); grip.setAttribute("aria-hidden", "true"); grip.dataset.col = key;
      th.scope = "col"; b.dataset.hover = "ink"; th.append(b, grip); sorters[key] = th;
      cols[key] = el("col", null, "msg-colw-" + key);
    }
    thead.append(hr); table.append(colgroup, thead, tbody); grid.append(table);
    thead.addEventListener("pointerdown", columnDrag);
    thead.addEventListener("dblclick", e => {const g = e.target.closest?.(".msg-col-grip"); if (g) {e.stopPropagation(); autoFit(g.dataset.col);}});
    thead.addEventListener("click", e => {if (e.target.closest?.(".msg-col-grip")) e.stopPropagation();}, true);
    thead.addEventListener("contextmenu", e => {e.preventDefault(); e.stopPropagation(); columnMenu(e.target.closest?.("th") || thead.querySelector("th"));});
    const foot = el("footer", null, "msg-foot"), summary = el("span"), hint = el("span", "Double-click a message to locate it.", "msg-hint");
    summary.setAttribute("role", "status"); foot.append(summary, hint);
    panel.append(grip, head, grid, foot);
    ui = {head, context, toggles, search, locateButton, rerun, options, extra, tbody, grid, summary, sorters, rows:[], tab, chip, chips, clearButton, hint, more, exportMenu, hr, colgroup, cols};
    layoutColumns();
    // Narrow docks: the table becomes a two-line list, and the header wraps with its actions in ⋯.
    if (typeof ResizeObserver === "function") new ResizeObserver(() => fit()).observe(panel);
    // perf-ui: virtualised rows follow the scroll position (scroll events arrive once per frame).
    grid.addEventListener("scroll", () => paintRows(false), {passive:true});
    // One click chooses a row; in Problems it also goes to it (both editors), as a click on a board marker does.
    tbody.onclick = e => {
      const tr = e.target.closest("tr[data-no]");
      if (!tr) return;
      choose(Number(tr.dataset.no));
      if (state.view === "problems") goTo(selectedMessage());
      else state.onActivate?.(selectedMessage());
    };
    tbody.ondblclick = e => {const tr = e.target.closest("tr[data-no]"); if (tr) {choose(Number(tr.dataset.no)); locate(selectedMessage());}};
    panel.addEventListener("keydown", keys);
    grip.onpointerdown = e => {
      e.preventDefault(); grip.setPointerCapture(e.pointerId);
      const start = e.clientY, height = panel.getBoundingClientRect().height;
      grip.onpointermove = m => {panel.style.height = Math.max(120, Math.min(innerHeight * .8, height + start - m.clientY)) + "px";};
      grip.onpointerup = () => {grip.onpointermove = grip.onpointerup = null;};
    };
    document.body.append(panel);
  }
  // ---- Columns: widths and visibility per user (preference "messages.columns"), like VS Code's tables.
  // Drag a header divider to resize, double-click it to fit the contents, right-click the header to show or
  // hide columns. Message always shows and takes the width the others leave.
  const COLUMN_PREF = "messages.columns", WIDTH = {class:118, document:150, source:86, time:68, no:52}, MIN_COL = 40, MIN_TEXT = 200;
  function columnPrefs() {
    let p = null; try {p = globalThis.AtriumPref?.get(COLUMN_PREF);} catch {}
    const hidden = new Set(Array.isArray(p?.hidden) ? p.hidden.filter(k => k !== "text" && Object.hasOwn(WIDTH, k)) : []), widths = {};
    for (const k in WIDTH) widths[k] = Number.isFinite(p?.widths?.[k]) ? Math.max(MIN_COL, Math.round(p.widths[k])) : WIDTH[k];
    return {hidden, widths};
  }
  let colPrefs = null;
  const columnState = () => colPrefs || (colPrefs = columnPrefs());
  function saveColumns() {
    const {hidden, widths} = columnState(), changed = {};
    for (const k in WIDTH) if (widths[k] !== WIDTH[k]) changed[k] = widths[k];
    try {globalThis.AtriumPref?.set(COLUMN_PREF, {hidden:[...hidden], widths:changed});} catch {}
  }
  const shownColumns = () => COLUMNS.filter(([k]) => !columnState().hidden.has(k));
  // The header row and <colgroup> for the shown columns; the last shown column has no divider.
  function layoutColumns() {
    const shown = shownColumns(), {widths} = columnState();
    ui.hr.replaceChildren(...shown.map(([k]) => ui.sorters[k]));
    ui.colgroup.replaceChildren(...shown.map(([k]) => ui.cols[k]));
    for (const [k] of shown) ui.cols[k].style.width = k === "text" ? "" : widths[k] + "px";
    shown.forEach(([k], i) => {ui.sorters[k].querySelector(".msg-col-grip").hidden = i === shown.length - 1;});
  }
  // The column a divider resizes, and the sign of the change: Message's own divider resizes its right neighbour.
  function resizeTarget(key) {
    if (key !== "text") return {key, sign:1};
    const shown = shownColumns().map(([k]) => k), next = shown[shown.indexOf("text") + 1];
    return next ? {key:next, sign:-1} : null;
  }
  function columnDrag(e) {
    const g = e.target.closest?.(".msg-col-grip"); if (!g || e.button !== 0) return;
    const t = resizeTarget(g.dataset.col); if (!t) return;
    e.preventDefault(); e.stopPropagation(); try {g.setPointerCapture(e.pointerId);} catch {}
    const {widths} = columnState(), start = widths[t.key], x0 = e.clientX, room = () => ui.grid.clientWidth - MIN_TEXT;
    let frame = 0, x = x0;
    const apply = () => {
      frame = 0;
      const others = shownColumns().reduce((n, [k]) => k === "text" || k === t.key ? n : n + widths[k], 0);
      widths[t.key] = Math.round(Math.max(MIN_COL, Math.min(start + t.sign * (x - x0), Math.max(MIN_COL, room() - others))));
      ui.cols[t.key].style.width = widths[t.key] + "px";
    };
    const move = m => {x = m.clientX; if (!frame) frame = requestAnimationFrame(apply);};
    const up = () => {if (frame) cancelAnimationFrame(frame); apply(); g.classList.remove("is-dragging"); g.removeEventListener("pointermove", move); g.removeEventListener("pointerup", up); g.removeEventListener("pointercancel", up); saveColumns(); fit();};
    g.classList.add("is-dragging"); g.addEventListener("pointermove", move); g.addEventListener("pointerup", up); g.addEventListener("pointercancel", up);
  }
  // Double-click a divider: the column fits its header and the rows in view.
  function autoFit(key) {
    const t = resizeTarget(key); if (!t) return;
    // The contents' own width (a Range), as scrollWidth never reports less than the cell is now.
    const range = document.createRange(), natural = n => {
      range.selectNodeContents(n); const cs = getComputedStyle(n);
      return range.getBoundingClientRect().width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    };
    let w = natural(ui.sorters[t.key].querySelector("button")) + 12; // room for the sort arrow
    for (const td of ui.tbody.querySelectorAll("td.msg-col-" + t.key)) w = Math.max(w, natural(td));
    columnState().widths[t.key] = Math.max(MIN_COL, Math.min(480, Math.ceil(w) + 2));
    layoutColumns(); saveColumns(); fit();
  }
  function setColumn(key, show) {
    const {hidden} = columnState();
    if (key === "text" || show === !hidden.has(key)) return;
    if (show) hidden.delete(key); else hidden.add(key);
    saveColumns(); layoutColumns(); ui.rowH = null; ui.win = null; paintRows(true); fit();
  }
  function columnMenu(th) {
    const {hidden} = columnState();
    const entries = COLUMNS.map(([k, label]) => ({label, checked:!hidden.has(k), enabled:k !== "text", run:() => setColumn(k, hidden.has(k))}));
    entries.push("-", {label:"Reset Columns", enabled:true, run:() => {colPrefs = {hidden:new Set(), widths:{...WIDTH}}; saveColumns(); layoutColumns(); paintRows(true); fit();}});
    th.setAttribute("aria-label", "Columns");
    globalThis.AtriumLazy?.need?.("AtriumContextMenu").then(menu => {if (th.isConnected) menu.dropdown(th, entries, {host:globalThis.AtriumNavHost || {info:() => {}}}); th.removeAttribute("aria-label");},
      e => state.ctx?.info?.(e.message));
  }

  // List layout below LIST_W of panel width: the message is the first line, class · document · source the
  // second. The header goes compact (wraps, actions in ⋯) once its one-line width does not fit.
  const LIST_W = 480;
  let headNeed = 0, headSig = "";
  function fit(changed = false) {
    if (!panel || panel.hidden || !ui) return;
    const w = panel.clientWidth; if (!w) return;
    const fixed = shownColumns().reduce((n, [k]) => k === "text" ? n : n + columnState().widths[k], 0);
    const list = w < LIST_W || w - fixed < MIN_TEXT;
    if (panel.classList.contains("msg-list") !== list) {panel.classList.toggle("msg-list", list); ui.rowH = null; ui.win = null; paintRows(true);}
    // The header's one-line width is measured with the compact layout off, only when its content changed.
    if (changed || !headNeed) {
      const was = panel.classList.contains("msg-compact");
      if (was) panel.classList.remove("msg-compact");
      headNeed = ui.head.scrollWidth;
      if (was) panel.classList.add("msg-compact");
    }
    panel.classList.toggle("msg-compact", headNeed > ui.head.clientWidth + 1 || list);
  }
  function moreMenu(trigger) {
    const sep = "-", entries = [];
    const add = (b, label = b.textContent) => {if (b && !b.hidden) entries.push({label, enabled:!b.disabled, run:() => b.click()});};
    add(ui.locateButton); add(ui.rerun); add(ui.options);
    const extra = [...ui.extra.children]; if (extra.length) {entries.push(sep); for (const b of extra) add(b);}
    if (!ui.exportMenu.hidden) entries.push(sep, {label:"Print…", enabled:true, run:() => printReport("print")}, {label:"Export PDF…", enabled:true, run:() => printReport("pdf")},
      {label:"Export Report (.html)…", enabled:true, run:() => save("html")}, {label:"Export Spreadsheet (.csv)…", enabled:true, run:() => save("csv")});
    if (!ui.clearButton.hidden) add(ui.clearButton);
    if (panel.classList.contains("msg-list")) {
      const by = COLUMNS.map(([key, label]) => ({label, enabled:true, checked:state.sort.key === key, radio:true,
        run:() => {state.sort = {key, dir:state.sort.key === key ? -state.sort.dir : 1}; render();}}));
      entries.push(sep, {sub:"Sort By", items:by});
    }
    globalThis.AtriumLazy?.need?.("AtriumContextMenu").then(menu => {if (trigger.isConnected) menu.dropdown(trigger, entries, {host:globalThis.AtriumNavHost || {info:() => {}}});},
      e => state.ctx?.info?.(e.message));
  }
  function keys(e) {
    const inField = e.target.closest("input,select,textarea,summary,button");
    if (e.key === "Escape") {e.preventDefault(); e.stopPropagation(); if (e.target === ui.search && ui.search.value) {ui.search.value = ""; state.query = ""; render();} else hide(); return;}
    if (!inField && e.target.closest(".msg-grid")) {
      const rows = ui.rows, at = rows.findIndex(m => m.no === state.selected);
      const step = {ArrowDown:1, ArrowUp:-1, PageDown:10, PageUp:-10}[e.key];
      if (step || e.key === "Home" || e.key === "End") {
        e.preventDefault(); e.stopPropagation();
        if (!rows.length) return;
        const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, (at < 0 ? -1 : at) + step));
        choose(rows[next].no); return;
      }
      const selected = selectedMessage();
      if (state.view === "log" && (e.key === "Enter" || e.key === " ") && state.onActivate?.(selected)) {
        e.preventDefault(); e.stopPropagation(); return;
      }
      if (e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        if (state.view === "problems") {goTo(selected); if (!selected?.netGroup) ui.grid.focus();}
        else locate(selected, true);
        return;
      }
    }
    // Keep single-key editor shortcuts out of the panel; Ctrl/Cmd commands still reach the editor.
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  }
  const selectedMessage = () => ui?.rows.find(m => m.no === state.selected);
  function syncActions() {
    const selected = selectedMessage();
    ui.locateButton.disabled = !selected?.objectId && !selected?.activate;
    [...ui.extra.children].forEach((b, i) => {const a = state.actions[i]; b.disabled = a.enabled ? !a.enabled(selected) : false;});
  }
  // A Problems row: the check store goes to the violation (document, camera, inspector); a stale waiver frames its objects.
  function goTo(m) {
    if (!m) return;
    if (m.netGroup) {togglePair(m.netGroup.key); return;}
    const host = globalThis.AtriumNavHost;
    if (m.problem && K()?.focus && host) {K().focus(host, m.problem); return;}
    if (m.objectId) locate(m, true);
  }
  // choose(no, {center, focus}): select a row. center scrolls it to the middle of the list (Show in
  // Messages) instead of just into view; the keyboard focus follows the selection when it is on a row
  // already (arrow keys) or `focus` asks for it.
  function choose(no, {center = false, focus = false} = {}) {
    const active = document.activeElement, rowFocus = focus || !!(active?.matches?.("tr[data-no]") && ui.tbody.contains(active));
    state.selected = no;
    // Problems are rebuilt after every check pass: the selection follows the problem, not its row number.
    const row = state.view === "problems" ? ui.rows.find(m => m.no === no) : null;
    state.selectedKey = row ? row.problem?.key || (row.staleWaiver ? "waiver:" + row.staleWaiver.id : null) : null;
    state.selectedPair = row?.netGroup?.key || null;
    // perf-ui: rows are virtualised; scroll the chosen row into view by index, then paint the window.
    const at = ui.rows.findIndex(m => m.no === no);
    if (at >= 0 && ui.grid.clientHeight) {
      const h = rowHeight(), head = ui.grid.tHead?.offsetHeight || ui.grid.querySelector("thead")?.offsetHeight || 0, top = ui.grid.scrollTop, view = ui.grid.clientHeight - head;
      if (center) ui.grid.scrollTop = Math.max(0, Math.round(at * h - (view - h) / 2));
      else if (at * h < top) ui.grid.scrollTop = at * h; else if ((at + 1) * h > top + view) ui.grid.scrollTop = (at + 1) * h - view;
      paintRows(false);
    }
    for (const tr of ui.tbody.children) if (tr.dataset.no) tr.setAttribute("aria-selected", String(Number(tr.dataset.no) === no));
    if (rowFocus) focusSelected();
    syncActions();
    if (state.view !== "problems") try {state.onChoose?.(selectedMessage());} catch (e) {globalThis.console?.error?.(e);}
  }
  // The keyboard focus on the selected row (rows are focusable, tabIndex -1), else on the list.
  function focusSelected() {
    const tr = ui.tbody.querySelector('tr[data-no][aria-selected="true"]');
    (tr || ui.grid).focus({preventScroll:true});
  }
  function setView(v) {
    if (v !== "problems" && v !== "log") return;
    // An explicit tab choice returns to the shared list and leaves the task's rows in the store.
    if (state.detail) {
      state.detail = state.status = state.rerun = state.options = state.onChoose = state.onActivate = null;
      state.title = ""; state.labels = null; state.actions = [];
    }
    state.view = v; state.selected = null; state.selectedPair = null;
    if (ui) ui.seen = null;
    render();
  }
  function togglePair(key) {
    if (state.expandedPairs.has(key)) state.expandedPairs.delete(key); else state.expandedPairs.add(key);
    state.selectedPair = key; state.selectedKey = null;
    render();
    focusPair(key);
  }
  function focusPair(key) {
    const b = [...ui.tbody.querySelectorAll(".msg-pair-toggle")].find(x => x.dataset.pair === key);
    if (b) b.focus({preventScroll:true}); else ui.grid.focus({preventScroll:true});
  }
  function render(animate = false) {
    if (!panel) return;
    if (!K()) state.view = "log";
    listenChecks();
    const list = viewList(), all = summarize(list), visible = sort(filter(list, state), state.sort.key, state.sort.dir), problems = state.view === "problems";
    const status = ui.drcStatus = displayedStatus();
    const busy = status === "Checking…";
    ui.grid.setAttribute("aria-busy", String(busy));
    ui.exportMenu.hidden = busy || !!(state.detail && !problems && status);
    painted = problems ? shownOf(list) : null;
    const display = problems ? groupNetPairs(visible, state.expandedPairs) : visible;
    const grouped = display.some(m => m.netGroup);
    if (ui.grid.classList.toggle("msg-with-pairs", grouped) !== ui.grouped) {ui.rowH = null; ui.grouped = grouped;}
    if (problems && state.selectedKey) state.selected = display.find(m => (m.problem?.key || (m.staleWaiver ? "waiver:" + m.staleWaiver.id : null)) === state.selectedKey)?.no ?? null;
    if (problems && state.selectedPair) state.selected = display.find(m => m.netGroup?.key === state.selectedPair)?.no ?? null;
    for (const [v, b] of Object.entries(ui.tab)) {b.setAttribute("aria-selected", String(state.view === v)); b.tabIndex = state.view === v ? 0 : -1; b.hidden = !K();}
    if (K()) {ui.grid.setAttribute("role", "tabpanel"); ui.grid.setAttribute("aria-labelledby", "msg-tab-" + state.view);}
    // The live Problems list changes with every edit: its count is not announced each time (Log's is).
    ui.summary.setAttribute("aria-live", problems && !status ? "off" : "polite");
    ui.chips.hidden = !problems;
    for (const [k, b] of Object.entries(ui.chip)) b.setAttribute("aria-pressed", String(k === "fab" ? state.fab : k === "waived" ? state.waived : state.domain === k));
    ui.clearButton.hidden = problems;
    ui.hint.textContent = problems ? "Click a problem to go to it." : "Double-click a message to locate it.";
    ui.context.textContent = problems ? "" : state.title || "";
    for (const c of CLASSES) {
      const b = ui.toggles[c]; b.lastChild.textContent = String(all.counts[c]);
      b.setAttribute("aria-pressed", String(state.classes.has(c)));
      b.setAttribute("aria-label", (state.classes.has(c) ? "Hide " : "Show ") + PLURAL[c] + " (" + all.counts[c] + ")");
    }
    for (const [key] of COLUMNS) ui.sorters[key].setAttribute("aria-sort", state.sort.key === key ? (state.sort.dir > 0 ? "ascending" : "descending") : "none");
    ui.rerun.hidden = !state.rerun; ui.rerun.disabled = busy; ui.options.hidden = !state.options;
    const L = state.labels || {};
    ui.rerun.textContent = L.rerunLabel || "Recompile"; ui.rerun.title = L.rerunTitle || "Compile the project again";
    ui.options.textContent = L.optionsLabel || "Options…"; ui.options.title = L.optionsTitle || "Error reporting options";
    ui.extra.replaceChildren(...(state.actions || []).map(a => button(a.label, () => a.run(selectedMessage()), null, a.title)));
    // Only rows in view (plus OVERSCAN) are in the DOM, between two spacer rows.
    // Animate explicit list changes while the grid is visible and unfiltered.
    ui.rows = display;
    const motion = animate && !panel.hidden && !state.query && globalThis.AtriumSpatialMotion;
    const paint = () => paintRows(true);
    if (motion) motion.layout(ui.tbody, ":scope > tr[data-motion-key]", row => row.dataset.motionKey, paint, {viewport:ui.grid});
    else paint();
    const shown = visible.length === list.length ? "" : " · " + visible.length + " shown";
    ui.summary.textContent = status || all.text + shown;
    syncActions();
    const sig = [state.view, ui.context.textContent, ui.rerun.hidden, ui.rerun.textContent, ui.options.hidden, ui.extra.textContent, ui.clearButton.hidden,
      ...CLASSES.map(c => all.counts[c])].join("\u0001");
    if (sig !== headSig) {headSig = sig; fit(true);}
  }
  // ---- Virtualised rows (perf-ui) ------------------------------------------------
  const OVERSCAN = 16;
  function rowHeight() {
    if (!ui.rowH) {const h = ui.tbody.querySelector("tr[data-no]")?.getBoundingClientRect().height; if (h > 4) ui.rowH = h;}
    return ui.rowH || 21;
  }
  function vpad(px) {
    const tr = el("tr", null, "msg-vpad"), td = el("td"); tr.setAttribute("aria-hidden", "true");
    td.colSpan = shownColumns().length; td.style.cssText = "height:" + px + "px;padding:0;border:0"; tr.append(td); return tr;
  }
  function rowFor(m) {
    const tr = el("tr", null, "msg-" + m.class.toLowerCase()); tr.dataset.no = m.no;
    tr.dataset.motionKey = motionKey(m); tr.setAttribute("aria-selected", String(m.no === state.selected)); tr.tabIndex = -1;
    if (m.objectId || m.activate) tr.classList.add("msg-locatable");
    const severity = m.netGroup ? "hint" : m.problem?.severity;
    const cls = el("td", null, "msg-col-class"); cls.append(iconFor(m.class), el("span", "[" + (severity === "hint" ? "Hint" : LABEL[m.class]) + "]"));
    if (severity) tr.dataset.sev = severity;
    const text = el("td", m.text, "msg-col-text"); // no title: no hover pop-ups (the full text is in the row)
    if (m.netGroup) {
      const {key, count, open} = m.netGroup, label = {count, pair:m.text};
      const b = button(t(open ? "messages.net_pair.hide" : "messages.net_pair.show", label), e => {e.stopPropagation(); togglePair(key);}, "msg-pair-toggle ui-button");
      b.dataset.size = "sm"; b.dataset.pair = key; b.ondblclick = e => e.stopPropagation();
      b.setAttribute("aria-expanded", String(open)); b.setAttribute("aria-label", t(open ? "messages.net_pair.hide_label" : "messages.net_pair.show_label", label));
      text.classList.add("msg-net-pair");
      const line = el("div", null, "msg-net-pair-line");
      line.append(el("span", m.text), b); text.replaceChildren(line);
    } else if (m.netGroupChild) text.classList.add("msg-net-pair-child");
    const cells = {class:cls, document:() => el("td", m.document, "msg-col-document"), source:() => el("td", m.source, "msg-col-source"), text,
      time:() => el("td", timeText(m.time), "msg-col-time"), no:() => el("td", m.netGroup ? "" : String(m.no), "msg-col-no")};
    // The list layout always shows the class (its icon starts the row) and the message.
    const {hidden} = columnState(), list = panel.classList.contains("msg-list");
    for (const [k] of COLUMNS) if (!hidden.has(k) || list && (k === "class" || k === "text")) tr.append(typeof cells[k] === "function" ? cells[k]() : cells[k]);
    return tr;
  }
  function displayedStatus() {
    if (state.view !== "problems") {
      if (state.detail === "DRC" && state.status === "Run DRC to check this revision." && globalThis.AtriumDRCView?.status?.() === "Checking…") return "Checking…";
      return state.status;
    }
    return state.domain !== "schematic" && !state.fab ? globalThis.AtriumDRCView?.status?.() || null : null;
  }
  function paintRows(force) {
    if (!panel || !ui?.rows) return;
    const list = ui.rows, active = document.activeElement;
    const focusedPair = ui.tbody.contains(active) && active?.dataset.pair;
    const focusedRow = !focusedPair && ui.tbody.contains(active) && active.matches?.("tr[data-no]");
    if (!list.length) {
      const none = displayedStatus() || (state.view === "problems" ? "No problems." : "No messages.");
      const tr = el("tr", null, "msg-empty"), td = el("td", displayedStatus() || (viewList().length ? "No messages match the filter." : none)); td.colSpan = shownColumns().length; tr.append(td);
      ui.tbody.replaceChildren(tr); ui.win = null; if (focusedPair) focusPair(focusedPair); else if (focusedRow) ui.grid.focus({preventScroll:true}); return;
    }
    const h = rowHeight(), top = ui.grid.scrollTop, view = ui.grid.clientHeight || 600;
    const a = Math.floor(top / h), b = Math.min(list.length, Math.ceil((top + view) / h));
    if (!force && ui.win && a >= ui.win[0] && b <= ui.win[1]) return;
    const first = Math.max(0, a - OVERSCAN), last = Math.min(list.length, b + OVERSCAN), frag = document.createDocumentFragment();
    if (first > 0) frag.append(vpad(first * h));
    for (let i = first; i < last; i++) frag.append(rowFor(list[i]));
    if (last < list.length) frag.append(vpad((list.length - last) * h));
    ui.tbody.replaceChildren(frag); ui.win = [first, last];
    if (focusedPair) focusPair(focusedPair);
    // A repaint replaces the rows: the focus stays on the selected row, or on the list once it scrolled away.
    else if (focusedRow && !ui.tbody.contains(document.activeElement)) focusSelected();
    if (!ui.rowH && panel.offsetParent !== null) rowHeight();
  }
  function project() {const ctx = state.ctx; return ctx?.currentProject?.() || ctx?.project;}
  function locate(m, keepFocus = false) {
    const ctx = state.ctx;
    if (!m || !ctx) return false;
    if (m.activate) {
      m.activate();
      return true;
    }
    if (!m.objectId) {ctx.info?.("This message has no object to locate."); return false;}
    const p = project();
    if (p && !p.documents?.some(d => d.items.some(i => i.id === m.objectId))) {ctx.info?.("This object no longer exists. Compile again to refresh the messages."); return false;}
    ctx.select?.(m.objectId);
    if (m.point && ctx.locate) ctx.locate(m.objectId, m.point);
    if (keepFocus) ui?.grid.focus();
    return true;
  }
  // The listed messages (filters and sort as shown) as a printable report (print-report.js).
  function toReport(list, {title = "Messages", project:name = "", date = new Date()} = {}) {
    return {title, name:(name || "Project") + " messages.pdf",
      subtitle:[name, summarize(list).text, dateText(date) + " " + timeText(date)].filter(Boolean).join(" · "),
      sections:[{columns:[{label:"Class"}, {label:"Document"}, {label:"Source"}, {label:"Message"}, {label:"Time"}, {label:"No.", numeric:true}],
        rows:list.map(m => [LABEL[m.class], m.document, m.source, m.text, (dateText(m.time) + " " + timeText(m.time)).trim(), m.no ?? ""]), empty:"No messages."}]};
  }
  async function printReport(mode) {
    const ctx = state.ctx, list = sort(filter(viewList(), state), state.sort.key, state.sort.dir);
    const base = (project()?.name || "Project").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim() || "Project";
    try {
      const R = globalThis.AtriumPrintReport || await globalThis.AtriumLazy?.need("AtriumPrintReport");
      if (!R) throw Error("Printing is unavailable in this build.");
      R.open({...ctx, exportFile:ctx?.exportFile || globalThis.AtriumIO?.exportFile}, {mode, title:state.title || "Messages", report:toReport(list, {title:state.title || "Messages", project:base})});
    } catch (error) {ctx?.info?.(error.message || String(error));}
  }
  async function save(format) {
    const ctx = state.ctx, list = sort(filter(viewList(), state), state.sort.key, state.sort.dir);
    const base = (project()?.name || "Project").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim() || "Project";
    const name = base + " messages." + format, text = format === "csv" ? toCSV(list) : toHTML(list, {title:(state.title || "Messages") + " · " + base});
    try {if (await (ctx?.exportFile || globalThis.AtriumIO?.exportFile)?.(name, text)) ctx?.info?.("Exported " + name);}
    catch (error) {ctx?.info?.(error.message);}
  }
  function show(ctx, {title, group = "Messages", messages:list = [], rerun = null, options = null, rerunLabel = "Recompile", rerunTitle = "Compile the project again",
    optionsLabel = "Options…", optionsTitle = "Error reporting options", actions = [], onChoose = null, onActivate = null, focus = true, detail = false, status = null, preserve = false} = {}) {
    if (ctx) state.ctx = ctx;
    if (title != null) state.title = title;
    // A check group opens Problems, filtered to its domain (Compile: Schematic, DRC and DFM: Layout).
    state.detail = detail ? group : null; state.status = status;
    if (detail) {if (!preserve) state.view = "log"; state.domain = PROBLEM_GROUPS[group] || null; state.fab = false;}
    else if (isProblemGroup(group)) {state.view = "problems"; state.domain = PROBLEM_GROUPS[group]; state.fab = group === "DFM";}
    else if (list?.length) state.view = "log";
    state.rerun = rerun; state.options = options; state.labels = {rerunLabel, rerunTitle, optionsLabel, optionsTitle}; state.actions = actions || []; state.onChoose = onChoose; state.onActivate = onActivate;
    set(group, list);
    if (typeof document === "undefined") return store;
    if (!panel) build();
    if (!preserve) panel.hidden = false;
    const first = state.view === "problems" ? null : store.find(m => m.group === group && m.class !== "Info" && m.objectId);
    if (!preserve || !viewList().some(m => m.no === state.selected)) {
      state.selected = first?.no ?? null; state.selectedKey = null; state.selectedPair = null;
    }
    render();
    if (focus) {
      const focusList = () => {if (!panel.hidden) ui.grid.focus({preventScroll:true});};
      focusList();
      // A registered tab can be open behind another panel or in a collapsed dock.
      if (document.activeElement !== ui.grid && globalThis.AtriumDock?.reveal("messages")) queueMicrotask(focusList);
    }
    return store;
  }
  // Replace one group's rows and repaint, keeping the title, buttons, filters and focus.
  function update(group, list, {animate = true} = {}) {
    const reuseKeys = animate && panel && !panel.hidden && !state.query && globalThis.AtriumMotionUI?.enabled();
    set(group, list, undefined, reuseKeys);
    if (state.selected != null && !viewList().some(m => m.no === state.selected)) state.selected = null;
    render(animate);
    return store;
  }
  // ---- Show in Messages -------------------------------------------------------------
  // reveal(test, {ctx, focus}): the first message passing `test`, shown as the chosen row: on its tab
  // (Problems or Log), with any chip, class toggle or filter text that hid it cleared (and said so in
  // the status bar), its net-pair group open, the Messages tab in front of its dock, scrolled to the
  // middle of the list, selected and, with focus (the default), holding the keyboard focus. False if none.
  function reveal(test, {ctx = null, focus = true} = {}) {
    if (ctx) state.ctx = ctx;
    const pass = x => {try {return !!test(x);} catch {return false;}};
    const cleared = [];
    let m = null, view = null;
    if (K()) {
      m = problemRows().find(pass);
      if (!m && (state.domain || state.fab || !state.waived)) {
        // Hidden by a chip: look again on every domain with the waived rows, then keep off only the chips that hid it.
        const was = {domain:state.domain, fab:state.fab, waived:state.waived};
        state.domain = null; state.fab = false; state.waived = true;
        m = problemRows().find(pass);
        if (!m) Object.assign(state, was);
        else {
          if (!m.waivedRow) state.waived = was.waived; else if (!was.waived) cleared.push("Waived");
          if (was.domain) cleared.push(was.domain === "layout" ? "Layout" : "Schematic");
          if (was.fab) cleared.push("Fab sign-off");
          if (!m.waivedRow && !was.waived) m = problemRows().find(pass) || m;
        }
      }
      if (m) view = "problems";
    }
    if (!m) {
      m = store.find(pass);
      if (!m) return false;
      // A check group's row: its problems are in Problems (the group's own rows are for scripts).
      if (!m.problem && isProblemGroup(m.group)) {view = "problems"; m = null;} else view = "log";
    }
    if (typeof document === "undefined") {state.view = view; return true;}
    if (!panel) build();
    if (view === "log" && state.detail && m.group !== state.detail) {
      state.detail = state.status = state.rerun = state.options = state.onChoose = state.onActivate = null;
      state.title = ""; state.labels = null; state.actions = [];
    }
    if (state.view !== view) {state.view = view; ui.seen = null;}
    if (m) {
      if (!state.classes.has(m.class)) {state.classes.add(m.class); cleared.push("hidden " + PLURAL[m.class]);}
      if (state.query && !filter([m], state).length) {cleared.push("the filter “" + state.query.trim() + "”"); state.query = ""; ui.search.value = "";}
      const pair = pairOf(m);
      if (pair) state.expandedPairs.add(pair.key);
    }
    panel.hidden = false;
    globalThis.AtriumDock?.reveal?.("messages");
    render();
    const settle = () => {
      if (!m) {if (focus) ui.grid.focus({preventScroll:true}); return;}
      // The shown row of that message (Problems rows are rebuilt by each check pass: match the finding).
      const row = ui.rows.find(r => r === m || !r.netGroup && (m.problem ? r.problem === m.problem : m.staleWaiver ? r.staleWaiver === m.staleWaiver : r.no === m.no));
      if (row) choose(row.no, {center:true, focus});
    };
    settle();
    // A tab brought to the front of its dock is laid out by the dock's next render: place the row again then.
    if (m && !ui.grid.clientHeight) queueMicrotask(() => requestAnimationFrame(settle));
    if (cleared.length) (state.ctx?.info || globalThis.AtriumNavHost?.info)?.("Messages: cleared " + cleared.join(", ") + " to show this " + (view === "problems" ? "problem." : "message."));
    return true;
  }
  const focusWhere = (test, o) => reveal(test, o);
  // A problem as the board, the sheet, a hover card or the violation inspector holds it: a check-store
  // finding (key), a DRC violation (its own object, or the same rule and objects after a re-check), or an insight.
  const unifiedProblem = v => !!v && typeof v.key === "string" && typeof v.check === "string";
  const drcKey = v => v?.type ? v.type + "|" + (v.ruleName || "") + "|" + [v.id, v.otherId].filter(Boolean).sort().join("|") : "";
  function revealProblem(v, ctx = null, o = {}) {
    if (!v) return false;
    if (unifiedProblem(v)) return reveal(m => m.problem === v || m.problem?.key === v.key, {...o, ctx});
    const k = drcKey(v);
    return reveal(m => m.drc === v || m.problem?.raw === v, {...o, ctx}) || !!k && reveal(m => !!m.drc && drcKey(m.drc) === k, {...o, ctx});
  }
  // open(ctx, {view, domain}): the panel, optionally on Problems filtered to a domain.
  function open(ctx, o = {}) {
    if (ctx) state.ctx = ctx;
    if (o.domain !== undefined) state.domain = o.domain;
    if (o.fab !== undefined) state.fab = !!o.fab;
    if (o.waived !== undefined) state.waived = !!o.waived;
    if (typeof document === "undefined") {setView(o.view); return;}
    if (!panel) build();
    panel.hidden = false;
    if (o.view === "problems" || o.view === "log") setView(o.view); else render();
    ui.grid.focus({preventScroll:true});
  }
  function hide() {
    if (!panel) return;
    if (panel.contains(document.activeElement)) {document.activeElement.blur(); globalThis.AtriumNavHost?.canvas?.()?.focus();}
    panel.hidden = true;
  }
  const isOpen = () => !!panel && !panel.hidden;
  return {CLASSES, LABEL, show, open, close:hide, isOpen, clear, set, update, focusWhere, reveal, revealProblem, messages, summarize, filter, sort, toCSV, toHTML, toReport, locate,
    problems:() => problemRows(), detail:() => state.detail,
    drcPending:() => state.detail === "DRC" && state.status === "Checking…", view:() => state.view, setView, groupNetPairs};
})();
