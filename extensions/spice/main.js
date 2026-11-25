// SPICE Simulation: a first-party extension. It runs in its own sandboxed worker with no network,
// through the public API. Benches and model assignments are reviewed project edits.
// spice.js (the solver) and export.js (schematic → netlist) load on first use.
let S = null, X = null, MD = null;
const lib = () => { S = S || require("./spice.js"); X = X || require("./export.js"); MD = MD || require("./models.js"); };
const PANEL = "waffle.spice", MAX_TRACES = 6, PLOT_POINTS = 1200, MAX_ROWS = 400;
const ANALYSES = [["op", "Operating point"], ["dc", "DC sweep"], ["ac", "AC"], ["tran", "Transient"]];
const ENGINES = {builtin: "Built-in", ngspice: "ngspice", ltspice: "LTspice"};
// Integration methods by their stored id (trap, be) and the names the panel shows.
const METHODS = {trap: "Trapezoidal", be: "Backward Euler"};
const methodId = v => Object.keys(METHODS).find(k => k === v || METHODS[k] === v) || v;
const defaults = () => ({analysis: "tran", tran: {tstep: "10u", tstop: "5m", method: "trap"},
  ac: {sweep: "dec", points: 20, fstart: "10", fstop: "1meg"}, dc: {source: "", start: "0", stop: "5", step: "50m"},
  probes: [], engine: "builtin", bench: null, name: "Test bench"});

