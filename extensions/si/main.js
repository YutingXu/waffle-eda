// Signal Integrity: a first-party extension. IBIS-based reflection and crosstalk simulation of routed
// nets, with each segment's impedance and delay from Waffle's 2D field solver. It runs in its own
// sandboxed worker with no network and no file access beyond the system picker, reads the design
// through the public API (simulation.* calls) and changes it only through reviewed proposals (stored
// IBIS files and per-part model assignments in project.simulation).
// The solver, IBIS reader, channel model and PNG writer load on first use.
let IB = null, EN = null, SV = null, CH = null, PNG = null, U = null;
const lib = () => { IB = IB || require("./ibis.js"); SV = SV || require("./solver.js"); CH = CH || require("./channel.js"); EN = EN || require("./engine.js"); U = U || require("./util.js"); };
const PANEL = "waffle.si", MAX_MODELS = 32, MAX_IBIS = 8 * 1024 * 1024, MAX_TOTAL = 24 * 1024 * 1024, PLOT_POINTS = 900, MAX_SERIES = 8;
const STYLE = {typ: "", min: "dash", max: "faint"};

exports.activate = function (api, context) {
  const st = {
    net: "", driver: "", corners: ["typ", "min", "max"], stimulus: "rise", freq: "100M", loss: true, crosstalk: true, gap: 0.5, eye: false, probe: "all",
    seriesSweep: null, parallelSweep: null, result: null, error: null, view: null, running: false, cancelled: false, progress: null, plan: null, info: null, notice: null
  };
  const parsed = new Map(); // project model key -> parsed IBIS
  let fieldCache = null;
  const ready = (async () => { try { Object.assign(st, pickSettings((await api.storage.get("settings")) || {})); } catch {} })();
  function pickSettings(s) {
    const o = {};
    if (Array.isArray(s.corners)) o.corners = s.corners.filter(c => ["typ", "min", "max"].includes(c));
    for (const k of ["stimulus", "freq", "probe"]) if (typeof s[k] === "string") o[k] = s[k];
    for (const k of ["loss", "crosstalk", "eye"]) if (typeof s[k] === "boolean") o[k] = s[k];
    if (Number(s.gap) > 0) o.gap = Math.min(5, Number(s.gap));
    return o;
  }
  const save = () => api.storage.set("settings", {corners: st.corners, stimulus: st.stimulus, freq: st.freq, loss: st.loss, crosstalk: st.crosstalk, gap: st.gap, eye: st.eye, probe: st.probe}).catch(() => {});
  const tick = () => (typeof setTimeout === "function" ? new Promise(r => setTimeout(r, 0)) : Promise.resolve());

  // ---------------------------------------------------------------- project models (IBIS)
  async function models() { return api.simulation.get(); }
  async function ibisFor(key) {
    lib();
    if (parsed.has(key)) return parsed.get(key);
    const m = await api.simulation.model(key);
    if (!m) return null;
    const p = IB.parse(m.text, {name: m.name});
    parsed.set(key, p);
    return p;
  }
  async function proposal(label, ops) {
    const info = await api.project.info();
    return api.proposals.submit({format: "atrium-ai", version: 2, project: info.name, tool: "waffle.si", summary: label, ops}, label);
  }
  async function importIbis() {
    lib();
    const f = await api.files.pickText({accept: [".ibs", ".ibis", ".pkg", ".txt"], maxBytes: MAX_IBIS});
    if (!f) return null;
    let ibis;
    try { ibis = IB.parse(f.text, {name: f.name}); }
    catch (e) { st.notice = {level: "error", text: f.name + ": " + e.message}; await render(); await api.ui.showMessage(f.name + " is not a valid IBIS file. " + e.message, {level: "error"}); return {error: e.message}; }
    const sim = await models();
    const sha = U.sha256(f.text), key = "ibis-" + sha.slice(0, 16);
    if (sim.models.some(m => m.key === key)) { st.notice = {level: "info", text: f.name + " is already in the project."}; await render(); return {key, existing: true}; }
    if (sim.models.length >= MAX_MODELS) throw Error("The project already holds " + MAX_MODELS + " IBIS files; remove one first.");
    if (sim.models.reduce((s, m) => s + m.size, 0) + f.text.length > MAX_TOTAL) throw Error("The project's IBIS files would exceed " + MAX_TOTAL / 1048576 + " MB.");
    const summary = IB.summary(ibis);
    const value = {name: f.name.replace(/[^\w .()+-]/g, "_").slice(0, 120), kind: "ibis", text: f.text, sha256: sha, added: new Date().toISOString(), summary};
    const r = await proposal("Add IBIS model " + value.name, [{op: "set", target: "project", path: ["simulation", "models", key], after: value}]);
    if (r?.declined || r?.applied === 0) { st.notice = {level: "info", text: "The IBIS file was not added."}; await render(); return {key, applied: 0}; }
    parsed.set(key, ibis);
    st.notice = {level: "info", text: "Added " + value.name + ": " + summary.components.map(c => c.name).join(", ") + " (" + summary.models.length + " models" + (ibis.warnings.length ? ", " + ibis.warnings.length + " notes" : "") + ")."};
    await render();
    return {key, applied: r?.applied ?? 1, summary, warnings: ibis.warnings};
  }
  async function removeModel(key) {
    const sim = await models();
    const m = sim.models.find(x => x.key === key);
    if (!m) return false;
    const full = await api.simulation.model(key);
    const all = await rawModel(key, full);
    const ops = [{op: "set", target: "project", path: ["simulation", "models", key], before: all}];
    for (const [pid, a] of Object.entries(sim.assign || {})) if (a?.model === key) ops.push({op: "set", target: "project", path: ["simulation", "assign", pid], before: a});
    const r = await proposal("Remove IBIS model " + m.name, ops);
    parsed.delete(key);
    await render();
    return r;
  }
  // The stored record, rebuilt exactly (the proposal guard compares the whole value).
  async function rawModel(key, full) {
    const sim = await models(), m = sim.models.find(x => x.key === key);
    const v = {name: m.name, kind: m.kind, text: full.text};
    if (m.sha256 != null) v.sha256 = m.sha256;
    if (m.added != null) v.added = m.added;
    if (m.summary != null) v.summary = m.summary;
    return v;
  }
  // Assign an IBIS component (and model-selector choices) to a part.
  async function assignModel(partId, preset) {
    lib();
    const sim = await models();
    if (!sim.models.length) { await api.ui.showMessage("Import an IBIS file first (Signal Integrity › Import IBIS Model…).", {level: "warn"}); return null; }
    if (!partId) {
      const sel = (await api.selection.items({fields: ["id", "kind", "ref"]})).filter(i => i.kind === "part");
      if (sel.length !== 1) { await api.ui.showMessage("Select one component to assign an IBIS model to.", {level: "warn"}); return null; }
      partId = sel[0].id;
    }
    const part = await api.items.get(partId, {fields: ["id", "ref", "value", "kind"]});
    if (!part || part.kind !== "part") throw Error("Choose a component.");
    let key = preset?.model, comp = preset?.component, choices = preset?.pins || null;
    if (!key) {
      const pick = await api.ui.showQuickPick(sim.models.map(m => ({label: m.name, detail: (m.summary?.components || []).map(c => c.name).join(", "), value: m.key})), {title: "IBIS file for " + part.ref});
      if (!pick) return null;
      key = typeof pick === "string" ? pick : pick.value;
    }
    const ibis = await ibisFor(key);
    if (!ibis) throw Error("That IBIS file is not in the project.");
    if (!comp) {
      if (ibis.components.length === 1) comp = ibis.components[0].name;
      else {
        const pick = await api.ui.showQuickPick(ibis.components.map(c => ({label: c.name, detail: c.manufacturer, value: c.name})), {title: "IBIS component for " + part.ref});
        if (!pick) return null;
        comp = typeof pick === "string" ? pick : pick.value;
      }
    }
    if (!choices) {
      // Model selectors on this part's pins: ask once per selector.
      const c = IB.component(ibis, comp), pins = await api.parts.pins(partId), asked = new Map();
      choices = {};
      for (const pin of pins) {
        const ip = c?.pins.get(String(pin.number).toLowerCase()), sel = ip && ibis.selectors.get(ip.model.toLowerCase());
        if (!sel) continue;
        if (!asked.has(sel.name)) {
          const pick = await api.ui.showQuickPick(sel.models.map(e => ({label: e.model, detail: e.description, value: e.model})), {title: part.ref + ": " + sel.name + " (model selector)"});
          asked.set(sel.name, pick ? (typeof pick === "string" ? pick : pick.value) : sel.models[0].model);
        }
        choices[pin.number] = asked.get(sel.name);
      }
    }
    const value = {model: key, name: sim.models.find(m => m.key === key)?.name || key, component: comp, ...(choices && Object.keys(choices).length ? {pins: choices} : {})};
    const before = sim.assign?.[partId];
    const op = {op: "set", target: "project", path: ["simulation", "assign", partId], after: value};
    if (before !== undefined) op.before = before;
    const r = await proposal("Assign IBIS model " + comp + " to " + part.ref, [op]);
    await render();
    return {partId, ...value, applied: r?.applied ?? 0};
  }
  async function clearModel(partId) {
    const sim = await models(), before = sim.assign?.[partId];
    if (before === undefined) return false;
    const r = await proposal("Clear the IBIS model of a part", [{op: "set", target: "project", path: ["simulation", "assign", partId], before}]);
    await render();
    return r;
  }

  // ---------------------------------------------------------------- field solver (cached)
  async function loadCache() {
    if (fieldCache) return fieldCache;
    fieldCache = new Map();
    try { const c = await api.storage.get("fieldCache"); if (c && typeof c === "object") for (const [k, v] of Object.entries(c)) fieldCache.set(k, v); } catch {}
    return fieldCache;
  }
  async function saveCache() {
    const entries = [...fieldCache].slice(-180);
    try { await api.storage.set("fieldCache", Object.fromEntries(entries)); } catch {}
  }
  async function solveAll(jobs) {
    const cache = await loadCache(), solved = new Map();
    let fresh = 0;
    await Promise.all(jobs.map(async j => {
      const ck = JSON.stringify([j.geometry, j.quality || "normal", j.fGHz ?? null]);
      let r = cache.get(ck);
      if (!r) {
        try { r = await api.simulation.fieldSolve(j.geometry, {quality: j.quality, fGHz: j.fGHz}); } catch (e) { r = {ok: false, error: e.message}; }
        if (r?.ok !== false) { cache.set(ck, r); fresh++; }
      }
      solved.set(j.key, r);
    }));
    if (fresh) await saveCache();
    return {solved, fresh};
  }

  // ---------------------------------------------------------------- simulation
  // o: {net, driver, corners, stimulus, freq, loss, crosstalk, gap, seriesR, parallel, quiet}
  async function prepare(o) {
    lib();
    const net = o.net;
    const first = await api.simulation.channel(net, {neighbours: o.crosstalk ? Math.min(5, o.gap + 0.3) : 0});
    const recs = [first];
    for (let hop = 0, frontier = [first]; hop < 2 && recs.length < 4; hop++) {
      const next = [];
      for (const r of frontier) for (const n of EN.seriesNets(r, recs.map(x => x.net))) if (recs.length < 4) { const c = await api.simulation.channel(n, {neighbours: 0}); recs.push(c); next.push(c); }
      frontier = next;
    }
    const sim = await models();
    const ids = new Set(recs.flatMap(r => (r.parts || []).map(p => p.id)));
    for (const [pid, a] of Object.entries(sim.assign || {})) if (ids.has(pid) && a?.model) { try { await ibisFor(a.model); } catch (e) { parsed.set(a.model, null); st.notice = {level: "warn", text: "IBIS file " + (a.name || a.model) + ": " + e.message}; } }
    const p = EN.plan({nets: recs, library: k => parsed.get(k) || null, assign: sim.assign || {}, driver: o.driver || undefined});
    return {p, recs, sim};
  }
  function simOptions(o) {
    lib();
    const freq = U.parseEng(o.freq || "100M");
    return {corners: o.corners?.length ? o.corners : ["typ"], loss: o.loss !== false, crosstalk: o.crosstalk ? {enabled: true, maxGap: o.gap ?? 0.5, maxVictims: 4} : null,
      stimulus: {type: o.stimulus || "rise", freq: freq > 0 ? freq : 100e6}, seriesR: o.seriesR, parallel: o.parallel, tstop: o.tstop, limits: o.limits};
  }
  // The whole flow; yields to the event loop between chunks so si.cancel can stop it.
  async function simulateNet(o) {
    const t0 = Date.now();
    const {p} = await prepare(o);
    const opts = simOptions(o), jobs = EN.solveList(p, opts);
    const fs = await solveAll(jobs);
    const g = EN.run(p, fs.solved, opts);
    let r, last = Date.now();
    for (;;) {
      const x = g.next();
      if (x.done) { r = x.value; break; }
      if (Date.now() - last > 30) {
        st.progress = x.value; last = Date.now();
        await tick();
        if (st.cancelled) throw Object.assign(Error("Simulation cancelled."), {cancelled: true});
      }
    }
    r.stats.fieldSolves = jobs.length; r.stats.freshSolves = fs.fresh; r.stats.totalMs = Date.now() - t0;
    r.solved = fs.solved;
    return {r, p, solved: fs.solved, opts};
  }
  async function run(values) {
    if (values && typeof values === "object") applyForm(values);
    if (!st.net) { await pickNet(); if (!st.net) return null; }
    if (st.running) return null;
    st.running = true; st.cancelled = false; st.error = null; st.progress = {stage: "extracting", progress: 0};
    await render();
    try {
      const out = await simulateNet({net: st.net, driver: st.driver, corners: st.corners, stimulus: st.stimulus, freq: st.freq, loss: st.loss, crosstalk: st.crosstalk, gap: st.gap});
      st.result = out.r; st.plan = out.p; st.solved = out.solved; st.opts = out.opts; st.seriesSweep = null; st.parallelSweep = null;
      st.view = fullView(); st.driver = st.driver || out.r.driver.ref + "." + out.r.driver.pin;
      await sendMessages(true);
    } catch (e) { st.error = e.cancelled ? "Cancelled." : e.message; if (!e.cancelled) st.result = null; }
    finally { st.running = false; st.progress = null; }
    await render();
    return st.result ? EN.summary(st.result) : {error: st.error};
  }
  function applyForm(v) {
    if (typeof v.net === "string" && v.net.trim() && v.net.trim() !== st.net) { st.net = v.net.trim(); st.driver = ""; }
    if (typeof v.driver === "string") st.driver = /^auto/i.test(v.driver) ? "" : v.driver.split(" ")[0];
    if (typeof v.stimulus === "string" && ["rise", "fall", "pulse", "clock"].includes(v.stimulus)) st.stimulus = v.stimulus;
    if (typeof v.freq === "string" && v.freq.trim()) st.freq = v.freq.trim();
    const cs = ["typ", "min", "max"].filter(c => v[c] === true || (v[c] === undefined && st.corners.includes(c)));
    if (cs.length) st.corners = cs;
    if (typeof v.loss === "boolean") st.loss = v.loss;
    if (typeof v.crosstalk === "boolean") st.crosstalk = v.crosstalk;
    if (Number(v.gap) > 0) st.gap = Math.min(5, Number(v.gap));
    save();
  }
  async function pickNet() {
    const doc = await api.documents.active();
    if (doc.kind !== "pcb") { await api.ui.showMessage("Open a PCB layout to simulate a net.", {level: "warn"}); return; }
    // From the selection first: a track, via or pad, or a part's single signal net.
    const sel = await api.selection.items({fields: ["id", "kind", "net", "pinNets"]});
    lib();
    const nets = new Set();
    for (const i of sel) { if (i.net) nets.add(i.net); else if (i.pinNets) for (const n of Object.values(i.pinNets)) if (n && !CH.isRail(n)) nets.add(n); }
    let list = [...nets].filter(n => !CH.isRail(n));
    if (list.length !== 1) {
      const all = (await api.nets.list({doc: doc.id})).map(n => n.name).filter(n => !CH.isRail(n));
      const items = (list.length ? list : all).slice(0, 500);
      if (!items.length) { await api.ui.showMessage("This board has no signal nets.", {level: "warn"}); return; }
      const pick = await api.ui.showQuickPick(items.map(n => ({label: n, value: n})), {title: "Net to simulate"});
      if (!pick) return;
      list = [typeof pick === "string" ? pick : pick.value];
    }
    if (list[0] !== st.net) st.driver = "";
    st.net = list[0];
  }
  async function sendMessages(auto) {
    const r = st.result;
    if (!r) return;
    const rows = r.violations.map(v => ({class: v.class, text: v.text, ...(v.partId ? {objectId: v.partId} : {}), ...(v.point ? {point: v.point} : {})}));
    if (!rows.length && auto) { await api.ui.showMessage("Signal integrity: " + r.net + " passes (" + r.corners.join(", ") + ").", {messages: [{class: "Info", text: "Net " + r.net + ": no signal-integrity violations (" + r.corners.join(", ") + ")."}]}); return; }
    await api.ui.showMessage("Signal integrity: " + rows.length + " issue" + (rows.length === 1 ? "" : "s") + " on " + r.net + ".", {messages: rows.length ? rows : [{class: "Info", text: "Net " + r.net + ": no violations."}]});
  }
  async function sweep(kind) {
    if (!st.plan || !st.result) throw Error("Simulate a net first.");
    st.running = true; st.cancelled = false; await render();
    try {
      const g = EN.sweep(st.plan, st.solved, {kind, sim: {...st.opts, stimulus: {type: "rise"}}, vterm: 0});
      let r, last = Date.now();
      for (;;) { const x = g.next(); if (x.done) { r = x.value; break; } if (Date.now() - last > 30) { st.progress = x.value; last = Date.now(); await tick(); if (st.cancelled) throw Object.assign(Error("cancelled"), {cancelled: true}); } }
      if (kind === "series") st.seriesSweep = r; else st.parallelSweep = r;
    } catch (e) { st.error = e.cancelled ? "Cancelled." : e.message; }
    finally { st.running = false; st.progress = null; }
    await render();
    return kind === "series" ? st.seriesSweep : st.parallelSweep;
  }

  // ---------------------------------------------------------------- waveform viewer
  function fullView() { const r = st.result; if (!r) return null; return {lo: 0, hi: r.tstop, a: r.tstop * 0.2, b: r.tstop * 0.4}; }
  const ns = x => x * 1e9;
  function chosenWaves() {
    const r = st.result, probes = [...new Set(r.waves.map(w => w.probe))];
    // "all" falls back to the receivers when every probe at every corner would exceed the plot's 8 series.
    const mode = st.probe === "all" && r.waves.length > MAX_SERIES ? "receivers" : st.probe;
    const want = mode === "all" ? probes : mode === "receivers" ? probes.filter(p => r.waves.find(w => w.probe === p).role === "receiver") : probes.filter(p => p === st.probe);
    const list = [];
    for (const w of r.waves) if (want.includes(w.probe) && list.length < MAX_SERIES) list.push({...w, color: probes.indexOf(w.probe) % 8});
    return list;
  }
  function plotData(forPng) {
    lib();
    const r = st.result, v = st.view, waves = chosenWaves();
    const period = r.stimulus.period;
    const series = [];
    if (st.eye && period) {
      // Eye-style overlay: every bit period folded onto two unit intervals after the first edge.
      const span = period, t0 = r.stimulus.edges[0].t;
      for (const w of waves) {
        const x = [], y = [];
        let lastK = -1;
        for (let i = 0; i < r.t.length; i += Math.max(1, Math.floor(r.t.length / 4000))) {
          const t = r.t[i] - t0 - period / 4;
          if (t < period) continue;
          const k = Math.floor(t / span), u = t - k * span;
          if (k !== lastK && x.length) { x.push(ns(u)); y.push(null); }
          lastK = k; x.push(ns(u)); y.push(w.v[i]);
        }
        series.push({name: w.probe + " " + w.corner, x, y, color: w.color, style: STYLE[w.corner]});
      }
    } else {
      const d = SV.decimate(r.t, waves.map(w => w.v), forPng ? 2400 : PLOT_POINTS, v.lo, v.hi);
      const tx = d.t.map(ns);
      waves.forEach((w, k) => series.push({name: w.probe + " " + w.corner, x: tx, y: d.ys[k], color: w.color, style: STYLE[w.corner]}));
    }
    const rx = r.metrics.find(m => m.role === "receiver") || r.metrics[0];
    const hlines = rx ? [{y: rx.vinh, label: "Vinh"}, {y: rx.vinl, label: "Vinl"}] : [];
    const vlines = st.eye && period ? [] : [{x: ns(v.a), label: "A"}, {x: ns(v.b), label: "B"}];
    return {type: "plot", size: "large", title: (st.eye && period ? "Eye overlay · " : "") + r.net + " · " + r.corners.join("/") + " · " + r.stimulus.type, xLabel: "Time (ns)", yLabel: "V",
      xRange: st.eye && period ? [0, ns(period)] : [ns(v.lo), ns(v.hi)], series, hlines, vlines, zoomCommand: "si.zoom", cursorCommand: "si.cursor"};
  }
  function cursorTable() {
    const r = st.result, v = st.view, rows = [{sig: "time", a: U.eng(v.a, "s"), b: U.eng(v.b, "s"), d: U.eng(v.b - v.a, "s")}];
    for (const w of chosenWaves()) { const va = SV.at(r.t, w.v, v.a), vb = SV.at(r.t, w.v, v.b); rows.push({sig: w.probe + " " + w.corner, a: U.eng(va, "V"), b: U.eng(vb, "V"), d: U.eng(vb - va, "V")}); }
    return {type: "table", columns: [{key: "sig", title: "Cursor"}, {key: "a", title: "A", align: "right"}, {key: "b", title: "B", align: "right"}, {key: "d", title: "Δ", align: "right"}], rows};
  }
  function viewAction(action) {
    const r = st.result, v = st.view; if (!r || !v) return;
    const span = v.hi - v.lo, mid = (v.lo + v.hi) / 2;
    const set = (a, b) => { a = Math.max(0, a); b = Math.min(r.tstop, b); if (b - a > r.dt * 4) { v.lo = a; v.hi = b; } };
    if (action === "in") set(mid - span / 4, mid + span / 4);
    else if (action === "out") set(mid - span, mid + span);
    else if (action === "left") { const d = Math.min(span / 2, v.lo); set(v.lo - d, v.hi - d); }
    else if (action === "right") { const d = Math.min(span / 2, r.tstop - v.hi); set(v.lo + d, v.hi + d); }
    else if (action === "fit") { v.lo = 0; v.hi = r.tstop; }
    else if (action === "cursors") set(Math.min(v.a, v.b), Math.max(v.a, v.b));
    else if (action === "center") { v.a = v.lo + span / 3; v.b = v.lo + 2 * span / 3; }
    else if (action === "edge") { const e = r.stimulus.edges[0].t; set(Math.max(0, e - 0.2e-9), Math.min(r.tstop, e + Math.max(2e-9, 6 * r.tr + 4 * (r.channel.lines.reduce((s, l) => s + l.delayPs, 0) * 1e-12)))); }
  }

  // ---------------------------------------------------------------- panel
  const fmt = (x, u, d) => (U ? U.eng(x, u, d) : String(x));
  const pct = x => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(1) + " %");
  async function render() {
    lib();
    const view = [];
    const r = st.result;
    const sim = await models().catch(() => ({models: [], assign: {}}));
    view.push({type: "text", muted: true, text: "IBIS-based reflection and crosstalk on routed nets. Line impedance and delay come from the 2D field solver per cross-section; vias are lumped (barrel L and C, stubs after back-drill)."});
    if (st.notice) view.push({type: "text", level: st.notice.level === "error" ? "error" : st.notice.level === "warn" ? "warn" : "info", text: st.notice.text});
    const drivers = st.plan && st.plan.net === st.net ? st.plan.endpoints.filter(e => !e.special && e.canDrive).map(e => e.ref + "." + e.pin + " (" + (e.source === "ibis" ? e.model.name : "generic") + ")") : [];
    view.push({type: "form", fields: [
      {key: "net", label: "Net", type: "string", value: st.net, placeholder: "select a track, or type a net"},
      {key: "driver", label: "Driver", type: drivers.length ? "enum" : "string", options: ["auto", ...drivers], value: drivers.find(d => d.startsWith(st.driver + " ")) || (drivers.length ? "auto" : st.driver)},
      {key: "stimulus", label: "Stimulus", type: "enum", options: ["rise", "fall", "pulse", "clock"], value: st.stimulus},
      {key: "freq", label: "Clock frequency", type: "string", value: st.freq},
      {key: "typ", label: "Typical", type: "boolean", value: st.corners.includes("typ")},
      {key: "min", label: "Min (slow, weak)", type: "boolean", value: st.corners.includes("min")},
      {key: "max", label: "Max (fast, strong)", type: "boolean", value: st.corners.includes("max")},
      {key: "loss", label: "Lossy lines", type: "boolean", value: st.loss},
      {key: "crosstalk", label: "Crosstalk", type: "boolean", value: st.crosstalk},
      {key: "gap", label: "Neighbour distance (mm)", type: "number", step: "0.05", value: st.gap}],
      submit: {label: st.running ? "Running…" : "Simulate", command: "si.run"}});
    view.push({type: "buttons", items: [
      ...(st.running ? [{label: "Cancel", command: "si.cancel"}] : [{label: "Simulate selected net", command: "si.simulateNet"}]),
      {label: "Import IBIS model…", command: "si.importIbis"}, {label: "Assign model to selected part…", command: "si.assignModel"}]});
    if (st.progress) view.push({type: "text", muted: true, text: "Running: " + st.progress.stage + " " + Math.round(100 * (st.progress.progress || 0)) + " %"});
    if (st.error) view.push({type: "text", level: "error", text: st.error});
    if (r) {
      const corner0 = r.stats.corners[r.corners[0]] || {};
      view.push({type: "heading", text: "Waveforms · " + r.net});
      view.push({type: "text", muted: true, text: "Driver " + r.driver.ref + "." + r.driver.pin + " (" + (r.driver.source === "ibis" ? r.driver.model + " · " + r.driver.file : "generic " + r.driver.model) + ") · " +
        r.receivers.length + " receiver" + (r.receivers.length === 1 ? "" : "s") + " · edge " + fmt(r.tr, "s") + " · step " + fmt(r.dt, "s") + " · " + corner0.nodes + " nodes · " + (r.stats.totalMs ?? r.stats.ms) + " ms (" + r.stats.fieldSolves + " cross-sections, " + r.stats.freshSolves + " solved now)"});
      view.push(plotData(false));
      view.push({type: "buttons", items: [
        {label: "Zoom in", command: "si.view", args: ["in"]}, {label: "Zoom out", command: "si.view", args: ["out"]}, {label: "◀", command: "si.view", args: ["left"]}, {label: "▶", command: "si.view", args: ["right"]},
        {label: "Edge", command: "si.view", args: ["edge"]}, {label: "Zoom to cursors", command: "si.view", args: ["cursors"]}, {label: "Fit", command: "si.view", args: ["fit"]},
        ...(r.stimulus.period ? [{label: st.eye ? "● Eye overlay" : "Eye overlay", command: "si.toggle", args: ["eye"]}] : []),
        {label: "Show: " + st.probe, command: "si.toggle", args: ["probe"]}]});
      view.push({type: "text", muted: true, text: "Drag across the plot to zoom, Ctrl/⌘+wheel zooms, double-click fits. Click places cursor A, Shift+click cursor B. Solid typ, dashed min, faint max."});
      view.push(cursorTable());
      view.push({type: "heading", text: "Results"});
      // Receivers only (the driver's own pin is in the plot); the edge rides on the corner (↑ rise, ↓ fall).
      const small = (x, u) => (x != null && Math.abs(x) < 1e-4 ? "0" : fmt(x, u));
      view.push({type: "table", columns: [{key: "probe", title: "Pin"}, {key: "corner", title: "Corner"}, {key: "os", title: "Over­shoot", align: "right"},
        {key: "us", title: "Under­shoot", align: "right"}, {key: "rb", title: "Ringback margin", align: "right"}, {key: "st", title: "Settle", align: "right"}, {key: "fl", title: "Flight Vinl / Vinh", align: "right"},
        {key: "mono", title: "Mono­tonic"}],
        rows: r.metrics.filter(m => m.role === "receiver").slice(0, 200).map(m => ({probe: m.probe, corner: m.corner + (m.edge === "rise" ? " ↑" : " ↓"),
          os: m.overshootPct > 0.05 ? m.overshootPct.toFixed(1) + " %" : "0", us: small(m.undershoot, "V"), rb: m.ringback == null ? "—" : small(m.ringback, "V"), st: m.settle == null ? "not settled" : fmt(m.settle, "s"),
          fl: (m.tVinl == null ? "—" : fmt(m.tVinl, "s")) + " / " + (m.tVinh == null ? "—" : fmt(m.tVinh, "s")), mono: m.monotonic ? "yes" : "no", locate: m.partId}))});
      if (r.violations.length) view.push({type: "list", items: r.violations.slice(0, 40).map(v => ({label: (v.class === "Error" ? "✖ " : "⚠ ") + v.text, ...(v.partId ? {locate: v.partId} : {})}))});
      else view.push({type: "text", level: "info", text: "No violations at " + r.corners.join(", ") + "."});
      view.push({type: "buttons", items: [{label: "Send to Messages", command: "si.toMessages"}, {label: "Export CSV…", command: "si.exportCsv"}, {label: "Export PNG…", command: "si.exportPng"}]});
      if (r.crosstalk.length || st.crosstalk) {
        view.push({type: "heading", text: "Crosstalk (" + (r.crosstalk[0]?.corner || "fast corner") + ", victims terminated in their Z0)"});
        if (r.crosstalk.length) view.push({type: "table", columns: [{key: "v", title: "Victim"}, {key: "l", title: "Layer"}, {key: "len", title: "Coupled", align: "right"}, {key: "g", title: "Gap", align: "right"},
          {key: "n", title: "NEXT", align: "right"}, {key: "f", title: "FEXT", align: "right"}, {key: "kb", title: "Kb (closed form)", align: "right"}],
          rows: r.crosstalk.map(x => ({v: x.victim, l: x.layer, len: x.length.toFixed(2) + " mm" + (x.runs > 1 ? " (" + x.runs + " runs)" : ""), g: x.gap.toFixed(3) + " mm",
            n: fmt(x.next, "V") + " · " + pct(x.nextPct), f: fmt(x.fext, "V") + " · " + pct(x.fextPct), kb: (100 * x.kb).toFixed(2) + " %"}))});
        else view.push({type: "text", muted: true, text: "No neighbour runs parallel within " + st.gap + " mm (at least 1 mm long)."});
      }
      view.push({type: "heading", text: "Termination what-ifs"});
      view.push({type: "buttons", items: [{label: "Sweep series R at the driver", command: "si.sweep", args: ["series"]}, {label: "Sweep parallel R to GND at the receivers", command: "si.sweep", args: ["parallel"]}]});
      for (const sw of [st.seriesSweep, st.parallelSweep]) if (sw) {
        const name = sw.kind === "series" ? "Series R" : "Parallel R";
        view.push({type: "text", level: "info", text: name + ": best " + (sw.best === 0 ? "none" : sw.best + " Ω") + (sw.kind === "series" && sw.theory != null ? " · rule of thumb Z0 − Rout = " + sw.theory.toFixed(1) + " Ω" : "") + " (typ corner, lowest worst overshoot/undershoot that still crosses the thresholds without ringback)."});
        view.push({type: "table", columns: [{key: "r", title: name}, {key: "os", title: "Overshoot", align: "right"}, {key: "us", title: "Undershoot", align: "right"}, {key: "rb", title: "Ringback margin", align: "right"}, {key: "st", title: "Settle", align: "right"}, {key: "dl", title: "Delay", align: "right"}, {key: "ok", title: "OK"}],
          rows: sw.rows.map(x => ({r: x.value === 0 ? "none" : x.value + " Ω", os: pct(x.overshootPct), us: pct(x.undershootPct), rb: Number.isFinite(x.ringback) ? fmt(x.ringback, "V") : "—", st: Number.isFinite(x.settle) ? fmt(x.settle, "s") : "—", dl: fmt(x.delay, "s"), ok: x.score < 1000 ? (x.value === sw.best ? "best" : "yes") : "no"}))});
      }
      view.push({type: "heading", text: "Channel"});
      view.push({type: "table", columns: [{key: "k", title: "Element"}, {key: "l", title: "Layer / span"}, {key: "len", title: "Length", align: "right"}, {key: "z", title: "Z0 / L", align: "right"}, {key: "d", title: "Delay / C", align: "right"}],
        rows: [...r.channel.lines.map(l => ({k: "Line " + l.width.toFixed(3) + " mm" + (l.fallback ? " (no plane)" : ""), l: l.layer, len: l.length.toFixed(2) + " mm", z: l.z.toFixed(1) + " Ω", d: l.delayPs.toFixed(1) + " ps"})),
          ...r.channel.vias.map(v => ({k: v.kind === "stub" ? "Via stub" : "Via", l: v.kind === "stub" ? v.side : v.from + " → " + v.to, len: v.length.toFixed(3) + " mm", z: fmt(v.L, "H"), d: fmt(v.C, "F")})),
          ...r.channel.series.map(s => ({k: "Series " + s.ref, l: s.kind, len: "", z: s.kind === "R" ? s.value + " Ω" : fmt(s.value, s.kind === "C" ? "F" : "H"), d: ""})),
          ...r.channel.shunts.map(s => ({k: "Shunt " + s.ref, l: s.kind + " to " + s.rail, len: "", z: s.kind === "R" ? s.value + " Ω" : fmt(s.value, "F"), d: ""}))].slice(0, 300)});
    }
    // Models on the net and in the project.
    if (st.plan) {
      view.push({type: "heading", text: "Models on " + st.plan.net});
      view.push({type: "list", items: st.plan.endpoints.slice(0, 60).map(e => ({label: e.ref + "." + e.pin + (e === st.plan.driver ? " (driver)" : "") + ": " + (e.special ? e.special : e.source === "ibis" ? e.model.name + " (" + e.model.type + ") · " + e.file : "generic " + e.model.type),
        detail: "assign…", command: "si.assignModel", args: [e.part.id]}))});
    }
    view.push({type: "heading", text: "IBIS files in this project"});
    if (sim.models.length) view.push({type: "list", items: sim.models.map(m => ({label: m.name + " · " + (m.summary?.components || []).map(c => c.name).join(", ") + " · " + Math.round(m.size / 1024) + " KB", detail: "remove", command: "si.removeModel", args: [m.key]}))});
    else view.push({type: "text", muted: true, text: "None yet. Import an IBIS file (.ibs) from a part vendor; it is checked, stored in the project and travels with it. Unassigned pins use a generic 3.3 V CMOS buffer (25 Ω, 0.5 ns)."});
    const notes = [...(r?.warnings || [])];
    if (notes.length) view.push({type: "heading", text: "Notes"}, {type: "list", items: notes.slice(0, 40).map(n => ({label: n}))});
    await api.ui.setPanel(PANEL, view);
  }

  // ---------------------------------------------------------------- exports
  async function exportCsv() {
    const r = st.result; if (!r) throw Error("Simulate a net first.");
    const head = ["time_s", ...r.waves.map(w => w.probe + "_" + w.corner + "_V")];
    const lines = [head.join(",")];
    const step = Math.max(1, Math.ceil(r.t.length / 200000));
    for (let i = 0; i < r.t.length; i += step) lines.push([r.t[i].toExponential(6), ...r.waves.map(w => w.v[i].toPrecision(6))].join(","));
    await api.files.export(r.net.replace(/[^\w.-]/g, "_") + "-si.csv", lines.join("\n") + "\n");
    return {rows: lines.length - 1};
  }
  async function exportPng() {
    const r = st.result; if (!r) throw Error("Simulate a net first.");
    PNG = PNG || require("./png.js");
    const bytes = PNG.png(plotData(true), {width: 1200, height: 640});
    await api.files.export(r.net.replace(/[^\w.-]/g, "_") + "-si.png", api.transfer(bytes));
    return {bytes: bytes.length};
  }

  // ---------------------------------------------------------------- commands
  const guarded = fn => async (...a) => { await ready; try { return await fn(...a); } catch (e) { st.error = e.message; await render().catch(() => {}); throw e; } };
  const show = async () => { await api.ui.registerPanel(PANEL, {title: "Signal Integrity", location: "right", tall: true}); await render(); await api.ui.showPanel(PANEL); };
  context.subscriptions.push(
    api.commands.register("si.show", guarded(show)),
    api.commands.register("si.simulateNet", guarded(async arg => { await api.ui.registerPanel(PANEL, {title: "Signal Integrity", location: "right", tall: true});
      if (arg && typeof arg === "object" && arg.net) { st.net = String(arg.net); st.driver = arg.driver || ""; } else { await pickNet(); if (!st.net) return null; }
      await show(); return run(); })),
    api.commands.register("si.run", guarded(values => run(values))),
    api.commands.register("si.cancel", guarded(async () => { st.cancelled = true; return true; })),
    api.commands.register("si.importIbis", guarded(async () => { await show(); return importIbis(); })),
    api.commands.register("si.assignModel", guarded(async (partId, preset) => assignModel(typeof partId === "string" ? partId : null, preset))),
    api.commands.register("si.clearModel", guarded(clearModel)),
    api.commands.register("si.removeModel", guarded(removeModel)),
    api.commands.register("si.view", guarded(async a => { viewAction(a); await render(); return st.view; })),
    api.commands.register("si.zoom", guarded(async o => {
      if (!st.result) return null;
      if (o?.fit) viewAction("fit");
      else if (Number.isFinite(o?.x0) && Number.isFinite(o?.x1) && o.x1 > o.x0) { const r = st.result, a = Math.max(0, o.x0 * 1e-9), b = Math.min(r.tstop, o.x1 * 1e-9); if (b - a > r.dt * 4) { st.view.lo = a; st.view.hi = b; } }
      await render(); return st.view; })),
    api.commands.register("si.cursor", guarded(async o => { if (!st.result || !Number.isFinite(o?.x)) return null; st.view[o.cursor === "b" ? "b" : "a"] = Math.max(0, Math.min(st.result.tstop, o.x * 1e-9)); await render(); return st.view; })),
    api.commands.register("si.toggle", guarded(async k => {
      if (k === "eye") st.eye = !st.eye;
      if (k === "probe") { const opts = ["all", "receivers", ...new Set((st.result?.waves || []).map(w => w.probe))]; st.probe = opts[(opts.indexOf(st.probe) + 1) % opts.length] || "all"; }
      save(); await render(); return true; })),
    api.commands.register("si.sweep", guarded(kind => sweep(kind === "parallel" ? "parallel" : "series"))),
    api.commands.register("si.toMessages", guarded(() => sendMessages(false))),
    api.commands.register("si.exportCsv", guarded(exportCsv)),
    api.commands.register("si.exportPng", guarded(exportPng)),
    // Programmatic: {net, driver, corners, stimulus, freq, loss, crosstalk, gap, sweep: "series"|"parallel", waves}
    api.commands.register("si.simulate", guarded(async (o = {}) => {
      if (!o.net) throw Error("si.simulate needs {net}.");
      const out = await simulateNet({corners: ["typ"], loss: true, crosstalk: false, gap: 0.5, stimulus: "rise", ...o});
      const s = EN.summary(out.r, {waves: !!o.waves});
      if (o.sweep) s.sweep = EN.drain(EN.sweep(out.p, out.solved, {kind: o.sweep === "parallel" ? "parallel" : "series", sim: {...out.opts, stimulus: {type: "rise"}}}));
      return s;
    }))
  );
  context.subscriptions.push({dispose() { st.cancelled = true; }});
};
