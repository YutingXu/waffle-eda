"use strict";
// Timing Vision and time-domain tuning (Allegro Timing Vision, AiDT/AiPT; KiCad 10
// time-domain tuning).
//
//   Delay model   model(board, defs): propagation delay per copper layer (ps/mm, εeff from the
//                 stack-up via AtriumStackup.delay, else Hammerstad microstrip / stripline), and
//                 a via model: barrel length × √εr of the dielectric it crosses, plus the lumped
//                 pad capacitance term Z0·C/2 with C = 1.41·εr·T·D1/(D2−D1) pF (T, D in inches;
//                 Howard Johnson). netTiming(board, defs, net) → {length, delay, ...}.
//   Targets       targets(board, defs) → Map net → status against the same constraints the
//                 Constraint Manager and DRC use: Matched Lengths / Matched Delays groups and
//                 stored length-tuning groups (AtriumLength.evaluate), Length rules and
//                 Propagation Delay rules. Status short | ok | long, with the tolerance band.
//   Delay groups  groupInDelay(...) turns a matched group into a time-domain group: target in ps,
//                 tolerance in ps, pair phase (intra-pair skew) in ps, and a per-member length
//                 target so auto-tune can reach it. extraGroups adds Matched Delays rules.
//   Session       sessionTarget(...) lets the interactive length tuner take a delay target
//                 (o.targetDelay, ps) or the delay target of its group or rule.
//   DRC           drc(doc, defs, {R, active, flag, notes}) checks Propagation Delay and Matched
//                 Delays rules (rules.js calls it).
//   UI            View → Timing Vision colours constrained tracks blue (short), green (ok),
//                 red (long) while routing and tuning, or always; a HUD near the cursor shows
//                 the length or delay against the target with the tolerance band.
globalThis.AtriumTiming = (() => {
  const C0 = 0.299792458;            // mm per ps
  const DK = 4.2, Z0 = 50, IN = 25.4, ANTIPAD = 0.25;
  const EPS = 1e-6;
  const COLORS = Object.freeze({short: "#3d8bff", ok: "#2fbf71", long: "#ff4d4d", band: "rgba(47,191,113,.28)"});
  const S = () => globalThis.AtriumStackup, Rl = () => globalThis.AtriumRules, L = () => globalThis.AtriumLength;
  const num = v => typeof v === "number" && Number.isFinite(v);
  const layerKey = l => typeof l === "number" ? (l === 0 ? "Top" : l === 127 ? "Bottom" : "Inner " + l) : l;
  const copperIndex = k => k === "Top" ? 0 : k === "Bottom" ? 127 : (m => m ? +m[1] : null)(/^Inner (\d+)$/.exec(k || ""));

  // ------------------------------------------------------------------ delay model
  const models = new WeakMap();
  function stackSig(board) {
    let s = "";
    try { s = S()?.signature?.(board) ?? ""; } catch { s = ""; }
    return s + "|" + (board?.thickness ?? "") + "|" + (board?.timing ? JSON.stringify(board.timing) : "");
  }
  // Per-board settings (board.timing): {z0, antipad, viaModel: "lumped" | "barrel"}.
  function settings(board) {
    const t = board?.timing || {};
    return {z0: num(t.z0) && t.z0 > 0 ? t.z0 : Z0, antipad: num(t.antipad) && t.antipad >= 0 ? t.antipad : ANTIPAD, lumped: t.viaModel !== "barrel"};
  }
  function model(board, defs, index) {
    // An implicit stack can gain an inner layer without changing the board's item count.
    const stack = index && !board.stackup ? S()?.get?.(board,defs,index) : null;
    const sig = stackSig(board) + (stack ? "|" + stack.layers.length : "");
    let m = models.get(board);
    if (m && m.sig === sig) return m;
    let layers = null;
    try { layers = stack?.layers || S()?.get?.(board, defs, index)?.layers || null; } catch { layers = null; }
    const isCu = l => l && (l.type === "Signal" || l.type === "Plane");
    // z of each copper layer centre and the dielectric profile along z.
    const z = new Map(), diel = [];
    let total = 0;
    if (Array.isArray(layers) && layers.length) {
      let acc = 0, n = 0;
      const cu = layers.filter(isCu).length;
      for (const l of layers) {
        const t = +l.thickness || 0;
        if (isCu(l)) { const key = l.key || (n === 0 ? "Top" : n === cu - 1 ? "Bottom" : "Inner " + n); z.set(key, acc + t / 2); n++; }
        else if (t > 0 && l.type !== "Overlay" && l.type !== "Surface Finish" && l.type !== "Solder Mask" && l.type !== "Stiffener") diel.push({from: acc, to: acc + t, dk: l.dk > 0 ? l.dk : DK});
        acc += t;
      }
      total = acc;
    }
    if (!z.size) {
      total = board?.thickness > 0 ? board.thickness : 1.6;
      z.set("Top", 0); z.set("Bottom", total); diel.push({from: 0, to: total, dk: DK});
    }
    const zOf = key => z.has(key) ? z.get(key) : (k => k == null ? 0 : k / 127 * total)(copperIndex(key));
    // Thickness-weighted εr of the dielectric between two heights.
    function erBetween(a, b) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      let h = 0, e = 0;
      for (const d of diel) { const o = Math.min(hi, d.to) - Math.max(lo, d.from); if (o > 0) { h += o; e += o * d.dk; } }
      return h > 0 ? e / h : DK;
    }
    const factors = new Map();
    function factor(layer, width) {
      const key = layerKey(layer), w = width > 0 ? width : 0.15, k = key + "|" + Math.round(w * 1e4);
      let f = factors.get(k);
      if (f !== undefined) return f;
      try { f = S()?.delay?.(board, key, w, defs) || null; } catch { f = null; }
      if (!(f > 0)) { // no stack-up module: AtriumImpedance's one fallback (impedance.js not loaded: its inner-layer value)
        const outer = key === "Top" || key === "Bottom", er = outer ? erBetween(zOf(key), key === "Top" ? zOf(key) + 0.2 : zOf(key) - 0.2) : DK;
        f = globalThis.AtriumImpedance?.delayFallback({outer, w, h: 0.2, er}).delay || Math.sqrt(DK) / C0;
      }
      factors.set(k, f);
      return f;
    }
    const opts = settings(board);
    const barrelFactor = Math.sqrt(erBetween(0, total)) / C0;
    // Lumped via term: Z0·C/2 with C (pF) = 1.41·εr·T·D1/(D2−D1), T and D in inches.
    function lumped(len, er, pad) {
      if (!opts.lumped || !(len > 0)) return 0;
      const d1 = pad > 0 ? pad : 0.6, d2 = d1 + 2 * opts.antipad;
      if (!(d2 > d1)) return 0;
      const c = 1.41 * er * (len / IN) * (d1 / IN) / ((d2 - d1) / IN);
      return opts.z0 * c / 2;
    }
    // Delay of one via (ps) from `from` to `to` copper layer (the full barrel by default).
    function via(v, from, to) {
      const a = zOf(from || v?.fromLayer || "Top"), b = zOf(to || v?.toLayer || "Bottom"), len = Math.abs(b - a), er = erBetween(a, b);
      return {length: len, barrel: len * Math.sqrt(er) / C0, lumped: lumped(len, er, v?.diameter), get ps() { return this.barrel + this.lumped; }, er};
    }
    const typical = via({diameter: 0.6}, "Top", "Bottom");
    m = {sig, factor, via, zOf, erBetween, thickness: total, barrelFactor, viaPs: typical.lumped, typicalVia: typical.barrel + typical.lumped,
      source: layers ? "stackup" : "default", settings: opts};
    models.set(board, m);
    return m;
  }
  // length-tuning.js stackInfo hook: via barrels use the stack's dielectric, plus the lumped term per via.
  function wrapStack(board, defs, base, index) {
    try {
      const m = model(board, defs, index);
      return {...base, viaFactor: m.barrelFactor, viaPs: m.viaPs, sig: base.sig + "|t" + m.sig.length + ":" + m.barrelFactor.toFixed(6) + ":" + m.viaPs.toFixed(4)};
    } catch { return base; }
  }

  // ------------------------------------------------------------------ per-net timing
  // {length (mm), delay (ps), vias, mode, layers}. Uses the length engine when loaded
  // (pad-to-pad path, die lengths, the via model above through wrapStack).
  function netTiming(board, defs, net, o = {}) {
    const E = L();
    if (E?.netLength) {
      // hs-series: through a series part (or a stored xSignal) the delay is source pin → part → load pin.
      try { const r = (E.matchLength || E.netLength)(board, defs, net, o); return {net, xSignal: r.xSignal || null, length: r.length, delay: r.delay, vias: r.vias, mode: r.mode, layers: r.layers, unrouted: r.unrouted, id: r.id, at: r.at}; }
      catch { /* fall back */ }
    }
    const m = model(board, defs);
    let length = 0, delay = 0, vias = 0, id = null, at = null;
    for (const i of board.items || []) {
      if (i.net !== net) continue;
      if (i.kind === "track" && Array.isArray(i.points)) {
        let len = 0; for (let k = 1; k < i.points.length; k++) len += Math.hypot(i.points[k][0] - i.points[k - 1][0], i.points[k][1] - i.points[k - 1][1]);
        length += len; delay += len * m.factor(i.layer || "Top", i.width);
        if (!id) { id = i.id; at = i.points[0]; }
      } else if (i.kind === "via") { const v = m.via(i); length += v.length; delay += v.ps; vias++; if (!id) { id = i.id; at = [i.x, i.y]; } }
    }
    return {net, length, delay, vias, mode: "total", layers: {}, unrouted: false, id, at};
  }
  const netDelay = (board, defs, net, o) => netTiming(board, defs, net, o).delay;
  // Average ps/mm of a net (its routed mix of layers), else the outer-layer factor.
  function speedOf(board, defs, net, t) {
    t ||= netTiming(board, defs, net);
    if (t.length > EPS && t.delay > 0) return t.delay / t.length;
    return model(board, defs).factor("Top", 0.15);
  }
  const lengthFor = (board, defs, net, ps, t) => { t ||= netTiming(board, defs, net); return t.length + (ps - t.delay) / speedOf(board, defs, net, t); };

  // ------------------------------------------------------------------ rules helpers
  function query(board, type, o) { try { return Rl()?.query?.(board, type, o) ?? null; } catch { return null; } }
  function boardNets(board) {
    const s = new Set();
    for (const i of board?.items || []) { if (i.net) s.add(i.net); if (i.pinNets) for (const k in i.pinNets) if (i.pinNets[k]) s.add(i.pinNets[k]); }
    return [...s].sort();
  }
  function pairList(board) { try { return Rl()?.diffPairs?.(board) || []; } catch { return []; } }

  // ------------------------------------------------------------------ delay groups
  // Matched Delays rules as length-tuning groups (length-tuning.js groups() hook).
  function extraGroups(board, out, memberOf, options = {}) {
    if (!Rl()?.types?.matchedDelays) return out;
    const pairs = pairList(board), pairOf = new Map();
    for (const p of pairs) { pairOf.set(p.positive, p); pairOf.set(p.negative, p); }
    const byRule = new Map(), rules = Rl().compiled(board,{project:options.project});
    if (!rules.byType.matchedDelays?.length) return out;
    const resolve = Rl().resolver(board,{project:options.project,compiled:rules});
    // hs-xsignals: rules scoped to xSignals are grouped per xSignal by xsignals.js (length-tuning.js groups()).
    const xsIds = new Set(rules.byType.matchedDelays.filter(r => Rl().isXsScope?.(r)).map(r => r.id));
    const nets = options.routingIndex ? [...options.routingIndex.groups.keys()].sort() : boardNets(board);
    for (const net of nets) {
      const r = resolve("matchedDelays", {net, pairName: pairOf.get(net)?.name});
      if (!r || xsIds.has(r.ruleId)) continue;
      const k = r.ruleId || r.ruleName || "Matched delays";
      if (!byRule.has(k)) byRule.set(k, {rule: r, nets: []});
      byRule.get(k).nets.push(net);
    }
    for (const [k, {rule, nets}] of byRule) {
      const inGroup = new Set(nets);
      out.push({key: "delay:" + k, kind: "delay", name: rule.ruleName || "Matched delays", basis: "delay", delayTolerance: rule.tolerance ?? 5,
        withinPair: !!rule.withinPair, pairDelayTolerance: rule.pairTolerance ?? 1, tolerance: 0.254, pairTolerance: 0.127,
        members: nets.map(memberOf), pairs: pairs.filter(p => inGroup.has(p.positive) && inGroup.has(p.negative)), explicit: null, rule: true});
    }
    return out;
  }
  // Stored length-tuning groups may target delay: {name, members, basis:"delay", targetDelay, delayTolerance, pairDelayTolerance}.
  function storedGroup(board, key) {
    if (!key?.startsWith("group:")) return null;
    return (board?.lengthTuning?.groups || []).find(g => "group:" + g.name === key) || null;
  }
  function delaySpec(board, g) {
    const t = board?.lengthTuning?.targets?.[g.key + "#ps"];
    if (g.basis === "delay") return {target: num(t) ? t : g.targetDelay ?? null, tolerance: g.delayTolerance ?? 5, pair: g.pairDelayTolerance ?? 1};
    const s = storedGroup(board, g.key);
    if (s?.basis === "delay") return {target: num(t) ? t : num(s.targetDelay) ? s.targetDelay : null, tolerance: num(s.delayTolerance) ? s.delayTolerance : 5, pair: num(s.pairDelayTolerance) ? s.pairDelayTolerance : 1};
    return num(t) ? {target: t, tolerance: g.delayTolerance ?? 5, pair: g.pairDelayTolerance ?? 1} : null;
  }
  // length-tuning.js evaluateGroup hook: re-judge a group in the time domain. Members keep
  // their lengths (mm) and gain delta in ps and a length target (lengthTarget) for auto-tune.
  function groupInDelay(board, defs, g, ev) {
    const spec = delaySpec(board, g);
    if (!spec) return ev;
    const routed = ev.members.filter(m => !m.unrouted);
    const longest = routed.reduce((a, m) => Math.max(a, m.delay || 0), 0);
    const target = spec.target ?? longest, tol = spec.tolerance, ptol = spec.pair;
    const delayOf = new Map(ev.members.map(m => [m.nets[0], m.delay || 0]));
    const skewOf = new Map();
    if (g.withinPair) for (const p of g.pairs || []) {
      if (!delayOf.has(p.positive) || !delayOf.has(p.negative)) continue;
      const sk = delayOf.get(p.positive) - delayOf.get(p.negative); skewOf.set(p.positive, sk); skewOf.set(p.negative, -sk);
    }
    let fails = 0, speedMax = 0;
    const members = ev.members.map(m => {
      const v = m.length > EPS && m.delay > 0 ? m.delay / m.length : model(board, defs).factor("Top", 0.15);
      speedMax = Math.max(speedMax, v);
      const dps = Math.abs((m.delay || 0) - target) < 1e-4 ? 0 : (m.delay || 0) - target;
      let status = m.status === "unrouted" || m.status === "length" ? m.status : "pass", note = m.status === status ? m.note : "";
      if (status === "pass") {
        if (dps < -tol - 1e-6) { status = "short"; note = (-dps).toFixed(1) + " ps short"; }
        else if (dps > tol + 1e-6) { status = "long"; note = dps.toFixed(1) + " ps long"; }
      }
      const skewPs = skewOf.get(m.nets[0]);
      if (status === "pass" && skewPs != null && Math.abs(skewPs) > ptol + 1e-6) { status = "skew"; note = "Pair phase " + skewPs.toFixed(2) + " ps"; }
      if (status !== "pass") fails++;
      return {...m, status, note, deltaDelay: dps, skewDelay: skewPs, speed: v, lengthTarget: m.unrouted ? null : m.length - dps / v,
        skew: skewPs != null ? skewPs / v : m.skew};
    });
    // mm equivalents keep the length-based tools (auto-tune, spread columns) meaningful.
    const mm = speedMax > 0 ? 1 / speedMax : 1 / 6.8;
    const lengthTargets = members.filter(m => m.lengthTarget != null).map(m => m.lengthTarget);
    return {...ev, basis: "delay", targetDelay: target, longestDelay: longest, delayTolerance: tol, pairDelayTolerance: ptol,
      tolerance: tol * mm, pairTolerance: ptol * mm, target: lengthTargets.length ? Math.max(...lengthTargets) : ev.target, members, fails,
      delaySpread: routed.length ? longest - routed.reduce((a, m) => Math.min(a, m.delay || 0), Infinity) : 0};
  }
  // length-tuning.js begin() hook: a delay target for the interactive tuner. Returns {target, tolerance} in mm or null.
  function sessionTarget(board, defs, s) {
    const o = s.o || {}, net = s.net;
    let ps = num(o.targetDelay) ? o.targetDelay : null, tolPs = num(o.toleranceDelay) ? o.toleranceDelay : null;
    if (ps == null && !num(o.target)) {
      const E = L();
      if (E?.evaluate) {
        try {
          for (const g of E.evaluate(board, defs)) {
            if (g.basis !== "delay") continue;
            const m = g.members.find(x => x.nets.includes(net));
            if (!m) continue;
            ps = g.targetDelay; tolPs ??= s.mode === "skew" ? g.pairDelayTolerance : g.delayTolerance; break;
          }
        } catch { /* no groups */ }
      }
      if (ps == null) {
        const r = query(board, "delay", {net});
        if (r && (num(r.min) || num(r.max))) { const lo = r.min || 0, hi = num(r.max) ? r.max : null; ps = hi != null ? (lo + hi) / 2 : lo; tolPs ??= hi != null ? (hi - lo) / 2 : 5; }
      }
    }
    if (ps == null) return null;
    const measure = n => netTiming(board, defs, n, o);
    const rate = L()?.delayRates?.(board, defs, o) || ((n, l, w) => model(board, defs).factor(l, w));
    const t = measure(net), mate = s.partner ? measure(s.partner.net) : null;
    let start = t.delay, length = s.base?.length ?? t.length, seg = s.track ? rate(net, s.track.layer, s.track.width) : speedOf(board, defs, net, t);
    if (mate && s.mode === "pair") {
      start = (start + mate.delay) / 2;
      length = (length + (s.partnerLen?.length ?? mate.length)) / 2;
      seg = (seg + rate(s.partner.net, s.partner.layer, s.partner.width)) / 2;
    } else if (mate && s.mode === "skew") {
      ps = Math.max(start, mate.delay);
      start = Math.min(start, mate.delay);
      length = t.delay <= mate.delay ? length : s.partnerLen?.length ?? mate.length;
      if (t.delay > mate.delay) seg = rate(s.partner.net, s.partner.layer, s.partner.width);
    }
    return {target: length + (ps - start) / seg, tolerance: num(o.tolerance) ? o.tolerance : (tolPs ?? 2) / seg,
      targetDelay: ps, startDelay: start, delayPerMm: seg, shorter: !mate || t.delay <= mate.delay};
  }

  // ------------------------------------------------------------------ targets and status
  // Map net → {net, basis, value, unit, min, max, target, tolerance, state, source, ratio}.
  const statusCache = new WeakMap();
  function targets(board, defs, o = {}) {
    const key = o.revision ?? null;
    const c = statusCache.get(board);
    if (key != null && c && c.key === key) return c.map;
    const map = new Map();
    const put = (net, rec) => { const prev = map.get(net); if (!prev || prev.state === "ok" && rec.state !== "ok") map.set(net, rec); };
    const E = L();
    let groups = [];
    if (E?.evaluate) { try { groups = E.evaluate(board, defs, {revision: o.revision}); } catch { groups = []; } }
    for (const g of groups) {
      // Groups with a rule or an explicit target are constraints; plain net-class groups are not.
      if (!(g.rule || g.kind === "custom" || g.kind === "delay" || g.basis === "delay" || g.explicit != null)) continue;
      const delay = g.basis === "delay";
      for (const m of g.members) {
        if (m.unrouted || m.kind !== "net") continue;
        const value = delay ? m.delay : m.length, target = delay ? g.targetDelay : g.target, tol = delay ? g.delayTolerance : g.tolerance;
        const delta = value - target;
        let state = delta < -tol - EPS ? "short" : delta > tol + EPS ? "long" : "ok";
        if (m.status === "skew") state = (delay ? m.skewDelay : m.skew) > 0 ? "long" : "short";
        put(m.nets[0], {net: m.nets[0], basis: delay ? "delay" : "length", unit: delay ? "ps" : "mm", value, length: m.length, delay: m.delay,
          min: target - tol, max: target + tol, target, tolerance: tol, state, source: g.name, group: g.key, skew: delay ? m.skewDelay : m.skew});
      }
    }
    // Length and Propagation Delay rules.
    let lengths = null;
    try { lengths = Rl()?.netLengths?.(board, defs, key != null ? {revision: key} : {}) || null; } catch { lengths = null; }
    for (const net of boardNets(board)) {
      const lr = query(board, "length", {net});
      if (lr && (num(lr.min) && lr.min > 0 || num(lr.max))) {
        const value = lengths?.get(net)?.length ?? netTiming(board, defs, net).length, lo = lr.min || 0, hi = num(lr.max) ? lr.max : Infinity;
        put(net, {net, basis: "length", unit: "mm", value, min: lo, max: hi, target: hi < Infinity ? (lo + hi) / 2 : lo, tolerance: hi < Infinity ? (hi - lo) / 2 : 0,
          state: value < lo - EPS ? "short" : value > hi + EPS ? "long" : "ok", source: lr.ruleName || "Length"});
      }
      const dr = query(board, "delay", {net});
      if (dr && (num(dr.min) && dr.min > 0 || num(dr.max))) {
        const t = netTiming(board, defs, net), lo = dr.min || 0, hi = num(dr.max) ? dr.max : Infinity;
        put(net, {net, basis: "delay", unit: "ps", value: t.delay, length: t.length, delay: t.delay, min: lo, max: hi, target: hi < Infinity ? (lo + hi) / 2 : lo,
          tolerance: hi < Infinity ? (hi - lo) / 2 : 0, state: t.delay < lo - EPS ? "short" : t.delay > hi + EPS ? "long" : "ok", source: dr.ruleName || "Propagation delay"});
      }
    }
    if (key != null) statusCache.set(board, {key, map});
    return map;
  }
  // Status of a hypothetical value against a target record.
  const judge = (rec, value) => value < rec.min - EPS ? "short" : value > rec.max + EPS ? "long" : "ok";

  // ------------------------------------------------------------------ DRC (rules.js)
  function drc(doc, defs, {R, active, flag, notes}) {
    const nets = boardNets(doc), timing = new Map(), t = n => { let v = timing.get(n); if (!v) timing.set(n, v = netTiming(doc, defs, n)); return v; };
    const fmt = v => v.toFixed(1) + " ps";
    const pairOf = n => R.pairOfNet?.get(n)?.name;
    if (active("delay")) for (const net of nets) {
      const r = R.first("delay", {kind:"net",name:net,net, pair: pairOf(net)});
      if (!r) continue;
      const x = t(net);
      if (!(x.length > EPS)) continue;
      const low = num(r.min) && x.delay + EPS < r.min, high = num(r.max) && x.delay - EPS > r.max;
      if (low || high) flag(r, {id: x.id, title: "Net " + net, what: "Delay", detail: "Delay " + fmt(x.delay) + (low ? " < " + fmt(r.min) : " > " + fmt(r.max)) + " (" + x.length.toFixed(3) + " mm)",
        delay: {actual: x.delay, required: low ? r.min : r.max, limit: low ? "min" : "max"}, unit: "ps", at: x.at});
    }
    if (active("matchedDelays")) {
      const groups = new Map();
      for (const net of nets) {
        const pair = pairOf(net), i = R.byType.matchedDelays.findIndex(r => r.m1({kind:"net",name:net,net,pair}));
        if (i < 0) continue;
        const r = R.byType.matchedDelays[i];
        if (!groups.has(r.id)) groups.set(r.id, {r, nets: []});
        groups.get(r.id).nets.push(net);
      }
      for (const {r, nets: list} of groups.values()) {
        const routed = list.filter(n => t(n).length > EPS);
        if (!routed.length) continue;
        const target = Math.max(...routed.map(n => t(n).delay));
        for (const n of routed) {
          const x = t(n);
          if (target - x.delay > r.tolerance + EPS) flag(r, {id: x.id, title: "Net " + n + " against slowest " + fmt(target), what: "Delay",
            detail: "Delay " + fmt(x.delay) + " < " + fmt(target - r.tolerance) + " (target " + fmt(target) + ")", delay: {actual: x.delay, required: target - r.tolerance, target, limit: "min"}, unit: "ps", at: x.at});
        }
        if (r.withinPair) {
          const inGroup = new Set(list);
          for (const p of R.pairs?.values?.() || []) {
            if (!inGroup.has(p.positive) || !inGroup.has(p.negative)) continue;
            const a = t(p.positive), b = t(p.negative), skew = Math.abs(a.delay - b.delay);
            if (a.length > EPS && b.length > EPS && skew > r.pairTolerance + EPS) flag(r, {id: a.id || b.id, title: "Differential pair " + p.name + " (" + p.positive + " / " + p.negative + ")",
              what: "Phase skew", detail: "Intra-pair skew " + skew.toFixed(2) + " ps > " + fmt(r.pairTolerance), delay: {actual: skew, required: r.pairTolerance, limit: "max"}, unit: "ps", at: a.at || b.at});
          }
        }
      }
    }
    const m = model(doc, defs);
    notes?.push?.("Delay from the " + (m.source === "stackup" ? "layer stack" : "default FR-4 stack") + ": per-layer εeff for tracks; vias " + m.typicalVia.toFixed(1) + " ps typical (barrel" + (m.settings.lumped ? " + pad capacitance" : "") + ").");
  }

  // ------------------------------------------------------------------ UI
  let host = null, always = false, live = true, hud = null, lastPointer = null, hoverNet = null, raf = 0;
  try {
    const s = JSON.parse(globalThis.localStorage?.getItem("atrium-timing-vision") || "null");
    if (s) { always = !!s.always; live = s.live !== false; }
  } catch { /* storage unavailable */ }
  const save = () => { try { globalThis.localStorage?.setItem("atrium-timing-vision", JSON.stringify({always, live})); } catch { /* storage unavailable */ } };
  const TOOLS = new Set(["route", "route-diffpair", "length-tune", "length-tune-pair", "length-tune-skew", "length-tune-phase"]);
  const busy = () => !!host && TOOLS.has(host.tool?.());
  const on = () => always || live && busy();

  function statusFor(d) {
    try { return targets(d, host.defs(), {revision: host.revision?.() ?? 0}); } catch (e) { globalThis.console?.warn?.("Timing Vision", e); return new Map(); }
  }
  // While routing: the one net's entry of the revision's status map, the same Map object every frame
  // (paths() is keyed on it, so the tracks' paths are rebuilt once per revision and net, not per frame).
  let netOnly = null;
  function onlyNet(all, net) {
    if (!netOnly || netOnly.all !== all || netOnly.net !== net) netOnly = {all, net, map: new Map([...all].filter(([n]) => n === net))};
    return netOnly.map;
  }
  // Paths per colour and width, rebuilt once per revision.
  const pathCache = new WeakMap();
  function paths(d, map) {
    const rev = host.revision?.() ?? 0, c = pathCache.get(d);
    if (c && c.rev === rev && c.map === map) return c.groups;
    const groups = new Map(), P = typeof Path2D === "function";
    for (const i of d.items) {
      if (i.kind !== "track" || !i.net || !Array.isArray(i.points) || i.points.length < 2) continue;
      const rec = map.get(i.net);
      if (!rec) continue;
      const k = rec.state + "|" + (i.layer || "Top") + "|" + (i.width || 0.15);
      let g = groups.get(k);
      if (!g) groups.set(k, g = {state: rec.state, layer: i.layer || "Top", width: i.width || 0.15, path: P ? new Path2D() : null, lines: []});
      if (g.path) { g.path.moveTo(i.points[0][0], i.points[0][1]); for (let n = 1; n < i.points.length; n++) g.path.lineTo(i.points[n][0], i.points[n][1]); }
      else g.lines.push(i.points);
    }
    pathCache.set(d, {rev, map, groups});
    return groups;
  }
  function strokeLines(ctx, g) {
    if (g.path) { ctx.stroke(g.path); return; }
    ctx.beginPath();
    for (const pts of g.lines) { ctx.moveTo(pts[0][0], pts[0][1]); for (let n = 1; n < pts.length; n++) ctx.lineTo(pts[n][0], pts[n][1]); }
    ctx.stroke();
  }
  // Live state while routing or tuning: {net, value, rec, preview[]}.
  function liveState(d) {
    const map = statusFor(d);
    const tune = host.liveTune?.(), route = host.liveRoute?.();
    if (tune?.net) {
      const g = tune.overlay?.gauge, rec = map.get(tune.net);
      if (!g) return null;
      const pv = tune.overlay?.preview || [];
      const rev = {revision: host.revision?.()}, rate = L()?.delayRates?.(d, host.defs(), rev);
      const seg = pv[0], speed = seg ? (rate ? rate(seg.net || tune.net, seg.layer, seg.width) : model(d, host.defs()).factor(seg.layer || "Top", seg.width)) : 0;
      if (tune.mode === "phase") {
        const ps = g.length * (speed || 6.8);
        return {net: tune.net, kind: "phase", value: g.length, rec: {basis: "length", unit: "mm", min: g.min, max: g.max, target: 0, tolerance: g.tolerance, source: "Phase"},
          state: g.status === "within" ? "ok" : g.length < 0 ? "short" : "long", preview: pv, text: "Phase " + (g.length >= 0 ? "+" : "") + g.length.toFixed(3) + " mm · " + (ps >= 0 ? "+" : "") + ps.toFixed(2) + " ps"};
      }
      const base = netTiming(d, host.defs(), tune.net, rev), delay = g.delay ?? (base.delay + (g.length - base.length) * (speed || speedOf(d, host.defs(), tune.net, base)));
      const timeRec = rec?.basis === "delay" ? rec : null;
      const r = timeRec || {basis: "length", unit: "mm", min: g.min, max: g.max, target: g.target, tolerance: g.tolerance, source: rec?.source || "Tuning target"};
      const value = r.basis === "delay" ? delay : g.length;
      return {net: tune.net, kind: "tune", value, length: g.length, delay, rec: r, state: judge(r, value), preview: pv};
    }
    if (route?.preview) {
      const net = route.net || route.preview.preview?.[0]?.net;
      if (!net) return null;
      const rev = {revision: host.revision?.()}, rec = map.get(net), base = netTiming(d, host.defs(), net, rev);
      const pv = (route.preview.preview || []).filter(p => !p.net || p.net === net), m = model(d, host.defs());
      const rate = L()?.delayRates?.(d, host.defs(), rev);
      let add = 0, addDelay = 0;
      for (const p of pv) { let len = 0; for (let n = 1; n < p.points.length; n++) len += Math.hypot(p.points[n][0] - p.points[n - 1][0], p.points[n][1] - p.points[n - 1][1]); add += len; addDelay += len * (rate ? rate(net, p.layer, p.width) : m.factor(p.layer || "Top", p.width)); }
      for (const v of route.preview.vias || []) { const x = m.via(v); add += x.length; addDelay += x.ps; }
      const length = base.length + add, delay = base.delay + addDelay;
      if (!rec) return {net, kind: "route", value: length, length, delay, rec: null, state: null, preview: pv};
      const value = rec.basis === "delay" ? delay : length;
      return {net, kind: "route", value, length, delay, rec, state: judge(rec, value), preview: pv};
    }
    return null;
  }
  function overlay(d, map, liveNow) {
    return (ctx, {scale}) => {
      const px = 1 / scale;
      ctx.save();
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      const hidden = host.hiddenLayers?.();
      if (map && map.size) {
        // A dark casing keeps the colour readable over any layer colour.
        for (const g of paths(d, map).values()) {
          if (hidden?.has?.(g.layer)) continue;
          ctx.globalAlpha = .55; ctx.strokeStyle = "#000"; ctx.lineWidth = Math.max(g.width, 3.5 * px); strokeLines(ctx, g);
          ctx.globalAlpha = .92; ctx.strokeStyle = COLORS[g.state] || COLORS.ok; ctx.lineWidth = Math.max(g.width - 2 * px, 2 * px); strokeLines(ctx, g);
        }
      }
      // The track being routed or tuned, in the colour it would have now.
      if (liveNow?.state && liveNow.preview?.length) {
        for (const p of liveNow.preview) {
          if (!p.points || p.points.length < 2) continue;
          ctx.beginPath(); ctx.moveTo(p.points[0][0], p.points[0][1]);
          for (let n = 1; n < p.points.length; n++) ctx.lineTo(p.points[n][0], p.points[n][1]);
          ctx.globalAlpha = .55; ctx.strokeStyle = "#000"; ctx.lineWidth = Math.max(p.width || .15, 3.5 * px); ctx.stroke();
          ctx.globalAlpha = .92; ctx.strokeStyle = COLORS[liveNow.state]; ctx.lineWidth = Math.max((p.width || .15) - 2 * px, 2 * px); ctx.stroke();
        }
      }
      ctx.restore();
    };
  }
  // ------------------------------------------------------------------ HUD
  const fmtV = (v, unit) => !Number.isFinite(v) ? "∞" : unit === "ps" ? v.toFixed(1) + " ps" : v.toFixed(3) + " mm";
  function hudModel(st) {
    if (!st) return null;
    const rec = st.rec, unit = rec?.unit || "mm";
    const lines = [];
    if (st.text) lines.push(st.text);
    else if (rec) {
      const tol = rec.max < Infinity && rec.min > -Infinity ? " ±" + (unit === "ps" ? ((rec.max - rec.min) / 2).toFixed(1) : ((rec.max - rec.min) / 2).toFixed(3)) : rec.max === Infinity ? " min" : "";
      lines.push(fmtV(st.value, unit) + " / " + fmtV(rec.max === Infinity ? rec.min : rec.target, unit) + tol);
    } else lines.push(fmtV(st.length, "mm"));
    const other = unit === "ps" ? (st.length != null ? fmtV(st.length, "mm") : "") : (st.delay != null ? fmtV(st.delay, "ps") : "");
    if (other) lines.push(other + (rec ? " · " + rec.source : " · no target"));
    let bar = null;
    if (rec && Number.isFinite(rec.min)) {
      const hiEnd = Math.max(Number.isFinite(rec.max) ? rec.max : rec.min * 1.2, st.value) * 1.1, loEnd = Math.min(0, rec.min, st.value);
      const span = hiEnd - loEnd || 1, at = v => Math.max(0, Math.min(1, (v - loEnd) / span));
      bar = {from: at(rec.min), to: Number.isFinite(rec.max) ? at(rec.max) : 1, value: at(st.value)};
    }
    return {title: st.net + (st.kind === "route" ? " · routing" : st.kind === "tune" ? " · tuning" : st.kind === "phase" ? " · phase" : ""), lines, state: st.state || "none", bar};
  }
  function paintHud(st, x, y) {
    if (typeof document === "undefined") return;
    const m = hudModel(st);
    if (!m || x == null) { if (hud) hud.hidden = true; return; }
    if (!hud) {
      hud = document.createElement("div"); hud.className = "timing-hud"; hud.setAttribute("role", "status"); hud.setAttribute("aria-live", "off");
      hud.innerHTML = '<strong></strong><span class="timing-hud-line"></span><span class="timing-hud-line timing-hud-sub"></span><span class="timing-hud-bar"><i class="timing-hud-band"></i><b class="timing-hud-mark"></b></span>';
    }
    // The readout belongs to the canvas under the pointer: it joins that canvas's layer
    // (ui/owner-layer.js), so a context menu or floating panel opened over the canvas covers it.
    const layer = globalThis.AtriumLayer, canvas = host?.canvas?.();
    if (!canvas) { hud.hidden = true; return; }
    layer.attach(hud, canvas);
    hud.dataset.state = m.state;
    hud.children[0].textContent = m.title;
    hud.children[1].textContent = m.lines[0] || "";
    hud.children[2].textContent = m.lines[1] || ""; hud.children[2].hidden = !m.lines[1];
    const bar = hud.children[3];
    bar.hidden = !m.bar;
    if (m.bar) { bar.children[0].style.left = (m.bar.from * 100).toFixed(1) + "%"; bar.children[0].style.width = (Math.max(.01, m.bar.to - m.bar.from) * 100).toFixed(1) + "%"; bar.children[1].style.left = (m.bar.value * 100).toFixed(1) + "%"; }
    hud.hidden = false;
    const r = hud.getBoundingClientRect(), W = globalThis.innerWidth || 1200, H = globalThis.innerHeight || 800;
    layer.at(hud, Math.max(4, Math.min(x + 18, W - r.width - 6)),
      Math.max(4 + (canvas ? canvas.getBoundingClientRect().top : parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-caption-height")) || 0), Math.min(y - r.height - 14, H - r.height - 6))); // over its canvas, below the app bar
  }
  function refreshHud() {
    raf = 0;
    if (!host) return;
    const d = host.doc();
    if (d?.kind !== "pcb" || !lastPointer || !(always || live)) { paintHud(null); return; }
    let st = busy() && live || busy() && always ? liveState(d) : null;
    if (!st && always && hoverNet) {
      const rec = statusFor(d).get(hoverNet);
      if (rec) st = {net: hoverNet, kind: "hover", value: rec.value, length: rec.length ?? (rec.unit === "mm" ? rec.value : null), delay: rec.delay ?? netTiming(d, host.defs(), hoverNet).delay, rec, state: rec.state};
    }
    const RF = globalThis.AtriumRouteFeel;
    if (RF?.timing) RF.timing(st?.kind === "route" ? hudModel(st) : null);
    if (st?.kind === "route" && RF?.timing) { paintHud(null); return; }
    paintHud(st, lastPointer[0], lastPointer[1]);
  }
  const later = () => { if (!raf) raf = (globalThis.requestAnimationFrame || (f => setTimeout(f, 16)))(refreshHud); };

  function setAlways(v) { always = !!v; save(); globalThis.AtriumNavCommon?.setChecked("timing-vision", always); host?.invalidate(); later(); host?.info?.(always ? "Timing Vision on: constrained tracks are coloured short (blue), OK (green) and long (red)." : "Timing Vision shows only while routing and tuning" + (live ? "." : " (off)."));}
  function setLive(v) { live = !!v; save(); globalThis.AtriumNavCommon?.setChecked("timing-vision-live", live); host?.invalidate(); later(); }

  function attach(h) {
    host = h;
    host.registerAction("timing-vision", () => setAlways(!always));
    host.registerAction("timing-vision-live", () => setLive(!live));
    host.addRenderer((d, info) => {
      if (d.kind !== "pcb" || !on()) return null;
      const liveNow = info?.active && busy() ? liveState(d) : null;
      const map = always ? statusFor(d) : liveNow ? onlyNet(statusFor(d), liveNow.net) : null;
      if (!map?.size && !liveNow?.state) return null;
      return {overlay: overlay(d, map, liveNow)};
    });
    host.on("change", later);
    host.on("document", later);
    const C = globalThis.AtriumNavCommon;
    C?.setChecked("timing-vision", always); C?.setChecked("timing-vision-live", live);
    if (typeof document === "undefined") return;
    C?.menuItem("view", "timing-vision-live", "Timing Vision While Routing", {after: "timing-vision", scope: "pcb", checkable: true});
    C?.setChecked("timing-vision-live", live);
    let hitAt = 0;
    document.addEventListener("pointermove", e => {
      if (e.target?.tagName !== "CANVAS") { if (lastPointer) { lastPointer = null; later(); } return; }
      lastPointer = [e.clientX, e.clientY];
      if (always && !busy()) {
        const t = e.timeStamp || 0;
        if (t - hitAt > 40) { hitAt = t; try { const r = host.hit?.(e.target, e.clientX, e.clientY); const n = r?.item?.kind === "track" || r?.item?.kind === "via" ? r.item.net : null; hoverNet = n || null; } catch { hoverNet = null; } }
      } else hoverNet = null;
      later();
    }, {passive: true});
    document.addEventListener("pointerleave", () => { lastPointer = null; later(); }, true);
    document.addEventListener("keyup", () => later(), true);
  }
  globalThis.AtriumNavCommon?.ready?.(attach);

  return Object.freeze({C0, COLORS, model, wrapStack, netTiming, netDelay, speedOf, lengthFor, extraGroups, groupInDelay, sessionTarget, targets, judge, drc,
    hudModel, liveState: d => host ? liveState(d) : null, settings, attach,
    setAlways, setLive, always: () => always, live: () => live, refresh: later});
})();
