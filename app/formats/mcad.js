"use strict";
if (!globalThis.AtriumGeometryMaterial && typeof require === "function") require("../pcb/geometry-material.js");
// ECAD-MCAD exchange core (docs/mcad.md): the board as MCAD sees it, the IDX
// identity map, the inbox of incoming proposals and how an accepted proposal changes the board.
// DOM-free; the formats live in mcad-idx.js (IDX / EDMD), mcad-idf.js (IDF 3.0) and mcad-step.js
// (enclosure STEP, board outline from STEP); the panel and menu actions in mcad-panel.js.
//
// Stored on the board (format 1.3, optional; app/compat.js): doc.mcad =
//   {version: 1,
//    ids:      {atriumKey: {s: systemScope, n: number}}   objects MCAD created, keyed to the Waffle object
//    baseline: {seq, at, objects: {key: hash}, versions: {key: n}}   the last baseline or change set sent
//    inbox:    [proposal]                                 incoming proposals and their decisions
//    received: [{batch, file, kind, source, at, count}]   incoming files (one row each)
//    constraints: {maxHeightTop, maxHeightBottom}         mechanical constraints sent with the baseline
//    enclosure: {name, digest, bytes, offset:[x,y,z], rz, gap, text?}  the reference enclosure (text when small)}
// Keys: a part, free pad (hole) or keep-out is keyed by its item id; footprint holes by
// "<part id>/<pad number>"; the board by "board"; bend lines by "bend:<id>". An object's IDX
// identifier is {SystemScope "ATRIUM", Number key} unless MCAD created it (ids).
//
// A proposal: {id, batch, source ("idx"|"idf"|"step"|"enclosure"), kind, key, ident, label,
//   before, after, status ("pending"|"accepted"|"rejected"), comment?}
// kinds: place (move / rotate / flip a component), outline (board outline and cutouts),
//   hole-add, hole-change, hole-remove, keepout-add, keepout-change, keepout-remove, info.
//
//   AtriumMCAD.snapshot(project, doc, opts)        -> the MCAD view of the board (see snapshot())
//   AtriumMCAD.compare(project, doc, design)       -> [proposal] (a design is what a reader returns)
//   AtriumMCAD.receive(project, doc, design, meta) -> {batch, proposals} stored in doc.mcad.inbox
//   AtriumMCAD.accept(project, doc, id) / reject(project, doc, id, comment)   (call inside edit())
//   AtriumMCAD.apply(project, doc, proposal)       -> what changed (no status change)
//   AtriumMCAD.preview(project, doc, ids)          -> a copy of the project with those proposals applied
//   AtriumMCAD.status(project, doc)                -> counts for the panel and MCP mcad_status
globalThis.AtriumMCAD = (() => {
  const G = globalThis, VERSION = 1, SCOPE = "ATRIUM", EPS = 1e-4, ANG = 1e-3;
  const MAX_INBOX = 20000, MAX_IDS = 200000;
  const obj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const fin = v => typeof v === "number" && Number.isFinite(v);
  const r4 = v => Math.round(v * 1e4) / 1e4;
  const norm = a => { const x = ((a % 360) + 360) % 360; return Math.abs(x - 360) < 1e-9 ? 0 : r4(x); };
  const angDiff = (a, b) => { const d = Math.abs(norm(a) - norm(b)); return Math.min(d, 360 - d); };
  const A = () => G.Atrium, BS = () => G.AtriumBoardShape;
  const KINDS = ["place", "outline", "hole-add", "hole-change", "hole-remove", "keepout-add", "keepout-change", "keepout-remove", "info"];

  // ---------------------------------------------------------------- store
  function validate(m, invalid = () => { throw Error("Invalid MCAD data on the board."); }) {
    if (!obj(m) || m.version !== VERSION) invalid();
    if (m.ids != null && (!obj(m.ids) || Object.keys(m.ids).length > MAX_IDS || !Object.values(m.ids).every(v => obj(v) && typeof v.s === "string" && typeof v.n === "string"))) invalid();
    if (m.baseline != null && (!obj(m.baseline) || !obj(m.baseline.objects) || !Number.isInteger(m.baseline.seq))) invalid();
    if (m.inbox != null && (!Array.isArray(m.inbox) || m.inbox.length > MAX_INBOX || !m.inbox.every(p => obj(p) && typeof p.id === "string" && KINDS.includes(p.kind)))) invalid();
    if (m.received != null && (!Array.isArray(m.received) || m.received.length > 1000)) invalid();
    if (m.enclosure != null && (!obj(m.enclosure) || typeof m.enclosure.name !== "string")) invalid();
    return m;
  }
  const store = doc => { if (!obj(doc.mcad)) doc.mcad = {version: VERSION}; return doc.mcad; };
  const peek = doc => obj(doc?.mcad) ? doc.mcad : null;
  function identOf(doc, key) { const v = peek(doc)?.ids?.[key]; return v ? {scope: v.s, number: v.n} : {scope: SCOPE, number: key}; }
  function keyOf(doc, ident, snap) {
    if (!ident?.number) return null;
    if ((ident.scope || SCOPE) === SCOPE && snap.index.has(ident.number)) return ident.number;
    const ids = peek(doc)?.ids;
    if (ids) for (const [k, v] of Object.entries(ids)) if (v.n === ident.number && v.s === (ident.scope || "")) return snap.index.has(k) ? k : null;
    return null;
  }
  function remember(doc, key, ident) {
    if (!ident?.number || (ident.scope || SCOPE) === SCOPE && ident.number === key) return;
    (store(doc).ids ||= {})[key] = {s: ident.scope || "", n: ident.number};
  }

  // ---------------------------------------------------------------- the board as MCAD sees it
  const keepoutOf = i => i.kind === "graphic" && (i.keepout === true || i.layer === "Keepout" || /^keep-?out/i.test(i.layer || "")) && Array.isArray(i.points) && i.points.length >= 3 && (i.fill || i.closed || i.mcadKind);
  const COPPER = l => /^(Top|Bottom|Inner \d+|Mid-?Layer \d+)$/i.test(l || "");
  function keepoutKind(i) {
    if (["component", "route", "via", "keepin", "other"].includes(i.mcadKind)) return i.mcadKind;
    return i.keepout === true && COPPER(i.layer) ? "route" : "component";
  }
  function holeOf(pad, parent, datum) {
    const M = G.AtriumGeometryMaterial;
    let hit;
    M.visitPad(pad, parent, [...datum.copper.keys()], datum.copper, [], null, (member, bore, {at, endpoints}) => {
      if (bore.operation === "primary") hit = {x: r4(at[0]), y: r4(at[1]), d: r4(bore.cutter.diameter), plated: bore.plated,
        ...(endpoints && {slot: endpoints.map(q => [r4(q[0]), r4(q[1])])})};
    }, () => {});
    return hit;
  }
  // A slotted hole (slot: its drill centreline [a, b], Y down) has no IDF 3.0 or IDX primitive: it is
  // written as its outline, a stadium of width d, as board-shape segments counter-clockwise from the top.
  function slotContour(a, b, d) {
    const B = BS(), r = d / 2, t = B.angleOf(a, b), at = (c, k) => B.pointAt(c, r, k);
    return [B.line(at(a, t - 90), at(b, t - 90)), B.arc(b, r, t - 90, t + 90, true), B.line(at(b, t + 90), at(a, t + 90)), B.arc(a, r, t + 90, t + 270, true)];
  }
  function heightOf(item, def, project) {
    const S = G.AtriumSTEP;
    if (!S) return fin(+item.height) ? +item.height : 1;
    const m3 = item.model3d || def?.model3d || def?.footprint?.model3d;
    const p = S.paramHeight?.(item, def);
    if (p != null) return r4(p);
    const text = typeof m3?.stepText === "string" ? m3.stepText : project?.blobs?.[m3?.sha256]?.stepText;
    if (typeof text === "string") { try { const b = S.readModel(text).bbox; return r4(Math.max(0.01, b[5] + (+m3.offset?.[2] || 0))); } catch { /* fall through */ } }
    return r4(S.packageHeight?.(item, def) ?? 1);
  }
  const modelName = (item, def) => { const m = item.model3d || def?.model3d || def?.footprint?.model3d; return m ? String(m.file || m.name || (def?.footprint?.name || def?.name || "model") + ".step") : null; };
  function outlineOf(doc) {
    const B = BS(), fresh = B?.fresh(doc), shape = fresh || B?.current(doc), cutoutContours = fresh?.cutouts || [];
    const points = p => p.map(([x,y]) => [r4(x),r4(y)]);
    return {outline: points(shape ? B.flattenContour(shape.contour, .005) : doc.outline || []),
      cutouts: cutoutContours.map(c => points(B.flattenContour(c, .005))), contour: shape?.contour || null, cutoutContours};
  }
  // opts.pinHoles: also every plated footprint hole (default: free holes and non-plated footprint holes only).
  function snapshot(project, doc, opts = {}) {
    const defs = new Map((project.library || []).map(d => [d.id, d]));
    const datum = G.AtriumGeometryMaterial.datum(doc, defs);
    const shape = outlineOf(doc);
    const m = peek(doc) || {};
    const board = {key: "board", name: String(doc.name || project.name || "Board"), thickness: r4(datum.nominal), ...shape,
      constraints: obj(m.constraints) ? {...m.constraints} : {}};
    const parts = [], holes = [], keepouts = [], bends = [];
    for (const i of doc.items || []) {
      if (i.kind === "part") {
        const def = defs.get(i.def);
        if (!def?.footprint) continue;
        parts.push({key: i.id, id: i.id, ref: String(i.ref || ""), value: String(i.value ?? ""), x: r4(i.x), y: r4(i.y), angle: norm(i.angle || 0),
          side: i.layer === "Bottom" ? "Bottom" : "Top", height: heightOf(i, def, project), package: String(def.footprint.name || def.name || def.id), def: def.id,
          model: modelName(i, def), locked: i.locked === true});
        for (const p of def.footprint.pads || []) {
          const h = holeOf(p, i, datum);
          if (h) opts.mechanicalHole?.(p, i, !h.plated || !!opts.pinHoles);
          if (h && (!h.plated || opts.pinHoles)) holes.push({key: i.id + "/" + p.number, id: null, owner: i.id, ...h});
        }
      } else if (i.kind === "pad") {
        const h = holeOf(i, null, datum);
        if (h) opts.mechanicalHole?.(i, null, true);
        if (h) holes.push({key: i.id, id: i.id, owner: null, ...h});
      } else if (i.kind === "via" && (opts.vias || opts.mechanicalHole)) {
        const h = holeOf(i, null, datum);
        if (h) opts.mechanicalHole?.(i, null, !!opts.vias);
        if (h && opts.vias) holes.push({key: i.id, id: i.id, owner: null, via: true, ...h});
      } else if (keepoutOf(i)) {
        const z = Array.isArray(i.mcadZ) && i.mcadZ.length === 2 && i.mcadZ.every(fin) ? i.mcadZ.map(r4) : null;
        keepouts.push({key: i.id, id: i.id, kind: keepoutKind(i), layer: i.layer, points: i.points.map(p => [r4(p[0]), r4(p[1])]), z0: z ? z[0] : 0, z1: z ? z[1] : null});
      }
    }
    for (const b of doc.stackup?.bends || []) if (b && Array.isArray(b.a) && Array.isArray(b.b))
      bends.push({key: "bend:" + b.id, id: b.id, name: String(b.name || b.id), a: b.a.map(r4), b: b.b.map(r4), width: r4(+b.width || 0), angle: r4(+b.angle || 0), radius: r4(+b.radius || 0)});
    const snap = {board, parts, holes, keepouts, bends, index: new Map()};
    snap.index.set("board", board);
    for (const list of [parts, holes, keepouts, bends]) for (const o of list) snap.index.set(o.key, o);
    return snap;
  }
  function exportSnapshot(project, doc, opts) {
    const snap = snapshot(project, doc, opts);
    if (!A().validOutline(snap.board.outline))
      throw Object.assign(Error("Define a closed board outline before exporting to MCAD."), {code:"mcad-outline-required"});
    return snap;
  }
  // A stable 32-bit FNV-1a digest of what MCAD cares about for one object.
  function hashOf(o) {
    const pick = o.key === "board" ? {o: o.outline, c: o.cutouts, t: o.thickness, k: o.constraints}
      : o.ref != null ? {x: o.x, y: o.y, a: o.angle, s: o.side, h: o.height, m: o.model, l: o.locked, p: o.package}
      : o.points ? {p: o.points, k: o.kind, z: [o.z0, o.z1], l: o.layer}
      : o.d != null ? {x: o.x, y: o.y, d: o.d, p: o.plated, s: o.slot}
      : {a: o.a, b: o.b, w: o.width, g: o.angle, r: o.radius};
    const s = JSON.stringify(pick);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
  function hashes(snap) { const out = {}; for (const [k, o] of snap.index) out[k] = hashOf(o); return out; }
  // Record what was sent (a baseline, or a change set on top of it). Versions count changes per object.
  function recordSent(doc, snap, o = {}) {
    const m = store(doc), prev = m.baseline, now = hashes(snap), versions = {...(o.reset ? {} : prev?.versions || {})};
    for (const [k, h] of Object.entries(now)) if (!o.reset && prev?.objects?.[k] != null && prev.objects[k] !== h) versions[k] = (versions[k] || 1) + 1;
    m.baseline = {seq: o.reset ? 1 : (prev?.seq || 0) + 1, at: o.at || "", objects: now, versions};
    return m.baseline;
  }
  // Objects added, changed or removed since the recorded baseline.
  function changesSince(doc, snap) {
    const base = peek(doc)?.baseline;
    if (!base) return null;
    const now = hashes(snap), out = {added: [], changed: [], removed: []};
    for (const [k, h] of Object.entries(now)) { if (base.objects[k] == null) out.added.push(k); else if (base.objects[k] !== h) out.changed.push(k); }
    for (const k of Object.keys(base.objects)) if (now[k] == null) out.removed.push(k);
    return out;
  }

  // ---------------------------------------------------------------- geometry helpers
  const polyDist = (p, P) => { let d = Infinity; for (let i = 0; i < P.length; i++) d = Math.min(d, A().nearSegment(p, P[i], P[(i + 1) % P.length])); return d; };
  // Two closed polygons describe the same outline within tol (every vertex of each lies on the other).
  function samePoly(a, b, tol = 0.01) {
    if (!a?.length || !b?.length) return !a?.length && !b?.length;
    return a.every(p => polyDist(p, b) <= tol) && b.every(p => polyDist(p, a) <= tol);
  }
  function sameSet(a, b, tol) {
    if ((a || []).length !== (b || []).length) return false;
    const used = new Set();
    return a.every(p => { const j = b.findIndex((q, k) => !used.has(k) && samePoly(p, q, tol)); if (j < 0) return false; used.add(j); return true; });
  }
  const centroid = P => { let x = 0, y = 0; for (const p of P) { x += p[0]; y += p[1]; } return [x / P.length, y / P.length]; };

  // ---------------------------------------------------------------- compare
  // design: {source, kind ("baseline"|"changes"|"response"), full, board?, parts, holes, keepouts, removed:[ident], responses, notes}
  // Each design object carries ident {scope, number} (or null) and, for parts, ref.
  function compare(project, doc, design, opts = {}) {
    opts = {...(design.compare || {}), ...opts};
    const snap = snapshot(project, doc, opts), out = [], tol = opts.tolerance ?? 0.01;
    const seen = new Set();
    const add = (kind, key, ident, label, before, after, extra) => out.push({kind, key, ident: ident || null, label, before: before ?? null, after: after ?? null, ...extra});
    const refs = new Map(snap.parts.map(p => [p.ref, p]));
    // Components: moved, rotated, flipped. Unknown ones and removals are reported, never applied.
    for (const c of design.parts || []) {
      let key = keyOf(doc, c.ident, snap);
      if (!key && c.ref && refs.has(c.ref)) key = refs.get(c.ref).key;
      const cur = key && snap.index.get(key);
      if (!cur || cur.ref == null) { add("info", null, c.ident, "MCAD has a component " + (c.ref || c.ident?.number || "") + " that is not on the board (not applied).", null, null); continue; }
      seen.add(key);
      const moved = Math.hypot(c.x - cur.x, c.y - cur.y) > EPS, turned = angDiff(c.angle, cur.angle) > ANG, flipped = (c.side || "Top") !== cur.side;
      if (!moved && !turned && !flipped) continue;
      const what = [moved && "moved", turned && "rotated", flipped && "flipped to " + c.side].filter(Boolean).join(", ");
      add("place", key, c.ident, cur.ref + " " + what + (cur.locked ? " (locked in Waffle)" : ""),
        {x: cur.x, y: cur.y, angle: cur.angle, side: cur.side}, {x: r4(c.x), y: r4(c.y), angle: norm(c.angle), side: c.side || "Top"}, {ref: cur.ref});
    }
    // IDF 3.0 carries a slotted hole as a board cutout: a cutout on a slot's outline is that hole.
    if (design.board?.cutouts?.length && snap.holes.some(h => h.slot)) {
      const slots = snap.holes.filter(h => h.slot).map(h => ({h, ring: BS().flattenContour(slotContour(h.slot[0], h.slot[1], h.d), .005)}));
      const cutouts = design.board.cutouts.filter(c => {
        const hit = slots.find(s => !seen.has(s.h.key) && samePoly(c, s.ring, tol));
        if (hit) seen.add(hit.h.key);
        return !hit;
      });
      design = {...design, board: {...design.board, cutouts}};
    }
    // Board outline and cutouts.
    if (design.board?.outline?.length >= 3) {
      const b = snap.board, sameOuter = samePoly(design.board.outline, b.outline, tol), sameCuts = design.board.cutouts == null || sameSet(design.board.cutouts, b.cutouts, tol);
      if (!sameOuter || !sameCuts) {
        const parts = [!sameOuter && "outline", !sameCuts && "cutouts"].filter(Boolean).join(" and ");
        add("outline", "board", design.board.ident, "Board " + parts + " changed" + (design.board.cutouts ? " (" + design.board.cutouts.length + " cutout" + (design.board.cutouts.length === 1 ? "" : "s") + ")" : ""),
          {outline: b.outline, cutouts: b.cutouts}, {outline: design.board.outline.map(p => [r4(p[0]), r4(p[1])]), cutouts: (design.board.cutouts ?? b.cutouts).map(c => c.map(p => [r4(p[0]), r4(p[1])])),
            contour: design.board.contour || null, cutoutContours: design.board.cutoutContours || null});
      }
    }
    // Holes: by identifier, else by position (and diameter).
    const freeHoles = snap.holes.filter(h => !h.owner), allHoles = snap.holes;
    for (let h of design.holes || []) {
      let key = keyOf(doc, h.ident, snap);
      if (!key) { const near = allHoles.find(x => !seen.has(x.key) && Math.hypot(x.x - h.x, x.y - h.y) <= Math.max(tol, 0.02) && Math.abs(x.d - h.d) <= 0.01); if (near) key = near.key; }
      if (!key && opts.matchHolesLoosely) { const near = allHoles.find(x => !seen.has(x.key) && Math.hypot(x.x - h.x, x.y - h.y) <= 0.05); if (near) key = near.key; }
      const cur = key && snap.index.get(key);
      if (!cur) { add("hole-add", null, h.ident, "New " + (h.plated ? "plated" : "non-plated") + " hole Ø" + fmt(h.d) + " mm at " + fmt(h.x) + ", " + fmt(h.y), null, {x: r4(h.x), y: r4(h.y), d: r4(h.d), plated: !!h.plated}); continue; }
      seen.add(key);
      if (opts.ignorePlating) h = {...h, plated: cur.plated};
      if (Math.hypot(h.x - cur.x, h.y - cur.y) <= EPS && Math.abs(h.d - cur.d) <= EPS && !!h.plated === !!cur.plated) continue;
      if (cur.owner) { add("info", key, h.ident, "MCAD changed a footprint hole of " + (snap.index.get(cur.owner)?.ref || "a component") + " (edit the footprint; not applied).", null, null); continue; }
      add("hole-change", key, h.ident, "Hole Ø" + fmt(cur.d) + " → Ø" + fmt(h.d) + " mm" + (Math.hypot(h.x - cur.x, h.y - cur.y) > EPS ? ", moved" : ""), {x: cur.x, y: cur.y, d: cur.d, plated: cur.plated}, {x: r4(h.x), y: r4(h.y), d: r4(h.d), plated: !!h.plated});
    }
    // Keep-outs and keep-ins.
    for (const k of design.keepouts || []) {
      let key = keyOf(doc, k.ident, snap);
      if (!key) { const near = snap.keepouts.find(x => !seen.has(x.key) && samePoly(x.points, k.points, tol)); if (near) key = near.key; }
      const cur = key && snap.index.get(key);
      const after = {points: k.points.map(p => [r4(p[0]), r4(p[1])]), kind: k.kind || "component", z0: fin(k.z0) ? r4(k.z0) : 0, z1: fin(k.z1) ? r4(k.z1) : null, layer: k.layer || null};
      const what = (after.kind === "keepin" ? "Keep-in" : "Keep-out (" + after.kind + ")") + (after.z1 != null ? " up to " + fmt(after.z1) + " mm" : "");
      if (!cur) { add("keepout-add", null, k.ident, "New " + what.toLowerCase().replace(/^keep/, "keep"), null, after); continue; }
      seen.add(key);
      if (samePoly(cur.points, after.points, EPS * 10) && cur.kind === after.kind && (cur.z1 ?? null) === (after.z1 ?? null) && (cur.z0 || 0) === (after.z0 || 0)) continue;
      add("keepout-change", key, k.ident, what + " changed", {points: cur.points, kind: cur.kind, z0: cur.z0, z1: cur.z1, layer: cur.layer}, after);
    }
    // Removals: explicit (a change set's deleted items) or, in a full data set, objects MCAD no longer has.
    const gone = new Set();
    for (const r of design.removed || []) { const key = keyOf(doc, r, snap); if (key) gone.add(key); }
    if (design.full) {
      if (design.scope?.holes !== false && design.holes) for (const h of freeHoles) if (!seen.has(h.key)) gone.add(h.key);
      if (design.scope?.keepouts !== false && design.keepouts) for (const k of snap.keepouts) if (!seen.has(k.key)) gone.add(k.key);
    }
    for (const key of gone) {
      const cur = snap.index.get(key);
      if (!cur) continue;
      if (cur.d != null && !cur.owner) add("hole-remove", key, identOf(doc, key), "Remove hole Ø" + fmt(cur.d) + " mm at " + fmt(cur.x) + ", " + fmt(cur.y), {x: cur.x, y: cur.y, d: cur.d, plated: cur.plated}, null);
      else if (cur.points) add("keepout-remove", key, identOf(doc, key), "Remove " + (cur.kind === "keepin" ? "keep-in" : "keep-out") + " at " + centroid(cur.points).map(fmt).join(", "), {points: cur.points, kind: cur.kind, z0: cur.z0, z1: cur.z1}, null);
      else if (cur.ref != null) add("info", key, identOf(doc, key), "MCAD removed " + cur.ref + " (not applied; delete it in Waffle if intended).", null, null);
    }
    for (const n of design.notes || []) add("info", null, null, String(n), null, null);
    return out;
  }
  const fmt = v => String(Math.round(v * 1000) / 1000);

  // ---------------------------------------------------------------- inbox
  // Store a received design's proposals (call inside edit()). meta: {file, at, source}.
  function receive(project, doc, design, meta = {}) {
    const m = store(doc), list = compare(project, doc, design, meta);
    m.inbox ||= []; m.received ||= [];
    const batch = "b" + (m.received.reduce((n, r) => Math.max(n, +String(r.batch).slice(1) || 0), 0) + 1);
    let n = m.inbox.reduce((k, p) => Math.max(k, +String(p.id).replace(/^\D+/, "") || 0), 0);
    // A newer file supersedes the pending proposals of earlier files from the same source.
    for (const p of m.inbox) if (p.status === "pending" && p.source === (design.source || meta.source)) p.status = "superseded";
    m.inbox = m.inbox.filter(p => p.status !== "superseded");
    const proposals = list.map(p => ({id: "p" + (++n), batch, source: design.source || meta.source || "idx", ...p, status: p.kind === "info" ? "info" : "pending"}));
    m.inbox.push(...proposals);
    if (m.inbox.length > MAX_INBOX) m.inbox = m.inbox.slice(-MAX_INBOX);
    m.received.push({batch, file: String(meta.file || ""), kind: design.kind || "baseline", source: design.source || meta.source || "idx", at: String(meta.at || ""),
      count: proposals.length, header: design.header ? {system: design.header.system || "", creator: design.header.creator || "", transaction: design.header.transaction || ""} : null,
      responses: (design.responses || []).length ? design.responses.slice(0, 2000) : undefined});
    if (m.received.length > 1000) m.received = m.received.slice(-1000);
    return {batch, proposals};
  }
  const find = (doc, id) => (peek(doc)?.inbox || []).find(p => p.id === id) || null;
  function pending(doc) { return (peek(doc)?.inbox || []).filter(p => p.status === "pending"); }

  // ---------------------------------------------------------------- apply
  const newId = () => A()?.id ? A().id() : "m" + Math.random().toString(36).slice(2, 12);
  function setOutline(doc, after) {
    const B = BS();
    if (!B) { doc.outline = after.outline.map(p => [p[0], p[1]]); return; }
    const contour = after.contour && after.contour.length ? after.contour : B.polySegments(after.outline, true, {fitArcs: true});
    const cutouts = after.cutoutContours && after.cutoutContours.length === (after.cutouts || []).length ? after.cutoutContours : (after.cutouts || []).map(c => B.polySegments(c, true, {fitArcs: true}));
    B.apply(doc, B.orient ? {contour, cutouts} : {contour, cutouts}, "mcad");
  }
  function apply(project, doc, p) {
    const item = id => doc.items.find(i => i.id === id);
    switch (p.kind) {
      case "place": {
        const part = item(p.key);
        if (!part) throw Error("The component " + (p.ref || p.key) + " is no longer on the board.");
        const a = p.after, side = part.layer === "Bottom" ? "Bottom" : "Top";
        if (a.side !== side) {
          const PE = G.AtriumPCBEdit;
          if (!PE?.applyFlip) throw Error("Flipping a component needs the PCB editing module.");
          PE.applyFlip(doc, project, {parts: [{id: part.id, def: part.def, to: {side: a.side, angle: a.angle, x: a.x, y: a.y}}]});
        }
        part.x = a.x; part.y = a.y; part.angle = a.angle;
        return {moved: part.id};
      }
      case "outline": setOutline(doc, p.after); return {outline: true};
      case "hole-add": {
        const a = p.after, w = a.plated ? r4(a.d + 0.6) : a.d;
        const it = {id: newId(), kind: "pad", number: "", x: a.x, y: a.y, w, h: w, drill: a.d, shape: "round", layer: "Multi", net: ""};
        if (!a.plated) it.plated = false;
        doc.items.push(it);
        remember(doc, it.id, p.ident);
        p.created = it.id;
        return {added: it.id};
      }
      case "hole-change": {
        const pad = item(p.key);
        if (!pad) throw Error("The hole is no longer on the board.");
        const a = p.after, k = pad.drill > 0 ? a.d / pad.drill : 1;
        pad.x = a.x; pad.y = a.y; pad.drill = a.d; pad.w = r4(Math.max(a.d, pad.w * k)); pad.h = r4(Math.max(a.d, pad.h * k));
        if (a.plated === false) pad.plated = false; else delete pad.plated;
        return {changed: pad.id};
      }
      case "keepout-add": {
        const a = p.after, layer = a.layer && COPPER(a.layer) ? a.layer : "Keepout";
        const it = {id: newId(), kind: "graphic", layer, points: a.points.map(q => [q[0], q[1]]), fill: true, closed: true, width: 0, mcadKind: a.kind || "component"};
        if (layer !== "Keepout") it.keepout = true;
        if (a.z1 != null) it.mcadZ = [a.z0 || 0, a.z1];
        doc.items.push(it);
        remember(doc, it.id, p.ident);
        p.created = it.id;
        return {added: it.id};
      }
      case "keepout-change": {
        const k = item(p.key);
        if (!k) throw Error("The keep-out is no longer on the board.");
        const a = p.after;
        k.points = a.points.map(q => [q[0], q[1]]); k.mcadKind = a.kind || k.mcadKind || "component";
        if (a.z1 != null) k.mcadZ = [a.z0 || 0, a.z1]; else delete k.mcadZ;
        return {changed: k.id};
      }
      case "hole-remove": case "keepout-remove": {
        const n = doc.items.length;
        doc.items = doc.items.filter(i => i.id !== p.key);
        if (doc.items.length === n) throw Error("It is no longer on the board.");
        if (doc.mcad?.ids) delete doc.mcad.ids[p.key];
        return {removed: p.key};
      }
      case "info": return {};
      default: throw Error("Unknown MCAD proposal " + p.kind + ".");
    }
  }
  // Accepting brings the board to MCAD's state for that object, so it is not sent back as a change.
  function settleBaseline(project, doc, p) {
    const base = peek(doc)?.baseline;
    if (!base) return;
    const snap = snapshot(project, doc), key = p.created || p.key;
    const o = key && snap.index.get(key);
    if (o) base.objects[key] = hashOf(o); else if (key) delete base.objects[key];
  }
  function accept(project, doc, id) {
    const p = find(doc, id);
    if (!p) throw Error("No MCAD proposal " + id + ".");
    if (p.status !== "pending") throw Error("This proposal was already " + p.status + ".");
    const r = apply(project, doc, p);
    p.status = "accepted";
    settleBaseline(project, doc, p);
    return r;
  }
  function reject(project, doc, id, comment) {
    const p = find(doc, id);
    if (!p) throw Error("No MCAD proposal " + id + ".");
    if (p.status !== "pending") throw Error("This proposal was already " + p.status + ".");
    p.status = "rejected";
    if (comment) p.comment = String(comment).slice(0, 500);
    return {};
  }
  // A copy of the project with the given proposals applied (preview, diff view). Failures are skipped.
  function preview(project, doc, ids) {
    const copy = JSON.parse(JSON.stringify(project)), d = copy.documents.find(x => x.id === doc.id);
    const want = new Set(ids || pending(doc).map(p => p.id)), errors = [];
    for (const p of (d.mcad?.inbox || [])) if (want.has(p.id) && p.status === "pending") { try { apply(copy, d, p); p.status = "accepted"; } catch (e) { errors.push(p.id + ": " + e.message); } }
    return {project: copy, doc: d, errors};
  }
  function status(project, doc) {
    const m = peek(doc) || {}, inbox = m.inbox || [], by = {};
    for (const p of inbox) by[p.status] = (by[p.status] || 0) + 1;
    const snap = snapshot(project, doc), ch = changesSince(doc, snap);
    return {document_id: doc.id, baseline: m.baseline ? {sequence: m.baseline.seq, at: m.baseline.at, objects: Object.keys(m.baseline.objects).length} : null,
      changes_since_baseline: ch ? {added: ch.added.length, changed: ch.changed.length, removed: ch.removed.length} : null,
      inbox: {pending: by.pending || 0, accepted: by.accepted || 0, rejected: by.rejected || 0, info: by.info || 0},
      mapped_ids: Object.keys(m.ids || {}).length, received: (m.received || []).length,
      enclosure: m.enclosure ? {name: m.enclosure.name, bytes: m.enclosure.bytes || 0, digest: m.enclosure.digest || "", offset: m.enclosure.offset || [0, 0, 0], rz: m.enclosure.rz || 0, embedded: typeof m.enclosure.text === "string"} : null,
      board: {parts: snap.parts.length, holes: snap.holes.length, keepouts: snap.keepouts.length, bends: snap.bends.length, thickness: snap.board.thickness}};
  }
  const pcbOf = (project, id) => {
    const d = (project.documents || []).find(x => id != null ? x.id === id || x.name === id : x.kind === "pcb");
    if (!d || d.kind !== "pcb") throw Error("Choose a PCB layout.");
    return d;
  };

  // Exchange formats supply Y-up coordinates; negate the parameters to
  // keep that frame while using the board sampler's ordinate convention.
  function projectArc(center, radius, start, sweep, minSegments, maxSegments) {
    return AtriumGeometryCurves.project([{kind: "arc", center, radius, start: -start, sweep: -sweep}],
      0.005 * Math.min(1, radius / 0.01), {minSegments, maxSegments, maxStep: 360});
  }
  return Object.freeze({VERSION, SCOPE, KINDS, projectArc, slotContour, validate, store, peek, identOf, keyOf, remember, snapshot, exportSnapshot, hashOf, hashes, recordSent, changesSince,
    compare, receive, find, pending, apply, accept, reject, preview, status, pcbOf, samePoly, keepoutOf, norm, r4});
})();