exports.activate = function (api, context) {
  const st = {...defaults(), benches: [], project: null, showNetlist: false, design: null, result: null,
    error: null, errorRefs: [], view: null, wizard: null, input: null};
  let generation = 0, refreshTimer = null, saving = false;
  const painted = new Map(), paintTimes = [];
  let paintQueue = Promise.resolve(), paintRequest = 0;
  function selectBench(bench) {
    generation++;
    Object.assign(st, defaults(), {result: null, view: null, error: null, errorRefs: [], wizard: null});
    if (!bench) return;
    st.bench = bench; st.name = bench.name || "Test bench";
    st.engine = Object.hasOwn(ENGINES, bench.engine) ? bench.engine : "builtin";
    const a = bench.analyses?.[0] || {}, kind = a.type || a.kind;
    if (ANALYSES.some(([k]) => k === kind)) { st.analysis = kind; applyFields(a); }
    if (Array.isArray(bench.probes)) st.probes = bench.probes.filter(n => typeof n === "string").slice(0, 50);
  }
  function applyFields(values = {}) {
    const into = st[st.analysis];
    if (into) for (const k of Object.keys(into)) if (values[k] != null) into[k] = k === "points" ? Number(values[k]) : k === "method" ? methodId(String(values[k])) : String(values[k]);
    if (values.name != null) st.name = String(values.name).trim().slice(0, 120);
    if (values.engine != null) {
      const id = String(values.engine).toLowerCase().replace("-", "");
      if (!Object.hasOwn(ENGINES, id)) throw Error("Unknown SPICE engine.");
      st.engine = id;
    }
  }
  async function syncBenches() {
    const [info, simulation] = await Promise.all([api.project.info(), api.simulation.get()]);
    const key = JSON.stringify([info.name, info.documents[0]?.id]);
    st.benches = simulation.benches || [];
    if (key !== st.project) {
      st.project = key; st.design = null; st.input = null;
      selectBench(st.benches.find(b => typeof b?.id === "string"));
      if (painted.size) await drawProbes();
    }
  }
  async function saveBench(values) {
    if (saving) throw Error("A bench is already waiting for review.");
    saving = true;
    try { return await proposeBench(values); } finally { saving = false; }
  }
  async function proposeBench(values) {
    await syncBenches(); applyFields(values);
    if (!st.name) throw Error("Enter a name for the test bench.");
    analysisSpec();
    const before = st.bench, other = st.benches.find(b => b?.id === before?.id);
    if (before && JSON.stringify(before) !== JSON.stringify(other)) throw Error("This bench changed. Reopen it before saving.");
    const id = before?.id || ("spice-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));
    const owner = st.project, existingAnalyses = Array.isArray(before?.analyses) ? before.analyses : [];
    const prior = existingAnalyses[0], sameAnalysis = (prior?.type || prior?.kind) === st.analysis;
    const bench = {...before, id, name: st.name, engine: st.engine, probes: st.probes,
      analyses: [{...(sameAnalysis ? prior : {}), type: st.analysis, ...st[st.analysis]}, ...existingAnalyses.slice(1)]};
    const benches = before ? st.benches.map(b => b?.id === id ? bench : b) : [...st.benches, bench];
    const reply = await api.proposals.propose([{target: "project", path: ["simulation", "benches"], value: benches}], {label: "Save SPICE bench " + st.name});
    if (owner === st.project && (reply.applied || reply.unchanged)) { st.benches = benches; if (st.bench === before) st.bench = bench; }
    if (reply.applied) await refresh(); else await render();
    return reply;
  }

  // ---------------------------------------------------------------- design → netlist
  async function design() {
    lib();
    const [info, netlist] = await Promise.all([api.project.info(), api.project.netlist({format: "json"})]);
    const parts = [];
    for (const doc of info.documents.filter(d => d.kind === "schematic"))
      parts.push(...await api.items.list({doc: doc.id, kind: "part", fields: ["id", "ref", "value", "def", "unit", "part", "parameters", "dnp", "doNotPopulate", "populate", "fitted", "sim"]}));
    const defs = await api.defs.list({fields: ["id", "name", "parameters", "category", "package", "generic", "sim"]});
    const sch = new Set((netlist.components || []).map(c => c.id));
    const schParts = parts.filter(p => sch.has(p.id));
    // Fitted state and parameter values under the active assembly variant come from the BOM feature.
    let fitted = null, variant = null, overrides = null;
    const names = new Set();
    for (const p of [...schParts, ...defs]) for (const k of Object.keys(p.parameters || {})) if (X.isSimParam(k)) names.add(k.toUpperCase().replace(/[_\s]+/g, " "));
    try {
      const r = await api.bom({source: "schematic", showDnp: true, groupBy: [], columns: ["designator", "dnp", ...[...names].map(n => "p:" + n)]});
      variant = r.variant || null; fitted = {}; overrides = {};
      for (const row of r.rows || []) {
        const ref = String(row[0]).toUpperCase();
        if (row[1]) fitted[ref] = false;
        const o = {}; [...names].forEach((n, i) => { if (row[i + 2] !== "" && row[i + 2] != null) o[n] = row[i + 2]; });
        if (Object.keys(o).length) overrides[ref] = o;
      }
    } catch {
      fitted = {};
      for (const p of schParts) if (p.dnp === true || p.doNotPopulate === true || p.populate === false || p.fitted === false || /^(dnp|dni|dnf)$/i.test(String(p.value || "").trim())) fitted[String(p.ref).toUpperCase()] = false;
    }
    return {title: info.name, netlist, parts: schParts, defs, fitted, variant, overrides};
  }
  function analysisSpec() {
    lib();
    const a = st.analysis, need = (v, what) => { const n = S.num(v); if (!Number.isFinite(n)) throw Error(what + " \"" + v + "\" is not a number (use SPICE suffixes: 10u, 2.2k, 1meg)."); return n; };
    if (a === "op") return {type: "op"};
    if (a === "tran") return {type: "tran", tstep: need(st.tran.tstep, "Step"), tstop: need(st.tran.tstop, "Stop time"), method: st.tran.method};
    if (a === "ac") return {type: "ac", sweep: st.ac.sweep, points: need(st.ac.points, "Points"), fstart: need(st.ac.fstart, "Start frequency"), fstop: need(st.ac.fstop, "Stop frequency")};
    if (!st.dc.source) throw Error("Choose a source to sweep.");
    return {type: "dc", source: st.dc.source, start: need(st.dc.start, "Start"), stop: need(st.dc.stop, "Stop"), step: need(st.dc.step, "Step")};
  }
  async function netlist(analysis) {
    lib();
    const d = await design();
    const out = X.exportNetlist({...d, analysis, probes: st.probes});
    st.input = d;
    st.title = d.title;
    st.design = {variant: d.variant, out, sources: out.elements.map(e => e.line.split(/\s+/)[0]).filter(n => /^[VI]/i.test(n))};
    if (!st.dc.source || !st.design.sources.includes(st.dc.source)) st.dc.source = st.design.sources[0] || "";
    return out;
  }

  // ---------------------------------------------------------------- simulation
  const solve = (engine, text, an, out) => engine === "builtin" ? S.simulate(text, an, {missing: "skip"}) : require("./external.js").run(api, engine, text, an, out);
  async function run() {
    lib();
    clearTimeout(refreshTimer);
    const token = ++generation, engine = st.engine;
    st.error = null; st.errorRefs = [];
    try {
      const an = analysisSpec(), out = await netlist(an);
      if (token !== generation) return {error: "The bench changed during the run."};
      const res = await solve(engine, out.text, an, out);
      if (token !== generation) return {error: "The bench changed during the run."};
      st.result = {res, an, engine, deck: out.text, nodeMap: out.nodeMap, nodeOf: out.nodeOf};
      st.view = initialView(res);
    } catch (e) {
      if (token !== generation) return {error: "The bench changed during the run."};
      st.error = e.message; st.errorRefs = e.refs || []; st.result = null;
    }
    await drawProbes();
    await render();
    return st.result ? {analysis: st.result.an.type, points: st.result.res.x?.length || 0, warnings: st.result.res.warnings.length} : {error: st.error};
  }
  // The API allows 32 decorated documents and 20 set calls per second. Paint only changed
  // sheets. When a large design reaches the document limit the focused sheet always has a slot.
  function drawProbes(focus) {
    const request = ++paintRequest;
    paintQueue = paintQueue.then(async () => {
      if (request !== paintRequest) return;
      const selected = new Set(st.probes), result = st.result, nodes = result?.res.type === "op" ? result.res.nodes : null;
      const sheets = new Map();
      if (st.input && (selected.size || nodes)) {
        const parts = new Map(st.input.parts.map(p => [p.id, p]));
        const readings = nodes && new Map(Object.entries(nodes).map(([n, v]) => [result.nodeMap[n] || n, v]));
        for (const c of st.input.netlist.components) {
          const part = parts.get(c.id);
          let nets = sheets.get(c.sheet);
          for (const pin of c.pins) {
            if (!pin.net || /^NC_/.test(pin.net) || nets?.has(pin.net) || pin.unit && pin.unit !== (part?.unit || part?.part || 1)) continue;
            const probed = selected.has(pin.net), volts = readings && (X.GROUND.test(pin.net) ? 0 : readings.get(pin.net));
            if (!probed && !Number.isFinite(volts)) continue;
            if (!nets) sheets.set(c.sheet, nets = new Map());
            if (nets.size >= 2000 && !probed) continue;
            nets.set(pin.net, {kind: "probe", text: pin.net.slice(0, 88) + (Number.isFinite(volts) ? "  " + S.eng(volts, "V") : ""),
              anchor: {id: c.id, pin: String(pin.number)}, tone: probed ? "accent" : "info"});
          }
        }
      }
      let ids = [...sheets.keys()];
      if (ids.length > 32) {
        const active = focus || (await api.documents.active()).id;
        ids = ids.filter(id => id !== active);
        if (sheets.has(active)) ids.unshift(active);
        ids = ids.slice(0, 32);
      }
      if (!ids.length && painted.size) { await api.ui.decorations.clear(); painted.clear(); return; }
      for (const id of painted.keys()) if (!ids.includes(id)) { await api.ui.decorations.clear(id); painted.delete(id); }
      for (const id of ids) {
        let items = [...sheets.get(id).values()];
        if (items.length > 2000) items = items.filter(it => it.tone === "accent").concat(items.filter(it => it.tone !== "accent")).slice(0, 2000);
        const signature = JSON.stringify(items);
        if (painted.get(id) === signature) continue;
        const now = Date.now();
        while (paintTimes.length && now - paintTimes[0] >= 1000) paintTimes.shift();
        if (paintTimes.length >= 20) await new Promise(resolve => setTimeout(resolve, 1010 - (now - paintTimes[0])));
        if (request !== paintRequest) return;
        await api.ui.decorations.set(id, items);
        paintTimes.push(Date.now()); painted.set(id, signature);
      }
    }).catch(e => api.log(e.message));
    return paintQueue;
  }
  // Probes are net names; default to a few named nets when none are chosen.
  function traces(res) {
    const want = st.probes.length ? st.probes : Object.values(st.result.nodeMap).filter(n => !/^NC_|^Net/i.test(n)).slice(0, 4);
    const out = [];
    for (const net of want) {
      const node = st.result.nodeOf(net), s = node === "0" ? null : S.signal(res, "v(" + node + ")");
      if (s) out.push({name: net, s});
      if (out.length >= MAX_TRACES) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- waveform viewer
  const isLog = res => res.type === "ac";
  const ax = (res, x) => (isLog(res) ? Math.log10(x) : x), unax = (res, u) => (isLog(res) ? 10 ** u : u);
  function initialView(res) {
    if (res.type === "op" || !res.x.length) return null;
    const lo = Math.min(res.x[0], res.x[res.x.length - 1]), hi = Math.max(res.x[0], res.x[res.x.length - 1]), a = ax(res, lo), b = ax(res, hi);
    return {lo, hi, a: unax(res, a + (b - a) * 0.25), b: unax(res, a + (b - a) * 0.75)};
  }
  function viewAction(action) {
    const r = st.result?.res, v = st.view; if (!r || !v) return;
    const full = initialView(r), a = ax(r, v.lo), b = ax(r, v.hi), span = b - a, mid = (a + b) / 2;
    const set = (x0, x1) => { const f0 = ax(r, full.lo), f1 = ax(r, full.hi); x0 = Math.max(f0, x0); x1 = Math.min(f1, x1); if (x1 - x0 > (f1 - f0) * 1e-6) { v.lo = unax(r, x0); v.hi = unax(r, x1); } };
    if (action === "in") set(mid - span / 4, mid + span / 4);
    else if (action === "out") set(mid - span, mid + span);
    else if (action === "left") { const d = Math.min(span / 2, a - ax(r, full.lo)); set(a - d, b - d); }
    else if (action === "right") { const d = Math.min(span / 2, ax(r, full.hi) - b); set(a + d, b + d); }
    else if (action === "fit") { v.lo = full.lo; v.hi = full.hi; }
    else if (action === "cursors") { const c0 = Math.min(ax(r, v.a), ax(r, v.b)), c1 = Math.max(ax(r, v.a), ax(r, v.b)); if (c1 > c0) set(c0, c1); }
    else if (action === "center") { const ca = ax(r, v.lo) + (ax(r, v.hi) - ax(r, v.lo)) / 3, cb = ax(r, v.lo) + (ax(r, v.hi) - ax(r, v.lo)) * 2 / 3; v.a = unax(r, ca); v.b = unax(r, cb); }
  }
  // Points inside the window, reduced to min/max pairs per bucket so peaks survive.
  function decimate(xs, ys, lo, hi) {
    const idx = [];
    for (let i = 0; i < xs.length; i++) if (xs[i] >= lo && xs[i] <= hi || (xs[i + 1] >= lo && xs[i] < lo) || (xs[i - 1] <= hi && xs[i] > hi)) idx.push(i);
    if (idx.length <= PLOT_POINTS) return {x: idx.map(i => xs[i]), y: idx.map(i => ys[i])};
    const x = [], y = [], per = Math.ceil(idx.length / (PLOT_POINTS / 2));
    for (let k = 0; k < idx.length; k += per) {
      let mn = idx[k], mx = idx[k];
      for (let j = k; j < Math.min(idx.length, k + per); j++) { if (ys[idx[j]] < ys[mn]) mn = idx[j]; if (ys[idx[j]] > ys[mx]) mx = idx[j]; }
      for (const i of mn < mx ? [mn, mx] : mn > mx ? [mx, mn] : [mn]) { x.push(xs[i]); y.push(ys[i]); }
    }
    return {x, y};
  }
  function xUnit(res, lo, hi) {
    if (res.type === "ac") return {k: 1, label: "Frequency (Hz)", u: "Hz"};
    const span = Math.max(Math.abs(lo), Math.abs(hi)), base = res.type === "tran" ? "s" : /^i/i.test(res.xName) ? "A" : "V";
    const [k, p] = [[1, ""], [1e3, "m"], [1e6, "µ"], [1e9, "n"], [1e12, "p"]].find(([k]) => span * k >= 1) || [1e12, "p"];
    return {k, label: (res.type === "tran" ? "Time" : res.xName) + " (" + p + base + ")", u: base};
  }
  function plot(res, title, yLabel, list, view) {
    const xu = xUnit(res, view.lo, view.hi), series = [];
    let y0 = Infinity, y1 = -Infinity;
    for (const t of list) {
      const d = decimate(res.x, t.y, view.lo, view.hi);
      for (const y of d.y) if (Number.isFinite(y)) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      series.push({name: t.name, x: d.x.map(x => x * xu.k), y: d.y});
    }
    if (!(y1 >= y0)) { y0 = 0; y1 = 1; }
    for (const [name, c] of [["A", view.a], ["B", view.b]]) if (c >= view.lo && c <= view.hi) series.push({name: "cursor " + name, x: [c * xu.k, c * xu.k], y: [y0, y1]});
    return {type: "plot", title, xLabel: xu.label, yLabel, xLog: isLog(res), series};
  }
  function cursorTable(res, list, view, fmt) {
    const xu = xUnit(res, view.lo, view.hi), at = (t, c) => S.at(res.x, t.y, c);
    const rows = [{sig: res.type === "tran" ? "time" : res.xName, a: S.eng(view.a, xu.u), b: S.eng(view.b, xu.u), d: S.eng(view.b - view.a, xu.u)}];
    for (const t of list) { const va = at(t, view.a), vb = at(t, view.b); rows.push({sig: t.name, a: fmt(va), b: fmt(vb), d: fmt(vb - va)}); }
    if (res.type !== "ac" && list.length) rows.push({sig: "1/Δ", a: "", b: "", d: S.eng(1 / Math.abs(view.b - view.a), res.type === "tran" ? "Hz" : "")});
    return {type: "table", columns: [{key: "sig", title: "Cursor"}, {key: "a", title: "A", align: "right"}, {key: "b", title: "B", align: "right"}, {key: "d", title: "Δ", align: "right"}], rows};
  }
  function resultView() {
    const R = st.result; if (!R) return [];
    const res = R.res, out = [];
    const stats = res.stats || {};
    out.push({type: "text", muted: true, text: [ENGINES[R.engine], res.type === "op" ? null : res.x.length + " points",
      stats.steps != null ? stats.steps + " steps (" + stats.rejected + " rejected)" : null,
      stats.unknowns != null ? stats.unknowns + " unknowns" : null, stats.iterations != null ? stats.iterations + " Newton iterations" : null, stats.ms + " ms"].filter(Boolean).join(" · ")});
    if (res.type === "op") {
      const cur = Object.entries(res.currents).filter(([n]) => /^[VEH]/i.test(n) && !n.includes(".")).slice(0, MAX_ROWS);
      if (cur.length) out.push({type: "heading", text: "Source currents"}, {type: "table", columns: [{key: "n", title: "Source"}, {key: "i", title: "Current (into +)", align: "right"}, {key: "p", title: "Power", align: "right"}],
        rows: cur.map(([n, i]) => ({n, i: S.eng(i, "A"), p: n[0].toUpperCase() === "V" ? S.eng(-i * sourceVolts(res, n), "W") : ""}))});
      const devs = Object.entries(res.devices).filter(([n]) => !n.includes(".")).slice(0, MAX_ROWS);
      if (devs.length) out.push({type: "heading", text: "Semiconductors"}, {type: "table", columns: [{key: "n", title: "Part"}, {key: "m", title: "Model"}, {key: "a", title: "Operating point"}],
        rows: devs.map(([n, d]) => ({n, m: d.model, a: d.type === "D" ? "Id " + S.eng(d.id, "A") + ", Vd " + S.eng(d.vd, "V") : d.type === "Q" ? "Ic " + S.eng(d.ic, "A") + ", Ib " + S.eng(d.ib, "A") + ", Vbe " + S.eng(d.vbe, "V") + ", Vce " + S.eng(d.vce, "V")
          : "Id " + S.eng(d.id, "A") + ", Vgs " + S.eng(d.vgs, "V") + ", Vds " + S.eng(d.vds, "V") + ", " + d.region}))});
      return out;
    }
    const list = traces(res), v = st.view;
    if (!list.length) { out.push({type: "text", text: "No probed net is in the simulated circuit. Probe nets that connect to simulated parts.", level: "warn"}); return out; }
    if (res.type === "ac") {
      const mags = list.map(t => ({name: t.name, y: S.db(t.s)})), phs = list.map(t => ({name: t.name, y: S.phase(t.s)}));
      out.push(plot(res, "Magnitude", "dB", mags, v), plot(res, "Phase", "degrees", phs, v));
      const both = list.map((t, i) => ({name: t.name, y: mags[i].y, p: phs[i].y}));
      const tab = cursorTable(res, both, v, x => x.toFixed(2) + " dB");
      tab.rows.splice(1 + both.length, 0, ...both.map(t => ({sig: t.name + " ∠", a: S.at(res.x, t.p, v.a).toFixed(1) + "°", b: S.at(res.x, t.p, v.b).toFixed(1) + "°", d: (S.at(res.x, t.p, v.b) - S.at(res.x, t.p, v.a)).toFixed(1) + "°"})));
      out.push(tab);
    } else {
      const ys = list.map(t => ({name: t.name, y: t.s.re}));
      out.push(plot(res, res.type === "tran" ? "Transient" : "DC sweep", "V", ys, v), cursorTable(res, ys, v, x => S.eng(x, "V")));
    }
    const xu = xUnit(res, v.lo, v.hi), f = x => String(Number((x * xu.k).toPrecision(6)));
    out.push({type: "buttons", items: [
      {label: "Zoom in", command: "spice.view", args: ["in"]}, {label: "Zoom out", command: "spice.view", args: ["out"]},
      {label: "◀ Pan", command: "spice.view", args: ["left"]}, {label: "Pan ▶", command: "spice.view", args: ["right"]},
      {label: "Zoom to cursors", command: "spice.view", args: ["cursors"]}, {label: "Cursors to view", command: "spice.view", args: ["center"]}, {label: "Fit", command: "spice.view", args: ["fit"]}]});
    out.push({type: "form", fields: [
      {key: "a", label: "Cursor A (" + xu.label.replace(/^.*\(|\)$/g, "") + ")", type: "string", value: f(v.a)}, {key: "b", label: "Cursor B", type: "string", value: f(v.b)},
      {key: "lo", label: "View from", type: "string", value: f(v.lo)}, {key: "hi", label: "View to", type: "string", value: f(v.hi)}],
      submit: {label: "Set cursors and view", primary: false, command: "spice.cursors"}});
    return out;
  }
  const sourceVolts = (res, name) => { const line = st.design?.out.elements.find(e => e.line.split(/\s+/)[0].toLowerCase() === name.toLowerCase())?.line.split(/\s+/); return line ? (res.nodes[line[1]] ?? 0) - (res.nodes[line[2]] ?? 0) : 0; };

  // ---------------------------------------------------------------- panel
  function form() {
    const t = st.analysis;
    if (t === "op") return {type: "form", fields: [], submit: {label: "Run operating point", command: "spice.run"}};
    if (t === "tran") return {type: "form", fields: [
      {key: "tstop", label: "Stop time", type: "string", value: st.tran.tstop}, {key: "tstep", label: "Max step", type: "string", value: st.tran.tstep},
      {key: "method", label: "Integration", type: "enum", options: Object.values(METHODS), value: METHODS[st.tran.method] || METHODS.trap}], submit: {label: "Run transient", command: "spice.run"}};
    if (t === "ac") return {type: "form", fields: [
      {key: "sweep", label: "Sweep", type: "enum", options: ["dec", "oct", "lin"], value: st.ac.sweep}, {key: "points", label: "Points (per decade)", type: "number", value: st.ac.points},
      {key: "fstart", label: "Start (Hz)", type: "string", value: st.ac.fstart}, {key: "fstop", label: "Stop (Hz)", type: "string", value: st.ac.fstop}], submit: {label: "Run AC", command: "spice.run"}};
    const srcs = st.design?.sources || [];
    return {type: "form", fields: [
      {key: "source", label: "Source", type: "enum", options: srcs.length ? srcs : [""], value: st.dc.source},
      {key: "start", label: "Start", type: "string", value: st.dc.start}, {key: "stop", label: "Stop", type: "string", value: st.dc.stop}, {key: "step", label: "Step", type: "string", value: st.dc.step}],
      submit: {label: "Run DC sweep", command: "spice.run"}};
  }
  async function render() {
    const d = st.design, view = [];
    const benches = st.benches.filter(b => typeof b?.id === "string");
    view.push({type: "heading", text: "Test benches"});
    if (benches.length) view.push({type: "list", items: benches.map(b => ({label: b.name || "Test bench", badge: b.id === st.bench?.id ? "Selected" : undefined,
      detail: ENGINES[b.engine] || ENGINES.builtin, command: "spice.selectBench", args: [b.id]}))});
    view.push({type: "buttons", items: [{label: "New bench", command: "spice.selectBench"}, {label: "Configure simulators…", command: "spice.configure"}]});
    if (d) view.push({type: "text", muted: true, text: "Variant: " + (d.variant || "base design") + " · " + d.out.elements.length + " simulated parts" + (d.out.omitted.length ? " · " + d.out.omitted.length + " left out" : "")});
    view.push({type: "buttons", items: ANALYSES.map(([k, label]) => ({label, pressed: st.analysis === k, command: "spice.analysis", args: [k]}))});
    const settings = form();
    settings.fields.unshift({key: "name", label: "Bench name", type: "string", value: st.name},
      {key: "engine", label: "Engine", type: "enum", options: Object.values(ENGINES), value: ENGINES[st.engine]});
    settings.secondarySubmit = {label: "Save bench", command: "spice.saveBench"};
    view.push(settings);
    view.push({type: "heading", text: "Probes"});
    if (!st.probes.length) view.push({type: "text", muted: true, text: "The first named nets are plotted. Select wires, labels or parts on the sheet to choose probes."});
    view.push({type: "buttons", items: [{label: "Probe selection", command: "spice.probeSelection"}, {label: "Clear probes", command: "spice.clearProbes"}]});
    view.push({type: "form", fields: [{key: "nets", label: "Probe nets (comma-separated)", type: "string", wide: true, value: st.probes.join(", ")}], submit: {label: "Set probes", primary: false, command: "spice.setProbes"}});
    if (st.error) view.push({type: "text", text: st.error, level: "error"});
    if (st.errorRefs.length) view.push({type: "list", items: st.errorRefs.map(ref => ({label: ref, detail: "Show on schematic", command: "spice.locatePart", args: [ref]}))});
    if (st.result) { view.push({type: "heading", text: "Results"}); view.push(...resultView()); }
    const notes = [...(d?.out.warnings || []), ...(st.result?.res.warnings || [])];
    if (notes.length) view.push({type: "heading", text: "Notes"}, {type: "list", items: notes.slice(0, 40).map(n => ({label: n}))});
    if (d) view.push(...coverageView(d.out.coverage));
    else view.push({type: "button", label: "Refresh model coverage", command: "spice.coverage"});
    if (st.wizard) view.push(...wizardView());
    view.push({type: "heading", text: "Netlist"});
    view.push({type: "buttons", items: [{label: st.showNetlist ? "Hide netlist" : "Show netlist", command: "spice.toggleNetlist"}, {label: "Export netlist…", command: "spice.exportNetlist"},
      ...(st.result && st.result.res.type !== "op" ? [{label: "Export results (CSV)…", command: "spice.exportCsv"}] : [])]});
    if (st.showNetlist && d) view.push({type: "code", text: d.out.text.length > 200000 ? d.out.text.slice(0, 200000) + "\n… (preview truncated; export for the full netlist)" : d.out.text});
    await api.ui.setPanel(PANEL, view);
  }
  async function refresh() {
    clearTimeout(refreshTimer);
    try {
      await syncBenches();
      const out = await netlist(analysisSpecSafe());
      if (st.result && (st.result.deck !== out.text || st.result.engine !== st.engine)) { st.result = null; st.view = null; }
      await drawProbes();
    } catch (e) {
      st.error = e.message; st.result = null; st.input = null; st.design = null;
      if (painted.size) await drawProbes();
    }
    await render();
  }
  const analysisSpecSafe = () => { try { return analysisSpec(); } catch { return null; } };

  // ---------------------------------------------------------------- probes from the selection
  async function probeSelection() {
    const doc = await api.documents.active();
    if (doc.kind !== "schematic") throw Error("Select wires, net labels or parts on a schematic sheet.");
    const items = await api.selection.items({fields: ["id", "kind", "text"]}), c = await api.query.connectivity({doc: doc.id}), nets = [];
    const addNet = n => { lib(); if (n && !X.GROUND.test(n) && !nets.includes(n)) nets.push(n); };
    for (const i of items) {
      if (i.kind === "wire") addNet(c.byWire?.[i.id]);
      else if (["netlabel", "port", "power", "offsheet"].includes(i.kind)) addNet(i.text);
      else if (i.kind === "part") for (const [k, n] of Object.entries(c.byPin || {})) if (k.startsWith(i.id + "/")) addNet(n);
    }
    if (!nets.length) throw Error("The selection touches no nets. Select wires, net labels or parts.");
    for (const n of nets) if (st.probes.length < 50 && !st.probes.includes(n)) st.probes.push(n);
    return nets;
  }

  // ---------------------------------------------------------------- commands
  const show = async () => { await api.ui.showPanel(PANEL); await refresh(); };
  const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { st.error = e.message; await render(); return {error: e.message}; } };
  api.commands.register("spice.show", show);
  api.commands.register("spice.saveBench", guard(saveBench));
  api.commands.register("spice.selectBench", guard(async id => {
    await syncBenches();
    const bench = id && st.benches.find(b => b?.id === id);
    if (id && !bench) throw Error("This bench no longer exists.");
    selectBench(bench); await refresh();
  }));
  api.commands.register("spice.configure", guard(() => api.external.configure(st.engine === "ltspice" ? "ltspice" : "ngspice")));
  api.commands.register("spice.locatePart", guard(async ref => {
    const c = st.input?.netlist.components.find(c => c.ref === ref);
    if (c) { await api.documents.activate(c.sheet); await api.ui.locate(c.id); }
  }));
  api.commands.register("spice.run", guard(async values => {
    await syncBenches(); applyFields(values);
    return run();
  }));
  api.commands.register("spice.analysis", guard(async kind => {
    await syncBenches();
    if (st.analysis !== kind && ANALYSES.some(([k]) => k === kind)) {
      generation++; st.analysis = kind; st.result = null; st.error = null; st.errorRefs = []; await drawProbes();
    }
    await render();
  }));
  api.commands.register("spice.probeSelection", guard(async () => { await syncBenches(); const nets = await probeSelection(); await api.ui.showPanel(PANEL); await refresh(); return nets; }));
  api.commands.register("spice.setProbes", guard(async values => { st.probes = [...new Set(String(values?.nets ?? "").split(",").map(s => s.trim()).filter(Boolean))].slice(0, 50); await drawProbes(); await render(); return st.probes; }));
  api.commands.register("spice.removeProbe", guard(async net => { st.probes = st.probes.filter(p => p !== net); await drawProbes(); await render(); }));
  api.commands.register("spice.clearProbes", guard(async () => { st.probes = []; await drawProbes(); await render(); }));
  api.commands.register("spice.toggleNetlist", guard(async () => { st.showNetlist = !st.showNetlist; if (st.showNetlist) await refresh(); else await render(); }));
  api.commands.register("spice.view", guard(async action => { viewAction(action); await render(); }));
  api.commands.register("spice.cursors", guard(async values => {
    const r = st.result?.res, v = st.view; if (!r || !v) return;
    lib();
    const k = xUnit(r, v.lo, v.hi).k, read = (t, d) => { const n = S.num(t); return Number.isFinite(n) ? n / k : d; };
    const lo = read(values?.lo, v.lo), hi = read(values?.hi, v.hi);
    if (hi > lo && (!isLog(r) || lo > 0)) { v.lo = lo; v.hi = hi; }
    v.a = read(values?.a, v.a); v.b = read(values?.b, v.b);
    await render();
  }));
  api.commands.register("spice.exportNetlist", guard(async () => {
    await syncBenches();
    const out = await netlist(analysisSpecSafe());
    return api.files.export(safeFile(st.title || "design") + ".cir", out.text);
  }));
  api.commands.register("spice.exportCsv", guard(async () => {
    const R = st.result; if (!R || R.res.type === "op") throw Error("Run a DC, AC or transient analysis first.");
    const res = R.res, list = traces(res), head = [res.type === "tran" ? "time" : res.xName];
    for (const t of list) head.push(...(res.type === "ac" ? [t.name + " dB", t.name + " deg"] : [t.name]));
    const cols = list.map(t => (res.type === "ac" ? [S.db(t.s), S.phase(t.s)] : [t.s.re])).flat();
    const rows = res.x.map((x, i) => [x, ...cols.map(c => c[i])].join(","));
    return api.files.export("simulation-" + res.type + ".csv", head.join(",") + "\n" + rows.join("\n") + "\n");
  }));
  const safeFile = n => String(n).replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
  // Programmatic simulation for scripts, tests and future MCP exposure:
  // spice.simulate({analysis: "tran" | {type, ...}, tstop, tstep, probes: ["OUT"], netlist?: text}).
  api.commands.register("spice.simulate", async (args = {}) => {
    lib();
    if (args.bench || !args.netlist) await syncBenches();
    const bench = args.bench ? st.benches.find(b => b?.id === args.bench) : null;
    if (args.bench && !bench) throw Error("Unknown SPICE bench.");
    const spec = args.analysis || bench?.analyses?.[0] || "op";
    const a = typeof spec === "object" ? {...spec, type: spec.type || spec.kind} : {type: spec};
    for (const k of ["tstep", "tstop", "tstart", "tmax", "method", "uic", "fstart", "fstop", "sweep", "points", "source", "start", "stop", "step"]) if (args[k] != null) a[k] = args[k];
    for (const k of ["tstep", "tstop", "tstart", "tmax", "fstart", "fstop", "start", "stop", "step", "points"]) if (typeof a[k] === "string") a[k] = S.num(a[k]);
    let text = args.netlist, nodeOf = n => n, out = null;
    if (!text) { out = await netlist(a); text = out.text; nodeOf = out.nodeOf; }
    const engine = args.engine || (Object.hasOwn(ENGINES, bench?.engine) ? bench.engine : "builtin");
    const res = await solve(engine, text, a, out || {});
    return summary({res, an: a, nodeOf, nodeMap: out?.nodeMap || {}}, args.probes || bench?.probes, text);
  });
  function summary(R, probes, text) {
    const res = R.res, base = {analysis: res.analysis, warnings: res.warnings, stats: res.stats, ...(text ? {netlist: text} : {})};
    if (res.type === "op") return {...base, nodes: Object.fromEntries(Object.entries(res.nodes).map(([n, v]) => [R.nodeMap[n] || n, v])), currents: res.currents, devices: res.devices};
    const names = probes || (st.probes.length ? st.probes : null);
    const sigs = {};
    for (const s of res.signals) {
      const node = s.name.slice(2, -1), net = s.kind === "v" ? R.nodeMap[node] || node : s.name;
      if (names && !names.some(p => String(p).toLowerCase() === String(net).toLowerCase() || R.nodeOf(p) === node)) continue;
      sigs[s.kind === "v" ? net : s.name] = res.type === "ac" ? {db: S.db(s), phase: S.phase(s)} : s.re;
    }
    return {...base, x: res.x, signals: sigs};
  }
  // ---------------------------------------------------------------- model assignments (docs/design/spice-models.md §5, §12)
  const modelEdit = (id, value, target = "item") => ({target, id, path: ["sim"], value});
  async function proposeModels(edits, label) {
    const reply = edits.length ? await api.proposals.propose(edits, {label}) : {applied: 0, unchanged: true};
    if (reply.applied) { generation++; st.result = null; st.error = null; st.errorRefs = []; }
    return reply;
  }
  const covRow = ref => st.design?.out.coverage.rows.find(r => r.ref.toUpperCase() === String(ref || "").toUpperCase());
  // The part's own component and parameters, for filling a template from them.
  function partContext(row) {
    const d = st.input, part = (d.parts || []).find(p => p.id === row.part) || {}, def = (d.defs || []).find(x => x.id === part.def) || {};
    const c = (d.netlist.components || []).find(x => String(x.ref).toUpperCase() === row.ref.toUpperCase()) || {ref: row.ref, value: row.value, pins: []};
    return {part, def, c, params: {...(def.parameters || {}), ...(part.parameters || {})}};
  }
  function genericEdit(ref, o = {}) {
    lib();
    const row = covRow(ref); if (!row) throw Error("No part " + ref + " in the simulated design.");
    const id = o.template || row.suggest || row.template?.replace(/@\d+$/, "");
    if (!id) throw Error(row.ref + ": Waffle cannot tell what kind of part this is. Open the Model Wizard and choose a category.");
    const {t, error} = MD.template(id); if (error) throw Error(error);
    const x = partContext(row);
    return modelEdit(row.part, {template: t.id + "@" + t.v, params: MD.fromPart(t.id, x.c, x.def, x.params)});
  }

  function coverageView(cov) {
    if (!cov || !cov.total) return [];
    const tone = rung => ({Vendor: "success", Fitted: "success", Generic: "info", Missing: "warning"})[rung] || "muted";
    const out = [{type: "heading", text: "Simulation coverage · " + (cov.variant || "base design")},
      {type: "text", text: cov.simulated + " of " + cov.total + " parts simulate" + (cov.defaults ? " · " + cov.defaults + " Waffle default values in generic models" : "")},
      {type: "chips", items: MD.RUNGS.filter(r => cov.counts[r]).map(r => ({text: r + " " + cov.counts[r], tone: tone(r)}))}];
    const action = r => (r.rung === "Missing" ? (r.suggest ? "Use generic " + r.suggest : "Choose a model…") : r.rung === "Excluded" && r.source === "assigned" ? "Include again" : r.template ? "Review…" : "—");
    out.push({type: "table", layout: "details", rowCommand: "spice.coverageRow", columns: [{key: "ref", title: "Ref"}, {key: "value", title: "Value"}, {key: "model", title: "Model"}, {key: "rung", title: "Model source", type: "chip"}, {key: "pins", title: "Pins", align: "right"}, {key: "action", title: "Action"}],
      rows: cov.rows.slice(0, MAX_ROWS).map(r => ({ref: r.ref, value: r.value, model: r.rung === "Missing" || r.rung === "Excluded" ? r.reason : r.model,
        rung: {text: r.rung + (r.placeholder ? " (placeholder)" : ""), tone: tone(r.rung)}, pins: r.pins, action: action(r)}))});
    const missing = cov.rows.filter(r => r.rung === "Missing" && r.suggest).length;
    out.push({type: "buttons", items: [...(missing ? [{label: "Use generic for all Missing (" + missing + ")", command: "spice.useGenericAll"}] : []), {label: "Model Wizard…", command: "spice.modelWizard"}]});
    return out;
  }

  // ---------------------------------------------------------------- the model wizard (§5)
  const SRC_CHOICES = ["datasheet", "user", "derived", "default", "ai"];
  function openWizard(ref, template) {
    lib();
    const row = ref ? covRow(ref) : null, x = row && partContext(row), prior = x && (x.part.sim || x.def.sim);
    const priorId = prior?.template || prior?.model?.id;
    const id = template || priorId || row?.template || (row?.suggest ? row.suggest + "@" + MD.TEMPLATES[row.suggest].v : ({C: "capacitor", L: "inductor", D: "diode", Q: "bjt", M: "mosfet", Y: "crystal", FB: "ferrite", SW: "switch"}[String(row?.ref || "").match(/^[A-Z]+/i)?.[0].toUpperCase()] || "opamp") + "@1");
    const {t} = MD.template(id);
    let params = prior && priorId === id ? prior.params : x ? MD.fromPart(t.id, x.c, x.def, x.params) : {};
    st.wizard = {ref: row?.ref || null, part: row?.part || null, def: row?.def || null, template: t.id + "@" + t.v, params: JSON.parse(JSON.stringify(params || {})), check: null, plots: [], scope: "part"};
  }
  function readWizard(values = {}) {
    const w = st.wizard, {t} = MD.template(w.template), params = {};
    for (const f of t.fields) {
      const v = String(values["f_" + f.k] ?? "").trim(); if (!v) continue;
      let src = String(values["s_" + f.k] || "user");
      if (src === "default" || src === "derived") src = "user"; // a typed value is the user's unless marked otherwise
      params[f.k] = {v, src, ...(values["p_" + f.k] ? {page: String(values["p_" + f.k]).slice(0, 12)} : {})};
      const old = w.params[f.k]; if (old && typeof old === "object" && old.quote && old.v === v) params[f.k].quote = old.quote;
    }
    if (values.scope === "component" || values.scope === "part") w.scope = values.scope;
    if (JSON.stringify(params) !== JSON.stringify(w.params)) { w.params = params; w.check = null; w.plots = []; }
  }
  function previewWizard() {
    const w = st.wizard, {t} = MD.template(w.template), r = MD.benchCheck(t, w.params, {keep: true});
    w.check = {passed: r.passed, date: new Date().toISOString().slice(0, 10), measures: r.measures.map(m => ({key: m.key, label: m.label, unit: m.unit, got: m.got, want: m.want, ok: m.ok, error: m.error}))};
    w.plots = r.measures.filter(m => m.res && m.res.type !== "op").slice(0, 4).map(m => benchPlot(m));
    return r;
  }
  function benchPlot(m) {
    const res = m.res, names = ["out", "vout", "a", "k", "i(vg)"], sig = names.map(n => S.signal(res, n)).find(Boolean) || res.signals[0], step = Math.max(1, Math.ceil(res.x.length / 400));
    const keep = (arr) => arr.filter((_, i) => i % step === 0);
    const y = res.type === "ac" ? S.mag(sig) : sig.re;
    const plot = {type: "plot", title: m.label, xLabel: res.type === "tran" ? "Time (s)" : res.type === "ac" ? "Frequency (Hz)" : res.xName, yLabel: res.type === "ac" ? "|" + sig.name + "|" : sig.name, xLog: res.type === "ac" && res.x.length > 1,
      series: [{name: sig.name, x: keep(res.x), y: keep(y)}]};
    if (m.want != null && res.type === "dc") plot.vlines = [{x: m.want, label: "entered " + m.key}];
    return plot;
  }
  function wizardView() {
    const w = st.wizard, {t} = MD.template(w.template), v = MD.values(t, w.params), out = [];
    out.push({type: "heading", text: "Model Wizard" + (w.ref ? " · " + w.ref : "")});
    out.push({type: "buttons", items: Object.values(MD.TEMPLATES).map(x => ({label: (x.id + "@" + x.v === w.template ? "● " : "") + x.title, command: "spice.wizardTemplate", args: [x.id + "@" + x.v]}))});
    const rung = MD.rungOf(t, v.recs, {check: w.check});
    out.push({type: "text", text: t.title + " (" + w.template + ") · rung " + rung + (v.defaults.length ? " · " + v.defaults.length + " Waffle defaults" : "") + (w.check ? " · bench " + (w.check.passed ? "passed" : "failed") : " · bench not run")});
    // Source chips: every value with where it came from.
    out.push({type: "table", columns: [{key: "k", title: "Field"}, {key: "v", title: "Value"}, {key: "src", title: "Source"}, {key: "req", title: ""}],
      rows: t.fields.filter(f => v.recs[f.k]).map(f => ({k: f.label, v: v.recs[f.k].v, src: "[" + MD.chip(v.recs[f.k]) + "]", req: f.req ? "required" : ""}))});
    const fields = [];
    for (const f of t.fields) {
      const r = w.params[f.k] && typeof w.params[f.k] === "object" ? w.params[f.k] : w.params[f.k] != null ? {v: String(w.params[f.k]), src: "user"} : null;
      fields.push({key: "f_" + f.k, label: f.label + (f.req ? " *" : "") + (f.unit && f.unit !== "text" ? " (" + f.unit + ")" : ""), type: f.options ? "enum" : "string", options: f.options ? ["", ...f.options] : undefined,
        value: r ? r.v : "", placeholder: v.recs[f.k] && !r ? v.recs[f.k].v + " (" + MD.chip(v.recs[f.k]) + ")" : ""});
      fields.push({key: "s_" + f.k, label: "source", type: "enum", options: SRC_CHOICES, value: r ? r.src : "default"});
      fields.push({key: "p_" + f.k, label: "page", type: "string", value: r?.page || ""});
    }
    if (w.ref) fields.push({key: "scope", label: "Save for", type: "enum", options: ["part", "component"], value: w.scope});
    out.push({type: "form", fields, submit: {label: "Preview bench", command: "spice.wizardPreview"},
      ...(w.ref ? {secondarySubmit: {label: "Save model for " + w.ref, command: "spice.wizardSave"}} : {})});
    if (w.check) {
      out.push({type: "table", columns: [{key: "m", title: "Bench"}, {key: "got", title: "Measured", align: "right"}, {key: "want", title: "Entered", align: "right"}, {key: "ok", title: ""}],
        rows: w.check.measures.map(m => ({m: m.label, got: m.error ? m.error : S.eng(m.got, m.unit && m.unit !== "dB" ? m.unit : "") + (m.unit === "dB" ? " dB" : ""), want: m.want == null ? "" : S.eng(m.want, m.unit && m.unit !== "dB" ? m.unit : "") + (m.unit === "dB" ? " dB" : ""), ok: m.ok == null ? "" : m.ok ? "pass" : "FAIL"}))});
      out.push(...w.plots);
    }
    out.push({type: "text", muted: true, text: "Not modelled: " + t.notModelled.join("; ") + "."});
    const row = w.ref && covRow(w.ref), x = row && partContext(row);
    out.push({type: "buttons", items: [...(x?.part.sim ? [{label: "Clear " + w.ref + "'s model", command: "spice.clearModel", args: [w.ref]}] : []),
      ...(x?.def.sim ? [{label: "Clear shared component model", command: "spice.clearModel", args: [w.ref, "definition"]}] : []),
      {label: "Close wizard", command: "spice.wizardClose"}]});
    if (w.ref) out.push({type: "form", fields: [{key: "reason", label: "Exclude " + w.ref + " with reason", type: "string", wide: true, value: ""}], submit: {label: "Exclude", command: "spice.exclude"}});
    return out;
  }
  api.commands.register("spice.coverage", guard(async () => { await syncBenches(); await netlist(analysisSpecSafe()); await render(); return JSON.parse(JSON.stringify(st.design.out.coverage)); }));
  async function useGeneric(ref, template) {
    if (!st.design) await netlist(analysisSpecSafe());
    const r = await proposeModels([genericEdit(ref, {template})], "Use generic model for " + ref);
    await refresh(); return r.applied || r.unchanged ? ref : r;
  }
  api.commands.register("spice.useGeneric", guard(useGeneric));
  api.commands.register("spice.useGenericAll", guard(async () => {
    if (!st.design) await netlist(analysisSpecSafe());
    const rows = st.design.out.coverage.rows.filter(r => r.rung === "Missing" && r.suggest);
    const edits = new Map(rows.map(r => [r.part, genericEdit(r.ref)]));
    const reply = await proposeModels([...edits.values()], "Assign generic SPICE models");
    await refresh(); return reply.declined ? reply : rows.filter(r => covRow(r.ref)?.rung !== "Missing").map(r => r.ref);
  }));
  api.commands.register("spice.coverageRow", guard(async row => {
    if (!st.design) await netlist(analysisSpecSafe());
    const r = covRow(row?.ref); if (!r) return;
    if (r.rung === "Missing" && r.suggest) return useGeneric(r.ref);
    if (r.rung === "Excluded" && r.source === "assigned") { await proposeModels([modelEdit(r.part, null)], "Include " + r.ref + " in simulation"); await refresh(); return; }
    if (!r.template && !r.suggest && r.rung !== "Missing" && r.rung !== "Generic") return; // primitives and sources: nothing to choose
    openWizard(r.ref); await render();
  }));
  api.commands.register("spice.modelWizard", guard(async ref => { await syncBenches(); await api.ui.showPanel(PANEL); if (!st.design) await netlist(analysisSpecSafe()); openWizard(typeof ref === "string" ? ref : null); await render(); return st.wizard.template; }));
  api.commands.register("spice.wizardTemplate", guard(async id => { const w = st.wizard; openWizard(w?.ref, id); await render(); }));
  api.commands.register("spice.wizardPreview", guard(async values => { lib(); readWizard(values); const r = previewWizard(); await render(); return {passed: r.passed, measures: st.wizard.check.measures}; }));
  api.commands.register("spice.wizardSave", guard(async values => {
    lib(); const w = st.wizard; if (!w?.ref) throw Error("Open the wizard from a part to save its model.");
    if (values) readWizard(values);
    if (!w.check) previewWizard();
    const {t} = MD.template(w.template), shared = w.scope === "component" && w.def;
    const value = {template: w.template, params: w.params, check: {passed: w.check.passed, date: w.check.date, bench: t.id + "@" + t.v}};
    const edits = shared ? [modelEdit(w.def, value, "definition"), modelEdit(w.part, null)] : [modelEdit(w.part, value)];
    const reply = await proposeModels(edits, "Save SPICE model for " + w.ref);
    if (!reply.applied && !reply.unchanged) return reply;
    st.wizard = null; await refresh();
    const row = covRow(w.ref), after = row && partContext(row);
    const saved = shared ? after?.def.sim : after?.part.sim;
    return {...reply, saved: JSON.stringify(saved) === JSON.stringify(value) ? (shared ? "def:" + w.def : "part:" + w.part) : null, rung: row?.rung};
  }));
  api.commands.register("spice.exclude", guard(async (values, refArg) => {
    const ref = refArg || st.wizard?.ref, r = covRow(ref); if (!r) throw Error("Choose a part to exclude.");
    const reason = String(values?.reason ?? values ?? "").trim().slice(0, 200);
    if (!reason) throw Error("Give a reason for leaving " + r.ref + " out of the simulation.");
    const reply = await proposeModels([modelEdit(r.part, {exclude: reason})], "Exclude " + r.ref + " from simulation");
    if (!reply.applied && !reply.unchanged) return reply;
    st.wizard = null; await refresh(); return r.ref;
  }));
  api.commands.register("spice.clearModel", guard(async (ref, scope) => {
    const row = covRow(ref); if (!row) return;
    const edit = scope === "definition" ? modelEdit(row.def, null, scope) : modelEdit(row.part, null);
    const reply = await proposeModels([edit], "Clear SPICE model for " + ref);
    if (reply.applied || reply.unchanged) st.wizard = null;
    await refresh(); return reply;
  }));
  api.commands.register("spice.wizardClose", guard(async () => { st.wizard = null; await render(); }));
  context.subscriptions.push(api.events.on("panelShown", e => { if (e.id === PANEL) return refresh(); }));
  context.subscriptions.push(api.events.on("activeDocumentChanged", e => { if (painted.size === 32) return drawProbes(e.document); }));
  context.subscriptions.push(api.events.on("documentChanged", () => {
    generation++;
    if (!st.input) return;
    st.design = null; st.wizard = null; st.error = null; st.errorRefs = [];
    // A move can keep the circuit identical. Existing anchors follow it immediately.
    // Coalesce bursts of edits, and only re-read the circuit while a result or probes need it.
    if (st.result || painted.size || st.probes.length) {
      clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh().catch(e => api.log(e.message)), 150);
    } else { st.input = null; return render(); }
  }));
};
exports.deactivate = function () {};
