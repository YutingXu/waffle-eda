"use strict";
// Teardrops (Tools → Teardrops…). Adds a same-net copper region where a track meets a
// pad or via (and optionally where a track ends on another track, a T junction). Each
// teardrop is an ordinary filled board graphic on the track's copper layer:
//   {kind:"graphic", points, closed:true, fill:true, width:0, layer, net, teardrop:true,
//    groupId:"teardrop:<pad, via or track id>"}
// so the canvas, Gerber (a Conductor region), DRC and connectivity read it as filled copper.
// Clearance against other nets is checked with the router's world (AtriumRouter.world /
// check) over the whole filled area, outline and interior, and violating teardrops are
// skipped. Removal and regeneration find teardrops by their tag and leave locked ones.
// A teardrop whose track or anchor later changes is stale (AtriumRules.staleTeardrops):
// DRC reports it and AtriumPCBEdit.settle removes it after the edit. plan() is DOM-free;
// open() is the dialog.
globalThis.AtriumTeardrops = (() => {
  const A = () => globalThis.Atrium;
  const DEFAULTS = {style: "curved", length: 100, width: 90, pads: true, vias: true, tjunctions: false, scope: "all", clearance: true};
  const isTeardrop = i => i?.teardrop === true || typeof i?.groupId === "string" && i.groupId.startsWith("teardrop:");
  const copper = l => l === "Top" || l === "Bottom" || /^Inner \d+$/.test(l || "");
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const layerNo = l => l === "Top" ? 0 : l === "Bottom" ? 127 : /^Inner \d+$/.test(l || "") ? +l.slice(6) : null;
  // Copper layers a via joins: through vias every layer, blind and buried vias their span.
  const viaSpan = v => { const a = layerNo(v.fromLayer), b = layerNo(v.toLayer); return a != null && b != null ? [Math.min(a, b), Math.max(a, b)] : [0, 127]; };
  function inside(p, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; }
    return c;
  }

  // Copper anchors (pads and vias) with their centre, radius, net and layer.
  function anchors(doc, defs, o) {
    const out = [];
    for (const i of doc.items) {
      if (i.kind === "via" && o.vias) out.push({id: i.id, at: [i.x, i.y], r: (i.diameter || 0) / 2, net: i.net || "", layer: "Multi", span: viaSpan(i), kind: "via"});
      else if (i.kind === "pad" && o.pads) {
        const size = Math.min(i.w || 0, i.h || 0);
        if (size > 0 && !(i.drill >= size)) out.push({id: i.id, at: [i.x, i.y], r: size / 2, net: i.net || "", layer: i.layer || (i.drill > 0 ? "Multi" : "Top"), kind: "pad"});
      } else if (i.kind === "part" && o.pads) {
        const fp = defs.get(i.def)?.footprint; if (!fp) continue;
        for (const p of fp.pads || []) {
          const size = Math.min(p.w || 0, p.h || 0); if (!(size > 0) || p.drill >= size) continue;
          const layer = p.layer || (p.drill > 0 ? "Multi" : i.layer || "Top");
          out.push({id: i.id + ":" + p.number, owner: i.id, at: A().world([p.x, p.y], i), r: size / 2, net: (i.pinNets?.[p.number] ?? p.net) || "", layer, kind: "pad"});
        }
      }
    }
    return out;
  }
  function grid(list, cell) {
    const m = new Map(), key = (x, y) => Math.floor(x / cell) + "," + Math.floor(y / cell);
    for (const a of list) { const k = key(a.at[0], a.at[1]); if (!m.has(k)) m.set(k, []); m.get(k).push(a); }
    return p => { const out = [], cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell); for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const l = m.get((cx + dx) + "," + (cy + dy)); if (l) out.push(...l); } return out; };
  }
  /**
   * Teardrop outline at centre c (anchor radius r) for a track leaving along unit vector u
   * with width w. o.length / o.width are percentages; o.style "curved" or "straight".
   * Returns points or null when the track is too short or already as wide as the anchor.
   */
  function shape(c, r, u, w, room, o) {
    const hw = Math.min(r, Math.max(w / 2, r * (o.width ?? 90) / 100)), tail = r + 2 * r * (o.length ?? 100) / 100;
    const d = Math.min(tail, room);
    if (w >= 2 * hw * .95 || d < r + w * .5) return null;
    const n = [-u[1], u[0]], at = (s, t) => [c[0] + u[0] * s + n[0] * t, c[1] + u[1] * s + n[1] * t];
    // Start the flanks at the anchor's edge where its half-width is hw, so the shape overlaps the land.
    const s0 = Math.sqrt(Math.max(0, r * r - hw * hw)) * .5;
    if (o.style === "straight") return [at(s0, hw), at(d, w / 2), at(d, -w / 2), at(s0, -hw)];
    const side = sign => { const pts = [], N = 8; for (let k = 0; k <= N; k++) { const t = k / N, mt = 1 - t;
      // Quadratic Bézier bowed toward the track: control at (r, w/2).
      const s = mt * mt * s0 + 2 * mt * t * Math.min(d, r * 1.05) + t * t * d, h = mt * mt * hw + 2 * mt * t * (w / 2) + t * t * (w / 2);
      pts.push(at(s, sign * h)); } return pts; };
    return [...side(1), ...side(-1).reverse()];
  }
  const round = p => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
  /**
   * Plan teardrops. o: {scope:"all"|"selection", selection:[ids], style, length, width, pads, vias,
   * tjunctions, clearance, project}. Returns {add:[items], remove:[ids], skipped:[{at, reason}], ms}.
   */
  function plan(doc, defs, options = {}) {
    const t0 = Date.now(), o = {...DEFAULTS, ...options};
    if (doc.kind !== "pcb") throw Error("Open a PCB layout to add teardrops.");
    const sel = o.scope === "selection" ? new Set(o.selection || []) : null;
    const inScope = (...ids) => !sel || ids.some(id => id && sel.has(id));
    const list = anchors(doc, defs, o), maxR = Math.max(.5, ...list.map(a => a.r));
    const near = grid(list, maxR * 2 + .01);
    const tracks = doc.items.filter(i => i.kind === "track" && copper(i.layer) && Array.isArray(i.points) && i.points.length > 1 && i.width > 0);
    // Existing teardrops in scope are replaced; locked ones stay, and no copy is added next to them.
    const remove = doc.items.filter(i => isTeardrop(i) && i.locked !== true && (!sel || sel.has(i.id) || sel.has(i.teardropTrack) || sel.has(i.teardropAnchor) || sel.has(String(i.teardropAnchor || "").split(":")[0]))).map(i => i.id);
    const kept = new Set(doc.items.filter(i => isTeardrop(i) && i.locked === true).map(i => i.teardropTrack + "|" + i.teardropAnchor));
    const add = [], skipped = [];
    let world = null, rules = null;
    const R = globalThis.AtriumRouter;
    if (o.clearance && R?.world && R?.check) {
      try { const gone = new Set(remove); const base = remove.length ? {...doc, items: doc.items.filter(i => !gone.has(i.id))} : doc; world = R.world(base, defs, {}); rules = R.core?.rulesFor ? R.core.rulesFor(base, {}, o.project || null) : null; } catch { world = null; }
    }
    // Copper of another net (or a keep-out or hole) lying wholly inside the teardrop: the
    // outline check alone cannot see it. Any such feature with a point inside is a short.
    const C = R?.core;
    const interior = (pts, layer, net) => {
      const W = world, li = C.layerIndex(layer);
      const nid = W.netIds.has(net) ? W.netIds.get(net) : net ? 1e9 : C.NONET;
      const ctx = C.makeContext(W, rules, {layer, hw: 0, net: nid, netName: net});
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, m = C.candidates(W, cx, cy, cx, cy, Math.hypot(x1 - x0, y1 - y0) / 2 + 1e-3, li, li);
      for (const f of Array.from(W.qb.subarray(0, m))) {
        if (W.own[f] < 0 || C.required(ctx, f) < 0) continue;
        if (inside([W.ax[f], W.ay[f]], pts)) return true;
      }
      return false;
    };
    // A failed check skips the teardrop: output copper is never added unchecked.
    const legal = (pts, layer, net) => {
      if (!world || !rules) return true;
      try { return R.check(world, rules, {points: [...pts, pts[0]], width: .002, layer, net}).ok && !(C?.candidates && interior(pts, layer, net)); } catch { return false; }
    };
    const emit = (anchorId, owner, c, r, track, end, u, room) => {
      if (kept.has(track.id + "|" + anchorId)) { skipped.push({at: c, reason: "locked", track: track.id}); return; }
      const pts = shape(c, r, u, track.width, room, o);
      if (!pts) return;
      const poly = pts.map(round);
      if (!legal(poly, track.layer, track.net || "")) { skipped.push({at: c, reason: "clearance", track: track.id}); return; }
      add.push({id: A().id(), kind: "graphic", points: poly, closed: true, fill: true, width: 0, layer: track.layer, net: track.net || "",
        teardrop: true, teardropTrack: track.id, teardropAnchor: anchorId, groupId: "teardrop:" + (owner || anchorId)});
    };
    for (const t of tracks) {
      for (const end of [0, t.points.length - 1]) {
        const p = t.points[end], q = t.points[end === 0 ? 1 : end - 1], len = dist(p, q);
        if (len < 1e-6) continue;
        const u = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
        // Pads and vias whose centre is at the track end (within the land).
        let best = null;
        const li = layerNo(t.layer);
        for (const a of near(p)) {
          if (a.layer !== "Multi" && a.layer !== t.layer) continue;
          if (a.span && !(li >= a.span[0] && li <= a.span[1])) continue;
          if ((a.net || "") !== (t.net || "")) continue;
          const e = dist(a.at, p); if (e > a.r * .5) continue;
          if (!best || e < dist(best.at, p)) best = a;
        }
        if (best) {
          // Build on the track's own centreline: from the anchor centre's projection onto
          // it, with the largest circle about that point that stays inside the land.
          const along = (best.at[0] - p[0]) * u[0] + (best.at[1] - p[1]) * u[1];
          const lateral = Math.abs((best.at[0] - p[0]) * u[1] - (best.at[1] - p[1]) * u[0]);
          const c = [p[0] + u[0] * along, p[1] + u[1] * along];
          if (inScope(t.id, best.id, best.owner)) emit(best.id, best.owner, c, best.r - lateral, t, end, u, len - along);
          continue;
        }
        if (!o.tjunctions) continue;
        // T junction: this end lies on the interior of another same-net track segment.
        for (const s of tracks) {
          if (s === t || s.layer !== t.layer || (s.net || "") !== (t.net || "") || s.width < t.width) continue;
          let hit = false;
          for (let k = 1; k < s.points.length && !hit; k++) {
            const a = s.points[k - 1], b = s.points[k];
            if (A().nearSegment(p, a, b) < 1e-4 && dist(p, a) > s.width && dist(p, b) > s.width) hit = true;
          }
          if (hit && inScope(t.id, s.id)) { emit(s.id + "@" + round(p).join(","), s.id, p, s.width / 2 * 1.4, t, end, u, len); break; }
        }
      }
    }
    return {add, remove, skipped, ms: Date.now() - t0};
  }
  function removePlan(doc, options = {}) {
    const sel = options.scope === "selection" ? new Set(options.selection || []) : null;
    const hit = doc.items.filter(i => isTeardrop(i) && (!sel || sel.has(i.id) || sel.has(i.teardropTrack) || sel.has(String(i.teardropAnchor || "").split(":")[0])));
    return {add: [], skipped: hit.filter(i => i.locked === true).map(i => ({at: i.points?.[0], reason: "locked"})), remove: hit.filter(i => i.locked !== true).map(i => i.id)};
  }
  function apply(doc, p) {
    const gone = new Set(p.remove || []);
    if (gone.size) doc.items = doc.items.filter(i => !gone.has(i.id));
    for (const i of p.add || []) doc.items.push(i);
    return {added: (p.add || []).length, removed: gone.size};
  }

  // ---------------------------------------------------------------- dialog
  let prefs = {...DEFAULTS};
  function open(ctx) {
    if (ctx.doc.kind !== "pcb") { ctx.info?.("Open a PCB layout to add teardrops."); return; }
    document.querySelectorAll("dialog.teardrop-dialog").forEach(d => d.close());
    const el = (t, x, c) => AtriumNavCommon.el(t, x, c);
    const d = el("dialog", null, "ui-dialog message-dialog teardrop-dialog"); d.setAttribute("aria-label", "Teardrops");
    const form = el("form"); form.method = "dialog";
    const body = el("div", null, "ui-dialog-body");
    const row = (label, input, unit) => {
      const l = el("label", null, "teardrop-field ui-field-row");
      input.classList.add("ui-field");
      l.append(el("span", label));
      if (unit) {
        const measure = el("span", null, "ui-field-measure");
        input.setAttribute("aria-label", label + " (" + unit + ")");
        measure.append(input, el("span", unit, "ui-field-unit"));
        l.append(measure);
      } else l.append(input);
      body.append(l);
      return input;
    };
    const select = (v, opts) => { const s = el("select"); for (const [k, t] of opts) s.add(new Option(t, k)); s.value = v; return s; };
    const num = v => { const n = el("input"); n.type = "number"; n.dataset.numericUnit = "%"; n.min = "10"; n.max = "300"; n.step = "5"; n.value = String(v); return n; };
    const check = (label, v) => { const l = el("label", null, "pcb-edit-check"), b = el("input", null, "ui-checkbox"); b.type = "checkbox"; b.checked = v; l.append(b, el("span", " " + label)); body.append(l); return b; };
    form.append(el("h2", "Teardrops", "ui-dialog-title"), body);
    const scope = row("Scope", select(ctx.selection?.length ? "selection" : "all", [["all", "All objects"], ["selection", "Selected objects only"]]));
    const style = row("Style", select(prefs.style, [["curved", "Curved"], ["straight", "Straight (line)"]]));
    const length = row("Length", num(prefs.length), "% of pad size"), width = row("Width", num(prefs.width), "% of pad size");
    const pads = check("Pads", prefs.pads), vias = check("Vias", prefs.vias), tj = check("Track T-junctions", prefs.tjunctions);
    const note = el("p", "Teardrops that would break clearance to other nets are skipped.", "side-note"); body.append(note);
    const opts = () => ({scope: scope.value, selection: ctx.selection, style: style.value, length: +length.value || 100, width: +width.value || 90, pads: pads.checked, vias: vias.checked, tjunctions: tj.checked, project: ctx.project});
    const btn = (t, f, variant) => { const b = el("button", t, "ui-button"); b.type = "button"; b.onclick = f; if (variant) b.dataset.variant = variant; return b; };
    const actions = el("div", null, "ui-dialog-actions");
    actions.append(btn("Cancel", () => d.close()),
      btn("Remove", () => { const p = removePlan(ctx.doc, opts()); if (p.remove.length) ctx.edit(() => apply(ctx.doc, p)); ctx.info(p.remove.length + " teardrops removed." + (p.skipped.length ? " " + p.skipped.length + " locked teardrops kept." : "")); d.close(); }, "danger"),
      btn("Add", () => {
        prefs = {...prefs, ...opts()}; delete prefs.selection; delete prefs.project;
        let p; try { p = plan(ctx.doc, ctx.defs, opts()); } catch (e) { note.textContent = e.message; return; }
        if (p.add.length || p.remove.length) ctx.edit(() => apply(ctx.doc, p));
        const n = r => p.skipped.filter(s => s.reason === r).length, clr = n("clearance"), lk = n("locked");
        ctx.info(p.add.length + " teardrops added" + (clr ? ", " + clr + " skipped for clearance" : "") + (lk ? ", " + lk + " locked kept" : "") + " in " + p.ms + " ms."); d.close();
      }, "primary"));
    form.append(actions);
    d.append(form); document.body.append(d); d.addEventListener("close", () => d.remove(), {once: true});
    globalThis.AtriumShell?.adoptDialog?.(d, {initialFocus: scope, actions, defaultAction: false});
    d.showModal();
  }
  return Object.freeze({DEFAULTS, isTeardrop, shape, plan, removePlan, apply, open});
})();
