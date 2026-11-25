"use strict";

if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");
// Altium chords that need a tool of their own (lazy: lazy.js loads it on first use).
//
//   S T                  Select Touching Line: click two points; everything the line crosses is selected.
//   S C                  Select Connection: the tracks and vias between two pads (it stops at pads).
//   S P                  Select Physical Connection: all copper joined to the seed, through pads too.
//   Edit › Align › Align…  (E G A, A A on sheets) horizontal and vertical alignment, distribution,
//                        fixed spacing and grid snap in one undo step. E G … mirrors the A … chords.
//   Increase / Decrease Horizontal / Vertical Spacing (Edit › Align, boards): ± one grid step.
//   U A M                Auto Route › Room…: the autorouter dialog scoped to a room's components.
//   + / −                Step through every shown layer, copper and non-copper. Copper sets the current
//                        (routing) layer; a non-copper layer becomes the current *drawing* layer for the
//                        Line, Arc and dimension tools while routing stays on the last copper layer.
//   Shift+Space / Tab    During M S / M D (or any drag): cycle the move corner mode (any angle, 90°, 45°)
//                        and open Properties on the object being moved.
//
// Headless API (pure, DOM-free):
//   AtriumAltiumTools.touching(doc, defs, a, b, {tol, filter}) -> [ids crossed by segment a–b]
//   AtriumAltiumTools.connection(doc, defs, seedIds, {physical}) -> [copper ids]
//   AtriumAltiumTools.alignPlan(doc, defs, ids, {h, v, hGap, vGap}) -> {moves:[{id,dx,dy}], locked}
//   AtriumAltiumTools.roomParts(doc, defs, room) -> [part ids]
//   AtriumAltiumTools.constrain(mode, origin, p) -> p constrained to 90° or 45° from origin
//   AtriumAltiumTools.layerCycle(copper, others, current, step) -> next layer name
globalThis.AtriumAltiumTools = (() => {
  const A = () => globalThis.Atrium;
  const EPS = 1e-6;

  // ------------------------------------------------------------------ geometry
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
  function ptSeg(p, a, b) {
    const d = sub(b, a), l = d[0] * d[0] + d[1] * d[1];
    const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l)) : 0;
    return Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1]);
  }
  function segsCross(a, b, c, d) {
    const r = sub(b, a), s = sub(d, c), den = cross(r, s);
    if (Math.abs(den) < 1e-15) return false;
    const t = cross(sub(c, a), s) / den, u = cross(sub(c, a), r) / den;
    return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS;
  }
  const segSeg = (a, b, c, d) => segsCross(a, b, c, d) ? 0 : Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
  const inPoly = globalThis.AtriumGeometry.inRing;
  const boxPts = b => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
  const CLOSED = new Set(["polygon", "region", "fill", "pour", "zone", "cutout", "keepout-region"]);
  // The outline a line has to touch to "touch" an item: a stroked path, a filled outline or a circle.
  function shapeOf(item, defs, kind) {
    if (item.kind === "via" || item.kind === "pad" || item.kind === "junction")
      return {circle:[item.x, item.y], r:Math.max(item.diameter || 0, item.w || 0, item.h || 0, item.kind === "junction" ? .4 : .5) / 2};
    const pts = Array.isArray(item.points) && item.points.length ? item.points : null;
    if (pts && item.kind !== "part") {
      const closed = CLOSED.has(item.kind) || CLOSED.has(item.shape) || item.closed === true || item.filled === true;
      return {path:pts, r:(item.width || 0) / 2, closed:closed && pts.length > 2};
    }
    const b = A().bounds(A().itemPoints(item, defs.get(item.def), kind));
    return b ? {path:boxPts(b), r:0, closed:true} : null;
  }
  // Ids of the items the segment a–b crosses or touches (within tol plus half the stroke width).
  function touching(doc, defs, a, b, o = {}) {
    const tol = o.tol ?? 0, out = [], lo = [Math.min(a[0], b[0]) - tol, Math.min(a[1], b[1]) - tol], hi = [Math.max(a[0], b[0]) + tol, Math.max(a[1], b[1]) + tol];
    for (const item of doc.items) {
      if (o.filter && !o.filter(item)) continue;
      const s = shapeOf(item, defs, doc.kind); if (!s) continue;
      if (s.circle) {if (ptSeg(s.circle, a, b) <= s.r + tol) out.push(item.id); continue;}
      const p = s.path, reach = s.r + tol;
      // Cheap reject on the bounding boxes.
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of p) {x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]);}
      if (x1 + reach < lo[0] || x0 - reach > hi[0] || y1 + reach < lo[1] || y0 - reach > hi[1]) continue;
      let hit = s.closed && (inPoly(a, p) || inPoly(b, p));
      const n = s.closed ? p.length : p.length - 1;
      for (let k = 0; !hit && k < n; k++) hit = segSeg(a, b, p[k], p[(k + 1) % p.length]) <= reach;
      if (!hit && p.length === 1) hit = ptSeg(p[0], a, b) <= reach;
      if (hit) out.push(item.id);
    }
    return out;
  }

  // ------------------------------------------------------------------ connection / physical connection
  const isCopper = l => !globalThis.AtriumPCBAppearance?.index || AtriumPCBAppearance.index(l) >= 0;
  const copperItem = i => !i.keepout && (i.kind === "via" || i.kind === "track" && Array.isArray(i.points) && i.points.length > 1 && isCopper(i.layer));
  const ends = i => i.kind === "via" ? [[i.x, i.y]] : [i.points[0], i.points[i.points.length - 1]];
  const pathOf = i => i.kind === "via" ? [[i.x, i.y]] : i.points;
  const reachOf = i => i.kind === "via" ? (i.diameter || .6) / 2 : (i.width || .2) / 2;
  function distPath(p, pts) {
    if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
    let d = Infinity; for (let k = 1; k < pts.length; k++) d = Math.min(d, ptSeg(p, pts[k - 1], pts[k])); return d;
  }
  // Where two pieces of copper join: the ends of one that lie on the other (tracks on the same layer).
  function joints(a, b) {
    if (a.kind === "track" && b.kind === "track" && a.layer !== b.layer) return [];
    const tol = Math.max(reachOf(a), reachOf(b)) + 1e-4, out = [];
    for (const q of ends(a)) if (distPath(q, pathOf(b)) <= tol) out.push(q);
    for (const q of ends(b)) if (distPath(q, pathOf(a)) <= tol) out.push(q);
    return out;
  }
  // Pads as terminals: free pads and the pins of board parts, with the layer they sit on.
  function padsOf(doc, defs) {
    const out = [];
    for (const i of doc.items) {
      if (i.kind === "pad") out.push({id:i.id, at:[i.x, i.y], r:Math.max(i.w || i.diameter || .5, i.h || i.diameter || .5) / 2, layer:i.layer || "Multi", net:i.net || ""});
      else if (i.kind === "part") for (const p of A().pins(i, defs.get(i.def), "pcb"))
        out.push({id:null, part:i.id, at:p.at, r:Math.max(p.w || p.diameter || .5, p.h || p.diameter || .5) / 2, layer:p.layer || (p.drill ? "Multi" : i.side === "bottom" ? "Bottom" : "Top"), net:i.pinNets?.[p.number] ?? p.net ?? ""});
    }
    return out;
  }
  const onPadLayer = (c, pad) => c.kind === "via" || !pad.layer || pad.layer === "Multi" || pad.layer === c.layer;
  const atPad = (c, pad) => onPadLayer(c, pad) && ends(c).some(q => Math.hypot(q[0] - pad.at[0], q[1] - pad.at[1]) <= pad.r + 1e-4);
  // S C: copper between pads (a pad ends the walk). S P: copper joined through pads as well.
  // Only copper on the seeds' nets (and net-less copper) is considered, so a 25k-object board stays fast.
  function connection(doc, defs, seedIds, o = {}) {
    const byId = new Map(doc.items.map(i => [i.id, i])), seeds = seedIds.map(id => byId.get(id)).filter(Boolean);
    const nets = new Set(seeds.map(i => i.net || "")), pads = padsOf(doc, defs).filter(p => nets.has(p.net) || !p.net);
    const copper = doc.items.filter(i => copperItem(i) && nets.has(i.net || ""));
    const seen = new Set(), out = [], todo = [];
    const visit = c => {if (!seen.has(c.id)) {seen.add(c.id); out.push(c.id); todo.push(c);}};
    // A pad seed (or a part's pin under a selected part) starts from the copper on it.
    for (const s of seeds) {
      if (copperItem(s)) visit(s);
      else if (s.kind === "pad" || s.kind === "part") {
        const mine = pads.filter(p => p.id === s.id || p.part === s.id);
        for (const c of copper) if (mine.some(p => atPad(c, p))) visit(c);
      }
    }
    const padSeen = new Set();
    while (todo.length) {
      const a = todo.pop();
      for (const b of copper) {
        if (seen.has(b.id)) continue;
        const js = joints(a, b); if (!js.length) continue;
        // Connection: copper that only meets inside a pad belongs to another pad-to-pad connection.
        if (!o.physical && js.every(q => pads.some(p => onPadLayer(a, p) && onPadLayer(b, p) && Math.hypot(q[0] - p.at[0], q[1] - p.at[1]) <= p.r + 1e-4))) continue;
        visit(b);
      }
      if (o.physical) for (const p of pads) {
        const key = p.id || p.part + "@" + p.at.join(",");
        if (padSeen.has(key) || !atPad(a, p)) continue;
        padSeen.add(key); if (p.id && !seen.has(p.id)) {seen.add(p.id); out.push(p.id);}
        for (const b of copper) if (!seen.has(b.id) && atPad(b, p)) visit(b);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ align plan (Align… dialog)
  // h: none | left | hcenter | right | distribute | gap ; v: none | top | vcenter | bottom | distribute | gap.
  function alignPlan(doc, defs, ids, o = {}) {
    const G = globalThis.AtriumGuides; if (!G) throw Error("Alignment is not loaded.");
    const one = (mode, axis, gap) => mode === "none" || !mode ? {moves:[]} : mode === "distribute" ? G.distribute(doc, defs, ids, axis)
      : mode === "gap" ? G.distribute(doc, defs, ids, axis, {gap:Number(gap) || 0}) : G.align(doc, defs, ids, mode);
    const h = one(o.h, "x", o.hGap), v = one(o.v, "y", o.vGap), m = new Map();
    for (const x of h.moves) m.set(x.id, {id:x.id, dx:x.dx, dy:0});
    for (const y of v.moves) {const e = m.get(y.id) || {id:y.id, dx:0, dy:0}; e.dy = y.dy; m.set(y.id, e);}
    const moves = [...m.values()].filter(x => Math.abs(x.dx) > 1e-12 || Math.abs(x.dy) > 1e-12), moved = new Set(moves.map(x => x.id));
    return {moves, locked:doc.items.filter(i => i.locked === true && moved.has(i.id)).map(i => i.id)};
  }
  // Average gap between neighbours along an axis (Increase / Decrease Spacing steps it by one grid).
  function currentGap(doc, defs, ids, axis) {
    const G = globalThis.AtriumGuides, a = axis === "y" ? 1 : 0, boxes = ids.map(id => doc.items.find(i => i.id === id)).filter(Boolean).map(i => G.itemBox(i, defs, doc.kind)).filter(Boolean);
    if (boxes.length < 2) return null;
    boxes.sort((p, q) => p[a] + p[a + 2] - q[a] - q[a + 2]);
    let s = 0; for (let k = 1; k < boxes.length; k++) s += boxes[k][a] - boxes[k - 1][a + 2];
    return s / (boxes.length - 1);
  }

  // ------------------------------------------------------------------ rooms, corner modes, layer cycle
  function roomParts(doc, defs, room) {
    const ids = new Set();
    for (const p of globalThis.AtriumRooms?.members?.(doc, room) || []) ids.add(p.id);
    for (const i of doc.items) if (i.kind === "part" && inPoly([i.x, i.y], room.points)) ids.add(i.id);
    return [...ids];
  }
  function roomAt(doc, defs, ids, point) {
    const rooms = Array.isArray(doc.rooms) ? doc.rooms.filter(r => Array.isArray(r.points) && r.points.length > 2) : [];
    if (point) return rooms.find(r => inPoly(point, r.points)) || null;
    for (const i of doc.items) if (ids.includes(i.id)) {const r = rooms.find(r => inPoly([i.x ?? i.points?.[0]?.[0], i.y ?? i.points?.[0]?.[1]], r.points)); if (r) return r;}
    return null;
  }
  const CORNERS = [null, "90", "45"], CORNER_NAMES = {null:"Any angle", 90:"90° (horizontal or vertical)", 45:"45°"};
  function constrain(mode, o, p) {
    const dx = p[0] - o[0], dy = p[1] - o[1];
    if (mode === "90") return Math.abs(dx) >= Math.abs(dy) ? [p[0], o[1]] : [o[0], p[1]];
    if (mode === "45") {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = dx * Math.cos(ang) + dy * Math.sin(ang);
      return [o[0] + len * Math.cos(ang), o[1] + len * Math.sin(ang)];
    }
    return p;
  }
  // + / −: shown copper layers first (stack order), then shown non-copper layers.
  function layerCycle(copper, others, current, step) {
    const all = [...copper, ...others];
    if (!all.length) return null;
    const k = all.indexOf(current);
    return all[k < 0 ? 0 : (k + step + all.length) % all.length];
  }

  // ------------------------------------------------------------------ editor wiring
  let host = null, drawLayer = null, linePick = null;
  const info = t => host.info(t);
  const plural = (n, w) => globalThis.AtriumI18n?.plural?.(n, w) ?? n + " " + w + (n === 1 ? "" : "s");
  const raw = p => host.pointer?.() || p;
  const tolerance = () => 4 / (host.view?.()?.scale?.() || 1);

  async function selectTouching() {
    const d = host.doc(); if (d.kind === "panel") return;
    const a = await host.pickPoint("Select Touching Line: click the start of the line. Escape cancels."); if (!a) return;
    linePick = a; const c = host.canvas(), move = () => host.redraw();
    c.addEventListener("pointermove", move);
    let b;
    try {b = await host.pickPoint("Click the end of the line: everything it touches is selected.");}
    finally {c.removeEventListener("pointermove", move); linePick = null; host.redraw();}
    if (!b) return;
    const ok = new Set(host.selectableItems()), ids = touching(host.doc(), host.defs(), a, b, {tol:tolerance(), filter:i => ok.has(i)});
    host.select(ids); info(plural(ids.length, "object") + " touching the line selected.");
  }
  async function selectConnection(physical) {
    const d = host.doc(), what = physical ? "Select Physical Connection" : "Select Connection";
    if (d.kind !== "pcb") {info(what + " works on a board layout. On a sheet, S N selects a net."); return;}
    const usable = i => copperItem(i) || i.kind === "pad" || i.kind === "part";
    let seeds = host.selection().filter(id => usable(d.items.find(i => i.id === id) || {}));
    if (!seeds.length) {
      const p = await host.pickPoint(what + ": click a track, via or pad. Escape cancels."); if (!p) return;
      const hit = host.hitAt(raw(p));
      if (!hit || !usable(hit)) {info("Click a track, via or pad."); return;}
      seeds = [hit.id];
    }
    const ok = new Set(host.selectableItems().map(i => i.id)), ids = connection(host.doc(), host.defs(), seeds, {physical}).filter(id => ok.has(id));
    host.select(ids);
    info(ids.length ? plural(ids.length, "copper object") + " selected in the " + (physical ? "physical connection" : "connection") + "." : "No routed copper there.");
  }

  // Align… : one dialog for both axes, applied as one undo step.
  let alignPrefs = {h:"none", v:"none", hGap:null, vGap:null, grid:false};
  async function alignDialog() {
    const L = globalThis.AtriumLazy; if (!globalThis.AtriumGuides && L) await L.need("AtriumGuides");
    const d = host.doc(), ids = host.selection();
    if (ids.length < 2) {info("Select two or more objects to align."); return;}
    const C = globalThis.AtriumNavCommon, el = C.el, U = A().units, unit = host.units();
    const group = (title, name, rows, gapKey) => {
      const f = el("fieldset", null, "align-group"), g = el("input"); f.append(el("legend", title));
      for (const [v, label] of rows) {
        const l = el("label", null, "align-option"), r = el("input"); r.type = "radio"; r.name = name; r.value = v; r.checked = alignPrefs[name] === v;
        l.append(r, el("span", label)); f.append(l);
        if (v === "gap") {g.type = "text"; g.inputMode = "decimal"; g.className = "align-gap";g.dataset.unit=unit; g.setAttribute("aria-label", title + " spacing (" + unit + ")");
          g.value = U.format(alignPrefs[gapKey] ?? d.grid, unit); g.oninput = () => {r.checked = true;}; l.append(g);}
      }
      f.gap = g; return f;
    };
    const hf = group("Horizontal", "h", [["none", "No Change"], ["left", "Left"], ["hcenter", "Centre"], ["right", "Right"], ["distribute", "Distribute Equally"], ["gap", "Space Equally By"]], "hGap");
    const vf = group("Vertical", "v", [["none", "No Change"], ["top", "Top"], ["vcenter", "Centre"], ["bottom", "Bottom"], ["distribute", "Distribute Equally"], ["gap", "Space Equally By"]], "vGap");
    const grid = el("label", null, "align-option align-grid"), gb = el("input"); gb.type = "checkbox"; gb.checked = alignPrefs.grid; grid.append(gb, el("span", "Move to Grid"));
    const cols = el("div", null, "align-cols"); cols.append(hf, vf);
    const note = el("p", plural(ids.length, "object") + " selected. Distribute keeps the first and last in place.", "align-note");
    const pick = f => f.querySelector("input[type=radio]:checked")?.value || "none";
    const dlg = globalThis.AtriumShell.dialog({title:"Align Objects", body:[cols, grid, note], className:"align-dialog", actions:[{label:"Cancel"}, {label:"OK", primary:true, run:() => {
      const o = {h:pick(hf), v:pick(vf), hGap:U.parse(hf.gap.value, unit), vGap:U.parse(vf.gap.value, unit), grid:gb.checked};
      if ((o.h === "gap" && !Number.isFinite(o.hGap)) || (o.v === "gap" && !Number.isFinite(o.vGap))) {note.textContent = "Enter a spacing such as 1mm or 50mil."; return false;}
      alignPrefs = {...o, hGap:Number.isFinite(o.hGap) ? o.hGap : alignPrefs.hGap, vGap:Number.isFinite(o.vGap) ? o.vGap : alignPrefs.vGap};
      applyAlign(o); return true;
    }}]});
    return dlg;
  }
  function applyPlan(plan, label, grid) {
    const d = host.doc(), defs = host.defs(), G = globalThis.AtriumGuides, locked = new Set(plan.locked || []);
    const moves = plan.moves.filter(m => !locked.has(m.id));
    if (!moves.length && !grid) {info(locked.size ? "Locked objects were kept in place." : "Nothing to move."); return 0;}
    const v = host.view(), wires = d.kind === "schematic" && v?.connectedWires ? part => v.connectedWires(d, defs, part) : undefined;
    let n = moves.length;
    host.edit(() => {
      G.applyPlan(d, defs, {moves}, wires);
      if (grid) {const g = G.alignToGrid(d, defs, host.selection().filter(id => !locked.has(id))); G.applyPlan(d, defs, g, wires); n = new Set([...moves.map(m => m.id), ...g.moves.map(m => m.id)]).size;}
    });
    info((label ? label + ": " : "") + plural(n, "object") + " moved" + (locked.size ? " (" + locked.size + " locked kept)" : "") + ".");
    return n;
  }
  function applyAlign(o) {
    const plan = alignPlan(host.doc(), host.defs(), host.selection(), o);
    applyPlan(plan, "Align", o.grid);
  }
  async function spacing(axis, sign) {
    const L = globalThis.AtriumLazy; if (!globalThis.AtriumGuides && L) await L.need("AtriumGuides");
    const d = host.doc(), ids = host.selection();
    if (ids.length < 2) {info("Select two or more objects."); return;}
    const gap = currentGap(d, host.defs(), ids, axis); if (gap == null) return;
    const next = Math.max(0, gap + sign * d.grid);
    applyPlan(alignPlan(d, host.defs(), ids, axis === "x" ? {h:"gap", hGap:next} : {v:"gap", vGap:next}), (sign > 0 ? "Increase " : "Decrease ") + (axis === "x" ? "horizontal" : "vertical") + " spacing");
  }

  // U A M: the autorouter dialog with the room's components chosen.
  async function autorouteRoom() {
    const d = host.doc();
    if (d.kind !== "pcb") {info("Auto Route Room works on a board layout."); return;}
    if (!(d.rooms || []).length) {info("This board has no rooms. Add one with Design › Rooms, or use Auto Route › Component…."); return;}
    let room = roomAt(d, host.defs(), host.selection(), null);
    if (!room) {const p = await host.pickPoint("Auto Route Room: click inside a room. Escape cancels."); if (!p) return; room = roomAt(host.doc(), host.defs(), [], raw(p));}
    if (!room) {info("Click inside a room."); return;}
    const L = globalThis.AtriumLazy; if (!globalThis.AtriumRooms && L) await L.need("AtriumRooms").catch(() => {});
    const parts = roomParts(host.doc(), host.defs(), room);
    if (!parts.length) {info("Room " + (room.name || "") + " has no components."); return;}
    host.select(parts);
    host.act("autoroute-component");
    info("Auto Route Room " + (room.name || "") + ": " + plural(parts.length, "component") + " chosen. Press Route Component to start.");
  }

  // + / −: copper and non-copper layers. Routing never leaves copper.
  function shownOthers() {
    if (typeof document === "undefined") return [];
    return [...document.querySelectorAll("#layer-tabs .layer-tab:not(.copper)[aria-pressed=true]")].map(b => b.dataset.layer).filter(l => l && l !== "Multi");
  }
  async function stepLayer(action) {
    const d = host.doc(); if (d.kind !== "pcb") return;
    const hidden = host.hiddenLayers(), name = l => globalThis.AtriumPCBAppearance?.name?.(l) || l;
    const copper = host.copperLayers().filter(l => !hidden.has(l)), others = host.liveRoute() ? [] : shownOthers().filter(l => !hidden.has(l));
    const cur = drawLayer && others.includes(drawLayer) ? drawLayer : host.activeLayer();
    const next = layerCycle(copper, others, cur, action === "layer-prev" ? -1 : 1);
    if (!next) {info("Show a layer first."); return;}
    if (next === cur) {info("Only one layer is shown: " + name(next)); return;}
    if (copper.includes(next)) {
      drawLayer = null; const P = globalThis.AtriumPCBDraw; if (P?.prefs?.line && P.prefs.line.layer && !copper.includes(P.prefs.line.layer)) P.prefs.line.layer = null;
      host.setLayer(next); markDrawing(); if (!host.liveRoute()) info("Current layer: " + name(next)); return;
    }
    const L = globalThis.AtriumLazy; if (!globalThis.AtriumPCBDraw && L) await L.need("AtriumPCBDraw").catch(() => {});
    drawLayer = next; const P = globalThis.AtriumPCBDraw; if (P?.prefs?.line) P.prefs.line.layer = next;
    markDrawing(); host.redraw();
    info("Drawing layer: " + name(next) + ". Lines and arcs go on it; routing stays on " + name(host.activeLayer()) + ".");
  }
  function markDrawing() {
    if (typeof document === "undefined") return;
    const on = host.doc().kind === "pcb" && drawLayer && !host.hiddenLayers().has(drawLayer) ? drawLayer : null;
    for (const b of document.querySelectorAll("#layer-tabs .layer-tab")) {
      const mine = !!on && b.dataset.layer === on;
      if (mine) {b.setAttribute("aria-current", "true"); b.title = name0(on) + " (current drawing layer)";} else if (b.getAttribute("aria-current") === "true" && !b.classList.contains("copper")) b.removeAttribute("aria-current");
    }
  }
  const name0 = l => globalThis.AtriumPCBAppearance?.name?.(l) || l;

  // Shift+Space and Tab while moving (M S, M D or a held drag).
  function cornerMode() {
    const g = host.drag?.();
    if (!g || g.kind !== "move") {info("Shift+Space changes the corner mode while moving objects (M S or M D)."); return;}
    if (g.segment) {info("Wire segments keep their own corners."); return;}
    g.corner = CORNERS[(CORNERS.indexOf(g.corner ?? null) + 1) % CORNERS.length];
    info("Move corner mode: " + CORNER_NAMES[g.corner] + ". Shift+Space cycles.");
  }
  function moveProperties() {
    const g = host.drag?.();
    if (!g || g.kind !== "move") return;
    document.body.classList.remove("hide-right");
    host.select(host.selection(), g.item?.id);
    const field = [...document.querySelectorAll("#inspector input:not([type=hidden]):not([type=checkbox]):not([disabled]):not([readonly]),#inspector select:not([disabled])")]
      .find(n => !n.closest(".pcb-edit-filter-section"));
    field?.focus(); field?.select?.();
    info("Properties of " + (g.item?.ref || g.item?.kind || "the object") + ". Move back over the canvas to keep moving; click places, Escape cancels.");
  }

  // Live line for Select Touching Line.
  function overlay() {
    return (ctx, o) => {
      const p = host.pointer?.(); if (!linePick || !p) return;
      const css = typeof getComputedStyle === "function" ? getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() : "";
      ctx.save(); ctx.strokeStyle = css || "#3794ff"; ctx.lineWidth = 1.5 / (o.scale || 1); ctx.setLineDash([6 / (o.scale || 1), 4 / (o.scale || 1)]);
      ctx.beginPath(); ctx.moveTo(linePick[0], linePick[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); ctx.restore();
    };
  }

  function attach(h) {
    host = h;
    host.addRenderer((d, inf) => {if (inf?.active) markDrawing(); return linePick && inf?.active ? {overlay:overlay()} : null;});
    host.registerAction("select-touching", selectTouching);
    host.registerAction("select-connection", () => selectConnection(false));
    host.registerAction("select-physical", () => selectConnection(true));
    host.registerAction("align-dialog", alignDialog);
    host.registerAction("spacing-h-more", () => spacing("x", 1));
    host.registerAction("spacing-h-less", () => spacing("x", -1));
    host.registerAction("spacing-v-more", () => spacing("y", 1));
    host.registerAction("spacing-v-less", () => spacing("y", -1));
    host.registerAction("autoroute-room", autorouteRoom);
    // Replaces the copper-only stepping in altium-keys.js (this module loads after it).
    host.registerAction("layer-next", () => stepLayer("layer-next"));
    host.registerAction("layer-prev", () => stepLayer("layer-prev"));
    host.registerAction("move-corner-mode", cornerMode);
    host.registerAction("move-properties", moveProperties);
    host.on?.("document", () => {drawLayer = null; markDrawing();});
  }
  globalThis.AtriumNavCommon?.ready(attach);

  return Object.freeze({touching, connection, alignPlan, currentGap, roomParts, roomAt, constrain, layerCycle, CORNERS, attach});
})();
