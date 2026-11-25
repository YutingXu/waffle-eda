"use strict";
// The table is created the first time the Nets panel opens. Its menu, shortcuts and board colours are available at startup.
globalThis.AtriumNetsTable = (() => {
  const C = globalThis.AtriumNavCommon, N = globalThis.AtriumNetsPanel;
  const A = () => globalThis.Atrium, CP = globalThis.AtriumCrossProbe;
  const {PALETTE, summary, classColours, colors, setOverride} = N;
  let host, panel = null, ui = null, rows = [], view = [], active = -1, dirty = true, timer = 0;
  const state = {query:"", cls:"", sort:"name", dir:1};

  let projectLoad;
  function compute() {
    const d = host.doc(), defs = host.defs(), project = host.project();
    let lengths = null, classes = null, hierarchy = null;
    if (d.kind === "schematic") {
      const load = N.ensureSchematicProject(host);
      if (load) {
        if (projectLoad !== load) {
          projectLoad = load;
          const settled = error => {
            if (projectLoad !== load) return;
            projectLoad = null;
            if (host.project() !== project || panel.hidden) return;
            if (error) host.info(error.message);
            else schedule();
          };
          load.then(() => settled(), settled);
        }
        rows = [];
        dirty = false;
        return;
      }
      hierarchy = globalThis.AtriumHierarchy.compileCached(project, {defs, publish:false});
    }
    if (d.kind === "pcb") {
      try {lengths = globalThis.AtriumLength?.lengths ? AtriumLength.lengths(d, defs, {revision:host.revision()}) : globalThis.AtriumRules?.netLengths?.(d, defs) || null;} catch {lengths = null;}
      try {classes = globalThis.AtriumRules?.netClasses?.(d, {project:host.project()}) || null;} catch {classes = null;}
    }
    rows = summary(d, defs, {connections:d.kind === "pcb" ? host.connections() : null, lengths, classes, hierarchy, instanceId:C.paletteInstance(host, d.id)});
    dirty = false;
  }
  function filtered() {
    const q = state.query.trim().toLowerCase(), natural = new Intl.Collator("en", {numeric:true});
    let out = rows.filter(r => (!q || r.name.toLowerCase().includes(q) || r.cls.toLowerCase().includes(q)) && (!state.cls || r.cls === state.cls));
    const key = state.sort, dir = state.dir;
    out = out.slice().sort((a, b) => {
      const x = a[key], y = b[key];
      const r = typeof x === "number" || typeof y === "number" ? (x ?? -1) - (y ?? -1) : natural.compare(String(x || ""), String(y || ""));
      return (r || natural.compare(a.name, b.name)) * dir;
    });
    return out;
  }
  const COLS = [["name", "Net"], ["cls", "Class"], ["nodes", "Nodes"], ["length", "Length"], ["unrouted", "Unrouted"]];
  function build() {
    const nav = document.getElementById("properties");
    if (!nav) return false;
    panel = C.el("section", null, "panel panel-nets"); panel.setAttribute("aria-labelledby", "nets-heading"); panel.hidden = true;
    const head = C.el("header", null, "pane-heading"), h2 = C.el("h2", "Nets"); h2.id = "nets-heading";
    const close = C.button("×", () => toggle(false), "ui-close nets-close", "Close Nets panel");
    head.append(h2, close);
    const tools = C.el("div", null, "nets-tools");
    const search = C.el("input", null, "ui-field"); search.type = "search"; search.placeholder = "Filter nets"; search.setAttribute("aria-label", "Filter nets");
    search.oninput = () => {state.query = search.value; paint();};
    // The library search field: static .ui-search markup that AtriumUIKit adopts (clear button, count, Escape).
    // The net count lives in the field (.ui-search-count), not in the heading.
    const countNode = C.el("span", null, "ui-search-count");
    const find = C.el("div", null, "ui-search nets-search"); find.dataset.size = "compact"; find.append(C.icon("search"), search, countNode); globalThis.AtriumUIKit?.adoptSearch(search);
    const clsPick = C.el("select", null, "ui-compact-field"); clsPick.setAttribute("aria-label", "Net class");
    clsPick.onchange = () => {state.cls = clsPick.value; paint();};
    const byClass = C.button("Colour by class", colourByClass, "nets-small ui-button", "Give every net class its own colour (one undo step)");
    const clear = C.button("Clear colours", clearColours, "nets-small ui-button", "Remove all net colours");
    const toggleBtn = C.button("Override", () => setOverride(!N.override()), "nets-small nets-override ui-button");
    const route = C.button("Route",()=>routeSelected(view[active]),"nets-small ui-button");
    toggleBtn.setAttribute("aria-label", "Net colour override");
    C.shortcutTitle(route, "Route selected net or differential pair", "R");
    for (const b of [byClass, clear, toggleBtn, route]) b.dataset.size = "sm";
    tools.append(find,clsPick,route,byClass,clear,toggleBtn);
    const scroller = C.el("div", null, "nets-scroll pane-scroll");
    const table = C.el("table", null, "nets-table"), thead = C.el("thead"), hr = C.el("tr"), tbody = C.el("tbody");
    table.tabIndex = 0; table.setAttribute("role", "grid"); table.setAttribute("aria-label", "Nets");
    const help = C.el("p", "Use arrow keys to choose a net and Enter to highlight it. Shift+Enter zooms to it. On a board, press R to route it, C to set its colour or Delete to clear it.", "visually-hidden");
    help.id = "nets-grid-help"; table.setAttribute("aria-describedby", help.id);
    const swatch = C.el("th", null, "nets-sw");
    swatch.scope = "col"; swatch.append(C.el("span", "Colour", "visually-hidden")); hr.append(swatch);
    hr.setAttribute("aria-rowindex", "1");
    const sorters = {};
    for (const [key, label] of COLS) {
      const th = C.el("th", null, "nets-col-" + key), b = C.button(label, () => {state.dir = state.sort === key ? -state.dir : 1; state.sort = key; paint();});
      th.scope = "col"; th.append(b); hr.append(th); sorters[key] = th;
    }
    thead.append(hr); table.append(thead, tbody); scroller.append(table);
    const picker = C.el("input"); picker.type = "color"; picker.className = "nets-picker"; picker.tabIndex = -1; picker.setAttribute("aria-hidden", "true");
    panel.append(head, tools, help, scroller, picker);
    nav.append(panel);
    const grid = AtriumWindowedTable(scroller, tbody, () => hr.querySelectorAll("th:not([hidden])").length, paintRow, {rowHeight:22});
    ui = {countNode, find, search, clsPick, scroller, table, tbody, grid, sorters, picker, toggleBtn, route};
    globalThis.AtriumKeymap?.onChange(overrideShortcut);
    tbody.addEventListener("click", e => {
      const tr = e.target.closest("tr[data-r]"); if (!tr) return;
      const r = Number(tr.dataset.r);
      if (e.target.closest(".nets-swatch")) {choose(r); pickColour(view[r]); return;}
      choose(r); highlight(view[r]);
    });
    tbody.addEventListener("dblclick", e => {const tr = e.target.closest("tr[data-r]"); if (tr) {choose(Number(tr.dataset.r)); zoom(view[Number(tr.dataset.r)]);}});
    table.addEventListener("keydown", keys);
    picker.addEventListener("input", () => setColour(picker.dataset.net, picker.value, true));
    picker.addEventListener("change", () => setColour(picker.dataset.net, picker.value, false));
    return true;
  }
  function keys(e) {
    if (e.target !== ui.table) return;
    const step = {ArrowDown:1, ArrowUp:-1, PageDown:12, PageUp:-12}[e.key];
    if (step || e.key === "Home" || e.key === "End") {
      e.preventDefault(); e.stopPropagation();
      if (!view.length) return;
      choose(e.key === "Home" ? 0 : e.key === "End" ? view.length - 1 : Math.max(0, Math.min(view.length - 1, (active < 0 ? -1 : active) + step)));
      return;
    }
    const r = view[active];
    if (e.key.toLowerCase()==="r" && r && host.doc().kind==="pcb" && !e.ctrlKey && !e.metaKey) {e.preventDefault();e.stopPropagation();routeSelected(r);return;}
    if (e.key === "Enter" && r) {e.preventDefault(); e.stopPropagation(); if (e.shiftKey) zoom(r); else highlight(r); return;}
    if ((e.key === "c" || e.key === "C") && r && !e.ctrlKey && !e.metaKey) {e.preventDefault(); e.stopPropagation(); pickColour(r); return;}
    if ((e.key === "Delete" || e.key === "Backspace") && r && colors(host.doc())[r.name]) {e.preventDefault(); e.stopPropagation(); setColour(r.name, "", false); return;}
    if (e.key === "Escape") {e.preventDefault(); e.stopPropagation(); host.setHighlight(""); host.canvas()?.focus(); return;}
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  }
  function paintRow(tr, r, i) {
    const d = host.doc(), pcb = d.kind === "pcb";
    tr.setAttribute("aria-selected", String(i === active));
    tr.setAttribute("aria-rowindex", String(i + 2));
    tr.id = i === active ? "nets-active-row" : "";
    if (r.name === host.highlight()) tr.classList.add("is-lit");
    if (pcb) {
      const col = colors(d)[r.name], sw = C.el("td", null, "nets-sw"), b = C.el("span", null, "nets-swatch");
      if (col) b.style.setProperty("--swatch", col); else b.classList.add("is-empty");
      b.title = col ? "Net colour " + col + " (click to change, Delete clears)" : "Assign a net colour";
      sw.append(b); tr.append(sw);
    }
    const name = C.el("td", r.name, "nets-col-name"); name.title = r.name + (r.shorted ? " · shorted to another net" : "");
    if (r.shorted || r.conflict) name.classList.add("is-bad");
    tr.append(name, C.el("td", r.cls, "nets-col-cls"), C.el("td", String(r.nodes ?? ""), "num"));
    if (pcb) {
      const unit = host.units();
      tr.append(C.el("td", r.length == null ? "—" : A().units.format(r.length, unit, unit === "mil" ? 0 : 2), "num"),
        C.el("td", r.unrouted == null ? "—" : String(r.unrouted), "num" + (r.unrouted ? " is-warn" : "")));
    }
  }
  function overrideShortcut() {
    if (panel.hidden) return;
    const K = globalThis.AtriumKeymap, key = K?.hintKey("net-colours", host.doc().kind);
    if (key) {
      if (!ui.toggleBtn.firstElementChild) ui.toggleBtn.textContent = "";
      C.shortcutBadge(ui.toggleBtn, key);
    } else if (ui.toggleBtn.textContent !== "Override") ui.toggleBtn.textContent = "Override";
    C.shortcutTitle(ui.toggleBtn, "Net colour override on the board", key);
  }
  function paint() {
    if (!panel || panel.hidden) return;
    overrideShortcut();
    if (dirty) compute();
    const prev = view[active]?.name;
    view = filtered();
    active = prev ? view.findIndex(r => r.name === prev) : -1;
    const classes = [...new Set(rows.map(r => r.cls).filter(Boolean))].sort();
    const sig = classes.join("|");
    if (ui.clsPick.dataset.sig !== sig) {
      ui.clsPick.replaceChildren(new Option("All classes", ""), ...classes.map(c => new Option(c, c)));
      ui.clsPick.dataset.sig = sig; ui.clsPick.value = classes.includes(state.cls) ? state.cls : "";
      ui.clsPick.hidden = !classes.length;
    }
    const d = host.doc();
    const counted = view.length === rows.length ? String(rows.length) : view.length + " of " + rows.length;
    if (ui.find.setCount) ui.find.setCount(counted); else ui.countNode.textContent = counted;
    for (const [key] of COLS) ui.sorters[key].setAttribute("aria-sort", state.sort === key ? (state.dir > 0 ? "ascending" : "descending") : "none");
    for (const n of panel.querySelectorAll(".nets-col-length,.nets-col-unrouted,thead .nets-sw,.nets-small")) n.hidden = d.kind !== "pcb";
    ui.route.disabled=active<0;
    ui.toggleBtn.setAttribute("aria-pressed", String(N.override()));
    ui.table.setAttribute("aria-rowcount", String(view.length + 1));
    ui.grid.refresh(view);
    if (active >= 0) ui.table.setAttribute("aria-activedescendant", "nets-active-row"); else ui.table.removeAttribute("aria-activedescendant");
  }
  function choose(i) {active = i;ui.route.disabled=i<0; ui.grid.scrollTo(i); if (active >= 0) ui.table.setAttribute("aria-activedescendant", "nets-active-row");}
  async function routeSelected(row) {
    const d=host.doc(); if(!row||d.kind!=="pcb")return;
    try{
      await globalThis.AtriumLazy?.need?.("AtriumRouter");
      if(host.doc()===d && !panel.hidden && view[active]?.name===row.name)host.routeSelectedNet(row.name);
    }catch(error){host.info(error.message);}
  }
  function currentRow(row) {
    if (!row || !dirty) return row;
    paint();
    return view.find(r => r.name === row.name);
  }
  function highlight(r) {
    r = currentRow(r);
    if (!r) return;
    const on = host.highlight() !== r.name;
    host.setHighlight(on ? r.name : "", on && r.compiled ? CP.compiledNetMembers(r.compiled) : null);
    host.info(on ? "Net " + r.name + " highlighted · " + r.nodes + " nodes" + (r.unrouted ? " · " + r.unrouted + " unrouted" : "") : "Highlight cleared");
    paint();
  }
  function zoom(r) {
    r = currentRow(r);
    if (!r) return;
    const doc = host.doc(), defs = host.defs();
    const members = r.compiled ? CP.compiledNetMembers(r.compiled) : null;
    const local = members?.get(doc.id)?.get(r.instanceId);
    let box = null;
    if (local) {
      for (const item of doc.items) if (local.ids.has(item.id)) box = C.union(box, C.itemBox(doc, defs, item));
      for (const {pin} of local.pins) box = C.union(box, [pin.at[0] - 1, pin.at[1] - 1, pin.at[0] + 1, pin.at[1] + 1]);
    } else box = CP?.netObjects(doc, defs, r.name)?.box;
    host.setHighlight(r.name, members);
    if (box) host.zoomTo(box);
    paint();
  }
  function pickColour(r) {
    if (!r || host.doc().kind !== "pcb") return;
    ui.picker.dataset.net = r.name; ui.picker.value = colors(host.doc())[r.name] || PALETTE[rows.indexOf(r) % PALETTE.length];
    ui.picker.click();
  }
  let previewing = null;
  function setColour(net, value, preview) {
    const d = host.doc();
    if (!net || d.kind !== "pcb") return;
    if (preview) {previewing = {net, value}; host.invalidate(); return;}
    previewing = null;
    host.edit(() => {
      const map = {...colors(d)};
      if (value) map[net] = value; else delete map[net];
      if (Object.keys(map).length) d.netColors = map; else delete d.netColors;
    });
    if (value && !N.override()) setOverride(true);
    host.info(value ? "Net " + net + " coloured " + value : "Net colour removed from " + net);
  }
  function colourByClass() {
    const d = host.doc();
    if (d.kind !== "pcb") return;
    const next = classColours(rows);
    if (!Object.keys(next).length) {host.info("This board has no net classes. Define them in Design → Rules…"); return;}
    host.edit(() => {d.netColors = {...colors(d), ...next};});
    setOverride(true);
    host.info("Coloured " + Object.keys(next).length + " nets by class");
  }
  function clearColours() {
    const d = host.doc();
    if (!d.netColors) return;
    host.edit(() => {delete d.netColors;});
    host.info("Net colours cleared");
  }
  function toggle(show) {
    if (!panel && !build()) return;
    const on = show ?? panel.hidden;
    panel.hidden = !on;
    if (on && !globalThis.AtriumDock) document.body.classList.remove("hide-right");
    C.setChecked("nets-panel", on);
    if (on) {dirty = true; paint(); ui.table.focus({preventScroll:true});}
    else host.canvas()?.focus();
  }
  function reveal(net) {
    toggle(true);
    state.query = ""; ui.search.value = ""; state.cls = "";
    paint();
    const i = view.findIndex(r => r.name === net);
    if (i >= 0) choose(i);
    paint();
  }
  function schedule() {dirty = true; if (!panel || panel.hidden) return; clearTimeout(timer); timer = setTimeout(paint, 120);}

  return {
    toggle(h, show) {host = h; toggle(show);},
    reveal(h, net) {host = h; reveal(net);},
    isOpen:() => !!panel && !panel.hidden, rows:() => rows.slice(), preview:() => previewing,
    schedule, highlight() {if (panel && !panel.hidden) ui.grid.refresh();},
    syncOverride(on) {ui?.toggleBtn.setAttribute("aria-pressed", String(on));}
  };
})();
