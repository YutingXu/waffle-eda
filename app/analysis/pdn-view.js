"use strict";
// PDN Analyzer panel (Tools › PDN Analyzer…): the setup (power net, source, loads, return net,
// limits), the solve in a Web Worker (pdn.js), a heat map overlay of voltage or current density
// per layer with a legend and a hover readout, a results table and findings in Messages.
// Non-modal: the board stays live under the overlay. The setup is saved with the board (doc.pdn).
globalThis.AtriumPDNView = (() => {
  const P = () => globalThis.AtriumPDN;
  const r4 = v => Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 + 0 : v;
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  let H = null, dlg = null, ui = null, setup = null, cur = 0, docId = null, job = null;
  // Results per net-setup id: {report, supply, ret, docId, revision, stamp}
  const results = new Map();
  const view = {show: "voltage", which: "supply", layer: "active"};
  const images = new Map();   // cache: key -> canvas
  let stamp = 0;

  function el(tag, text, cls, attrs) { return AtriumNavCommon.elWithAttributes(tag, text, cls, attrs, {omitNull:true}); }
  const button = (text, act, cls, title) => globalThis.AtriumUI.nativeButton(text, act, cls, title);
  function option(sel, value, label, selected) { const o = el("option", label); o.value = value; if (selected) o.selected = true; sel.append(o); return o; }
  const fmtV = v => v == null || !Number.isFinite(v) ? "—" : (Math.abs(v) < 1 ? (v * 1000).toFixed(2) + " mV" : v.toFixed(4) + " V");
  const fmtmV = v => v == null || !Number.isFinite(v) ? "—" : (v * 1000).toFixed(2) + " mV";
  const fmtA = v => v == null || !Number.isFinite(v) ? "—" : (Math.abs(v) < 1 ? (v * 1000).toFixed(1) + " mA" : v.toFixed(3) + " A");
  const fmtJ = v => v == null || !Number.isFinite(v) ? "—" : (v < 10 ? v.toFixed(2) : v.toFixed(1)) + " A/mm²";
  const board = () => { const d = H?.doc?.(); return d?.kind === "pcb" ? d : null; };
  const netSetup = () => setup?.nets[cur] || null;

  // ---------------------------------------------------------------- data
  function load(doc) {
    setup = P().read(doc);
    docId = doc.id;
    if (!setup.nets.length) setup.nets.push(P().guess(doc, H.defs(), null, {project: H.project()}));
    cur = Math.min(cur, setup.nets.length - 1);
  }
  function save() {
    const doc = board();
    if (!doc || doc.id !== docId) return;
    const next = P().normalize(setup);
    if (JSON.stringify(next) === JSON.stringify(P().read(doc)) && doc.pdn) return;
    try { H.edit(() => { P().write(doc, next); }); } catch (e) { H.info?.(e.message); }
  }

  // ---------------------------------------------------------------- dialog
  function open(host) {
    H = host || H;
    let doc = H.doc();
    if (doc?.kind !== "pcb") {
      const b = H.project().documents.find(d => d.kind === "pcb");
      if (!b) { H.info("Open a board layout for the PDN analysis."); return null; }
      H.selectDocument(b.id); doc = H.doc();
    }
    if (dlg?.open) { dlg.querySelector("select, input, button")?.focus(); return dlg; }
    load(doc);
    const d = el("dialog", null, "work-dialog ui-dialog ui-sheet ui-tool-panel", {"aria-labelledby": "pdn-heading", "data-tool": "pdn"});
    dlg = d;
    const head = el("div", null, "ui-tool-head");
    const status = el("p", null, "ui-tool-status", {role: "status", "aria-live": "polite"});
    const title = el("h2", "PDN Analyzer", null, {id: "pdn-heading"});
    head.append(title, button("", () => d.close(), "ui-tool-close", "Close the PDN Analyzer"));
    head.lastChild.setAttribute("aria-label", "Close");
    const setupBox = el("section", null, "ui-tool-body", {"aria-label": "Setup"});
    const actions = el("div", null, "work-actions ui-dialog-actions ui-tool-actions");
    const resultBox = el("section", null, "pdn-results", {"aria-label": "Results"});
    const run = button("Analyse", () => analyse(), "is-primary", "Solve the power net and its return net");
    const msgs = button("Send to Messages", () => toMessages(true), "", "List the PDN findings in the Messages panel");
    actions.append(msgs, run);
    d.append(head, status, setupBox, actions, resultBox);
    d.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); d.close(); return; }
      if (e.target.closest?.(".ui-tabs, .ui-segmented") && /^(Arrow(Left|Right|Up|Down)|Home|End)$/.test(e.key)) return;
      e.stopPropagation();
    });
    d.addEventListener("close", () => { job?.cancel(); job = null; save(); if (dlg === d) { dlg = null; ui = null; } d.remove(); H.invalidate(); });
    ui = {d, status, setupBox, resultBox, run, msgs, readout: null};
    paintSetup(); paintResults();
    globalThis.AtriumShell.adoptDialog(d, {title, body: setupBox, actions, sheet: true, defaultAction: false});
    document.body.append(d); d.show();
    setupBox.querySelector("select")?.focus({preventScroll: true});
    if (results.get(netSetup()?.id)) say("Showing the last result for " + netSetup().net + ".");
    else say("Check the setup, then Analyse.");
    return d;
  }
  const say = (t, kind) => { if (!ui) return; ui.status.textContent = t; ui.status.dataset.kind = kind || ""; };

  const field = (label, input, unit, cls) => globalThis.AtriumUIKit.analysisField(label, input, unit, cls);
  const numInput = (value, onValue, opts) => globalThis.AtriumUIKit.nullableNumber(value, onValue, opts);
  function paintSetup() {
    const box = ui.setupBox, doc = board(), defs = H.defs(), S = setup, N = netSetup();
    box.replaceChildren();
    if (!doc) { box.append(el("p", "Open a board layout.", "ui-tool-empty")); return; }
    const nets = P().nets(doc, defs);
    // Net setups.
    const bar = el("div", null, "ui-tool-bar");
    const pick = el("select", null, "ui-field", {"aria-label": "Net setup"});
    S.nets.forEach((n, i) => option(pick, String(i), (n.net || "(no net)") + (n.voltage != null ? " · " + n.voltage + " V" : ""), i === cur));
    pick.onchange = () => { cur = +pick.value; paintSetup(); paintResults(); H.invalidate(); };
    const add = button("Add net", () => {
      const used = new Set(S.nets.map(n => n.net)), next = nets.find(n => P().isSupply(n) && !used.has(n)) || nets.find(n => !P().isGround(n) && !used.has(n)) || nets[0];
      S.nets.push(P().guess(doc, defs, next, {project: H.project()})); cur = S.nets.length - 1; paintSetup(); paintResults(); H.invalidate();
    }, "", "Add a setup for another power net");
    const del = button("Remove", () => { if (S.nets.length <= 1) return; results.delete(N.id); S.nets.splice(cur, 1); cur = Math.max(0, cur - 1); paintSetup(); paintResults(); H.invalidate(); }, "", "Remove this net setup");
    del.disabled = S.nets.length <= 1;
    bar.append(field("Setup", pick), add, del);
    box.append(bar);
    if (!N) return;
    // Net, voltage, source, return.
    const grid = el("div", null, "ui-tool-grid");
    const netSel = el("select", null, "ui-field", {"aria-label": "Power net"});
    if (!nets.includes(N.net)) option(netSel, N.net, N.net || "Choose…", true);
    for (const n of nets) option(netSel, n, n, n === N.net);
    netSel.onchange = () => {
      const g = P().guess(doc, defs, netSel.value, {project: H.project()});
      Object.assign(N, {net: g.net, voltage: g.voltage, source: g.source, loads: g.loads, returnNet: N.returnNet || g.returnNet});
      results.delete(N.id); paintSetup(); paintResults(); H.invalidate();
    };
    const volt = numInput(N.voltage, v => { N.voltage = v ?? 0; }, {label: "Voltage (V)"});
    const parts = P().partsOn(doc, defs, N.net);
    const srcSel = el("select", null, "ui-field", {"aria-label": "Source component"});
    option(srcSel, "", "Choose…", !N.source.ref);
    for (const p of parts) option(srcSel, p.ref, p.ref + (p.value ? " · " + p.value : ""), p.ref === N.source.ref);
    srcSel.onchange = () => { N.source = {ref: srcSel.value, pins: []}; N.loads = N.loads.filter(l => l.ref !== srcSel.value); paintSetup(); };
    const srcPins = el("input", null, "ui-field", {type: "text", "aria-label": "Source pins", placeholder: "all on net", spellcheck: "false"});
    srcPins.value = N.source.pins.join(", ");
    srcPins.onchange = () => { N.source.pins = pins(srcPins.value); };
    const retSel = el("select", null, "ui-field", {"aria-label": "Return net"});
    option(retSel, "", "None (supply only)", !N.returnNet);
    for (const n of nets) if (n !== N.net) option(retSel, n, n, n === N.returnNet);
    retSel.onchange = () => { N.returnNet = retSel.value; };
    grid.append(field("Power net", netSel), field("Voltage", volt, "V"), field("Source", srcSel), field("Source pins", srcPins), field("Return net", retSel, null, "ui-tool-wide"));
    box.append(grid);
    // Loads.
    const lt = el("table", null, "ui-tool-table pdn-loads"), th = el("thead"), hr = el("tr"), tb = el("tbody");
    for (const c of ["Load", "Pins", "Current", "Per", ""]) hr.append(el("th", c, null, {scope: "col"}));
    th.append(hr); lt.append(th, tb);
    N.loads.forEach((ld, i) => {
      const tr = el("tr");
      const ref = el("select", null, "ui-field", {"aria-label": "Load " + (i + 1) + " component"});
      if (!parts.some(p => p.ref === ld.ref)) option(ref, ld.ref, ld.ref || "Choose…", true);
      for (const p of parts) if (p.ref !== N.source.ref) option(ref, p.ref, p.ref, p.ref === ld.ref);
      ref.onchange = () => { ld.ref = ref.value; ld.pins = []; };
      const pin = el("input", null, "ui-field", {type: "text", "aria-label": "Load " + (i + 1) + " pins", placeholder: "all", spellcheck: "false"});
      pin.value = ld.pins.join(", "); pin.onchange = () => { ld.pins = pins(pin.value); };
      const amps = numInput(ld.current, v => { ld.current = Math.max(0, v ?? 0); }, {min: "0", unit: "A", label: "Load " + (i + 1) + " current (A)"});
      const mode = el("select", null, "ui-field", {"aria-label": "Load " + (i + 1) + " current applies to"});
      option(mode, "total", "total", ld.mode !== "per-pin"); option(mode, "per-pin", "each pin", ld.mode === "per-pin");
      mode.onchange = () => { ld.mode = mode.value; };
      const x = button("", () => { N.loads.splice(i, 1); paintSetup(); }, "ui-tool-close pdn-remove", "Remove this load"); x.setAttribute("aria-label", "Remove load " + (ld.ref || i + 1));
      const tdA = el("td"); tdA.append(amps, el("span", "A", "ui-tool-unit"));
      for (const n of [ref, pin, tdA, mode, x]) { if (n.tagName === "TD") tr.append(n); else { const td = el("td"); td.append(n); tr.append(td); } }
      tb.append(tr);
    });
    if (!N.loads.length) { const tr = el("tr"), td = el("td", "No loads: add the parts that draw current.", "ui-tool-empty", {colspan: "5"}); tr.append(td); tb.append(tr); }
    const loadBar = el("div", null, "ui-tool-bar");
    loadBar.append(button("Add load", () => { const p = parts.find(q => q.ref !== N.source.ref && !N.loads.some(l => l.ref === q.ref)); N.loads.push({ref: p?.ref || "", pins: [], current: .1, mode: "total"}); paintSetup(); }),
      button("Add selected", () => {
        const ids = new Set(H.selection()), refs = doc.items.filter(i => ids.has(i.id) && i.kind === "part" && parts.some(p => p.ref === i.ref) && i.ref !== N.source.ref && !N.loads.some(l => l.ref === i.ref)).map(i => i.ref);
        if (!refs.length) { say("Select parts with a pin on " + N.net + " first."); return; }
        for (const r of refs) N.loads.push({ref: r, pins: [], current: .1, mode: "total"});
        paintSetup();
      }, "", "Add the selected components as loads"));
    box.append(el("h3", "Loads", "pdn-sub"), lt, loadBar);
    // Limits and model.
    const more = el("details", null, "ui-tool-more");
    more.append(el("summary", "Limits and model"));
    const lim = el("div", null, "ui-tool-grid");
    lim.append(field("Max drop", numInput(N.maxDropPct, v => { N.maxDropPct = v ?? 5; }, {min: "0", label: "Maximum drop (%)"}), "%"),
      field("Max density", numInput(N.maxDensity, v => { N.maxDensity = v ?? 100; }, {min: "0", label: "Maximum current density (A/mm²)"}), "A/mm²"),
      field("Via limit", numInput(N.viaCurrent, v => { N.viaCurrent = v; }, {min: "0", label: "Via current limit (A)", placeholder: "IPC-2221"}), "A"),
      field("Via rise", numInput(S.viaRise, v => { S.viaRise = v ?? 10; }, {min: "1", unit:"Δ°C",label: "Via temperature rise for IPC-2221 (°C)"}), "°C"),
      field("Temperature", numInput(S.temperature, v => { S.temperature = v ?? 25; }, {label: "Copper temperature (°C)"}), "°C"),
      field("Via plating", numInput(r4(S.plating * 1000), v => { S.plating = (v ?? 25) / 1000; }, {min: "1", label: "Via barrel plating (µm)"}), "µm"),
      field("Grid pitch", numInput(S.pitch, v => { S.pitch = v; }, {min: "0", label: "Grid pitch (mm)", placeholder: "auto"}), "mm"),
      field("Cell cap", numInput(S.maxCells / 1e6, v => { S.maxCells = Math.round((v ?? 4) * 1e6); }, {min: "0.01", label: "Grid cell cap (millions)"}), "M"));
    more.append(lim, el("p", "A DC 2D sheet model: each layer is R□ = ρ(T)/t from the stack-up. Tracks narrower than three grid cells are exact 1D resistors; vias are barrel resistors. Source and load pads are equipotential. No self-heating.", "pdn-note"));
    box.append(more);
  }
  const pins = t => String(t || "").split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);

  // ---------------------------------------------------------------- analysis
  async function analyse() {
    const doc = board(), N = netSetup();
    if (!doc || !N) return;
    if (job) { job.cancel(); job = null; }
    save();
    const S = P().normalize(setup), defs = H.defs(), t0 = now(), my = ++stamp;
    let sj, rj = null;
    try { sj = P().job(doc, defs, N, S, "supply"); } catch (e) { say(e.message, "error"); return; }
    if (N.returnNet) { try { rj = P().job(doc, defs, N, S, "return"); } catch (e) { sj.meta.notes.push("Return net " + N.returnNet + " not analysed: " + e.message); } }
    ui.run.disabled = true;
    const phase = {raster: "Rasterising copper", mesh: "Meshing", assemble: "Assembling", factor: "Factorising", solve: "Solving", post: "Computing currents"};
    const progress = which => v => { if (my === stamp) say((which === "return" ? N.returnNet + ": " : N.net + ": ") + (phase[v.phase] || v.phase) + (v.done ? " · " + v.done + " iterations" : v.unknowns ? " · " + v.unknowns.toLocaleString() + " unknowns" : "") + "…"); };
    try {
      job = P().run(sj, {onProgress: progress("supply")});
      const supply = await job.promise;
      let ret = null;
      if (rj && my === stamp) { job = P().run(rj, {onProgress: progress("return")}); try { ret = await job.promise; } catch (e) { if (my !== stamp) return; supply.meta.notes.push("Return net " + N.returnNet + " not analysed: " + e.message); } }
      job = null;
      if (my !== stamp) return;
      const report = P().report(doc, N, S, supply, ret);
      results.set(N.id, {report, supply, ret, docId: doc.id, revision: H.revision(), stamp: my, ms: now() - t0, sjPads: sj.pads, rjPads: rj?.pads || null});
      images.clear();
      const v = report.violations.length, st = supply.stats;
      say(N.net + " solved in " + Math.round(now() - t0) + " ms · " + st.unknowns.toLocaleString() + " unknowns, " + st.iterations + " iterations, " + report.pitch + " mm grid · " +
        (v ? v + " finding" + (v === 1 ? "" : "s") : "within limits"), v ? "warn" : "ok");
      toMessages(false);
      paintResults(); H.invalidate();
    } catch (e) {
      job = null;
      if (my === stamp && e.message !== "Cancelled.") say(e.message, "error");
    } finally { if (ui) ui.run.disabled = false; }
  }
  function toMessages(showPanel) {
    const M = globalThis.AtriumMessages;
    if (!M) { if (showPanel) H.info("Messages are not available."); return; }
    const all = [];
    const name = H.project().documents.find(x => x.id === docId)?.name || "";
    for (const [, res] of results) {
      for (const v of res.report.violations) {
        const part = v.ref ? board()?.items.find(i => i.kind === "part" && i.ref === v.ref) : null;
        all.push({class: v.severity, source: "PDN", text: v.title + ": " + v.detail, document: name, documentId: res.docId, objectId: v.id || part?.id || null, point: v.at || null});
      }
      const rp = res.report;
      all.push({class: "Info", source: "PDN", text: "PDN " + rp.net + ": " + rp.loads.length + " load" + (rp.loads.length === 1 ? "" : "s") + ", worst drop " +
        (Math.max(0, ...rp.loads.map(l => l.dropPct || 0))).toFixed(2) + " %, peak density " + Math.max(0, ...rp.density.map(x => x.jMax || 0)).toFixed(1) + " A/mm²", document: name, documentId: res.docId});
    }
    if (showPanel || all.some(m => m.class === "Error")) M.show(H.messageContext?.(), {title: "PDN Analyzer", group: "PDN", messages: all, focus: !!showPanel});
    else M.set("PDN", all);
  }

  // ---------------------------------------------------------------- results
  function paintResults() {
    const box = ui?.resultBox;
    if (!box) return;
    const activeGroup = document.activeElement?.closest(".pdn-seg, .pdn-tabs");
    const focusGroup = box.contains(activeGroup) ? activeGroup.classList.contains("pdn-tabs") ? "tab" : "radio" : null;
    box.replaceChildren();
    const N = netSetup(), res = N && results.get(N.id);
    if (!res) { box.append(el("p", "No result yet. Analyse to see the voltage and current density on the board.", "ui-tool-empty")); return; }
    const R = res.report;
    // View controls.
    const ctl = el("div", null, "ui-tool-bar pdn-view");
    const show = el("div", null, "pdn-seg ui-segmented", {role: "radiogroup", "aria-label": "Heat map"});
    for (const [k, t] of [["voltage", "Voltage"], ["density", "Current density"], ["off", "Off"]]) {
      const b = button(t, () => { view.show = k; paintResults(); H.invalidate(); }, "pdn-seg-b ui-segment");
      b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(view.show === k));
      b.tabIndex = view.show === k ? 0 : -1; show.append(b);
    }
    const which = el("select", null, "ui-field", {"aria-label": "Net shown"});
    option(which, "supply", R.net, view.which === "supply");
    if (res.ret) option(which, "return", R.returnNet + " (return)", view.which === "return");
    else view.which = "supply";
    which.onchange = () => { view.which = which.value; paintResults(); H.invalidate(); };
    const layerSel = el("select", null, "ui-field", {"aria-label": "Layer shown"});
    option(layerSel, "active", "Active layer", view.layer === "active");
    for (const l of res.supply.layers) option(layerSel, l.key, l.key, view.layer === l.key);
    layerSel.onchange = () => { view.layer = layerSel.value; paintResults(); H.invalidate(); };
    ctl.append(show, which, layerSel);
    box.append(ctl);
    // Legend.
    const scale = scaleFor(res);
    const legend = el("div", null, "ui-tool-legend", {role: "img", "aria-label": (view.show === "density" ? "Current density " : "Voltage ") + scale.label(scale.lo) + " to " + scale.label(scale.hi)});
    const bar = el("div", null, "ui-tool-ramp");
    bar.style.backgroundImage = P().gradient();
    legend.append(el("span", scale.label(scale.lo), "ui-tool-tick"), bar, el("span", (scale.clipped ? "≥ " : "") + scale.label(scale.hi), "ui-tool-tick"));
    if (view.show !== "off") box.append(legend);
    ui.readout = el("p", "Hover over the board for a reading.", "ui-tool-readout", {"aria-live": "off"});
    box.append(ui.readout);
    // Tabs.
    const tabs = el("div", null, "pdn-tabs ui-tabs", {role: "tablist", "aria-label": "Analysis results", "data-underline": ""}), body = el("div", null, "pdn-body");
    const T = [["loads", "Loads"], ["density", "Density"], ["vias", "Vias (" + R.vias.length + ")"], ["model", "Model"]];
    view.tab = view.tab || "loads";
    for (const [k, t] of T) {
      const b = button(t, () => { view.tab = k; paintResults(); }, "pdn-tab ui-tab");
      b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(view.tab === k));
      b.id = "pdn-tab-" + k; b.tabIndex = view.tab === k ? 0 : -1;
      if (view.tab === k) b.setAttribute("aria-controls", "pdn-tab-panel");
      tabs.append(b);
    }
    body.id = "pdn-tab-panel"; body.setAttribute("role", "tabpanel"); body.setAttribute("aria-labelledby", "pdn-tab-" + view.tab);
    box.append(tabs, body);
    if (focusGroup === "tab") tabs.querySelector('[aria-selected="true"]')?.focus({preventScroll: true});
    if (focusGroup === "radio") show.querySelector('[aria-checked="true"]')?.focus({preventScroll: true});
    const st = s => ({ok: "OK", fail: "Fail"})[s] || s;
    if (view.tab === "loads") body.append(table(["Load", "Current", N.net, R.returnNet || "Return", "At load", "Drop", "Status"], R.loads.map(l => ({status: l.status, at: l.at, ref: l.ref,
      cells: [l.ref + (l.pins.length ? " (" + l.pins.length + " pin" + (l.pins.length === 1 ? "" : "s") + ")" : ""), fmtA(l.current), l.unreached ? "open" : fmtV(l.supply), l.retOpen ? "open" : l.ret == null ? "—" : fmtmV(l.ret), fmtV(l.voltage),
        l.drop == null ? "—" : fmtmV(l.drop) + " (" + l.dropPct.toFixed(2) + " %)", st(l.status)]}))));
    if (view.tab === "density") body.append(table(["Net", "Layer", "Peak density", "At", "Status"], R.density.map(dd => ({status: dd.status, at: dd.at,
      cells: [dd.net, dd.layer, fmtJ(dd.jMax), dd.at ? dd.at[0].toFixed(2) + ", " + dd.at[1].toFixed(2) : "—", st(dd.status)]}))));
    if (view.tab === "vias") body.append(table(["Net", "Via at", "Current", "Limit", "Status"], R.vias.slice(0, 500).map(v => ({status: v.status, at: v.at, id: v.id,
      cells: [v.net, v.at[0].toFixed(2) + ", " + v.at[1].toFixed(2), fmtA(v.current), fmtA(v.limit), st(v.status)]}))));
    if (view.tab === "model") {
      const s = R.stats.supply, list = el("ul", null, "ui-tool-notes");
      list.append(el("li", "Grid " + R.pitch + " mm, " + s.cells.toLocaleString() + " cells → " + s.nodes.toLocaleString() + " nodes (quadtree), " + s.iterations + " CG iterations (MIC(0)), residual " + s.residual.toExponential(1) + ", " + Math.round(res.ms) + " ms."));
      list.append(el("li", "Power: " + (R.power.supply * 1000).toFixed(1) + " mW in " + R.net + (R.power.ret != null ? ", " + (R.power.ret * 1000).toFixed(1) + " mW in " + R.returnNet : "") + "."));
      list.append(el("li", "Via limit: " + (R.limits.viaCurrent != null ? R.limits.viaCurrent + " A" : R.limits.viaRule) + "."));
      for (const n of R.notes) list.append(el("li", n));
      list.append(el("li", "Accuracy: a DC 2D sheet model (uniform current through the copper thickness, one temperature, no self-heating). Analytic checks: uniform strip, narrow track and vias in parallel exact; L-shaped trace within 0.1 %. Density next to small pads and vias is resolved to the grid pitch."));
      body.append(list);
    }
  }
  function table(cols, rows) {
    return AtriumUIKit.analysisTable(cols, rows, row => {
      const tr = el("tr", null, "ui-tool-row is-" + (row.status || "ok"));
      tr.tabIndex = 0;
      for (const c of row.cells) tr.append(el("td", c));
      const go = () => {
        if (row.id) { try { H.select([row.id], row.id); } catch { /* gone */ } }
        else if (row.ref) { const p = board()?.items.find(i => i.kind === "part" && i.ref === row.ref); if (p) try { H.select([p.id], p.id); } catch { /* gone */ } }
        if (row.at) H.centerOn?.(row.at);
        H.invalidate();
      };
      tr.onclick = go; tr.onkeydown = e => { if (e.key === "Enter") go(); };
      return tr;
    }, {wrapClass: "ui-tool-table-wrap", tableClass: "ui-tool-table", emptyClass: "ui-tool-empty"});
  }

  // ---------------------------------------------------------------- heat map
  // Value range for the shown net and quantity, over every layer (one legend for all layers).
  function scaleFor(res) {
    const which = view.which === "return" && res.ret ? res.ret : res.supply, V0 = which.meta?.voltage ?? 0;
    if (view.show === "density") {
      // Top of the scale at the 99.5th percentile, so one hot cell does not wash out the map.
      const all = [];
      for (const l of which.layers) if (l.grid) { const j = l.grid.j, step = Math.max(1, Math.floor(j.length / 200000)); for (let i = 0; i < j.length; i += step) if (j[i] > 0) all.push(j[i]); }
      for (let i = 0; i < which.chain.n; i++) if (which.chain.j[i] > 0) all.push(which.chain.j[i]);
      all.sort((a, b) => a - b);
      const top = all.length ? all[Math.min(all.length - 1, Math.floor(all.length * .995))] : 1, hi = Math.max(top, 1e-9);
      return {lo: 0, hi, clipped: (which.jMax || 0) > hi * 1.0001, value: (u, j) => j, label: fmtJ};
    }
    const a = V0 - which.uMax, b = V0 - which.uMin, lo = Math.min(a, b), hi = Math.max(a, b);
    return {lo, hi: hi > lo ? hi : lo + 1e-6, clipped: false, value: u => V0 - u, label: v => Math.abs(hi - lo) < .1 && Math.abs(v) >= 1 ? v.toFixed(4) + " V" : fmtV(v)};
  }
  function layerKey() { return view.layer === "active" ? (H.activeLayer?.() || "Top") : view.layer; }
  function image(res, which, li, scale) {
    const key = res.stamp + "|" + view.which + "|" + view.show + "|" + li;
    if (images.has(key)) return images.get(key);
    const g = which.layers[li].grid;
    if (!g) { images.set(key, null); return null; }
    const c = document.createElement("canvas");
    c.width = g.nx; c.height = g.ny;
    const ctx = c.getContext("2d"), img = ctx.createImageData(g.nx, g.ny), px = img.data, span = scale.hi - scale.lo;
    for (let i = 0; i < g.nx * g.ny; i++) {
      const cov = g.cov[i];
      if (!cov) continue;
      const u = g.u[i], o = 4 * i;
      if (!(u === u)) { px[o] = 128; px[o + 1] = 128; px[o + 2] = 128; px[o + 3] = 90; continue; }   // floating copper
      const t = (scale.value(u, g.j[i]) - scale.lo) / span, col = P().ramp(t);
      px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = Math.round(235 * Math.min(1, cov / 200));
    }
    ctx.putImageData(img, 0, 0);
    images.set(key, c);
    while (images.size > 12) images.delete(images.keys().next().value);
    return c;
  }
  function current() {
    const doc = board(), N = netSetup(), res = N && results.get(N.id);
    return doc && res && res.docId === doc.id ? res : null;
  }
  function draw(g, info) {
    const res = current();
    if (!res || view.show === "off") return;
    const which = view.which === "return" && res.ret ? res.ret : res.supply, key = layerKey(), li = which.layers.findIndex(l => l.key === key);
    const scale = scaleFor(res), px = 1 / (info.scale || 1);
    g.save();
    if (li >= 0) {
      const c = image(res, which, li, scale), gr = which.layers[li].grid;
      if (c) { g.imageSmoothingEnabled = false; g.globalAlpha = 1; g.drawImage(c, gr.x0, gr.y0, gr.nx * gr.h, gr.ny * gr.h); }
      // Narrow tracks (1D elements) and pads on layers without a grid.
      const ch = which.chain;
      g.lineCap = "round";
      for (let k = 0; k < ch.n; k++) {
        if (ch.layer[k] !== li) continue;
        const u = (ch.ua[k] + ch.ub[k]) / 2;
        if (!(u === u)) continue;
        const w = trackWidth(which, ch.track[k]);
        g.strokeStyle = P().rgb((scale.value(u, ch.j[k]) - scale.lo) / (scale.hi - scale.lo));
        g.lineWidth = Math.max(w, 2 * px);
        g.beginPath(); g.moveTo(ch.geo[4 * k], ch.geo[4 * k + 1]); g.lineTo(ch.geo[4 * k + 2], ch.geo[4 * k + 3]); g.stroke();
      }
      const pads = view.which === "return" ? res.rjPads : res.sjPads;
      if (!which.layers[li].grid && pads) pads.forEach((p, k) => {
        const at = p.layers.indexOf(li);
        if (at < 0) return;
        const u = which.pads[k].u[at];
        if (!(u === u)) return;
        g.fillStyle = P().rgb((scale.value(u, 0) - scale.lo) / (scale.hi - scale.lo));
        g.beginPath(); for (let i = 0; i < p.ring.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, p.ring[i], p.ring[i + 1]); g.closePath(); g.fill();
      });
    }
    // Vias over their limit get a ring.
    for (const v of res.report.vias) if (v.status === "fail" && (view.which === "supply" ? v.net === res.report.net : v.net === res.report.returnNet)) {
      g.strokeStyle = "#ff5cf0"; g.lineWidth = 2 * px; g.beginPath(); g.arc(v.at[0], v.at[1], 6 * px, 0, Math.PI * 2); g.stroke();
    }
    g.restore();
    hover(g, info, res, which, li, scale);
  }
  const widths = new WeakMap();
  function trackWidth(which, k) {
    let w = widths.get(which);
    if (!w) { w = which.meta?.trackWidths || []; widths.set(which, w); }
    return w[k] || .1;
  }
  // Reading at a world point: {value text, density, layer} or null.
  function readAt(res, which, li, p) {
    if (li < 0) return null;
    const V0 = which.meta?.voltage ?? 0, gr = which.layers[li].grid;
    if (gr) {
      const ix = Math.floor((p[0] - gr.x0) / gr.h), iy = Math.floor((p[1] - gr.y0) / gr.h);
      if (ix >= 0 && iy >= 0 && ix < gr.nx && iy < gr.ny) { const c = iy * gr.nx + ix; if (gr.cov[c] && gr.u[c] === gr.u[c]) return {v: V0 - gr.u[c], j: gr.j[c]}; }
    }
    const ch = which.chain;
    let best = null, bd = Infinity;
    for (let k = 0; k < ch.n; k++) {
      if (ch.layer[k] !== li) continue;
      const ax = ch.geo[4 * k], ay = ch.geo[4 * k + 1], bx = ch.geo[4 * k + 2], by = ch.geo[4 * k + 3], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0, d = Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy);
      if (d < bd && d <= trackWidth(which, ch.track[k]) / 2 + .05) { bd = d; best = {v: V0 - (ch.ua[k] + (ch.ub[k] - ch.ua[k]) * t), j: ch.j[k], i: ch.i[k]}; }
    }
    return best;
  }
  function hover(g, info, res, which, li, scale) {
    const p = H.pointer?.();
    if (!p) return;
    const r = readAt(res, which, li, p);
    const text = r ? (view.which === "return" ? res.report.returnNet : res.report.net) + " · " + layerKey() + " · " + fmtV(r.v) + " · " + fmtJ(r.j) + (r.i != null ? " · " + fmtA(Math.abs(r.i)) : "") : "";
    if (ui?.readout && ui.readout.textContent !== (text || "Hover over the board for a reading.")) ui.readout.textContent = text || "Hover over the board for a reading.";
    if (!r) return;
    const [sx, sy] = info.worldToScreen(p), dpr = info.dpr || 1;
    g.save();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.font = "12px system-ui, -apple-system, sans-serif"; g.textAlign = "left"; g.textBaseline = "alphabetic"; g.globalAlpha = 1;
    const w = g.measureText(text).width + 12, x = Math.min(sx + 14, (info.width || 1e4) / dpr - w - 4), y = sy + 18;
    g.fillStyle = "rgba(20,24,28,.88)"; g.fillRect(x, y, w, 20);
    g.fillStyle = P().rgb(((view.show === "density" ? r.j : r.v) - scale.lo) / (scale.hi - scale.lo)); g.fillRect(x, y, 4, 20);
    g.fillStyle = "#f2f2f2"; g.fillText(text, x + 8, y + 14);
    g.restore();
  }

  function install(host) {
    if (H === host) return;
    H = host;
    host.registerAction("pdn-analysis", () => open(host));
    host.addRenderer(d => d?.kind === "pcb" && dlg?.open && view.show !== "off" && current() ? {overlay: (g, info) => draw(g, info)} : null);
    // A different board or project: the panel follows it.
    host.on?.("document", () => {
      if (!dlg?.open) return;
      const doc = board();
      if (doc && doc.id !== docId) { save(); load(doc); paintSetup(); paintResults(); }
    });
  }
  if (typeof document !== "undefined" && globalThis.AtriumNavCommon?.ready) AtriumNavCommon.ready(install);
  return Object.freeze({open: () => open(H), install, analyse, state: () => ({open: !!dlg?.open, setup, cur, view: {...view}, result: results.get(netSetup()?.id)?.report || null}), _results: results});
})();
