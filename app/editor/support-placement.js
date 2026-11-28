"use strict";
// Smart placement of support components (Tools › Component Placement › Place Decoupling,
// Place Terminations, Place Support Components; MCP place_support_components).
//
// Associations are inferred from the netlist on the board (pad nets) and the schematic
// (sheets, symbol positions, pin names and electrical types):
//   decoupling  a capacitor below 1 µF between an IC power-pin net and ground. It belongs to one
//               power pin of that IC: the pin drawn nearest the capacitor on the same sheet, with
//               the capacitors of one net spread over its pins (one per pin before a second).
//   bulk        the same at 1 µF and above; it goes behind the small capacitors of its pin.
//   crystal     a crystal or resonator whose two signal pads reach two pins of one IC.
//   load        a capacitor from a crystal pad to ground (crystal load capacitor).
//   termination a two-pin R, C, L or ferrite in series on a point-to-point net: next to the
//               driver pin (source termination, default) or the receiver ("receiver" preference).
//   pullup /    a resistor from a signal to a power net (or to ground), next to the IC pin on
//   pulldown    that signal.
//   connector   optional: snapped to the nearest board edge.
// Overrides are stored with the board: board.sync.support[partId] = {kind:"none"} turns a part's
// association off; {kind, ref, pin} sets it by hand. Place preferences: board.sync.place.
//
//   associate(project, board, opts)  -> {roles: [Role], notes}
//   propose(project, board, opts)    -> {moves: [Move], skipped: [...], notes, roles}
//   apply(project, board, proposal, {ids, vias})  -> moves applied (call inside one editor edit)
//   explain(role)                    -> "Decoupling for U3 pin 12 VDD (100 nF, 0402)"
//   headless(args, host)             -> the MCP tool place_support_components
// Role: {id, ref, kind, net, ground, value, farads, size, target: {id, ref, pin, pinName, net}, reason, manual}
// Move: {id, ref, kind, from: {x, y, angle, layer}, to: {x, y, angle, layer}, target, anchor, near, distance, far, via}
globalThis.AtriumSupportPlace = (() => {
  const A = () => globalThis.Atrium;
  const fail = m => { throw Error(m); };
  const natural = typeof Intl !== "undefined" ? new Intl.Collator("en", {numeric: true}).compare : (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const r4 = v => Math.round(v * 1e4) / 1e4 + 0;
  const snap = (v, g = 0.05) => r4(Math.round(v / g) * g);
  // net-intent.js (isGround) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const GROUND_RE = /^(?:[ADPSC]?GND\w*|GND\w*|[AD]?VSS\w*|VSS\w*|0V|EARTH\w*|CHASSIS\w*)$/i;
  const GROUND = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isGround ? N.isGround(String(n ?? "")) : GROUND_RE.test(n); }};
  // net-intent.js (isRail) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const POWER_RE = /^(?:[+-]?\d+(?:[.,V]\d*)?V\w*|\+?\d+V\d*\w*|V(?:DD|CC|EE|BAT|BUS|IN|SYS|REF|IO|CORE|CAP)\w*|[AD]VDD\w*|[AD]VCC\w*|PWR\w*|VDD|VCC|P\d+V\d*\w*)$/i;
  const POWER = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isRail ? N.isRail(String(n ?? "")) : POWER_RE.test(n); }};
  const isGround = n => GROUND.test(String(n || ""));
  const isPowerName = n => !!n && !isGround(n) && POWER.test(String(n));
  const KINDS = ["decoupling", "bulk", "crystal", "load", "termination", "pullup", "pulldown", "connector"];
  const LABEL = {decoupling: "Decoupling", bulk: "Bulk decoupling", crystal: "Crystal", load: "Crystal load capacitor", termination: "Series termination",
    pullup: "Pull-up", pulldown: "Pull-down", connector: "Connector (board edge)", none: "No placement role"};
  const SETS = {decoupling: ["decoupling", "bulk"], terminations: ["termination"], support: ["crystal", "load", "decoupling", "bulk", "termination", "pullup", "pulldown", "connector"]};
  const DEFAULTS = {side: "same", termination: "source", connectors: false, maxDistance: 5, gap: 0.25, vias: false};

  // ------------------------------------------------------------------ values
  const MULT = {p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, "μ": 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, R: 1, r: 1, "": 1};
  // "100 nF", "0.1uF", "4u7", "10k", "4R7" -> number (farads, ohms, ...), or NaN.
  function quantity(v) {
    const s = String(v ?? "").trim().replace(",", ".");
    let m = s.match(/^(\d+)([pnuµμmkKMGRr])(\d+)\b/);
    const q = (v, k) => Number((v * MULT[k]).toPrecision(12));
    if (m) return q(Number(m[1] + "." + m[3]), m[2]);
    m = s.match(/^(\d+(?:\.\d+)?|\.\d+)\s*([pnuµμmkKMG]?)/);
    return m ? q(Number(m[1]), m[2]) : NaN;
  }
  const farads = v => quantity(v);
  function showFarads(f) {
    if (!Number.isFinite(f)) return "";
    for (const [u, k] of [["µF", 1e-6], ["nF", 1e-9], ["pF", 1e-12]]) if (f >= k * 0.999) return +(f / k).toPrecision(3) + " " + u;
    return f + " F";
  }
  // Short package of a footprint name: 0402, 0603, SOT-23, ... else the name.
  const METRIC = {"0402": "01005", "0603": "0201", "1005": "0402", "1608": "0603", "2012": "0805", "3216": "1206", "3225": "1210", "5025": "2010", "6332": "2512"};
  function sizeOf(fp) {
    const n = String(fp?.name || "");
    let m = n.match(/^(?:CAP|RES|IND|LED|DIO|FUS|BEAD)[A-Z]*C(\d{4})X/i);
    if (m) return METRIC[m[1]] || m[1];
    m = n.match(/(?:^|[_\-\s])(01005|0201|0402|0603|0805|1206|1210|2010|2512)(?=$|[_\-\s])/) || n.match(/(SOT-?\d+(?:-\d)?|SOD-?\d+|3225|2520|2016|5032)/i);
    return m ? m[1] : n;
  }

  // ------------------------------------------------------------------ the board model
  const baseLink = l => { const s = String(l || ""), at = s.indexOf("@"); return at >= 0 ? s.slice(0, at) : s; };
  function courtyardBox(fp) {
    if (Array.isArray(fp?.courtyard) && fp.courtyard.length === 4 && fp.courtyard.every(Number.isFinite)) return fp.courtyard.slice();
    const b = A().bounds(A().symbolPoints(fp)) || [-0.5, -0.5, 0.5, 0.5];
    return [b[0] - 0.25, b[1] - 0.25, b[2] + 0.25, b[3] + 0.25];
  }
  function rotBox(b, angle) {
    const pts = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(p => A().rotate(p, angle || 0));
    return A().bounds(pts);
  }
  const worldBox = (local, x, y, angle) => { const b = rotBox(local, angle); return [b[0] + x, b[1] + y, b[2] + x, b[3] + y]; };
  const center = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const hits = (a, b, gap = 0) => a[0] < b[2] + gap - 1e-9 && b[0] < a[2] + gap - 1e-9 && a[1] < b[3] + gap - 1e-9 && b[1] < a[3] + gap - 1e-9;
  function inside(poly, p) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  const boxInside = (poly, b) => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].every(p => inside(poly, p));

  function model(project, board) {
    const defs = new Map(project.library.map(d => [d.id, d])), sch = new Map();
    for (const d of project.documents) if (d.kind === "schematic") for (const i of d.items) if (i.kind === "part" && i.link) sch.set(i.link, {item: i, doc: d});
    const parts = [], byId = new Map(), nets = new Map();
    for (const it of board.items) {
      if (it.kind !== "part") continue;
      const def = defs.get(it.def), fp = def?.footprint;
      if (!fp) continue;
      const s = sch.get(baseLink(it.link)) || null, sdef = s ? defs.get(s.item.def) : (def.symbol ? def : defs.get(def.mirrorOf));
      const names = new Map();
      for (const p of sdef?.symbol?.pins || []) names.set(String(p.number), {name: String(p.name ?? ""), electrical: p.electrical});
      const pads = [];
      for (const pad of fp.pads || []) {
        const n = String(pad.number ?? "");
        if (!n || pad.thermalVia) continue;
        const net = it.pinNets && Object.prototype.hasOwnProperty.call(it.pinNets, n) ? it.pinNets[n] : (pad.net || "");
        if (pads.some(q => q.number === n)) continue;
        pads.push({number: n, net, local: [pad.x, pad.y], w: pad.w, h: pad.h, at: A().world([pad.x, pad.y], it), name: names.get(n)?.name || n, electrical: names.get(n)?.electrical});
      }
      const ref = String(it.ref || ""), prefix = (ref.match(/^[A-Za-z_]+/) || [""])[0].toUpperCase();
      const cat = String(def.category || sdef?.category || ""), dname = String(def.name || "") + " " + String(fp.name || "");
      let type = "other";
      if (/^(J|CN|CON|P|USB)$/.test(prefix) || /connector/i.test(cat) || /header|connector|receptacle/i.test(dname)) type = "connector";
      if (/^(Y|XTAL|XT|OSC)$/.test(prefix) || /frequency|crystal|resonator/i.test(cat + " " + dname)) type = "crystal";
      if (/^(U|IC)$/.test(prefix) && pads.length >= 3) type = "ic";
      if (pads.length === 2 && /^(R|RN|C|L|FB|BEAD|FL)$/.test(prefix)) type = prefix === "C" ? "cap" : prefix === "R" || prefix === "RN" ? "res" : "series";
      if (pads.length === 2 && type === "other" && /capacitor/i.test(cat + dname)) type = "cap";
      const local = courtyardBox(fp);
      const r = {id: it.id, item: it, ref, prefix, type, def, fp, sdef, sch: s, pads, local, box: worldBox(local, it.x, it.y, it.angle),
        value: String(it.value ?? ""), side: it.layer === "Bottom" ? "Bottom" : "Top", locked: it.locked === true};
      parts.push(r); byId.set(it.id, r);
      for (const p of pads) if (p.net) { if (!nets.has(p.net)) nets.set(p.net, []); nets.get(p.net).push({part: r, pad: p}); }
    }
    // Schematic positions of pins, for "drawn near" and pin names.
    for (const r of parts) {
      r.schPins = new Map();
      if (!r.sch) continue;
      const g = A().pins(r.sch.item, r.sdef, "schematic");
      for (const p of g) r.schPins.set(String(p.number), p.at);
    }
    return {project, board, defs, parts, byId, nets};
  }
  const powerish = (M, net) => isPowerName(net) || (!isGround(net) && (M.nets.get(net) || []).some(e => e.part.type === "ic" && e.pad.electrical === 7));
  const schDist = (a, b, pin) => {
    if (!a.sch || !b.sch) return 400;
    if (a.sch.doc.id !== b.sch.doc.id) return 1000 + Math.hypot(a.sch.item.x - b.sch.item.x, a.sch.item.y - b.sch.item.y) * 0.01;
    const at = pin != null && b.schPins.get(String(pin)) || [b.sch.item.x, b.sch.item.y];
    return Math.hypot(a.sch.item.x - at[0], a.sch.item.y - at[1]);
  };
  const target = (part, pad) => ({id: part.id, ref: part.ref, pin: pad.number, pinName: pad.name, net: pad.net});

  // ------------------------------------------------------------------ associations
  function associate(project, board, opts = {}) {
    const M = opts.model || model(project, board), roles = [], notes = [], taken = new Set();
    const over = board.sync?.support || {};
    const role = (r, kind, tgt, extra = {}) => {
      const x = {id: r.id, ref: r.ref, kind, value: r.value, size: sizeOf(r.fp), target: tgt, ...extra};
      roles.push(x); taken.add(r.id); return x;
    };
    const ics = M.parts.filter(r => r.type === "ic");
    // Manual overrides first.
    for (const r of M.parts) {
      const o = over[r.id];
      if (!o || typeof o !== "object") continue;
      if (o.kind === "none") { taken.add(r.id); continue; }
      if (!KINDS.includes(o.kind)) continue;
      const t = M.parts.find(q => q.ref === o.ref), pad = t?.pads.find(p => p.number === String(o.pin ?? ""));
      if (o.kind === "connector") { role(r, "connector", null, {manual: true, reason: "Set by hand."}); continue; }
      if (!t || !pad) { notes.push(r.ref + ": its placement role names " + (o.ref || "?") + " pin " + (o.pin ?? "?") + ", which is not on the board. Detected instead."); continue; }
      const g = r.pads.find(p => isGround(p.net)), other = r.pads.find(p => p !== g && p.net === pad.net) || r.pads.find(p => p !== g);
      role(r, o.kind, target(t, pad), {manual: true, net: other?.net || "", ground: g?.net || "", farads: farads(r.value), reason: "Set by hand in Properties."});
    }
    // Crystals: two signal pads that reach two pins of one IC.
    const crystals = [];
    for (const r of M.parts.filter(r => r.type === "crystal" && !taken.has(r.id))) {
      const sig = r.pads.filter(p => p.net && !isGround(p.net) && !isPowerName(p.net));
      const hitsIC = sig.map(p => (M.nets.get(p.net) || []).filter(e => e.part.type === "ic"));
      const common = ics.filter(ic => hitsIC.every(l => l.some(e => e.part === ic)));
      if (sig.length < 2 || !common.length) continue;
      const ic = common.sort((a, b) => schDist(r, a) - schDist(r, b) || natural(a.ref, b.ref))[0];
      const pins = sig.map(p => (M.nets.get(p.net) || []).find(e => e.part === ic).pad);
      const x = role(r, "crystal", target(ic, pins[0]), {pins: pins.map(p => p.number), net: sig[0].net,
        reason: "Its pads " + sig.map(p => p.number).join(" and ") + " reach " + ic.ref + " pins " + pins.map(p => p.number + " " + p.name).join(" and ") + " (oscillator)."});
      crystals.push({r, ic, x, sig});
    }
    // Two-pin parts.
    const two = M.parts.filter(r => r.pads.length === 2 && !taken.has(r.id) && ["cap", "res", "series"].includes(r.type));
    // Crystal load capacitors.
    for (const c of two.filter(r => r.type === "cap")) {
      const g = c.pads.find(p => isGround(p.net)), o = c.pads.find(p => p !== g);
      if (!g || !o?.net) continue;
      const x = crystals.find(k => k.sig.some(p => p.net === o.net));
      if (!x) continue;
      const pad = x.r.pads.find(p => p.net === o.net);
      role(c, "load", target(x.r, pad), {net: o.net, ground: g.net, farads: farads(c.value),
        reason: "Capacitor from " + o.net + " (crystal " + x.r.ref + " pad " + pad.number + ") to " + g.net + "."});
    }
    // Decoupling and bulk: a capacitor between an IC power-pin net and ground.
    const caps = [];
    for (const c of two.filter(r => r.type === "cap" && !taken.has(r.id))) {
      const g = c.pads.find(p => isGround(p.net)), pw = c.pads.find(p => p !== g && p.net && powerish(M, p.net));
      if (!g || !pw) continue;
      const pins = [];
      for (const e of M.nets.get(pw.net) || []) if (e.part.type === "ic") pins.push(e);
      if (!pins.length) continue;
      caps.push({c, g, pw, pins, f: farads(c.value)});
    }
    const load = new Map(), bulkLoad = new Map(), key = e => e.part.id + "/" + e.pad.number;
    const small = caps.filter(x => !(x.f >= 1e-6)), bulk = caps.filter(x => x.f >= 1e-6);
    // The capacitors nearest their IC on the schematic choose first; smaller values first.
    const near = x => Math.min(...x.pins.map(e => schDist(x.c, e.part, e.pad.number)));
    small.sort((a, b) => near(a) - near(b) || (a.f || 0) - (b.f || 0) || natural(a.c.ref, b.c.ref));
    for (const x of small) {
      let best = null;
      for (const e of x.pins) {
        const cost = schDist(x.c, e.part, e.pad.number) + 25 * (load.get(key(e)) || 0);
        if (!best || cost < best.cost - 1e-9 || Math.abs(cost - best.cost) < 1e-9 && natural(e.part.ref + "." + e.pad.number, best.e.part.ref + "." + best.e.pad.number) < 0) best = {e, cost};
      }
      load.set(key(best.e), (load.get(key(best.e)) || 0) + 1);
      const d = schDist(x.c, best.e.part, best.e.pad.number);
      role(x.c, "decoupling", target(best.e.part, best.e.pad), {net: x.pw.net, ground: x.g.net, farads: x.f,
        reason: "Capacitor between " + x.pw.net + " and " + x.g.net + "; " + (d < 1000 ? "drawn " + Math.round(d) + " mm from this pin on " + (x.c.sch?.doc.name || "the same sheet") : "on another sheet than the IC") + "."});
    }
    for (const x of bulk.sort((a, b) => near(a) - near(b) || natural(a.c.ref, b.c.ref))) {
      let best = null;
      for (const e of x.pins) {
        const cost = schDist(x.c, e.part, e.pad.number) + 40 * (bulkLoad.get(key(e)) || 0);
        if (!best || cost < best.cost - 1e-9) best = {e, cost};
      }
      bulkLoad.set(key(best.e), (bulkLoad.get(key(best.e)) || 0) + 1);
      role(x.c, "bulk", target(best.e.part, best.e.pad), {net: x.pw.net, ground: x.g.net, farads: x.f,
        reason: "Bulk capacitor (" + showFarads(x.f) + ") on " + x.pw.net + "; placed behind the smaller capacitors of this pin."});
    }
    // Pull-ups and pull-downs: a resistor from a signal to a power net or ground.
    for (const r of two.filter(r => r.type === "res" && !taken.has(r.id))) {
      const rail = r.pads.find(p => isGround(p.net) || powerish(M, p.net)), sig = r.pads.find(p => p !== rail);
      if (!rail || !sig?.net || isGround(sig.net) || powerish(M, sig.net)) continue;
      const ends = (M.nets.get(sig.net) || []).filter(e => e.part !== r && e.part.type === "ic");
      if (!ends.length) continue;
      const e = ends.sort((a, b) => schDist(r, a.part, a.pad.number) - schDist(r, b.part, b.pad.number) || natural(a.part.ref, b.part.ref))[0];
      const down = isGround(rail.net);
      role(r, down ? "pulldown" : "pullup", target(e.part, e.pad), {net: sig.net, ground: rail.net,
        reason: "Resistor from " + sig.net + " to " + rail.net + "; " + e.part.ref + " pin " + e.pad.number + " " + e.pad.name + " is on " + sig.net + "."});
    }
    // Series terminations: both nets point to point (the part and one other pin each).
    // Driver rank: an output pin, then I/O, passive or unknown pins, a connector (driven off the
    // board), then an input pin (never the driver).
    const rank = e => e.part.type === "ic" ? (e.pad.electrical === 2 ? 3 : e.pad.electrical === 1 || e.pad.electrical === 3 ? 2 : e.pad.electrical === 0 ? 0 : 1.5) : e.part.type === "connector" ? 0.5 : 0.25;
    for (const r of two.filter(r => !taken.has(r.id))) {
      if (r.pads.some(p => !p.net || isGround(p.net) || powerish(M, p.net))) continue;
      const ends = r.pads.map(p => (M.nets.get(p.net) || []).filter(e => e.part !== r));
      if (ends.some(l => l.length !== 1)) continue;
      const [a, b] = ends.map(l => l[0]);
      if (a.part.type !== "ic" && b.part.type !== "ic") continue;
      const drv = rank(a) > rank(b) || rank(a) === rank(b) && schDist(r, a.part, a.pad.number) <= schDist(r, b.part, b.pad.number) ? a : b, rcv = drv === a ? b : a;
      const at = opts.termination === "receiver" && rcv.part.type === "ic" ? rcv : drv;
      role(r, "termination", target(at.part, at.pad), {net: at.pad.net, other: target(drv === at ? rcv.part : drv.part, drv === at ? rcv.pad : drv.pad), driver: drv === at,
        reason: "In series between " + a.part.ref + " pin " + a.pad.number + " and " + b.part.ref + " pin " + b.pad.number + "; " + drv.part.ref + " drives (" +
          (drv.pad.electrical === 2 ? "output pin" : rcv.pad.electrical === 0 ? rcv.part.ref + " pin " + rcv.pad.number + " is an input" : drv.part.type === "ic" && rcv.part.type !== "ic" ? "the IC side" : "nearest on the schematic") + ")."});
    }
    if (opts.connectors) for (const r of M.parts.filter(r => r.type === "connector" && !taken.has(r.id))) role(r, "connector", null, {reason: "Connector: snapped to the nearest board edge."});
    roles.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || natural(a.target?.ref || "", b.target?.ref || "") || natural(a.ref, b.ref));
    return {roles, notes, model: M};
  }
  function explain(r) {
    if (!r) return "";
    const what = r.kind === "decoupling" || r.kind === "bulk" || r.kind === "load" ? [showFarads(r.farads ?? farads(r.value)), r.size] : [r.value, r.size];
    const tail = " (" + what.filter(Boolean).join(", ") + ")";
    if (r.kind === "connector") return "Connector: snapped to the board edge" + tail;
    const t = r.target, pin = t ? t.ref + " pin " + t.pin + (t.pinName && t.pinName !== t.pin ? " " + t.pinName : "") : "";
    switch (r.kind) {
      case "decoupling": return "Decoupling for " + pin + tail;
      case "bulk": return "Bulk decoupling for " + pin + tail;
      case "crystal": return "Crystal for " + t.ref + " pins " + (r.pins || [t.pin]).join(" and ") + tail;
      case "load": return "Load capacitor for crystal " + t.ref + " pad " + t.pin + tail;
      case "termination": return "Series termination at " + pin + (r.driver === false ? " (receiver)" : " (driver)") + tail;
      case "pullup": return "Pull-up for " + pin + " to " + r.ground + tail;
      case "pulldown": return "Pull-down for " + pin + " to " + r.ground + tail;
    }
    return LABEL[r.kind] || r.kind;
  }

  // ------------------------------------------------------------------ placement
  function prefsOf(board, opts = {}) {
    const p = {...DEFAULTS, ...(board.sync?.place || {})};
    for (const k of Object.keys(DEFAULTS)) if (opts[k] !== undefined) p[k] = opts[k];
    p.maxDistance = Math.max(0.5, Math.min(50, +p.maxDistance || DEFAULTS.maxDistance));
    p.gap = Math.max(0, Math.min(5, +p.gap || 0));
    return p;
  }
  // Copper (tracks, vias, arcs) that touches a part's pads: such parts are never moved.
  function copperOn(board, M) {
    const out = new Set(), byNet = new Map();
    for (const r of M.parts) for (const p of r.pads) if (p.net) { if (!byNet.has(p.net)) byNet.set(p.net, []); byNet.get(p.net).push({r, p}); }
    const touch = (pt, {r, p}) => Math.abs(pt[0] - p.at[0]) <= Math.max(p.w, p.h) / 2 + 0.05 && Math.abs(pt[1] - p.at[1]) <= Math.max(p.w, p.h) / 2 + 0.05;
    for (const i of board.items) {
      if (!i.net || !(i.kind === "track" || i.kind === "via" || i.kind === "arc")) continue;
      const list = byNet.get(i.net); if (!list) continue;
      const pts = i.kind === "via" ? [[i.x, i.y]] : (i.points || [[i.x, i.y]]);
      for (const e of list) if (!out.has(e.r.id) && pts.some(pt => touch(pt, e))) out.add(e.r.id);
    }
    return out;
  }
  // Outward direction of a pad from its part, snapped to an axis.
  function outward(part, at) {
    const c = center(part.box), dx = at[0] - c[0], dy = at[1] - c[1];
    const b = part.box, w = b[2] - b[0], h = b[3] - b[1];
    // Distance to each side relative to its size picks the side the pin sits on.
    const fx = w ? dx / (w / 2) : 0, fy = h ? dy / (h / 2) : 0;
    return Math.abs(fx) >= Math.abs(fy) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dy) || 1];
  }
  const angleOf = v => Math.atan2(v[1], v[0]) * 180 / Math.PI;
  const norm = a => ((Math.round(a / 90) * 90) % 360 + 360) % 360;
  // Local pad positions, mirrored for the bottom side (pcb-edit.js mirrors footprints about Y).
  const localPads = (r, side) => r.pads.map(p => ({...p, local: side !== r.side ? [-p.local[0], p.local[1]] : p.local}));
  const localBox = (r, side) => side !== r.side ? [-r.local[2], r.local[1], -r.local[0], r.local[3]] : r.local;

  function propose(project, board, opts = {}) {
    const P = prefsOf(board, opts), kinds = new Set(opts.kinds || SETS[opts.set || "support"] || SETS.support);
    const asc = associate(project, board, {termination: P.termination, connectors: P.connectors && kinds.has("connector")});
    const M = asc.model, outline = Array.isArray(board.outline) && board.outline.length >= 3 ? board.outline : null;
    const copper = copperOn(board, M), skipped = [], notes = [...asc.notes];
    let roles = asc.roles.filter(r => kinds.has(r.kind));
    // Scope: the given parts (support parts, or ICs whose support parts move), else everything unplaced.
    const ids = opts.ids?.length ? new Set(opts.ids) : null;
    if (ids) roles = roles.filter(r => ids.has(r.id) || (r.target && ids.has(r.target.id)));
    else if (opts.scope !== "all") roles = roles.filter(r => { const p = M.byId.get(r.id); return !outline || !boxInside(outline, p.box); });
    const moving = new Set();
    for (const r of roles) {
      const p = M.byId.get(r.id);
      if (p.locked) { skipped.push({id: r.id, ref: r.ref, reason: "locked"}); continue; }
      if (copper.has(r.id)) { skipped.push({id: r.id, ref: r.ref, reason: "routed copper"}); continue; }
      moving.add(r.id);
    }
    roles = roles.filter(r => moving.has(r.id));
    // Obstacles per side: every part that stays put, plus copper near the targets.
    const obstacles = {Top: [], Bottom: []};
    for (const p of M.parts) if (!moving.has(p.id)) obstacles[p.side].push(p.box);
    const near = roles.map(r => r.target && M.byId.get(r.target.id)?.box).filter(Boolean);
    if (near.length) {
      const zone = near.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]).map((v, i) => v + (i < 2 ? -15 : 15));
      for (const i of board.items) {
        if (i.kind === "via") { const b = [i.x - i.diameter / 2, i.y - i.diameter / 2, i.x + i.diameter / 2, i.y + i.diameter / 2]; if (hits(b, zone)) { obstacles.Top.push(b); obstacles.Bottom.push(b); } continue; }
        if (i.kind !== "track" || !Array.isArray(i.points)) continue;
        const side = i.layer === "Bottom" ? "Bottom" : i.layer === "Top" ? "Top" : null, w = (i.width || 0.15) / 2;
        for (let k = 1; k < i.points.length; k++) {
          const a = i.points[k - 1], b = i.points[k], bb = [Math.min(a[0], b[0]) - w, Math.min(a[1], b[1]) - w, Math.max(a[0], b[0]) + w, Math.max(a[1], b[1]) + w];
          if (!hits(bb, zone)) continue;
          if (side) obstacles[side].push(bb);
        }
      }
    }
    const moves = [], order = {crystal: 0, load: 1, decoupling: 2, bulk: 3, termination: 4, pullup: 5, pulldown: 5, connector: 6};
    // Per pin: smaller capacitors first, so the smallest value sits closest.
    roles.sort((a, b) => order[a.kind] - order[b.kind] || natural(a.target?.ref || "", b.target?.ref || "") || natural(a.target?.pin || "", b.target?.pin || "") ||
      (a.farads ?? 0) - (b.farads ?? 0) || natural(a.ref, b.ref));
    const placed = new Map();
    for (const r of roles) {
      const part = M.byId.get(r.id);
      const m = r.kind === "connector" ? edgeMove(part, outline, obstacles, P) : place(M, part, r, obstacles, P, placed, outline);
      if (!m) { skipped.push({id: r.id, ref: r.ref, reason: "no room"}); continue; }
      m.kind = r.kind; m.role = r; m.text = explain(r);
      m.far = m.distance != null && m.distance > P.maxDistance + 1e-6;
      moves.push(m); obstacles[m.to.layer].push(m.box); placed.set(r.id, m);
    }
    const far = moves.filter(m => m.far);
    if (far.length) notes.push(far.length + " part" + (far.length === 1 ? " is" : "s are") + " farther than " + P.maxDistance + " mm from " + (far.length === 1 ? "its" : "their") + " pin: " + far.map(m => m.ref).join(", ") + ".");
    for (const s of skipped.filter(s => s.reason !== "no room")) notes.push(s.ref + " was not moved: " + (s.reason === "locked" ? "it is locked." : "routed copper is connected to it."));
    return {moves, skipped, notes, roles: asc.roles, prefs: P};
  }
  // Where a support part goes: its near pad as close as possible to the anchor (the target pin),
  // outside the target part's courtyard (same side), or under the pin (opposite side).
  // A part as this proposal leaves it (a target placed earlier in the same run, e.g. a crystal).
  function posed(part, m) {
    if (!m) return part;
    const it = {...part.item, x: m.to.x, y: m.to.y, angle: m.to.angle}, side = m.to.layer;
    const pads = localPads(part, side).map(p => ({...p, at: A().world(p.local, it)}));
    return {...part, item: it, side, pads, box: m.box};
  }
  function place(M, part, r, obstacles, P, placed, outline) {
    const t = posed(M.byId.get(r.target.id), placed.get(r.target.id));
    if (!t) return null;
    const tpad = t.pads.find(p => p.number === r.target.pin) || t.pads[0];
    let anchor = tpad.at, dir = outward(t, anchor);
    if (r.kind === "crystal") {
      const pins = (r.pins || []).map(n => t.pads.find(p => p.number === n)).filter(Boolean);
      if (pins.length) { anchor = [pins.reduce((s, p) => s + p.at[0], 0) / pins.length, pins.reduce((s, p) => s + p.at[1], 0) / pins.length]; dir = outward(t, anchor); }
    }
    const side = P.side === "opposite" && r.kind !== "crystal" ? (t.side === "Top" ? "Bottom" : "Top") : t.side;
    const pads = localPads(part, side), box0 = localBox(part, side);
    // Which pad faces the target: the pad on the target's net (decoupling: the power pad).
    let nearPad = pads.find(p => p.net && p.net === tpad.net) || pads.find(p => p.net && !isGround(p.net)) || pads[0];
    if (r.kind === "load") nearPad = pads.find(p => p.net === r.net) || nearPad;
    const farPad = pads.find(p => p !== nearPad && !(r.kind === "crystal" && !isGround(p.net))) || pads.find(p => p !== nearPad);
    const angles = [];
    if (r.kind === "crystal") angles.push(0, 90, 180, 270);
    else if (farPad) {
      // The far pad (ground, or the other end) points away from the target on the same side,
      // and toward the inside of the target under it on the opposite side.
      const want = side === t.side ? dir : [-dir[0], -dir[1]];
      const v = [farPad.local[0] - nearPad.local[0], farPad.local[1] - nearPad.local[1]];
      const a = norm(angleOf(want) - angleOf(v));
      angles.push(a, norm(a + 90), norm(a - 90), norm(a + 180));
    } else angles.push(part.item.angle || 0);
    const tb = t.box, gap = P.gap, cands = [];
    const pinsFor = r.kind === "crystal" ? (r.pins || []).map(n => t.pads.find(p => p.number === n)).filter(Boolean) : null;
    for (const angle of angles) {
      const lb = rotBox(box0, angle), np = A().rotate(nearPad.local, angle);
      const offsets = [0];
      for (let s = 0.25; s <= 8.0001; s += 0.25) offsets.push(r4(s), r4(-s));
      for (let row = 0; row < 6; row++) {
        for (const t2 of offsets) {
          let x, y;
          if (side !== t.side) {
            // Under the pin: the near pad right below the target pad, the part extending inward.
            x = anchor[0] - np[0] - dir[0] * row * (lb[2] - lb[0] + gap) + (dir[0] ? 0 : t2);
            y = anchor[1] - np[1] - dir[1] * row * (lb[3] - lb[1] + gap) + (dir[1] ? 0 : t2);
          } else if (dir[0] > 0) { x = tb[2] + gap - lb[0] + row * (lb[2] - lb[0] + gap); y = anchor[1] - np[1] + t2; }
          else if (dir[0] < 0) { x = tb[0] - gap - lb[2] - row * (lb[2] - lb[0] + gap); y = anchor[1] - np[1] + t2; }
          else if (dir[1] > 0) { y = tb[3] + gap - lb[1] + row * (lb[3] - lb[1] + gap); x = anchor[0] - np[0] + t2; }
          else { y = tb[1] - gap - lb[3] - row * (lb[3] - lb[1] + gap); x = anchor[0] - np[0] + t2; }
          x = snap(x); y = snap(y);
          const near = [x + np[0], y + np[1]];
          let cost = Math.hypot(near[0] - anchor[0], near[1] - anchor[1]);
          if (pinsFor) {
            // A crystal: each signal pad to its IC pin.
            cost = 0;
            for (const ip of pinsFor) { const cp = pads.find(p => p.net === ip.net); if (cp) { const q = A().rotate(cp.local, angle); cost += Math.hypot(x + q[0] - ip.at[0], y + q[1] - ip.at[1]); } }
          }
          cost += (angle === angles[0] ? 0 : 0.35) + row * 0.01;
          cands.push({x, y, angle, cost, near, lb});
        }
      }
    }
    cands.sort((a, b) => a.cost - b.cost);
    const obs = obstacles[side], inOutline = outline && boxInside(outline, t.box);
    for (const c of cands) {
      const box = [c.x + c.lb[0], c.y + c.lb[1], c.x + c.lb[2], c.y + c.lb[3]];
      if (side === t.side && hits(box, tb, gap - 1e-6)) continue;
      if (obs.some(o => hits(box, o, gap))) continue;
      if (inOutline && !boxInside(outline, box)) continue;
      const it = part.item, angle = side === part.side ? c.angle : c.angle;
      const via = r.kind === "decoupling" || r.kind === "bulk" ? viaFor(part, pads, nearPad, c, side === t.side ? dir : [-dir[0], -dir[1]], r.ground) : null;
      return {id: part.id, ref: part.ref, from: {x: it.x, y: it.y, angle: it.angle || 0, layer: part.side}, to: {x: c.x, y: c.y, angle, layer: side},
        target: r.target, anchor: anchor.map(r4), near: c.near.map(r4), distance: r4(Math.hypot(c.near[0] - anchor[0], c.near[1] - anchor[1])), box: box.map(r4), via};
    }
    return null;
  }
  // A suggested ground via just beyond the ground pad, along the outward direction.
  function viaFor(part, pads, nearPad, c, dir, ground) {
    const g = pads.find(p => p !== nearPad && p.net === ground);
    if (!g || !ground) return null;
    const q = A().rotate(g.local, c.angle), reach = Math.max(g.w, g.h) / 2 + 0.55;
    return {at: [snap(c.x + q[0] + dir[0] * reach), snap(c.y + q[1] + dir[1] * reach)], net: ground, diameter: 0.6, drill: 0.3};
  }
  function edgeMove(part, outline, obstacles, P) {
    if (!outline) return null;
    const ob = A().bounds(outline), b = part.box, c = center(b), it = part.item;
    const d = [c[0] - ob[0], ob[2] - c[0], c[1] - ob[1], ob[3] - c[1]], k = d.indexOf(Math.min(...d));
    const dx = k === 0 ? ob[0] - b[0] : k === 1 ? ob[2] - b[2] : 0, dy = k === 2 ? ob[1] - b[1] : k === 3 ? ob[3] - b[3] : 0;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return null;
    const box = [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
    if (obstacles[part.side].some(o => hits(box, o, P.gap))) return null;
    return {id: part.id, ref: part.ref, from: {x: it.x, y: it.y, angle: it.angle || 0, layer: part.side}, to: {x: snap(it.x + dx), y: snap(it.y + dy), angle: it.angle || 0, layer: part.side},
      target: null, anchor: null, near: null, distance: null, box: box.map(r4), via: null};
  }

  // ------------------------------------------------------------------ apply
  function apply(project, board, proposal, o = {}) {
    const only = o.ids ? new Set(o.ids) : null, byId = new Map(board.items.map(i => [i.id, i])), E = globalThis.AtriumPCBEdit;
    let n = 0, vias = 0;
    for (const m of proposal.moves) {
      if (only && !only.has(m.id)) continue;
      const it = byId.get(m.id);
      if (!it || it.kind !== "part" || it.locked) continue;
      const side = it.layer === "Bottom" ? "Bottom" : "Top";
      if (m.to.layer !== side) {
        if (!E?.applyFlip) continue;
        E.applyFlip(board, project, {parts: [{id: it.id, def: it.def, to: {side: m.to.layer, angle: m.to.angle, x: m.to.x, y: m.to.y}}]});
      } else { it.x = m.to.x; it.y = m.to.y; it.angle = m.to.angle; }
      n++;
      if (o.vias && m.via) { board.items.push({id: A().id(), kind: "via", x: m.via.at[0], y: m.via.at[1], diameter: m.via.diameter, drill: m.via.drill, layer: "Multi", net: m.via.net}); vias++; }
    }
    return {moved: n, vias};
  }
  // Store a manual association (or "none", or null to go back to automatic).
  function setOverride(board, partId, value) {
    const sync = board.sync && typeof board.sync === "object" ? board.sync : (board.sync = {});
    const s = {...(sync.support || {})};
    if (value == null) delete s[partId]; else s[partId] = value;
    if (Object.keys(s).length) sync.support = s; else delete sync.support;
    if (!Object.keys(sync).length) delete board.sync;
  }
  function setPrefs(board, prefs) {
    const sync = board.sync && typeof board.sync === "object" ? board.sync : (board.sync = {});
    const p = {...(sync.place || {})};
    for (const k of Object.keys(DEFAULTS)) if (prefs[k] !== undefined) p[k] = prefs[k];
    sync.place = p;
  }

  // ------------------------------------------------------------------ MCP (headless)
  function summary(prop, refOf, limit = 200) {
    return {
      moves: prop.moves.slice(0, limit).map(m => ({id: m.id, kind: m.kind, from: m.from, to: m.to, distance_mm: m.distance, far: !!m.far,
        target: m.target ? {id: m.target.id, pin: m.target.pin} : null, via: m.via ? {at: m.via.at} : null,
        untrusted_design_text: {ref: m.ref, target: m.target ? m.target.ref : null, pin_name: m.target?.pinName ?? null, net: m.target?.net ?? null, text: m.text}})),
      skipped: prop.skipped.map(s => ({id: s.id, reason: s.reason, untrusted_design_text: {ref: s.ref}})),
      counts: Object.fromEntries(KINDS.map(k => [k, prop.moves.filter(m => m.kind === k).length]).filter(([, v]) => v)),
      untrusted_design_text: {notes: prop.notes}, prefs: prop.prefs, truncated: Math.max(0, prop.moves.length - limit)
    };
  }
  function headless(a, h) {
    const planOnly = a.mode === "plan", p = planOnly ? h.project() : h.mutable(), board = h.board(p, a.document_id);
    const ids = [];
    if (a.components?.length) {
      const want = new Set(a.components.map(s => String(s).toUpperCase()));
      for (const i of board.items) if (i.kind === "part" && (want.has(String(i.ref).toUpperCase()) || want.has(i.id))) ids.push(i.id);
    }
    const prop = propose(p, board, {set: a.set || "support", kinds: a.kinds, ids, scope: a.scope, side: a.side, termination: a.termination, connectors: a.connectors,
      maxDistance: a.max_distance_mm, gap: a.gap_mm});
    let applied = {moved: 0, vias: 0};
    if (!planOnly && prop.moves.length) { applied = apply(p, board, prop, {vias: !!a.vias}); if (applied.moved) h.touched(); }
    return {document_id: board.id, mode: planOnly ? "plan" : a.mode || "proposal", moved: applied.moved, vias: applied.vias, ...summary(prop)};
  }

  // ------------------------------------------------------------------ editor UI (browser)
  let H = null, card = null, session = null, inspectObs = null, cache = null;
  const hasDOM = () => typeof document !== "undefined" && !!document.createElement;
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  const css = (name, fallback) => { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch { return fallback; } };
  function overlay(ctx, info) {
    if (!session || H.doc()?.id !== session.board.id) return;
    const px = 1 / info.scale, accent = css("--accent", "#2f81f7"), muted = css("--muted", "#999"), warn = css("--warning", "#d29922");
    ctx.save(); ctx.lineWidth = 1.4 * px; ctx.lineCap = "round";
    for (const m of session.proposal.moves) {
      const on = session.on.has(m.id), active = session.focus === m.id;
      const b = m.box, from = H.project().documents.find(d => d.id === session.board.id)?.items.find(i => i.id === m.id);
      ctx.globalAlpha = on ? 1 : 0.35;
      // Ghost of the new position.
      ctx.setLineDash([]); ctx.fillStyle = accent; ctx.globalAlpha = (on ? 0.16 : 0.06) * (active ? 2 : 1); ctx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
      ctx.globalAlpha = on ? 1 : 0.35; ctx.strokeStyle = m.far ? warn : accent; ctx.lineWidth = (active ? 2.4 : 1.4) * px; ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
      // Dashed travel from the current position.
      if (from) { ctx.setLineDash([4 * px, 3 * px]); ctx.strokeStyle = muted; ctx.lineWidth = px; ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo((b[0] + b[2]) / 2, (b[1] + b[3]) / 2); ctx.stroke(); }
      // Arrow from the support part to its target pin.
      if (m.near && m.anchor) {
        ctx.setLineDash([]); ctx.strokeStyle = m.far ? warn : accent; ctx.lineWidth = (active ? 2.2 : 1.5) * px;
        const [x0, y0] = m.near, [x1, y1] = m.anchor, L = Math.hypot(x1 - x0, y1 - y0) || 1, ux = (x1 - x0) / L, uy = (y1 - y0) / L, h = Math.min(0.6, L / 2.5);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.moveTo(x1, y1); ctx.lineTo(x1 - ux * h - uy * h * 0.6, y1 - uy * h + ux * h * 0.6);
        ctx.moveTo(x1, y1); ctx.lineTo(x1 - ux * h + uy * h * 0.6, y1 - uy * h - ux * h * 0.6); ctx.stroke();
      }
      if (m.via && session.vias) { ctx.beginPath(); ctx.arc(m.via.at[0], m.via.at[1], m.via.diameter / 2, 0, Math.PI * 2); ctx.strokeStyle = muted; ctx.stroke(); }
    }
    // Labels in screen space.
    ctx.setTransform(info.dpr, 0, 0, info.dpr, 0, 0); ctx.globalAlpha = 1; ctx.setLineDash([]);
    ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif"; ctx.textBaseline = "bottom";
    for (const m of session.proposal.moves) {
      if (!session.on.has(m.id)) continue;
      const s = info.worldToScreen([m.box[0], m.box[1]]);
      ctx.fillStyle = m.far ? warn : accent; ctx.fillText(m.ref, s[0], s[1] - 2);
    }
    ctx.restore();
  }
  function closeCard(instant = false) {
    const restoreFocus = card?.contains(document.activeElement);
    if (card) {
      const old = card;
      card = null;
      const surface = globalThis.AtriumSurfaceMotion;
      if (surface) surface.popover(old, false, {instant, done:() => old.remove()});
      else old.remove();
    }
    session = null; H?.redraw?.();
    if (restoreFocus) H?.canvas?.()?.focus({preventScroll: true});
  }
  function scopeIds(board) {
    const sel = new Set(H.selection());
    return board.items.filter(i => i.kind === "part" && sel.has(i.id)).map(i => i.id);
  }
  const TITLES = {decoupling: "Place Decoupling", terminations: "Place Terminations", support: "Place Support Components"};
  function open(set) {
    const board = H.doc();
    if (!board || board.kind !== "pcb") { H.info("Open a board layout to place support components."); return; }
    const switching = !!card;
    closeCard(true);
    const ids = scopeIds(board), project = H.project();
    let prop;
    try { prop = propose(project, board, {set, ids}); } catch (e) { H.info(e.message); return; }
    const what = set === "decoupling" ? "decoupling capacitors" : set === "terminations" ? "series terminations" : "support components";
    if (!prop.moves.length) {
      const why = prop.skipped.length ? " " + prop.skipped.length + " " + (prop.skipped.length === 1 ? "is" : "are") + " locked or routed." : "";
      H.info("No " + what + " to place" + (ids.length ? " for the selection" : " outside the board") + "." + why + (ids.length ? "" : " Select parts to re-place placed ones."));
      return;
    }
    session = {set, board, proposal: prop, on: new Set(prop.moves.map(m => m.id)), focus: null, vias: !!prop.prefs.vias, ids};
    card = el("section", null, "spc-card ui-popover"); card.dataset.anchor = "right";
    card.setAttribute("role", "dialog"); card.setAttribute("aria-labelledby", "spc-title");
    const head = el("div", null, "spc-head"), title = el("h2", TITLES[set], "spc-title"); title.id = "spc-title";
    head.append(title, el("span", prop.moves.length + " part" + (prop.moves.length === 1 ? "" : "s") + (ids.length ? " · selection" : " · unplaced"), "spc-sub"));
    const close = el("button", null, "ui-button spc-icon spc-close"); close.type = "button"; close.dataset.variant = "quiet"; close.dataset.size = "sm";
    close.title = "Cancel"; close.setAttribute("aria-label", "Cancel"); close.onclick = () => closeCard();
    head.append(close);
    const intro = el("p", "Each part goes next to the pin it serves. Arrows point from the part to its pin. Untick a row to leave that part where it is.", "spc-intro");
    const opts = el("div", null, "spc-opts");
    const select = (label, value, options, onchange) => {
      const l = el("label", null, "spc-opt ui-field-row"), s = el("select", null, "ui-field");
      for (const [v, t] of options) s.add(new Option(t, v));
      s.setAttribute("aria-label",label);
      s.value = value; s.onchange = () => onchange(s.value); l.append(el("span", label), s); return l;
    };
    const P = prop.prefs;
    const refresh = patch => {
      try { H.edit(() => setPrefs(board, patch)); } catch (e) { H.info(e.message); }
      const keep = session; open(set); if (!session && keep) H.info("Nothing left to place with these settings.");
    };
    if (set !== "terminations") opts.append(select("Side", P.side, [["same", "Same side as the IC"], ["opposite", "Opposite side, behind the pin"]], v => refresh({side: v})));
    if (set !== "decoupling") opts.append(select("Terminations", P.termination, [["source", "At the driver (source)"], ["receiver", "At the receiver"]], v => refresh({termination: v})));
    const dist = el("label", null, "spc-opt ui-field-row"), dIn = el("input", null, "ui-field ui-field-number"); dIn.type = "number"; dIn.min = "0.5"; dIn.max = "50"; dIn.step = "0.5"; dIn.dataset.numericUnit = "mm"; dIn.value = String(P.maxDistance);
    dIn.setAttribute("aria-label","Max distance (mm)");
    dIn.onchange = () => refresh({maxDistance: +dIn.value});
    const measure = el("span", null, "ui-field-measure");
    measure.append(dIn,el("span","mm","ui-field-unit"));
    dist.append(el("span", "Max distance"),measure); opts.append(dist);
    const flag = (label, on, title, fn) => { const l = el("label", null, "spc-opt spc-check"), b = el("input", null, "ui-checkbox"); b.type = "checkbox"; b.checked = on; b.onchange = () => fn(b.checked); l.title = title; l.append(b, el("span", label)); return l; };
    if (set === "support") opts.append(flag("Snap connectors to the board edge", !!P.connectors, "Connectors move to the nearest board edge.", v => refresh({connectors: v})));
    if (set !== "terminations") opts.append(flag("Add ground vias", session.vias, "Adds the suggested ground via beside each decoupling capacitor.", v => { session.vias = v; H.redraw(); }));
    const list = el("ul", null, "spc-list");
    const rows = new Map();
    for (const m of prop.moves) {
      const li = el("li", null, "spc-row" + (m.far ? " is-far" : "")), box = el("input", null, "ui-checkbox"), lab = el("label");
      box.type = "checkbox"; box.checked = true; box.setAttribute("aria-label", "Place " + m.ref);
      box.onchange = () => { if (box.checked) session.on.add(m.id); else session.on.delete(m.id); li.classList.toggle("is-off", !box.checked); count(); H.redraw(); };
      const text = el("span", null, "spc-text");
      text.append(el("b", m.ref), document.createTextNode(" " + (m.text || LABEL[m.kind])));
      const dist2 = el("span", m.distance == null ? "edge" : m.distance.toFixed(1) + " mm", "spc-dist");
      if (m.far) dist2.title = "Farther than " + P.maxDistance + " mm: the area next to the pin is taken.";
      lab.append(box, text); li.append(lab, dist2);
      li.onmouseenter = li.onfocusin = () => { session.focus = m.id; H.redraw(); };
      li.onclick = e => { if (e.target === box) return; session.focus = m.id; H.zoomTo?.([m.box[0] - 6, m.box[1] - 6, m.box[2] + 6, m.box[3] + 6]); H.redraw(); };
      rows.set(m.id, li); list.append(li);
    }
    const notes = el("ul", null, "spc-notes");
    for (const n of prop.notes.slice(0, 6)) notes.append(el("li", n));
    const foot = el("div", null, "spc-actions"), status = el("span", "", "spc-count");
    const cancel = el("button", "Cancel", "ui-button"); cancel.type = "button"; cancel.onclick = () => closeCard();
    const ok = el("button", "Apply", "ui-button spc-primary"); ok.type = "button"; ok.dataset.variant = "primary";
    const count = () => { const n = session?.on.size || 0; status.textContent = n + " of " + prop.moves.length + " selected"; ok.disabled = !n; ok.textContent = n ? "Apply " + n : "Apply"; };
    ok.onclick = () => {
      const s = session; if (!s) return;
      let r = null;
      try { H.edit(() => { r = apply(H.project(), s.board, s.proposal, {ids: [...s.on], vias: s.vias}); }); } catch (e) { H.info(e.message); return; }
      closeCard();
      H.info(r.moved + " part" + (r.moved === 1 ? "" : "s") + " placed next to their pins" + (r.vias ? ", " + r.vias + " ground via" + (r.vias === 1 ? "" : "s") + " added" : "") + ". Undo reverts all of them.");
    };
    foot.append(status, cancel, ok);
    card.append(head, intro, opts, list);
    if (prop.notes.length) card.append(notes);
    card.append(foot);
    (document.querySelector("#editor-panes") || document.body).append(card);
    card.addEventListener("keydown", e => { if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); e.stopPropagation(); closeCard(); } });
    count(); H.redraw();
    const all = prop.moves.map(m => m.box).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
    // Fit the moves into the canvas left of the card.
    const z = [all[0] - 5, all[1] - 5, all[2] + 5, all[3] + 5], cr = H.canvas?.()?.getBoundingClientRect?.(), kr = card.getBoundingClientRect();
    const f = cr?.width ? Math.max(0.3, Math.min(1, (kr.left - cr.left - 12) / cr.width)) : 1;
    if (f < 0.9) { const w = Math.max(z[2] - z[0], (z[3] - z[1]) * cr.width * f / Math.max(1, cr.height)); z[0] = (z[0] + z[2]) / 2 - w / 2; z[2] = z[0] + w / f; }
    H.zoomTo?.(z);
    globalThis.AtriumSurfaceMotion?.popover(card, true, {instant:switching});
    ok.focus({preventScroll: true});
  }
  // Properties panel: the association of the selected part, and a way to change it.
  function roleOf(board, id) {
    const rev = H.revision?.();
    if (!cache || cache.rev !== rev || cache.board !== board) {
      let a = null; try { a = associate(H.project(), board, {termination: prefsOf(board).termination}); } catch { a = {roles: [], model: null}; }
      cache = {rev, board, a, by: new Map(a.roles.map(r => [r.id, r]))};
    }
    return cache;
  }
  function decorate() {
    const panel = document.getElementById("inspector"), board = H.doc();
    if (!panel || board?.kind !== "pcb" || panel.querySelector(".spc-section")) return;
    const sel = H.selection();
    if (sel.length !== 1) return;
    const item = board.items.find(i => i.id === sel[0]);
    if (item?.kind !== "part") return;
    const c = roleOf(board, item.id), r = c.by.get(item.id), part = c.a.model?.byId.get(item.id);
    if (!part || !(r || part.pads.length === 2 || part.type === "crystal" || part.type === "connector")) return;
    const o = board.sync?.support?.[item.id];
    const s = H.ui.section(panel, "Placement role");
    s.classList.add("spc-section");
    s.append(el("p", r ? explain(r) : o?.kind === "none" ? "No placement role (turned off by hand)." : "No support role detected.", "spc-explain"));
    if (r?.reason) s.append(el("p", r.reason, "spc-reason"));
    // Role and target pin. Candidates: pins of ICs on this part's nets.
    const nets = new Set(part.pads.map(p => p.net).filter(Boolean)), cands = [];
    for (const n of nets) if (!isGround(n)) for (const e of c.a.model.nets.get(n) || []) if (e.part !== part && (e.part.type === "ic" || e.part.type === "crystal")) cands.push(e);
    const kindSel = el("select"), pinSel = el("select");
    kindSel.add(new Option("Automatic" + (r && !o ? " (" + LABEL[r.kind] + ")" : ""), ""));
    for (const k of KINDS) kindSel.add(new Option(LABEL[k], k));
    kindSel.add(new Option("None (never place)", "none"));
    kindSel.value = o?.kind || "";
    for (const e of cands) pinSel.add(new Option(e.part.ref + " pin " + e.pad.number + (e.pad.name && e.pad.name !== e.pad.number ? " " + e.pad.name : "") + " · " + e.pad.net, e.part.ref + "\u0000" + e.pad.number));
    const cur = o?.ref ? o.ref + "\u0000" + o.pin : r?.target ? r.target.ref + "\u0000" + r.target.pin : "";
    if (cur) pinSel.value = cur;
    pinSel.disabled = !cands.length || !kindSel.value || kindSel.value === "none" || kindSel.value === "connector";
    const save = () => {
      const k = kindSel.value, [ref, pin] = (pinSel.value || "").split("\u0000");
      const v = !k ? null : k === "none" || k === "connector" ? {kind: k} : ref ? {kind: k, ref, pin} : null;
      if (k && k !== "none" && k !== "connector" && !ref) { H.info("Choose the pin this part serves."); return; }
      H.edit(() => setOverride(board, item.id, v));
    };
    kindSel.onchange = () => { pinSel.disabled = !cands.length || !kindSel.value || kindSel.value === "none" || kindSel.value === "connector"; if (!kindSel.value || kindSel.value === "none" || kindSel.value === "connector" || pinSel.value) save(); };
    pinSel.onchange = save;
    kindSel.setAttribute("aria-label", "Placement role"); pinSel.setAttribute("aria-label", "Target pin");
    const row = (label, ctl) => { const l = el("label", null, "ui-prop-row"); ctl.classList.add("ui-field"); l.append(el("span", label), ctl); s.append(l); };
    row("Role", kindSel); if (cands.length) row("Serves", pinSel);
    if (r && r.kind !== "connector") s.append(H.ui.button("Place next to its pin", () => { H.select([item.id], item.id); open("support"); }));
  }
  function install(host) {
    H = host;
    host.registerAction("place-decoupling", () => open("decoupling"));
    host.registerAction("place-terminations", () => open("terminations"));
    host.registerAction("place-support", () => open("support"));
    if (install.done) return;
    install.done = true;
    host.addRenderer(d => session && d?.id === session.board.id ? {overlay} : null);
    host.on("document", () => { if (session && host.currentId?.() !== session.board.id) closeCard(); });
    const panel = document.getElementById("inspector");
    if (panel && typeof MutationObserver === "function") {
      inspectObs = new MutationObserver(() => { try { decorate(); } catch (e) { globalThis.console?.error?.(e); } });
      inspectObs.observe(panel, {childList: true});
      try { decorate(); } catch {}
    }
  }
  if (hasDOM() && globalThis.AtriumNavCommon?.ready) AtriumNavCommon.ready(install);
  const api = {KINDS, LABEL, SETS, DEFAULTS, associate, propose, apply, explain, setOverride, setPrefs, prefsOf, headless, quantity, showFarads, sizeOf, isGround, isPowerName,
    open: (h, set) => { if (h && !H) install(h); open(set || "support"); }, close: closeCard, session: () => session};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  return api;
})();
