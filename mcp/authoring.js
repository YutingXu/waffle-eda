"use strict";
// MCP authoring v2 and netlists, for mcp/headless.js (tools in mcp/authoring.py).
//
//   AtriumAuthorV2.headless(op, args, ctx, body) with ctx {project, mutable, touched, page, board, defsOf, author, endpoint, applyPlan}
//   ops: find_parts, place_part, connect, export_netlist, import_netlist, multi_route
//
// Parts come from the project library, the starter library (app/library/starter-library.js) and the built-in
// parts (app/library/parts.js), by ID, name or a query over value, footprint, category and part-number
// parameters. Part numbers are only ever read from parameters a library already has: nothing here
// invents a manufacturer or supplier part number. Strings that come from the design or a netlist file
// are returned under untrusted_design_text.
globalThis.AtriumAuthorV2 = (() => {
  const A = globalThis.Atrium;
  const fail = m => { throw Error(m); };
  const up = s => String(s ?? "").trim().toUpperCase();
  const round = v => Math.round(v * 1e4) / 1e4 + 0;
  const fold = s => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[µμ]/g, "u").replace(/(ohms?|Ω|Ω)/gi, "").replace(/[\s_×x*-]+/g, "");
  const words = s => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[µμ]/g, "u").split(/[\s,;]+/).map(fold).filter(Boolean);
  const MPN_KEY = /^(mpn|manufacturer ?part(?: ?(number|no\.?|#))?|mfr\.? ?(part|pn|p\/n)(?: ?(number|no\.?|#))?|part ?(number|no\.?|#)|lcsc ?(part)? ?#?|supplier ?part(?: ?(number|#))?|digi-?key ?(part)? ?#?|mouser ?(part)? ?#?)$/i;

  // ---------------------------------------------------------------- part search
  function starter() {
    try { return globalThis.AtriumStarterLibrary?.templates() || []; } catch { return []; }
  }
  function pool(p) {
    const members = p.componentFamilies && globalThis.AtriumComponentFamilies?.memberships(p);
    const have = new Set(p.library.map(d => d.id)), out = p.library.map(d => ({d, source: "project", family: members?.get(d.id)}));
    for (const d of starter()) if (!have.has(d.id)) { have.add(d.id); out.push({d, source: "starter"}); }
    for (const d of globalThis.AtriumParts?.catalogue || []) if (!have.has(d.id)) { have.add(d.id); out.push({d, source: "builtin"}); }
    return out;
  }
  // The project library first, then the starter library, then the built-in parts; the query only orders within a source.
  const RANK = {project: 30, starter: 20, builtin: 10};
  const fpName = d => String(d.footprint?.name || d.footprintName || "");
  const pinCount = d => d.symbol?.pins?.length || 0;
  const partNumbers = d => Object.entries(d.parameters || {}).filter(([k, v]) => MPN_KEY.test(String(k).trim()) && String(v ?? "").trim()).map(([k, v]) => ({key: k, value: String(v).trim()}));
  function score(entry, q, m) {
    const d = entry.d, name = fold(d.name), fields = [d.id, d.name, d.value, fpName(d), d.package, d.category, d.prefix, d.description, entry.family?.name, entry.family?.part,
      ...Object.values(d.parameters || {})].map(fold).join("\u0001");
    let s = RANK[entry.source];
    for (const t of q) {
      if (!fields.includes(t)) return -1;
      s += name.includes(t) ? 2 : 1;
    }
    if (q.length && q.join("") === name) s += 4;
    if (m.value != null) {
      const want = fold(m.value), have = [d.value, d.parameters?.Value].map(fold);
      if (!have.some(h => h && (h === want || h.includes(want)))) return -1;
      s += have.includes(want) ? 3 : 1;
    }
    if (m.footprint != null) {
      const want = fold(m.footprint), have = [fpName(d), d.package, d.name].map(fold);
      if (!have.some(h => h && h.includes(want))) return -1;
      s += fold(fpName(d)) === want ? 3 : 1;
    }
    if (m.mpn != null) {
      const want = fold(m.mpn);
      if (!partNumbers(d).some(x => fold(x.value) === want)) return -1;
      s += 5;
    }
    if (m.category != null && !fold(d.category).includes(fold(m.category))) return -1;
    if (m.prefix != null && up(d.prefix) !== up(m.prefix)) return -1;
    if (m.pins != null && pinCount(d) !== m.pins) return -1;
    return s;
  }
  function search(p, a) {
    const q = words(a.query), m = a.match || {}, sources = new Set(a.sources || ["project", "starter", "builtin"]);
    const hits = [];
    for (const e of pool(p)) {
      if (!sources.has(e.source)) continue;
      if (a.placeable !== false && !e.d.symbol) continue;
      const s = score(e, q, m);
      if (s >= 0) hits.push({...e, score: s});
    }
    hits.sort((x, y) => y.score - x.score || RANK[y.source] - RANK[x.source] || String(x.d.name).localeCompare(String(y.d.name)) || String(x.d.id).localeCompare(String(y.d.id)));
    return hits;
  }
  const row = h => ({def_id: h.d.id, source: h.source, score: h.score, placeable: !!h.d.symbol, has_footprint: !!h.d.footprint, pins: pinCount(h.d),
    pads: (h.d.footprint?.pads || []).filter(x => !x.thermalVia).length, gates: h.d.symbol?.parts || 1,
    untrusted_design_text: {name: h.d.name || "", value: h.d.value || "", prefix: h.d.prefix || "", category: h.d.category || "", footprint: fpName(h.d),
      ...(h.family ? {family: h.family.name, part: h.family.part} : {}),
      part_numbers: partNumbers(h.d), description: String(h.d.description || "").slice(0, 300)}});
  function findParts(a, ctx) {
    if (!a.query && !a.match) fail("Give a query or match.");
    const hits = search(ctx.project(), {...a, placeable: a.placeable_only !== false});
    return {...ctx.page(hits.map(row), a),
      note: "Starter and built-in parts are generic and carry no manufacturer or supplier part number. Waffle never invents part numbers; set them from your own sourcing."};
  }
  // A definition ID in the project library for `def` (ID or name) or the best match of query/match.
  function requireExactFamilyMatch(matches) {
    if (matches.length > 1 && matches.some(e => e.family)) {
      fail("Choose an exact definition ID for the chip and package: " + matches.slice(0, 8).map(e => e.d.id + " (" + fpName(e.d) + ")").join(", ") + ".");
    }
  }
  function resolve(p, a) {
    if (a.def != null) {
      const key = up(a.def), all = pool(p);
      let hit = all.find(e => e.d.id === a.def);
      if (!hit) {
        const named = all.filter(e => up(e.d.name) === key);
        requireExactFamilyMatch(named.filter(e => e.source === "project"));
        hit = named[0];
      }
      if (!hit) return {id: a.def, source: null, alternatives: []};   // sch-author.js reports the miss (and the shared library)
      if (hit.source !== "project") p.library.push(A.clone(hit.d));
      return {id: hit.d.id, source: hit.source, alternatives: []};
    }
    if (!a.query && !a.match) fail("Name the part with def (library ID or name), or find it with query or match.");
    const hits = search(p, a);
    if (!hits.length) {
      if (a.match?.mpn != null) fail("No library part has the part number " + JSON.stringify(String(a.match.mpn)) + ". Waffle never invents part numbers: add it to a part's parameters, create the part (create_symbol, create_footprint) or place a generic part and set its parameters.");
      const near = search(p, {query: words(a.query).slice(0, 1).join(" ")}).slice(0, 8).map(h => h.d.id);
      fail("No placeable library part matches" + (a.query ? " " + JSON.stringify(String(a.query)) : "") + (a.match ? " " + JSON.stringify(a.match) : "") + "." +
        (near.length ? " Close: " + near.join(", ") + "." : " Try find_parts with a shorter query."));
    }
    const best = hits[0];
    if (!a.match && a.query) requireExactFamilyMatch(hits.filter(e => e.family && up(e.family.name) === up(a.query)));
    requireExactFamilyMatch(hits.filter(e => e.score === best.score && e.source === best.source));
    if (best.source !== "project") p.library.push(A.clone(best.d));
    return {id: best.d.id, source: best.source, alternatives: hits.slice(1, 5).map(h => h.d.id), tied: hits.length > 1 && hits[1].score === best.score};
  }
  function placePart(a, ctx) {
    const p = ctx.mutable(), {query, match, ...rest} = a, r = resolve(p, a);
    const out = ctx.author.place_part({...rest, def: r.id});
    return {...out, matched: {def_id: r.id, source: r.source, ...(query || match ? {alternatives: r.alternatives, tied: !!r.tied} : {})}};
  }

  // ---------------------------------------------------------------- connect
  const POWER = /^([+-]?\d+(\.\d+)?V\d*|[+-]\d+V\d*|V(CC|DD|EE|SS|BUS|BAT|IN|REF|IO)\w*|A?GND\w*|D?GND\w*|P?GND\w*|0V|EARTH|\+?\d+V\d+)$/i;
  function connect(a, ctx) {
    const W = globalThis.AtriumSchAuthor || fail("Authoring is not available in this build (sch-author.js).");
    const p = ctx.mutable(), doc = W.documentOf(p, a.sheet, "schematic"), net = String(a.net ?? "").trim();
    if (!net) fail("Name the net.");
    if (globalThis.AtriumSchObjects?.isBus?.(net)) fail("connect joins single nets; " + net + " is a bus name.");
    const style = a.style === "auto" || !a.style ? (POWER.test(net) ? "power" : "label") : a.style;
    const pins = a.pins || [], seen = new Set();
    if (!pins.length) fail("List the pins to connect.");
    for (const x of pins) { const k = up(x.designator) + "/" + up(x.pin); if (seen.has(k)) fail(x.designator + " pin " + x.pin + " is listed twice."); seen.add(k); }
    const stub = a.stub ?? 0, defs = new Map(p.library.map(d => [d.id, d])), made = [];
    const pinInfo = x => {
      const at = W.pinAt(p, doc, x.designator, x.pin);
      // Outward: away from the part's origin along the dominant axis.
      const v = [at.at[0] - at.part.x, at.at[1] - at.part.y], dir = Math.abs(v[0]) >= Math.abs(v[1]) ? [Math.sign(v[0]) || 1, 0] : [0, Math.sign(v[1]) || 1];
      return {at: at.at, dir};
    };
    const marker = (x, at) => style === "power" || (style === "wire" && POWER.test(net))
      ? ctx.author.add_power_port({sheet: doc.id, net, x: at[0], y: at[1], snap: false, ...(a.power_style ? {style: a.power_style} : {})})
      : ctx.author.add_net_label({sheet: doc.id, text: net, x: at[0], y: at[1], snap: false});
    if (style === "wire") {
      for (let i = 1; i < pins.length; i++) {
        const w = ctx.author.add_wire({sheet: doc.id, from: {designator: pins[i - 1].designator, pin: pins[i - 1].pin}, to: {designator: pins[i].designator, pin: pins[i].pin},
          ...(a.allow_join ? {allow_join: true} : {})});
        made.push({designator: pins[i].designator, pin: String(pins[i].pin), kind: "wire", id: w.id});
      }
      const first = pinInfo(pins[0]), m = marker(pins[0], first.at);
      made.unshift({designator: pins[0].designator, pin: String(pins[0].pin), kind: m.style ? "power" : "netlabel", id: m.id});
    } else {
      for (const x of pins) {
        const info = pinInfo(x);
        let at = info.at, wire = null;
        if (stub > 0) {
          at = [round(info.at[0] + info.dir[0] * stub), round(info.at[1] + info.dir[1] * stub)];
          wire = ctx.author.add_wire({sheet: doc.id, points: [info.at, at], snap: false, ...(a.allow_join ? {allow_join: true} : {})}).id;
        }
        const m = marker(x, at);
        made.push({designator: x.designator, pin: String(x.pin), kind: style === "power" ? "power" : "netlabel", id: m.id, ...(wire ? {wire_id: wire} : {}), at});
      }
    }
    // Check the result: every listed pin should now be on the net (a pin already on another named net shows as a conflict).
    const graph = A.connectivity(doc, defs), conflicts = [];
    for (const x of pins) {
      const part = W.pinAt(p, doc, x.designator, x.pin).part, pinNo = A.pins(part, defs.get(part.def), "schematic").find(q => String(q.number) === String(x.pin) || up(q.name) === up(x.pin))?.number;
      const got = graph.byPin.get(part.id + "/" + pinNo) || "";
      if (got !== net) conflicts.push({designator: x.designator, pin: String(x.pin), net: got});
    }
    const bad = graph.nets.filter(n => n.conflict && (n.name === net || conflicts.some(c => c.net === n.name))).map(n => n.name);
    return {document_id: doc.id, style, pins: made.length, objects: made.map(({designator, pin, ...r}) => r),
      untrusted_design_text: {net, pins: made.map(m => m.designator + "-" + m.pin), conflicts, merged_names: bad}};
  }

  // ---------------------------------------------------------------- netlists
  function importNetlist(a, ctx, body) {
    const N = globalThis.AtriumNetlist || fail("Netlists are not available in this build (netlist.js).");
    const parsed = N.parse(String(body ?? ""), {format: a.format || "auto"});
    if (!parsed.components.length) fail("The netlist lists no components.");
    const p = ctx.mutable();
    const r = N.importInto(p, parsed, {board: a.document_id, sheet_name: a.sheet_name, starter: a.starter_parts === false ? [] : starter()});
    ctx.touched();
    let eco = null;
    if (a.update_pcb !== false) {
      const e = ctx.author.update_pcb({document_id: r.board_id, scope: r.sheet_id, limit: 1});
      eco = {applied: e.applied, failed: e.failed, groups: e.groups, valid: e.valid, untrusted_design_text: {issues: (e.untrusted_design_text?.issues || []).slice(0, 50)}};
    }
    const {issues, sheet_name, ...rest} = r;
    return {...rest, format: parsed.format, eco, untrusted_design_text: {sheet_name, issues: issues.slice(0, 100)}};
  }

  // ---------------------------------------------------------------- multi-route
  function multiRoute(a, ctx) {
    const M = globalThis.AtriumMultiRoute || fail("Multi-routing is not available in this build (multi-route.js).");
    const p = ctx.mutable(), doc = ctx.board(p, a.document_id), defs = ctx.defsOf(p);
    const starts = (a.starts || []).map((s, i) => ctx.endpoint(doc, defs, s, "start " + (i + 1)));
    const nets = a.nets || [];
    starts.forEach((s, i) => { if (nets[i] != null) s.net = nets[i]; });
    const r = M.plan(doc, defs, {starts, to: a.to, ends: a.ends, layer: a.layer, width: a.width, gap: a.gap, budgetMs: a.time_limit_ms, project: p});
    if (!r.routed) fail("No member of the bus could be routed (" + (r.members[0]?.status || "blocked") + ").");
    if (!r.ok && a.require_all) fail("Only " + r.routed + " of " + r.members.length + " members could be routed; nothing was changed (require_all).");
    const counts = ctx.applyPlan(doc, r.plan);
    ctx.touched();
    return {document_id: doc.id, strategy: r.strategy, routed: r.routed, total: r.members.length, layer: r.layer, width: r.width, gap: r.gap, pitch: r.pitch, length: r.length,
      ...counts, members: r.members.map(m => ({ok: m.ok, length: m.length ?? null, status: m.status ?? null, from: m.from, to: m.to})), ms: r.ms,
      untrusted_design_text: {nets: r.members.map(m => m.net), order: r.order}};
  }


  // ---------------------------------------------------------------- route bus
  function routeBus(a, ctx) {
    const B = globalThis.AtriumBusRoute || fail("Bus routing is not available in this build (bus-route.js).");
    const p = ctx.mutable(), doc = ctx.board(p, a.document_id), defs = ctx.defsOf(p);
    const r = B.route(doc, defs, {nets: a.nets, netClass: a.net_class, query: a.query, from: a.from, waypoints: a.waypoints || [], layer: a.layer,
      layers: (a.layer_changes || []).map(c => ({after: c.after, layer: c.layer, pattern: c.pattern})), mode: a.conflict, corner: a.corner, width: a.width, gap: a.gap,
      viaPattern: a.via_pattern, order: a.order, visits: (a.visits || []).map(v => ({after: v.after, to: v.to})), finish: a.to ? {to: a.to} : null, swap: a.swap_pins !== false, tune: !!a.tune, project: p, budgetMs: a.time_limit_ms});
    if (a.require_finish && !r.done) fail("The bus did not reach its destination pads; nothing was changed (require_finish).");
    if (r.swaps?.length) { const PS = globalThis.AtriumPinSwap; if (PS?.applyPlans && p.documents.some(d => d.kind === "schematic")) PS.applyPlans(p, doc, defs, r.swaps); else B.applySwaps(doc, r.swaps); }
    const counts = ctx.applyPlan(doc, r.plan);
    ctx.touched();
    return {document_id: doc.id, done: r.done, ok: r.ok, ...counts, swaps: (r.swaps || []).map(s => ({component: s.ref, pins: s.pairs[0]})),
      members: r.members.map(m => ({length: m.length, delta: m.delta, band: m.band})), steps: r.steps, ms: r.ms, loads: r.loads, hops: r.hops?.length || 1,
      tune: r.tune && {ok: r.tune.ok, target: r.tune.target, tolerance: r.tune.tolerance, after: r.tune.after.map(x => x.length), hops: r.tune.hops, report: r.tune.report},
      untrusted_design_text: {nets: r.nets}};
  }

  const OPS = {find_parts: findParts, place_part: placePart, connect, import_netlist: importNetlist, multi_route: multiRoute, route_bus: routeBus};
  function headless(op, a, ctx, body) { return (OPS[op] || fail("Unknown authoring operation " + op + "."))(a || {}, ctx, body); }
  return Object.freeze({headless, search, resolve, POWER});
})();
