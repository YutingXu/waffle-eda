"use strict";
// Automatic designator (silkscreen reference) placement.
//
// Model: part.designator = {x, y, angle, height}
//   x, y    centre of the designator text box, in PART coordinates (moves and rotates
//           with the part, like Altium's designator)
//   angle   text angle RELATIVE to the part, degrees (model convention: clockwise on
//           screen, Y-down; Altium angle = -model angle)
//   height  cap height in mm (the Gerber stroke-font size)
// The drawn board angle is readable(part.angle + angle): text never reads upside down.
// On top it reads left-to-right (0) or bottom-to-top (270); on the bottom side the
// text is mirrored and reads 0 or 90 (bottom-to-top when viewed from below).
// part.showRef === false still hides it. Parts without the field keep refAt / imported
// Altium label / default positions; plan() only emits fields for parts it places.
//
//   plan(doc, defs, opts)       -> {moves:[{id, designator}], unplaced:[ref], issues:[...], stats}
//   relayout(doc, defs, ids, o) -> same, for moved/rotated parts plus labels they now hit
//   apply(doc, plan)            -> changed items (mutates; wrap in one undo step)
//   label(part, def)            -> resolved world geometry for drawing / Gerber, or null
//   paint(ctx, part, def, ink)  -> draws a designator on a world-transformed 2D context
//
// The optimiser behind plan() and relayout() is designator-plan.js (AtriumDesignatorPlan),
// loaded on first use and prefetched once a board is open; label() and paint() stay here
// because every board frame draws designators.
globalThis.AtriumDesignators = (() => {
  const A = globalThis.Atrium;
  const DEFAULTS = {height: .8, minHeight: .6, clearance: null, maskExpansion: null, silkGap: null, edgeClearance: .25,
    gap: .12, prefer: "top", orientation: "auto", inside: true, rounds: 3, vias: "soft"};

  // ------------------------------------------------------------ text metrics (Gerber stroke font)
  // fab-outputs.js strokeText: cap height = size, advance = size, glyph 4/6 of the advance,
  // stroke width max(0.1, size/6), descenders reach size/3.
  function metrics(text, height) {
    const n = Array.from(String(text || "")).length, stroke = Math.max(.1, height / 6);
    const desc = /[gjpqy_,;()[\]{}|]/.test(text) ? height / 3 : 0;
    return {w: (n ? (6 * n - 2) / 6 * height : 0) + stroke, h: height + stroke + desc, height, stroke, desc};
  }
  // Nearest readable board angle: top 0 / 270, bottom (mirrored) 0 / 90.
  function readable(angle, bottom) {
    const q = ((Math.round((angle || 0) / 90) % 4) + 4) % 4;
    return q % 2 === 0 ? 0 : bottom ? 90 : 270;
  }
  const isBottom = part => part.layer === "Bottom" || part.side === "Bottom" || part.side === "bottom";
  // AABB of the text box with centre (cx, cy) at a multiple-of-90 board angle.
  function textBox(cx, cy, m, boardAngle) {
    const vertical = (Math.round(boardAngle / 90) & 1) === 1;
    const w = vertical ? m.h : m.w, h = vertical ? m.w : m.h;
    return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
  }

  function labelLayer(part) {
    const d = part.designator;
    if (!d || part.showRef === false || !part.ref || !Number.isFinite(d.x) || !Number.isFinite(d.y)) return null;
    return isBottom(part) ? "Bottom silk" : "Silk";
  }
  /** Resolved designator geometry in board coordinates, or null when the part has none. */
  function label(part, def) {
    const layer = labelLayer(part);
    if (!layer) return null;
    const d = part.designator, height = d.height > 0 ? d.height : DEFAULTS.height, bottom = layer === "Bottom silk";
    const angle = readable((part.angle || 0) + (d.angle || 0), bottom);
    const center = A.world([d.x, d.y], part), m = metrics(part.ref, height);
    // Baseline centre: the anchor for centre-aligned text in canvas.js and fab-outputs.js.
    const anchor = A.world([0, m.h / 2 - m.stroke / 2 - m.desc], {x: center[0], y: center[1], angle});
    return {text: part.ref, center, anchor, angle, height, mirror: bottom, layer,
      stroke: m.stroke, box: textBox(center[0], center[1], m, angle)};
  }
  function textShape(l,part=null) {
    const at=part?A.rotate([l.anchor[0]-part.x,l.anchor[1]-part.y],-(part.angle||0)):l.anchor;
    return {kind:"text",text:l.text,x:at[0],y:at[1],size:l.height,width:l.stroke,angle:l.angle-(part?.angle||0),
      layer:l.layer,mirrored:l.mirror,justify:"bottom-center"};
  }
  // The board and plots use the same cap height, pen, anchor and strokes.
  const FONT = 'ui-monospace, "SFMono-Regular", Menlo, "DejaVu Sans Mono", monospace';
  function paint(ctx, part, def, ink, weight = 600, scale = Infinity) {
    const l = label(part, def);
    if (!l) return null;
    if(globalThis.AtriumPCBText){
      AtriumPCBText.draw(ctx,textShape(l),scale,ink,{lod:0});return l;
    }
    const size = l.height / .72, n = Array.from(l.text).length || 1;
    const sx = ((6 * n - 2) / 6 * l.height) / (n * .6 * size);
    ctx.save();
    ctx.translate(l.anchor[0], l.anchor[1]); ctx.rotate(l.angle * Math.PI / 180);
    ctx.scale(l.mirror ? -sx : sx, 1);
    ctx.font = weight + " " + size + "px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = ink;
    ctx.fillText(l.text, 0, 0);
    ctx.restore();
    return l;
  }

  // plan() and relayout() run the optimiser in designator-plan.js. Before it has loaded,
  // relayout() (designators following a moved part) asks for it and changes nothing.
  const optimiser = () => globalThis.AtriumDesignatorPlan;
  function engineFor(what) {
    const P = optimiser();
    if (P) return P;
    try { globalThis.AtriumLazy?.need?.("AtriumDesignatorPlan").catch(() => {}); } catch { /* no loader */ }
    if (what === "plan") throw Error("Designator placement is still loading. Try again in a moment.");
    return null;
  }
  /**
   * plan(doc, defs, opts) -> {moves:[{id, ref, designator:{x,y,angle,height}}], unplaced:[ref], shrunk:[ref], issues, stats}
   *  opts.ids            parts to place (default: every part with a visible designator)
   *  opts.height         cap height, mm (0.8)          opts.minHeight  retry height for leftovers (0.6; 0 disables)
   *  opts.clearance      silk to solder-mask opening (rules silkToMask, else 0.1)
   *  opts.maskExpansion  override the rules' solder-mask expansion (else rules, 0.1016)
   *  opts.silkGap        designator to designator (rules silkToSilk, else 0.1)
   *  opts.edgeClearance  to the board outline (0.25)
   *  opts.prefer         "top" | "left" | "bottom" | "right"
   *  opts.orientation    "auto" (follow the part) | "horizontal" | "vertical"
   *  opts.inside         allow centred-inside for large parts (true)
   *  opts.vias           "soft" | "hard" | "ignore"
   *  opts.project        project, for project-level rules
   */
  const plan = (doc, defs, opts = {}) => engineFor("plan").run(doc, defs, opts, null);
  /** relayout(doc, defs, ids, opts): after moving/rotating parts. Keeps their managed designators that still fit. */
  const relayout = (doc, defs, ids, opts = {}) => engineFor("relayout")?.run(doc, defs, opts, [...ids]) ||
    {moves: [], unplaced: [], shrunk: [], issues: [], stats: {parts: 0, ms: 0, note: "Designator placement is loading."}};
  function apply(doc, p) {
    const byId = new Map(doc.items.map(i => [i.id, i])), changed = [];
    for (const m of p.moves) {
      const item = byId.get(m.id);
      if (!item || item.kind !== "part") continue;
      item.designator = {...m.designator};
      changed.push(item);
    }
    return changed;
  }
  function placeSelection(doc, defs, {project, selection, edit, info}) {
    const ids = doc.items.filter(item => item.kind === "part" && selection.has(item.id)).map(item => item.id);
    const result = plan(doc, defs, {ids: ids.length ? ids : undefined, project});
    if (result.moves.length) edit(() => apply(doc, result));
    const missing = result.unplaced.length ? " No room for " + result.unplaced.slice(0, 8).join(", ") +
      (result.unplaced.length > 8 ? "…" : "") + ": hide them or keep them on the assembly drawing." : "";
    const count = result.moves.length;
    info(count + " designator" + (count === 1 ? "" : "s") + " placed" +
      (result.shrunk.length ? " (" + result.shrunk.length + " at reduced height)" : "") + " in " + result.stats.ms + " ms." + missing);
  }

  return {plan, relayout, apply, placeSelection, label, labelLayer, textShape, paint, readable, metrics, isBottom, defaults: DEFAULTS};
})();
