"use strict";
// AtriumSpice: a small clean-room SPICE netlist parser and modified-nodal-analysis simulator.
// DOM-free and dependency-free: it runs in the SPICE extension's sandboxed worker, under Node or
// JavaScriptCore (tests/spice.cjs, cli.js) and anywhere else plain JavaScript runs.
//   Devices:  R C L V I, E (VCVS) F (CCCS) G (VCCS) H (CCVS), D (Shockley + RS, CJO, BV),
//             Q (Ebers–Moll transport model + VAF), M (level 1, Shichman–Hodges), X (subcircuits),
//             B (behavioural: V={expr}, I={expr}, or Q={expr} for a charge whose current is dQ/dt;
//             expressions from expr.js, loaded on the first B card, with automatic derivatives).
//   Analyses: .op, .dc (source sweep), .ac (complex small-signal), .tran (trapezoidal or backward
//             Euler, divided-difference LTE step control, source breakpoints).
//   parse(text) -> deck; simulate(textOrDeck, analysis?, options?) -> result; signal(result, "v(out)").
(function () {
  const Q = 1.602176634e-19, K = 1.380649e-23, VT = K * 300.15 / Q; // thermal voltage at 27 °C
  const SCALE = {t: 1e12, g: 1e9, meg: 1e6, k: 1e3, mil: 25.4e-6, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15};
  // A SPICE number: 4.7k, 10meg, 1e-3, 2.2uF (letters after the scale are ignored), and 4k7 / 1r5.
  function num(text) {
    if (typeof text === "number") return text;
    const s = String(text ?? "").trim().toLowerCase().replace(/[µμ]/g, "u");
    let m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(meg|mil|[tgkmunpf])?[a-z]*$/.exec(s);
    if (m) return Number(m[1]) * (m[2] ? SCALE[m[2]] : 1);
    m = /^(\d+)(meg|[tgkmunpfr])(\d+)[a-z]*$/.exec(s);
    return m ? Number(m[1] + "." + m[3]) * (m[2] === "r" ? 1 : SCALE[m[2]]) : NaN;
  }
  const isNum = t => Number.isFinite(num(t));
  // Engineering format: 4.7k, 1.25m, 330n.
  function eng(v, unit = "", digits = 4) {
    if (!Number.isFinite(v)) return String(v);
    if (v === 0) return "0 " + unit;
    const steps = [[1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"]];
    const [s, p] = steps.find(([x]) => Math.abs(v) >= x * 0.99995) || steps[steps.length - 1];
    return Number((v / s).toPrecision(digits)) + " " + p + unit;
  }
  const fail = msg => { throw Error(msg); };

  // ------------------------------------------------------------------ parsing
  // Lines: the first is the title; "*" comments; ";" and " $ " end-of-line comments; "+" continues.
  function cards(text) {
    const raw = String(text).replace(/\r\n?/g, "\n").split("\n"), out = [];
    raw.forEach((l, i) => {
      if (i === 0) { out.push({title: l.replace(/^\*\s*/, ""), line: 1}); return; }
      l = l.replace(/;.*$/, "").replace(/\s\$\s.*$/, "").trim();
      if (!l || l[0] === "*") return;
      if (l[0] === "+" && out.length > 1) out[out.length - 1].text += " " + l.slice(1).trim();
      else out.push({text: l, line: i + 1});
    });
    return out;
  }
  const tokens = text => text.replace(/[(),]/g, " ").replace(/\s*=\s*/g, "=").trim().split(/\s+/).filter(Boolean);
  const kv = list => { const o = {}; for (const t of list) { const m = /^(\w+)=(.+)$/.exec(t); if (m) o[m[1].toLowerCase()] = m[2]; } return o; };
  // Independent source specification: [DC] v, AC mag [phase], PULSE/SIN/EXP/PWL(...).
  function sourceSpec(list, where) {
    const s = {dc: null, acMag: 0, acPhase: 0, wave: null};
    for (let i = 0; i < list.length; i++) {
      const t = list[i].toLowerCase();
      if (t === "dc") { s.dc = num(list[++i]); continue; }
      if (t === "ac") { s.acMag = isNum(list[i + 1]) ? num(list[++i]) : 1; if (isNum(list[i + 1])) s.acPhase = num(list[++i]); continue; }
      if (/^(pulse|sin|exp|pwl|sffm)$/.test(t)) {
        const args = []; while (i + 1 < list.length && isNum(list[i + 1])) args.push(num(list[++i]));
        if (t === "sffm") fail(where + ": SFFM sources are not supported.");
        if (t === "pwl" && (args.length < 2 || args.length % 2)) fail(where + ": PWL needs time-value pairs.");
        s.wave = {type: t, args}; continue;
      }
      if (isNum(t) && s.dc == null && !s.wave) { s.dc = num(t); continue; }
      fail(where + ": cannot read the source specification at \"" + list[i] + "\".");
    }
    if (s.dc != null && !Number.isFinite(s.dc)) fail(where + ": bad DC value.");
    return s;
  }
  function parse(text) {
    const all = cards(text), deck = {title: all[0]?.title || "", elements: [], models: {}, subckts: {}, analyses: [], ic: {}, options: {}, params: {}, probes: [], warnings: []};
    let target = deck.elements, sub = null;
    for (const c of all.slice(1)) {
      const t = c.text, where = "line " + c.line;
      if (t[0] === ".") {
        const tk = tokens(t), cmd = tk[0].toLowerCase();
        if (cmd === ".end") break;
        if (cmd === ".model") {
          const m = /^\.model\s+(\S+)\s+([a-z]+)\s*\(?([^]*?)\)?\s*$/i.exec(t) || fail(where + ": bad .model card.");
          const params = {}; for (const [, k, v] of m[3].matchAll(/(\w+)\s*=\s*([^\s,)]+)/g)) params[k.toLowerCase()] = num(v);
          deck.models[m[1].toLowerCase()] = {name: m[1], type: m[2].toLowerCase(), params};
        } else if (cmd === ".subckt") {
          if (sub) fail(where + ": nested .subckt definitions are not supported.");
          const ports = tk.slice(2).filter(x => !x.includes("=") && x.toLowerCase() !== "params:");
          sub = {name: tk[1], ports, elements: []}; deck.subckts[String(tk[1]).toLowerCase()] = sub; target = sub.elements;
        } else if (cmd === ".ends") { sub = null; target = deck.elements; }
        else if (cmd === ".op") deck.analyses.push({type: "op"});
        else if (cmd === ".dc") {
          if (tk.length < 5) fail(where + ": .dc needs source start stop step.");
          deck.analyses.push({type: "dc", source: tk[1], start: num(tk[2]), stop: num(tk[3]), step: num(tk[4])});
        } else if (cmd === ".ac") {
          if (tk.length < 5) fail(where + ": .ac needs dec|oct|lin points fstart fstop.");
          deck.analyses.push({type: "ac", sweep: tk[1].toLowerCase(), points: num(tk[2]), fstart: num(tk[3]), fstop: num(tk[4])});
        } else if (cmd === ".tran") {
          const n = tk.slice(1).filter(isNum).map(num);
          if (n.length < 2) fail(where + ": .tran needs tstep tstop.");
          deck.analyses.push({type: "tran", tstep: n[0], tstop: n[1], tstart: n[2] || 0, tmax: n[3] || 0, uic: /\buic\b/i.test(t)});
        } else if (cmd === ".ic") { for (const [, n, v] of t.matchAll(/v\(\s*([^)\s]+)\s*\)\s*=\s*([^\s]+)/gi)) deck.ic[n.toLowerCase()] = num(v); }
        else if (cmd === ".options" || cmd === ".option") Object.assign(deck.options, kv(tk.slice(1)));
        else if (cmd === ".param") for (const [k, v] of Object.entries(kv(tk.slice(1)))) deck.params[k] = v;
        else if (cmd === ".probe" || cmd === ".print" || cmd === ".plot" || cmd === ".save") { for (const [, k, n] of t.matchAll(/\b([vi])\(\s*([^)\s]+)\s*\)/gi)) deck.probes.push(k.toLowerCase() + "(" + n + ")"); }
        else if (cmd === ".include" || cmd === ".lib") deck.warnings.push(where + ": " + cmd + " is ignored (the sandbox reads no files); paste the models into the netlist.");
        else if (cmd === ".temp" || cmd === ".global" || cmd === ".control" || cmd === ".endc" || cmd === ".title") deck.warnings.push(where + ": " + cmd + " is ignored.");
        else deck.warnings.push(where + ": unknown control card " + cmd + " ignored.");
        continue;
      }
      if (/^b/i.test(t)) { target.push(behaviouralCard(t, where)); continue; }
      const sub2 = t.replace(/\{\s*([a-z_]\w*)\s*\}/gi, (x, k) => (deck.params[k.toLowerCase()] ?? fail(where + ": unknown parameter " + k + ".")));
      const tk = tokens(sub2), name = tk[0], letter = name[0].toUpperCase();
      if (!"RCLVIEFGHDQMXK".includes(letter)) fail(where + ": unsupported element " + name + ".");
      if (letter === "K") { deck.warnings.push(where + ": coupled inductors (" + name + ") are not supported and were ignored."); continue; }
      target.push({letter, name, tokens: tk, where});
    }
    if (sub) fail("A .subckt " + sub.name + " is missing its .ends.");
    return deck;
  }

  // Bname n+ n- V=expr | I=expr | Q=expr, the expression bare, in {braces} or in 'quotes'.
  const EX = () => (typeof require === "function" ? require("./expr.js") : globalThis.AtriumSpiceExpr) || fail("expr.js is not loaded.");
  function behaviouralCard(t, where) {
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+([viq])\s*=\s*([^]+)$/i.exec(t) || fail(where + ": a B source reads Bname n+ n- V=expr, I=expr or Q=expr.");
    let src = m[5].trim();
    if (/^\{[^]*\}$/.test(src) || /^'[^]*'$/.test(src)) src = src.slice(1, -1);
    let parsed;
    try { parsed = EX().parse(src); } catch (e) { fail(where + " (" + m[1] + "): " + e.message); }
    return {letter: "B", name: m[1], tokens: [m[1], m[2], m[3]], where, kind: m[4].toLowerCase(), parsed};
  }

  // ------------------------------------------------------------------ linear algebra
  // Dense LU with partial pivoting; circuits here have tens to a few hundred unknowns.
  function solveReal(A, b, n) {
    for (let k = 0; k < n; k++) {
      let p = k, best = Math.abs(A[k * n + k]);
      for (let i = k + 1; i < n; i++) { const v = Math.abs(A[i * n + k]); if (v > best) { best = v; p = i; } }
      if (!(best > 1e-300)) { const e = Error("singular"); e.row = k; throw e; }
      if (p !== k) { for (let j = 0; j < n; j++) { const t = A[k * n + j]; A[k * n + j] = A[p * n + j]; A[p * n + j] = t; } const t = b[k]; b[k] = b[p]; b[p] = t; }
      const d = A[k * n + k];
      for (let i = k + 1; i < n; i++) {
        const f = A[i * n + k] / d; if (f === 0) continue;
        for (let j = k + 1; j < n; j++) A[i * n + j] -= f * A[k * n + j];
        b[i] -= f * b[k];
      }
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= A[i * n + j] * x[j]; x[i] = s / A[i * n + i]; }
    return x;
  }
  function solveComplex(Ar, Ai, br, bi, n) {
    for (let k = 0; k < n; k++) {
      let p = k, best = Math.hypot(Ar[k * n + k], Ai[k * n + k]);
      for (let i = k + 1; i < n; i++) { const v = Math.hypot(Ar[i * n + k], Ai[i * n + k]); if (v > best) { best = v; p = i; } }
      if (!(best > 1e-300)) { const e = Error("singular"); e.row = k; throw e; }
      if (p !== k) for (const M of [Ar, Ai]) for (let j = 0; j < n; j++) { const t = M[k * n + j]; M[k * n + j] = M[p * n + j]; M[p * n + j] = t; }
      if (p !== k) for (const v of [br, bi]) { const t = v[k]; v[k] = v[p]; v[p] = t; }
      const dr = Ar[k * n + k], di = Ai[k * n + k], dd = dr * dr + di * di;
      for (let i = k + 1; i < n; i++) {
        const ar = Ar[i * n + k], ai = Ai[i * n + k]; if (ar === 0 && ai === 0) continue;
        const fr = (ar * dr + ai * di) / dd, fi = (ai * dr - ar * di) / dd;
        for (let j = k + 1; j < n; j++) { const cr = Ar[k * n + j], ci = Ai[k * n + j]; Ar[i * n + j] -= fr * cr - fi * ci; Ai[i * n + j] -= fr * ci + fi * cr; }
        const cr = br[k], ci = bi[k]; br[i] -= fr * cr - fi * ci; bi[i] -= fr * ci + fi * cr;
      }
    }
    const xr = new Float64Array(n), xi = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let sr = br[i], si = bi[i];
      for (let j = i + 1; j < n; j++) { const ar = Ar[i * n + j], ai = Ai[i * n + j]; sr -= ar * xr[j] - ai * xi[j]; si -= ar * xi[j] + ai * xr[j]; }
      const dr = Ar[i * n + i], di = Ai[i * n + i], dd = dr * dr + di * di;
      xr[i] = (sr * dr + si * di) / dd; xi[i] = (si * dr - sr * di) / dd;
    }
    return [xr, xi];
  }

  // ------------------------------------------------------------------ devices
  const E80 = Math.exp(80);
  const expl = a => (a > 80 ? E80 * (1 + a - 80) : Math.exp(a)), dexpl = a => (a > 80 ? E80 : Math.exp(a));
  const V = (x, i) => (i < 0 ? 0 : x[i]);
  // SPICE junction voltage limiting: grow forward-biased junctions logarithmically.
  function pnjlim(ctx, vnew, vold, vt, vcrit) {
    if (ctx.noLimit || !(vnew > vcrit && Math.abs(vnew - vold) > 2 * vt)) return vnew;
    ctx.limited = true;
    if (vold > 0) { const arg = 1 + (vnew - vold) / vt; return arg > 0 ? vold + vt * Math.log(arg) : vcrit; }
    return vt * Math.log(vnew / vt);
  }
  const add = (ctx, i, j, v) => { if (i >= 0 && j >= 0) ctx.A[i * ctx.n + j] += v; };
  const rhs = (ctx, i, v) => { if (i >= 0) ctx.b[i] += v; };
  function conductance(ctx, a, b, g) { add(ctx, a, a, g); add(ctx, b, b, g); add(ctx, a, b, -g); add(ctx, b, a, -g); }
  function incidence(ctx, a, b, br) { add(ctx, a, br, 1); add(ctx, b, br, -1); add(ctx, br, a, 1); add(ctx, br, b, -1); }
  // A nonlinear device linearised at V0: I[k] is the current into the device at terminal k and
  // J[k][j] = dI[k]/dV[j]. The Jacobian goes into A and the companion current into b.
  function stampNL(ctx, nodes, I, J, V0) {
    for (let k = 0; k < nodes.length; k++) {
      const r = nodes[k]; if (r < 0) continue;
      let s = I[k];
      for (let j = 0; j < nodes.length; j++) { s -= J[k][j] * V0[j]; add(ctx, r, nodes[j], J[k][j]); }
      ctx.b[r] -= s;
    }
  }
  // Time-dependent value of an independent source.
  function waveAt(w, t, dc, step, stop) {
    const a = w.args, g = (i, d) => (a[i] != null ? a[i] : d);
    switch (w.type) {
      case "pulse": {
        const v1 = g(0, 0), v2 = g(1, 0), td = g(2, 0), tr = g(3, 0) || step, tf = g(4, 0) || step, pw = a[5] != null ? a[5] : stop, per = a[6] || Infinity;
        if (t < td) return v1;
        let u = t - td; if (Number.isFinite(per) && per > 0) u %= per;
        if (u < tr) return v1 + (v2 - v1) * u / tr;
        if (u < tr + pw) return v2;
        if (u < tr + pw + tf) return v2 + (v1 - v2) * (u - tr - pw) / tf;
        return v1;
      }
      case "sin": {
        const vo = g(0, 0), va = g(1, 0), f = g(2, stop > 0 ? 1 / stop : 0), td = g(3, 0), th = g(4, 0), ph = g(5, 0) * Math.PI / 180;
        if (t < td) return vo + va * Math.sin(ph);
        return vo + va * Math.exp(-(t - td) * th) * Math.sin(2 * Math.PI * f * (t - td) + ph);
      }
      case "exp": {
        const v1 = g(0, 0), v2 = g(1, 0), td1 = g(2, 0), tau1 = g(3, step) || step, td2 = g(4, td1 + step), tau2 = g(5, step) || step;
        let v = v1;
        if (t >= td1) v += (v2 - v1) * (1 - Math.exp(-(t - td1) / tau1));
        if (t >= td2) v += (v1 - v2) * (1 - Math.exp(-(t - td2) / tau2));
        return v;
      }
      case "pwl": {
        if (t <= a[0]) return a[1];
        for (let i = 2; i < a.length; i += 2) if (t <= a[i]) return a[i - 1] + (a[i + 1] - a[i - 1]) * (t - a[i - 2]) / ((a[i] - a[i - 2]) || 1);
        return a[a.length - 1];
      }
    }
    return dc;
  }
  function breakpoints(w, stop, step) {
    const a = w.args, out = [];
    if (w.type === "pulse") {
      const td = a[2] || 0, tr = a[3] || step, tf = a[4] || step, pw = a[5] != null ? a[5] : stop, per = a[6] || Infinity;
      for (let base = td; base <= stop && out.length < 20000; base += per) { out.push(base, base + tr, base + tr + pw, base + tr + pw + tf); if (!Number.isFinite(per)) break; }
    } else if (w.type === "pwl") for (let i = 0; i < a.length; i += 2) out.push(a[i]);
    else if (w.type === "exp") out.push(a[2] || 0, a[4] != null ? a[4] : (a[2] || 0) + step);
    else if (w.type === "sin") out.push(a[3] || 0);
    return out.filter(t => t > 0 && t < stop);
  }
  function source(dev, spec) {
    dev.spec = spec;
    dev.value = ctx => {
      if (dev.override != null) return dev.override * ctx.srcScale;
      const s = dev.spec;
      if (ctx.mode === "tran" && s.wave) return waveAt(s.wave, ctx.t, s.dc ?? 0, ctx.step, ctx.stop);
      return (s.dc != null ? s.dc : s.wave ? waveAt(s.wave, 0, 0, 1, 1) : 0) * ctx.srcScale;
    };
  }

  // ------------------------------------------------------------------ circuit construction
  // Flatten the deck (subcircuits expanded, names prefixed "X1.") into device objects whose
  // terminals are matrix rows (-1 for ground). Branch rows follow the node rows.
  // Work limits: expanded elements, matrix size (n² doubles: 4000 → 128 MB) and stored samples.
  const LIMITS = {elements: 200000, unknowns: 4000, samples: 2e7};
  function build(deck, options = {}) {
    const rows = new Map(), names = [], devices = [], byName = new Map(), warnings = [...deck.warnings];
    const node = n => {
      const k = String(n).toLowerCase();
      if (k === "0" || k === "gnd" || k === "gnd!") return -1;
      if (!rows.has(k)) { rows.set(k, names.length); names.push(String(n)); }
      return rows.get(k);
    };
    const model = (name, types, where) => {
      const m = deck.models[String(name).toLowerCase()];
      if (!m) fail(where + ": no .model " + name + ".");
      if (!types.includes(m.type)) fail(where + ": model " + name + " is a " + m.type + ", expected " + types.join(" or ") + ".");
      return m;
    };
    let internal = 0, expanded = 0;
    const branchOwners = [];
    function element(el, prefix, map, depth) {
      // Subcircuit fan-out is bounded while expanding (10 levels of 10 instances is 10^10
      // elements from 1 KB of text): fail fast instead of exhausting memory.
      if (++expanded > LIMITS.elements) fail("The circuit expands to more than " + LIMITS.elements.toLocaleString("en") + " elements (subcircuits included); this simulator handles board-level circuits.");
      const tk = el.tokens, name = prefix + tk[0], L = el.letter, where = el.where + " (" + name + ")";
      const nodeOf = t => { const k = t.toLowerCase(); return map && map.has(k) ? map.get(k) : node(k === "0" || k === "gnd" || !prefix ? t : prefix + t); };
      const n = i => { const t = tk[i]; if (t == null) fail(where + ": missing a node."); return nodeOf(t); };
      const value = i => { const v = num(tk[i]); if (!Number.isFinite(v)) fail(where + ": bad value \"" + (tk[i] ?? "") + "\"."); return v; };
      const dev = {name, letter: L, key: name.toLowerCase()};
      const branch = () => { dev.br = true; branchOwners.push(dev); };
      switch (L) {
        case "R": { dev.a = n(1); dev.b = n(2); const r = value(3); if (r === 0) fail(where + ": zero resistance; use a 0 V source."); dev.r = r; dev.load = ctx => conductance(ctx, dev.a, dev.b, 1 / r); break; }
        case "C": { const ic = kv(tk.slice(4)).ic; capacitor(dev, n(1), n(2), value(3), ic != null ? num(ic) : null); break; }
        case "L": {
          dev.a = n(1); dev.b = n(2); dev.l = value(3); const ic = kv(tk.slice(4)).ic; if (ic != null) dev.ic = num(ic); branch();
          dev.ip = 0; dev.vp = 0;
          dev.load = ctx => {
            incidence(ctx, dev.a, dev.b, dev.row);
            if (ctx.mode !== "tran") return;
            const r = (ctx.method === "be" ? 1 : 2) * dev.l / ctx.h;
            add(ctx, dev.row, dev.row, -r); rhs(ctx, dev.row, -r * dev.ip - (ctx.method === "be" ? 0 : dev.vp));
          };
          dev.ac = (ctx, w) => { ctx.Ai[dev.row * ctx.n + dev.row] -= w * dev.l; };
          dev.init = (x, uic) => { dev.ip = uic && dev.ic != null ? dev.ic : x[dev.row]; dev.vp = V(x, dev.a) - V(x, dev.b); };
          dev.accept = x => { dev.ip = x[dev.row]; dev.vp = V(x, dev.a) - V(x, dev.b); };
          break;
        }
        case "V": case "I": {
          dev.a = n(1); dev.b = n(2); source(dev, sourceSpec(tk.slice(3), where));
          if (L === "V") {
            branch();
            dev.load = ctx => { incidence(ctx, dev.a, dev.b, dev.row); rhs(ctx, dev.row, dev.value(ctx)); };
            dev.acRhs = ctx => { ctx.br[dev.row] += dev.spec.acMag * Math.cos(dev.spec.acPhase * Math.PI / 180); ctx.bi[dev.row] += dev.spec.acMag * Math.sin(dev.spec.acPhase * Math.PI / 180); };
          } else {
            dev.load = ctx => { const i = dev.value(ctx); rhs(ctx, dev.a, -i); rhs(ctx, dev.b, i); };
            dev.acRhs = ctx => {
              const re = dev.spec.acMag * Math.cos(dev.spec.acPhase * Math.PI / 180), im = dev.spec.acMag * Math.sin(dev.spec.acPhase * Math.PI / 180);
              if (dev.a >= 0) { ctx.br[dev.a] -= re; ctx.bi[dev.a] -= im; } if (dev.b >= 0) { ctx.br[dev.b] += re; ctx.bi[dev.b] += im; }
            };
          }
          break;
        }
        case "E": case "G": {
          dev.a = n(1); dev.b = n(2); dev.cp = n(3); dev.cn = n(4); const g = value(5);
          if (L === "E") { branch(); dev.load = ctx => { incidence(ctx, dev.a, dev.b, dev.row); add(ctx, dev.row, dev.cp, -g); add(ctx, dev.row, dev.cn, g); }; }
          else dev.load = ctx => { add(ctx, dev.a, dev.cp, g); add(ctx, dev.a, dev.cn, -g); add(ctx, dev.b, dev.cp, -g); add(ctx, dev.b, dev.cn, g); };
          break;
        }
        case "F": case "H": {
          dev.a = n(1); dev.b = n(2); dev.ctrl = (prefix + tk[3]).toLowerCase(); dev.ctrlWhere = where; const g = value(4);
          if (L === "H") { branch(); dev.load = ctx => { incidence(ctx, dev.a, dev.b, dev.row); add(ctx, dev.row, dev.ctrlDev.row, -g); }; }
          else dev.load = ctx => { add(ctx, dev.a, dev.ctrlDev.row, g); add(ctx, dev.b, dev.ctrlDev.row, -g); };
          break;
        }
        case "B": behavioural(dev, el, n, nodeOf, prefix, where); break;
        case "D": diode(dev, n, tk, model(tk[3], ["d"], where), where); break;
        case "Q": bjt(dev, n, tk, where); break;
        case "M": mosfet(dev, n, tk, where); break;
        case "X": {
          if (depth > 20) fail(where + ": subcircuits nest too deeply.");
          const nodesTk = tk.slice(1).filter(t => !t.includes("=")), subName = nodesTk.pop(), def = deck.subckts[String(subName).toLowerCase()];
          if (!def) {
            if (options.missing === "skip") { warnings.push(name + ": no .subckt " + subName + "; left out of the simulation."); return; }
            fail(where + ": no .subckt " + subName + ".");
          }
          if (def.ports.length !== nodesTk.length) fail(where + ": " + subName + " has " + def.ports.length + " pins; " + nodesTk.length + " were connected.");
          const m = new Map(def.ports.map((p, i) => [p.toLowerCase(), n(1 + i)]));
          for (const e of def.elements) element(e, name + ".", m, depth + 1);
          return;
        }
      }
      if (byName.has(dev.key)) fail(where + ": " + name + " is defined twice.");
      byName.set(dev.key, dev); devices.push(dev);
    }
    function capacitor(dev, a, b, c, ic) {
      Object.assign(dev, {a, b, c, ic, vp: 0, ip: 0});
      dev.load = ctx => {
        if (ctx.mode !== "tran") return;
        const g = (ctx.method === "be" ? 1 : 2) * c / ctx.h, ieq = g * dev.vp + (ctx.method === "be" ? 0 : dev.ip);
        conductance(ctx, a, b, g); rhs(ctx, a, ieq); rhs(ctx, b, -ieq);
      };
      dev.ac = (ctx, w) => { const y = w * c; for (const [i, j, s] of [[a, a, 1], [b, b, 1], [a, b, -1], [b, a, -1]]) if (i >= 0 && j >= 0) ctx.Ai[i * ctx.n + j] += s * y; };
      dev.init = (x, uic) => { dev.vp = uic && ic != null ? ic : V(x, a) - V(x, b); dev.ip = 0; };
      dev.accept = (x, ctx) => { const v = V(x, a) - V(x, b), g = (ctx.method === "be" ? 1 : 2) * c / ctx.h; dev.ip = ctx.method === "be" ? g * (v - dev.vp) : g * (v - dev.vp) - dev.ip; dev.vp = v; };
    }
    // Behavioural source. The expression's V() nodes and I() sources become the variables x; its
    // value f and gradient d linearise it for Newton: V: v(a)-v(b) = f; I: current f leaves a and
    // enters b; Q: the current is dQ/dt (trapezoidal or backward Euler companion; jw*dQ/dx in AC).
    function behavioural(dev, el, n, nodeOf, prefix, where) {
      dev.a = n(1); dev.b = n(2); dev.kind = el.kind;
      let f;
      try { f = EX().compile(el.parsed, Object.fromEntries(Object.entries(deck.params).map(([k, v]) => [k, num(v)]))); } catch (e) { fail(where + ": " + e.message); }
      dev.vars = el.parsed.vars.map(v => (v.t === "v" ? {row: nodeOf(v.node)} : {ctrl: (prefix + v.name).toLowerCase()}));
      if (dev.vars.some(v => v.ctrl)) { dev.ctrlList = dev.vars.filter(v => v.ctrl); dev.ctrlWhere = where; }
      const rowsOf = () => dev.rows || (dev.rows = dev.vars.map(v => (v.ctrl ? v.dev.row : v.row)));
      const evalAt = (x, ctx) => { const r = rowsOf(), xs = r.map(i => V(x, i)); return {r, xs, ...f(xs, {time: ctx.mode === "tran" ? ctx.t : 0, temp: 27})}; };
      const current = (ctx, i, d, r, xs) => {
        let s = i;
        for (let k = 0; k < r.length; k++) { add(ctx, dev.a, r[k], d[k]); add(ctx, dev.b, r[k], -d[k]); s -= d[k] * xs[k]; }
        rhs(ctx, dev.a, -s); rhs(ctx, dev.b, s);
      };
      if (el.kind === "v") {
        dev.br = true; branchOwners.push(dev);
        dev.load = ctx => {
          const {r, xs, v, d} = evalAt(ctx.x, ctx);
          incidence(ctx, dev.a, dev.b, dev.row);
          let s = v; for (let k = 0; k < r.length; k++) { add(ctx, dev.row, r[k], -d[k]); s -= d[k] * xs[k]; }
          rhs(ctx, dev.row, s);
        };
      } else if (el.kind === "i") {
        dev.load = ctx => { const {r, xs, v, d} = evalAt(ctx.x, ctx); current(ctx, v, d, r, xs); };
      } else {
        dev.qp = 0; dev.ip = 0; dev.qd = null;
        dev.load = ctx => {
          const {r, xs, v, d} = evalAt(ctx.x, ctx);
          if (ctx.mode !== "tran") { dev.qd = d; dev.qr = r; return; }
          const g = (ctx.method === "be" ? 1 : 2) / ctx.h, i = g * (v - dev.qp) - (ctx.method === "be" ? 0 : dev.ip);
          current(ctx, i, d.map(x => x * g), r, xs);
        };
        dev.ac = (ctx, w) => {
          if (!dev.qd) return;
          for (let k = 0; k < dev.qr.length; k++) for (const [row, s] of [[dev.a, 1], [dev.b, -1]]) if (row >= 0 && dev.qr[k] >= 0) ctx.Ai[row * ctx.n + dev.qr[k]] += s * w * dev.qd[k];
        };
        dev.init = x => { dev.qp = evalAt(x, {mode: "dc"}).v; dev.ip = 0; };
        dev.accept = (x, ctx) => { const q = evalAt(x, ctx).v, g = (ctx.method === "be" ? 1 : 2) / ctx.h; dev.ip = ctx.method === "be" ? g * (q - dev.qp) : g * (q - dev.qp) - dev.ip; dev.qp = q; };
      }
    }
    function diode(dev, n, tk, m, where) {
      const p = m.params, area = isNum(tk[4]) ? num(tk[4]) : 1, is = (p.is ?? 1e-14) * area, nn = p.n ?? 1, rs = (p.rs ?? 0) / area, nvt = nn * VT;
      const bv = p.bv, ibv = p.ibv ?? 1e-3, cjo = (p.cjo ?? 0) * area;
      dev.a = n(1); dev.k = n(2); dev.model = m.name;
      if (rs > 0) { const mid = node(dev.name + "#a" + internal++); devices.push({name: dev.name + "#rs", load: ctx => conductance(ctx, dev.a, mid, 1 / rs)}); dev.ai = mid; } else dev.ai = dev.a;
      if (cjo > 0) { const cap = {name: dev.name + "#cj", letter: "C"}; capacitor(cap, dev.ai, dev.k, cjo, null); devices.push(cap); }
      const vcrit = nvt * Math.log(nvt / (Math.SQRT2 * is));
      dev.vd = 0;
      dev.load = ctx => {
        let vd = V(ctx.x, dev.ai) - V(ctx.x, dev.k);
        vd = pnjlim(ctx, vd, dev.vd, nvt, vcrit);
        if (bv != null && !ctx.noLimit && vd < -bv) vd = -bv - pnjlim(ctx, -bv - vd, -bv - dev.vd, nvt, vcrit);
        dev.vd = vd;
        let id = is * (expl(vd / nvt) - 1), gd = is * dexpl(vd / nvt) / nvt;
        if (bv != null) { const a = -(vd + bv) / nvt; id -= ibv * expl(a); gd += ibv * dexpl(a) / nvt; }
        id += ctx.gmin * vd; gd += ctx.gmin; dev.id = id; dev.gd = gd;
        const vk = V(ctx.x, dev.k);
        stampNL(ctx, [dev.ai, dev.k], [id, -id], [[gd, -gd], [-gd, gd]], [vk + vd, vk]);
      };
      dev.info = () => ({vd: dev.vd, id: dev.id});
    }
    function pickModel(tk, from, types, where) {
      let mi = -1;
      for (let i = from; i < tk.length; i++) if (!tk[i].includes("=") && deck.models[tk[i].toLowerCase()]) { mi = i; break; }
      if (mi < 0) for (let i = tk.length - 1; i >= from; i--) if (!tk[i].includes("=") && !isNum(tk[i])) { mi = i; break; }
      if (mi < 0) fail(where + ": missing a model name.");
      return [mi, model(tk[mi], types, where)];
    }
    function bjt(dev, n, tk, where) {
      const [mi, m] = pickModel(tk, 4, ["npn", "pnp"], where), p = m.params, pol = m.type === "pnp" ? -1 : 1;
      if (mi < 4) fail(where + ": a BJT needs collector, base and emitter nodes.");
      const area = isNum(tk[mi + 1]) ? num(tk[mi + 1]) : 1, is = (p.is ?? 1e-16) * area, bf = p.bf ?? 100, br = p.br ?? 1, nf = p.nf ?? 1, nr = p.nr ?? 1;
      const vaf = p.vaf || Infinity, vtf = nf * VT, vtr = nr * VT, vcrit = VT * Math.log(VT / (Math.SQRT2 * is));
      dev.c = n(1); dev.b = n(2); dev.e = n(3); dev.model = m.name; dev.vbe = 0; dev.vbc = 0;
      dev.load = ctx => {
        const x = ctx.x, vc = V(x, dev.c), vb = V(x, dev.b), ve = V(x, dev.e);
        let vbe = pol * (vb - ve), vbc = pol * (vb - vc);
        vbe = pnjlim(ctx, vbe, dev.vbe, vtf, vcrit); vbc = pnjlim(ctx, vbc, dev.vbc, vtr, vcrit);
        dev.vbe = vbe; dev.vbc = vbc;
        const iF = is * (expl(vbe / vtf) - 1) + ctx.gmin * vbe, gF = is * dexpl(vbe / vtf) / vtf + ctx.gmin;
        const iR = is * (expl(vbc / vtr) - 1) + ctx.gmin * vbc, gR = is * dexpl(vbc / vtr) / vtr + ctx.gmin;
        const kq = 1 - vbc / vaf, ict = (iF - iR) * kq;
        const ic = ict - iR / br, ib = iF / bf + iR / br;
        const dIc_be = gF * kq, dIc_bc = -gR * kq - (iF - iR) / vaf - gR / br, dIb_be = gF / bf, dIb_bc = gR / br;
        dev.ic = pol * ic; dev.ib = pol * ib;
        // Terminal currents into the device and their derivatives with respect to (vc, vb, ve).
        const rowC = [-dIc_bc, dIc_be + dIc_bc, -dIc_be], rowB = [-dIb_bc, dIb_be + dIb_bc, -dIb_be], rowE = rowC.map((v, i) => -(v + rowB[i]));
        const Ic = pol * ic, Ib = pol * ib;
        // Linearise around the limited junction voltages (consistent terminal voltages).
        const v0 = [vb - pol * vbc, vb, vb - pol * vbe];
        stampNL(ctx, [dev.c, dev.b, dev.e], [Ic, Ib, -(Ic + Ib)], [rowC, rowB, rowE], v0);
      };
      dev.info = () => ({ic: dev.ic, ib: dev.ib, vbe: dev.vbe * pol, vce: pol * (dev.vbe - dev.vbc)});
    }
    function mosfet(dev, n, tk, where) {
      const [mi, m] = pickModel(tk, 4, ["nmos", "pmos"], where), p = m.params, pol = m.type === "pmos" ? -1 : 1, inst = kv(tk.slice(mi + 1));
      const w = inst.w != null ? num(inst.w) : p.w ?? 1e-4, l = inst.l != null ? num(inst.l) : p.l ?? 1e-4;
      const beta = (p.kp ?? 2e-5) * w / l, vth = pol * (p.vto ?? 0), lambda = p.lambda ?? 0;
      dev.d = n(1); dev.g = n(2); dev.s = n(3); dev.model = m.name; dev.vgs = 0; dev.vds = 0;
      dev.load = ctx => {
        const x = ctx.x, vd = V(x, dev.d), vg = V(x, dev.g), vs = V(x, dev.s);
        let vgs = pol * (vg - vs), vds = pol * (vd - vs);
        if (!ctx.noLimit) {
          const cl = (v, o, s) => (Math.abs(v - o) > s ? (ctx.limited = true, o + Math.sign(v - o) * s) : v);
          vgs = cl(vgs, dev.vgs, Math.max(0.5, Math.abs(dev.vgs - vth) * 0.5)); vds = cl(vds, dev.vds, Math.max(2, Math.abs(dev.vds) * 0.5));
        }
        dev.vgs = vgs; dev.vds = vds;
        // Reverse mode: the terminals swap roles so vds' >= 0.
        const rev = vds < 0, vgsN = rev ? vgs - vds : vgs, vdsN = rev ? -vds : vds, vov = vgsN - vth, cl = 1 + lambda * vdsN;
        let id = 0, gm = 0, gds = 0, region = "cutoff";
        if (vov > 0) {
          if (vdsN < vov) { region = "triode"; id = beta * (vov * vdsN - vdsN * vdsN / 2) * cl; gm = beta * vdsN * cl; gds = beta * (vov - vdsN) * cl + beta * (vov * vdsN - vdsN * vdsN / 2) * lambda; }
          else { region = "saturation"; id = beta / 2 * vov * vov * cl; gm = beta * vov * cl; gds = beta / 2 * vov * vov * lambda; }
        }
        gds += ctx.gmin;
        id += ctx.gmin * vdsN;
        const D = rev ? dev.s : dev.d, S = rev ? dev.d : dev.s, vS = rev ? vd : vs;
        const Id = pol * id;
        dev.id = rev ? -Id : Id; dev.region = region;
        const rowD = [gds, gm, -(gm + gds)], rowS = rowD.map(v => -v);
        stampNL(ctx, [D, dev.g, S], [Id, 0, -Id], [rowD, [0, 0, 0], rowS], [vS + pol * vdsN, vS + pol * vgsN, vS]);
      };
      dev.info = () => ({id: dev.id, vgs: pol * dev.vgs, vds: pol * dev.vds, region: dev.region});
    }
    for (const el of deck.elements) element(el, "", null, 0);
    for (const dev of devices) if (dev.ctrl) {
      dev.ctrlDev = byName.get(dev.ctrl);
      if (!dev.ctrlDev || !dev.ctrlDev.br) fail(dev.ctrlWhere + ": the controlling element " + dev.ctrl + " must be a voltage source or inductor.");
    }
    for (const dev of devices) for (const v of dev.ctrlList || []) {
      v.dev = byName.get(v.ctrl);
      if (!v.dev || !v.dev.br) fail(dev.ctrlWhere + ": I(" + v.ctrl + ") must name a voltage source, inductor or B voltage source.");
    }
    const nNodes = names.length;
    branchOwners.forEach((d, i) => { d.row = nNodes + i; });
    if (!nNodes) fail("The circuit has no nodes besides ground.");
    const unknowns = nNodes + branchOwners.length;
    if (unknowns > LIMITS.unknowns) fail("The circuit has " + unknowns + " unknowns; the dense solver is limited to " + LIMITS.unknowns + ".");
    return {names, rows, devices, byName, nNodes, n: nNodes + branchOwners.length, branches: branchOwners, warnings};
  }

  // ------------------------------------------------------------------ Newton–Raphson
  function newton(ckt, x0, ctx, maxIter) {
    const n = ckt.n, opt = ckt.opt;
    let x = Float64Array.from(x0), polished = !ctx.polish;
    ctx.n = n;
    for (let it = 0; it < maxIter; it++) {
      // One matrix buffer per context, cleared each iteration, instead of a new n² array.
      if (ctx.A?.length === n * n) ctx.A.fill(0); else ctx.A = new Float64Array(n * n);
      if (ctx.b?.length === n) ctx.b.fill(0); else ctx.b = new Float64Array(n);
      ctx.x = x; ctx.limited = false;
      for (const d of ckt.devices) d.load(ctx);
      for (let i = 0; i < ckt.nNodes; i++) ctx.A[i * n + i] += ctx.gdiag;
      if (ctx.force) for (const [r, v] of ctx.force) { ctx.A[r * n + r] += 1; ctx.b[r] += v; }
      let xn;
      try { xn = solveReal(ctx.A, ctx.b, n); }
      catch (e) { if (e.message === "singular") throw Error("The circuit matrix is singular near " + rowName(ckt, e.row) + " (a floating node, a loop of voltage sources or inductors, or a cut set of current sources)."); throw e; }
      ckt.iterations++;
      let ok = !ctx.limited;
      for (let i = 0; i < n && ok; i++) {
        if (!Number.isFinite(xn[i])) throw Error("The solution diverged.");
        const tol = opt.reltol * Math.max(Math.abs(xn[i]), Math.abs(x[i])) + (i < ckt.nNodes ? opt.vntol : opt.abstol);
        if (Math.abs(xn[i] - x[i]) > tol) ok = false;
      }
      for (let i = 0; i < n; i++) if (!Number.isFinite(xn[i])) throw Error("The solution diverged.");
      x = xn;
      // DC solutions take one more (quadratically converging) step once within tolerance.
      if (ok && it > 0) { if (polished) return x; polished = true; }
    }
    return null;
  }
  const rowName = (ckt, r) => (r < ckt.nNodes ? "node " + ckt.names[r] : ckt.branches[r - ckt.nNodes] ? "the branch of " + ckt.branches[r - ckt.nNodes].name : "row " + r);
  // Operating point with gmin stepping and source stepping as fallbacks.
  function operatingPoint(ckt, x0, extra = {}) {
    const opt = ckt.opt, base = {mode: "dc", gmin: opt.gmin, gdiag: opt.gmin, srcScale: 1, polish: true, ...extra};
    let x = newton(ckt, x0 || new Float64Array(ckt.n), {...base}, opt.itl1);
    if (x) return x;
    x = new Float64Array(ckt.n);
    let ok = true;
    for (let g = 1e-2; g >= opt.gmin * 0.99; g /= 10) { const r = newton(ckt, x, {...base, gdiag: g}, opt.itl1); if (!r) { ok = false; break; } x = r; }
    if (ok) { const r = newton(ckt, x, {...base}, opt.itl1); if (r) return r; }
    x = new Float64Array(ckt.n);
    let s = 0, ds = 0.1;
    while (s < 1) {
      const next = Math.min(1, s + ds), r = newton(ckt, x, {...base, srcScale: next}, opt.itl1);
      if (r) { x = r; s = next; ds = Math.min(ds * 2, 0.25); }
      else { ds /= 4; if (ds < 1e-6) break; }
    }
    if (s >= 1) return x;
    throw Error("No DC operating point: Newton iterations did not converge, even with gmin and source stepping.");
  }

  // ------------------------------------------------------------------ analyses
  const sigName = (ckt, r) => (r < ckt.nNodes ? "v(" + ckt.names[r] + ")" : "i(" + ckt.branches[r - ckt.nNodes].name + ")");
  function signals(ckt) { const out = []; for (let r = 0; r < ckt.n; r++) out.push({name: sigName(ckt, r), kind: r < ckt.nNodes ? "v" : "i", re: []}); return out; }
  function push(sig, x) { for (let r = 0; r < sig.length; r++) sig[r].re.push(x[r]); }
  function icForce(ckt, ic) {
    const f = [];
    for (const [k, v] of Object.entries(ic || {})) { const r = ckt.rows.get(k); if (r == null) ckt.warnings.push(".ic names an unknown node " + k + "."); else f.push([r, v]); }
    return f;
  }
  function op(ckt, deck) {
    const x = operatingPoint(ckt, null, {force: icForce(ckt, deck.ic)});
    const nodes = {}, currents = {}, devices = {};
    for (let r = 0; r < ckt.nNodes; r++) nodes[ckt.names[r]] = x[r];
    for (const d of ckt.branches) currents[d.name] = x[d.row];
    finalLoad(ckt, x);
    for (const d of ckt.devices) if (d.info) devices[d.name] = {type: d.letter, model: d.model, ...d.info()};
    return {type: "op", nodes, currents, devices, x: Array.from(x)};
  }
  function finalLoad(ckt, x) {
    const ctx = {mode: "dc", gmin: ckt.opt.gmin, gdiag: ckt.opt.gmin, srcScale: 1, noLimit: true, n: ckt.n, A: new Float64Array(ckt.n * ckt.n), b: new Float64Array(ckt.n), x};
    for (const d of ckt.devices) d.load(ctx);
    return ctx;
  }
  function dc(ckt, an) {
    const src = ckt.byName.get(String(an.source).toLowerCase());
    if (!src || (src.letter !== "V" && src.letter !== "I")) fail(".dc sweeps an independent source; " + an.source + " is not one.");
    const {start, stop} = an; let step = Math.abs(an.step);
    if (![start, stop, step].every(Number.isFinite) || step === 0) fail(".dc needs a non-zero step.");
    const count = Math.floor(Math.abs(stop - start) / step + 1e-9) + 1;
    if (count > 1e5) fail(".dc would take more than 100 000 points.");
    if (count * ckt.n > LIMITS.samples) fail(".dc would store " + count * ckt.n + " samples (limit " + LIMITS.samples + "); sweep fewer points.");
    step *= stop >= start ? 1 : -1;
    const sig = signals(ckt), xs = [];
    let x = null;
    try {
      for (let i = 0; i < count; i++) {
        src.override = start + i * step; xs.push(src.override);
        x = operatingPoint(ckt, x); push(sig, x);
      }
    } finally { src.override = null; }
    return {type: "dc", xName: src.name, x: xs, signals: sig};
  }
  function ac(ckt, an) {
    const {points, fstart, fstop} = an, sweep = an.sweep || "dec";
    if (!(fstart > 0) || !(fstop >= fstart) || !(points >= 1)) fail(".ac needs points >= 1 and 0 < fstart <= fstop.");
    const freqs = [];
    if (sweep === "lin") for (let i = 0; i < points; i++) freqs.push(points === 1 ? fstart : fstart + (fstop - fstart) * i / (points - 1));
    else {
      const per = sweep === "oct" ? Math.log(2) : Math.log(10), total = Math.floor(Math.log(fstop / fstart) / per * points + 1e-9);
      for (let i = 0; i <= total; i++) freqs.push(fstart * Math.exp(i * per / points));
      if (freqs[freqs.length - 1] < fstop * (1 - 1e-9)) freqs.push(fstop);
    }
    if (freqs.length > 1e5) fail(".ac would take more than 100 000 points.");
    if (freqs.length * ckt.n * 2 > LIMITS.samples) fail(".ac would store too many samples; use fewer points.");
    const x0 = operatingPoint(ckt, null), G = finalLoad(ckt, x0).A, n = ckt.n;
    const sig = signals(ckt); for (const s of sig) s.im = [];
    for (const f of freqs) {
      const w = 2 * Math.PI * f, ctx = {n, Ai: new Float64Array(n * n), br: new Float64Array(n), bi: new Float64Array(n)};
      const Ar = Float64Array.from(G);
      // A much smaller shunt than the DC gmin: at a resonator's motional node (|Z| ~ MΩ) 1e-12 S
      // already reads as ohms of extra loss (|Z|²·G), e.g. +4 Ω on a 50 Ω crystal ESR.
      for (let i = 0; i < ckt.nNodes; i++) Ar[i * n + i] += ckt.opt.gmin * 1e-3;
      for (const d of ckt.devices) { if (d.ac) d.ac(ctx, w); if (d.acRhs) d.acRhs(ctx); }
      let r;
      try { r = solveComplex(Ar, ctx.Ai, ctx.br, ctx.bi, n); }
      catch (e) { if (e.message === "singular") fail("The AC matrix is singular at " + eng(f, "Hz") + " near " + rowName(ckt, e.row) + "."); throw e; }
      for (let k = 0; k < n; k++) { sig[k].re.push(r[0][k]); sig[k].im.push(r[1][k]); }
    }
    return {type: "ac", xName: "frequency", x: freqs, signals: sig};
  }
  // Divided-difference estimate of the local truncation error, relative to tolerance.
  function lteRatio(ckt, hist, t, x, order) {
    const pts = hist.slice(-(order + 1)).concat([{t, x}]);
    if (pts.length < order + 2) return 0;
    let worst = 0;
    const h = t - pts[pts.length - 2].t, opt = ckt.opt, rows = ckt.stateRows;
    for (const r of rows) {
      let dd = pts.map(p => p.x[r]);
      const ts = pts.map(p => p.t);
      for (let k = 1; k < dd.length; k++) dd = dd.slice(1).map((v, i) => (v - dd[i]) / (ts[i + k] - ts[i]));
      // trapezoidal: h^3/12 x''' = h^3 * dd3 / 2; backward Euler: h^2/2 x'' = h^2 * dd2.
      const lte = order === 2 ? Math.abs(dd[0]) * h * h * h / 2 : Math.abs(dd[0]) * h * h;
      const prev = pts[pts.length - 2].x[r];
      const tol = opt.reltol * Math.max(Math.abs(x[r]), Math.abs(prev)) + (r < ckt.nNodes ? opt.vntol : opt.abstol) * 10;
      worst = Math.max(worst, lte / tol);
    }
    return worst;
  }
  function tran(ckt, an, deck) {
    const opt = ckt.opt, tstop = an.tstop, tstep = an.tstep, tstart = an.tstart || 0;
    if (!(tstop > 0) || !(tstep > 0) || tstart >= tstop) fail(".tran needs 0 < tstep and tstart < tstop.");
    const tmax = Math.min(an.tmax > 0 ? an.tmax : Infinity, tstep, (tstop - tstart) / 50 || tstep), hmin = tstop * 1e-12;
    const method = /^(be|euler|gear)/i.test(String(an.method || opt.method || "trap")) ? "be" : "trap";
    const uic = !!an.uic;
    let x;
    if (uic) { x = new Float64Array(ckt.n); for (const [r, v] of icForce(ckt, deck.ic)) x[r] = v; }
    else x = operatingPoint(ckt, null, {force: icForce(ckt, deck.ic)});
    for (const d of ckt.devices) if (d.init) d.init(x, uic);
    const bps = new Set([tstop]);
    for (const d of ckt.devices) if (d.spec?.wave) for (const t of breakpoints(d.spec.wave, tstop, tstep)) bps.add(t);
    const bpList = [...bps].sort((a, b) => a - b);
    const sig = signals(ckt), times = [];
    const record = (t, xv) => { if (t >= tstart - hmin) { times.push(t); push(sig, xv); } };
    record(0, x);
    ckt.stateRows = [...Array(ckt.nNodes).keys(), ...ckt.devices.filter(d => d.letter === "L").map(d => d.row)];
    let t = 0, h = Math.min(tmax, (bpList[0] || tstop) / 10), afterBp = true, hist = [{t: 0, x}], bi = 0, rejected = 0, steps = 0;
    const ctxBase = {mode: "tran", gmin: opt.gmin, gdiag: opt.gmin, srcScale: 1, step: tstep, stop: tstop};
    while (t < tstop - hmin) {
      while (bi < bpList.length && bpList[bi] <= t + hmin) bi++;
      const nextBp = bpList[bi] ?? tstop;
      let hit = false;
      if (t + h >= nextBp - hmin) { h = nextBp - t; hit = true; }
      else if (t + 2 * h > nextBp) h = (nextBp - t) / 2; // avoid a sliver step before the breakpoint
      const m = method === "be" || afterBp || hist.length < 2 ? "be" : "trap";
      const ctx = {...ctxBase, t: t + h, h, method: m};
      const xn = newton(ckt, x, ctx, opt.itl4);
      if (!xn) { rejected++; h /= 8; if (h < hmin) fail("Transient analysis failed at t = " + eng(t, "s") + ": the time step became too small."); continue; }
      const order = m === "trap" ? 2 : 1, ratio = afterBp ? 0 : lteRatio(ckt, hist, t + h, xn, order);
      if (ratio > 1 && h > hmin * 10) { rejected++; h *= Math.max(0.2, 0.9 * Math.pow(ratio, -1 / (order + 1))); continue; }
      for (const d of ckt.devices) if (d.accept) d.accept(xn, ctx);
      t = hit ? nextBp : t + h; x = xn; steps++;
      record(t, x);
      if (times.length > 500000) fail("Transient analysis would store more than 500 000 points; raise the step.");
      if (times.length * sig.length > LIMITS.samples) fail("Transient analysis would store more than " + LIMITS.samples.toLocaleString("en") + " samples; raise the step or simulate a smaller circuit.");
      if (hit) { afterBp = true; hist = [{t, x}]; const gap = (bpList[bi + 1] ?? tstop) - t; h = Math.min(h, tmax, gap > 0 ? gap / 10 : tmax); continue; }
      hist.push({t, x}); if (hist.length > 4) hist.shift();
      afterBp = false;
      const grow = ratio > 0 ? Math.min(2, 0.9 * Math.pow(ratio, -1 / (order + 1))) : 2;
      h = Math.min(tmax, h * Math.max(grow, 0.5));
    }
    return {type: "tran", xName: "time", x: times, signals: sig, stats: {steps, rejected}};
  }

  // ------------------------------------------------------------------ entry points
  function simulate(input, analysis, options = {}) {
    const started = Date.now();
    const deck = typeof input === "string" ? parse(input) : input;
    const an = analysis || deck.analyses[0] || {type: "op"};
    const ckt = build(deck, options);
    const o = deck.options;
    ckt.opt = {reltol: num(o.reltol ?? 1e-3), abstol: num(o.abstol ?? 1e-12), vntol: num(o.vntol ?? 1e-6), gmin: num(o.gmin ?? 1e-12),
      itl1: num(o.itl1 ?? 150), itl4: num(o.itl4 ?? 40), method: o.method, ...options.tolerances};
    ckt.iterations = 0;
    let res;
    if (an.type === "op") res = op(ckt, deck);
    else if (an.type === "dc") res = dc(ckt, an);
    else if (an.type === "ac") res = ac(ckt, an);
    else if (an.type === "tran") res = tran(ckt, an, deck);
    else fail("Unknown analysis " + an.type + ".");
    res.analysis = an; res.title = deck.title; res.warnings = ckt.warnings;
    res.nodes = res.nodes || undefined;
    res.stats = {...(res.stats || {}), unknowns: ckt.n, iterations: ckt.iterations, ms: Date.now() - started};
    return res;
  }
  // A signal by name, case-insensitive: "v(out)", "out", "i(v1)", "v(a,b)" (difference).
  function signal(result, name) {
    let s = String(name).trim().toLowerCase();
    const diff = /^v\(\s*([^,\s)]+)\s*,\s*([^)\s]+)\s*\)$/.exec(s);
    if (diff) {
      const a = signal(result, "v(" + diff[1] + ")"), b = diff[2] === "0" ? null : signal(result, "v(" + diff[2] + ")");
      if (!a || (diff[2] !== "0" && !b)) return null;
      return {name: s, kind: "v", re: a.re.map((v, i) => v - (b ? b.re[i] : 0)), im: a.im && a.im.map((v, i) => v - (b ? b.im[i] : 0))};
    }
    if (!/^[vi]\(/.test(s)) s = "v(" + s + ")";
    if (s === "v(0)" || s === "v(gnd)") return {name: s, kind: "v", re: result.x.map(() => 0), im: result.type === "ac" ? result.x.map(() => 0) : undefined};
    return (result.signals || []).find(g => g.name.toLowerCase() === s) || null;
  }
  // Complex helpers for AC results.
  const mag = s => s.re.map((r, i) => Math.hypot(r, s.im ? s.im[i] : 0));
  const db = s => mag(s).map(m => 20 * Math.log10(m || 1e-300));
  function phase(s) { // degrees, unwrapped
    const out = []; let off = 0, prev = null;
    s.re.forEach((r, i) => { let p = Math.atan2(s.im ? s.im[i] : 0, r) * 180 / Math.PI + off; if (prev != null) { while (p - prev > 180) { p -= 360; off -= 360; } while (p - prev < -180) { p += 360; off += 360; } } out.push(p); prev = p; });
    return out;
  }
  // Linear interpolation of y over x at a point (x ascending or descending).
  function at(xs, ys, x) {
    const n = xs.length; if (!n) return NaN;
    const up = xs[n - 1] >= xs[0];
    if (up ? x <= xs[0] : x >= xs[0]) return ys[0];
    if (up ? x >= xs[n - 1] : x <= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if ((xs[mid] <= x) === up) lo = mid; else hi = mid; }
    const f = (x - xs[lo]) / ((xs[hi] - xs[lo]) || 1);
    return ys[lo] + (ys[hi] - ys[lo]) * f;
  }
  const api = {version: "1.0.0", VT, num, eng, parse, simulate, signal, mag, db, phase, at, solveReal, solveComplex};
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof globalThis === "object" && globalThis) globalThis.AtriumSpice = api;
})();
