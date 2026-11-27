"use strict";
// Part text: the Designator, the Comment and the visible parameters on schematics, and a
// component's designator and comment silkscreen on boards.
// As in Altium, pressing on a field's glyphs selects and drags that text only. The field stays
// attached to its part: its position is stored relative to the part, and the part is outlined
// while the field is hovered, selected or dragged so it is clear which part the text belongs to.
//
// A field is {item, key}: key "ref" (Designator), "value" (Comment) or "param:<name>".
// Where each field's position lives (all in part coordinates, so the text follows the part):
//   Designator / Comment   part.refAt / part.valueAt (left-aligned anchor), else the default place
//   imported parameter     part.schPaint.parameters[name].at
//   stacked parameter      drawn under the Comment until moved; a move gives it schPaint.parameters[name]
// Font, alignment and angle come from part.schPaint[key] (imported Altium text). Rotating a field
// that has none gives it one with the default face, so nothing else changes in its appearance.
//
// API (editor.js and canvas.js):
//   list(part, def, pos)                    -> [{key, label, text, at, paint}] (world anchor and paint)
//   quad(field)                             -> 4 world corners of the glyph box
//   at(view, doc, defs, p, opts)            -> {item, key} under p, or null
//   find(doc, defs, ref, pos)               -> the field record for a {id, key}
//   begin(part, def, key, pos)              -> drag session {anchor, move(world), rotate(step)} (after the undo mark)
//   rotate(part, def, key, pos, step)       -> rotates the field about its anchor
//   setPosition(part, def, key, pos, local) -> stores a new anchor in part coordinates
//   drawFocus(ctx, doc, defs, focus, o)     -> the owner outline and the field box
//   inspect(panel, ctx, ref)                -> the Properties panel of the selected field
//   pick(view, doc, defs, p, opts)          -> a sheet field {item, key} or a board label {item, label} under p
//   session(doc, defs, picked)              -> its drag {anchor, move(world), rotate?(step)}
//   turn(doc, defs, {id, key}, step)        -> Space on a selected field
globalThis.AtriumSchFields = (() => {
  const A = () => globalThis.Atrium, SCH = () => globalThis.AtriumSchAppearance;
  const SIZE = 2.032, FAMILY = "Times New Roman", INK = "#000080";
  const LABELS = {ref:"Designator", value:"Comment"};
  const OFFSET = {ref:"refAt", value:"valueAt"}, SHOW = {ref:"showRef", value:"showValue"};

  const isParam = key => key.startsWith("param:");
  const paramName = key => key.slice(6);
  const label = key => LABELS[key] || paramName(key);
  const norm = a => ((Math.round(a || 0) % 360) + 360) % 360;
  function toLocal(w, part) {
    const q = A().rotate([w[0] - part.x, w[1] - part.y], -(part.angle || 0));
    if (part.mirror) q[0] = -q[0];
    return q.map(v => Math.round(v * 1e6) / 1e6);
  }
  const face = align => ({family:FAMILY, size:SCH()?.fontSize || SIZE, ink:SCH()?.wire || INK, align, baseline:"alphabetic"});

  // ------------------------------------------------------------------ the fields a part shows
  // The same positions and paints as AtriumSchAppearance.refs and AtriumSchObjects.drawParams.
  function list(part, def, pos) {
    const out = [], lab = A().gateLabel ? A().gateLabel(part, def) : part;
    for (const key of ["ref", "value"]) {
      const text = lab[key], offset = part[OFFSET[key]];
      if (part[SHOW[key]] === false || !text) continue;
      const at = offset ? A().world(offset, part) : pos?.[key];
      if (!at) continue;
      const src = part.schPaint?.[key];
      out.push({key, label:label(key), text:String(text), at, paint:src ? {...src, angle:(src.angle || 0) + (part.angle || 0)} : face(offset ? "left" : pos.align)});
    }
    const S = globalThis.AtriumSchObjects, keys = S?.shownParams ? S.shownParams(part) : [];
    const base = part.valueAt ? A().world(part.valueAt, part) : pos?.value || [part.x, part.y];
    let stacked = 0;
    for (const k of keys) {
      const paint = part.schPaint?.parameters?.[k], value = String(part.parameters?.[k] ?? paint?.text ?? "");
      const key = "param:" + k;
      if (paint) out.push({key, label:k, text:paint.caption ? paint.caption + ": " + value : value, at:A().world(paint.at, part), paint:{...paint, angle:(paint.angle || 0) + (part.angle || 0)}});
      else out.push({key, label:k, text:value, at:[base[0], base[1] + ++stacked * SIZE * 1.15], paint:face(part.valueAt ? "left" : pos?.align || "left"), stacked:true});
    }
    return out;
  }

  // ------------------------------------------------------------------ glyph boxes
  let metricsCtx = null;
  const metrics = new Map();
  function fontMetrics(font) {
    let m = metrics.get(font);
    if (!m) {
      metricsCtx ??= globalThis.document?.createElement("canvas").getContext("2d") || null;
      m = {ascent:.89, descent:.22};
      if (metricsCtx) {
        metricsCtx.font = "100px " + font; metricsCtx.textBaseline = "alphabetic";
        const t = metricsCtx.measureText("Hg");
        if (Number.isFinite(t.fontBoundingBoxAscent)) m = {ascent:t.fontBoundingBoxAscent / 100, descent:t.fontBoundingBoxDescent / 100};
      }
      metrics.set(font, m);
    }
    return m;
  }
  function width(text, font) {
    if (!metricsCtx) metricsCtx = globalThis.document?.createElement("canvas").getContext("2d") || null;
    if (!metricsCtx) return text.length * .55;
    metricsCtx.font = "100px " + font;
    return metricsCtx.measureText(text).width / 100;
  }
  // The box AtriumSchAppearance.glyph paints, in the text's own frame (em units of size), then in world.
  function quad(f) {
    const S = SCH(), p = f.paint, size = p.size || SIZE;
    const style = (p.italic ? "italic " : "") + (p.bold ? "bold " : ""), font = style + (S?.fontStack ? S.fontStack(p.family) : '"' + (p.family || FAMILY) + '"');
    const text = S?.negation ? S.negation(f.text).text : f.text;
    const w = width(text, font) * size, m = fontMetrics(font);
    const dy = (S?.baselineShift ? S.baselineShift(font, p.baseline || "alphabetic") : 0) * size;
    const x0 = p.align === "right" ? -w : p.align === "center" ? -w / 2 : 0;
    const pad = size * .08;
    const local = [[x0 - pad, dy - m.ascent * size], [x0 + w + pad, dy - m.ascent * size], [x0 + w + pad, dy + m.descent * size], [x0 - pad, dy + m.descent * size]];
    return local.map(q => {const r = A().rotate(q, p.angle || 0); return [r[0] + f.at[0], r[1] + f.at[1]];});
  }
  function inside(p, poly) {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }
  const C = () => globalThis.AtriumCanvas;
  const defOf = (defs, part) => defs?.get ? defs.get(part.def) : defs?.[part.def];
  const posOf = (part, def) => C()?.referencePositions ? C().referencePositions(part, def, "schematic") : null;

  // The topmost field whose glyph box holds p. opts: {scale, selectable(item), tolerance (world)}.
  function at(view, doc, defs, p, opts = {}) {
    if (doc?.kind !== "schematic") return null;
    const tol = opts.tolerance || 0, scale = opts.scale || 1;
    const nearby = view.query(doc, defs, [p[0] - tol, p[1] - tol, p[0] + tol, p[1] + tol]);
    for (let n = nearby.length - 1; n >= 0; n--) {
      const part = nearby[n];
      if (part.kind !== "part" || opts.hidden?.has?.(part.id) || opts.selectable && !opts.selectable(part)) continue;
      const def = defOf(defs, part);
      for (const f of list(part, def, posOf(part, def)).reverse()) {
        // Text drawn too small to read is not drawn, so it cannot be picked either.
        if ((f.paint.size || SIZE) * scale < 2.4) continue;
        const box = quad(f);
        if (inside(p, box) || tol && box.some((c, k) => A().nearSegment(p, c, box[(k + 1) % 4]) <= tol)) return {item:part, key:f.key};
      }
    }
    return null;
  }
  function find(doc, defs, ref) {
    const part = ref && doc?.items.find(i => i.id === ref.id && i.kind === "part");
    if (!part) return null;
    const def = defOf(defs, part), pos = posOf(part, def);
    const f = list(part, def, pos).find(x => x.key === ref.key);
    return f ? {...f, item:part, def, pos} : null;
  }

  // ------------------------------------------------------------------ edits (inside the editor's edit()/drag)
  // A paint of the field's own: a copy, so imported parts that share paint objects stay independent.
  function ownPaint(part, key, f) {
    part.schPaint = {...part.schPaint};
    if (isParam(key)) {
      const k = paramName(key), params = part.schPaint.parameters = {...part.schPaint.parameters};
      params[k] = params[k] ? {...params[k]} : {...face(f.paint.align), angle:-(part.angle || 0), at:toLocal(f.at, part), text:String(part.parameters?.[k] ?? "")};
      return params[k];
    }
    if (part.schPaint[key]) return (part.schPaint[key] = {...part.schPaint[key]});
    // Default text has no paint: the one it is drawn with, at the angle it is drawn at.
    return (part.schPaint[key] = {...face(f.paint.align), angle:-(part.angle || 0)});
  }
  // Store a new world anchor. Designator and Comment anchors are left-aligned when they have no
  // paint of their own (the default place is centred), so the first move converts the anchor.
  function place(part, f, world) {
    const key = f.key;
    if (isParam(key)) {ownPaint(part, key, f).at = toLocal(world, part); return;}
    const offset = OFFSET[key];
    if (!part[offset] && !part.schPaint?.[key] && f.paint.align && f.paint.align !== "left") {
      const S = SCH(), font = S?.fontStack ? S.fontStack(f.paint.family) : FAMILY;
      const w = width(S?.negation ? S.negation(f.text).text : f.text, font) * (f.paint.size || SIZE);
      world = [world[0] - (f.paint.align === "center" ? w / 2 : w), world[1]];
    }
    part[offset] = toLocal(world, part);
  }
  // A Designator or Comment still at its default (centred) place gets an explicit anchor at the
  // same place first; returns the field as drawn afterwards.
  function explicit(part, def, key, pos) {
    // Parameters stacked under the Comment stay where they are when the Comment moves.
    if (key === "value") for (const g of list(part, def, pos)) if (g.stacked) ownPaint(part, g.key, g);
    let f = list(part, def, pos).find(x => x.key === key);
    if (f && !isParam(key) && !part[OFFSET[key]]) {place(part, f, f.at); f = list(part, def, pos).find(x => x.key === key);}
    return f;
  }
  function setPosition(part, def, key, pos, local) {
    const f = explicit(part, def, key, pos);
    if (f) place(part, f, A().world(local, part));
  }
  function rotate(part, def, key, pos, step) {
    const f = explicit(part, def, key, pos);
    if (!f) return false;
    const paint = ownPaint(part, key, f);
    paint.angle = norm((paint.angle || 0) + step);
    return true;
  }
  function setSize(part, def, key, pos, size) {
    const f = explicit(part, def, key, pos);
    if (f) ownPaint(part, key, f).size = size;
  }
  // A drag session. Call it once the drag has started (after the undo mark): a field at its
  // default place gets its explicit anchor here. move(world) puts the anchor there.
  function begin(part, def, key, pos) {
    const f = explicit(part, def, key, pos);
    if (!f) return null;
    const fresh = () => list(part, def, pos).find(x => x.key === key);
    return {anchor:f.at.slice(), move(world) {const g = fresh(); if (g) place(part, g, world);}, rotate:step => rotate(part, def, key, pos, step)};
  }

  // ------------------------------------------------------------------ board labels
  // A component's own silkscreen label on a board: its placed designator (part.designator), an
  // imported Altium Designator / Comment (AtriumPCBAppearance.sourceLabels) or the plain reference
  // (part.refAt). Altium lets these be dragged without the component. -> {item, label:{kind, index}}
  function boardLabelAt(view, doc, defs, p, opts) {
    const PCB = globalThis.AtriumPCBAppearance, scale = view.scale(), tol = 2 / scale;
    const nearby = view.query(doc, defs, [p[0] - tol, p[1] - tol, p[0] + tol, p[1] + tol]);
    for (let n = nearby.length - 1; n >= 0; n--) {
      const i = nearby[n];
      if (i.kind !== "part" || i.locked || opts.selectable && !opts.selectable(i)) continue;
      const rows = Array.from(PCB.partText(doc,i,PCB.readDefinition(defs,i.def,doc)));
      const hit = row => PCB.visible(row.text.layer,i,opts) &&
        (row.kind!=="annotation" || row.text.size*scale>3.3) && C().partTextDistance(row,doc,p)<=tol;
      if(rows[0]?.kind==="designator" && hit(rows[0]))return {item:i,label:{kind:"designator"}};
      for(let k=rows.length-1;k>=0;k--){
        const row=rows[k];
        if(row.kind!=="designator" && hit(row))return {item:i,label:{kind:row.kind,...(row.index==null?null:{index:row.index})}};
      }
    }
    return null;
  }
  function boardSession(doc, defs, i, l) {
    const PCB = globalThis.AtriumPCBAppearance;
    const row=Array.from(PCB.partText(doc,i,PCB.readDefinition(defs,i.def,doc)))
      .find(row=>row.kind===l.kind && row.index===l.index);
    if(!row)return null;
    const text=row.text;
    let anchor=row.center||[text.x,text.y];
    if(l.kind==="reference" && !i.refAt){
      // A new explicit anchor is left-aligned.
      const box=globalThis.AtriumPCBText?.paintBox(text);
      if(box)anchor=[box[0],text.y];
    }
    const hiddenIndex=row.row?i.hiddenBoardLabels?.indexOf(row.row)??-1:-1;
    const local = at => {const q = A().rotate([at[0] - i.x, at[1] - i.y], -(i.angle || 0)); if (i.mirror) q[0] = -q[0]; return q.map(v => Math.round(v * 1e6) / 1e6);};
    return {anchor, move(at) {
      if (l.kind === "designator") {const [x, y] = local(at); i.designator = {...i.designator, x, y};}
      else if (l.kind === "reference") i.refAt = local(at);
      else if(hiddenIndex>=0){
        i.hiddenBoardLabels=i.hiddenBoardLabels.map((a,n)=>n===hiddenIndex?{...a,at:local(at)}:a);
      }else {
        // Imported labels become the part's own when one moves (a shared annotation table stays as it was).
        const rows = Array.isArray(i.boardLabels) ? i.boardLabels : doc.pcbDrawing?.annotations?.[i.sourceRecord];
        if (!Array.isArray(rows) || !rows[l.index]) return;
        i.boardLabels = rows.map(a => ({...a})); i.boardLabels[l.index].at = local(at);
      }
    }};
  }

  // ------------------------------------------------------------------ editor glue
  // The text under p on a sheet or a board -> {item, key} (sheet field) or {item, label} (board label).
  function pick(view, doc, defs, p, opts = {}) {
    return doc?.kind === "pcb" ? boardLabelAt(view, doc, defs, p, opts) : at(view, doc, defs, p, {...opts, scale:view.scale()});
  }
  // A drag of what pick() returned: {anchor, move(world), rotate?(step)}. Call it after the undo mark.
  function session(doc, defs, t) {
    if (t.label) return boardSession(doc, defs, t.item, t.label);
    const def = defOf(defs, t.item);
    return begin(t.item, def, t.key, posOf(t.item, def));
  }
  // Space on a selected (not moving) field.
  function turn(doc, defs, ref, step) {
    const part = doc.items.find(i => i.id === ref.id), def = part && defOf(defs, part);
    return !!part && rotate(part, def, ref.key, posOf(part, def), step);
  }

  // ------------------------------------------------------------------ drawing
  // focus: {id, key, mode: "hover" | "selected" | "drag"}; o: {scale, select (ink)}.
  function drawFocus(ctx, doc, defs, focus, o) {
    const f = find(doc, defs, focus);
    if (!f) return;
    const scale = o.scale || 1, ink = o.select || "#00a000";
    ctx.save();
    // The owner: a light tint and a thin dashed outline, not a selection.
    const box = C()?.partBox ? C().partBox(f.item, A().geometries(f.def, "schematic")) : null;
    if (box) {
      const m = 4 / scale;
      ctx.globalAlpha = .08; ctx.fillStyle = ink; ctx.fillRect(box[0] - m, box[1] - m, box[2] - box[0] + 2 * m, box[3] - box[1] + 2 * m);
      ctx.globalAlpha = .7; ctx.strokeStyle = ink; ctx.lineWidth = 1 / scale; ctx.setLineDash([4 / scale, 3 / scale]);
      ctx.strokeRect(box[0] - m, box[1] - m, box[2] - box[0] + 2 * m, box[3] - box[1] + 2 * m);
    }
    // The field: a box around its glyphs, solid when it is selected or moving.
    const q = quad(f);
    ctx.globalAlpha = focus.mode === "hover" ? .6 : 1; ctx.setLineDash(focus.mode === "hover" ? [3 / scale, 2 / scale] : []);
    ctx.strokeStyle = ink; ctx.lineWidth = (focus.mode === "hover" ? 1 : 1.4) / scale;
    ctx.beginPath(); ctx.moveTo(...q[0]); for (let k = 1; k < 4; k++) ctx.lineTo(...q[k]); ctx.closePath(); ctx.stroke();
    if (focus.mode !== "hover") {ctx.globalAlpha = .12; ctx.fillStyle = ink; ctx.fill();}
    ctx.restore();
  }

  // ------------------------------------------------------------------ Properties panel
  // ctx: {doc, defs, edit(fn, touched), field(parent, label, value, update, opt), section(parent, title),
  //       row(parent, label, value), select(id)}
  const check = (parent, text, on, update) => AtriumNavCommon.appendSwitchRow(parent, text, on, update);
  function inspect(panel, ctx, ref) {
    const f = find(ctx.doc(), ctx.defs(), ref);
    if (!f) return false;
    const part = f.item, key = ref.key, s = ctx.section(panel, label(key) + " · " + (part.ref || "Part"));
    const edit = fn => ctx.edit(() => fn(part), [part]);
    if (key === "ref") ctx.field(s, "Text", part.ref || "", v => edit(p => {p.ref = v;}));
    else if (key === "value") ctx.field(s, "Text", part.value || "", v => edit(p => {p.value = v;}), {allowEmpty:true});
    else ctx.field(s, "Value", String(part.parameters?.[paramName(key)] ?? ""), v => edit(p => {p.parameters = {...p.parameters, [paramName(key)]:v};}), {allowEmpty:true});
    check(s, "Visible", true, on => edit(p => {
      if (on) return;
      if (isParam(key)) {p.paramShow = {...p.paramShow}; delete p.paramShow[paramName(key)];}
      else p[SHOW[key]] = false;
    }));
    const local = toLocal(f.at, part);
    ctx.field(s, "X (from part)", local[0], v => edit(p => setPosition(p, f.def, key, f.pos, [v, local[1]])), {length:true});
    ctx.field(s, "Y (from part)", local[1], v => edit(p => setPosition(p, f.def, key, f.pos, [local[0], v])), {length:true});
    ctx.field(s, "Rotation (°)", String(norm(f.paint.angle)), v => edit(p => rotate(p, f.def, key, f.pos, norm(+v - norm(f.paint.angle)))),
      {values:["0", "90", "180", "270"].map(a => [a, a + "°"])});
    ctx.field(s, "Font size (pt)", String(Math.round((f.paint.size || SIZE) / .2032 * 10) / 10), v => edit(p => setSize(p, f.def, key, f.pos, Math.max(1, Math.min(200, v)) * .2032)), {number:true, min:1, step:1});
    ctx.row(s, "Font", f.paint.family || FAMILY);
    ctx.row(s, "Owner", part.ref || part.def);
    const go = document.createElement("button"); go.type = "button"; go.textContent = "Select " + (part.ref || "part");
    go.title = "Select the part this text belongs to"; go.onclick = () => ctx.select(part.id);
    s.append(globalThis.AtriumUI?.button(go, "secondary") ?? go);
    return true;
  }

  return {list, quad, at, find, begin, rotate, setPosition, drawFocus, inspect, label, toLocal, pick, session, turn};
})();
