"use strict";
// AtriumSIEngine: driver → channel → receiver simulation for one routed net.
//
//   plan(input)                 endpoints, models, the channel graph and the cross-sections to solve
//   solveList(plan, opts)       the field-solver geometries the run needs (single lines and, with
//                               crosstalk, coupled pairs), keyed so results can be cached
//   run(plan, solved, opts)     generator: yields {progress, stage} between chunks; returns the result
//   simulate(plan, solved, o)   the same, drained (headless and tests)
//
// input: {nets: [channel records from api.simulation.channel], library: key -> parsed IBIS,
//         assign: {partId: {model, component, pins: {pin: selector choice}}}, driver: "U1.7",
//         generic: {vcc, ron, rise, ccomp}, ideal: {rs, v0, v1, rise} (an ideal source driver)}
// Line parameters come from the field solver per cross-section (Z0, delay per mm, and R and G per
// mm at the edge's knee frequency 0.35/tr for lossy runs). A line shorter than one time step
// becomes a lumped pi section (L = Z0·Td, C = Td/Z0).
(function () {
  // Extension code sees no globalThis (the sandbox shadows it); headless hosts load the files as globals.
  const req = name => (typeof require === "function" ? require(name) : null);
  const G = typeof globalThis === "object" && globalThis ? globalThis : {};
  const S = G.AtriumSISolver || req("./solver.js");
  const IB = G.AtriumIBIS || req("./ibis.js");
  const CH = G.AtriumSIChannel || req("./channel.js");
  const GND = -1, C0 = 299.792458; // mm/ns
  const NP = 8.685889638; // dB per neper
  const CORNERS = ["typ", "min", "max"];
  const DEFAULT_LIMITS = Object.freeze({overshootPct: 15, undershootPct: 15, ringbackV: 0, crosstalkPct: 5, settleNs: null});

  const isPassive = p => /^(R|C|L|FB|RN|RP|CN|LN)\d/i.test(p.ref || "") && p.pins.length === 2;
  const kindOf = p => { const k = String(p.ref || "").match(/^[A-Za-z]+/)?.[0].toUpperCase() || ""; return k === "FB" ? "L" : k[0]; };

  // Nets reached through two-pin series parts (to fetch before planning).
  function seriesNets(rec, have = []) {
    const out = [];
    for (const p of rec.parts || []) {
      if (!isPassive(p)) continue;
      const on = p.pins.filter(x => x.net === rec.net), other = p.pins.find(x => x.net !== rec.net);
      if (on.length === 1 && other?.net && !CH.isRail(other.net) && !have.includes(other.net) && !out.includes(other.net)) out.push(other.net);
    }
    return out;
  }

  // ------------------------------------------------------------------ plan
  function plan(input) {
    const recs = input.nets || [input];
    if (!recs.length || !recs[0]) throw Error("No routed net to simulate.");
    const names = new Set(recs.map(r => r.net));
    const g = CH.graph({nets: recs});
    const warnings = [...g.warnings];
    if (!g.edges.some(e => e.kind === "track")) throw Error("Net " + recs[0].net + " has no routed tracks.");
    for (const p of g.unrouted) warnings.push("Pin " + p.ref + "." + p.pin + " (" + p.net + ") is not reached by the routing and is left out.");
    const padNode = new Map(g.pads.filter(p => p.nodeId !== undefined).map(p => [p.part + "/" + p.pin, p.nodeId]));
    const parts = new Map();
    for (const r of recs) for (const p of r.parts || []) if (!parts.has(p.id)) parts.set(p.id, p);
    const series = [], shunts = [], endpoints = [];
    for (const p of parts.values()) {
      const pins = p.pins.filter(x => names.has(x.net) && padNode.has(p.id + "/" + x.pin));
      if (!pins.length) continue;
      if (isPassive(p)) {
        const kind = kindOf(p), val = CH.value(p.value);
        const other = p.pins.find(x => !pins.includes(x));
        if (pins.length === 2) {
          if (!(val > 0) && !(kind === "R" && val === 0)) { warnings.push(p.ref + " (" + (p.value || "no value") + ") has no usable value; it is treated as a short."); }
          series.push({part: p, kind, value: val, a: padNode.get(p.id + "/" + pins[0].pin), b: padNode.get(p.id + "/" + pins[1].pin)});
        } else if (other && CH.isRail(other.net)) {
          shunts.push({part: p, kind, value: val, node: padNode.get(p.id + "/" + pins[0].pin), rail: other.net, v: CH.railVoltage(other.net)});
        } else warnings.push(p.ref + " connects " + pins[0].net + " to " + (other?.net || "nothing") + ", which is not simulated; it is left out.");
        continue;
      }
      for (const pin of pins) endpoints.push({part: p, ref: p.ref, pin: pin.pin, name: pin.name, net: pin.net, node: padNode.get(p.id + "/" + pin.pin), x: pin.x, y: pin.y});
    }
    endpoints.sort((a, b) => a.ref.localeCompare(b.ref, undefined, {numeric: true}) || String(a.pin).localeCompare(String(b.pin), undefined, {numeric: true}));
    if (!endpoints.length) throw Error("Net " + recs[0].net + " has no component pins to drive or receive (only passives).");
    // Models.
    for (const e of endpoints) {
      const a = input.assign?.[e.part.id];
      e.source = "generic";
      if (a && a.model) {
        const ibis = input.library?.(a.model);
        if (!ibis) warnings.push(e.ref + ": the IBIS file " + (a.name || a.model) + " is not in the project; a generic model is used.");
        else {
          let pm = null;
          try { pm = IB.pinModel(ibis, a.component, e.pin, {choice: a.pins?.[e.pin]}); } catch (err) { warnings.push(e.ref + ": " + err.message); }
          if (!pm && e.name) { const c = IB.component(ibis, a.component); const hit = c && [...c.pins.values()].find(x => x.signal.toLowerCase() === String(e.name).toLowerCase()); if (hit) pm = IB.pinModel(ibis, a.component, hit.pin, {choice: a.pins?.[e.pin]}); }
          if (!pm) warnings.push(e.ref + "." + e.pin + " is not in IBIS component " + (a.component || "") + "; a generic model is used.");
          else if (pm.special) { e.special = pm.special; }
          else if (!pm.model) warnings.push(e.ref + "." + e.pin + ": model " + pm.pin.model + " is missing; a generic model is used.");
          else { e.ibis = ibis; e.model = pm.model; e.pinModel = pm; e.component = a.component; e.file = a.name || a.model; e.source = "ibis"; }
        }
      }
      // Unassigned pins get a generic I/O buffer (it can drive, e.g. a connector fed from off-board).
      if (!e.model) e.model = IB.generic({...(input.generic || {}), type: "i/o"});
      e.canDrive = IB.DRIVERS.has(e.model.type);
    }
    const live = endpoints.filter(e => !e.special);
    let driver = null;
    if (input.driver) {
      const [ref, pin] = String(input.driver).split(".");
      driver = live.find(e => e.ref === ref && (pin == null || String(e.pin) === pin));
      if (!driver) throw Error("Driver " + input.driver + " is not a pin on " + [...names].join(", ") + ".");
    }
    if (!driver) driver = live.find(e => e.source === "ibis" && /^(output|3-state|output_ecl|3-state_ecl)$/.test(e.model.type))
      || live.find(e => e.source === "ibis" && e.canDrive) || live.find(e => e.canDrive && /^U|^IC/i.test(e.ref)) || live.find(e => e.canDrive);
    if (!driver) throw Error("No pin on the net can drive it. Assign an output or I/O IBIS model, or choose the driver.");
    const receivers = live.filter(e => e !== driver);
    return {nets: [...names], net: recs[0].net, graph: g, endpoints, driver, receivers, series, shunts, warnings, ideal: input.ideal || null, generic: input.generic || {}};
  }

  // Edge time (s) of the driver at a corner: 10-90 % of the pullup coefficient.
  function edgeTime(b) {
    const e = b.edges?.rise;
    if (!e) return 1e-9;
    const cross = lvl => { for (let i = 1; i < e.t.length; i++) if (e.ku[i] >= lvl) { const f = (lvl - e.ku[i - 1]) / ((e.ku[i] - e.ku[i - 1]) || 1); return e.t[i - 1] + f * (e.t[i] - e.t[i - 1]); } return e.t[e.t.length - 1]; };
    return Math.max(10e-12, cross(0.9) - cross(0.1));
  }
  function buffers(p, corner) {
    const map = new Map();
    for (const e of p.endpoints) if (!e.special) map.set(e, IB.buffer(e.model, corner, {vcc: p.generic.vcc}));
    return map;
  }

  // ------------------------------------------------------------------ field-solver jobs
  function solveList(p, opts = {}) {
    const corners = opts.corners || ["typ"];
    let tr = Infinity;
    if (p.ideal) tr = p.ideal.rise || 1e-10;
    else for (const c of corners) tr = Math.min(tr, edgeTime(IB.buffer(p.driver.model, c, {vcc: p.generic.vcc})));
    const fGHz = Math.min(20, Math.max(0.05, 0.35 / tr / 1e9));
    p.tr = tr; p.fGHz = fGHz;
    const jobs = new Map();
    for (const x of CH.crossSections(p.graph)) if (x.geometry) jobs.set(x.key, {key: x.key, geometry: x.geometry, layer: x.layer, width: x.width, fGHz: opts.loss === false ? undefined : Math.round(fGHz * 1000) / 1000});
    p.missing = CH.crossSections(p.graph).filter(x => !x.geometry).map(x => x.layer);
    p.victims = [];
    if (opts.crosstalk && opts.crosstalk.enabled !== false) {
      const rec = p.graph.recs[0];
      const list = CH.coupling(rec, {maxGap: opts.crosstalk.maxGap ?? 0.5, minLength: opts.crosstalk.minLength ?? 1}).filter(v => !p.nets.includes(v.net)).slice(0, opts.crosstalk.maxVictims ?? 4);
      for (const v of list) {
        const key = CH.xsKey(v.layer, v.width, v.gap), geom = CH.solverGeometry(p.graph.stackup, v.layer, v.width, v.gap);
        if (!geom) continue;
        v.key = key; p.victims.push(v);
        if (!jobs.has(key)) jobs.set(key, {key, geometry: geom, coupled: true, quality: "fast"});
      }
    }
    return [...jobs.values()];
  }
  // Line parameters per mm from a field-solver result.
  function lineParams(r, loss) {
    if (!r || r.ok === false) return null;
    const z = r.z0 ?? r.z, d = r.delay; // ps/mm
    const R = loss ? 2 * z * ((r.alpha_c || 0) / NP) : 0, G = loss ? 2 * ((r.alpha_d || 0) / NP) / z : 0;
    return {z, delay: d * 1e-12, R, G};
  }
  const FALLBACK_Z = 100, FALLBACK_DELAY = 6.6e-12; // no reference plane: an estimate only

  // ------------------------------------------------------------------ circuit
  // o: {corner, buffers, dt, stim: {edges: [{t, rise}]}, couple: victim, seriesR, parallel: {r, v}, solved, loss, refload}
  function build(p, o) {
    const S0 = S, c = new S0.Circuit(), g = p.graph;
    const node = g.nodes.map(nd => c.node("n" + nd.id + (nd.pads.length ? ":" + nd.pads[0] : "")));
    const dt = o.dt, info = {lines: [], vias: [], lumped: 0, sections: 0};
    const er = g.stackup?.er || 4.2, clear = g.recs[0].clearance ?? 0.25;
    let dist = null;
    const couple = o.couple || null;
    if (couple) dist = CH.distances(g, p.driver.node);
    const line = (a, b, z, td, R, G, tag, len) => {
      if (td < dt) {
        // Lumped pi section.
        const L = z * td, C = td / z;
        c.C(a, GND, C / 2, tag); c.C(b, GND, C / 2, tag);
        if (R > 0) { const m = c.node(tag + ":r"); c.R(a, m, R, tag); c.L(m, b, L, tag); } else c.L(a, b, L, tag);
        if (G > 0) { c.R(a, GND, 2 / G, tag); c.R(b, GND, 2 / G, tag); }
        info.lumped++;
        return;
      }
      if (!(R > 0.002 * z) && !(G * z > 0.002)) { c.T(a, b, z, td, tag); info.sections++; return; }
      const k = Math.max(1, Math.min(6, Math.ceil(R / (0.1 * z)), Math.floor(td / dt)));
      const rs = R / k, gs = G / k;
      // a -R/2- [T] -R- [T] - … -R/2- b, with the shunt conductance after each section.
      let prev = a;
      for (let i = 0; i < k; i++) {
        const x = c.node(tag + ":s" + i), y = c.node(tag + ":t" + i);
        c.R(prev, x, (i ? rs : rs / 2) || 1e-6, tag);
        c.T(x, y, z, td / k, tag); info.sections++;
        if (gs > 0) c.R(y, GND, 1 / gs, tag);
        prev = y;
      }
      c.R(prev, b, rs / 2 || 1e-6, tag);
    };
    for (const e of g.edges) {
      if (e.kind === "track") {
        const key = CH.xsKey(e.layer, e.width, null, e.profile), lp = lineParams(o.solved.get(key), o.loss);
        const z = lp?.z ?? FALLBACK_Z, d = lp?.delay ?? FALLBACK_DELAY, td = e.length * d;
        const tag = "L" + info.lines.length;
        info.lines.push({layer: e.layer, width: e.width, length: e.length, z, delayPs: d * 1e12 * e.length, coupled: e.coupled, fallback: !lp, tracks: [...new Set(e.segs.map(s => s.track))]});
        if (couple && e.coupled) {
          const cp = o.solved.get(couple.key);
          if (cp && cp.ok !== false && cp.zodd > 0 && cp.zeven > 0) {
            const [n1, f1] = dist[e.a] <= dist[e.b] ? [node[e.a], node[e.b]] : [node[e.b], node[e.a]];
            const vn = c.node("victim-near"), vf = c.node("victim-far");
            const te = e.length * Math.sqrt(cp.eeffEven) / C0 * 1e-9, to = e.length * Math.sqrt(cp.eeffOdd) / C0 * 1e-9;
            const zt = o.victimTermination > 0 ? o.victimTermination : Math.sqrt(cp.zodd * cp.zeven);
            if (Math.min(te, to) >= dt) {
              c.T2(n1, f1, vn, vf, cp.zeven, cp.zodd, te, to, tag);
              c.R(vn, GND, zt, "victim near"); c.R(vf, GND, zt, "victim far");
              info.victim = {near: vn, far: vf, zt, ze: cp.zeven, zo: cp.zodd, te, to, length: e.length};
              continue;
            }
            info.victimTooShort = true;
          }
        }
        line(node[e.a], node[e.b], z, td, lp ? lp.R * e.length : 0, lp ? lp.G * e.length : 0, tag, e.length);
      } else if (e.kind === "via" || e.kind === "stub") {
        const v = e.via, d1 = v.diameter || (v.drill || 0.3) + 0.3, d2 = d1 + 2 * clear;
        const L = CH.viaL(e.length, v.drill || 0.3), C = CH.viaC(e.length, d1, d2, er);
        if (e.kind === "via") { c.C(node[e.a], GND, C / 2, "via"); c.C(node[e.b], GND, C / 2, "via"); c.L(node[e.a], node[e.b], L, "via"); }
        else { const s = c.node("stub"); c.L(node[e.a], s, L, "stub"); c.C(s, GND, C, "stub"); }
        info.vias.push({id: v.id, kind: e.kind, from: e.from, to: e.to, side: e.side, length: e.length, L, C});
      }
    }
    for (const s of p.series) {
      if (s.kind === "C" && s.value > 0) { c.C(node[s.a], node[s.b], s.value, s.part.ref); c.R(node[s.a], node[s.b], 1e9, s.part.ref); }
      else if (s.kind === "L" && s.value > 0) c.L(node[s.a], node[s.b], s.value, s.part.ref);
      else c.R(node[s.a], node[s.b], s.value > 0 ? s.value : 1e-3, s.part.ref);
    }
    const db = o.buffers.get(p.driver), vcc = db?.vcc ?? p.generic.vcc ?? 3.3;
    for (const s of p.shunts) {
      const rail = s.v ?? (/VTT|VREF/i.test(s.rail) ? vcc / 2 : vcc);
      if (s.kind === "R" && s.value > 0) c.V(node[s.node], s.value, () => rail, s.part.ref);
      else if (s.kind === "C" && s.value > 0) c.C(node[s.node], GND, s.value, s.part.ref);
    }
    // Endpoints: package, die, buffer.
    const probes = new Map();
    for (const e of p.endpoints) {
      if (e.special) continue;
      let pad = node[e.node];
      if (e === p.driver && o.seriesR > 0) { const q = c.node("series-R"); c.R(q, pad, o.seriesR, "what-if series R"); pad = q; }
      if (e !== p.driver && o.parallel && o.parallel.r > 0 && (!o.parallel.ref || o.parallel.ref === e.ref)) c.V(node[e.node], o.parallel.r, () => o.parallel.v ?? 0, "what-if parallel R");
      const pkg = e.pinModel?.pkg || {R: 0, L: 0, C: 0}, pkgc = e.ibis && o.corner !== "typ" ? (IB.pinModel(e.ibis, e.component, e.pinModel.pin.pin, {corner: o.corner, choice: e.pinModel.choice})?.pkg || pkg) : pkg;
      let die = pad;
      if (pkgc.C > 0) c.C(pad, GND, pkgc.C, "C_pkg");
      if (pkgc.R > 0 || pkgc.L > 0) {
        die = c.node(e.ref + "." + e.pin + ":die");
        if (pkgc.L > 0) { const m = pkgc.R > 0 ? c.node("pkg") : die; if (pkgc.R > 0) c.R(pad, m, pkgc.R, "R_pkg"); c.L(m, die, pkgc.L, "L_pkg"); }
        else c.R(pad, die, pkgc.R, "R_pkg");
      }
      const b = o.buffers.get(e);
      if (e === p.driver && p.ideal) {
        const id = p.ideal, r = id.rise || 1e-10;
        c.V(pad, id.rs || 1e-3, t => idealWave(o.stim, id, t), "ideal source");
        probes.set(e, {pad: node[e.node], die: pad});
        continue;
      }
      if (b.ccomp > 0) c.C(die, GND, b.ccomp, "C_comp");
      if (e === p.driver) c.D(die, driverDevice(b, o.stim), e.ref + "." + e.pin);
      else if (b.pc !== undefined) c.D(die, {i: v => b.current(v, 0, 0)}, e.ref + "." + e.pin);
      probes.set(e, {pad: node[e.node], die});
    }
    return {c, probes, info};
  }
  function idealWave(stim, id, t) {
    if (stim.static) return stim.static === "high" ? id.v1 : id.v0;
    let v = stim.edges[0]?.rise === false ? id.v1 : id.v0;
    for (const e of stim.edges) {
      if (t < e.t) break;
      const f = Math.min(1, (t - e.t) / (id.rise || 1e-10));
      v = e.rise ? id.v0 + (id.v1 - id.v0) * f : id.v1 + (id.v0 - id.v1) * f;
      if (f < 1) break;
    }
    return v;
  }
  // The driver as a time-varying device. stim.edges: [{t, rise}] (or a static state {static: "high"|"low"}).
  function driverDevice(b, stim) {
    const tab = (e, tau) => {
      const t = e.t, n = t.length;
      if (tau <= t[0]) return [e.ku[0], e.kd[0]];
      if (tau >= t[n - 1]) return [e.ku[n - 1], e.kd[n - 1]];
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] > tau) hi = m; else lo = m; }
      const f = (tau - t[lo]) / (t[hi] - t[lo]);
      return [e.ku[lo] + (e.ku[hi] - e.ku[lo]) * f, e.kd[lo] + (e.kd[hi] - e.kd[lo]) * f];
    };
    const K = t => {
      if (stim.static) return stim.static === "high" ? [1, 0] : [0, 1];
      let k = stim.edges[0]?.rise === false ? [1, 0] : [0, 1];
      for (const e of stim.edges) { if (t < e.t) break; k = tab(e.rise ? b.edges.rise : b.edges.fall, t - e.t); }
      return k;
    };
    return {i: (v, t) => { const [ku, kd] = K(t); return b.current(v, ku, kd); }};
  }

  // ------------------------------------------------------------------ stimulus and timing
  function stimulus(o, tr, span) {
    const s = o.stimulus || {}, start = s.delay ?? 0.2e-9, type = s.type || "rise";
    if (type === "fall") return {type, edges: [{t: start, rise: false}]};
    if (type === "pulse") { const w = s.width ?? Math.max(4 * tr, span / 2); return {type, edges: [{t: start, rise: true}, {t: start + w, rise: false}], width: w}; }
    if (type === "clock") {
      const period = 1 / (s.freq || 100e6), edges = [];
      for (let k = 0, t = start; k < 400 && t < span; k++, t += period / 2) edges.push({t, rise: k % 2 === 0});
      return {type, edges, period};
    }
    return {type: "rise", edges: [{t: start, rise: true}]};
  }

  // ------------------------------------------------------------------ run
  function* run(p, solved, opts = {}) {
    const corners = (opts.corners || ["typ"]).filter(c => CORNERS.includes(c));
    const loss = opts.loss !== false, limits = {...DEFAULT_LIMITS, ...(opts.limits || {})};
    const started = Date.now();
    const warnings = [...p.warnings];
    if (p.tr === undefined) solveList(p, opts);
    if (p.missing?.length) warnings.push("No reference plane next to " + [...new Set(p.missing)].join(", ") + ": " + FALLBACK_Z + " Ω and " + FALLBACK_DELAY * 1e12 + " ps/mm are assumed there.");
    for (const [k, r] of solved) if (r && r.ok === false) warnings.push("The field solver failed for " + k + ": " + (r.error || "no result") + ".");
    // Time step: a fraction of the fastest edge; the stop time covers the round trips.
    const tr = p.tr || 1e-9;
    let dt = opts.dt || Math.min(20e-12, Math.max(0.25e-12, tr / 30));
    for (const v of p.victims || []) {
      const cp = solved.get(v.key);
      if (cp?.eeffOdd) { const t = Math.min(v.longest, v.length) * Math.sqrt(Math.min(cp.eeffOdd, cp.eeffEven)) / C0 * 1e-9; if (t > 0 && t < dt && t > 0.25e-12) dt = t; }
    }
    let flight = 0;
    for (const e of p.graph.edges) if (e.kind === "track") flight += e.length * (lineParams(solved.get(CH.xsKey(e.layer, e.width, null, e.profile)), false)?.delay ?? FALLBACK_DELAY);
    const edgeLen = Math.max(...corners.map(c => { const b = p.ideal ? null : IB.buffer(p.driver.model, c, {vcc: p.generic.vcc}); const e = b?.edges?.rise; return e ? e.t[e.t.length - 1] : tr; }));
    let tstop = opts.tstop || Math.min(100e-9, Math.max(3e-9, 0.2e-9 + edgeLen + 12 * flight + 2e-9));
    const stim = stimulus(opts, tr, tstop);
    if (stim.type === "pulse" && !opts.tstop) tstop = Math.min(200e-9, stim.edges[1].t + edgeLen + 12 * flight + 2e-9);
    if (stim.type === "clock" && !opts.tstop) tstop = Math.min(200e-9, 0.2e-9 + 3 * stim.period);
    if (stim.type === "clock") stim.edges = stim.edges.filter(e => e.t < tstop);
    const out = {net: p.net, nets: p.nets, corners, dt, tstop, tr, fGHz: p.fGHz, stimulus: {type: stim.type, edges: stim.edges.map(e => ({t: e.t, rise: e.rise})), period: stim.period},
      driver: describe(p.driver), receivers: p.receivers.map(describe), waves: [], metrics: [], crosstalk: [], violations: [], warnings, channel: null, stats: {corners: {}}};
    const probeList = [p.driver, ...p.receivers];
    for (let ci = 0; ci < corners.length; ci++) {
      const corner = corners[ci], bufs = buffers(p, corner);
      for (const b of bufs.values()) for (const w of b.warnings) if (!warnings.includes(w)) warnings.push(w);
      const B = build(p, {corner, buffers: bufs, dt, stim, solved, loss, seriesR: opts.seriesR, parallel: opts.parallel});
      if (!out.channel) out.channel = {lines: B.info.lines, vias: B.info.vias, lumped: B.info.lumped, sections: B.info.sections,
        series: p.series.map(s => ({ref: s.part.ref, kind: s.kind, value: s.value})), shunts: p.shunts.map(s => ({ref: s.part.ref, kind: s.kind, value: s.value, rail: s.rail}))};
      const nodes = probeList.map(e => B.probes.get(e)?.pad ?? -1);
      const gen = S.run(B.c, {dt, tstop, probes: nodes, chunk: 1500});
      let r;
      for (;;) { const x = gen.next(); if (x.done) { r = x.value; break; } yield {stage: "simulate " + corner, progress: (ci + x.value.progress) / (corners.length + 1)}; }
      out.stats.corners[corner] = r.stats;
      if (!out.t) out.t = r.t;
      probeList.forEach((e, j) => out.waves.push({corner, probe: e.ref + "." + e.pin, role: e === p.driver ? "driver" : "receiver", v: r.v[j]}));
      // Settled levels: DC with the driver held low and held high.
      const levels = {};
      for (const st of ["low", "high"]) {
        const D = build(p, {corner, buffers: bufs, dt, stim: {static: st, edges: []}, solved, loss, seriesR: opts.seriesR, parallel: opts.parallel});
        const v = S.dc(D.c);
        levels[st] = probeList.map(e => v[D.probes.get(e).pad]);
      }
      // Timing reference: the driver into its IBIS reference load (Rref, Cref, Vref) at Vmeas.
      const db = bufs.get(p.driver);
      const tref = p.ideal ? null : referenceTimes(db, stim, dt);
      if (tref && (tref.rise == null || tref.fall == null)) { const w = "The driver's reference load (Rref, Cref, Vref) never reaches Vmeas at " + corner + "; flight times there are measured from the start of the edge."; if (!warnings.includes(w)) warnings.push(w); }
      probeList.forEach((e, j) => {
        const bt = bufs.get(e) || db, id = p.ideal;
        // An ideal source has no IBIS thresholds: 30/70 % of the source swing, Vmeas at mid-swing of each probe.
        const th = id ? {vinl: opts.vinl ?? id.v0 + 0.3 * (id.v1 - id.v0), vinh: opts.vinh ?? id.v0 + 0.7 * (id.v1 - id.v0), vmeas: (levels.low[0] + levels.high[0]) / 2}
          : {vinl: opts.vinl ?? bt?.thresholds.vinl, vinh: opts.vinh ?? bt?.thresholds.vinh, vmeas: db?.thresholds.vmeas ?? 1.65};
        stim.edges.forEach((ed, k) => {
          if (stim.type === "clock" && k > 3) return;
          const t1 = stim.edges[k + 1]?.t ?? tstop;
          const m = S.measure(r.t, r.v[j], {edge: ed.rise ? "rise" : "fall", t0: ed.t, t1, vlow: levels.low[j], vhigh: levels.high[j], vinl: th.vinl, vinh: th.vinh, vmeas: th.vmeas,
            tref: tref && (ed.rise ? tref.rise : tref.fall) != null ? ed.t + (ed.rise ? tref.rise : tref.fall) : undefined, settle: opts.settleBand ?? 0.05});
          const vm = id ? k => (levels.low[k] + levels.high[k]) / 2 : () => th.vmeas;
          const drvMeas = j === 0 ? null : S.crossings(r.t, r.v[0], vm(0), ed.rise ? 1 : -1, ed.t)[0];
          const rxMeas = S.crossings(r.t, r.v[j], vm(j), ed.rise ? 1 : -1, ed.t)[0];
          out.metrics.push({corner, probe: e.ref + "." + e.pin, ref: e.ref, partId: e.part.id, role: j === 0 ? "driver" : "receiver", edge: m.edge, edgeIndex: k, ...m,
            vinl: th.vinl, vinh: th.vinh, vmeas: th.vmeas, delay: drvMeas != null && rxMeas != null ? rxMeas - drvMeas : null, x: e.x, y: e.y});
        });
      });
    }
    // Crosstalk on the fastest corner.
    if (p.victims?.length && !opts.noCrosstalk) {
      const corner = corners.includes("max") ? "max" : corners[0], bufs = buffers(p, corner);
      const stimX = {type: "rise", edges: [{t: 0.2e-9, rise: true}]};
      let k = 0;
      for (const v of p.victims) {
        const cp = solved.get(v.key);
        if (!cp || cp.ok === false) continue;
        const seg = p.graph.recs[0].tracks.find(t => t.id === v.track), pts = seg?.points;
        const segLen = pts ? Math.hypot(pts[v.seg + 1][0] - pts[v.seg][0], pts[v.seg + 1][1] - pts[v.seg][1]) : v.longest;
        const want = Math.min(v.length, segLen), from = Math.max(0, Math.min(v.from, segLen - want));
        const pg = {...p, graph: CH.graph({nets: p.graph.recs}, {couple: {track: v.track, seg: v.seg, from, to: from + want}})};
        const pads = new Map(pg.graph.pads.filter(x => x.nodeId !== undefined).map(x => [x.part + "/" + x.pin, x.nodeId]));
        pg.endpoints = p.endpoints.map(e => ({...e, node: pads.get(e.part.id + "/" + e.pin)}));
        const remap = e => pg.endpoints[p.endpoints.indexOf(e)];
        pg.driver = remap(p.driver); pg.receivers = p.receivers.map(remap);
        pg.series = p.series.map(s => ({...s, a: pads.get(s.part.id + "/" + s.part.pins[0].pin), b: pads.get(s.part.id + "/" + s.part.pins[1].pin)}));
        pg.shunts = p.shunts.map(s => ({...s, node: pads.get(s.part.id + "/" + s.part.pins.find(x => pg.nets.includes(x.net)).pin)}));
        const bmap = new Map(); for (const [e, b] of bufs) bmap.set(remap(e), b);
        const B = build(pg, {corner, buffers: bmap, dt, stim: p.ideal ? opts.xstim || stimX : stimX, solved, loss, couple: v, victimTermination: opts.crosstalk?.termination});
        if (!B.info.victim) { warnings.push("The coupled run with " + v.net + " is too short to simulate with this time step."); continue; }
        const r = S.simulate(B.c, {dt, tstop, probes: [B.info.victim.near, B.info.victim.far, B.probes.get(pg.driver).pad]});
        const next = S.peak(r.t, r.v[0]), fext = S.peak(r.t, r.v[1]);
        const swing = Math.abs((r.v[2][r.v[2].length - 1]) - r.v[2][0]) || 1;
        // Closed-form screening values for comparison (weak coupling, matched victim).
        const ze = cp.zeven, zo = cp.zodd, kb = (ze - zo) / (2 * (ze + zo));
        const dTd = Math.abs(Math.sqrt(cp.eeffOdd) - Math.sqrt(cp.eeffEven)) * B.info.victim.length / C0 * 1e-9;
        out.crosstalk.push({victim: v.net, layer: v.layer, length: v.length, simulatedLength: B.info.victim.length, gap: v.gap, runs: v.runs.length, zeven: ze, zodd: zo,
          next: next.v, tNext: next.t, fext: fext.v, tFext: fext.t, nextPct: 100 * Math.abs(next.v) / swing, fextPct: 100 * Math.abs(fext.v) / swing, kb, dTdPs: dTd * 1e12, corner, termination: B.info.victim.zt});
        yield {stage: "crosstalk", progress: (corners.length + (++k) / p.victims.length) / (corners.length + 1)};
      }
    }
    // Violations.
    for (const m of out.metrics) {
      if (m.role !== "receiver") continue;
      const at = m.probe + " (" + m.corner + ", " + m.edge + ")";
      const row = (cls, text) => out.violations.push({class: cls, text: "Net " + p.net + ": " + text + " at " + at + ".", probe: m.probe, partId: m.partId, point: m.x != null ? [m.x, m.y] : null, corner: m.corner});
      if (m.overshootPct > limits.overshootPct) row("Warning", "overshoot " + fmt(m.overshoot, "V") + " (" + m.overshootPct.toFixed(1) + " % of the swing)");
      if (m.swing && 100 * m.undershoot / Math.abs(m.swing) > limits.undershootPct) row("Warning", "undershoot " + fmt(m.undershoot, "V"));
      if (!m.reachesVinh) row("Error", "the signal does not cross " + (m.edge === "rise" ? "Vinh " + fmt(m.vinh, "V") : "Vinl " + fmt(m.vinl, "V")));
      else if (m.ringback != null && m.ringback < limits.ringbackV) row("Error", "ringback re-enters the threshold region by " + fmt(-m.ringback, "V"));
      if (!m.monotonic) row("Warning", "the edge is not monotonic between Vinl and Vinh");
      if (limits.settleNs != null && (m.settle == null || m.settle > limits.settleNs * 1e-9)) row("Warning", m.settle == null ? "the signal does not settle" : "settling takes " + fmt(m.settle, "s"));
    }
    for (const x of out.crosstalk) if (Math.max(x.nextPct, x.fextPct) > limits.crosstalkPct)
      out.violations.push({class: "Warning", text: "Net " + p.net + " couples into " + x.victim + ": NEXT " + fmt(x.next, "V") + ", FEXT " + fmt(x.fext, "V") + " (" + Math.max(x.nextPct, x.fextPct).toFixed(1) + " % of the swing).", probe: x.victim, partId: null, point: null});
    out.stats.ms = Date.now() - started;
    return out;
  }
  function describe(e) {
    return {ref: e.ref, pin: e.pin, name: e.name, partId: e.part.id, model: e.model?.name, type: e.model?.type, source: e.source, component: e.component || null, file: e.file || null, x: e.x, y: e.y};
  }
  // Times from each edge's start to Vmeas into the reference load (or 50 Ω to the mid rail).
  function referenceTimes(b, stim, dt) {
    if (!b?.edges) return null;
    const out = {};
    for (const rise of [true, false]) {
      const c = new S.Circuit(), d = c.node("die");
      if (b.ccomp > 0) c.C(d, GND, b.ccomp);
      const vref = b.thresholds.vref ?? (b.vcc + b.vgnd) / 2, rref = b.thresholds.rref > 0 ? b.thresholds.rref : 50;
      c.V(d, rref, () => vref);
      if (b.thresholds.cref > 0) c.C(d, GND, b.thresholds.cref);
      c.D(d, driverDevice(b, {edges: [{t: 0, rise}]}));
      const e = rise ? b.edges.rise : b.edges.fall, span = (e.t[e.t.length - 1] || 1e-9) * 1.5 + 1e-9;
      const r = S.simulate(c, {dt: Math.min(dt, span / 400), tstop: span, probes: [d]});
      out[rise ? "rise" : "fall"] = S.crossings(r.t, r.v[0], b.thresholds.vmeas, rise ? 1 : -1)[0] ?? null;
    }
    return out;
  }
  const fmt = (x, u) => {
    if (x == null || !Number.isFinite(x)) return "—";
    const a = Math.abs(x);
    const [k, pfx] = a === 0 ? [1, ""] : a >= 1 ? [1, ""] : a >= 1e-3 ? [1e3, "m"] : a >= 1e-6 ? [1e6, "µ"] : a >= 1e-9 ? [1e9, "n"] : [1e12, "p"];
    return String(Number((x * k).toPrecision(3))) + " " + pfx + u;
  };

  function simulate(p, solved, opts) {
    const g = run(p, solved, opts);
    for (;;) { const r = g.next(); if (r.done) return r.value; }
  }

  // ------------------------------------------------------------------ termination sweeps
  // Score: the worst of overshoot, undershoot and ringback (as % of the swing) over the receivers,
  // with a large penalty when a receiver misses a threshold or the edge is not monotonic.
  function score(res) {
    let worst = 0, bad = false;
    for (const m of res.metrics) {
      if (m.role !== "receiver") continue;
      const sw = Math.abs(m.swing) || 1;
      worst = Math.max(worst, m.overshootPct, 100 * m.undershoot / sw);
      if (!m.reachesVinh || (m.ringback != null && m.ringback < 0)) bad = true;
      if (!m.monotonic) worst += 10;
    }
    return bad ? 1000 + worst : worst;
  }
  function* sweep(p, solved, opts = {}) {
    const kind = opts.kind || "series";
    const values = opts.values || (kind === "series" ? [0, 5, 10, 15, 20, 22, 27, 33, 39, 47, 56, 68, 82, 100] : [0, 330, 220, 150, 100, 75, 68, 50, 39]);
    const base = {...opts.sim, corners: ["typ"], noCrosstalk: true};
    const rows = [];
    let k = 0;
    for (const v of values) {
      const o = kind === "series" ? {...base, seriesR: v} : {...base, parallel: v > 0 ? {r: v, v: opts.vterm ?? 0} : null};
      const res = simulate(p, solved, o);
      const rx = res.metrics.filter(m => m.role === "receiver" && m.edgeIndex === 0);
      const worst = (f, d = 0) => rx.reduce((a, m) => Math.max(a, f(m) ?? d), -Infinity);
      rows.push({value: v, score: score(res), overshootPct: worst(m => m.overshootPct), undershootPct: worst(m => 100 * m.undershoot / (Math.abs(m.swing) || 1)),
        ringback: rx.reduce((a, m) => Math.min(a, m.ringback ?? Infinity), Infinity), delay: worst(m => m.delay, 0), settle: worst(m => m.settle ?? Infinity, 0),
        monotonic: rx.every(m => m.monotonic), reaches: rx.every(m => m.reachesVinh), swing: rx.reduce((a, m) => Math.min(a, Math.abs(m.swing)), Infinity)});
      yield {stage: "sweep", progress: ++k / values.length};
    }
    // Best: lowest score; among values within 1 percentage point of it, the fastest settling.
    const ok = rows.filter(r => r.score < 1000), pool = ok.length ? ok : rows, min = Math.min(...pool.map(r => r.score));
    const near = pool.filter(r => r.score <= min + 1);
    const best = near.reduce((a, b) => (b.settle < a.settle ? b : a), near[0]);
    // Rule of thumb for the series value: the first line's Z0 less the driver's output resistance.
    let theory = null;
    if (kind === "series") {
      const first = res0Line(p, solved), rout = outputResistance(p);
      if (first && rout != null) theory = Math.max(0, first - rout);
    }
    return {kind, rows, best: best?.value ?? null, theory, vterm: opts.vterm ?? 0};
  }
  function res0Line(p, solved) {
    const d = CH.distances(p.graph, p.driver.node);
    let best = null, bd = Infinity;
    for (const e of p.graph.edges) if (e.kind === "track") { const m = Math.min(d[e.a], d[e.b]); if (m < bd) { bd = m; best = e; } }
    return best ? lineParams(solved.get(CH.xsKey(best.layer, best.width, null, best.profile)), false)?.z ?? null : null;
  }
  // Average of the pullup and pulldown small-signal resistance near the rails.
  function outputResistance(p) {
    if (p.ideal) return p.ideal.rs || 0;
    const b = IB.buffer(p.driver.model, "typ", {vcc: p.generic.vcc});
    const rs = [];
    const pd = b.pd.f(0.2 * (b.vcc - b.vgnd)), pu = b.pu.f(0.2 * (b.vcc - b.vgnd));
    if (pd[1] > 0) rs.push(1 / pd[1]); if (pu[1] < 0) rs.push(-1 / pu[1]); else if (pu[1] > 0) rs.push(1 / pu[1]);
    return rs.length ? rs.reduce((a, x) => a + x, 0) / rs.length : null;
  }
  // JSON-safe result for the programmatic command, MCP and tests. o.waves adds the full waveforms.
  function summary(r, o = {}) {
    const full = !!o.waves;
    const round = x => (x == null || !Number.isFinite(x) ? x : Number(x.toPrecision(5)));
    const metrics = r.metrics.map(m => ({corner: m.corner, probe: m.probe, role: m.role, edge: m.edge, vlow: round(m.vlow), vhigh: round(m.vhigh), max: round(m.max), min: round(m.min),
      overshoot: round(m.overshoot), overshootPct: round(m.overshootPct), undershoot: round(m.undershoot), ringback: round(m.ringback), settle: round(m.settle),
      tVinl: round(m.tVinl), tVinh: round(m.tVinh), delay: round(m.delay), monotonic: m.monotonic, reachesVinh: m.reachesVinh, vinl: round(m.vinl), vinh: round(m.vinh)}));
    const out = {net: r.net, nets: r.nets, driver: r.driver, receivers: r.receivers, corners: r.corners, stimulus: r.stimulus.type, dt: r.dt, tstop: r.tstop, edgeTime: r.tr, kneeGHz: r.fGHz,
      metrics, crosstalk: r.crosstalk.map(x => ({victim: x.victim, layer: x.layer, length: round(x.length), gap: round(x.gap), next: round(x.next), fext: round(x.fext), nextPct: round(x.nextPct), fextPct: round(x.fextPct), zeven: round(x.zeven), zodd: round(x.zodd)})),
      violations: r.violations.map(v => ({class: v.class, text: v.text})), warnings: r.warnings,
      channel: {lines: r.channel.lines.map(l => ({layer: l.layer, width: l.width, length: round(l.length), z0: round(l.z), delayPs: round(l.delayPs), fallback: l.fallback || undefined})),
        vias: r.channel.vias.map(v => ({id: v.id, kind: v.kind, length: round(v.length), L: round(v.L), C: round(v.C)})), series: r.channel.series, shunts: r.channel.shunts},
      stats: {ms: r.stats.ms, totalMs: r.stats.totalMs, fieldSolves: r.stats.fieldSolves, freshSolves: r.stats.freshSolves, nodes: r.stats.corners[r.corners[0]]?.nodes, steps: r.stats.corners[r.corners[0]]?.steps}};
    if (full) out.waves = {t: Array.from(r.t), series: r.waves.map(w => ({corner: w.corner, probe: w.probe, role: w.role, v: Array.from(w.v)}))};
    return out;
  }
  function drain(g) { for (;;) { const r = g.next(); if (r.done) return r.value; } }

  const api = {version: "1.0.0", CORNERS, DEFAULT_LIMITS, seriesNets, plan, solveList, lineParams, build, run, simulate, sweep, drain, summary, stimulus, fmt, outputResistance};
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof globalThis === "object" && globalThis) globalThis.AtriumSIEngine = api;
})();
