"use strict";
// Thermal panel (Tools › Thermal): Current Capacity Check (IPC-2152, ipc2152.js) and Temperature
// Rise Map (thermal.js). Non-modal and docked at the right like the PDN Analyzer, so the board
// and the temperature overlay stay live. The map is an ESTIMATE: the panel says so, with its
// assumptions. Design › Rules › Current Capacity opens the Rules editor on that rule type.
//
// The overlay draws through AtriumNavHost.addRenderer (no canvas.js change): the renderer
// returns null unless the panel is open, the map is on and a result for this board exists, so a
// hidden overlay costs one function call per frame.
globalThis.AtriumThermalView = (() => {
  const TH = () => globalThis.AtriumThermal, CC = () => globalThis.AtriumIPC2152;
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const fin = Number.isFinite;
  const r2 = v => fin(v) ? Math.round(v * 100) / 100 + 0 : v;
  let H = null, dlg = null, ui = null, setup = null, docId = null, job = null, stamp = 0;
  const view = {tab: "map", show: "on", layer: "active", sub: "hotspots", fade: 1};
  const state = {map: null, check: null, opts: {max_rise: 10, method: "ipc2152", source: "both"}};
  const images = new Map();
  const WARN_C = 100;   // absolute °C at which a hotspot becomes a Warning in Messages

  function el(tag, text, cls, attrs) { return AtriumNavCommon.elWithAttributes(tag, text, cls, attrs, {omitNull:true}); }
  const button = (text, act, cls, title) => globalThis.AtriumUI.nativeButton(text, act, cls, title);
  function option(sel, value, label, selected) { const o = el("option", label); o.value = value; if (selected) o.selected = true; sel.append(o); return o; }
  const fmtA = v => CC()?.fmtA ? CC().fmtA(v) : String(v);
  const fmtT = v => !fin(v) ? "—" : v.toFixed(1) + " °C";
  const board = () => { const d = H?.doc?.(); return d?.kind === "pcb" ? d : null; };
  const say = (t, kind) => { if (!ui) return; ui.status.textContent = t; ui.status.dataset.kind = kind || ""; };
  // Is the PCB canvas dark? (the ramp runs dark → light on dark canvases, light → dark on light ones)
  function darkCanvas() {
    try {
      const T = globalThis.AtriumTheme, ws = T?.canvasPalette?.("pcb")?.workspace;
      if (ws && T.color?.luminance) return T.color.luminance(T.color.hex ? T.color.hex(ws) : ws) < .3;
    } catch { /* default below */ }
    return true;
  }

  // ---------------------------------------------------------------- dialog
  function open(host, tab) {
    H = host || H;
    let doc = H.doc();
    if (doc?.kind !== "pcb") {
      const b = H.project().documents.find(d => d.kind === "pcb");
      if (!b) { H.info("Open a board layout for the thermal checks."); return null; }
      H.selectDocument(b.id); doc = H.doc();
    }
    if (tab) view.tab = tab;
    if (dlg?.open) { paint(); dlg.querySelector("button, select, input")?.focus(); return dlg; }
    load(doc);
    const d = el("dialog", null, "work-dialog ui-dialog ui-sheet thm-dialog", {"aria-labelledby": "thm-heading"});
    dlg = d;
    const head = el("div", null, "thm-head");
    const close = button("", () => d.close(), "thm-close", "Close the thermal panel"); close.setAttribute("aria-label", "Close");
    const title = el("h2", "Thermal", null, {id: "thm-heading"});
    head.append(title, close);
    const tabs = el("div", null, "thm-seg ui-tabs", {role: "tablist", "aria-label": "Thermal check"});
    const status = el("p", null, "thm-status", {role: "status", "aria-live": "polite"});
    const body = el("div", null, "thm-body", {id: "thm-mode-panel", role: "tabpanel"});
    d.append(head, tabs, status, body);
    d.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); d.close(); return; }
      if (e.target.closest?.(".ui-tabs, .ui-segmented") && /^(Arrow(Left|Right|Up|Down)|Home|End)$/.test(e.key)) return;
      e.stopPropagation();
    });
    d.addEventListener("close", () => { job?.cancel(); job = null; save(); if (dlg === d) { dlg = null; ui = null; } d.remove(); H.invalidate(); });
    ui = {d, tabs, status, body, readout: null};
    paint();
    globalThis.AtriumShell.adoptDialog(d, {title, body, sheet: true, defaultAction: false});
    document.body.append(d); d.show();
    body.querySelector("button, select, input")?.focus({preventScroll: true});
    return d;
  }
  function load(doc) { setup = TH().read(doc); docId = doc.id; }
  function save() {
    const doc = board();
    if (!doc || doc.id !== docId || !setup) return;
    const next = TH().normalize(setup);
    if (JSON.stringify(next) === JSON.stringify(TH().read(doc)) && doc.thermal) return;
    if (!doc.thermal && JSON.stringify(next) === JSON.stringify(TH().normalize({}))) return;   // defaults: nothing to store
    try { H.edit(() => { TH().write(doc, next); }); } catch (e) { H.info?.(e.message); }
  }
  function paint() {
    if (!ui) return;
    // The tabs are rebuilt on every paint: a tab chosen by keyboard keeps focus, one tab stop, arrows switch (WAI-ARIA tabs).
    const active = document.activeElement, had = ui.tabs.contains(active), keys = ["map", "current"];
    const resultTabs = ui.body.contains(active?.closest(".thm-tabs"));
    const overlay = ui.body.contains(active?.closest(".thm-seg[role=radiogroup]"));
    ui.tabs.replaceChildren();
    for (const [k, t] of [["map", "Temperature Rise Map"], ["current", "Current Capacity"]]) {
      const b = button(t, () => { view.tab = k; paint(); H.invalidate(); }, "thm-seg-b ui-tab");
      b.setAttribute("role", "tab"); b.id = "thm-mode-" + k;
      const selected = view.tab === k;
      b.setAttribute("aria-selected", String(selected)); b.tabIndex = selected ? 0 : -1;
      if (selected) b.setAttribute("aria-controls", ui.body.id);
      ui.tabs.append(b);
    }
    ui.tabs.onkeydown = e => {
      const step = {ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1}[e.key];
      if (!step) return;
      e.preventDefault(); view.tab = keys[(keys.indexOf(view.tab) + step + keys.length) % keys.length]; paint(); H.invalidate();
    };
    ui.body.setAttribute("aria-labelledby", "thm-mode-" + view.tab);
    ui.body.replaceChildren();
    if (view.tab === "current") paintCurrent(); else paintMap();
    if (had) ui.tabs.querySelector('[aria-selected="true"]')?.focus({preventScroll: true});
    if (resultTabs) ui.body.querySelector('.thm-tabs [aria-selected="true"]')?.focus({preventScroll: true});
    if (overlay) ui.body.querySelector('.thm-seg [aria-checked="true"]')?.focus({preventScroll: true});
  }
  const field = (label, input, unit, cls) => globalThis.AtriumUIKit.analysisField(label, input, unit, cls, "thm");
  const numInput = (value, onValue, opts) => globalThis.AtriumUIKit.nullableNumber(value, onValue, opts);
  function select(options, value, onValue, label) {
    const s = el("select", null, "ui-field", {"aria-label": label});
    for (const [k, t] of options) option(s, k, t, k === value);
    s.onchange = () => onValue(s.value);
    return s;
  }
  function check(label, on, onValue) {
    const lab = el("label", null, "thm-check"), c = el("input", null, "ui-checkbox", {type: "checkbox"});
    c.checked = !!on; c.onchange = () => onValue(c.checked);
    lab.append(c, el("span", label));
    return lab;
  }
  function table(cols, rows, empty = "Nothing to report.") {
    return AtriumUIKit.analysisTable(cols, rows, row => {
      const tr = el("tr", null, "thm-row" + (row.status ? " thm-" + row.status : ""));
      tr.tabIndex = 0;
      for (const c of row.cells) tr.append(el("td", c));
      const go = () => { if (row.id) { try { H.select([row.id], row.id); } catch { /* gone */ } } if (row.at) H.centerOn?.(row.at); H.invalidate(); };
      tr.onclick = go; tr.onkeydown = e => { if (e.key === "Enter") go(); };
      return tr;
    }, {wrapClass: "thm-table-wrap", tableClass: "thm-table", empty, emptyClass: "thm-empty"});
  }

  // ---------------------------------------------------------------- Current Capacity Check
  function paintCurrent() {
    const box = ui.body, o = state.opts, doc = board();
    const grid = el("div", null, "thm-grid");
    grid.append(field("Allowed rise", numInput(o.max_rise, v => { o.max_rise = v > 0 ? v : 10; }, {min: "1", unit:"Δ°C",label: "Allowed temperature rise (°C)"}), "°C"),
      field("Method", select(Object.entries(CC().METHODS), o.method, v => { o.method = v; }, "Method")),
      field("Current", select([["both", "Larger of required and PDN"], ["rule", "Required (Net/Class currents)"], ["pdn", "PDN Analyzer currents"]], o.source, v => { o.source = v; }, "Current source"), null, "thm-wide"));
    const hasRule = (() => { try { return (globalThis.AtriumRules?.effective?.(doc, H.project())?.list || []).some(r => r.type === "currentCapacity"); } catch { return false; } })();
    box.append(el("p", hasRule ? "The board's Current Capacity rules set the scopes and limits; the rise and method here apply where no rule does." :
      "No Current Capacity rule yet: every net with a current is checked with these settings. Add a rule for per-net currents.", "thm-note"), grid);
    const bar = el("div", null, "work-actions ui-dialog-actions thm-actions");
    bar.append(button("Current Capacity Rule…", () => rulesEditor(), "", "Design › Rules › Current Capacity"), button("Send to Messages", () => currentMessages(true), "", "List the failing conductors in Messages"),
      button("Check", () => runCheck(), "is-primary", "Check every track, pad and via of the nets with a current"));
    box.append(bar);
    const R = state.check;
    if (!R || R.docId !== doc?.id) { box.append(el("p", "Check to list every conductor of the nets with a current, worst first.", "thm-empty")); return; }
    const res = R.res, s = res.summary;
    box.append(el("p", s.checked + " conductor" + (s.checked === 1 ? "" : "s") + " on " + s.nets + " net" + (s.nets === 1 ? "" : "s") + " · " + (s.failing ? s.failing + " over the allowed rise" : "all within the allowed rise") +
      " · worst rise " + fmtT(s.worstRise) + (s.pdn ? " · PDN currents used" : ""), "thm-summary"));
    box.append(table(["Object", "Net", "Size", "Current", "Allowed", "Rise", ""], res.rows.slice(0, 500).map(x => ({id: x.id, at: x.at, status: x.ok ? "ok" : "fail",
      cells: [x.kind === "via" ? "Via" : x.kind === "pad" ? x.label.replace(/ \S+$/, "") : "Track " + x.layer, x.net, x.kind === "via" ? r2(x.drill) + " mm hole" : r2(x.width) + " mm",
        fmtA(x.current) + (x.basis === "pdn" ? " PDN" : ""), fmtA(x.allowed), fmtT(x.rise), x.ok ? "OK" : "Over"]})), "No net has a current. Set one in a Current Capacity rule, or analyse the power nets in Tools › PDN Analyzer."));
    const notes = el("ul", null, "thm-notes");
    for (const n of res.notes) notes.append(el("li", n));
    notes.append(el("li", "Each conductor is treated as isolated in still air (IPC-2152). Neighbouring heat adds to the rise: see the Temperature Rise Map."));
    box.append(notes);
  }
  function runCheck() {
    const doc = board();
    if (!doc) return;
    try {
      const res = CC().check(doc, H.defs(), state.opts, H.project());
      state.check = {docId: doc.id, res};
      say("Checked " + res.summary.checked + " conductors in " + res.summary.ms + " ms" + (res.summary.failing ? " · " + res.summary.failing + " over the allowed rise" : ""), res.summary.failing ? "warn" : "ok");
      currentMessages(false);
    } catch (e) { say(e.message, "error"); }
    paint(); H.invalidate();
  }
  function currentMessages(show) {
    const M = globalThis.AtriumMessages, R = state.check;
    if (!M || !R) return;
    const name = H.project().documents.find(x => x.id === R.docId)?.name || "";
    const list = R.res.violations.map(v => ({class: v.severity, source: "Current Capacity", text: v.title + ": " + v.detail, document: name, documentId: R.docId, objectId: v.id || null, point: v.at || null}));
    list.push({class: "Info", source: "Current Capacity", text: "Current capacity: " + R.res.summary.checked + " conductors checked, " + R.res.summary.failing + " over the allowed rise.", document: name, documentId: R.docId});
    if (show) M.show(H.messageContext?.(), {title: "Current Capacity", group: "Current Capacity", messages: list, focus: true}); else M.set("Current Capacity", list);
  }
  // Design › Rules › Current Capacity: the Rules editor, opened on that rule type.
  function rulesEditor() {
    if (!board()) { H.info("Open a board layout first."); return; }
    H.act("rules");
    let tries = 0;
    const pick = () => {
      const tree = document.querySelector("dialog.rules-editor[open] [role=tree]");
      const item = tree && [...tree.querySelectorAll("[role=treeitem]")].find(n => /^Current Capacity\b/.test(n.textContent.trim()));
      if (item) { item.click(); item.focus?.(); return; }
      if (++tries < 40) setTimeout(pick, 50);
    };
    setTimeout(pick, 0);
  }

  // ---------------------------------------------------------------- Temperature Rise Map
  function paintMap() {
    const box = ui.body, S = setup, doc = board();
    box.append(el("p", "Estimate: a steady-state grid model of copper, dielectric and vias with convection. Check critical parts with a full thermal simulation.", "thm-estimate"));
    const grid = el("div", null, "thm-grid");
    const airSel = select([["natural", "Natural air (h 10)"], ["forced-1", "Forced air ≈ 1 m/s (h 25)"], ["forced-3", "Forced air ≈ 3 m/s (h 50)"], ["forced-5", "Forced air ≈ 5 m/s (h 80)"], ["custom", "Custom h"]], S.air,
      v => { S.air = v; if (v !== "custom") { S.hTop = S.hBottom = TH().AIR[v]; } paint(); }, "Air");
    grid.append(field("Ambient", numInput(S.ambient, v => { S.ambient = v ?? 25; }, {label: "Ambient temperature (°C)"}), "°C"), field("Air", airSel));
    if (S.air === "custom") grid.append(field("h top", numInput(S.hTop, v => { S.hTop = v ?? 10; }, {min: "0.1", label: "Top face h (W/m²·K)"}), "W/m²K"), field("h bottom", numInput(S.hBottom, v => { S.hBottom = v ?? 10; }, {min: "0.1", label: "Bottom face h (W/m²·K)"}), "W/m²K"));
    grid.append(field("Board edges", select([["adiabatic", "Insulated"], ["convective", "Convective"], ["fixed", "Held at ambient"]], S.edge, v => { S.edge = v; paint(); }, "Board edges")));
    if (S.edge === "convective") grid.append(field("h edge", numInput(S.hEdge, v => { S.hEdge = v ?? 10; }, {min: "0", label: "Edge h (W/m²·K)"}), "W/m²K"));
    box.append(grid);
    const inc = el("div", null, "thm-bar");
    inc.append(check("Component power", S.includeParts, v => { S.includeParts = v; }), check("PDN I²R losses", S.includePDN, v => { S.includePDN = v; }));
    box.append(inc);
    // Powers.
    let list = [];
    try { list = TH().powers(doc, H.defs(), H.project(), S); } catch { list = []; }
    const more = el("details", null, "thm-more");
    more.append(el("summary", "Component power (" + list.length + " part" + (list.length === 1 ? "" : "s") + ", " + r2(list.reduce((s, p) => s + p.power, 0)) + " W)"));
    const pt = el("table", null, "thm-table thm-powers"), tb = el("tbody"), hr = el("tr");
    for (const c of ["Part", "Power", "From"]) hr.append(el("th", c, null, {scope: "col"}));
    const th = el("thead"); th.append(hr); pt.append(th, tb);
    for (const p of list) {
      const tr = el("tr"), inp = numInput(p.power, v => { S.power[p.ref] = Math.max(0, v ?? 0); }, {min: "0", unit:"W",label: p.ref + " power (W)"});
      const td = el("td"); td.append(inp, el("span", "W", "thm-unit"));
      tr.append(el("td", p.ref), td, el("td", p.source));
      tb.append(tr);
    }
    if (!list.length) { const tr = el("tr"); tr.append(el("td", "No part has a power. Add \"Power Dissipation\" (W) to the parts, or add the selected parts here.", "thm-empty", {colspan: "3"})); tb.append(tr); }
    const pbar = el("div", null, "thm-bar");
    pbar.append(button("Add selected", () => {
      const ids = new Set(H.selection()), parts = doc.items.filter(i => ids.has(i.id) && i.kind === "part" && i.ref);
      if (!parts.length) { say("Select parts on the board first."); return; }
      for (const p of parts) if (!(S.power[p.ref] > 0)) S.power[p.ref] = .5;
      paint();
    }, "", "Give the selected parts a power (0.5 W; edit it in the table)"));
    more.append(pt, pbar);
    box.append(more);
    // Heatsinks.
    const hs = el("details", null, "thm-more");
    hs.append(el("summary", "Heatsinks (" + S.sinks.length + ")"));
    const hbody = el("div", null, "thm-sinks");
    S.sinks.forEach((s, i) => {
      const row = el("div", null, "thm-bar");
      row.append(el("span", (s.name || "Heatsink " + (i + 1)) + " · " + s.side, "thm-label"),
        select([["h", "h"], ["fixed", "Held at"]], s.mode, v => { s.mode = v; paint(); }, "Heatsink kind"),
        s.mode === "fixed" ? field("", numInput(s.rise, v => { s.rise = v ?? 0; }, {unit:"Δ°C",label: "Rise held (°C above ambient)"}), "°C rise") : field("", numInput(s.h, v => { s.h = v ?? 1000; }, {min: "0", label: "Heatsink h (W/m²·K)"}), "W/m²K"),
        button("Remove", () => { S.sinks.splice(i, 1); paint(); }, "", "Remove this heatsink"));
      hbody.append(row);
    });
    const addSink = side => () => {
      const ids = new Set(H.selection()), sel = doc.items.filter(i => ids.has(i.id));
      let b = null;
      for (const i of sel) {
        const pts = Array.isArray(i.points) ? i.points : fin(i.x) ? [[i.x - 2, i.y - 2], [i.x + 2, i.y + 2]] : [];
        for (const p of pts) b = b ? [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])] : [p[0], p[1], p[0], p[1]];
      }
      if (!b) { say("Select the objects the heatsink covers first."); return; }
      S.sinks.push({id: "sink" + Date.now().toString(36), name: "", side, box: b, mode: "h", h: 1000, rise: 0});
      paint();
    };
    hbody.append(el("div", null, "thm-bar"));
    hbody.lastChild.append(button("Add on top over selection", addSink("top"), "", "A heatsink on the top face over the selected objects (h 1000 W/m²·K)"), button("Add on bottom", addSink("bottom"), "", "A heatsink or cold plate on the bottom face"));
    hs.append(hbody);
    box.append(hs);
    const adv = el("details", null, "thm-more");
    adv.append(el("summary", "Grid and materials"));
    const ag = el("div", null, "thm-grid");
    ag.append(field("Grid pitch", numInput(S.pitch, v => { S.pitch = v; }, {min: "0", label: "Grid pitch (mm)", placeholder: "auto"}), "mm"),
      field("Node cap", numInput(S.maxNodes / 1000, v => { S.maxNodes = Math.round((v ?? 300) * 1000); }, {min: "1", label: "Grid node cap (thousands)"}), "k"),
      field("Dielectric k ⊥", numInput(S.kz, v => { S.kz = v ?? .3; }, {min: "0.01", label: "FR-4 through-plane conductivity (W/m·K)"}), "W/m·K"),
      field("Dielectric k ∥", numInput(S.kxy, v => { S.kxy = v ?? .8; }, {min: "0.01", label: "FR-4 in-plane conductivity (W/m·K)"}), "W/m·K"),
      field("Via plating", numInput(r2(S.plating * 1000), v => { S.plating = (v ?? 25) / 1000; }, {min: "1", label: "Via plating (µm)"}), "µm"));
    adv.append(ag);
    box.append(adv);
    const bar = el("div", null, "work-actions ui-dialog-actions thm-actions");
    ui.run = button("Solve", () => solveMap(), "is-primary", "Solve the temperature rise");
    bar.append(button("Send to Messages", () => mapMessages(true), "", "List the hotspots in Messages"), ui.run);
    box.append(bar);
    paintResult();
  }
  function current() {
    const doc = board(), R = state.map;
    return doc && R && R.docId === doc.id ? R : null;
  }
  function paintResult() {
    const box = ui.body, R = current();
    if (!R) { box.append(el("p", "Solve to see the temperature rise on the board.", "thm-empty")); return; }
    const rep = R.report, s = rep.summary;
    const ctl = el("div", null, "thm-bar");
    const seg = el("div", null, "thm-seg ui-segmented", {role: "radiogroup", "aria-label": "Overlay"});
    for (const [k, t] of [["on", "Map on"], ["off", "Off"]]) {
      const b = button(t, () => { view.show = k; paint(); H.invalidate(); }, "thm-seg-b ui-segment");
      b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(view.show === k));
      b.tabIndex = view.show === k ? 0 : -1; seg.append(b);
    }
    const layerSel = el("select", null, "ui-field", {"aria-label": "Layer shown"});
    option(layerSel, "active", "Active layer", view.layer === "active");
    for (const l of rep.layers) option(layerSel, l.layer, l.layer + " (max +" + l.maxRise + " °C)", view.layer === l.layer);
    layerSel.onchange = () => { view.layer = layerSel.value; images.clear(); H.invalidate(); };
    ctl.append(seg, layerSel);
    box.append(ctl);
    const dark = darkCanvas(), legend = el("div", null, "thm-legend", {role: "img", "aria-label": "Temperature rise " + scale(R).lo.toFixed(1) + " to " + s.maxRise + " °C above " + s.ambient + " °C ambient"});
    const bar = el("div", null, "thm-ramp");
    bar.style.backgroundImage = TH().gradient(dark);
    legend.append(el("span", "+" + scale(R).lo.toFixed(1) + " °C", "thm-tick"), bar, el("span", "+" + s.maxRise + " °C", "thm-tick"));
    box.append(legend, el("p", "Rise above " + s.ambient + " °C ambient · peak " + s.maxTemperature + " °C on " + s.layer + " · " + s.power + " W (" + s.partsPower + " W parts, " + s.pdnPower + " W I²R)" + (R.revision !== H.revision() ? " · the board has changed since: solve again" : ""), "thm-summary"));
    ui.readout = el("p", "Hover over the board for a reading.", "thm-readout", {"aria-live": "off"});
    box.append(ui.readout);
    const tabs = el("div", null, "thm-tabs ui-tabs", {role: "tablist", "aria-label": "Temperature results", "data-underline": ""}), body = el("div");
    for (const [k, t] of [["hotspots", "Hotspots (" + rep.hotspots.length + ")"], ["parts", "Parts"], ["model", "Model"]]) {
      const b = button(t, () => { view.sub = k; paint(); }, "thm-tab ui-tab");
      b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(view.sub === k));
      b.id = "thm-results-tab-" + k; b.tabIndex = view.sub === k ? 0 : -1;
      if (view.sub === k) b.setAttribute("aria-controls", "thm-results-panel");
      tabs.append(b);
    }
    body.id = "thm-results-panel"; body.setAttribute("role", "tabpanel");
    body.setAttribute("aria-labelledby", "thm-results-tab-" + view.sub);
    box.append(tabs, body);
    if (view.sub === "hotspots") body.append(table(["Where", "Layer", "Rise", "Temperature"], rep.hotspots.map(h => ({id: h.id, at: h.at, status: h.temperature >= WARN_C ? "fail" : "",
      cells: [(h.ref ? h.ref + " · " : "") + h.at[0].toFixed(1) + ", " + h.at[1].toFixed(1), h.layer, "+" + h.rise.toFixed(1) + " °C", h.temperature.toFixed(1) + " °C"]}))));
    if (view.sub === "parts") body.append(table(["Part", "Power", "Board under it", ""], rep.parts.map(p => ({id: p.id, at: p.at, status: p.temperature >= WARN_C ? "fail" : "",
      cells: [p.ref, p.power + " W", p.temperature == null ? "—" : p.temperature.toFixed(1) + " °C", p.source]})), "No powered parts."));
    if (view.sub === "model") {
      const list = el("ul", null, "thm-notes");
      list.append(el("li", "Grid " + s.pitch + " mm, " + s.nodes.toLocaleString() + " nodes, " + s.iterations + " CG iterations (MIC(0)), " + Math.round(R.ms) + " ms; energy balance " + (s.balance * 100).toFixed(3) + " %."));
      for (const a of rep.assumptions) list.append(el("li", a));
      list.append(el("li", "Not modelled: component bodies and their own cooling, air heating and flow direction, enclosures, transients, lead conduction in plated holes. Expect ±30 % on the rise."));
      for (const n of rep.notes) list.append(el("li", n));
      body.append(list);
    }
  }
  async function solveMap() {
    const doc = board();
    if (!doc) return;
    if (job) { job.cancel(); job = null; }
    save();
    const S = TH().normalize(setup), defs = H.defs(), t0 = now(), my = ++stamp;
    if (ui.run) ui.run.disabled = true;
    try {
      // PDN I²R: reuse fresh PDN Analyzer results for this board, else solve the saved setups.
      let pdn = [];
      if (S.includePDN && globalThis.AtriumPDN) {
        const P = AtriumPDN, saved = P.read(doc), rev = H.revision();
        const fresh = [...(globalThis.AtriumPDNView?._results?.values?.() || [])].filter(r => r.docId === doc.id && r.revision === rev);
        for (const n of saved.nets.filter(x => x.enabled)) {
          const hit = fresh.find(r => r.report?.net === n.net);
          if (hit) { pdn.push(Object.assign(hit.supply, {rho: P.rhoAt(saved.temperature)})); if (hit.ret) pdn.push(Object.assign(hit.ret, {rho: P.rhoAt(saved.temperature)})); continue; }
          for (const which of ["supply", "return"]) {
            if (which === "return" && !n.returnNet) continue;
            if (my !== stamp) return;
            say("PDN " + (which === "return" ? n.returnNet : n.net) + ": solving the current distribution…");
            try { const j = P.job(doc, defs, n, saved, which); job = P.run(j); pdn.push(Object.assign(await job.promise, {rho: P.rhoAt(saved.temperature)})); }
            catch (e) { if (e.message === "Cancelled.") return; }
          }
        }
      }
      if (my !== stamp) return;
      const j = TH().job(doc, defs, S, {project: H.project(), pdn});
      const phase = {raster: "Rasterising copper", assemble: "Assembling", factor: "Factorising", solve: "Solving", post: "Finishing"};
      job = TH().run(j, {onProgress: v => { if (my === stamp) say((phase[v.phase] || v.phase) + (v.done ? " · " + v.done + " iterations" : v.unknowns ? " · " + v.unknowns.toLocaleString() + " unknowns" : "") + "…"); }});
      const res = await job.promise;
      job = null;
      if (my !== stamp) return;
      const report = TH().report(doc, defs, j, res);
      state.map = {docId: doc.id, revision: H.revision(), job: j, res, report, stamp: my, ms: now() - t0};
      images.clear();
      say("Solved in " + Math.round(now() - t0) + " ms · peak rise +" + report.summary.maxRise + " °C (" + report.summary.maxTemperature + " °C) · an estimate", report.summary.maxTemperature >= WARN_C ? "warn" : "ok");
      mapMessages(false);
      fadeIn();
      paint(); H.invalidate();
    } catch (e) {
      job = null;
      if (my === stamp && e.message !== "Cancelled.") say(e.message, "error");
    } finally { if (ui?.run) ui.run.disabled = false; }
  }
  // The overlay eases in (AtriumMotion; instant when motion is off).
  function fadeIn() {
    const M = globalThis.AtriumMotion;
    if (!M?.animate || !M.enabled?.()) { view.fade = 1; return; }
    view.fade = 0;
    M.animate({duration: "base", ease: "decelerate", step: t => { view.fade = t; H.redraw?.(); }, done: () => { view.fade = 1; H.redraw?.(); }});
  }
  function mapMessages(show) {
    const M = globalThis.AtriumMessages, R = current();
    if (!M || !R) return;
    const name = H.project().documents.find(x => x.id === R.docId)?.name || "", s = R.report.summary;
    const list = R.report.hotspots.map(h => ({class: h.temperature >= WARN_C ? "Warning" : "Info", source: "Thermal", document: name, documentId: R.docId, objectId: h.id || null, point: h.at,
      text: "Hotspot (estimate) " + (h.ref ? "near " + h.ref + " " : "") + "on " + h.layer + ": +" + h.rise.toFixed(1) + " °C, " + h.temperature.toFixed(1) + " °C at " + s.ambient + " °C ambient"}));
    list.push({class: "Info", source: "Thermal", document: name, documentId: R.docId, text: "Temperature rise map (estimate): peak +" + s.maxRise + " °C, " + s.power + " W, " + s.pitch + " mm grid."});
    if (show) M.show(H.messageContext?.(), {title: "Thermal", group: "Thermal", messages: list, focus: true}); else M.set("Thermal", list);
  }

  // ---------------------------------------------------------------- overlay
  function layerIndex(R) {
    const key = view.layer === "active" ? (H.activeLayer?.() || "Top") : view.layer;
    let li = R.res.layers.findIndex(l => l.key === key);
    if (li < 0) li = /bottom/i.test(String(key)) ? R.res.layers.length - 1 : 0;   // a non-copper active layer: its side
    return li;
  }
  // One scale for every layer: the coolest to the hottest board cell (rise above ambient).
  function scale(R) { const s = R.report.summary, lo = fin(s.minRise) ? Math.max(0, s.minRise) : 0; return {lo, span: Math.max(1e-6, s.maxRise - lo)}; }
  function image(R, li, dark) {
    const key = R.stamp + "|" + li + "|" + dark;
    if (images.has(key)) return images.get(key);
    const g = R.res.grid, lay = R.res.layers[li], c = document.createElement("canvas");
    c.width = g.nx; c.height = g.ny;
    const ctx = c.getContext("2d"), img = ctx.createImageData(g.nx, g.ny), px = img.data, sc = scale(R);
    for (let i = 0; i < g.nx * g.ny; i++) {
      const v = lay.t[i];
      if (!(v === v)) continue;
      const col = TH().ramp((v - sc.lo) / sc.span, dark), o = 4 * i;
      px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = Math.round(190 * Math.min(1, R.res.board[i]));
    }
    ctx.putImageData(img, 0, 0);
    images.set(key, c);
    while (images.size > 8) images.delete(images.keys().next().value);
    return c;
  }
  function draw(g, info) {
    const R = current();
    if (!R || view.show === "off") return;
    const li = layerIndex(R), dark = darkCanvas(), gr = R.res.grid, c = image(R, li, dark);
    g.save();
    g.imageSmoothingEnabled = true;
    g.globalAlpha = view.fade;
    g.drawImage(c, gr.x0, gr.y0, gr.nx * gr.h, gr.ny * gr.h);
    g.restore();
    hover(g, info, R, li, dark);
  }
  function hover(g, info, R, li, dark) {
    const p = H.pointer?.();
    if (!p) return;
    const v = TH().sample(R.res, li, p), amb = R.report.summary.ambient, key = R.res.layers[li].key;
    const text = v === v && v != null ? key + " · +" + v.toFixed(1) + " °C · " + (amb + v).toFixed(1) + " °C (estimate)" : "";
    if (ui?.readout) { const t = text || "Hover over the board for a reading."; if (ui.readout.textContent !== t) ui.readout.textContent = t; }
    if (!text) return;
    const [sx, sy] = info.worldToScreen(p), dpr = info.dpr || 1;
    g.save();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.font = "11px system-ui, -apple-system, sans-serif"; g.textAlign = "left"; g.textBaseline = "alphabetic"; g.globalAlpha = .92;
    const w = g.measureText(text).width + 14, x = Math.min(sx + 14, (info.width || 1e4) / dpr - w - 4), y = sy + 16;
    g.fillStyle = dark ? "rgba(20,22,26,.9)" : "rgba(250,250,248,.94)"; g.fillRect(x, y, w, 18);
    const sc = scale(R);
    g.fillStyle = TH().rgb((v - sc.lo) / sc.span, dark); g.fillRect(x, y, 4, 18);
    g.fillStyle = dark ? "#f0efec" : "#1a1a19"; g.fillText(text, x + 9, y + 13);
    g.restore();
  }
  function install(host) {
    if (H === host) return;
    H = host;
    host.registerAction("thermal-map", () => open(host, "map"));
    host.registerAction("thermal-current-check", () => { open(host, "current"); runCheck(); });
    host.registerAction("rules-current-capacity", () => { H = host; rulesEditor(); });
    host.addRenderer(d => d?.kind === "pcb" && dlg?.open && view.show !== "off" && view.tab === "map" && current() ? {overlay: (g, info) => draw(g, info)} : null);
    host.on?.("document", () => {
      if (!dlg?.open) return;
      const doc = board();
      if (doc && doc.id !== docId) { save(); load(doc); paint(); }
    });
  }
  if (typeof document !== "undefined" && globalThis.AtriumNavCommon?.ready) AtriumNavCommon.ready(install);
  return Object.freeze({open: tab => open(H, tab), install, solve: () => solveMap(), check: () => runCheck(), rules: () => rulesEditor(),
    state: () => ({open: !!dlg?.open, tab: view.tab, setup, view: {...view}, map: state.map?.report || null, check: state.check?.res?.summary || null})});
})();
