"use strict";
// Power-plane proposals: which ground and supply nets get a plane or pour on which copper
// layer, from the layer stack and each net's current, and the polygon pours to create.
//
// plan(doc, defs, {project, stackup, nets, currents, rise, outerGround}) -> {copper, nets,
//   assignments:[{layer, net, kind:"plane"|"pour", region:"board"|"local", points, pourIndex,
//   reason, current, width, exists}], notes, summary}
//   copper    the board's copper layers top to bottom (AtriumStackup, else the routing layers)
//   nets      ground nets (GND, AGND, VSS …) and supply nets (VCC, +3V3 …) on the board's pads
//   current   per net: currents{} argument, else the rules' netCurrents/classCurrents, else an
//             estimate (0.25 A per supply pin, 0.5–3 A; ground carries the supplies' sum)
//   width     IPC-2152 track width for that current (AtriumCalc track_width, Brooks & Adam fit,
//             10 °C rise) when the calculators module is loaded, else IPC-2221. A supply whose
//             track would be wider than 1 mm, carries 2 A or more, or reaches 8 pins gets copper.
// Layer rules (overridable per layer with stackup: {LAYER: NET | "signal"}):
//   2 layers   Bottom: ground over the whole board; Top: ground flood (outerGround, default on)
//              and local supply pours around each supply that needs copper.
//   4+ layers  Plane-type layers first, else inner layers: the inner layer next to Top is
//              ground; the next is the main supply with the other supplies as local split
//              pours; 6+ layers repeat ground on the inner layer next to Bottom. Outer layers
//              get a ground flood only with outerGround: true.
// apply(doc, defs, plan, {select}) adds the chosen polygons and pours them with
// AtriumPolygonPour (public API: make, apply). Existing pours of the same net and layer are kept.
globalThis.AtriumPlanePlanner = (() => {
  const fail = m => { throw Error(m); };
  const round = (v, d = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d + 0 : v);
  const natural = typeof Intl !== "undefined" ? new Intl.Collator("en", {numeric: true}).compare : (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  // net-intent.js (isGround) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const GROUND_RE = /^(?:[ADPSC]?GND\w*|GND\w*|VSS\w*|0V|EARTH\w*|CHASSIS\w*)$/i;
  const GROUND = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isGround ? N.isGround(String(n ?? "")) : GROUND_RE.test(n); }};
  // net-intent.js (isRail) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const SUPPLY_RE = /^(?:VDD\w*|VCC\w*|VEE\w*|VBAT\w*|VBUS\w*|VIN\w*|VSYS|VREF\w*|AVDD\w*|DVDD\w*|PWR\w*|\+?\d+V\d*\w*|\d+V\d+|V\d+(?:V\d+)?|[+-]\d+(?:\.\d+)?V\w*)$/i;
  const SUPPLY = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isRail ? N.isRail(String(n ?? "")) : SUPPLY_RE.test(n); }};
  const COPPER_KEY = /^(?:Top|Bottom|Inner (?:[1-9]|[12]\d|30))$/;
  const OZ = 0.035;
  const isGround = n => GROUND.test(n || "");
  const isSupply = n => !!n && !isGround(n) && SUPPLY.test(n);

  function copperLayers(doc, defs) {
    const S = globalThis.AtriumStackup;
    if (S?.get) {
      try {
        const st = S.get(doc, defs);
        const list = (st.layers || []).filter(l => (l.type === "Signal" || l.type === "Plane") && l.key).map(l => ({key: l.key, type: l.type, thickness: +l.thickness || OZ, name: l.name || l.key}));
        if (list.length) return list;
      } catch { /* derived below */ }
    }
    const AR = globalThis.AtriumAutorouter;
    const keys = AR?.boardLayers ? AR.boardLayers(doc, defs) : ["Top", "Bottom"];
    return keys.map(key => ({key, type: "Signal", thickness: OZ, name: key}));
  }
  function netPads(doc, defs) {
    const pads = new Map();
    const world = globalThis.Atrium?.world || ((p, it) => [p[0] + it.x, p[1] + it.y]);
    for (const i of doc.items) {
      if (i.kind !== "part") continue;
      const def = defs.get(i.def);
      for (const p of def?.footprint?.pads || []) {
        const n = i.pinNets?.[p.number];
        if (!n) continue;
        let l = pads.get(n); if (!l) pads.set(n, l = []);
        l.push(world([p.x, p.y], i));
      }
    }
    return pads;
  }
  function currentOf(net, pins, o, rules, supplies) {
    if (o.currents && Number.isFinite(o.currents[net])) return {value: o.currents[net], source: "given"};
    const nc = rules?.netCurrents || {}, cc = rules?.classCurrents || {}, classes = rules?.netClasses || {};
    if (Number.isFinite(nc[net])) return {value: nc[net], source: "rules"};
    let best = 0;
    for (const [c, members] of Object.entries(classes)) if (Number.isFinite(cc[c]) && (members || []).includes(net)) best = Math.max(best, cc[c]);
    if (best > 0) return {value: best, source: "rules"};
    if (isGround(net)) return {value: Math.min(10, Math.max(1, supplies)), source: "estimate"};
    return {value: Math.min(3, Math.max(0.5, 0.25 * pins)), source: "estimate"};
  }
  // IPC-2152 width through AtriumCalc (Brooks & Adam), else IPC-2221 (k 0.048 external, 0.024 internal).
  function trackWidth(current, rise, copperMm, internal) {
    const C = globalThis.AtriumCalc;
    if (C?.calculate) {
      try {
        const r = C.calculate("track_width", {current, rise, copper: Math.max(0.25, Math.min(6, copperMm / OZ)), layer: internal ? "internal" : "external"});
        return {width: r.values.width, method: "IPC-2152 (Brooks & Adam, AtriumCalc)"};
      } catch { /* fall through */ }
    }
    const k = internal ? 0.024 : 0.048, area = Math.pow(current / (k * Math.pow(rise, 0.44)), 1 / 0.725); // mil²
    const thMil = copperMm / 0.0254;
    return {width: area / thMil * 0.0254, method: "IPC-2221 (AtriumCalc not loaded)"};
  }
  const rect = b => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
  function localRegion(points, outlineBox, grow = 2) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const b = [Math.max(outlineBox[0], x0 - grow), Math.max(outlineBox[1], y0 - grow), Math.min(outlineBox[2], x1 + grow), Math.min(outlineBox[3], y1 + grow)];
    return b[2] > b[0] && b[3] > b[1] ? rect(b.map(v => round(v, 3))) : null;
  }

  function plan(doc, defs, o = {}) {
    if (!doc || doc.kind !== "pcb") fail("Choose a PCB layout to plan planes for.");
    const outline = Array.isArray(doc.outline) && doc.outline.length >= 3 ? doc.outline.map(p => [+p[0], +p[1]]) : null;
    if (!outline) fail("Set the board outline first: planes follow the board shape.");
    const ob = outline.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
    const copper = copperLayers(doc, defs), keys = copper.map(l => l.key);
    const rules = globalThis.AtriumRules?.effective?.(doc, o.project) ?? null;
    const pads = netPads(doc, defs), rise = Number.isFinite(o.rise) ? o.rise : 10;
    let names = [...pads.keys()].filter(n => isGround(n) || isSupply(n));
    if (o.nets) { for (const n of o.nets) if (!pads.has(n)) fail("No pad on this board is on the requested net."); names = o.nets.slice(); }
    const grounds = names.filter(isGround).sort((a, b) => pads.get(b).length - pads.get(a).length || natural(a, b));
    const supplies = names.filter(n => !isGround(n)).sort((a, b) => pads.get(b).length - pads.get(a).length || natural(a, b));
    const notes = [];
    const nets = [];
    let supplySum = 0;
    for (const n of supplies) {
      const pins = pads.get(n).length, cur = currentOf(n, pins, o, rules, 0), outer = copper[0];
      const w = trackWidth(cur.value, rise, outer.thickness, false);
      const needs = w.width > 1 || cur.value >= 2 || pins >= 8;
      supplySum += cur.value;
      nets.push({net: n, ground: false, pins, current: cur.value, current_source: cur.source, width: w.width, method: w.method, needs});
    }
    for (const n of grounds) {
      const pins = pads.get(n).length, cur = currentOf(n, pins, o, rules, supplySum);
      const w = trackWidth(cur.value, rise, copper[0].thickness, false);
      nets.push({net: n, ground: true, pins, current: cur.value, current_source: cur.source, width: w.width, method: w.method, needs: true});
    }
    if (!nets.length) notes.push("No ground or supply nets were found on the board's pads.");
    const info = n => nets.find(x => x.net === n);
    const out = [];
    const existing = new Set(doc.items.filter(i => i.kind === "polygon").map(i => i.layer + "\u0000" + (i.net || "")));
    let index = 0;
    const add = (layer, net, region, reason, points, pourIndex) => {
      const x = info(net), kind = copper.find(l => l.key === layer)?.type === "Plane" ? "plane" : "pour";
      out.push({index: index++, layer, net, kind, region, reason, points: points || outline.map(p => [round(p[0]), round(p[1])]), pourIndex,
        current: x ? round(x.current, 3) : null, width: x ? round(x.width, 3) : null, exists: existing.has(layer + "\u0000" + net)});
    };
    const overrides = new Map(Object.entries(o.stackup || {}));
    for (const k of overrides.keys()) if (!COPPER_KEY.test(k) || !keys.includes(k)) fail("stackup names " + k + ", which is not a copper layer of this board (" + keys.join(", ") + ").");
    const g = grounds[0] || null, mainSupply = supplies[0] || null;
    const needy = supplies.filter(n => info(n).needs);
    const localSupplies = (layer, start, skip) => {
      let k = start;
      for (const n of needy) {
        if (n === skip) continue;
        const pts = localRegion(pads.get(n), ob);
        if (pts) add(layer, n, "local", "split pour around the " + pads.get(n).length + " pads of this supply", pts, k++);
      }
    };
    const used = new Set();
    // Explicit assignments first.
    for (const [layer, net] of overrides) {
      used.add(layer);
      if (net === "signal" || net == null || net === "") continue;
      if (!pads.has(net)) fail("stackup assigns a net with no pads on this board to " + layer + ".");
      add(layer, net, "board", "assigned in the request", null, 10);
    }
    const free = keys.filter(k => !used.has(k));
    if (keys.length <= 2) {
      if (g && free.includes("Bottom")) add("Bottom", g, "board", "ground reference under the whole board (two-layer board)", null, 10);
      if (free.includes("Top")) {
        localSupplies("Top", 1, null);
        if (g && o.outerGround !== false) add("Top", g, "board", "ground flood around the top-side routing", null, 20);
      }
      if (needy.length && !free.includes("Top")) notes.push("Supplies that need copper have no free outer layer; route them as wide tracks.");
    } else {
      const inner = free.filter(k => /^Inner/.test(k));
      const planes = inner.filter(k => copper.find(l => l.key === k)?.type === "Plane");
      const orderInner = [...planes, ...inner.filter(k => !planes.includes(k))].sort((a, b) => keys.indexOf(a) - keys.indexOf(b));
      const gl = orderInner[0], pl = orderInner.find(k => k !== gl && (orderInner.length < 3 || k !== orderInner[orderInner.length - 1])) || orderInner[1];
      if (g && gl) add(gl, g, "board", "ground plane next to the top layer (return path for Top signals)", null, 10);
      if (pl) {
        if (mainSupply) add(pl, mainSupply, "board", "main supply plane (" + pads.get(mainSupply).length + " pads)", null, 10);
        localSupplies(pl, 1, mainSupply);
      }
      if (keys.length >= 6 && g) {
        const last = orderInner[orderInner.length - 1];
        if (last && last !== gl && last !== pl) add(last, g, "board", "second ground plane next to the bottom layer", null, 10);
      }
      if (o.outerGround === true && g) for (const k of ["Top", "Bottom"]) if (free.includes(k)) add(k, g, "board", "ground flood on the outer layer", null, 20);
      if (!inner.length) notes.push("The stack has no free inner layers; nothing was assigned automatically.");
    }
    if (!globalThis.AtriumCalc) notes.push("Track widths use IPC-2221; open Tools › Calculators once (or load AtriumCalc) for IPC-2152.");
    if (out.some(a => a.exists)) notes.push("Layers that already have a pour of that net are listed but left alone.");
    const created = out.filter(a => !a.exists).length;
    const summary = created ? "Proposed " + created + " pour" + (created === 1 ? "" : "s") + " on " + new Set(out.filter(a => !a.exists).map(a => a.layer)).size + " of " + keys.length + " copper layers." : "No new planes or pours to propose.";
    return {copper: copper.map(l => ({key: l.key, type: l.type, copper_mm: round(l.thickness, 4)})), nets: nets.map(n => ({...n, current: round(n.current, 3), width: round(n.width, 3)})),
      assignments: out, notes, summary, rise};
  }

  /** Create the selected assignments' polygons (indexes, default all new) and pour them. */
  function apply(doc, defs, planned, o = {}) {
    const PP = globalThis.AtriumPolygonPour || fail("Polygon pours are unavailable in this build.");
    const pick = o.select ? new Set(o.select) : null, ids = [];
    for (const a of planned.assignments) {
      if (a.exists || (pick && !pick.has(a.index))) continue;
      const item = PP.make(a.points.map(p => p.slice()), {layer: a.layer, net: a.net, name: (a.region === "local" ? "Split " : "Plane ") + a.net + " " + a.layer, pourIndex: a.pourIndex});
      doc.items.push(item);
      ids.push(item.id);
    }
    let regions = 0;
    if (ids.length) { const r = PP.apply(doc, defs, {only: ids}); regions = (r.regions || []).filter(x => ids.includes(x.polygon)).length; }
    return {polygons: ids, regions};
  }

  // MCP / AI result: net names are design text, under untrusted_design_text.
  function summary(p, made = null) {
    return {copper: p.copper, summary: p.summary, notes: p.notes, rise_c: p.rise,
      assignments: p.assignments.map(a => ({index: a.index, layer: a.layer, kind: a.kind, region: a.region, pour_index: a.pourIndex, current_a: a.current, track_width_mm: a.width, exists: a.exists, vertices: a.points.length})),
      nets: p.nets.map((n, k) => ({index: k, ground: n.ground, pins: n.pins, current_a: n.current, current_source: n.current_source, track_width_mm: n.width, method: n.method, needs_copper: n.needs})),
      ...(made ? {created: made.polygons.length, regions: made.regions} : {}),
      untrusted_design_text: {assignment_nets: p.assignments.map(a => a.net), net_names: p.nets.map(n => n.net), reasons: p.assignments.map(a => a.reason)}};
  }
  /** MCP op: a = {document_id, stackup, nets, currents, rise, outer_ground, mode}. */
  function headless(a, h) {
    const planOnly = a.mode === "plan", p = planOnly ? h.project() : h.mutable(), doc = h.board(p, a.document_id), defs = h.defsOf(p);
    const planned = plan(doc, defs, {project: p, stackup: a.stackup, nets: a.nets, currents: a.currents, rise: a.rise, outerGround: a.outer_ground});
    let made = null;
    if (!planOnly) { made = apply(doc, defs, planned, {select: a.assignments}); if (made.polygons.length) h.touched(); }
    return {document_id: doc.id, mode: planOnly ? "plan" : a.mode || "proposal", ...summary(planned, made)};
  }
  return Object.freeze({plan, apply, summary, headless, trackWidth, isGround, isSupply});
})();
