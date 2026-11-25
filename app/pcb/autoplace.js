"use strict";
// Auto placement proposals (Allegro X AI style generative placement, but deterministic).
//
// propose(project, doc, defs, options) places footprints inside the board outline and
// returns scored alternatives; nothing in `doc` changes. An AI client (MCP propose_placement,
// the in-app AI Assistant) or the user (Tools › Auto Place (Proposal)…) reviews the result
// as a proposal and applies it as one undo step.
//
// Pipeline, per alternative (a strategy and a seed):
//   1. Model. Courtyard and DFA-measured boxes per footprint (AtriumDFA when loaded), pad
//      offsets and nets, the board outline with cutouts, keep-outs, rooms (AtriumRooms),
//      schematic sheet of each footprint, connectors (DFA type, designator, parameters) with
//      edge hints, and decoupling capacitors matched to IC power pins.
//   2. Force-directed global placement: star-model net attraction (power and ground nets
//      weigh little), sheet/room/group cluster attraction, overlap repulsion, connectors
//      pulled to their edge.
//   3. Legalisation to the placement grid: connectors along their edge first, then the
//      largest parts each followed by its decoupling capacitors, then the rest. A candidate
//      is legal when its courtyard is inside the board (inset by the margin), clear of
//      cutouts, keep-outs and other courtyards (plus the strategy's spacing) and its
//      DFA-measured outline keeps the DFA matrix gap. Board side is kept: SMD parts on
//      opposite sides may overlap, through-hole parts block both sides.
//   4. Improvement passes: move each part towards its optimal region (median of its nets'
//      bounding boxes) and try every allowed rotation, keep a move only when it shortens
//      the weighted half-perimeter wirelength; swap identical footprints.
//   5. Score: airwire length (minimum spanning tree per net), DFA violations, courtyard
//      overlaps, parts outside the board, utilisation and peak density.
//
// Incremental: locked parts, parts in locked rooms and parts out of scope stay where they
// are and act as obstacles. Scope "unplaced" (default when any exist) places only parts
// whose courtyard is not inside the board or overlaps another courtyard on its side (an ECO
// grid that landed on the board); "selected" the given components; "all" every
// unlocked part. Deterministic for a seed: no Math.random, every loop in a fixed order.
// Resource limits: the work is bounded by iteration and evaluation caps (about 1 s per
// alternative for 500 parts), so a seed gives the same result on every machine; time_limit_ms
// (default 20 s for all alternatives) is a safety net, and hitting it is reported in notes.
//
// DOM-free model (propose, applyMoves, headless, feature); the dialog is browser only.
globalThis.AtriumAutoplace = (() => {
  const A = () => globalThis.Atrium;
  const EPS = 1e-7, INF = Infinity;
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const round = (v, d = 4) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d + 0 : v);
  const fail = m => { throw Error(m); };
  const natural = typeof Intl !== "undefined" ? new Intl.Collator("en", {numeric: true}).compare : (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  function rng(seed) { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // net-intent.js (isGround) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const GROUND_RE = /^(?:[ADPSC]?GND\w*|GND\w*|VSS\w*|0V|EARTH\w*|CHASSIS\w*)$/i;
  const GROUND = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isGround ? N.isGround(String(n ?? "")) : GROUND_RE.test(n); }};
  // net-intent.js (isRail) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const POWER_RE = /^(?:VDD\w*|VCC\w*|VEE\w*|VBAT\w*|VBUS\w*|VIN\w*|VSYS|VREF\w*|AVDD\w*|DVDD\w*|PWR\w*|\+?\d+V\d*\w*|\d+V\d+|V\d+(?:V\d+)?|[+-]\d+(?:\.\d+)?V\w*)$/i;
  const POWER = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isRail ? N.isRail(String(n ?? "")) : POWER_RE.test(n); }};
  const isGround = n => GROUND.test(n || "");
  const isPower = n => !!n && !isGround(n) && (POWER.test(n) || !!globalThis.AtriumAutorouter?.POWER?.test?.(n));

  const STRATEGIES = {
    balanced: {label: "Balanced", spacing: 1.0, cluster: 0.35, spread: 1.0},
    compact: {label: "Compact (shortest wiring)", spacing: 0.5, cluster: 0.25, spread: 1.0},
    clustered: {label: "Clustered by sheet and room", spacing: 1.0, cluster: 1.4, spread: 1.0},
    spread: {label: "Spread (routing room)", spacing: 2.0, cluster: 0.35, spread: 1.0}
  };
  const ORDER = ["balanced", "compact", "clustered", "spread"];
  const LIMITS = {parts: 5000, timeMs: 20000, maxTimeMs: 60000, iterations: 300, passes: 8, alternatives: 4};

  // ------------------------------------------------------------------ geometry
  const trig = a => {
    const n = ((a % 360) + 360) % 360;
    if (n === 0) return [1, 0]; if (n === 90) return [0, 1]; if (n === 180) return [-1, 0]; if (n === 270) return [0, -1];
    const r = n * Math.PI / 180; return [Math.cos(r), Math.sin(r)];
  };
  const norm = a => ((Math.round(a * 1e6) / 1e6 % 360) + 360) % 360;
  function rotBox(b, a) {
    const [c, s] = trig(a);
    if (c === 1) return b;
    let x0 = INF, y0 = INF, x1 = -INF, y1 = -INF;
    for (const [x, y] of [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]) {
      const X = x * c - y * s, Y = x * s + y * c;
      if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
    }
    return [x0, y0, x1, y1];
  }
  const sep = (a, b) => Math.max(b[0] - a[2], a[0] - b[2], b[1] - a[3], a[1] - b[3]);
  function insidePoly(x, y, poly) {
    let r = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) r = !r;
    }
    return r;
  }
  const bbox = pts => { let x0 = INF, y0 = INF, x1 = -INF, y1 = -INF; for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return x0 === INF ? null : [x0, y0, x1, y1]; };
  const isRect = (pts, b) => pts.length === 4 && pts.every(([x, y]) => (Math.abs(x - b[0]) < EPS || Math.abs(x - b[2]) < EPS) && (Math.abs(y - b[1]) < EPS || Math.abs(y - b[3]) < EPS));

  // Local courtyard and DFA-measured boxes of a footprint definition.
  const boxCache = new WeakMap();
  function localBoxes(def, measure) {
    let cached = boxCache.get(def);
    if (!cached) {
      const fp = def.footprint || {}, D = globalThis.AtriumDFA;
      let court = null, body = null;
      if (D?.outlines) { const o = D.outlines(def); court = o.courtyard; body = o.body; }
      if (Array.isArray(fp.courtyard) && fp.courtyard.length === 4 && fp.courtyard.every(Number.isFinite)) court = fp.courtyard.slice();
      if (!court || !body) {
        const pts = [];
        for (const p of fp.pads || []) {
          const w = (+p.w || +p.diameter || 0.5) / 2, h = (+p.h || +p.diameter || 0.5) / 2, r = trig(+p.angle || 0);
          for (const [dx, dy] of [[-w, -h], [w, -h], [w, h], [-w, h]]) pts.push([p.x + dx * r[0] - dy * r[1], p.y + dx * r[1] + dy * r[0]]);
        }
        const shapes = [];
        for (const s of fp.shapes || []) if (s.points) shapes.push(...s.points); else if (s.kind === "circle" && Number.isFinite(s.r)) shapes.push([s.x - s.r, s.y - s.r], [s.x + s.r, s.y + s.r]);
        const b = bbox(pts.concat(shapes)) || [-0.5, -0.5, 0.5, 0.5];
        body = body || bbox(shapes) || bbox(pts) || b;
        court = court || [b[0] - 0.25, b[1] - 0.25, b[2] + 0.25, b[3] + 0.25];
      }
      // The courtyard always holds the pads (a too-small courtyard would let pads touch).
      const pads = bbox((fp.pads || []).flatMap(p => { const w = (+p.w || +p.diameter || 0) / 2, h = (+p.h || +p.diameter || 0) / 2, m = Math.max(w, h); return [[p.x - m, p.y - m], [p.x + m, p.y + m]]; }));
      if (pads) court = [Math.min(court[0], pads[0]), Math.min(court[1], pads[1]), Math.max(court[2], pads[2]), Math.max(court[3], pads[3])];
      cached = {court, body};
      boxCache.set(def, cached);
    }
    return {court: cached.court, meas: measure === "courtyard" ? cached.court : cached.body};
  }

  // Uniform bucket grid of placed rectangles.
  function bucketGrid(box, cell) {
    const map = new Map(), ox = box[0], oy = box[1];
    const key = (i, j) => i * 1048576 + j;
    const span = (r, grow) => [Math.floor((r[0] - grow - ox) / cell), Math.floor((r[1] - grow - oy) / cell), Math.floor((r[2] + grow - ox) / cell), Math.floor((r[3] + grow - oy) / cell)];
    let stamp = 0;
    return {
      insert(o) { const [i0, j0, i1, j1] = span(o.c, 0); o.cells = []; for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = key(i, j); let l = map.get(k); if (!l) map.set(k, l = []); l.push(o); o.cells.push(k); } },
      remove(o) { for (const k of o.cells || []) { const l = map.get(k); const n = l ? l.indexOf(o) : -1; if (n >= 0) l.splice(n, 1); } o.cells = null; },
      // Calls fn(o) once per rectangle near r (within grow); fn returning true stops.
      each(r, grow, fn) {
        const [i0, j0, i1, j1] = span(r, grow), s = ++stamp;
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
          const l = map.get(key(i, j)); if (!l) continue;
          for (const o of l) { if (o.seen === s) continue; o.seen = s; if (fn(o)) return true; }
        }
        return false;
      }
    };
  }

  // ------------------------------------------------------------------ parameters
  const param = (srcs, names) => {
    for (const s of srcs) if (s && typeof s === "object") for (const [k, v] of Object.entries(s)) if (names.includes(String(k).trim().toUpperCase()) && typeof v !== "object") return String(v).trim();
    return "";
  };
  const EDGE_PARAMS = ["PLACEMENT EDGE", "BOARD EDGE", "EDGE", "PLACEMENT"];
  const edgeOf = s => { const m = /^(left|right|top|bottom)$/i.exec(String(s || "").trim()); return m ? m[1].toLowerCase() : ""; };

  function effectiveRules(doc, project) { return globalThis.AtriumRules?.stored?.(doc, project) ?? null; }
  function dfaRule(doc, project) {
    const D = globalThis.AtriumDFA;
    if (!D) return null;
    try { return D.activeRule(doc, project) || D.defaultRule(); } catch { return D.defaultRule?.() || null; }
  }
  function edgeClearance(doc, project) {
    const set = effectiveRules(doc, project);
    const r = set?.version === 2 ? (set.list || []).find(x => x.type === "boardOutlineClearance" && x.enabled !== false) : null;
    return Number.isFinite(r?.gap) ? r.gap : 0.25;
  }

  // ------------------------------------------------------------------ model
  function sheetIndex(project) {
    const byLink = new Map(), byRef = new Map();
    for (const d of project?.documents || []) {
      if (d.kind !== "schematic") continue;
      for (const i of d.items) if (i.kind === "part") { if (i.link) byLink.set(i.link, d.id); if (i.ref) byRef.set(String(i.ref).toUpperCase(), d.id); }
    }
    return item => {
      const l = typeof item.link === "string" ? item.link : "";
      return byLink.get(l) || byLink.get(l.split("@")[0]) || byRef.get(String(item.ref || "").toUpperCase()) || "";
    };
  }
  function keepoutRects(doc) {
    const out = [], D = globalThis.AtriumPCBDraw;
    for (const i of doc.items) {
      const ko = D?.isKeepout ? D.isKeepout(i) : (i.kind !== "part" && (i.keepout === true || /^keep-?out/i.test(i.layer || "")));
      if (!ko) continue;
      let b = null;
      if (Array.isArray(i.points) && i.points.length) b = bbox(i.points);
      else if (Array.isArray(i.a) && Array.isArray(i.b)) b = bbox([i.a, i.b]);
      else if (Number.isFinite(i.x) && Number.isFinite(i.y)) { const r = (+i.r || +i.radius || 0); b = [i.x - r, i.y - r, i.x + r, i.y + r]; }
      if (!b) continue;
      const w = (+i.width || 0) / 2;
      const side = i.keepout === true && i.layer === "Top" ? 1 : i.keepout === true && i.layer === "Bottom" ? 2 : 3;
      if (i.keepout === true && /^Inner/.test(i.layer || "")) continue; // inner copper keep-outs do not block parts
      out.push({c: [b[0] - w, b[1] - w, b[2] + w, b[3] + w], m: null, mask: side, keepout: true});
    }
    // Free pads and vias (mounting holes, test pads, stitching) block footprints too, with a clearance.
    for (const i of doc.items) {
      if ((i.kind !== "pad" && i.kind !== "via") || !Number.isFinite(i.x) || !Number.isFinite(i.y)) continue;
      const r = Math.max(+i.w || 0, +i.h || 0, +i.diameter || 0, +i.drill || 0) / 2 + 0.5;
      const side = i.kind === "via" || +i.drill > 0 || i.layer === "Multi" ? 3 : i.layer === "Bottom" ? 2 : 1;
      out.push({c: [i.x - r, i.y - r, i.x + r, i.y + r], m: null, mask: side, keepout: true});
    }
    return out;
  }
  function resolveParts(doc, list, what) {
    if (!list) return null;
    const out = new Set();
    for (const c of list) {
      const p = doc.items.find(i => i.kind === "part" && (i.id === c || i.ref === c));
      if (!p) fail("No component " + c + " is on this board" + (what ? " (" + what + ")" : "") + ".");
      out.add(p.id);
    }
    return out;
  }

  function prepare(project, doc, defs, o = {}) {
    if (!doc || doc.kind !== "pcb") fail("Choose a PCB layout to place.");
    const c = o.constraints || {};
    const outline = Array.isArray(doc.outline) && doc.outline.length >= 3 ? doc.outline.map(p => [+p[0], +p[1]]) : null;
    if (!outline) fail("Set the board outline first: placement needs a board shape.");
    const box = bbox(outline);
    let cutouts = [];
    try { if (doc.boardShape && globalThis.AtriumBoardShape?.flatten) cutouts = AtriumBoardShape.flatten(doc.boardShape).cutouts || []; } catch { cutouts = []; }
    const margin = Number.isFinite(c.margin) ? c.margin : edgeClearance(doc, project) + 0.25;
    const grid = Number.isFinite(c.grid) && c.grid > 0 ? c.grid : 0.25;
    const rule = dfaRule(doc, project), D = globalThis.AtriumDFA;
    const measure = rule?.measure || "courtyard";
    const all = doc.items.filter(i => i.kind === "part" && defs.get(i.def)?.footprint);
    if (all.length > LIMITS.parts) fail("Auto placement handles up to " + LIMITS.parts + " footprints per run; select fewer.");
    const sheetOf = sheetIndex(project), R = globalThis.AtriumRooms;
    const selected = resolveParts(doc, o.components, "components");
    const forced = new Map();
    for (const [k, v] of Object.entries(c.place || {})) {
      const p = doc.items.find(i => i.kind === "part" && (i.id === k || i.ref === k)) || fail("No component " + k + " is on this board (constraints.place).");
      forced.set(p.id, v);
    }
    const edges = new Map();
    for (const [k, v] of Object.entries(c.edges || {})) {
      const p = doc.items.find(i => i.kind === "part" && (i.id === k || i.ref === k)) || fail("No component " + k + " is on this board (constraints.edges).");
      if (!edgeOf(v)) fail("constraints.edges values are left, right, top or bottom.");
      edges.set(p.id, edgeOf(v));
    }
    const groups = (c.groups || []).map((g, n) => { const s = resolveParts(doc, g, "constraints.groups"); return {n, ids: s}; });
    const region = Array.isArray(c.region) && c.region.length === 4 ? c.region.slice() : null;
    const inBoard = (b, m = margin) => {
      if (b[0] - m < box[0] - EPS || b[1] - m < box[1] - EPS || b[2] + m > box[2] + EPS || b[3] + m > box[3] + EPS) return false;
      if (!M.rectBoard) {
        const q = [[b[0] - m, b[1] - m], [b[2] + m, b[1] - m], [b[2] + m, b[3] + m], [b[0] - m, b[3] + m]];
        if (!q.every(([x, y]) => insidePoly(x, y, outline))) return false;
        for (const [x, y] of outline) if (x > b[0] - m + EPS && x < b[2] + m - EPS && y > b[1] - m + EPS && y < b[3] + m - EPS) return false;
      }
      for (const cut of cutouts) {
        const cb = bbox(cut);
        if (!cb || cb[0] > b[2] + m || cb[2] < b[0] - m || cb[1] > b[3] + m || cb[3] < b[1] - m) continue;
        if (cut.some(([x, y]) => x > b[0] - m && x < b[2] + m && y > b[1] - m && y < b[3] + m)) return false;
        if ([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].some(([x, y]) => insidePoly(x, y, cut))) return false;
      }
      return true;
    };
    const M = {doc, defs, project, outline, box, rectBoard: isRect(outline, box) && !cutouts.length, cutouts, margin, grid, rule, measure, inBoard, region,
      rotate: c.rotate !== false, parts: [], nets: [], notes: [], keepouts: keepoutRects(doc).concat((c.keepouts || []).map(b => ({c: b.slice(), m: null, mask: 3, keepout: true})))};
    // Gap cache for package type pairs.
    const gaps = new Map();
    M.gap = (a, b) => { const k = a + "|" + b; let g = gaps.get(k); if (g == null) { g = rule && D ? D.gapFor(rule, a, b) : 0; gaps.set(k, g); } return g; };
    M.maxGap = rule && D?.maxGap ? D.maxGap(rule) : 1;
    // Routed parts (copper ends on their pads) stay put unless rip_up allows moving them.
    const routedPads = new Map();
    for (const i of doc.items) if ((i.kind === "track" || i.kind === "via") && i.net) {
      const pts = i.kind === "via" ? [[i.x, i.y]] : (i.points || []);
      for (const p of pts) { let l = routedPads.get(i.net); if (!l) routedPads.set(i.net, l = []); l.push(p); }
    }
    const netIndex = new Map();
    const order = all.slice().sort((a, b) => natural(a.ref || "", b.ref || "") || natural(a.id, b.id));
    const scope = o.scope || (selected ? "selected" : "auto");
    let unplacedCount = 0;
    for (const item of order) {
      const def = defs.get(item.def), fp = def.footprint, {court, meas} = localBoxes(def, measure);
      const type = D?.packageType ? D.packageType(item, def) : ((fp.pads || []).some(p => p.drill > 0) ? "tht" : "other");
      const tht = type === "tht" || (fp.pads || []).some(p => p.drill > 0);
      const side = item.layer === "Bottom" ? 2 : 1;
      const r = {i: M.parts.length, id: item.id, ref: item.ref || item.id, item, def, court, meas, type, tht, side, mask: tht ? 3 : side,
        x: +item.x || 0, y: +item.y || 0, a: norm(+item.angle || 0), x0: +item.x || 0, y0: +item.y || 0, a0: norm(+item.angle || 0), pads: [], movable: false, kind: "other",
        sheet: sheetOf(item), room: null, roomBox: null, edge: "", decap: null, groups: []};
      for (const p of fp.pads || []) {
        if (p.thermalVia) continue;
        const net = item.pinNets?.[p.number] || "";
        r.pads.push({lx: +p.x || 0, ly: +p.y || 0, net: net ? (netIndex.has(net) ? netIndex.get(net) : (netIndex.set(net, netIndex.size), netIndex.size - 1)) : -1, name: String(p.number)});
      }
      const wb = worldBox(r, r.court);
      r.inside = inBoard(wb, 0);
      if (!r.inside) unplacedCount++;
      const room = R?.roomOf ? R.roomOf(doc, item) : null;
      if (room && Array.isArray(room.points) && room.points.length >= 3) { r.room = room.id; r.roomBox = bbox(room.points); r.roomLocked = !!room.locked; }
      // Connectors: DFA type, designator letter or category; edge from parameters or constraints.
      const conn = type === "connector" || /^(?:J|P|CN|CON|X|USB)\d/i.test(r.ref) || /connector|header/i.test(def.category || "");
      if (conn) { r.kind = "conn"; r.edge = edges.get(item.id) || edgeOf(param([item.parameters, def.parameters], EDGE_PARAMS)); }
      else if (r.pads.length >= 5) r.kind = "ic";
      else if (edges.has(item.id)) { r.kind = "conn"; r.edge = edges.get(item.id); }
      r.groups = groups.filter(g => g.ids.has(item.id)).map(g => g.n);
      M.parts.push(r);
    }
    // A footprint inside the board whose courtyard overlaps another one on its side (an ECO grid
    // that landed on the board, a pasted pile) is not placed yet either.
    const insideList = M.parts.filter(r => r.inside).map(r => ({r, b: worldBox(r, r.court)})).sort((a, b) => a.b[0] - b.b[0]);
    for (let i = 0; i < insideList.length; i++) for (let j = i + 1; j < insideList.length; j++) {
      const a = insideList[i], b = insideList[j];
      if (b.b[0] > a.b[2]) break;
      if ((a.r.mask & b.r.mask) && sep(a.b, b.b) < -0.05) { a.r.piled = b.r.piled = true; }
    }
    for (const r of M.parts) if (r.piled) { r.inside = false; unplacedCount++; }
    M.nets = [...netIndex.keys()].map((name, n) => ({n, name, pins: [], power: isPower(name), ground: isGround(name), w: 0}));
    for (const r of M.parts) r.pads.forEach((p, k) => { if (p.net >= 0) M.nets[p.net].pins.push([r.i, k]); });
    for (const net of M.nets) {
      const k = net.pins.length;
      net.w = k < 2 || k > 60 ? 0 : (net.ground ? 0.08 : net.power ? 0.15 : 1) / Math.sqrt(k - 1);
    }
    // Scope and locks.
    const mode = scope === "auto" ? (unplacedCount ? "unplaced" : "all") : scope;
    if (!["unplaced", "selected", "all"].includes(mode)) fail("scope is unplaced, selected or all.");
    if (mode === "selected" && !selected) fail("Give the components to place (scope selected).");
    let locked = 0, routed = 0;
    for (const r of M.parts) {
      const inScope = mode === "all" || (mode === "unplaced" && !r.inside) || (mode === "selected" && selected.has(r.id));
      if (!inScope) continue;
      if (r.item.locked === true || r.roomLocked) { locked++; continue; }
      if (forced.has(r.id)) continue;
      if (r.inside && !c.rip_up && r.pads.some(p => p.net >= 0 && (routedPads.get(M.nets[p.net].name) || []).some(q => Math.hypot(q[0] - (r.x + rotPt(p, r.a)[0]), q[1] - (r.y + rotPt(p, r.a)[1])) < 0.6))) { routed++; continue; }
      r.movable = true;
    }
    for (const [id, v] of forced) {
      const r = M.parts.find(q => q.id === id);
      if (r.item.locked || r.roomLocked) fail("Unlock " + r.ref + " before specifying its placement.");
      if (mode === "selected" && !selected.has(id)) fail(r.ref + " is outside the selected placement scope.");
      if (Number.isFinite(v.x)) r.x = v.x; if (Number.isFinite(v.y)) r.y = v.y; if (Number.isFinite(v.angle)) r.a = norm(v.angle);
      r.forced = true;
    }
    M.scope = mode; M.locked = locked; M.routed = routed;
    if (locked) M.notes.push(locked + " locked footprint" + (locked === 1 ? "" : "s") + " kept in place.");
    if (routed) M.notes.push(routed + " routed footprint" + (routed === 1 ? "" : "s") + " kept in place (constraints.rip_up moves them; their copper is not moved).");
    // Decoupling capacitors: two pads, one on ground and one on a power net an IC uses.
    const ics = M.parts.filter(r => r.kind === "ic");
    const load = new Map();
    for (const r of M.parts) {
      if (r.kind !== "other" || r.pads.length !== 2 || !/^C/i.test(r.ref)) continue;
      const nets = r.pads.map(p => p.net >= 0 ? M.nets[p.net] : null);
      const g = nets.findIndex(n => n?.ground), pw = nets.findIndex(n => n && !n.ground && (n.power || n.pins.length >= 3));
      if (g < 0 || pw < 0) continue;
      let best = null;
      for (const ic of ics) for (let k = 0; k < ic.pads.length; k++) {
        if (ic.pads[k].net !== r.pads[pw].net) continue;
        const key = ic.i + "/" + k, n = load.get(key) || 0;
        if (!best || n < best.n || (n === best.n && natural(ic.ref, best.ic.ref) < 0)) best = {ic, k, n, key};
      }
      if (best) { load.set(best.key, best.n + 1); r.kind = "decap"; r.decap = {ic: best.ic.i, pad: best.k, pw, g, rank: best.n}; (best.ic.caps ||= []).push(r.i); }
    }
    return M;
  }
  const rotPt = (p, a) => { const [c, s] = trig(a); return [p.lx * c - p.ly * s, p.lx * s + p.ly * c]; };
  function worldBox(r, local, x = r.x, y = r.y, a = r.a) { const b = rotBox(local, a); return [b[0] + x, b[1] + y, b[2] + x, b[3] + y]; }

  // ------------------------------------------------------------------ wirelength
  function pinXY(M, r, k) { const p = r.pads[k], [c, s] = r.trig || (r.trig = trig(r.a)); return [r.x + p.lx * c - p.ly * s, r.y + p.lx * s + p.ly * c]; }
  function setPose(r, x, y, a) { r.x = x; r.y = y; if (a !== r.a) { r.a = a; r.trig = trig(a); } }
  function hpwl(M, net) {
    let x0 = INF, y0 = INF, x1 = -INF, y1 = -INF;
    for (const [pi, k] of net.pins) { const [x, y] = pinXY(M, M.parts[pi], k); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return x1 - x0 + y1 - y0;
  }
  function partNets(M, r) { if (!r.netList) r.netList = [...new Set(r.pads.map(p => p.net).filter(n => n >= 0 && M.nets[n].w > 0))]; return r.netList; }
  // Weighted HPWL of the part's nets, plus the distance of decoupling capacitors to their IC pin
  // (an IC counts its capacitors too, so it does not walk away from them).
  function partCost(M, r) {
    let s = 0;
    for (const n of partNets(M, r)) {
      const net = M.nets[n];
      if (net.pins.length === 2) {
        const [a, b] = net.pins, p = pinXY(M, M.parts[a[0]], a[1]), q = pinXY(M, M.parts[b[0]], b[1]);
        const dx = Math.abs(p[0] - q[0]), dy = Math.abs(p[1] - q[1]);
        s += net.w * (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy));
      } else s += net.w * hpwl(M, net);
    }
    if (r.caps) for (const k of r.caps) if (M.parts[k].placed) s += decapCost(M, M.parts[k]);
    return s + decapCost(M, r);
  }
  function decapCost(M, r) {
    if (!r.decap) return 0;
    const ic = M.parts[r.decap.ic], [px, py] = pinXY(M, ic, r.decap.pad), [qx, qy] = pinXY(M, r, r.decap.pw);
    return 3 * Math.hypot(px - qx, py - qy);
  }
  function mst(points) {
    const n = points.length;
    if (n < 2) return 0;
    if (n > 400) { const b = bbox(points); return (b[2] - b[0] + b[3] - b[1]) * Math.sqrt(n) / 2; }
    const used = new Uint8Array(n), dist = new Float64Array(n).fill(INF);
    let total = 0, cur = 0; used[0] = 1;
    for (let step = 1; step < n; step++) {
      let best = -1, bd = INF;
      for (let j = 0; j < n; j++) {
        if (used[j]) continue;
        const d = Math.hypot(points[j][0] - points[cur][0], points[j][1] - points[cur][1]);
        if (d < dist[j]) dist[j] = d;
        if (dist[j] < bd) { bd = dist[j]; best = j; }
      }
      used[best] = 1; total += bd; cur = best;
    }
    return total;
  }

  // ------------------------------------------------------------------ legality
  function rectOf(M, r, x, y, a) {
    const c = worldBox(r, r.court, x, y, a), m = r.meas === r.court ? c : worldBox(r, r.meas, x, y, a);
    return {c, m, mask: r.mask, type: r.type, r};
  }
  function legal(M, S, r, x, y, a, spacing) {
    const o = rectOf(M, r, x, y, a), c = o.c;
    const lim = r.roomBox && S.useRooms ? r.roomBox : M.region;
    if (lim && (c[0] < lim[0] - EPS || c[1] < lim[1] - EPS || c[2] > lim[2] + EPS || c[3] > lim[3] + EPS)) return false;
    if (!M.inBoard(c)) return false;
    const reach = spacing + M.maxGap + EPS;
    return !S.hash.each(c, reach, q => {
      if (q.r === r || !(q.mask & o.mask)) return false;
      if (q.keepout) return sep(c, q.c) < EPS;
      if (sep(c, q.c) < spacing - EPS) return true;
      const g = M.gap(o.type, q.type);
      return g > 0 && sep(o.m, q.m) < g - EPS;
    });
  }
  function place(S, r, x, y, a) { setPose(r, x, y, a); r.rect = rectOf(S.M, r, x, y, a); S.hash.insert(r.rect); r.placed = true; }
  function lift(S, r) { if (r.rect) S.hash.remove(r.rect); r.rect = null; r.placed = false; }

  // Ring search around (tx, ty): returns the legal pose with the lowest cost.
  function search(S, r, tx, ty, angles, cost, o = {}) {
    const M = S.M, g = M.grid, snap = v => Math.round(v / g) * g + 0;
    const maxR = o.maxR ?? Math.max(M.box[2] - M.box[0], M.box[3] - M.box[1]) * 1.5;
    const budget = o.evals ?? 6000, extra = o.extraRings ?? 2;
    let best = null, bestCost = INF, evals = 0, foundAt = -1, rad = 0;
    tx = snap(tx); ty = snap(ty);
    for (let k = 0; rad <= maxR; k++) {
      const step = g * (1 + Math.floor(k / 12));
      const pts = [];
      if (k === 0) pts.push([tx, ty]);
      else {
        const n = Math.max(1, Math.round(rad / step));
        for (let i = -n; i <= n; i++) { const d = snap(i * rad / n); pts.push([tx + d, ty - rad], [tx + d, ty + rad]); }
        for (let i = -n + 1; i < n; i++) { const d = snap(i * rad / n); pts.push([tx - rad, ty + d], [tx + rad, ty + d]); }
      }
      for (const [x, y] of pts) {
        if (o.line && !o.line(x, y)) continue;
        for (const a of angles) {
          if (++evals > budget) return best;
          if (!legal(M, S, r, x, y, a, S.spacing)) continue;
          const v = cost(x, y, a);
          if (v < bestCost - EPS) { bestCost = v; best = {x, y, a, cost: v}; }
        }
      }
      if (best && foundAt < 0) foundAt = k;
      if (foundAt >= 0 && k - foundAt >= extra) break;
      rad = snap(rad + step);
    }
    return best;
  }

  // The centre of a footprint is often far from the pin that needs connecting.
  // Try aligning actual pads beside their connected neighbour's legal courtyard.
  function pinAligned(S, r, angles, best) {
    const M = S.M, g = M.grid, snap = v => Math.round(v / g) * g;
    const up = v => Math.ceil((v - EPS) / g) * g, down = v => Math.floor((v + EPS) / g) * g;
    let considered = 0;
    for (const n of partNets(M, r)) {
      const net = M.nets[n];
      if (net.pins.length !== 2) continue;
      const mine = net.pins.find(p => p[0] === r.i), other = net.pins.find(p => p[0] !== r.i);
      if (!mine || !other) continue;
      const neighbour = M.parts[other[0]];
      if (!neighbour.placed || !(neighbour.mask & r.mask)) continue;
      const pin = pinXY(M, neighbour, other[1]), c = neighbour.rect.c, m = neighbour.rect.m;
      const d = M.gap(r.type, neighbour.type);
      for (const a of angles) {
        const [px, py] = rotPt(r.pads[mine[1]], a), x = snap(pin[0] - px), y = snap(pin[1] - py);
        const b = rotBox(r.court, a), f = rotBox(r.meas, a);
        const poses = [
          [down(Math.min(c[0] - S.spacing - b[2], m[0] - d - f[2])), y],
          [up(Math.max(c[2] + S.spacing - b[0], m[2] + d - f[0])), y],
          [x, down(Math.min(c[1] - S.spacing - b[3], m[1] - d - f[3]))],
          [x, up(Math.max(c[3] + S.spacing - b[1], m[3] + d - f[1]))]
        ];
        for (const [x, y] of poses) {
          if (!legal(M, S, r, x, y, a, S.spacing)) continue;
          setPose(r, x, y, a);
          const cost = partCost(M, r);
          if (!best || cost < best.cost - EPS) best = {x, y, a, cost};
        }
      }
      if (++considered >= 4) break;
    }
    return best;
  }

  // ------------------------------------------------------------------ one run
  function edgeTarget(M, r, edge, x, y, a) {
    const b = rotBox(r.court, a), m = M.margin, B = M.box;
    if (edge === "left") return [B[0] + m - b[0], y];
    if (edge === "right") return [B[2] - m - b[2], y];
    if (edge === "top") return [x, B[1] + m - b[1]];
    return [x, B[3] - m - b[3]];
  }
  function edgeAngles(M, r, edge) {
    const base = r.forced || !M.rotate ? [r.a] : [0, 90, 180, 270].map(d => norm(r.a0 + d));
    const want = edge === "left" || edge === "right" ? "tall" : "wide";
    const fit = base.filter(a => { const b = rotBox(r.court, a), w = b[2] - b[0], h = b[3] - b[1]; return want === "tall" ? h >= w - EPS : w >= h - EPS; });
    return fit.length ? fit : base;
  }
  function nearestEdge(M, x, y) {
    const B = M.box, d = [["left", x - B[0]], ["right", B[2] - x], ["top", y - B[1]], ["bottom", B[3] - y]];
    d.sort((p, q) => p[1] - q[1]);
    return d[0][0];
  }

  function run(M, strategy, seed, deadline, o = {}) {
    const st = STRATEGIES[strategy] || STRATEGIES.balanced, c = o.constraints || {};
    const spacing = Number.isFinite(c.spacing) ? c.spacing : st.spacing;
    const random = rng(seed * 7919 + ORDER.indexOf(strategy) + 1);
    // Fresh state for this alternative.
    for (const r of M.parts) { setPose(r, r.forced ? r.x : r.x0, r.forced ? r.y : r.y0, r.forced ? r.a : r.a0); r.rect = null; r.placed = false; r.failed = false; }
    const B = M.region ? [Math.max(M.box[0], M.region[0]), Math.max(M.box[1], M.region[1]), Math.min(M.box[2], M.region[2]), Math.min(M.box[3], M.region[3])] : M.box;
    const S = {M, spacing, hash: bucketGrid(M.box, Math.max(2, Math.min(10, (B[2] - B[0]) / 20))), useRooms: true};
    const mov = M.parts.filter(r => r.movable), fixed = M.parts.filter(r => !r.movable);
    for (const k of M.keepouts) S.hash.insert({...k, r: null, type: "keepout"});
    for (const r of fixed) if (r.forced || r.inside || r.piled) place(S, r, r.x, r.y, r.a);
    const stats = {iterations: 0, passes: 0, moved: 0, swaps: 0, unplaced: [], evals: 0}, tStart = now();
    if (!mov.length) return finish(M, S, strategy, seed, spacing, stats);
    const inner = [B[0] + M.margin, B[1] + M.margin, B[2] - M.margin, B[3] - M.margin];
    const W = Math.max(1, inner[2] - inner[0]), H = Math.max(1, inner[3] - inner[1]);
    // Rooms whose parts cannot fit fall back to the whole board.
    const roomArea = new Map();
    for (const r of mov) if (r.roomBox) { const b = rotBox(r.court, r.a); roomArea.set(r.room, (roomArea.get(r.room) || 0) + (b[2] - b[0] + spacing) * (b[3] - b[1] + spacing)); }
    for (const r of mov) if (r.roomBox) {
      const rb = r.roomBox, area = (rb[2] - rb[0]) * (rb[3] - rb[1]);
      if (roomArea.get(r.room) > area * 0.9) { r.roomBox = null; r.roomTooSmall = true; }
    }
    // ---- 1. initial positions
    const seeds = new Map();
    const seedOf = key => { if (!seeds.has(key)) seeds.set(key, [inner[0] + W * (0.2 + 0.6 * random()), inner[1] + H * (0.2 + 0.6 * random())]); return seeds.get(key); };
    for (const r of mov) {
      if (r.inside && M.scope !== "unplaced" && !c.restart) continue;
      const [sx, sy] = r.roomBox ? [(r.roomBox[0] + r.roomBox[2]) / 2, (r.roomBox[1] + r.roomBox[3]) / 2] : seedOf(r.sheet || "-");
      setPose(r, sx + (random() - 0.5) * W * 0.25, sy + (random() - 0.5) * H * 0.25, r.a);
    }
    // ---- 2. force-directed global placement
    const iters = Math.min(LIMITS.iterations, Math.max(10, c.iterations ?? (mov.length > 300 ? 50 : 80)));
    const free = mov.filter(r => r.kind !== "decap");
    const clusterW = st.cluster;
    const groupMembers = new Map();
    for (const r of M.parts) for (const g of r.groups) { if (!groupMembers.has(g)) groupMembers.set(g, []); groupMembers.get(g).push(r); }
    // Overlap repulsion over a spatial hash: overlapping inflated courtyards push apart along the
    // shallower axis (fixed parts push fully). Returns the total overlap resolved.
    const pad2 = spacing / 2 + Math.min(0.5, M.maxGap / 2);
    const halfOf = r => { const b = rotBox(r.court, r.a); return [(b[2] - b[0]) / 2 + pad2, (b[3] - b[1]) / 2 + pad2, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; };
    function repel(sweeps) {
      let moved = 0;
      for (let s = 0; s < sweeps; s++) {
        const cell = Math.max(2, Math.sqrt(W * H / Math.max(1, M.parts.length)) * 1.5), buckets = new Map();
        const live = free.concat(fixed.filter(r => r.placed));
        for (const r of live) { const k = Math.floor(r.x / cell) * 1048576 + Math.floor(r.y / cell); let l = buckets.get(k); if (!l) buckets.set(k, l = []); l.push(r); }
        for (const a of free) {
          const [ha, va, ca, da] = halfOf(a), ix = Math.floor(a.x / cell), iy = Math.floor(a.y / cell), R = Math.ceil((Math.max(ha, va) + 8) / cell);
          for (let i = ix - R; i <= ix + R; i++) for (let j = iy - R; j <= iy + R; j++) {
            const l = buckets.get(i * 1048576 + j); if (!l) continue;
            for (const b of l) {
              if (b === a || !(a.mask & b.mask)) continue;
              const [hb, vb, cb, db] = halfOf(b);
              const dx = (b.x + cb) - (a.x + ca), dy = (b.y + db) - (a.y + da);
              const ox = ha + hb - Math.abs(dx), oy = va + vb - Math.abs(dy);
              if (ox <= 0 || oy <= 0) continue;
              const fixedB = !b.movable || b.kind === "decap", share = fixedB ? 1 : 0.5;
              // Coincident centres split along x by designator order (deterministic).
              const sx = dx > 0 || (dx === 0 && a.i < b.i) ? -1 : 1, sy = dy > 0 || (dy === 0 && a.i < b.i) ? -1 : 1;
              if (ox < oy) { const m = sx * ox * share * 0.9; setPose(a, a.x + m, a.y, a.a); if (!fixedB) setPose(b, b.x - m, b.y, b.a); moved += Math.abs(m); }
              else { const m = sy * oy * share * 0.9; setPose(a, a.x, a.y + m, a.a); if (!fixedB) setPose(b, b.x, b.y - m, b.a); moved += Math.abs(m); }
            }
          }
        }
      }
      return moved;
    }
    // Stay inside the placement area (the room, else the board).
    function clamp() {
      for (const r of free) {
        const lim = r.roomBox || inner, b = rotBox(r.court, r.a);
        const x = Math.min(Math.max(r.x, lim[0] - b[0]), lim[2] - b[2]), y = Math.min(Math.max(r.y, lim[1] - b[1]), lim[3] - b[3]);
        setPose(r, lim[2] - lim[0] < b[2] - b[0] ? (lim[0] + lim[2]) / 2 : x, lim[3] - lim[1] < b[3] - b[1] ? (lim[1] + lim[3]) / 2 : y, r.a);
      }
    }
    for (let it = 0; it < iters; it++) {
      if (now() > deadline) { M.notes.push("Time limit reached during global placement: raise time_limit_ms for a result that does not depend on machine speed."); break; }
      stats.iterations++;
      const cx = new Float64Array(M.nets.length), cy = new Float64Array(M.nets.length);
      for (const net of M.nets) {
        if (!net.w) continue;
        let sx = 0, sy = 0;
        for (const [pi, k] of net.pins) { const [x, y] = pinXY(M, M.parts[pi], k); sx += x; sy += y; }
        cx[net.n] = sx; cy[net.n] = sy;
      }
      const sheetC = new Map(), groupC = new Map();
      if (clusterW > 0) for (const r of M.parts) if (r.sheet && (r.movable || r.inside)) { const s = sheetC.get(r.sheet) || [0, 0, 0]; s[0] += r.x; s[1] += r.y; s[2]++; sheetC.set(r.sheet, s); }
      for (const [g, list] of groupMembers) { let sx = 0, sy = 0; for (const r of list) { sx += r.x; sy += r.y; } groupC.set(g, [sx / list.length, sy / list.length]); }
      const t = it / iters;
      for (const r of free) {
        // Star model: each pad pulls the origin towards its net's other pins (minus the pad offset).
        let sx = 0, sy = 0, sw = 0;
        for (let k = 0; k < r.pads.length; k++) {
          const p = r.pads[k]; if (p.net < 0) continue;
          const net = M.nets[p.net]; if (!net.w) continue;
          const n = net.pins.length, [px, py] = pinXY(M, r, k);
          const ox = (cx[net.n] - px) / (n - 1), oy = (cy[net.n] - py) / (n - 1);
          sx += net.w * (ox - (px - r.x)); sy += net.w * (oy - (py - r.y)); sw += net.w;
        }
        const base = Math.max(sw, 0.2);
        if (r.sheet && clusterW > 0) { const s = sheetC.get(r.sheet); if (s && s[2] > 1) { sx += base * clusterW * s[0] / s[2]; sy += base * clusterW * s[1] / s[2]; sw += base * clusterW; } }
        for (const g of r.groups) { const q = groupC.get(g); sx += base * 1.5 * q[0]; sy += base * 1.5 * q[1]; sw += base * 1.5; }
        if (r.roomBox) { sx += base * 2 * (r.roomBox[0] + r.roomBox[2]) / 2; sy += base * 2 * (r.roomBox[1] + r.roomBox[3]) / 2; sw += base * 2; }
        const alpha = 0.55 * (1 - 0.6 * t);
        if (sw > 0) { const tx = sx / sw, ty = sy / sw; setPose(r, r.x + alpha * (tx - r.x), r.y + alpha * (ty - r.y), r.a); }
        if (r.kind === "conn" && t > 0.3) {
          if (!r.edge) r.edge = nearestEdge(M, r.x, r.y);
          const [ex, ey] = edgeTarget(M, r, r.edge, r.x, r.y, r.a);
          setPose(r, r.x + 0.7 * (ex - r.x), r.y + 0.7 * (ey - r.y), r.a);
        }
      }
      repel(t < 0.4 ? 1 : t < 0.8 ? 2 : 3);
      clamp();
    }
    // Spreading: repulsion only, until the inflated courtyards barely overlap (near-legal).
    for (let k = 0; k < 16 && now() <= deadline; k++) { if (repel(1) < 1e-3 * free.length) break; clamp(); }
    clamp();
    stats.force_ms = Math.round(now() - tStart);
    // ---- 3. legalisation
    const anglesOf = r => r.forced || !M.rotate ? [r.a] : [0, 90, 180, 270].map(d => norm(r.a0 + d));
    const bestAngles = (r, x, y) => {
      const list = anglesOf(r);
      if (list.length === 1) return list;
      const keep = [r.x, r.y, r.a], scored = list.map(a => { setPose(r, x, y, a); return [partCost(M, r), a]; });
      setPose(r, keep[0], keep[1], keep[2]);
      scored.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      return scored.map(s => s[1]);
    };
    const dist = (tx, ty) => (x, y) => Math.hypot(x - tx, y - ty);
    const area = r => { const b = r.court; return (b[2] - b[0]) * (b[3] - b[1]); };
    const decaps = new Map();
    for (const r of mov) if (r.kind === "decap") { const k = r.decap.ic; if (!decaps.has(k)) decaps.set(k, []); decaps.get(k).push(r); }
    const order = [...mov.filter(r => r.kind === "conn"), ...mov.filter(r => r.kind !== "conn" && r.kind !== "decap").sort((a, b) => area(b) - area(a) || natural(a.ref, b.ref))];
    const placeDecaps = ic => {
      for (const d of (decaps.get(ic.i) || []).sort((a, b) => a.decap.rank - b.decap.rank || natural(a.ref, b.ref))) {
        if (d.placed) continue;
        const [px, py] = pinXY(M, ic, d.decap.pad), b = rotBox(ic.court, ic.a), ccx = ic.x + (b[0] + b[2]) / 2, ccy = ic.y + (b[1] + b[3]) / 2;
        // Start just outside the IC courtyard, in the direction of the pin.
        let ux = px - ccx, uy = py - ccy; const l = Math.hypot(ux, uy) || 1; ux /= l; uy /= l;
        const tx = px + ux * 1.5, ty = py + uy * 1.5;
        const angles = anglesOf(d);
        const cost = (x, y, a) => { setPose(d, x, y, a); const v = decapCost(M, d); return v; };
        const keep = [d.x, d.y, d.a], best = search(S, d, tx, ty, angles, cost, {maxR: 25, extraRings: 3, evals: 24000});
        setPose(d, keep[0], keep[1], keep[2]);
        if (best) place(S, d, best.x, best.y, best.a);
      }
    };
    for (const ic of fixed) if (decaps.has(ic.i) && ic.placed) placeDecaps(ic);
    for (const r of order) {
      let best = null;
      if (r.kind === "conn") {
        const edges = [r.edge || nearestEdge(M, r.x, r.y), ...["left", "right", "top", "bottom"].filter(e => e !== r.edge)];
        for (const e of edges) {
          const angles = edgeAngles(M, r, e), a0 = angles[0];
          const [ex, ey] = edgeTarget(M, r, e, r.x, r.y, a0);
          // Slide along the edge: candidates keep the edge-flush coordinate.
          const flush = (x, y, a) => { const [fx, fy] = edgeTarget(M, r, e, x, y, a); return e === "left" || e === "right" ? Math.abs(x - fx) < M.grid : Math.abs(y - fy) < M.grid; };
          best = search(S, r, ex, ey, angles, (x, y, a) => (flush(x, y, a) ? 0 : 50) + Math.hypot(x - ex, y - ey), {extraRings: 1, evals: 5000});
          if (best && best.cost < 50) { r.edge = e; break; }
          best = null;
        }
      }
      if (!best) best = search(S, r, r.x, r.y, bestAngles(r, r.x, r.y), dist(r.x, r.y), {evals: 8000});
      if (!best) best = search(S, r, (inner[0] + inner[2]) / 2, (inner[1] + inner[3]) / 2, anglesOf(r), () => 0, {evals: 40000, extraRings: 0});
      if (!best && r.roomBox) { S.useRooms = false; best = search(S, r, r.x, r.y, anglesOf(r), dist(r.x, r.y), {evals: 20000}); S.useRooms = true; if (best) r.roomBox = null; }
      if (best) { place(S, r, best.x, best.y, best.a); if (decaps.has(r.i)) placeDecaps(r); }
      else { setPose(r, r.x0, r.y0, r.a0); r.failed = true; stats.unplaced.push({id: r.id, reason: "no legal position inside the board (board too full, keep-outs or spacing)"}); }
      if (now() > deadline + 2000) { for (const q of order) if (!q.placed && q !== r && !stats.unplaced.some(u => u.id === q.id)) { setPose(q, q.x0, q.y0, q.a0); q.failed = true; stats.unplaced.push({id: q.id, reason: "time limit"}); } break; }
    }
    for (const r of mov) if (r.kind === "decap" && !r.placed && !stats.unplaced.some(u => u.id === r.id)) {
      const best = search(S, r, r.x, r.y, anglesOf(r), dist(r.x, r.y), {evals: 20000});
      if (best) place(S, r, best.x, best.y, best.a); else { setPose(r, r.x0, r.y0, r.a0); r.failed = true; stats.unplaced.push({id: r.id, reason: "no legal position near its IC"}); }
    }
    stats.legal_ms = Math.round(now() - tStart) - stats.force_ms;
    // ---- 4. improvement passes
    const passes = Math.min(LIMITS.passes, Math.max(0, c.passes ?? (mov.length > 300 ? 3 : 4)));
    const median = v => { v.sort((a, b) => a - b); const n = v.length; return n ? (n % 2 ? v[n >> 1] : (v[n / 2 - 1] + v[n / 2]) / 2) : NaN; };
    const target = r => {
      if (r.decap) { const ic = M.parts[r.decap.ic]; return pinXY(M, ic, r.decap.pad); }
      const xs = [], ys = [];
      for (const n of partNets(M, r)) {
        let x0 = INF, y0 = INF, x1 = -INF, y1 = -INF;
        for (const [pi, k] of M.nets[n].pins) { if (pi === r.i) continue; const [x, y] = pinXY(M, M.parts[pi], k); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x0 < INF) { xs.push(x0, x1); ys.push(y0, y1); }
      }
      return xs.length ? [median(xs), median(ys)] : [r.x, r.y];
    };
    for (let pass = 0; pass < passes; pass++) {
      if (now() > deadline) { M.notes.push("Time limit reached during the improvement passes: raise time_limit_ms for a result that does not depend on machine speed."); break; }
      stats.passes++;
      let improved = 0;
      for (const r of [...mov.filter(q => q.kind !== "decap"), ...mov.filter(q => q.kind === "decap")]) {
        if (!r.placed || now() > deadline) continue;
        const before = partCost(M, r), keep = [r.x, r.y, r.a];
        let [tx, ty] = target(r);
        if (r.kind === "conn") [tx, ty] = edgeTarget(M, r, r.edge, tx, ty, r.a);
        // Later passes skip parts already at their optimal region and keep their rotation.
        if (pass > 0 && Math.hypot(tx - r.x, ty - r.y) < 2 * M.grid) continue;
        lift(S, r);
        const angles = r.kind === "conn" ? edgeAngles(M, r, r.edge) : pass === 0 ? anglesOf(r) : [r.a];
        const line = r.kind === "conn" ? (x, y) => { const e = r.edge, [fx, fy] = edgeTarget(M, r, e, x, y, r.a); return e === "left" || e === "right" ? Math.abs(x - fx) < M.grid * 1.01 : Math.abs(y - fy) < M.grid * 1.01; } : null;
        const cost = (x, y, a) => { setPose(r, x, y, a); return partCost(M, r); };
        let best = search(S, r, tx, ty, angles, cost, {maxR: 16, extraRings: 2, evals: 1400, line});
        if(!line && pass===0)best=pinAligned(S,r,angles,best);
        if (best && best.cost < before - 1e-6) { place(S, r, best.x, best.y, best.a); improved++; stats.moved++; }
        else place(S, r, keep[0], keep[1], keep[2]);
      }
      // Swap identical footprints (same definition, side and room).
      const byDef = new Map();
      for (const r of mov) if (r.placed && r.kind !== "conn") { const k = r.def.id + "|" + r.side + "|" + (r.room || ""); if (!byDef.has(k)) byDef.set(k, []); byDef.get(k).push(r); }
      for (const list of byDef.values()) {
        if (list.length < 2 || now() > deadline) continue;
        const n = Math.min(list.length, 40);
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
          const p = list[i], q = list[j], before = partCost(M, p) + partCost(M, q), pp = [p.x, p.y, p.a], qq = [q.x, q.y, q.a];
          setPose(p, qq[0], qq[1], qq[2]); setPose(q, pp[0], pp[1], pp[2]);
          const after = partCost(M, p) + partCost(M, q);
          if (after < before - 1e-6) { lift(S, p); lift(S, q); place(S, p, qq[0], qq[1], qq[2]); place(S, q, pp[0], pp[1], pp[2]); improved++; stats.swaps++; }
          else { setPose(p, pp[0], pp[1], pp[2]); setPose(q, qq[0], qq[1], qq[2]); }
        }
      }
      if (!improved) break;
    }
    stats.improve_ms = Math.round(now() - tStart) - stats.force_ms - stats.legal_ms;
    for (const r of mov) if (r.roomTooSmall) M.notes.push("A room is too small for its footprints; some were placed outside it.");
    return finish(M, S, strategy, seed, spacing, stats);
  }

  // ------------------------------------------------------------------ scoring
  function finish(M, S, strategy, seed, spacing, stats) {
    const moves = [];
    for (const r of M.parts) {
      if (!r.movable && !r.forced) continue;
      const x = round(r.x, 4), y = round(r.y, 4), a = round(r.a, 4);
      if (Math.abs(x - r.x0) < 1e-6 && Math.abs(y - r.y0) < 1e-6 && Math.abs(a - r.a0) < 1e-6) continue;
      if (stats.unplaced.some(u => u.id === r.id)) continue;
      moves.push({id: r.id, ref: r.ref, from: [round(r.x0), round(r.y0)], from_angle: r.a0, to: [x, y], angle: a});
    }
    const score = scoreOf(M);
    return {strategy, label: (STRATEGIES[strategy] || STRATEGIES.balanced).label, seed, spacing, moves, score, stats: {...stats, unplaced: stats.unplaced.slice()}};
  }
  function scoreOf(M) {
    let wl = 0;
    for (const net of M.nets) if (net.pins.length >= 2) wl += mst(net.pins.map(([pi, k]) => pinXY(M, M.parts[pi], k)));
    const live = M.parts.filter(r => !r.failed && (r.movable || r.forced || r.inside || r.piled));
    const recs = live.map(r => rectOf(M, r, r.x, r.y, r.a));
    let overlaps = 0, dfa = 0, outside = 0, area = 0;
    const order = recs.slice().sort((a, b) => a.c[0] - b.c[0]);
    for (let i = 0; i < order.length; i++) {
      const a = order[i];
      for (let j = i + 1; j < order.length; j++) {
        const b = order[j];
        if (b.c[0] > a.c[2] + M.maxGap) break;
        if (!(a.mask & b.mask) || (!a.r.movable && !b.r.movable)) continue;
        if (sep(a.c, b.c) < -EPS) overlaps++;
        else { const g = M.gap(a.type, b.type); if (g > 0 && sep(a.m, b.m) < g - EPS) dfa++; }
      }
    }
    for (const o of recs) { if (o.r.movable && !M.inBoard(o.c, 0)) outside++; area += (o.c[2] - o.c[0]) * (o.c[3] - o.c[1]); }
    // Exact DFA check (oriented outlines, matrix) when the module is loaded.
    const D = globalThis.AtriumDFA;
    if (D?.check && M.rule) {
      const ids = live.filter(r => r.movable).map(r => r.id);
      const items = live.map(r => ({...r.item, x: r.x, y: r.y, angle: r.a}));
      try { dfa = D.check({items}, M.defs, M.rule, {ids, limit: 10000}).violations.length; } catch { /* keep the box estimate */ }
    }
    const B = M.box, boardArea = Math.max(1e-6, (B[2] - B[0]) * (B[3] - B[1]));
    // Peak density over a 6 × 6 grid of bins.
    const nb = 6, bins = new Float64Array(nb * nb), bw = (B[2] - B[0]) / nb, bh = (B[3] - B[1]) / nb;
    for (const o of recs) {
      const c = o.c, w = 1;
      for (let i = Math.max(0, Math.floor((c[0] - B[0]) / bw)); i <= Math.min(nb - 1, Math.floor((c[2] - B[0]) / bw)); i++)
        for (let j = Math.max(0, Math.floor((c[1] - B[1]) / bh)); j <= Math.min(nb - 1, Math.floor((c[3] - B[1]) / bh)); j++) {
          const ox = Math.min(c[2], B[0] + (i + 1) * bw) - Math.max(c[0], B[0] + i * bw), oy = Math.min(c[3], B[1] + (j + 1) * bh) - Math.max(c[1], B[1] + j * bh);
          if (ox > 0 && oy > 0) bins[i * nb + j] += ox * oy * w;
        }
    }
    let peak = 0; for (const v of bins) peak = Math.max(peak, v / (bw * bh));
    const density = area / boardArea;
    const total = wl + 500 * (overlaps + dfa) + 2000 * (outside + M.parts.filter(r => r.failed).length) + 200 * Math.max(0, peak - 0.85);
    return {wirelength_mm: round(wl, 2), dfa_violations: dfa, overlaps, outside, unplaced: M.parts.filter(r => r.failed).length, density: round(density, 3), peak_density: round(peak, 3), total: round(total, 2)};
  }

  // ------------------------------------------------------------------ public
  /**
   * Placement proposals for one board. options: {strategy, seed, alternatives, scope
   * ("unplaced"|"selected"|"all"), components, constraints, timeLimitMs}. constraints:
   * {grid, spacing, margin, rotate, region, keepouts:[[x0,y0,x1,y1]], edges:{ref: side},
   * place:{ref: {x,y,angle}}, groups:[[ref,...]], iterations, passes, rip_up, restart}.
   * Returns {alternatives (best first), best: 0, scope, movable, fixed, notes, ms}.
   */
  function propose(project, doc, defs, o = {}) {
    const t0 = now();
    const M = prepare(project, doc, defs, o);
    const first = o.strategy && STRATEGIES[o.strategy] ? o.strategy : o.strategy ? fail("Unknown placement strategy " + o.strategy + ". Strategies: " + ORDER.join(", ") + ".") : "balanced";
    const count = Math.max(1, Math.min(LIMITS.alternatives, o.alternatives ?? 3));
    const seed = Number.isInteger(o.seed) ? o.seed : 1;
    const plan = [first, ...ORDER.filter(s => s !== first)].slice(0, count);
    const limit = Math.min(LIMITS.maxTimeMs, Math.max(200, o.timeLimitMs ?? LIMITS.timeMs));
    const out = [];
    for (let n = 0; n < plan.length; n++) {
      const share = (limit - (now() - t0)) / (plan.length - n);
      if (n > 0 && share < 150) { M.notes.push("Time limit: " + (plan.length - n) + " alternative(s) skipped."); break; }
      const res = run(M, plan[n], seed, now() + share * 0.8, o);
      res.ms = Math.round(now() - t0 - out.reduce((s, r) => s + r.ms, 0));
      out.push(res);
    }
    out.sort((a, b) => a.score.total - b.score.total || plan.indexOf(a.strategy) - plan.indexOf(b.strategy));
    // Restore the model positions of the best (the doc itself never changed).
    return {alternatives: out.map((r, index) => ({...r, index})), best: 0, scope: M.scope, movable: M.parts.filter(r => r.movable).length,
      fixed: M.parts.filter(r => !r.movable).length, locked: M.locked, routed: M.routed, notes: [...new Set(M.notes)], grid: M.grid, margin: M.margin,
      board: M.box, ms: Math.round(now() - t0)};
  }
  /** Apply moves ({id, to:[x,y], angle}) to a board, in place. Returns the count. */
  function applyMoves(doc, defs, moves, select) {
    const want = select ? new Set(select) : null, byId = new Map(doc.items.map(i => [i.id, i]));
    let n = 0;
    for (const m of moves) {
      if (want && !want.has(m.id)) continue;
      const item = byId.get(m.id);
      if (!item || item.kind !== "part") continue;
      const change = {x: m.to[0], y: m.to[1], angle: m.angle};
      if (A()?.transformPart) A().transformPart(doc, item, defs.get(item.def), change); else Object.assign(item, change);
      n++;
    }
    return n;
  }
  // Stale guard for a dialog that applies later: every moved part must still sit where planned from.
  function stale(doc, moves) {
    const byId = new Map(doc.items.map(i => [i.id, i]));
    return moves.filter(m => { const i = byId.get(m.id); return !i || Math.abs((+i.x || 0) - m.from[0]) > 1e-3 || Math.abs((+i.y || 0) - m.from[1]) > 1e-3 || Math.abs(norm(+i.angle || 0) - norm(m.from_angle)) > 1e-3; }).map(m => m.id);
  }

  // Result rows for MCP / the AI Assistant: design text only under untrusted_design_text.
  function summary(r, chosen, o = {}) {
    const alt = r.alternatives[chosen];
    const limit = o.limit ?? 200, offset = o.offset ?? 0;
    const moves = alt ? alt.moves.slice(offset, offset + limit) : [];
    const refs = {};
    for (const m of moves) refs[m.id] = m.ref;
    for (const u of alt?.stats.unplaced || []) refs[u.id] = r.refOf?.(u.id) ?? refs[u.id];
    return {scope: r.scope, movable: r.movable, fixed: r.fixed, locked: r.locked, routed_kept: r.routed, applied_alternative: alt ? chosen : null,
      alternatives: r.alternatives.map(a => ({index: a.index, strategy: a.strategy, seed: a.seed, spacing_mm: a.spacing, moved: a.moves.length, score: a.score,
        iterations: a.stats.iterations, passes: a.stats.passes, improvements: a.stats.moved, swaps: a.stats.swaps, unplaced: a.stats.unplaced.length, ms: a.ms})),
      moved: alt ? alt.moves.length : 0, moves: moves.map(m => ({id: m.id, from: m.from, from_rotation: m.from_angle, at: m.to, rotation: m.angle})),
      total: alt ? alt.moves.length : 0, next_offset: alt && offset + limit < alt.moves.length ? offset + limit : null,
      unplaced: (alt?.stats.unplaced || []).map(u => ({id: u.id, reason: u.reason})), notes: r.notes, grid_mm: r.grid, margin_mm: r.margin, ms: r.ms,
      untrusted_design_text: {designators: refs}};
  }
  const KEYS = {time_limit_ms: "timeLimitMs"};
  function options(a) {
    const o = {};
    for (const [k, v] of Object.entries(a || {})) o[KEYS[k] || k] = v;
    return o;
  }
  /** MCP op (mcp/headless.js): a = {document_id, strategy, seed, alternatives, alternative, scope, components, constraints, time_limit_ms, mode, offset, limit}. */
  function headless(a, h) {
    const planOnly = a.mode === "plan", p = planOnly ? h.project() : h.mutable(), doc = h.board(p, a.document_id), defs = h.defsOf(p);
    const r = propose(p, doc, defs, options(a));
    const chosen = Math.min(a.alternative ?? 0, r.alternatives.length - 1);
    if (a.alternative != null && a.alternative >= r.alternatives.length) fail("alternative " + a.alternative + " does not exist (" + r.alternatives.length + " computed).");
    r.refOf = id => doc.items.find(i => i.id === id)?.ref;
    if (!planOnly && r.alternatives[chosen]?.moves.length) { applyMoves(doc, defs, r.alternatives[chosen].moves); h.touched(); }
    return {document_id: doc.id, mode: planOnly ? "plan" : a.mode || "proposal", ...summary(r, chosen, a)};
  }

  // ------------------------------------------------------------------ AtriumAPI feature (AI Assistant)
  // feature(kind, project, docId, defs, o): edits the forked project (atrium-api change()),
  // returning a report; dryRun leaves it alone. kind: place | route | planes.
  const LABELS = {place: "Auto place (proposal)", route: "Route plan (proposal)", planes: "Power planes (proposal)"};
  function feature(kind, project, docId, defs, o = {}) {
    const doc = project.documents.find(d => d.id === docId) || fail("No board " + docId + ".");
    const opts = options(o);
    delete opts.doc; delete opts.dryRun;
    if (kind === "place") {
      const r = propose(project, doc, defs, opts), chosen = Math.min(o.alternative ?? 0, r.alternatives.length - 1), alt = r.alternatives[chosen];
      r.refOf = id => doc.items.find(i => i.id === id)?.ref;
      const out = summary(r, chosen, {limit: 100});
      if (!o.dryRun && alt?.moves.length) { preview.show(doc, defs, alt.moves); applyMoves(doc, defs, alt.moves); }
      return {report: out};
    }
    if (kind === "route") {
      const RP = globalThis.AtriumRoutePlanner || fail("Route planning is unavailable in this build.");
      const target = o.dryRun ? JSON.parse(JSON.stringify(doc)) : doc;
      return {report: RP.summary(RP.run(target, defs, {...opts, project}))};
    }
    if (kind === "planes") {
      const PL = globalThis.AtriumPlanePlanner || fail("Plane planning is unavailable in this build.");
      const pl = PL.plan(doc, defs, {...opts, project});
      if (!o.dryRun) PL.apply(doc, defs, pl, {});
      return {report: PL.summary(pl)};
    }
    fail("Unknown planner " + kind + ".");
  }

  // ------------------------------------------------------------------ canvas preview (browser)
  // Ghost outlines of the proposed positions with arrows from the current ones, drawn on the
  // board while a review dialog is open.
  const preview = (() => {
    let off = null, data = null;
    const accent = "#2f81f7", ghost = "rgba(47,129,247,.18)";
    function draw(ctx, {scale}) {
      if (!data) return;
      const px = 1 / scale;
      ctx.save(); ctx.lineWidth = 1.5 * px;
      for (const g of data) {
        ctx.setLineDash([4 * px, 3 * px]); ctx.strokeStyle = "rgba(140,140,140,.9)"; ctx.strokeRect(g.from[0], g.from[1], g.from[2] - g.from[0], g.from[3] - g.from[1]);
        ctx.setLineDash([]); ctx.fillStyle = ghost; ctx.strokeStyle = accent;
        ctx.fillRect(g.to[0], g.to[1], g.to[2] - g.to[0], g.to[3] - g.to[1]); ctx.strokeRect(g.to[0], g.to[1], g.to[2] - g.to[0], g.to[3] - g.to[1]);
        ctx.beginPath(); ctx.moveTo((g.from[0] + g.from[2]) / 2, (g.from[1] + g.from[3]) / 2); ctx.lineTo((g.to[0] + g.to[2]) / 2, (g.to[1] + g.to[3]) / 2); ctx.stroke();
      }
      ctx.restore();
    }
    return {
      show(doc, defs, moves) {
        const H = globalThis.AtriumNavHost;
        if (!H?.addRenderer || typeof document === "undefined") return;
        data = boxesFor(doc, defs, moves);
        if (!off) off = H.addRenderer(d => (data && d?.id === doc.id ? {overlay: draw} : null));
        H.redraw?.();
      },
      clear() { data = null; if (off) { off(); off = null; } globalThis.AtriumNavHost?.redraw?.(); }
    };
  })();
  function boxesFor(doc, defs, moves) {
    const byId = new Map(doc.items.map(i => [i.id, i]));
    return moves.map(m => {
      const item = byId.get(m.id), def = item && defs.get(item.def);
      if (!def?.footprint) return null;
      const {court} = localBoxes(def, "courtyard"), f = rotBox(court, m.from_angle), t = rotBox(court, m.angle);
      return {id: m.id, ref: m.ref, from: [f[0] + m.from[0], f[1] + m.from[1], f[2] + m.from[0], f[3] + m.from[1]], to: [t[0] + m.to[0], t[1] + m.to[1], t[2] + m.to[0], t[3] + m.to[1]]};
    }).filter(Boolean);
  }

  // ------------------------------------------------------------------ dialogs (browser)
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function button(text, fn) { const b = el("button", text); b.classList.add("ui-button"); b.type = "button"; b.onclick = fn; return b; }
  const SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; }
  // Visual diff: the board, fixed parts, and each moved part's old (dashed) and new (filled) courtyard.
  function diffSvg(doc, defs, moves, extra = {}) {
    const boxes = boxesFor(doc, defs, moves), moved = new Set(moves.map(m => m.id));
    const pts = [...(doc.outline || [])];
    for (const b of boxes) pts.push([b.from[0], b.from[1]], [b.from[2], b.from[3]], [b.to[0], b.to[1]], [b.to[2], b.to[3]]);
    for (const r of extra.regions || []) pts.push(...r.points);
    const v = bbox(pts) || [0, 0, 10, 10], pad = Math.max(v[2] - v[0], v[3] - v[1]) * 0.03 + 1;
    const svg = svgEl("svg", {viewBox: [v[0] - pad, v[1] - pad, v[2] - v[0] + 2 * pad, v[3] - v[1] + 2 * pad].map(x => round(x, 3)).join(" "), class: "autoplace-diff", role: "img",
      "aria-label": extra.label || "Proposed placement: dashed outlines are current positions, filled outlines the proposed ones."});
    const sw = round(Math.max(v[2] - v[0], v[3] - v[1]) / 400, 4);
    if (doc.outline?.length) svg.append(svgEl("polygon", {points: doc.outline.map(p => p.join(",")).join(" "), fill: "var(--ap-board, rgba(46,125,50,.12))", stroke: "var(--ap-edge, #6a9a5b)", "stroke-width": sw * 2}));
    for (const r of extra.regions || []) svg.append(svgEl("polygon", {points: r.points.map(p => p.join(",")).join(" "), fill: r.fill, stroke: r.stroke, "stroke-width": sw * 1.5, "fill-opacity": 0.35}));
    for (const i of doc.items) {
      if (i.kind !== "part" || moved.has(i.id)) continue;
      const def = defs.get(i.def); if (!def?.footprint) continue;
      const b = rotBox(localBoxes(def, "courtyard").court, norm(+i.angle || 0));
      svg.append(svgEl("rect", {x: b[0] + i.x, y: b[1] + i.y, width: b[2] - b[0], height: b[3] - b[1], fill: "rgba(128,128,128,.25)", stroke: "rgba(128,128,128,.7)", "stroke-width": sw}));
    }
    for (const b of boxes) {
      svg.append(svgEl("rect", {x: b.from[0], y: b.from[1], width: b.from[2] - b.from[0], height: b.from[3] - b.from[1], fill: "none", stroke: "rgba(150,150,150,.9)", "stroke-width": sw, "stroke-dasharray": sw * 4 + " " + sw * 3}));
      svg.append(svgEl("line", {x1: (b.from[0] + b.from[2]) / 2, y1: (b.from[1] + b.from[3]) / 2, x2: (b.to[0] + b.to[2]) / 2, y2: (b.to[1] + b.to[3]) / 2, stroke: "rgba(47,129,247,.45)", "stroke-width": sw}));
      const r = svgEl("rect", {x: b.to[0], y: b.to[1], width: b.to[2] - b.to[0], height: b.to[3] - b.to[1], fill: "rgba(47,129,247,.35)", stroke: "#2f81f7", "stroke-width": sw * 1.5, "data-id": b.id});
      const t = svgEl("title", {}); t.textContent = b.ref; r.append(t); svg.append(r);
      const label = svgEl("text", {x: (b.to[0] + b.to[2]) / 2, y: (b.to[1] + b.to[3]) / 2, "font-size": round(Math.max(0.6, Math.min(b.to[2] - b.to[0], b.to[3] - b.to[1]) * 0.45), 3),
        "text-anchor": "middle", "dominant-baseline": "central", fill: "var(--ap-text, #e8eef7)", "pointer-events": "none"});
      label.textContent = b.ref; svg.append(label);
    }
    return svg;
  }
  function boardOf(h) {
    const d = h.doc();
    if (d?.kind === "pcb") return d;
    const b = h.project().documents.find(x => x.kind === "pcb");
    if (!b) throw Error("Open a board layout first.");
    h.selectDocument?.(b.id);
    return b;
  }
  function modal(title, cls) {
    const dlg = el("dialog", null, "ui-dialog work-dialog autoplace-dialog " + (cls || "")), head = el("h2", title, "ui-dialog-title"), body = el("div", null, "autoplace-body ui-dialog-body"), msg = el("p", null, "side-note autoplace-msg"), footer = el("div", null, "work-actions ui-dialog-actions");
    dlg.append(head, body, msg, footer); document.body.append(dlg);
    dlg.addEventListener("close", () => { preview.clear(); dlg.remove(); }, {once: true});
    return {dlg, body, msg, footer};
  }
  function field(label, input) { const l = el("label", null, "autoplace-field"); input.classList.add("ui-field"); l.append(el("span", label), input); return l; }

  function openPlacement(h) {
    const doc = boardOf(h), defs = h.defs(), sel = new Set(h.selection?.() || []);
    const selectedParts = doc.items.filter(i => i.kind === "part" && sel.has(i.id)).map(i => i.id);
    const {dlg, body, msg, footer} = modal("Auto Place (Proposal)");
    const scope = el("select"), strategy = el("select"), seed = el("input"), rotate = el("input", null, "ui-checkbox");
    for (const [v, t] of [["auto", "Unplaced footprints (else all unlocked)"], ["selected", "Selected footprints (" + selectedParts.length + ")"], ["all", "All unlocked footprints"]]) scope.add(new Option(t, v));
    if (selectedParts.length) scope.value = "selected"; else scope.options[1].disabled = true;
    for (const k of ORDER) strategy.add(new Option(STRATEGIES[k].label, k));
    seed.type = "number"; seed.min = "1"; seed.value = "1"; seed.style.width = "5em"; rotate.type = "checkbox"; rotate.checked = true;
    const controls = el("div", null, "autoplace-controls"), rot = el("label", null, "autoplace-field");
    rot.append(rotate, el("span", "Allow rotation"));
    controls.append(field("Place", scope), field("Strategy", strategy), field("Seed", seed), rot);
    const alts = el("div", null, "autoplace-alts"), view = el("div", null, "autoplace-view"), list = el("div", null, "work-list autoplace-rows");
    body.append(controls, el("p", "Nothing changes until you apply. Locked footprints, locked rooms and footprints outside the chosen scope stay where they are. Applying is one undo step.", "side-note"), alts, view, list);
    let result = null, chosen = 0, checks = [];
    function show() {
      const alt = result?.alternatives[chosen];
      view.replaceChildren(); list.replaceChildren(); checks = [];
      if (!alt) return;
      view.append(diffSvg(doc, defs, alt.moves));
      preview.show(doc, defs, alt.moves);
      for (const m of alt.moves.slice(0, 2000)) {
        const l = el("label", null, "work-row"), cb = el("input", null, "ui-checkbox"), t = el("span", m.ref);
        cb.type = "checkbox"; cb.checked = true;
        t.append(el("small", "(" + m.from.map(v => round(v, 2)).join(", ") + ") " + m.from_angle + "° → (" + m.to.map(v => round(v, 2)).join(", ") + ") " + m.angle + "°"));
        l.append(cb, t); list.append(l); checks.push([cb, m.id]);
      }
      if (alt.moves.length > 2000) list.append(el("p", "… and " + (alt.moves.length - 2000) + " more", "side-note"));
      const u = alt.stats.unplaced.length;
      msg.textContent = alt.moves.length + " footprints move." + (u ? " " + u + " could not be placed." : "") + (result.notes.length ? " " + result.notes.join(" ") : "");
    }
    function compute() {
      msg.textContent = "Placing…";
      setTimeout(() => {
        try {
          const o = {scope: scope.value === "auto" ? undefined : scope.value, strategy: strategy.value, seed: Math.max(1, Math.round(+seed.value || 1)), constraints: {rotate: rotate.checked}};
          if (scope.value === "selected") o.components = selectedParts;
          result = propose(h.project(), doc, defs, o); chosen = 0;
          alts.replaceChildren();
          const group = "ap-alt-" + Date.now();
          result.alternatives.forEach((a, n) => {
            const l = el("label", null, "autoplace-alt"), r = el("input");
            r.type = "radio"; r.name = group; r.checked = n === 0; r.onchange = () => { chosen = n; show(); };
            const s = a.score;
            l.append(r, el("b", a.label), el("small", "airwires " + s.wirelength_mm + " mm · DFA " + s.dfa_violations + " · overlaps " + s.overlaps + " · density " + Math.round(s.density * 100) + "% (peak " + Math.round(s.peak_density * 100) + "%)" + (a.ms ? " · " + a.ms + " ms" : "") + (a.stats.unplaced.length ? " · " + a.stats.unplaced.length + " not placed" : "")));
            alts.append(l);
          });
          show();
        } catch (e) { msg.textContent = e.message; }
      }, 20);
    }
    const run = button("Compute", compute);
    const apply = button("Apply selected", () => {
      const alt = result?.alternatives[chosen];
      if (!alt) return;
      const ids = checks.filter(([c]) => c.checked).map(([, id]) => id);
      if (!ids.length) { msg.textContent = "Choose at least one footprint."; return; }
      const moves = alt.moves.filter(m => ids.includes(m.id)), gone = stale(doc, moves);
      if (gone.length) { msg.textContent = "The board changed since this proposal was computed. Compute again."; return; }
      const moved = new Set(moves.map(m => m.id));
      h.edit(() => applyMoves(doc, defs, moves), undefined, doc.items.filter(i => moved.has(i.id)));
      dlg.close();
      h.info?.("Auto place · " + moves.length + " footprint" + (moves.length === 1 ? "" : "s") + " moved");
    });
    apply.dataset.variant = "primary";
    footer.append(button("Close", () => dlg.close()), run, apply);
    globalThis.AtriumShell?.adoptDialog?.(dlg, {defaultAction: false});
    dlg.showModal();
    compute();
    return dlg;
  }

  const LAYER_COLORS = ["#d4553a", "#3a7bd4", "#c9a227", "#4caf50", "#9c27b0", "#00897b", "#e91e63", "#795548"];
  async function openPlanes(h) {
    const doc = boardOf(h), defs = h.defs();
    try { if (!globalThis.AtriumCalc && globalThis.AtriumLazy?.modules?.().includes("AtriumCalc")) await AtriumLazy.need("AtriumCalc"); } catch { /* IPC-2221 fallback */ }
    const PL = globalThis.AtriumPlanePlanner;
    if (!PL) { h.info?.("Plane planning is unavailable in this build."); return null; }
    const {dlg, body, msg, footer} = modal("Plan Power Planes");
    let planned;
    try { planned = PL.plan(doc, defs, {project: h.project()}); } catch (e) { h.info?.(e.message); dlg.remove(); return null; }
    const layers = [...new Set(planned.assignments.map(a => a.layer))], color = l => LAYER_COLORS[Math.max(0, layers.indexOf(l)) % LAYER_COLORS.length];
    const view = el("div", null, "autoplace-view"), list = el("div", null, "work-list autoplace-rows"), checks = [];
    body.append(el("p", planned.summary, "side-note"), view, list);
    const redraw = () => {
      const on = planned.assignments.filter((a, n) => checks[n]?.[0].checked !== false && !a.exists);
      view.replaceChildren(diffSvg(doc, defs, [], {regions: on.map(a => ({points: a.points, fill: color(a.layer), stroke: color(a.layer)})), label: "Proposed pours, coloured by layer."}));
    };
    planned.assignments.forEach((a, n) => {
      const l = el("label", null, "work-row"), cb = el("input", null, "ui-checkbox"), t = el("span", a.layer + " · " + a.net + (a.region === "local" ? " (local)" : ""));
      cb.type = "checkbox"; cb.checked = !a.exists; cb.disabled = !!a.exists; cb.onchange = redraw;
      const sw = el("i", null, "autoplace-swatch"); sw.style.setProperty("--swatch", color(a.layer));
      t.prepend(sw);
      t.append(el("small", a.reason + (a.current != null ? " · " + round(a.current, 2) + " A" : "") + (a.width != null ? " → " + round(a.width, 2) + " mm track" : "")));
      l.append(cb, t); list.append(l); checks.push([cb, n]);
    });
    for (const n of planned.notes) body.append(el("p", n, "side-note"));
    redraw();
    const create = button("Create pours", () => {
      const pick = checks.filter(([c]) => c.checked && !c.disabled).map(([, n]) => n);
      if (!pick.length) { msg.textContent = "Choose at least one pour."; return; }
      let made = null;
      try { h.edit(() => { made = PL.apply(doc, defs, planned, {select: pick}); }); }
      catch (e) { msg.textContent = e.message; return; }
      dlg.close();
      h.info?.("Power planes · " + (made?.polygons.length || 0) + " pour" + ((made?.polygons.length || 0) === 1 ? "" : "s") + " created");
    });
    create.dataset.variant = "primary";
    footer.append(button("Close", () => dlg.close()), create);
    globalThis.AtriumShell?.adoptDialog?.(dlg, {defaultAction: false});
    dlg.showModal();
    return dlg;
  }

  function install(h) {
    h.registerAction("autoplace-proposal", () => { try { openPlacement(h); } catch (e) { h.info?.(e.message); } });
    h.registerAction("plan-power-planes", () => { openPlanes(h).catch?.(e => h.info?.(e.message)); });
  }
  if (typeof document !== "undefined" && globalThis.AtriumNavCommon?.ready) {
    AtriumNavCommon.ready(install);
    if (!document.getElementById("autoplace-style")) {
      const s = document.createElement("style"); s.id = "autoplace-style";
      s.textContent = ".autoplace-dialog{width:min(860px,94vw)}.autoplace-controls{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}" +
        ".autoplace-field{display:inline-flex;gap:6px;align-items:center}.autoplace-alts{display:grid;gap:4px;margin:8px 0}.autoplace-alt{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}" +
        ".autoplace-alt small{opacity:.75}.autoplace-view svg{width:100%;max-height:46vh;background:var(--canvas-bg,rgba(0,0,0,.04));border:1px solid var(--border,rgba(128,128,128,.3));border-radius:6px}" +
        ".autoplace-rows{max-height:22vh;overflow:auto}.autoplace-swatch{display:inline-block;width:.8em;height:.8em;border-radius:2px;margin-right:6px;vertical-align:-1px}";
      document.head.append(s);
    }
  }

  return Object.freeze({STRATEGIES, LABELS, propose, applyMoves, stale, headless, feature, summary, diffSvg, preview, openPlacement, openPlanes,
    isPower, isGround, _internal: {prepare, localBoxes, rotBox, mst, scoreOf}});
})();
