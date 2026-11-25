"use strict";
// xSignals: signal paths through series parts, and the wizard that builds them (Design ›
// xSignals Wizard…), after Altium's xSignals and Allegro's extended nets (XNets).
//
// An xSignal is a source pin → load pin path that may pass through series resistors, ferrites,
// AC-coupling capacitors or resistor-network elements, so one constraint covers the whole path:
//   {name, from:{ref, pin}, to:{ref, pin}, through:[refs], nets:[net...], class?}
// xSignals and xSignal classes are the signal model's (project.signals paths and tags, signals.js); the
// topology orders stay with the length-tuning store: board.lengthTuning.topologies {net or class: {order, source}}.
//
//   Model       list, classes, netsOf, add, remove, setClass (DOM-free).
//   Discovery   discover(board, defs, from, to): from the netlist (pin nets), not the copper, so it
//               works before routing. Two-pin series parts (R, L, FB, C, RN/RA/RP elements) are
//               crossed up to `depth` times; resistor networks pair pins i ↔ N+1−i.
//   Wizard      plan(board, defs, {from, to:[...], preset}) classifies each xSignal by its net names:
//               DDR3/DDR4/DDR5/LPDDR4 byte lanes (DQ, DQS pair, DM/DBI), address/command/control,
//               clock pairs; "generic" groups by bus stem. It proposes xSignal classes, Matched
//               Delays (or Lengths) rules scoped InxSignalClass('…'), and a fly-by topology for the
//               address bus. apply(board, plan) writes them (one undo step in the UI).
//   Rules       Rules scoped with InxSignal / InxSignalClass (query.js) are matched per xSignal, not
//               per net: rules.js skips them in the net checks and calls drc() here, which measures
//               each xSignal pad to pad through its series parts (AtriumLength.xSignalLength).
//   Pin delays  importPinDelays(board, csv): package pin delay or length per component pin
//               (Designator, Pin, Delay ps | Length mm/mil). length-tuning.js adds them to
//               lengths and delays.
//   MCP         headless(args, host) → the `xsignals` tool.
globalThis.AtriumXSignals = (() => {
  const fail = m => { throw Error(m); };
  const clone = v => JSON.parse(JSON.stringify(v));
  const L = () => globalThis.AtriumLength, Rl = () => globalThis.AtriumRules;
  // Rails and grounds: net-intent.js (isSupply) when loaded, else this regex (one release).
  const POWER_RE = /^(?:[ADPS]?GND\w*|GND\w*|VSS\w*|VCC\w*|VDD\w*|VEE\w*|VBUS\w*|VBAT\w*|VIN\w*|VREF\w*|VTT\w*|VPP\w*|PWR\w*|[+-]?\d+V\d*\w*|[+-]?\d+(?:\.\d+)?V\w*|P\d+V\d*\w*|\+\w+)$/i;
  const POWER = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isSupply ? N.isSupply(n) : POWER_RE.test(n); }};
  const SERIES = /^(R|L|FB|C|RN|RA|RP|RR|Z)\d/i, NETWORK = /^(RN|RA|RP|RR)\d/i;
  const classScope = name => globalThis.AtriumDesignQueryRecord.selector("xsignalclass", name);
  const natural = (a, b) => String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: "base"});

  // ------------------------------------------------------------------ model
  // xSignals and their classes are the signal model's (signals.js: paths and xSignal-class tags). Reads take the
  // board's view; writes change a copy of it and hand it back to the model (one edit).
  const S = () => globalThis.AtriumSignals || fail("Signals are not loaded.");
  const view = board => S().xsView(board);
  function write(board, project, fn) {
    const v = {xSignals: clone(view(board).xSignals), xSignalClasses: clone(view(board).xSignalClasses)}, out = fn(v);
    S().applyClasses(project || S().projectOf(board) || fail("Open the board in a project to change its xSignals."), board, v);
    globalThis.AtriumLength?.invalidate?.(board);
    return out;
  }
  function topologies(board) {
    if (!board.lengthTuning || typeof board.lengthTuning !== "object") board.lengthTuning = {version: 1, groups: [], targets: {}};
    return board.lengthTuning.topologies ||= {};
  }
  function partsByRef(board) { const m = new Map(); for (const i of board.items || []) if (i.kind === "part" && i.ref) m.set(i.ref, i); return m; }
  // Nets an xSignal runs through: stored by the wizard, else the end pins' nets.
  function netsOf(board, x, parts = partsByRef(board)) {
    if (Array.isArray(x.nets) && x.nets.length) return [...x.nets];
    const out = [], a = parts.get(x.from?.ref)?.pinNets?.[x.from?.pin], b = parts.get(x.to?.ref)?.pinNets?.[x.to?.pin];
    if (a) out.push(a); if (b && b !== a) out.push(b);
    return out;
  }
  function classes(board) {
    const out = {};
    for (const [k, v] of Object.entries(view(board).xSignalClasses)) out[k] = [...v];
    return out;
  }
  function list(board, indexedParts) {
    const all = view(board).xSignals;
    if (!all.length) return [];
    const parts = indexedParts || partsByRef(board), cls = classes(board), of = new Map();
    for (const [c, names] of Object.entries(cls)) for (const n of names) { if (!of.has(n)) of.set(n, []); of.get(n).push(c); }
    return all.map(x => ({...clone(x), nets: netsOf(board, x, parts), classes: of.get(x.name) || []}));
  }
  const putClass = (v, name, members, append) => {
    if (!name || typeof name !== "string") fail("An xSignal class needs a name.");
    const cur = append ? v.xSignalClasses[name] || [] : [];
    v.xSignalClasses[name] = [...new Set([...cur, ...members])].sort(natural);
    if (!v.xSignalClasses[name].length) delete v.xSignalClasses[name];
    return v.xSignalClasses[name] || [];
  };
  function addTo(v, items, cls) {
    const names = new Map(v.xSignals.map((x, i) => [x.name, i]));
    let added = 0, updated = 0;
    for (const x of items) {
      if (!x?.name || !x.from?.ref || !x.to?.ref) fail("An xSignal needs a name and from/to pins.");
      const rec = {name: x.name, from: {ref: x.from.ref, pin: String(x.from.pin)}, to: {ref: x.to.ref, pin: String(x.to.pin)}};
      if (x.through?.length) rec.through = [...x.through];
      if (x.nets?.length) rec.nets = [...x.nets];
      if (names.has(x.name)) { v.xSignals[names.get(x.name)] = rec; updated++; } else { names.set(x.name, v.xSignals.length); v.xSignals.push(rec); added++; }
      if (cls || x.class) putClass(v, cls || x.class, [x.name], true);
    }
    return {added, updated, total: v.xSignals.length};
  }
  const add = (board, items, cls, project) => write(board, project, v => addTo(v, items, cls));
  function remove(board, names, project) {
    return write(board, project, v => {
      const drop = new Set(names), before = v.xSignals.length;
      v.xSignals = v.xSignals.filter(x => !drop.has(x.name));
      for (const [k, list] of Object.entries(v.xSignalClasses)) { v.xSignalClasses[k] = list.filter(n => !drop.has(n)); if (!v.xSignalClasses[k].length) delete v.xSignalClasses[k]; }
      return {removed: before - v.xSignals.length, total: v.xSignals.length};
    });
  }
  const setClass = (board, name, members, append = false, project) => write(board, project, v => putClass(v, name, members, append));

  // ------------------------------------------------------------------ discovery (netlist)
  // Pins of each net: net -> [{ref, pin}].
  function pinIndex(board) {
    const m = new Map();
    for (const p of board.items || []) if (p.kind === "part" && p.ref) for (const [pin, net] of Object.entries(p.pinNets || {})) {
      if (!net) continue; if (!m.has(net)) m.set(net, []); m.get(net).push({ref: p.ref, pin: String(pin)});
    }
    return m;
  }
  // The pin across a series element: two-pin parts, or a resistor-network element (i ↔ N+1−i).
  // signals.js decides when loaded (one definition of a series part: designators, resistor networks,
  // the SeriesPins parameter and the store's overrides); the rule below is its fallback.
  function across(part, pin, store, defs) {
    const S = globalThis.AtriumSignals;
    if (S?.series) { for (const [a, b] of S.series(part, defs?.get ? defs.get(part.def) : defs?.[part.def] || null, store)) { if (a === String(pin)) return b; if (b === String(pin)) return a; } return null; }
    const pins = Object.keys(part.pinNets || {}).filter(k => part.pinNets[k]);
    if (pins.length === 2 && SERIES.test(part.ref)) return pins.find(k => k !== String(pin)) ?? null;
    if (NETWORK.test(part.ref)) {
      const all = Object.keys(part.pinNets || {}).map(Number).filter(Number.isFinite), n = all.length ? Math.max(...all) : 0, i = +pin;
      if (n >= 4 && n % 2 === 0 && Number.isFinite(i)) { const j = String(n + 1 - i); return part.pinNets[j] ? j : null; }
    }
    return null;
  }
  // Every path from each signal pin of `fromRef` to a pin of a `to` part, crossing at most `depth`
  // series elements. One xSignal per (source pin, load pin).
  function discover(board, defs, fromRef, toRefs, o = {}) {
    const parts = partsByRef(board), src = parts.get(fromRef);
    if (!src) fail("No component " + fromRef + " on the board.");
    const targets = new Set((Array.isArray(toRefs) ? toRefs : [toRefs]).filter(Boolean));
    for (const r of targets) if (!parts.has(r)) fail("No component " + r + " on the board.");
    const pins = pinIndex(board), depth = o.depth ?? 2, out = [], sigStore = globalThis.AtriumSignals?.projectOf?.(board)?.signals || null;
    for (const [pin, net0] of Object.entries(src.pinNets || {}).sort((a, b) => natural(a[0], b[0]))) {
      if (!net0 || (!o.includePower && POWER.test(net0))) continue;
      // Breadth-first over nets; a state is (net, nets so far, parts crossed).
      const queue = [{net: net0, nets: [net0], through: []}], seen = new Set([net0]);
      while (queue.length) {
        const cur = queue.shift();
        for (const q of pins.get(cur.net) || []) {
          if (q.ref === fromRef) continue;
          if (targets.has(q.ref)) {
            out.push({name: null, from: {ref: fromRef, pin: String(pin)}, to: {ref: q.ref, pin: q.pin}, through: [...cur.through], nets: [...cur.nets]});
            continue;
          }
          if (cur.through.length >= depth) continue;
          const part = parts.get(q.ref); if (!part || cur.through.includes(part.ref)) continue;
          const other = across(part, q.pin, sigStore, defs); if (other == null) continue;
          const net = part.pinNets[other];
          if (!net || seen.has(net) || POWER.test(net)) continue;
          seen.add(net); queue.push({net, nets: [...cur.nets, net], through: [...cur.through, part.ref]});
        }
      }
    }
    for (const x of out) x.name = (o.prefix ?? "") + nameFor(x, o);
    // Unique names: a source pin that reaches several loads (fly-by) gets the load as a suffix.
    const counts = new Map(); for (const x of out) counts.set(x.name, (counts.get(x.name) || 0) + 1);
    for (const x of out) if (counts.get(x.name) > 1) x.name += "_" + x.to.ref;
    const final = new Map(); for (const x of out) final.set(x.name, (final.get(x.name) || 0) + 1);
    for (const x of out) if (final.get(x.name) > 1) x.name += "_" + x.to.pin;
    return out.sort((a, b) => natural(a.name, b.name));
  }
  // The cleanest net name along the path: the one without a series-part suffix, else the source net.
  function nameFor(x) {
    const nets = x.nets, clean = nets.find(n => !/(_R|_SER|_S|_T|_TERM|_AC|_RN)\d*$/i.test(n) && !/^Net[-_(]/i.test(n));
    return (clean || nets[0]).replace(/[^\w+.\-[\]]/g, "_");
  }

  // ------------------------------------------------------------------ classification (wizard)
  const PRESETS = {
    ddr4: {label: "DDR4", lane: 5, pair: 1, acc: 10, clk: 1, basis: "delay", topology: "flyBy", stub: 1.5},
    ddr3: {label: "DDR3", lane: 10, pair: 2, acc: 20, clk: 2, basis: "delay", topology: "flyBy", stub: 2},
    ddr5: {label: "DDR5", lane: 3, pair: 1, acc: 8, clk: 1, basis: "delay", topology: "flyBy", stub: 1},
    lpddr4: {label: "LPDDR4", lane: 3, pair: 1, acc: 6, clk: 1, basis: "delay", topology: "daisyChainSimple", stub: 1},
    generic: {label: "Generic bus", lane: 10, pair: 2, acc: 20, clk: 2, basis: "length", topology: null, stub: 2}
  };
  // Tokens of a net name: "DDR4_DQS0_T" -> ["DDR4","DQS0","T"], "DQ[12]" -> ["DQ12"].
  function tokens(net) { return String(net).toUpperCase().replace(/\[(\d+)\]/g, "$1").split(/[^A-Z0-9#]+/).filter(Boolean); }
  const polarity = t => /^(P|T|\+)$/.test(t) ? "P" : /^(N|C|-|B|#)$/.test(t) ? "N" : null;
  // {role: dq|dqs|dm|clk|acc|other, lane, polarity}
  function classify(net) {
    const tk = tokens(net), s = String(net).toUpperCase();
    const pol = polarity(tk[tk.length - 1] || "") || (/[_-]?(N|C|#)$/.test(s) && /DQS|CK|CLK/.test(s) ? "N" : /[_-]?(P|T)$/.test(s) && /DQS|CK|CLK/.test(s) ? "P" : null);
    for (const t of tk) {
      let m;
      if ((m = /^DQS([LU]|\d+)?([PNTC])?$/.exec(t))) return {role: "dqs", lane: m[1] === "L" ? 0 : m[1] === "U" ? 1 : m[1] != null ? +m[1] : 0, polarity: m[2] ? (m[2] === "P" || m[2] === "T" ? "P" : "N") : pol};
      if ((m = /^(?:DM|DBI|DMI|LDM|UDM)([LU]|\d+)?$/.exec(t))) return {role: "dm", lane: t.startsWith("U") || m[1] === "U" ? 1 : m[1] === "L" || t.startsWith("L") ? 0 : m[1] != null ? +m[1] : 0};
      if ((m = /^DQ(\d+)$/.exec(t))) return {role: "dq", lane: Math.floor(+m[1] / 8), bit: +m[1]};
      if ((m = /^(?:CK|CLK|DCK|MCK)(\d*)([PNTC])?$/.exec(t)) && !/CKE/.test(t)) return {role: "clk", lane: m[1] ? +m[1] : 0, polarity: m[2] ? (m[2] === "P" || m[2] === "T" ? "P" : "N") : pol};
      if (/^(?:A\d{1,2}|ADDR\d+|MA\d+|BA\d|BG\d|CA\d+|ACT|RAS|CAS|WE|PAR|PARITY|CS\d*|CKE\d*|ODT\d*|CID\d|C\d)$/.test(t)) return {role: "acc", lane: 0};
      if (/^(?:RESET|RST|ALERT|ZQ|TEN|VREFCA)/.test(t)) return {role: "other", lane: 0};
    }
    return {role: "other", lane: 0};
  }
  // Bus stem for the generic preset: "D12" -> "D", "ADC_DATA3" -> "ADC_DATA".
  const stem = net => { const m = /^(.*?)[_[]?(\d+)\]?$/.exec(String(net)); return m && m[1] ? m[1].replace(/_$/, "") : null; };

  function plan(board, defs, o = {}) {
    const preset = PRESETS[o.preset || "ddr4"] || fail("Unknown preset " + o.preset + ". Use ddr3, ddr4, ddr5, lpddr4 or generic.");
    const from = o.from || fail("Choose the source component (for example the memory controller).");
    const to = (Array.isArray(o.to) ? o.to : String(o.to || "").split(/[\s,;]+/)).filter(Boolean);
    if (!to.length) fail("Choose at least one load component.");
    const prefix = o.classPrefix ?? (preset.label.replace(/\W/g, "") + "_");
    const found = discover(board, defs, from, to, {prefix: o.prefix ?? "", depth: o.depth});
    const groups = new Map(), pairs = [], unmatched = [];
    const put = (cls, x, kind) => { if (!groups.has(cls)) groups.set(cls, {name: cls, kind, members: []}); groups.get(cls).members.push(x.name); x.class = cls; };
    for (const x of found) {
      const nets = x.nets, c = nets.map(classify).find(k => k.role !== "other") || classify(nets[0]);
      x.role = c.role; x.lane = c.lane; x.polarity = c.polarity || null;
      if (o.preset === "generic") {
        const st = stem(nets[0]); if (st) put(prefix + st, x, "bus"); else unmatched.push(x.name);
        continue;
      }
      if (c.role === "dq" || c.role === "dm" || c.role === "dqs") put(prefix + "BYTE" + c.lane + (to.length > 1 && o.perLoad ? "_" + x.to.ref : ""), x, "lane");
      else if (c.role === "clk") put(prefix + "CLK", x, "clock");
      else if (c.role === "acc") put(prefix + "ADDR_CMD", x, "acc");
      else unmatched.push(x.name);
    }
    // Pairs among xSignals: the same load, same role and lane, P and N.
    const byKey = new Map();
    for (const x of found) if (x.polarity && (x.role === "dqs" || x.role === "clk")) {
      const k = x.role + x.lane + x.to.ref; if (!byKey.has(k)) byKey.set(k, {});
      byKey.get(k)[x.polarity] = x.name;
    }
    for (const v of byKey.values()) if (v.P && v.N) pairs.push({positive: v.P, negative: v.N});
    const clsList = [...groups.values()].sort((a, b) => natural(a.name, b.name));
    const ps = preset.basis === "delay";
    const rules = [];
    for (const g of clsList) {
      const tol = g.kind === "lane" ? preset.lane : g.kind === "acc" ? preset.acc : g.kind === "clock" ? preset.clk : preset.lane;
      const scope = classScope(g.name);
      const pairIn = pairs.some(p => g.members.includes(p.positive));
      if (ps) rules.push({type: "matchedDelays", name: g.name + "_Match", scope, tolerance: tol, withinPair: pairIn, pairTolerance: preset.pair});
      else rules.push({type: "matchedLengths", name: g.name + "_Match", scope, tolerance: +(tol * 0.15).toFixed(3), withinPair: pairIn, pairTolerance: 0.127});
    }
    // Fly-by / daisy chain for the address bus when there are several loads.
    const acc = clsList.find(g => g.kind === "acc");
    if (acc && preset.topology && to.length > 1) rules.push({type: "routingTopology", name: acc.name + "_Topology", scope: classScope(acc.name),
      topology: preset.topology, maxStub: preset.stub});
    const topologies = acc && to.length > 1 ? {[acc.name]: {source: from, order: [...to]}} : {};
    return {preset: o.preset || "ddr4", from, to, xSignals: found, classes: Object.fromEntries(clsList.map(g => [g.name, g.members])), kinds: Object.fromEntries(clsList.map(g => [g.name, g.kind])),
      pairs, rules, topologies, unmatched,
      summary: found.length + " xSignals in " + clsList.length + " classes (" + clsList.map(g => g.name + " " + g.members.length).join(", ") + ")" + (unmatched.length ? "; " + unmatched.length + " not classified" : "")};
  }
  // Write a plan: xSignals, classes, topology orders and rules. Mutates board (wrap in ctx.edit).
  function apply(board, p, o = {}) {
    const keep = o.only ? new Set(o.only) : null, chosen = p.xSignals.filter(x => !keep || keep.has(x.name));
    const res = write(board, o.project, v => {
      const r = addTo(v, chosen.map(x => ({name: x.name, from: x.from, to: x.to, through: x.through, nets: x.nets})));
      for (const [cls, members] of Object.entries(p.classes)) { const m = members.filter(n => !keep || keep.has(n)); if (m.length) putClass(v, cls, m, o.append !== false); }
      return r;
    });
    if (Object.keys(p.topologies || {}).length) Object.assign(topologies(board), clone(p.topologies));
    let rules = 0;
    if (o.rules !== false && p.rules.length && Rl()) rules = addRules(board, p.rules, o.project);
    globalThis.AtriumLength?.invalidate?.(board);
    return {...res, classes: Object.keys(p.classes).length, rules};
  }
  // Add (or replace by name) rules at the top priority of their type.
  function addRules(board, list, project) {
    const R = Rl(), set = clone(R.effective(board, project));
    let n = 0;
    for (const spec of list) {
      const T = R.types[spec.type]; if (!T) continue;
      const i = set.list.findIndex(r => r.type === spec.type && r.name.toLowerCase() === spec.name.toLowerCase());
      const r = {id: i >= 0 ? set.list[i].id : globalThis.Atrium.id(), type: spec.type, name: spec.name, comment: "xSignals wizard", enabled: true, priority: 0, scope: spec.scope};
      if (T.two) r.scope2 = spec.scope2 || globalThis.AtriumDesignQueryRecord.selector("all");
      for (const f of T.fields) { const d = f.def; r[f.key] = Array.isArray(d) ? [...d] : d && typeof d === "object" ? {...d} : d; if (f.omitNull && r[f.key] == null) delete r[f.key]; }
      for (const [k, v] of Object.entries(spec)) if (k !== "type" && k !== "scope" && k !== "scope2" && k !== "name" && T.fields.some(f => f.key === k)) r[k] = v;
      for (const f of T.fields) if (r[f.key] === undefined && f.optional) delete r[f.key];
      if (i >= 0) set.list[i] = r; else set.list.push(r);
      n++;
    }
    R.store(board, project, set);
    return n;
  }

  // ------------------------------------------------------------------ rules scoped to xSignals
  const isXsRule = r => Rl()?.isXsScope(r) === true;
  // xSignals a compiled rule (r.m1) covers: the matcher sees {net, xSignal}.
  function members(board, rule, parts = partsByRef(board)) {
    const out = [];
    for (const x of view(board).xSignals) { const nets = netsOf(board, x, parts); if (rule.m1({kind:"signal",name:x.name,net:nets[0] || "",xSignal:x.name})) out.push(x); }
    return out;
  }
  // Groups for the Length Manager and DRC: one per xSignal-scoped Matched Lengths / Delays rule.
  function ruleGroups(board, R, indexedParts) {
    const out = [], stored = view(board);
    if (!R || !stored.xSignals.length) return out;
    const parts = indexedParts || partsByRef(board);
    const pairsOf = list => {
      const P = [], byNet = new Map(); for (const x of list) byNet.set(x.name, x);
      const dp = new Map(); for (const p of R.pairs?.values?.() || []) { dp.set(p.positive, p); dp.set(p.negative, p); }
      const used = new Set();
      for (const x of list) {
        if (used.has(x.name)) continue;
        const nets = netsOf(board, x, parts), p = nets.map(n => dp.get(n)).find(Boolean); if (!p) continue;
        const mate = list.find(y => y !== x && !used.has(y.name) && y.to.ref === x.to.ref && netsOf(board, y, parts).some(n => n === (nets.includes(p.positive) ? p.negative : p.positive)));
        if (mate) { const pos = nets.includes(p.positive) ? x : mate, neg = pos === x ? mate : x; P.push({name: p.name + "@" + x.to.ref, positive: netsOf(board, pos, parts)[0], negative: netsOf(board, neg, parts)[0]}); used.add(x.name); used.add(mate.name); }
      }
      return P;
    };
    const claimed = new Map([["matchedLengths", new Set()], ["matchedDelays", new Set()]]);
    for (const type of ["matchedLengths", "matchedDelays"]) for (const r of R.byType[type] || []) {
      if (!isXsRule(r)) continue;
      const used = claimed.get(type), m = members(board, r, parts).filter(x => !used.has(x.name));
      if (!m.length) continue;
      for (const x of m) used.add(x.name);
      const delay = type === "matchedDelays";
      out.push({key: "rule:" + r.id, kind: "matched", name: r.name, rule: true, ruleId: r.id, ruleType: type, xs: true,
        tolerance: delay ? 0.254 : r.tolerance, withinPair: !!r.withinPair, pairTolerance: delay ? 0.127 : r.pairTolerance,
        ...(delay ? {basis: "delay", delayTolerance: r.tolerance, pairDelayTolerance: r.pairTolerance} : {}),
        members: m.map(x => ({name: x.name, kind: "xsignal", xs: x, nets: []})), pairs: pairsOf(m), explicit: stored.targets?.["rule:" + r.id] ?? null});
    }
    return out;
  }
  // DRC (rules.js): Length, Propagation Delay, Matched Lengths and Matched Delays rules scoped to
  // xSignals. rules.js removes these rules from its net checks and passes them here. Each xSignal
  // belongs to the first (highest-priority) rule of a type that scopes it, as nets do.
  function drc(doc, defs, {R, active, flag, notes}) {
    const E = L();
    const types = ["length", "delay", "matchedLengths", "matchedDelays"].filter(t => active(t) && (R.byType[t] || []).some(isXsRule));
    if (!types.length) return;
    if (!E?.xSignalLength || !E?.evaluateGroup) { notes.push("xSignal rules need the length engine (length-tuning.js)."); return; }
    const parts = partsByRef(doc), cache = new Map();
    const run = x => { if (!cache.has(x.name)) { let r; try { r = E.xSignalLength(doc, defs, x, {}); } catch (e) { r = {unrouted: true, reason: e.message}; } cache.set(x.name, r); } return cache.get(x.name); };
    for (const type of ["length", "delay"]) {
      if (!types.includes(type)) continue;
      const rules = R.byType[type].filter(isXsRule), ps = type === "delay";
      for (const x of view(doc).xSignals) {
        const nets = netsOf(doc, x, parts), r = rules.find(q => q.m1({kind:"signal",name:x.name,net:nets[0] || "",xSignal:x.name})); if (!r) continue;
        const m = run(x); if (m.unrouted) continue;
        const v = ps ? m.delay : m.length, min = r.min ?? 0, max = r.max ?? null, low = v + 1e-6 < min, high = max != null && v - 1e-6 > max;
        if (!low && !high) continue;
        const at = firstAt(doc, m.nets);
        const base = {id: at?.id ?? null, title: "xSignal " + x.name + " (" + m.nets.join(" → ") + ")", what: ps ? "Delay" : "Length", at: at?.at ?? null, xSignal: x.name};
        if (ps) flag(r, {...base, detail: "Delay " + v.toFixed(1) + " ps " + (low ? "< " + min : "> " + max) + " ps", unit: "ps", delay: {actual: v, required: low ? min : max, limit: low ? "min" : "max"}});
        else flag(r, {...base, actual: v, required: low ? min : max, limit: low ? "min" : "max"});
      }
    }
    for (const g of ruleGroups(doc, R)) {
      if (!types.includes(g.ruleType)) continue;
      const r = R.byType[g.ruleType].find(x => x.id === g.ruleId), ev = E.evaluateGroup(doc, defs, g, {});
      const ps = g.ruleType === "matchedDelays";
      for (const m of ev.members) {
        if (m.status === "pass" || m.status === "unrouted" || m.status === "length") continue;
        const at = m.at ? {id: m.id, at: m.at} : firstAt(doc, m.nets);
        const what = m.status === "skew" ? (ps ? "Phase skew" : "Intra-pair skew") : ps ? "Delay" : "Length";
        const v = {id: at?.id ?? null, title: "xSignal " + m.name + (m.nets?.length ? " (" + m.nets.join(" → ") + ")" : ""), what, at: at?.at ?? null, xSignal: m.name,
          detail: m.note + (ps ? " (target " + (+ev.targetDelay).toFixed(1) + " ps ±" + g.delayTolerance + " ps)" : " (target " + ev.target.toFixed(3) + " mm ±" + g.tolerance + " mm)")};
        if (ps) { v.unit = "ps"; v.delay = {actual: m.status === "skew" ? Math.abs(m.skewDelay || 0) : m.delay, required: m.status === "skew" ? g.pairDelayTolerance : ev.targetDelay, limit: m.status === "long" || m.status === "skew" ? "max" : "min"}; }
        else { v.actual = m.status === "skew" ? Math.abs(m.skew || 0) : m.length; v.required = m.status === "skew" ? g.pairTolerance : m.status === "long" ? ev.target + g.tolerance : ev.target - g.tolerance; v.target = ev.target; v.limit = m.status === "long" || m.status === "skew" ? "max" : "min"; }
        flag(r, v);
      }
      const unrouted = ev.members.filter(m => m.status === "unrouted").length;
      if (unrouted) notes.push(g.name + ": " + unrouted + " xSignal" + (unrouted === 1 ? " is" : "s are") + " not routed end to end yet.");
    }
  }
  // First track of the nets, for a marker position.
  function firstAt(doc, nets) {
    const s = new Set(nets || []);
    for (const i of doc.items || []) if (i.kind === "track" && s.has(i.net) && i.points?.length) return {id: i.id, at: [...i.points[0]]};
    return null;
  }

  // ------------------------------------------------------------------ package pin delays
  // CSV/TSV with a header: Designator (or Ref), Pin (or Pin Number), and Delay (ps) and/or
  // Length (mm; "mil" in the header or unit column converts). Lines starting with # are comments.
  function importPinDelays(board, text, o = {}) {
    const lines = String(text || "").split(/\r?\n/).filter(l => l.trim() && !/^\s*#/.test(l));
    if (!lines.length) fail("The pin delay file is empty.");
    const sep = lines[0].includes("\t") ? "\t" : lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
    const split = l => { const out = []; let cur = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur.trim()); cur = ""; } else cur += ch; } out.push(cur.trim()); return out; };
    const head = split(lines[0]).map(h => h.toLowerCase());
    const col = re => head.findIndex(h => re.test(h));
    const cRef = col(/^(designator|ref|refdes|component|part)/), cPin = col(/^(pin|pin ?number|pad|ball)/), cDelay = col(/delay|ps|time/), cLen = col(/length|len|mm|mil/), cUnit = col(/^unit/);
    if (cRef < 0 || cPin < 0 || (cDelay < 0 && cLen < 0)) fail("The header needs Designator, Pin and Delay (ps) or Length columns.");
    const milHead = cLen >= 0 && /mil/.test(head[cLen]), nsHead = cDelay >= 0 && /\bns\b/.test(head[cDelay]);
    const parts = partsByRef(board), stats = {pins: 0, parts: new Set(), unknown: new Set(), skipped: 0};
    for (const l of lines.slice(1)) {
      const c = split(l), ref = c[cRef], pin = c[cPin];
      if (!ref || !pin) { stats.skipped++; continue; }
      const part = parts.get(ref); if (!part) { stats.unknown.add(ref); continue; }
      const unit = cUnit >= 0 ? String(c[cUnit] || "").toLowerCase() : "";
      const d = cDelay >= 0 ? parseFloat(c[cDelay]) : NaN, len = cLen >= 0 ? parseFloat(c[cLen]) : NaN;
      if (Number.isFinite(d)) { part.pinDelays ||= {}; part.pinDelays[pin] = +(nsHead || unit === "ns" ? d * 1000 : d).toFixed(4); }
      if (Number.isFinite(len)) { part.pinLengths ||= {}; part.pinLengths[pin] = +(milHead || unit === "mil" ? len * 0.0254 : unit === "in" ? len * 25.4 : len).toFixed(5); }
      if (!Number.isFinite(d) && !Number.isFinite(len)) { stats.skipped++; continue; }
      stats.pins++; stats.parts.add(ref);
    }
    globalThis.AtriumLength?.invalidate?.(board);
    return {pins: stats.pins, parts: [...stats.parts].sort(natural), unknown: [...stats.unknown].sort(natural), skipped: stats.skipped};
  }

  // ------------------------------------------------------------------ evaluation (Constraint Manager, MCP)
  function measure(board, defs, o = {}) {
    const E = L(), out = [];
    for (const x of list(board)) {
      let r = null;
      try { r = E?.xSignalLength?.(board, defs, x, o) || null; } catch (e) { r = {unrouted: true, reason: e.message}; }
      out.push({name: x.name, from: x.from.ref + "." + x.from.pin, to: x.to.ref + "." + x.to.pin, through: x.through || [], nets: x.nets, classes: x.classes,
        length: r && !r.unrouted ? r.length : null, delay: r && !r.unrouted ? r.delay : null, die: r?.die ?? null, routed: !!r && !r.unrouted, reason: r?.unrouted ? r.reason : null});
    }
    return out;
  }

  // ------------------------------------------------------------------ MCP (headless.js op "xsignals")
  const r4 = v => typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 + 0 : v;
  function headless(a, H) {
    const action = a.action || "list";
    const p = action === "list" || action === "plan" ? H.project() : H.mutable(), doc = H.board(p, a.document_id), defs = H.defsOf(p);
    if (action === "list") {
      const rows = (a.measure === false ? list(doc).map(x => ({name: x.name, from: x.from.ref + "." + x.from.pin, to: x.to.ref + "." + x.to.pin, through: x.through || [], nets: x.nets, classes: x.classes})) : measure(doc, defs))
        .map(x => ({...x, length: r4(x.length), delay: r4(x.delay)}));
      const f = String(a.filter || "").toLowerCase(), cls = a.class;
      return {document_id: doc.id, units: {length: "mm", delay: "ps"}, classes: classes(doc), ...H.page(rows.filter(x => (!f || x.name.toLowerCase().includes(f)) && (!cls || x.classes.includes(cls))), a)};
    }
    if (action === "plan" || action === "wizard") {
      const pl = plan(doc, defs, {from: a.from, to: a.to, preset: a.preset, classPrefix: a.class_prefix, prefix: a.prefix, depth: a.depth, perLoad: a.per_load});
      const out = {document_id: doc.id, preset: pl.preset, summary: pl.summary, classes: pl.classes, pairs: pl.pairs, rules: pl.rules, topologies: pl.topologies, unmatched: pl.unmatched,
        xsignals: pl.xSignals.map(x => ({name: x.name, from: x.from.ref + "." + x.from.pin, to: x.to.ref + "." + x.to.pin, through: x.through, nets: x.nets, class: x.class || null, role: x.role}))};
      if (action === "plan") return out;
      const res = apply(doc, pl, {rules: a.rules !== false, project: p});
      H.touched();
      return {...out, applied: res};
    }
    if (action === "add") { const r = add(doc, a.xsignals || [], a.class, p); H.touched(); return {document_id: doc.id, ...r}; }
    if (action === "remove") { const r = remove(doc, a.names || [], p); H.touched(); return {document_id: doc.id, ...r}; }
    if (action === "set_class") { const m = setClass(doc, a.class, a.names || [], !!a.append, p); H.touched(); return {document_id: doc.id, class: a.class, members: m}; }
    if (action === "discover") return {document_id: doc.id, xsignals: discover(doc, defs, a.from, a.to, {depth: a.depth})};
    if (action === "import_pin_delays") { const r = importPinDelays(doc, a.csv || a.text || ""); H.touched(); return {document_id: doc.id, ...r}; }
    fail("Unknown xsignals action " + action + ". Use list, plan, wizard, add, remove, set_class, discover or import_pin_delays.");
  }

  // ------------------------------------------------------------------ wizard dialog
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function button(text, fn, title, cls) { const b = el("button", text, cls); b.classList.add("ui-button"); if (cls?.includes("is-primary")) b.dataset.variant = "primary"; b.type = "button"; b.onclick = fn; if (title) b.title = title; return b; }
  let dlg = null;
  function open(host) {
    if (dlg?.open) { dlg.focus?.(); return dlg; }
    const val = v => typeof v === "function" ? v() : v;
    const project = val(host.project), cur = val(host.doc);
    const board = cur?.kind === "pcb" ? cur : project?.documents?.find(d => d.kind === "pcb");
    if (!board) { host.info?.("Open a board layout first."); return null; }
    const defs = val(host.defs);
    const parts = [...partsByRef(board).values()].sort((a, b) => natural(a.ref, b.ref));
    const ics = parts.filter(p => Object.keys(p.pinNets || {}).length >= 8);
    const d = el("dialog", null, "ui-dialog work-dialog xs-dialog"); d.setAttribute("aria-label", "xSignals Wizard");
    dlg = d;
    const head = el("div", null, "xs-head"); head.append(el("h2", "xSignals Wizard", "ui-dialog-title"), el("p", "Builds source-to-load signal paths through series parts, groups them into classes and adds matching rules.", "xs-note"));
    const form = el("div", null, "work-form xs-form");
    const preset = el("select"); for (const [k, v] of Object.entries(PRESETS)) preset.add(new Option(v.label, k)); preset.value = "ddr4";
    const from = el("select"); for (const p of ics.length ? ics : parts) from.add(new Option(p.ref + (p.value ? " · " + p.value : ""), p.ref));
    from.value = (ics.slice().sort((a, b) => Object.keys(b.pinNets || {}).length - Object.keys(a.pinNets || {}).length)[0] || parts[0])?.ref || "";
    const to = el("select"); to.multiple = true; to.size = Math.min(6, Math.max(3, ics.length));
    const fillTo = () => { to.replaceChildren(); for (const p of ics.length ? ics : parts) if (p.ref !== from.value) to.add(new Option(p.ref + (p.value ? " · " + p.value : ""), p.ref)); if (to.options.length) to.options[0].selected = true; };
    fillTo();
    const prefix = el("input"); prefix.type = "text"; prefix.placeholder = "DDR4_"; prefix.setAttribute("aria-label", "Class prefix");
    const rulesBox = el("input", null, "ui-checkbox"); rulesBox.type = "checkbox"; rulesBox.checked = true;
    const row = (label, ctl) => { const l = el("label", label); ctl.classList.add("ui-field"); ctl.setAttribute("aria-label", label); form.append(l, ctl); };
    row("Interface", preset); row("Source (controller)", from); row("Loads", to); row("Class prefix", prefix);
    const rl = el("label", null, "xs-check"); rl.append(rulesBox, el("span", "Add matching and topology rules")); form.append(el("label", "Rules"), rl);
    const status = el("p", null, "xs-status"); status.setAttribute("role", "status");
    const out = el("div", null, "xs-preview ui-dialog-body");
    let current = null;
    function preview() {
      try {
        const sel = [...to.selectedOptions].map(o => o.value);
        current = plan(board, defs, {preset: preset.value, from: from.value, to: sel, classPrefix: prefix.value || undefined});
        status.textContent = current.summary; status.classList.remove("bad");
        out.replaceChildren();
        const table = el("table", null, "xs-table"), thead = el("thead"), tr = el("tr");
        for (const h of ["Class", "xSignal", "From", "To", "Through"]) tr.append(el("th", h));
        thead.append(tr); table.append(thead);
        const body = el("tbody");
        for (const x of current.xSignals.slice(0, 600)) {
          const r = el("tr"); r.dataset.role = x.role || "other";
          r.append(el("td", x.class || "—"), el("td", x.name), el("td", x.from.ref + "." + x.from.pin), el("td", x.to.ref + "." + x.to.pin), el("td", (x.through || []).join(", ") || "—"));
          body.append(r);
        }
        table.append(body); out.append(table);
        if (current.rules.length) {
          const ul = el("ul", null, "xs-rules");
          for (const r of current.rules) ul.append(el("li", r.name + ": " + (r.type === "matchedDelays" ? "Matched Delays ±" + r.tolerance + " ps" + (r.withinPair ? ", pairs ±" + r.pairTolerance + " ps" : "") : r.type === "matchedLengths" ? "Matched Lengths ±" + r.tolerance + " mm" : "Routing Topology " + r.topology + ", max stub " + r.maxStub + " mm")));
          out.append(el("p", "Rules", "xs-sub"), ul);
        }
        if (!current.xSignals.length) out.append(el("p", "No paths found between these components. Check that the board has nets from the schematic.", "empty-state"));
      } catch (e) { current = null; status.textContent = e.message; status.classList.add("bad"); out.replaceChildren(); }
    }
    preset.onchange = preview; from.onchange = () => { fillTo(); preview(); }; to.onchange = preview; prefix.oninput = preview;
    const foot = el("div", null, "work-actions ui-dialog-actions");
    const create = button("Create xSignals", () => {
      if (!current?.xSignals.length) return;
      let res = null;
      try { host.edit(() => { res = apply(board, current, {rules: rulesBox.checked, project}); }); }
      catch (e) { status.textContent = e.message; status.classList.add("bad"); return; }
      host.info?.("Created " + res.added + " xSignals (" + res.updated + " updated) in " + res.classes + " classes" + (res.rules ? ", " + res.rules + " rules" : "") + ".");
      host.invalidate?.(); d.close();
    }, "Write the xSignals, classes and rules to the board", "is-primary");
    const importBtn = button("Import pin delays…", async () => {
      try {
        const f = await (host.pickFile || globalThis.AtriumIO?.pickFile)?.({accept: ".csv,.tsv,.txt"});
        const text = typeof f === "string" ? f : await f?.text?.();
        if (!text) return;
        let r = null; host.edit(() => { r = importPinDelays(board, text); });
        status.textContent = "Imported " + r.pins + " pin delays for " + r.parts.length + " parts" + (r.unknown.length ? "; unknown: " + r.unknown.join(", ") : "") + ".";
      } catch (e) { status.textContent = e.message; status.classList.add("bad"); }
    }, "Package pin delays (CSV: Designator, Pin, Delay ps or Length mm)");
    foot.append(importBtn, button("Cancel", () => d.close()), create);
    d.append(head, form, status, out, foot);
    d.addEventListener("close", () => { dlg = null; d.remove(); }, {once: true});
    document.body.append(d); globalThis.AtriumShell?.adoptDialog?.(d, {initialFocus: preset, defaultAction: false}); d.showModal?.();
    preview();
    return d;
  }
  let H = null;
  function install(host) {
    if (H === host) return;
    H = host;
    host.registerAction("xsignal-wizard", () => open(host));
  }
  if (typeof document !== "undefined" && globalThis.AtriumNavCommon?.ready) AtriumNavCommon.ready(install);

  return Object.freeze({PRESETS, list, classes, netsOf, add, remove, setClass, discover, classify, plan, apply, addRules, isXsRule, members, ruleGroups, drc, importPinDelays, measure, headless, open, install});
})();
