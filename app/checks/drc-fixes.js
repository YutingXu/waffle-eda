"use strict";
if (!globalThis.AtriumLandContours && typeof require === "function") require("../pcb/land-contours.js");
// Suggested DRC fixes (KiCad 10 style) and two extra checks.
//
// For common violations the Violation inspector (drc-inspector.js; click a marker) lists the
// fixes inline (panel()); the Messages row "Fix" button, the context menu and the Altium-style
// preference open the same list in a small popover (offer()), only on an explicit click. Each
// fix shows a live preview on the board when its button is hovered or focused, with a verdict
// from a local re-check of the changed objects ("clears the violation" / "would still violate").
// Applying it is one undo step, after which the online DRC re-checks the region.
//
//   clearance      nudge the track away (a 45° bump around the conflict), or reduce its width
//                  when the width rule allows
//   width (min)    set the track to the minimum width
//   netAntennae    an unconnected track end (stub): delete the dangling segment or track
//   silkToMask     clip the overlay line where it crosses the pad's mask opening (board
//                  overlay lines, or the footprint's silk for all its instances)
//   annularRing    enlarge the via, the free pad or the footprint pad to the minimum ring
//   courtyard      add a courtyard (pads and body + 0.25 mm) to the footprint
//
// Extra checks (not in rules.js): netAntennae (track ends that touch nothing of their net)
// and courtyard (placed footprints without a courtyard), both warnings. drc-view.js merges
// them into batch and online results (augment, online).
//
// Pure API (tests): checks(doc, defs), fixesFor(doc, defs, rules, v, {project}) → [{id, label,
// detail, run(doc, lib)}], preview(doc, defs, rules, v, fix, {project}) → {doc, defs, clears,
// remaining, introduced}, apply(doc, project, fix), augment(result, doc, defs), online(doc, defs, list).
globalThis.AtriumDRCFixes = (() => {
  const A = () => globalThis.Atrium, R = () => globalThis.AtriumRules;
  const EXTRA = {netAntennae: {title: "Net Antennae", description: "Track ends that connect to nothing of their net (stubs)."},
    courtyard: {title: "Missing Courtyard", description: "Placed footprints without a courtyard outline."}};
  const FIXABLE = new Set(["clearance", "width", "netAntennae", "silkToMask", "annularRing", "courtyard"]);
  const clone = v => JSON.parse(JSON.stringify(v));
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const r4 = v => Math.round(v * 1e4) / 1e4 + 0;
  const SILK = new Set(["Silk", "Bottom silk", "Top Overlay", "Bottom Overlay"]);
  function closest(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
    return {t, at: [a[0] + dx * t, a[1] + dy * t], d: Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t)};
  }
  // Math.hypot(u, v) <= L. Math.hypot is several times slower than u² + v², so the answer comes from
  // u² + v² when it is clearly on one side of L² (a 1e-9 relative margin, far above the rounding of
  // either), else from Math.hypot itself: the same answer either way.
  const within = (u, v, L) => {
    if (!(L > 1e-100 && L < 1e100)) return Math.hypot(u, v) <= L;
    const q = u * u + v * v, l2 = L * L;
    return q < l2 * (1 - 1e-9) ? true : q > l2 * (1 + 1e-9) ? false : Math.hypot(u, v) <= L;
  };
  // closest(p, a, b).d <= L, without the result object (the same arithmetic up to the comparison).
  function segWithin(p, a, b, L) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
    return within(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t, L);
  }
  const rot = (p, deg) => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]; };
  // Pads of the board as world rectangles: {at, w, h, angle, net, layer, drill, part, number, pad}.
  function padsOf(doc, defs, items = doc.items) {
    const out = [];
    for (const i of items) {
      if (i.kind === "pad") out.push({at: [i.x, i.y], w: i.w || i.diameter || .5, h: i.h || i.diameter || .5, angle: i.angle || 0, net: i.net || "", layer: i.layer || "Top", drill: i.drill || 0, item: i});
      else if (i.kind === "part") {
        const d = defs.get(i.def); if (!d?.footprint) continue;
        for (const p of A().pins(i, d, "pcb")) out.push({at: p.at, w: p.w || p.diameter || .5, h: p.h || p.diameter || .5, angle: (p.angle || 0) + (i.angle || 0), net: i.pinNets?.[p.number] ?? p.net ?? "",
          layer: p.drill > 0 ? "Multi" : p.layer || i.layer || "Top", drill: p.drill || 0, part: i, number: String(p.number)});
      }
    }
    return out;
  }
  function contactsOf(doc, defs, item, copper) {
    const C = AtriumLandContours, PCB = AtriumPCBAppearance;
    if (item.kind === "pad" || item.kind === "via") return C.placedCopper(item, null, copper).map(q => ({...q,net:item.net || ""}));
    if (item.kind !== "part") return [];
    const pads = PCB.readDefinition(defs, item.def, doc)?.footprint?.pads || [];
    return pads.flatMap(p => C.placedCopper(p, item, copper).map(q => ({...q,net:PCB.padNet(p,item) || ""})));
  }
  function inPoly(poly, p) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  const onLayer = (l, layer) => l === "Multi" || layer === "Multi" || l === layer;

  // ------------------------------------------------------------------ extra checks
  // names: the board's layer names (doc.layerNames): an imported Altium board keeps its courtyard
  // on a mechanical layer it calls "Top Courtyard" (Mechanical 4 on the PiDP-11 fixture).
  function hasCourtyard(fp, names = null) {
    return !!fp && (Array.isArray(fp.courtyard) || (fp.shapes || []).some(s => s.style === "courtyard" || /courtyard/i.test(s.layer || "") || /courtyard/i.test(names?.[s.layer] || "")));
  }
  // Track ends that touch no copper of their own net. → [{id, end: 0|1, at}]
  // items (default every object) and nets (default every net): the incremental engine re-checks the
  // nets an edit touched with only their objects.
  function danglingEnds(doc, defs, items = doc.items, nets = null) {
    const byNet = new Map(), add = (net, x) => { if (nets && !nets.has(net)) return; if (!byNet.has(net)) byNet.set(net, []); byNet.get(net).push(x); };
    const copper = AtriumLandContours.copperLookup(doc, defs);
    for (const i of items) {
      if (i.kind === "track" && i.points?.length > 1) add(i.net || "", {kind: "track", item: i, layer: i.layer || "Top"});
      else if ((i.kind === "polygon" || i.kind === "graphic" && i.fill) && i.net && i.points?.length > 2) add(i.net, {kind: "area", poly: i.points, layer: i.layer || "Top"});
      else if (i.kind === "via") for (const contact of contactsOf(doc, defs, i, copper)) add(contact.net, {kind:"contact", ...contact});
    }
    for (const i of items) if (i.kind === "pad" || i.kind === "part") {
      for (const contact of contactsOf(doc, defs, i, copper)) add(contact.net, {kind:"contact", ...contact});
    }
    const out = [];
    for (const [net, all] of byNet) {
      // Only whether some object of the net reaches an end matters, so a grid of the net's objects
      // (by a box that holds everything each test can accept) gives the same answer as the full scan.
      const near = reach(all);
      for (const x of all) {
        if (x.kind !== "track") continue;
        const t = x.item, w = (t.width || 0) / 2;
        // A loop with no per-track array or closure (allocation-heavy loops cost twice as much in
        // WebKit's JavaScriptCore as in V8 on this board).
        for (let end = 0; end < 2; end++) {
          const e = end ? t.points.at(-1) : t.points[0];
          if (!endTouches(x, t, w, e, end, near(e, w))) out.push({id: t.id, end, at: e, net});
        }
      }
    }
    return out;
  }
  // Whether end e (0 first, 1 last) of track x touches some candidate of its net.
  function endTouches(x, t, w, e, end, cands) {
    for (let c = 0; c < cands.length; c++) {
      const y = cands[c];
      if (y === x) {
        // Its own other segments (a closed or folded track) count only away from this end.
        const pts = t.points, skip = end ? pts.length - 2 : 0;
        for (let k = 1; k < pts.length; k++) if (k - 1 !== skip && Math.abs(k - 1 - skip) > 1 && segWithin(e, pts[k - 1], pts[k], w + 1e-6)) return true;
        continue;
      }
      if (y.kind === "contact" && onLayer(y.layer, x.layer) &&
          AtriumResolvedLand.distance(y.land, e, y.at, y.angle, y.mirror) <= 1e-6) return true;
      if (y.kind === "area" && onLayer(y.layer, x.layer) && inPoly(y.poly, e)) return true;
      if (y.kind === "track" && y.layer === x.layer) {
        const q = y.item.points, w2 = (y.item.width || 0) / 2;
        for (let k = 1; k < q.length; k++) if (segWithin(e, q[k - 1], q[k], w + w2 + 1e-6)) return true;
      }
    }
    return false;
  }
  // Candidates for an end e of a track of half-width w: every object whose reach box (grown by the
  // largest track half-width of the net) contains e. Small nets are scanned whole.
  function reach(list) {
    if (list.length < 48) return () => list;
    let grow = 0;
    for (const y of list) if (y.kind === "track") grow = Math.max(grow, (y.item.width || 0) / 2);
    // Boxes in one typed array and the grid as cell runs (counting sort, so each cell's indices stay
    // ascending): no per-object arrays, closures or Map entries.
    const m = list.length, B = new Float64Array(m * 4), fin = k => Number.isFinite(B[4 * k]) && Number.isFinite(B[4 * k + 1]) && Number.isFinite(B[4 * k + 2]) && Number.isFinite(B[4 * k + 3]);
    for (let k = 0; k < m; k++) {
      const y = list[k];
      let b0, b1, b2, b3;
      if (y.kind === "contact") [b0,b1,b2,b3] = AtriumLandContours.contactBox(y);
      else {
        const pts = y.kind === "area" ? y.poly : y.item.points, g = y.kind === "track" ? (y.item.width || 0) / 2 + grow : 0;
        b0 = Infinity; b1 = Infinity; b2 = -Infinity; b3 = -Infinity;
        for (const q of pts) {b0 = Math.min(b0, q[0] - g); b1 = Math.min(b1, q[1] - g); b2 = Math.max(b2, q[0] + g); b3 = Math.max(b3, q[1] + g);}
      }
      B[4 * k] = b0 - 1e-5; B[4 * k + 1] = b1 - 1e-5; B[4 * k + 2] = b2 + 1e-5; B[4 * k + 3] = b3 + 1e-5;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < m; k++) if (fin(k)) {x0 = Math.min(x0, B[4 * k]); y0 = Math.min(y0, B[4 * k + 1]); x1 = Math.max(x1, B[4 * k + 2]); y1 = Math.max(y1, B[4 * k + 3]);}
    if (!(x1 >= x0 && y1 >= y0)) return () => list;
    const n = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(list.length / 2)))), cw = Math.max((x1 - x0) / n, 1e-9), ch = Math.max((y1 - y0) / n, 1e-9);
    const wide = [], span = new Int32Array(m * 4), start = new Int32Array(n * n + 1);
    const cx = v => Math.max(0, Math.min(n - 1, Math.floor((v - x0) / cw))), cy = v => Math.max(0, Math.min(n - 1, Math.floor((v - y0) / ch)));
    for (let k = 0; k < m; k++) {
      span[4 * k] = -1;
      if (!fin(k)) {wide.push(k); continue;}
      const a0 = cx(B[4 * k]), a1 = cx(B[4 * k + 2]), b0 = cy(B[4 * k + 1]), b1 = cy(B[4 * k + 3]);
      if ((a1 - a0 + 1) * (b1 - b0 + 1) > 64) {wide.push(k); continue;}
      span[4 * k] = a0; span[4 * k + 1] = a1; span[4 * k + 2] = b0; span[4 * k + 3] = b1;
      for (let i = a0; i <= a1; i++) for (let j = b0; j <= b1; j++) start[i * n + j + 1]++;
    }
    for (let c = 0; c < n * n; c++) start[c + 1] += start[c];
    const fill = start.slice(0, n * n), idx = new Int32Array(start[n * n]);
    for (let k = 0; k < m; k++) {
      const a0 = span[4 * k]; if (a0 < 0) continue;
      for (let i = a0, a1 = span[4 * k + 1]; i <= a1; i++) for (let j = span[4 * k + 2], b1 = span[4 * k + 3]; j <= b1; j++) idx[fill[i * n + j]++] = k;
    }
    return e => {
      if (!(e[0] >= x0 && e[0] <= x1 && e[1] >= y0 && e[1] <= y1)) return wide.map(k => list[k]);
      // Indices in list order, so the scan visits candidates in the same order as before: a cell's
      // indices and `wide` are each ascending (and disjoint), so a merge keeps that order.
      const key = cx(e[0]) * n + cy(e[1]), z = start[key + 1], out = [];
      for (let i = start[key], j = 0; i < z || j < wide.length;) {
        const k = j >= wide.length || i < z && idx[i] < wide[j] ? idx[i++] : wide[j++], b = 4 * k;
        if (e[0] >= B[b] && e[0] <= B[b + 2] && e[1] >= B[b + 1] && e[1] <= B[b + 3]) out.push(list[k]);
      }
      return out;
    };
  }
  // Net antennae of the given ends (one violation per stub end, or one per track that touches nothing).
  function antennae(ends, itemOf, label) {
    const out = [], both = new Map();
    for (const e of ends) both.set(e.id, (both.get(e.id) || 0) + 1);
    for (const e of ends) {
      const t = itemOf(e.id), whole = both.get(e.id) > 1;
      if (whole && e.end === 1) continue;
      out.push({type: "netAntennae", ruleId: "atrium-netAntennae", ruleName: "Net Antennae", typeTitle: "Net Antennae", source: "Net Antennae", warning: true,
        id: e.id, end: whole ? -1 : e.end, at: e.at, title: "Track (" + label(t.layer || "Top") + ")" + (e.net ? " " + e.net : ""),
        detail: whole ? "Unconnected track: neither end touches its net" : "Unconnected track end (stub)"});
    }
    return out;
  }
  function courtyardOf(doc, defs, i, court) {
    const d = defs.get(i.def), fp = d?.footprint;
    if (!fp?.pads?.length || court(fp) || court(d.mirrorOf ? defs.get(d.mirrorOf)?.footprint : null)) return null;
    return {type: "courtyard", ruleId: "atrium-courtyard", ruleName: "Missing Courtyard", typeTitle: "Missing Courtyard", source: "Missing Courtyard", warning: true,
      id: i.id, at: [i.x, i.y], title: (i.ref || "Component") + " (" + (fp.name || d.name || i.def) + ")", detail: "Footprint has no courtyard"};
  }
  const labeller = () => { const labels = new Map(); return l => { let v = labels.get(l); if (v === undefined) labels.set(l, v = R()?.layerLabel?.(l) || l); return v; }; };
  const courter = doc => { const courts = new Map(); return fp => { if (!fp) return hasCourtyard(fp, doc.layerNames); let v = courts.get(fp); if (v === undefined) courts.set(fp, v = hasCourtyard(fp, doc.layerNames)); return v; }; };
  function checks(doc, defs, types = null) {
    const out = [];
    if (!types || types.includes("netAntennae")) {
      const byId = new Map();
      for (const i of doc.items) if (!byId.has(i.id)) byId.set(i.id, i);
      for (const v of antennae(danglingEnds(doc, defs), id => byId.get(id), labeller())) out.push(v);
    }
    if (!types || types.includes("courtyard")) {
      const court = courter(doc);
      for (const i of doc.items) if (i.kind === "part") { const v = courtyardOf(doc, defs, i, court); if (v) out.push(v); }
    }
    return out;
  }
  // The extras kept per board and re-checked per edit: the nets
  // of the changed objects (old and new nets) for net antennae, the changed components for courtyards.
  // update(doc, defs, hint) → the extras of the whole board; hint {from, to, ids, items, outer} is the undo
  // store's journal since the last update (AtriumUndoStore.changed). Without one, or after a library, layer
  // name or outer change, everything is checked again. Equal to checks() as a set (tests/drc-fixes.cjs).
  function extras() {
    let st = null;
    const SMALL = 64, CELL = 2, ck = (x, y) => x * 73856093 ^ y * 19349663;
    const netsOf = i => i.kind === "part" ? [...new Set(Object.values(i.pinNets || {}).map(n => n ?? ""))] :
      i.kind === "track" || i.kind === "via" || i.kind === "pad" ? [i.net || ""] : (i.kind === "polygon" || i.kind === "graphic" && i.fill) && i.net ? [i.net] : [];
    // What an end can touch of this object lies in its box (tracks: grown by their half width).
    function boxOf(doc, defs, i) {
      let b = null;
      const add = (x0, y0, x1, y1) => { b = b ? [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)] : [x0, y0, x1, y1]; };
      if (i.kind === "track" && i.points?.length) { const w = (i.width || 0) / 2; for (const q of i.points) add(q[0] - w, q[1] - w, q[0] + w, q[1] + w); }
      else if (i.kind === "via" || i.kind === "pad" || i.kind === "part") {
        const C = AtriumLandContours;
        for (const p of contactsOf(doc, defs, i, st.copper)) add(...C.contactBox(p));
      }
      else if (i.points?.length) for (const q of i.points) add(q[0], q[1], q[0], q[1]);
      return b && b.every(Number.isFinite) ? [b[0] - 1e-5, b[1] - 1e-5, b[2] + 1e-5, b[3] + 1e-5] : null;
    }
    function grid(id, b, on) {
      if (!b) return;
      const x0 = Math.floor(b[0] / CELL), x1 = Math.floor(b[2] / CELL), y0 = Math.floor(b[1] / CELL), y1 = Math.floor(b[3] / CELL);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) { if (on) st.big.add(id); else st.big.delete(id); return; }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = ck(x, y); let c = st.grid.get(k); if (on) { if (!c) st.grid.set(k, c = new Set()); c.add(id); } else if (c) { c.delete(id); if (!c.size) st.grid.delete(k); } }
    }
    function near(b, fn) {
      const seen = new Set();
      for (const id of st.big) { seen.add(id); fn(id); }
      for (let x = Math.floor(b[0] / CELL); x <= Math.floor(b[2] / CELL); x++) for (let y = Math.floor(b[1] / CELL); y <= Math.floor(b[3] / CELL); y++)
        for (const id of st.grid.get(ck(x, y)) || []) if (!seen.has(id)) { seen.add(id); fn(id); }
    }
    const overlaps = (a, b) => !!a && !!b && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
    function index(doc, defs, id, item) {
      const old = st.items.get(id);
      if (old) { for (const n of old.nets) { const m = st.members.get(n); if (m) { m.delete(id); if (!m.size) st.members.delete(n); } } grid(id, old.box, false); }
      if (!item) { st.items.delete(id); return old; }
      const e = {nets: netsOf(item), kind: item.kind, item, box: boxOf(doc, defs, item)};
      st.items.set(id, e);
      for (const n of e.nets) { let m = st.members.get(n); if (!m) st.members.set(n, m = new Set()); m.add(id); }
      grid(id, e.box, true);
      if (item.kind === "track") st.maxW = Math.max(st.maxW, (item.width || 0) / 2);
      return old;
    }
    function put(list) { for (const v of list) { let l = st.byTrack.get(v.id); if (!l) st.byTrack.set(v.id, l = []); l.push(v); } }
    function full(doc, defs, hint) {
      st = {at: hint?.to ?? null, outer: hint?.outer, defs, names: JSON.stringify(doc.layerNames ?? null), items: new Map(), members: new Map(), grid: new Map(), big: new Set(), maxW: 0,
        byTrack: new Map(), byPart: new Map(), copper: AtriumLandContours.copperLookup(doc, defs)};
      for (const i of doc.items) if (!st.items.has(i.id)) index(doc, defs, i.id, i);
      const court = courter(doc);
      put(antennae(danglingEnds(doc, defs), id => st.items.get(id)?.item, labeller()));
      for (const [id, e] of st.items) if (e.kind === "part") { const v = courtyardOf(doc, defs, e.item, court); if (v) st.byPart.set(id, v); }
    }
    const isTrack = e => e?.kind === "track" && e.item.points?.length > 1;
    // The tracks of net n whose antenna status an edit with these boxes can change: those with an end in a box.
    function tracksNear(n, boxes, out) {
      const g = st.maxW + 1e-5;
      for (const b0 of boxes) {
        const b = [b0[0] - g, b0[1] - g, b0[2] + g, b0[3] + g];
        near(b, id => {
          const e = st.items.get(id);
          if (!isTrack(e) || (e.item.net || "") !== n) return;
          const p = e.item.points, a = p[0], z = p.at(-1);
          if (a[0] >= b[0] && a[0] <= b[2] && a[1] >= b[1] && a[1] <= b[3] || z[0] >= b[0] && z[0] <= b[2] && z[1] >= b[1] && z[1] <= b[3]) out.add(id);
        });
      }
    }
    function recheck(doc, defs, n, tracks, label) {
      if (!tracks.size) return;
      // Everything of the net an end of these tracks can touch, and the tracks themselves.
      const items = new Set(), g = st.maxW + 1e-5;
      for (const id of tracks) {
        const e = st.items.get(id); items.add(e.item);
        for (const q of [e.item.points[0], e.item.points.at(-1)]) near([q[0] - g, q[1] - g, q[0] + g, q[1] + g], other => {
          const o = st.items.get(other);
          if (o && o.nets.includes(n) && overlaps(o.box, [q[0] - g, q[1] - g, q[0] + g, q[1] + g])) items.add(o.item);
        });
      }
      for (const id of tracks) st.byTrack.delete(id);
      const ends = danglingEnds(doc, defs, [...items], new Set([n])).filter(x => tracks.has(x.id));
      put(antennae(ends, id => st.items.get(id)?.item, label));
    }
    function update(doc, defs, hint) {
      if (!st || !hint?.ids || hint.from == null || hint.from !== st.at || hint.outer !== st.outer || defs !== st.defs || JSON.stringify(doc.layerNames ?? null) !== st.names) full(doc, defs, hint);
      else if (hint.ids.size) {
        st.dirty = true;
        const whole = new Set(), local = new Map(), parts = new Set(), label = labeller();
        for (const id of hint.ids) {
          const live = hint.items.get(id), old = index(doc, defs, id, live || null), now = st.items.get(id);
          if (old?.kind === "track" || now?.kind === "track") st.byTrack.delete(id);
          if (old?.kind === "part" || live?.kind === "part") parts.add(id);
          for (const [e, n] of [...(old?.nets || []).map(n => [old, n]), ...(now?.nets || []).map(n => [now, n])]) {
            if ((st.members.get(n)?.size || 0) <= SMALL) { whole.add(n); continue; }
            let l = local.get(n); if (!l) local.set(n, l = {boxes: [], tracks: new Set()});
            if (e.box) l.boxes.push(e.box);
            if (e === now && isTrack(now)) l.tracks.add(id);
          }
        }
        for (const n of whole) {
          const tracks = new Set();
          for (const id of st.members.get(n) || []) if (isTrack(st.items.get(id))) tracks.add(id);
          recheck(doc, defs, n, tracks, label);
        }
        for (const [n, l] of local) { if (whole.has(n)) continue; tracksNear(n, l.boxes, l.tracks); recheck(doc, defs, n, l.tracks, label); }
        if (parts.size) {
          const court = courter(doc);
          for (const id of parts) { st.byPart.delete(id); const e = st.items.get(id); if (e?.kind === "part") { const v = courtyardOf(doc, defs, e.item, court); if (v) st.byPart.set(id, v); } }
        }
      }
      st.at = hint?.to ?? st.at;
      if (!st.out || st.dirty !== false) {
        const out = [];
        for (const l of st.byTrack.values()) for (const v of l) out.push(v);
        for (const v of st.byPart.values()) out.push(v);
        st.out = out; st.dirty = false;
      }
      return st.out;
    }
    return {update, advance(from, to) {if (st && st.at === from) st.at = to;}, reset() { st = null; }};
  }
  function augment(result, doc, defs, options = {}) {
    if (!result || doc?.kind !== "pcb") return result;
    const {limit = Infinity} = options;
    const selected = Object.keys(EXTRA).filter(type =>
      !result.rules.some(r => r.id === "atrium-" + type) &&
      (globalThis.AtriumRules?.checkSelected(doc, type, options) ?? (!options.types || options.types.includes(type))));
    if (!selected.length) return result;
    const extra = checks(doc, defs, selected);
    for (const [type, info] of Object.entries(EXTRA)) {
      if (!selected.includes(type)) continue;
      const id = "atrium-" + type;
      const warnings = extra.filter(v => v.type === type);
      result.rules.push({id, type, name: info.title, description: info.title + " (" + info.description + ")", count: warnings.length});
      for (const v of warnings.slice(0, limit)) result.violations.push(v);
      result.total += warnings.length;
    }
    return result;
  }
  const mine = v => Object.hasOwn(EXTRA, v.type);
  // engine (optional, from extras()) with hint: only what the edit touched is checked again.
  function online(doc, defs, list, engine, hint) {
    try { return list.filter(v => !mine(v)).concat(engine ? engine.update(doc, defs, hint) : checks(doc, defs)); } catch { engine?.reset(); return list; }
  }

  // ------------------------------------------------------------------ fixes
  const item = (doc, id) => doc.items.find(i => i.id === id);
  const libFor = (doc, defs, part) => { const d = defs.get(part.def); return d?.mirrorOf ? {def: defs.get(d.mirrorOf) || d, mirror: !!defs.get(d.mirrorOf)} : {def: d, mirror: false}; };
  // A 45° bump of track t at point c by delta along normal n, over half length F.
  function bump(t, c, n, delta, F) {
    const pts = t.points;
    let k = 1, best = Infinity;
    for (let j = 1; j < pts.length; j++) { const q = closest(c, pts[j - 1], pts[j]).d; if (q < best) { best = q; k = j; } }
    const a = pts[k - 1], b = pts[k], L = dist(a, b); if (L < 1e-9) return null;
    const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], s = closest(c, a, b).t * L;
    const s1 = s - F - delta, s2 = s + F + delta, at = x => [a[0] + u[0] * x, a[1] + u[1] * x];
    const off = (p, d) => [p[0] + n[0] * d, p[1] + n[1] * d];
    let mid;
    if (s1 > 1e-6 && s2 < L - 1e-6) mid = [at(s1), off(at(s - F), delta), off(at(s + F), delta), at(s2)];
    else {
      // Too short for a bump: move the whole segment, when neither end is a track end.
      if (k - 1 === 0 || k === pts.length - 1) return null;
      return {points: [...pts.slice(0, k - 1), off(a, delta), off(b, delta), ...pts.slice(k + 1)]};
    }
    return {points: [...pts.slice(0, k), ...mid, ...pts.slice(k)].map(p => [r4(p[0]), r4(p[1])])};
  }
  function otherPoint(doc, defs, v, t) {
    const o = v.otherId && v.otherId !== t.id ? item(doc, v.otherId) : v.id !== t.id ? item(doc, v.id) : null;
    if (!o) return {at: v.otherAt || v.at, size: .3};
    if (o.kind === "track" && o.points?.length > 1) {
      let best = null;
      for (let k = 1; k < o.points.length; k++) { const c = closest(v.at, o.points[k - 1], o.points[k]); if (!best || c.d < best.d) best = c; }
      return {at: best.at, size: (o.width || 0) / 2};
    }
    if (o.kind === "via") return {at: [o.x, o.y], size: (o.diameter || .6) / 2};
    if (o.kind === "part") {
      const pads = padsOf({items: [o]}, defs); let best = null;
      for (const p of pads) { const d = dist(p.at, v.at); if (!best || d < best.d) best = {d, p}; }
      return best ? {at: best.p.at, size: Math.max(best.p.w, best.p.h) / 2} : {at: [o.x, o.y], size: .5};
    }
    return {at: Number.isFinite(o.x) ? [o.x, o.y] : v.at, size: Math.max(o.w || 0, o.h || 0, o.diameter || 0) / 2 || .3};
  }
  function clearanceFixes(doc, defs, v) {
    const out = [];
    for (const id of [v.id, v.otherId]) {
      const t = id && item(doc, id);
      if (!t || t.kind !== "track" || t.locked || out.some(f => f.track === id)) continue;
      const o = otherPoint(doc, defs, v, t), deficit = Math.max(.005, (v.required ?? .2) - (v.actual ?? 0)) + .005;
      // Away from the other object, perpendicular to the segment at the conflict.
      let k = 1, best = Infinity;
      for (let j = 1; j < t.points.length; j++) { const q = closest(v.at, t.points[j - 1], t.points[j]).d; if (q < best) { best = q; k = j; } }
      const a = t.points[k - 1], b = t.points[k], L = dist(a, b) || 1, u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      let n = [-u[1], u[0]];
      const on = closest(o.at, a, b).at, away = [on[0] - o.at[0], on[1] - o.at[1]];
      if (away[0] * n[0] + away[1] * n[1] < 0) n = [-n[0], -n[1]];
      const F = o.size + (t.width || 0) / 2 + (v.required ?? .2);
      for (const mult of [1, 1.6, 2.5]) {
        const delta = r4(deficit * mult), plan = bump(t, on, n, delta, F);
        if (!plan) break;
        out.push({id: "nudge-" + id + "-" + mult, track: id, label: "Nudge track " + delta.toFixed(3) + " mm", detail: "Moves the track away from the other object with a short 45° jog.",
          run: d => { const x = item(d, id); if (x) x.points = plan.points; }});
      }
      const w = t.width || 0, w2 = r4(w - 2 * deficit);
      if (w2 > 0) out.push({id: "width-" + id, track: id, label: "Reduce width to " + w2.toFixed(3) + " mm", detail: "Narrows this track; the width rule must allow it.",
        run: d => { const x = item(d, id); if (x) x.width = w2; }});
    }
    return out;
  }
  function stubFixes(doc, v) {
    const t = item(doc, v.id); if (!t || t.kind !== "track") return [];
    if (v.end < 0 || t.points.length < 3) return [{id: "delete-" + t.id, label: "Delete the unconnected track", detail: "Removes the track; nothing of its net is lost.", run: d => { d.items = d.items.filter(i => i.id !== t.id); }}];
    return [{id: "trim-" + t.id, label: "Delete the stub segment", detail: "Removes the last segment, which leads nowhere.",
      run: d => { const x = item(d, t.id); if (x) x.points = v.end ? x.points.slice(0, -1) : x.points.slice(1); }},
    {id: "delete-" + t.id, label: "Delete the whole track", detail: "Removes the track.", run: d => { d.items = d.items.filter(i => i.id !== t.id); }}];
  }
  // Clips a polyline against a (rotated) rectangle; returns the pieces outside it.
  function clipOut(points, c, w, h, angle, minLen = 1e-6) {
    const toL = p => rot([p[0] - c[0], p[1] - c[1]], -angle), toW = q => { const p = rot(q, angle); return [r4(p[0] + c[0]), r4(p[1] + c[1])]; };
    const pieces = []; let cur = [];
    const ins = q => Math.abs(q[0]) < w / 2 - 1e-9 && Math.abs(q[1]) < h / 2 - 1e-9;
    for (let k = 1; k < points.length; k++) {
      const p = toL(points[k - 1]), q = toL(points[k]);
      // Parametric entry and exit of the box (Liang–Barsky).
      let t0 = 0, t1 = 1; const dx = q[0] - p[0], dy = q[1] - p[1];
      let hit = true;
      for (const [pp, qq] of [[-dx, p[0] + w / 2], [dx, w / 2 - p[0]], [-dy, p[1] + h / 2], [dy, h / 2 - p[1]]]) {
        if (Math.abs(pp) < 1e-12) { if (qq < 0) { hit = false; break; } continue; }
        const r = qq / pp; if (pp < 0) { if (r > t1) { hit = false; break; } if (r > t0) t0 = r; } else { if (r < t0) { hit = false; break; } if (r < t1) t1 = r; }
      }
      const at = t => [p[0] + dx * t, p[1] + dy * t];
      if (!cur.length) cur.push(toW(p));
      if (!hit || t1 - t0 < 1e-9 || (!ins(at((t0 + t1) / 2)) && t1 - t0 < 1e-9)) { cur.push(toW(q)); continue; }
      if (t0 > 1e-9) cur.push(toW(at(t0)));
      if (cur.length > 1) pieces.push(cur);
      cur = t1 < 1 - 1e-9 ? [toW(at(t1)), toW(q)] : [];
    }
    if (cur.length > 1) pieces.push(cur);
    return pieces.filter(pc => pc.length > 1 && pc.slice(1).reduce((s, p, i) => s + dist(p, pc[i]), 0) > minLen);
  }
  function silkFixes(doc, defs, rules, v) {
    const owner = item(doc, v.id), padOwner = item(doc, v.otherId); if (!owner || !padOwner) return [];
    const pads = padsOf({items: [padOwner]}, defs);
    let pad = null; for (const p of pads) if (!pad || dist(p.at, v.otherAt || v.at) < dist(pad.at, v.otherAt || v.at)) pad = p;
    if (!pad) return [];
    let exp = .1016; try { exp = R().expansion?.(doc, "solder", pad.item || {kind: "pad", number: pad.number, layer: pad.layer}, {parent: pad.part || null, rules}) ?? exp; } catch { /* default */ }
    if (!Number.isFinite(exp)) exp = .1016;
    const out = [];
    for (const mult of [1, 1.5]) {
      const grow = (Math.max(exp, 0) + (v.required ?? .1)) * mult + .01;
      if (owner.kind === "graphic" && owner.points?.length > 1 && SILK.has(owner.layer)) {
        const pieces = clipOut(owner.closed ? [...owner.points, owner.points[0]] : owner.points, pad.at, pad.w + 2 * (grow + (owner.width || 0) / 2), pad.h + 2 * (grow + (owner.width || 0) / 2), pad.angle, Math.max(.05, owner.width || 0));
        out.push({id: "clip-" + owner.id + "-" + mult, label: "Clip the overlay line" + (mult > 1 ? " (wider gap)" : ""), detail: "Cuts the line where it crosses the mask opening of the pad.",
          run: d => { const i = d.items.findIndex(x => x.id === owner.id); if (i < 0) return; const base = d.items[i], next = pieces.map((pts, k) => ({...base, id: k ? A().id() : base.id, points: pts, closed: false}));
            d.items.splice(i, 1, ...next); }});
      } else if (owner.kind === "part" && owner === padOwner) {
        const {def, mirror} = libFor(doc, defs, owner); if (!def?.footprint) continue;
        // The pad in the footprint's own frame.
        const local = A().pins({x: 0, y: 0, angle: 0, def: owner.def}, defs.get(owner.def), "pcb").find(p => String(p.number) === pad.number);
        if (!local) continue;
        const c = mirror ? [-local.at[0], local.at[1]] : local.at, ang = (mirror ? -1 : 1) * (local.angle || 0);
        out.push({id: "clipfp-" + def.id + "-" + mult, label: "Clip the footprint silk at pad " + pad.number + (mult > 1 ? " (wider gap)" : ""), detail: "Edits footprint " + (def.footprint.name || def.name) + ": every instance changes.",
          lib: def.id, run: (d, lib) => { const fp = lib.get(def.id).footprint; const next = [];
            for (const s of fp.shapes || []) {
              const silk = SILK.has(s.layer) || s.style === "silk";
              if (!silk || !s.points || s.points.length < 2 || s.fill) { next.push(s); continue; }
              const pts = s.closed ? [...s.points, s.points[0]] : s.points;
              for (const pc of clipOut(pts, c, pad.w + 2 * (grow + (s.width || 0) / 2), pad.h + 2 * (grow + (s.width || 0) / 2), ang, Math.max(.05, s.width || 0))) next.push({...s, points: pc, closed: false});
            }
            fp.shapes = next; }});
      }
    }
    return out;
  }
  function ringFixes(doc, defs, v) {
    const o = item(doc, v.id), need = (v.required ?? .1) + .001; if (!o) return [];
    if (o.kind === "via") { const d = r4((o.drill || 0) + 2 * need); return [{id: "via-" + o.id, label: "Enlarge the via to " + d.toFixed(3) + " mm", detail: "Keeps the drill, grows the land.", run: x => { const i = item(x, o.id); if (i) i.diameter = d; }}]; }
    if (o.kind === "pad") { const d = r4((o.drill || 0) + 2 * need); return [{id: "pad-" + o.id, label: "Enlarge the pad to " + d.toFixed(3) + " mm", detail: "Grows the pad's smaller side.", run: x => { const i = item(x, o.id); if (i) { i.w = Math.max(i.w || 0, d); i.h = Math.max(i.h || 0, d); } }}]; }
    if (o.kind === "part") {
      const pads = padsOf({items: [o]}, defs); let pad = null; for (const p of pads) if (p.drill > 0 && (!pad || dist(p.at, v.at) < dist(pad.at, v.at))) pad = p;
      if (!pad) return [];
      const {def} = libFor(doc, defs, o), d = r4(pad.drill + 2 * need);
      return [{id: "fppad-" + def.id + "-" + pad.number, lib: def.id, label: "Enlarge pad " + pad.number + " to " + d.toFixed(3) + " mm", detail: "Edits footprint " + (def.footprint?.name || def.name) + ": every instance changes.",
        run: (x, lib) => { for (const p of lib.get(def.id).footprint.pads || []) if (String(p.number) === pad.number) { p.w = Math.max(p.w || 0, d); p.h = Math.max(p.h || 0, d); if (p.diameter) p.diameter = Math.max(p.diameter, d); } }}];
    }
    return [];
  }
  function courtyardFixes(doc, defs, v) {
    const o = item(doc, v.id); if (!o || o.kind !== "part") return [];
    const {def} = libFor(doc, defs, o); const fp = def?.footprint; if (!fp) return [];
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    const add = p => { b = [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])]; };
    for (const p of fp.pads || []) for (const s of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const q = rot([s[0] * (p.w || p.diameter || .5) / 2, s[1] * (p.h || p.diameter || .5) / 2], p.angle || 0); add([q[0] + p.x, q[1] + p.y]); }
    for (const s of fp.shapes || []) { if (s.points) s.points.forEach(add); else if (s.kind === "circle") { add([s.x - s.r, s.y - s.r]); add([s.x + s.r, s.y + s.r]); } }
    if (!Number.isFinite(b[0])) return [];
    const up = x => Math.ceil(x * 20 - 1e-9) / 20, dn = x => Math.floor(x * 20 + 1e-9) / 20, e = .25;
    const c = [r4(dn(b[0] - e)), r4(dn(b[1] - e)), r4(up(b[2] + e)), r4(up(b[3] + e))];
    return [{id: "court-" + def.id, lib: def.id, label: "Add a courtyard (" + (c[2] - c[0]).toFixed(2) + " × " + (c[3] - c[1]).toFixed(2) + " mm)", detail: "Adds the courtyard to footprint " + (fp.name || def.name) + " (pads and body + 0.25 mm).",
      run: (x, lib) => { const f = lib.get(def.id).footprint; f.courtyard = c; f.shapes = [...(f.shapes || []), {kind: "path", points: [[c[0], c[1]], [c[2], c[1]], [c[2], c[3]], [c[0], c[3]]], closed: true, layer: "Mechanical 15", style: "courtyard", width: .05}]; }}];
  }
  function fixesFor(doc, defs, rules, v) {
    if (!v || !FIXABLE.has(v.type)) return [];
    try {
      if (v.type === "clearance") return v.stale ? [] : clearanceFixes(doc, defs, v);
      if (v.type === "width") { const t = item(doc, v.id); return t?.kind === "track" && v.limit === "min" && v.required > 0 ? [{id: "minw-" + t.id, label: "Set width to " + v.required.toFixed(3) + " mm (minimum)", detail: "Widens the track to the rule's minimum.", run: d => { const x = item(d, t.id); if (x) x.width = v.required; }}] : []; }
      if (v.type === "netAntennae") return stubFixes(doc, v);
      if (v.type === "silkToMask") return silkFixes(doc, defs, rules, v);
      if (v.type === "annularRing") return ringFixes(doc, defs, v);
      if (v.type === "courtyard") return courtyardFixes(doc, defs, v);
    } catch (e) { globalThis.console?.warn?.("DRC fix", e); }
    return [];
  }
  const hasFix = v => !!v && FIXABLE.has(v.type) && !v.stale && (v.type !== "width" || v.limit === "min");
  const LABEL = {clearance: "nudge the track or reduce its width", width: "set the minimum width", netAntennae: "delete the stub", silkToMask: "clip the silk",
    annularRing: "enlarge the land", courtyard: "add a courtyard"};
  function hint(v) { return hasFix(v) ? "Fix: " + LABEL[v.type] + " — click the marker" : ""; }
  const fixLabel = v => hasFix(v) ? LABEL[v.type] : "";

  // Runs a fix on copies and re-checks the region it changed.
  function preview(doc, defs, rules, v, fix) {
    const d = {...doc, items: doc.items.map(i => clone(i))}, lib = new Map();
    if (fix.lib) {
      const base = defs.get(fix.lib); lib.set(fix.lib, clone(base));
    }
    fix.run(d, lib);
    let defs2 = defs;
    if (lib.size) {
      defs2 = new Map(defs);
      for (const [id, def] of lib) {
        defs2.set(id, def);
        // Bottom-side mirrors of the edited footprint, regenerated like pcb-edit does.
        for (const [k, m] of defs) if (m?.mirrorOf === id && globalThis.AtriumPCBEdit?.mirrorFootprint) { try { defs2.set(k, {...m, footprint: AtriumPCBEdit.mirrorFootprint(def.footprint, 0)}); } catch { /* keep */ } }
      }
    }
    const check = (dd, df) => {
      let list = [];
      const types = Object.hasOwn(EXTRA, v.type) ? [] : [v.type, ...(v.type === "clearance" || v.type === "width" || v.type === "netAntennae" ? ["clearance", "width"] : [])];
      try { if (types.length && R()?.drc) list = R().drc(dd, df, rules, {types: [...new Set(types)], limit: 2000}).violations; } catch { list = []; }
      try { list = list.concat(checks(dd, df)); } catch { /* none */ }
      return list;
    };
    const key = x => x.type + "|" + [x.id, x.otherId].filter(Boolean).sort().join("|");
    const near = x => (x.at && v.at && dist(x.at, v.at) < 3) || x.id === v.id || x.id === v.otherId;
    const before = check(doc, defs).filter(near), after = check(d, defs2).filter(near);
    const had = new Set(before.map(key));
    const remaining = after.filter(x => key(x) === key(v) || x.type === v.type && (x.id === v.id || x.id === v.otherId) && (!v.otherId || x.otherId === v.otherId || x.id === v.otherId));
    const introduced = after.filter(x => !had.has(key(x)));
    return {doc: d, defs: defs2, lib, clears: !remaining.length, remaining, introduced, ok: !remaining.length && !introduced.length};
  }
  // Applies a fix to the live document (and library); call inside one editor edit.
  function apply(doc, project, fix) {
    const lib = new Map();
    if (fix.lib) { const def = project.library.find(x => x.id === fix.lib); if (def) lib.set(fix.lib, def); }
    fix.run(doc, lib);
  }

  // ------------------------------------------------------------------ UI
  let host = null, pop = null, popTrigger = null, show = null;   // show: {doc, base, fix, verdict}
  const el = (t, x, c) => AtriumNavCommon.el(t, x, c);
  function rulesOf(d) { return R().stored(d, host.project()) || R().defaults(); }
  function drawItem(ctx, i, defs, px, color) {
    ctx.strokeStyle = color; ctx.fillStyle = color;
    if (i.kind === "track" || i.kind === "graphic" && i.points && !i.fill) {
      ctx.lineWidth = Math.max(i.width || 0, 2 * px); ctx.beginPath(); ctx.moveTo(i.points[0][0], i.points[0][1]);
      for (const p of i.points.slice(1)) ctx.lineTo(p[0], p[1]); if (i.closed) ctx.closePath(); ctx.stroke();
    } else if (i.kind === "via") { ctx.beginPath(); ctx.arc(i.x, i.y, (i.diameter || .6) / 2, 0, Math.PI * 2); ctx.fill(); }
    else if (i.kind === "pad") { ctx.save(); ctx.translate(i.x, i.y); ctx.rotate((i.angle || 0) * Math.PI / 180); ctx.fillRect(-(i.w || .5) / 2, -(i.h || .5) / 2, i.w || .5, i.h || .5); ctx.restore(); }
    else if (i.kind === "part") {
      const def = defs.get(i.def), fp = def?.footprint; if (!fp) return;
      ctx.lineWidth = 1.5 * px;
      for (const s of fp.shapes || []) if (s.points?.length > 1) { const pts = s.points.map(p => A().world(p, i)); ctx.lineWidth = Math.max(s.width || 0, 1.5 * px); ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]); if (s.closed) ctx.closePath(); ctx.stroke(); }
      for (const p of padsOf({items: [i]}, defs)) { ctx.save(); ctx.translate(p.at[0], p.at[1]); ctx.rotate(p.angle * Math.PI / 180); ctx.lineWidth = 1.5 * px; ctx.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore(); }
    }
  }
  function overlay(ctx, {scale}) {
    const s = show; if (!s) return;
    const px = 1 / scale, base = new Map(s.base.items.map(i => [i.id, JSON.stringify(i)])), now = new Set(s.doc.items.map(i => i.id));
    ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
    // Removed: dashed red. Changed or added: bright cyan. Library edits: every instance of the footprint.
    ctx.globalAlpha = .9; ctx.setLineDash([5 * px, 4 * px]);
    for (const i of s.base.items) if (!now.has(i.id)) drawItem(ctx, i, s.defs0, px, "#ff6b6b");
    ctx.setLineDash([]); ctx.globalAlpha = .8;
    const color = s.verdict.ok ? "#39d0ff" : s.verdict.clears ? "#ffd33d" : "#ff9b54";
    for (const i of s.doc.items) {
      if (i.kind === "part") { if (s.lib.size && s.lib.has(s.defs0.get(i.def)?.mirrorOf || i.def)) drawItem(ctx, i, s.defs, px, color); continue; }
      if (base.get(i.id) !== JSON.stringify(i)) drawItem(ctx, i, s.defs, px, color);
    }
    ctx.restore();
  }
  function clearPreview() { if (show) { show = null; host?.redraw(); } }
  function closePop({restoreFocus = false, instant = false} = {}) {
    if (pop) {
      const returnTo = popTrigger?.getClientRects().length ? popTrigger : host?.canvas?.();
      const card = pop;
      pop = popTrigger = null;
      const surface = globalThis.AtriumSurfaceMotion;
      if (surface) surface.popover(card, false, {instant, done:() => card.remove()});
      else card.remove();
      if (restoreFocus) returnTo?.focus({preventScroll: true});
    }
    clearPreview();
    document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", esc, true);
  }
  function outside(e) { if (pop && !pop.contains(e.target)) closePop(); }
  function esc(e) {
    if (e.key === "Escape" && pop && !e.defaultPrevented && !e.isComposing && !e.target.closest?.("dialog[open], [role=dialog]:not(.drc-fix-pop)")) {
      e.preventDefault(); e.stopPropagation(); closePop({restoreFocus: pop.contains(e.target)});
    }
  }
  // The fix list for a violation: one button per fix, preview on hover or focus, click applies.
  // Returns {list, status, first} or null when no fix applies. Shared by the popover and the
  // inspector (onApply runs before the fix is applied, e.g. to close the popover).
  function build(v, {onApply = null} = {}) {
    const d = host.doc(); if (d?.kind !== "pcb" || !v) return null;
    const defs = host.defs(), rules = rulesOf(d), fixes = fixesFor(d, defs, rules, v);
    if (!fixes.length) return null;
    const verdicts = new Map();
    const verdict = f => { if (!verdicts.has(f)) verdicts.set(f, preview(d, defs, rules, v, f)); return verdicts.get(f); };
    // Best first: clears and introduces nothing, then clears, then the rest.
    const rank = f => { const x = verdict(f); return x.ok ? 0 : x.clears ? 1 : 2; };
    const sorted = fixes.map(f => [rank(f), f]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    // Of the nudge variants keep the smallest that works.
    const list = sorted.filter((f, i) => !/^nudge-/.test(f.id) || !sorted.slice(0, i).some(g => /^nudge-/.test(g.id) && g.track === f.track && rank(g) <= rank(f)));
    const status = el("p", null, "drc-fix-status"); status.setAttribute("role", "status");
    const preview_ = f => {
      const x = verdict(f);
      show = {doc: x.doc, base: d, fix: f, verdict: x, defs: x.defs, defs0: defs, lib: x.lib};
      status.textContent = (x.ok ? "Preview: clears the violation." : x.clears ? "Preview: clears it, but adds " + x.introduced.length + " other violation" + (x.introduced.length === 1 ? "" : "s") + "." : "Preview: would still violate (" + (x.remaining[0]?.actual != null ? x.remaining[0].actual.toFixed(3) + " mm" : "unchanged") + ").") + " " + (f.detail || "");
      status.dataset.state = x.ok ? "ok" : x.clears ? "warn" : "bad";
      host.redraw();
    };
    const box = el("div", null, "drc-fix-list");
    for (const f of list) {
      const x = verdict(f), b = el("button", null, "drc-fix-button ui-button"); b.type = "button";
      const tag = el("span", "Fix", "ui-badge"); tag.dataset.tone = "accent";
      b.append(tag, el("span", f.label), el("span", x.ok ? "✓" : x.clears ? "!" : "✕", "drc-fix-verdict"));
      b.dataset.state = x.ok ? "ok" : x.clears ? "warn" : "bad";
      b.title = (x.ok ? "Clears the violation. " : x.clears ? "Clears it but adds other violations. " : "Does not clear it. ") + (f.detail || "");
      b.onpointerenter = b.onfocus = () => preview_(f);
      b.onclick = () => { onApply?.(); run(v, f); };
      box.append(b);
    }
    return {list: box, status, first: () => preview_(list[0])};
  }
  // Inline fix list for the Violation inspector: an element, or null when no fix applies.
  function panel(h, v) {
    host ||= h;
    closePop();
    const b = build(v);
    if (!b) return null;
    const wrap = el("div", null, "drc-fix-panel");
    wrap.append(b.list, b.status, el("small", "Hover or focus a fix to preview it · click to apply (one undo step)", "drc-fix-note"));
    b.first();
    return wrap;
  }
  // The popover (Messages "Fix" button, context menu, Altium-style click): opened only on an explicit click.
  function offer(h, v, at) {
    host ||= h;
    const switching = !!pop;
    closePop({instant:true});
    const b = build(v, {onApply: () => closePop({restoreFocus: true})});
    if (!b) return false;
    popTrigger = at?.trigger || (document.activeElement !== document.body ? document.activeElement : null);
    pop = el("div", null, "drc-fix-pop ui-popover"); pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "Suggested fixes");
    const md = globalThis.AtriumDRCMarkers?.describe?.(v, host.units?.() || "mm");
    pop.append(el("strong", md?.title || v.ruleName || v.type), el("span", md?.measured || v.detail || "", "drc-fix-measure"));
    const foot = el("div", null, "drc-fix-foot"), cancel = el("button", "Cancel", "drc-fix-cancel ui-button"); cancel.type = "button"; cancel.onclick = () => closePop({restoreFocus: true});
    foot.append(el("small", "Hover to preview · click to apply (one undo step)"), cancel);
    pop.append(b.list, b.status, foot);
    document.body.append(pop);
    const r = pop.getBoundingClientRect(), x = at?.x ?? innerWidth / 2, y = at?.y ?? innerHeight / 2;
    pop.style.left = Math.max(6, Math.min(x + 12, innerWidth - r.width - 6)) + "px"; pop.style.top = Math.max(6 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-caption-height")) || 0), Math.min(y + 12, innerHeight - r.height - 6)) + "px"; // below the title bar
    b.first();
    b.list.querySelector("button")?.focus({preventScroll: true});
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", esc, true);
    globalThis.AtriumSurfaceMotion?.popover(pop, true, {instant:switching});
    return true;
  }
  function run(v, f) {
    const d = host.doc(), project = host.project();
    closePop();
    try { host.edit(() => apply(d, project, f)); } catch (e) { host.info(e.message); return; }
    // Re-check locally (online DRC) at once, then report.
    let r = null; try { r = globalThis.AtriumDRCView?.check?.(); } catch { r = null; }
    const still = (globalThis.AtriumDRCView?.violations?.(d.id) || []).some(x => x.type === v.type && (x.id === v.id || x.id === v.otherId) && (!v.at || !x.at || dist(x.at, v.at) < 1.5));
    host.info((still ? "Applied " : "Fixed: ") + f.label.charAt(0).toLowerCase() + f.label.slice(1) + (still ? " · the violation is still reported" : "") + (r?.ms != null ? " · local DRC " + r.ms.toFixed(1) + " ms" : "") + " · Undo reverts it");
    globalThis.AtriumNavCommon?.toast?.(still ? "Fix applied; still violating" : "Fixed · " + (v.ruleName || v.type), {kind: still ? "warn" : "ok"});
  }
  // Messages rows: a "Fix" button on DRC rows that have one.
  let observed = null;
  function decorate() {
    const M = globalThis.AtriumMessages, tbody = document.querySelector(".msg-panel .msg-grid tbody");
    if (!M || !tbody) return;
    if (observed !== tbody) { observed = tbody; new MutationObserver(decorate).observe(tbody, {childList: true}); }
    const byNo = new Map(M.messages().map(m => [m.no, m]));
    for (const tr of tbody.querySelectorAll("tr[data-no]")) {
      if (tr.querySelector(".drc-fix-row")) continue;
      const m = byNo.get(Number(tr.dataset.no));
      if (!m?.drc || !hasFix(m.drc)) continue;
      const b = el("button", "Fix", "drc-fix-row ui-button"); b.type = "button"; b.dataset.size = "sm"; b.title = "Suggested fix: " + LABEL[m.drc.type] + " (preview first)";
      b.setAttribute("aria-label", "Fix: " + LABEL[m.drc.type]);
      b.onclick = e => { e.stopPropagation(); const r = b.getBoundingClientRect(); globalThis.AtriumDRCMarkers?.zoom?.(host, m.drc); if (!offer(host, m.drc, {x: r.left, y: r.bottom, trigger: b})) host.info("No automatic fix applies to this violation."); };
      b.ondblclick = e => e.stopPropagation();
      tr.querySelector(".msg-col-text")?.prepend(b);
    }
  }
  function attach(h) {
    host = h;
    host.addRenderer(d => show && d.id === show.base.id ? {overlay} : null);
    host.on?.("document", closePop);
    host.on?.("change", () => { if (pop) closePop(); });
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    new MutationObserver(() => { if (document.querySelector(".msg-panel") && !observed) decorate(); }).observe(document.body, {childList: true});
    decorate();
  }
  globalThis.AtriumNavCommon?.ready?.(attach);

  // Context menu (context-menu.js): "Fix…" on a marker opens the same popover.
  let lastPointer = null;
  if (typeof window !== "undefined") window.addEventListener("contextmenu", e => { lastPointer = {x: e.clientX, y: e.clientY}; }, true);
  const fix = (h, v) => offer(h, v, lastPointer) || h?.info?.("No automatic fix applies to this violation.");
  return Object.freeze({checks, extras, danglingEnds, hasCourtyard, augment, online, fixesFor, preview, apply, hasFix, canFix: hasFix, fix, hint, fixLabel, clipOut, offer, panel, clearPreview, decorate, EXTRA, attach});
})();
