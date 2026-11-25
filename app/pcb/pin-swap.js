"use strict";
// Pin and gate swapping on boards, Altium-style (Tools › Pin/Part Swapping), with
// back-annotation to the schematic through the reverse ECO.
//
// Equivalence comes from the library definition:
//   pin swap   pins of one symbol with the same `swapGroup` (alias `pinGroup`, set in the
//              symbol editor's pin table, column "Swap") and the same gate are interchangeable.
//   gate swap  gates (units) of a multi-gate symbol are equivalent when their pins sit at the
//              same positions with the same electrical types (U1A ↔ U1B of a dual op amp),
//              unless symbol.gateSwap === false. symbol.swapGates [[1,2],[3,4]] limits the groups.
//
// On the board a swap exchanges the pads' nets (part.pinNets). Copper on a swapped pad that
// dead-ends there follows the pad to its new net; copper that leads on to other pads is
// unrouted (removed) so no short is left behind. In the same undo step the schematic is
// updated through AtriumECO (direction "sch", actions gateSwap and pinSwap, which this module
// registers with AtriumECO.extendSch): gate swaps exchange the gates' units, pin swaps move the
// wire ends, labels and ports at the two pins, then check the result with the connectivity.
//
// The optimiser (Automatic Net/Pin Optimizer) proposes swaps that shorten the ratsnest and
// remove crossings, per swap group and per pair of equivalent gates, as a reviewable list.
//
// Pure API (tests): info(def), peers(def, n), gatePairs(def, u1, u2), planPin, planGate,
// applyBoard(board, defs, plan), optimise(board, defs, o), applyPlans(project, board, defs, plans),
// ecoPlanner(cx, add, h), sch handlers SCH.pinSwap / SCH.gateSwap, register().
globalThis.AtriumPinSwap = (() => {
  const A = () => globalThis.Atrium;
  const {copperSpan} = AtriumConnectivity;
  const TOL = 1e-6;
  const groupOf = p => { const g = p?.swapGroup ?? p?.pinGroup; return g == null || String(g).trim() === "" ? null : String(g).trim(); };
  const unitOf = p => p?.unit || p?.part || 1;
  const letter = u => u <= 26 ? String.fromCharCode(64 + u) : "#" + u;
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const fail = m => { throw Error(m); };

  // ------------------------------------------------------------------ library equivalence
  const infos = new WeakMap();
  function info(def) {
    const sym = def?.symbol;
    if (!sym) return {pins: new Map(), groups: new Map(), gateGroups: [], swappable: false, pairs: () => []};
    let I = infos.get(sym);
    if (I && I.n === sym.pins?.length) return I;
    const pins = new Map();
    for (const p of sym.pins || []) if (p.number != null && p.number !== "") pins.set(String(p.number), {number: String(p.number), name: p.name || "", part: p.part > 0 ? p.part : 0, group: groupOf(p), x: p.x, y: p.y, electrical: p.electrical});
    const groups = new Map();
    for (const p of pins.values()) if (p.group) { const k = p.part + "|" + p.group; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p.number); }
    for (const [k, v] of groups) if (v.length < 2) groups.delete(k);
    const parts = sym.parts || 1, sig = new Map();
    const pos = p => Math.round(p.x * 1000) + "," + Math.round(p.y * 1000);
    if (parts > 1 && sym.gateSwap !== false) for (let u = 1; u <= parts; u++) {
      const list = [...pins.values()].filter(p => p.part === u).map(p => pos(p) + ":" + (p.electrical ?? "")).sort();
      if (list.length) { const s = list.join(";"); if (!sig.has(s)) sig.set(s, []); sig.get(s).push(u); }
    }
    let gateGroups = [...sig.values()].filter(g => g.length > 1);
    if (Array.isArray(sym.swapGates)) {
      const allowed = sym.swapGates.map(g => new Set(g.map(Number)));
      gateGroups = gateGroups.flatMap(g => allowed.map(a => g.filter(u => a.has(u))).filter(x => x.length > 1));
    }
    const cache = new Map();
    function pairs(u1, u2) {
      const k = u1 + "/" + u2; if (cache.has(k)) return cache.get(k);
      if (!gateGroups.some(g => g.includes(u1) && g.includes(u2)) || u1 === u2) { cache.set(k, []); return []; }
      const b = new Map([...pins.values()].filter(p => p.part === u2).map(p => [pos(p), p.number]));
      const out = [...pins.values()].filter(p => p.part === u1).map(p => [p.number, b.get(pos(p))]).filter(x => x[1]);
      cache.set(k, out); return out;
    }
    I = {n: sym.pins?.length, pins, groups, gateGroups, parts, pairs, swappable: groups.size > 0 || gateGroups.length > 0};
    infos.set(sym, I);
    return I;
  }
  function peers(def, n) {
    const I = info(def), p = I.pins.get(String(n));
    if (!p?.group) return [];
    return (I.groups.get(p.part + "|" + p.group) || []).filter(x => x !== p.number);
  }
  const gatePairs = (def, u1, u2) => info(def).pairs(u1, u2);
  const gateOf = (def, n) => info(def).pins.get(String(n))?.part || 0;
  // The library definition behind a board part (bottom-side parts use a mirrored copy).
  function libDef(defs, part) { const d = defs.get(part.def); return d?.mirrorOf && !d.symbol ? defs.get(d.mirrorOf) || d : d; }

  // ------------------------------------------------------------------ board plans
  const netOf = (part, n) => part.pinNets?.[n] ?? "";
  function planPin(board, defs, partId, a, b) {
    const part = board.items.find(i => i.id === partId && i.kind === "part") || fail("Choose a component on the board.");
    const def = libDef(defs, part); a = String(a); b = String(b);
    if (a === b) fail("Choose two different pads.");
    if (!peers(def, a).includes(b)) fail("Pins " + a + " and " + b + " of " + part.ref + " are not swap-equivalent. Give them the same Swap group in the symbol's pin table.");
    if (netOf(part, a) === netOf(part, b)) fail("Pins " + a + " and " + b + " of " + part.ref + " are on the same net.");
    return {kind: "pin", partId, ref: part.ref, pairs: [[a, b]], label: part.ref + " pins " + a + " ↔ " + b};
  }
  function planGate(board, defs, partId, u1, u2) {
    const part = board.items.find(i => i.id === partId && i.kind === "part") || fail("Choose a component on the board.");
    const def = libDef(defs, part), pairs = gatePairs(def, u1, u2);
    if (!pairs.length) fail("Gates " + letter(u1) + " and " + letter(u2) + " of " + part.ref + " are not equivalent.");
    if (pairs.every(([x, y]) => netOf(part, x) === netOf(part, y))) fail("Gates " + letter(u1) + " and " + letter(u2) + " of " + part.ref + " carry the same nets.");
    return {kind: "gate", partId, ref: part.ref, units: [u1, u2], pairs, label: part.ref + letter(u1) + " ↔ " + part.ref + letter(u2)};
  }
  function terminal(pad, part) {
    const r = Math.max(pad.w || 0, pad.h || 0, pad.diameter || 0) / 2 || .3;
    const kind = pad.kind === "via" ? "via" : "pad";
    const span = pad.holeOnly || (pad.drill > 0 && pad.plated === false) ? null : copperSpan({...pad, kind}, part);
    return {at: pad.at || [pad.x, pad.y], r, span};
  }
  // Pads of the board (part pins and free pads) per net.
  function terminals(board, defs) {
    const out = new Map(), add = (net, t) => { if (!net) return; if (!out.has(net)) out.set(net, []); out.get(net).push(t); };
    for (const i of board.items) {
      if (i.kind === "part") {
        const d = defs.get(i.def);
        if (!d?.footprint) continue;
        for (const p of A().pins(i, d, "pcb")) add(netOf(i, p.number) || p.net || "", {...terminal(p, i), partId: i.id, number: String(p.number)});
      } else if (i.kind === "pad") add(i.net, terminal(i));
    }
    return out;
  }
  function padOf(defs, part, n) {
    const d = defs.get(part.def), p = d?.footprint ? A().pins(part, d, "pcb").find(q => String(q.number) === String(n)) : null;
    return p ? terminal(p, part) : null;
  }
  const sharesLayer = (a, b) => a && b && a[0] <= b[1] && b[0] <= a[1];
  const touchesPad = (copper, pad) => sharesLayer(copper.span, pad.span) &&
    copper.points.some(q => near(q, pad.at) <= pad.r + TOL);

  // Copper of `net` connected to the pad: shared track vertices and vias on common layers.
  function island(board, net, pad) {
    if (!pad.span) return [];
    const copper = [];
    for (const item of board.items) {
      if ((item.kind !== "track" && item.kind !== "via") || item.net !== net) continue;
      const span = copperSpan(item);
      if (!span) continue;
      const via = item.kind === "via";
      copper.push({item, span, points: via ? [[item.x, item.y]] : item.points || [], reach: via ? (item.diameter || .6) / 2 : 0});
    }
    const queue = copper.filter(i => touchesPad(i, pad)), seen = new Set(queue);
    for (let k = 0; k < queue.length; k++) {
      const a = queue[k];
      for (const b of copper) {
        if (seen.has(b) || !sharesLayer(a.span, b.span)) continue;
        const reach = Math.max(TOL, a.reach, b.reach);
        const join = a.points.some(p => b.points.some(q => near(p, q) <= reach));
        if (join) { seen.add(b); queue.push(b); }
      }
    }
    return queue;
  }
  function applyBoard(board, defs, plan, terms = null) {
    const part = board.items.find(i => i.id === plan.partId) || fail("The component is no longer on the board.");
    terms ||= terminals(board, defs);
    const actions = [];
    for (const [a, b] of plan.pairs) for (const [n, to] of [[a, netOf(part, b)], [b, netOf(part, a)]]) {
      const from = netOf(part, n), pad = padOf(defs, part, n);
      if (!from || !pad) { actions.push({n, to, copper: [], leads: false}); continue; }
      const copper = island(board, from, pad);
      // Does that copper reach another pad of the old net?
      const others = (terms.get(from) || []).filter(t => !(t.partId === part.id && t.number === n));
      const leads = others.some(t => copper.some(i => touchesPad(i, t)));
      actions.push({n, to, copper, leads});
    }
    const nets = {...(part.pinNets || {})};
    for (const [a, b] of plan.pairs) { const x = nets[a] ?? "", y = nets[b] ?? ""; nets[a] = y; nets[b] = x; }
    part.pinNets = nets;
    let unrouted = 0, renetted = 0;
    const drop = new Set();
    for (const x of actions) for (const {item: i} of x.copper) {
      if (x.leads) { drop.add(i.id); unrouted++; }
      else { i.net = x.to; renetted++; }
    }
    if (drop.size) board.items = board.items.filter(i => !drop.has(i.id));
    return {unrouted, renetted};
  }

  // ------------------------------------------------------------------ optimiser
  function segCross(a, b, c, d) {
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }
  // The airwire a pad of `net` at `at` would get: to the nearest pad of the net off this part.
  function target(terms, net, at, partId) {
    let best = null, bd = Infinity;
    for (const t of terms.get(net) || []) { if (t.partId === partId) continue; const d = near(t.at, at); if (d < bd) { bd = d; best = t.at; } }
    return best;
  }
  function cost(lines, w) {
    let len = 0, cross = 0;
    for (const l of lines) len += near(l[0], l[1]);
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) if (segCross(lines[i][0], lines[i][1], lines[j][0], lines[j][1])) cross++;
    return {length: len, crossings: cross, score: len + w * cross};
  }
  function routedPads(board, defs, part) {
    const out = new Set();
    for (const n of Object.keys(part.pinNets || {})) { const net = netOf(part, n), pad = padOf(defs, part, n); if (net && pad && island(board, net, pad).length) out.add(n); }
    return out;
  }
  // Transpositions that turn `from` (number → net) into `to`.
  function transpositions(order, from, to) {
    const cur = new Map(from), out = [];
    for (const x of order) {
      if (cur.get(x) === to.get(x)) continue;
      const y = order.find(z => z !== x && cur.get(z) === to.get(x) && cur.get(z) !== to.get(z));
      if (!y) continue;
      out.push([x, y]); const t = cur.get(x); cur.set(x, cur.get(y)); cur.set(y, t);
    }
    return out;
  }
  function optimise(board, defs, o = {}) {
    const w = o.crossingWeight ?? 2, terms = terminals(board, defs), out = [];
    const only = o.parts ? new Set(o.parts) : null;
    for (const part of board.items) {
      if (part.kind !== "part" || (only && !only.has(part.id)) || part.locked) continue;
      const def = libDef(defs, part), I = info(def);
      if (!I.swappable) continue;
      const fixed = o.includeRouted ? new Set() : routedPads(board, defs, part);
      const at = new Map();
      for (const n of I.pins.keys()) { const p = padOf(defs, part, n); if (p) at.set(n, p.at); }
      const lineFor = (n, net) => { const t = net && at.has(n) ? target(terms, net, at.get(n), part.id) : null; return t ? [at.get(n), t] : null; };
      const linesOf = (list, nets) => list.map(n => lineFor(n, nets.get(n))).filter(Boolean);
      // Gates first: each pair of equivalent gates, swapped or not.
      for (const g of I.gateGroups) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
        const pairs = I.pairs(g[i], g[j]);
        if (!pairs.length || pairs.some(([x, y]) => fixed.has(x) || fixed.has(y))) continue;
        const pins = pairs.flat(), now = new Map(pins.map(n => [n, netOf(part, n)]));
        if (!pins.some(n => now.get(n))) continue;
        const sw = new Map(now); for (const [x, y] of pairs) { sw.set(x, now.get(y)); sw.set(y, now.get(x)); }
        const a = cost(linesOf(pins, now), w), b = cost(linesOf(pins, sw), w);
        if (a.score - b.score > (o.minGain ?? .05)) out.push({kind: "gate", partId: part.id, ref: part.ref, units: [g[i], g[j]], pairs, before: a, after: b, gain: a.score - b.score,
          label: part.ref + letter(g[i]) + " ↔ " + part.ref + letter(g[j]), lines: {before: linesOf(pins, now), after: linesOf(pins, sw)}});
      }
      // Pin groups: the assignment of the group's nets to its pins with the lowest cost.
      for (const list of I.groups.values()) {
        const free = list.filter(n => !fixed.has(n) && at.has(n));
        if (free.length < 2) continue;
        const now = new Map(free.map(n => [n, netOf(part, n)])), nets = free.map(n => now.get(n));
        if (new Set(nets).size < 2) continue;
        let best = {assign: nets.slice(), c: cost(linesOf(free, now), w)};
        const base = best.c;
        const tryAssign = arr => { const m = new Map(free.map((n, k) => [n, arr[k]])), c = cost(linesOf(free, m), w); if (c.score < best.c.score - 1e-9) best = {assign: arr.slice(), c}; };
        if (free.length <= 7) {
          const a = nets.slice(), c = new Array(a.length).fill(0); let i = 0;
          while (i < a.length) { if (c[i] < i) { const k = i % 2 ? c[i] : 0; [a[k], a[i]] = [a[i], a[k]]; tryAssign(a); c[i]++; i = 0; } else { c[i] = 0; i++; } }
        } else {
          for (let pass = 0, better = true; better && pass < 20; pass++) {
            better = false;
            for (let x = 0; x < free.length; x++) for (let y = x + 1; y < free.length; y++) {
              const a = best.assign.slice(); [a[x], a[y]] = [a[y], a[x]]; const s = best.c.score; tryAssign(a); if (best.c.score < s - 1e-9) better = true;
            }
          }
        }
        if (base.score - best.c.score <= (o.minGain ?? .05)) continue;
        const to = new Map(free.map((n, k) => [n, best.assign[k]])), steps = transpositions(free, now, to);
        if (!steps.length) continue;
        out.push({kind: "pin", partId: part.id, ref: part.ref, pairs: steps, before: base, after: best.c, gain: base.score - best.c.score,
          label: part.ref + " pins " + free.filter(n => now.get(n) !== to.get(n)).join(", "), lines: {before: linesOf(free, now), after: linesOf(free, to)}});
      }
    }
    return out.sort((a, b) => b.gain - a.gain);
  }

  // ------------------------------------------------------------------ apply with back-annotation
  // Applies board plans in order, then back-annotates the schematic (when the project has one).
  // Call inside one editor edit: everything is one undo step.
  function applyPlans(project, board, defs, plans, o = {}) {
    let unrouted = 0, renetted = 0;
    const affected = new Set();
    for (const p of plans) { const part = board.items.find(i => i.id === p.partId); for (const n of p.pairs.flat()) if (/^Net-/.test(part?.pinNets?.[n] || "")) affected.add(part.pinNets[n]); }
    for (const p of plans) {
      // Pin plans are transpositions; each is applied on the current nets.
      if (p.kind === "pin") for (const pair of p.pairs) { const r = applyBoard(board, defs, {...p, pairs: [pair]}); unrouted += r.unrouted; renetted += r.renetted; }
      else { const r = applyBoard(board, defs, p); unrouted += r.unrouted; renetted += r.renetted; }
    }
    const back = o.backAnnotate === false ? null : backAnnotate(project, board, affected);
    return {unrouted, renetted, back};
  }
  // Automatic net names (Net-U1-3) follow the first pin of a net, so a swap renames them in the
  // schematic. Give the swapped nets the schematic's names on the board too (pads and copper),
  // when every pad of the net agrees, so neither direction shows a difference afterwards.
  function harmonize(project, board, affected) {
    const E = globalThis.AtriumECO, plan = E.plan(project, {direction: "pcb", board: board.id}), map = new Map(), bad = new Set();
    for (const c of plan.changes) if (c.action === "padNet" && affected.has(c.before) && c.after) {
      if (map.has(c.before) && map.get(c.before) !== c.after) bad.add(c.before); else map.set(c.before, c.after);
    }
    for (const n of bad) map.delete(n);
    const used = new Set(board.items.flatMap(i => [i.net, ...Object.values(i.pinNets || {})]).filter(Boolean));
    for (const [from, to] of [...map]) if (used.has(to) && !map.has(to)) map.delete(from);
    if (!map.size) return 0;
    for (const i of board.items) {
      if (i.pinNets) { let ch = false; const n = {...i.pinNets}; for (const k in n) if (map.has(n[k])) { n[k] = map.get(n[k]); ch = true; } if (ch) i.pinNets = n; }
      if (i.net && map.has(i.net)) i.net = map.get(i.net);
    }
    return map.size;
  }
  function backAnnotate(project, board, affected = null) {
    const E = globalThis.AtriumECO;
    if (!project.documents.some(d => d.kind === "schematic")) return {applied: 0, failed: 0, messages: ["No schematic to update."]};
    if (!E?.update || !register()) return {applied: 0, failed: 0, messages: ["The ECO module is not loaded; use Design › Update Schematics to back-annotate."]};
    const r = E.update(project, {direction: "sch", board: board.id, only: ["gateSwap", "pinSwap"]});
    const rows = r.report.rows.filter(x => x.action === "gateSwap" || x.action === "pinSwap");
    if (affected?.size && rows.some(x => x.state === "done")) harmonize(project, board, affected);
    return {applied: rows.filter(x => x.state === "done").length, failed: rows.filter(x => x.state === "failed").length,
      messages: rows.filter(x => x.state === "failed").map(x => x.object + ": " + x.message), rows};
  }

  // ------------------------------------------------------------------ reverse ECO
  function ecoPlanner(cx, add, h) {
    const changeId = h?.changeId || ((...k) => JSON.stringify(k));
    for (const c of cx.comps.values()) {
      if (c.skip || !c.inScope) continue;
      const m = cx.matched.get(c.key), bp = m?.bp;
      if (!bp || !c.sd?.symbol) continue;
      const I = info(c.sd);
      if (!I.swappable) continue;
      const board = n => bp.pinNets?.[n] ?? "";
      const cur = new Map([...I.pins.keys()].map(n => [n, c.net(n).net || ""]));
      const t = {sheet: c.sheet.id, sheetName: c.sheet.name, component: c.ref, targetId: bp.id, document: c.sheet.name};
      const placed = new Map(c.gates.map(g => [unitOf(g.p), g]));
      for (const g of I.gateGroups) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
        const u1 = g[i], u2 = g[j], pairs = I.pairs(u1, u2), g1 = placed.get(u1), g2 = placed.get(u2);
        if (!pairs.length || !g1 || !g2) continue;
        const differs = pairs.some(([x, y]) => board(x) !== cur.get(x) || board(y) !== cur.get(y));
        const crossed = pairs.every(([x, y]) => board(x) === cur.get(y) && board(y) === cur.get(x));
        if (!differs || !crossed) continue;
        add({...t, action: "gateSwap", id: changeId("gateSwap", c.key, u1 + "/" + u2), object: c.ref + letter(u1) + " ↔ " + c.ref + letter(u2),
          sourceIds: [g1.p.id, g2.p.id], units: [u1, u2], before: [c.ref + letter(u1), c.ref + letter(u2)], after: [c.ref + letter(u2), c.ref + letter(u1)]});
        for (const [x, y] of pairs) { const v = cur.get(x); cur.set(x, cur.get(y)); cur.set(y, v); }
        placed.set(u1, g2); placed.set(u2, g1);
      }
      for (const list of I.groups.values()) {
        const want = new Map(list.map(n => [n, board(n)]));
        for (const [x, y] of transpositions(list, cur, want)) {
          const unit = I.pins.get(x).part, owner = (unit ? placed.get(unit) : c.gates[0]) || c.gates[0];
          add({...t, action: "pinSwap", id: changeId("pinSwap", c.key, x + "/" + y), object: c.ref + " pins " + x + " ↔ " + y, pins: [x, y],
            sourceIds: [owner.p.id], before: [x + " " + (cur.get(x) || "—"), y + " " + (cur.get(y) || "—")], after: [x + " " + (cur.get(y) || "—"), y + " " + (cur.get(x) || "—")]});
          const v = cur.get(x); cur.set(x, cur.get(y)); cur.set(y, v);
        }
      }
    }
  }
  const sheetOf = (project, item) => project.documents.find(d => d.kind === "schematic" && d.items.includes(item));
  const SCH = {
    gateSwap(env, c) {
      const [a, b] = c.sourceIds.map(id => env.sch.get(id));
      if (!a || !b) fail("A gate is no longer on the schematic.");
      if (unitOf(a) !== c.units[0] || unitOf(b) !== c.units[1]) fail("Changed since the comparison. Compare again.");
      for (const [p, u] of [[a, c.units[1]], [b, c.units[0]]]) { p.unit = u; if ("part" in p) delete p.part; }
      return "";
    },
    pinSwap(env, c) {
      const part = env.sch.get(c.sourceIds[0]) || fail("The component is no longer on the schematic.");
      const sheet = sheetOf(env.project, part) || fail("The component's sheet is gone.");
      const def = env.lib.get(part.def), [x, y] = c.pins;
      const pins = A().pins(part, def, "schematic"), px = pins.find(p => String(p.number) === x)?.at, py = pins.find(p => String(p.number) === y)?.at;
      if (!px || !py) fail("Pins " + x + " and " + y + " are not on the same gate of " + part.ref + ".");
      const kx = part.id + "/" + x, ky = part.id + "/" + y;
      // What each pin is connected to (other pins, and the net name unless it is automatic).
      const peersOf = (g, k) => { const n = g.byPin.get(k); if (n == null) return ""; const o = [...g.byPin].filter(([q, m]) => m === n && q !== kx && q !== ky).map(([q]) => q).sort(); return (/^Net-/.test(n) ? "" : n) + "|" + o.join(","); };
      const before = A().connectivity(sheet, env.lib), bx = peersOf(before, kx), by = peersOf(before, ky);
      const saved = sheet.items;
      const moved = rewire(sheet, part, px, py);
      const after = A().connectivity(sheet, env.lib);
      const ok = moved > 0 && peersOf(after, ky) === bx && peersOf(after, kx) === by;
      if (!ok) { sheet.items = saved; fail("Pins " + x + " and " + y + " of " + part.ref + " could not be re-wired automatically; swap their wires by hand."); }
      return moved + " connection" + (moved === 1 ? "" : "s") + " moved";
    }
  };
  // Moves what connects at pin end px to py and back: wire ends (with an orthogonal dogleg
  // when the wire leaves straight), net labels, power ports, ports and junctions.
  function rewire(sheet, part, px, py) {
    const eq = (p, q) => Math.abs(p[0] - q[0]) < 1e-4 && Math.abs(p[1] - q[1]) < 1e-4;
    const grid = sheet.grid || 1.27;
    let n = 0;
    // The two wires cross over diagonally between one and two grid steps from the pins, so
    // neither gets a vertex on the other: [new end, 1 step out, 2 steps out on the old line, …].
    const repath = (pts, end) => {
      const from = pts[0], to = end, nx = pts[1];
      if (!nx) return [to];
      const horiz = Math.abs(nx[1] - from[1]) < 1e-6 && Math.abs(to[0] - from[0]) < 1e-6, vert = Math.abs(nx[0] - from[0]) < 1e-6 && Math.abs(to[1] - from[1]) < 1e-6, L = near(from, nx);
      if ((horiz || vert) && L > 2 * grid + 1e-6) {
        const u = [(nx[0] - from[0]) / L, (nx[1] - from[1]) / L];
        return [to, [to[0] + u[0] * grid, to[1] + u[1] * grid], [from[0] + u[0] * 2 * grid, from[1] + u[1] * 2 * grid], ...pts.slice(1)];
      }
      return [to, ...pts.slice(1)];
    };
    // Changed objects are replaced, never edited: the ECO dry run shares unchanged sheet objects.
    sheet.items = sheet.items.map(i => {
      if (i === part) return i;
      if (i.kind === "wire" && i.points?.length > 1) {
        const pts = i.points;
        for (const [p, q] of [[px, py], [py, px]]) {
          if (eq(pts[0], p)) { n++; return {...i, points: repath(pts, q)}; }
          if (eq(pts.at(-1), p)) { n++; return {...i, points: repath(pts.slice().reverse(), q).reverse()}; }
        }
      } else if (i.kind !== "part" && Number.isFinite(i.x) && Number.isFinite(i.y)) {
        if (eq([i.x, i.y], px)) { n++; return {...i, x: py[0], y: py[1]}; }
        if (eq([i.x, i.y], py)) { n++; return {...i, x: px[0], y: px[1]}; }
      }
      return i;
    });
    return n;
  }
  let registered = false;
  function register() {
    const E = globalThis.AtriumECO;
    if (registered) return true;
    if (!E?.extendSch) return false;
    E.extendSch("gateSwap", {group: "Swap Gates", label: "Swap gates", run: SCH.gateSwap, plan: ecoPlanner});
    E.extendSch("pinSwap", {group: "Swap Pins", label: "Swap pins", run: SCH.pinSwap});
    registered = true;
    return true;
  }
  register();

  // ------------------------------------------------------------------ interactive tool
  let host = null, tool = null, proposal = null;
  const el = (t, x, c) => AtriumNavCommon.el(t, x, c);
  function needECO() { return globalThis.AtriumECO ? Promise.resolve() : globalThis.AtriumLazy?.need?.("AtriumECO") || Promise.resolve(); }
  function board() { const d = host.doc(); return d?.kind === "pcb" ? d : null; }
  // The part pad under a client point of the active pane.
  function padAt(e) {
    const d = board(); if (!d) return null;
    const pane = host.panes().find(p => p.active); if (!pane || e.target !== pane.canvas) return null;
    const r = pane.canvas.getBoundingClientRect(), w = pane.view.screenToWorld([e.clientX - r.left, e.clientY - r.top]), defs = host.defs();
    const slack = 4 / (pane.view.scale?.() || 1);
    let best = null, bd = Infinity;
    const cand = pane.view.query ? pane.view.query(d, defs, [w[0] - 3, w[1] - 3, w[0] + 3, w[1] + 3]) : d.items;
    for (const i of cand) {
      if (i.kind !== "part") continue;
      const def = defs.get(i.def); if (!def?.footprint) continue;
      for (const p of A().pins(i, def, "pcb")) {
        const dd = near(p.at, w), reach = Math.max(p.w || 0, p.h || 0, p.diameter || 0) / 2 + slack;
        if (dd <= reach && dd < bd) { bd = dd; best = {part: i, number: String(p.number), at: p.at}; }
      }
    }
    return best;
  }
  function describe(r) {
    const b = r.back, parts = [];
    if (r.unrouted) parts.push(r.unrouted + " track" + (r.unrouted === 1 ? "" : "s") + " unrouted");
    if (r.renetted) parts.push(r.renetted + " re-netted");
    if (b) parts.push(b.applied ? "schematic updated (" + b.applied + " change" + (b.applied === 1 ? "" : "s") + ")" : b.failed ? "schematic: " + b.messages[0] : b.messages?.[0] || "schematic already matches");
    return parts.join(" · ");
  }
  function commit(plans, what) {
    const d = board(), project = host.project();
    let res = null;
    try { host.edit(() => { res = applyPlans(project, d, host.defs(), plans); }); }
    catch (e) { host.info(e.message); return null; }
    host.info(what + (describe(res) ? " · " + describe(res) : ""));
    return res;
  }
  function startTool(kind) {
    if (!board()) { host.info("Open a PCB layout to swap pins or gates."); return; }
    stopTool();
    tool = {kind, first: null, hover: null};
    host.info(kind === "gate" ? "Gate swap: click a pin of the first gate, then the matching pin of another gate of the same part. Escape ends."
      : "Pin swap: click the first pad, then a swap-equivalent pad of the same part (highlighted). Escape ends.");
    host.redraw();
  }
  function stopTool(msg) { if (!tool) return; tool = null; if (msg) host.info(msg); host.redraw(); }
  // What a second pad would do with the first: a pin plan, a gate plan or a reason.
  function planFor(a, b) {
    const d = board(), defs = host.defs();
    if (a.part.id !== b.part.id) return {error: "Both pads must belong to " + a.part.ref + "."};
    const def = libDef(defs, a.part), ua = gateOf(def, a.number), ub = gateOf(def, b.number);
    try {
      if (tool.kind !== "gate" && peers(def, a.number).includes(b.number)) return {plan: planPin(d, defs, a.part.id, a.number, b.number)};
      if (ua && ub && ua !== ub) return {plan: planGate(d, defs, a.part.id, ua, ub)};
      if (tool.kind === "gate") return {error: "Click a pin of another gate of " + a.part.ref + "."};
      return {error: "Pin " + b.number + " is not swap-equivalent with pin " + a.number + "."};
    } catch (e) { return {error: e.message}; }
  }
  function candidates(a) {
    const def = libDef(host.defs(), a.part), out = new Set(tool.kind === "gate" ? [] : peers(def, a.number)), u = gateOf(def, a.number);
    if (u) for (const g of info(def).gateGroups) if (g.includes(u)) for (const v of g) if (v !== u) for (const [x, y] of info(def).pairs(u, v)) if (x === a.number) out.add(y);
    return out;
  }
  function onDown(e) {
    if (!tool || e.button !== 0) { if (tool && e.button === 2) { e.preventDefault(); e.stopPropagation(); stopTool("Swap ended."); } return; }
    const pane = host.panes().find(p => p.active); if (!pane || e.target !== pane.canvas) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation?.();
    const hit = padAt(e);
    if (!hit) { host.info("Click a pad of a component."); return; }
    if (!tool.first) {
      const c = candidates(hit);
      if (!c.size) { host.info(hit.part.ref + "-" + hit.number + " has no " + (tool.kind === "gate" ? "equivalent gate" : "swap-equivalent pins") + ". Set a Swap group in the symbol's pin table (Library › Edit Symbol)."); return; }
      tool.first = hit; host.info("Now click " + (tool.kind === "gate" ? "the matching pin of another gate" : "a highlighted pad") + " of " + hit.part.ref + " (" + c.size + " candidate" + (c.size === 1 ? "" : "s") + ")."); host.redraw(); return;
    }
    const r = planFor(tool.first, hit);
    if (r.error) { host.info(r.error); return; }
    needECO().then(() => { commit([r.plan], "Swapped " + r.plan.label); if (tool) { tool.first = null; host.redraw(); } }, err => host.info(err.message));
  }
  function onMove(e) {
    if (!tool) return;
    const h = padAt(e);
    if ((h?.number || "") + (h?.part.id || "") !== (tool.hover?.number || "") + (tool.hover?.part.id || "")) { tool.hover = h; host.redraw(); }
  }
  function ring(ctx, at, r, color, px, dash) {
    ctx.beginPath(); ctx.arc(at[0], at[1], r, 0, Math.PI * 2); ctx.strokeStyle = color; ctx.lineWidth = 2 * px;
    if (dash) ctx.setLineDash([4 * px, 3 * px]); ctx.stroke(); ctx.setLineDash([]);
  }
  function lineSet(ctx, lines, color, px, dash) {
    ctx.strokeStyle = color; ctx.lineWidth = 1.5 * px; if (dash) ctx.setLineDash([5 * px, 4 * px]);
    for (const [a, b] of lines) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
    ctx.setLineDash([]);
  }
  function overlay(ctx, {scale}) {
    const px = 1 / scale, d = board(); if (!d) return;
    ctx.save();
    if (tool) {
      const defs = host.defs();
      if (tool.first) {
        ring(ctx, tool.first.at, 10 * px, "#ffd33d", px);
        for (const n of candidates(tool.first)) { const p = padOf(defs, tool.first.part, n); if (p) ring(ctx, p.at, 8 * px, "#7ee787", px, true); }
        // Live preview: the airwires after the swap the hovered pad would make.
        const h = tool.hover;
        if (h && h.part.id === tool.first.part.id && h.number !== tool.first.number) {
          const r = planFor(tool.first, h);
          if (r.plan) {
            const terms = terminals(d, defs), lines = {before: [], after: []};
            for (const [x, y] of r.plan.pairs) for (const [n, m] of [[x, y], [y, x]]) {
              const at = padOf(defs, h.part, n)?.at; if (!at) continue;
              const tb = target(terms, netOf(h.part, n), at, h.part.id), ta = target(terms, netOf(h.part, m), at, h.part.id);
              if (tb) lines.before.push([at, tb]); if (ta) lines.after.push([at, ta]);
            }
            lineSet(ctx, lines.before, "rgba(255,107,107,.8)", px, true); lineSet(ctx, lines.after, "#7ee787", px, false);
          }
        }
      } else if (tool.hover) ring(ctx, tool.hover.at, 8 * px, "#ffd33d", px, true);
    }
    if (proposal) for (const p of proposal.list) if (proposal.checked.has(p)) { lineSet(ctx, p.lines.before, "rgba(255,107,107,.75)", px, true); lineSet(ctx, p.lines.after, "#7ee787", px, false); }
    ctx.restore();
  }
  // Automatic Net/Pin Optimizer: a non-modal proposal list with a live preview on the board.
  function openOptimiser() {
    const d = board(); if (!d) { host.info("Open a PCB layout to optimise pin and gate assignments."); return; }
    document.querySelectorAll("dialog.pin-swap-dialog").forEach(x => x.close());
    const sel = host.selection().filter(id => d.items.some(i => i.id === id && i.kind === "part"));
    const run = (routed) => optimise(d, host.defs(), {parts: sel.length ? sel : null, includeRouted: routed});
    const dlg = el("dialog", null, "ui-dialog ui-sheet message-dialog pin-swap-dialog"); dlg.setAttribute("aria-label", "Automatic Net/Pin Optimizer");
    const head = el("h2", "Automatic Net/Pin Optimizer", "ui-dialog-title");
    const scope = el("p", (sel.length ? sel.length + " selected component" + (sel.length === 1 ? "" : "s") : "All components") + " · equivalent pins (Swap groups) and gates. Red: airwires now; green: after the swap.", "side-note");
    const routedBox = el("input", null, "ui-checkbox"); routedBox.type = "checkbox";
    const routedLabel = el("label", null, "pcb-edit-check"); routedLabel.append(routedBox, el("span", " Include routed pads (their tracks are unrouted)"));
    const list = el("div", null, "pin-swap-list ui-dialog-body"), sum = el("p", null, "pin-swap-sum");
    const close = () => dlg.close();
    const apply = el("button", "Apply", "ui-button"); apply.dataset.variant = "primary"; apply.type = "button";
    const cancel = el("button", "Cancel", "ui-button"); cancel.type = "button"; cancel.onclick = close;
    function paint() {
      const items = run(routedBox.checked);
      proposal = {list: items, checked: new Set(items)};
      list.replaceChildren();
      if (!items.length) list.append(el("p", "No swap shortens the ratsnest. Equivalent pins need a Swap group in the symbol's pin table; gates are equivalent when their pins match.", "pin-swap-empty"));
      for (const p of items) {
        const row = el("label", null, "pin-swap-row"), box = el("input", null, "ui-checkbox"); box.type = "checkbox"; box.checked = true;
        box.onchange = () => { if (box.checked) proposal.checked.add(p); else proposal.checked.delete(p); total(); host.redraw(); };
        row.onpointerenter = () => host.redraw();
        const what = el("span", (p.kind === "gate" ? "Gate swap " : "Pin swap ") + p.label, "pin-swap-what");
        const gain = el("span", "−" + (p.before.length - p.after.length).toFixed(2) + " mm" + (p.before.crossings !== p.after.crossings ? " · crossings " + p.before.crossings + " → " + p.after.crossings : ""), "pin-swap-gain");
        row.append(box, what, gain); list.append(row);
      }
      total(); host.redraw();
    }
    function total() {
      const on = proposal.list.filter(p => proposal.checked.has(p)), g = on.reduce((s, p) => s + p.before.length - p.after.length, 0);
      sum.textContent = on.length ? on.length + " of " + proposal.list.length + " swaps · ratsnest −" + g.toFixed(2) + " mm" : "No swaps chosen.";
      apply.disabled = !on.length;
    }
    routedBox.onchange = paint;
    apply.onclick = () => {
      const on = proposal.list.filter(p => proposal.checked.has(p));
      needECO().then(() => { commit(on, on.length + " swap" + (on.length === 1 ? "" : "s") + " applied"); close(); }, e => host.info(e.message));
    };
    const foot = el("div", null, "pin-swap-actions ui-dialog-actions"); foot.append(cancel, apply);
    dlg.append(head, scope, routedLabel, list, sum, foot);
    dlg.addEventListener("close", () => { proposal = null; dlg.remove(); host.redraw(); }, {once: true});
    dlg.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); close(); } });
    document.body.append(dlg); globalThis.AtriumShell?.adoptDialog?.(dlg); dlg.show(); paint(); cancel.focus();
  }
  // Diff-pair router hint: is swapping these two pins of a part allowed? (pin swap suggestion)
  function canSwap(board_, defs, partId, a, b) {
    try { planPin(board_, defs, partId, a, b); return true; } catch { return false; }
  }
  function swapNow(partId, a, b) {
    const d = board(); if (!d) return null;
    let plan; try { plan = planPin(d, host.defs(), partId, a, b); } catch (e) { host.info(e.message); return null; }
    return needECO().then(() => commit([plan], "Swapped " + plan.label));
  }
  // Diff-pair routing that arrives crossed at two swap-equivalent pins: a one-click chip.
  let chip = null, chipKey = "";
  function crossedChip() {
    const live = host.liveRoute?.(), c = live?.preview?.crossed, d = board();
    const ok = c?.partId && d && canSwap(d, host.defs(), c.partId, c.pins[0], c.pins[1]);
    const key = ok ? c.partId + "|" + c.pins.join("|") : "";
    if (key === chipKey) return;
    chipKey = key;
    if (!ok) { if (chip) chip.hidden = true; return; }
    if (!chip) {
      // A small library popover above the canvas: a warning dot, what is crossed and the one action.
      chip = el("div", null, "ui-popover pin-swap-hint"); chip.setAttribute("role", "status");
      const dot = el("span", null, "ui-dot"); dot.dataset.tone = "warning"; chip.append(dot);
      const action = el("button", "Swap pins", "ui-button");
      action.type = "button"; action.dataset.variant = "primary"; action.dataset.size = "sm";
      chip.append(el("span"), action);
      document.body.append(chip);
    }
    chip.children[1].textContent = "The pair arrives crossed at " + (c.ref || "the part") + " pins " + c.pins[0] + " and " + c.pins[1] + ", which are swappable.";
    const btn = chip.lastChild; btn.textContent = "Swap pins " + c.pins[0] + " ↔ " + c.pins[1]; btn.title = "Finish the routed section and swap the two pins (one undo step for the swap)";
    btn.onclick = () => { chip.hidden = true; chipKey = ""; host.executeKey?.("escape"); swapNow(c.partId, c.pins[0], c.pins[1])?.then?.(() => host.info("Pins " + c.pins[0] + " ↔ " + c.pins[1] + " of " + (c.ref || "the part") + " swapped. Route the last section of the pair again: it now arrives uncrossed.")); };
    const pane = host.panes().find(p => p.active), r = pane?.canvas.getBoundingClientRect();
    chip.hidden = false;
    if (r) { const w = chip.getBoundingClientRect().width; chip.style.left = Math.max(8, r.left + r.width / 2 - w / 2) + "px"; chip.style.top = Math.max(8, r.top + 52) + "px"; }
  }
  function attach(h) {
    host = h;
    host.addRenderer(() => { try { if (typeof document !== "undefined") crossedChip(); } catch { /* no live route */ } return null; });
    host.registerAction("pin-swap", () => startTool("pin"));
    host.registerAction("gate-swap", () => startTool("gate"));
    host.registerAction("swap-optimise", openOptimiser);
    host.addRenderer(d => (tool || proposal) && d.kind === "pcb" ? {overlay} : null);
    host.on?.("document", () => { stopTool(); });
    if (typeof window === "undefined") return;
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("contextmenu", e => { if (tool) { e.preventDefault(); e.stopPropagation(); } }, true);
    window.addEventListener("keydown", e => { if (tool && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stopTool("Swap ended."); } }, true);
  }
  globalThis.AtriumNavCommon?.ready?.(attach);

  return Object.freeze({info, peers, gatePairs, gateOf, planPin, planGate, applyBoard, optimise, applyPlans, backAnnotate, ecoPlanner, SCH, rewire, register,
    terminals, canSwap, swapNow, start: k => host && startTool(k === "gate" ? "gate" : "pin"), optimiser: () => host && openOptimiser(), attach});
})();
