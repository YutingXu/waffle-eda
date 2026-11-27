"use strict";

globalThis.AtriumPCBTextInspector = (() => {
  // Inspector: Altium-style String properties.
  // inspector(container, item, apply, units, {layers:[[value, label]], info})
  // apply(fn) must run fn(item) inside an undoable edit.
  const FAMILIES = ["Arial", "Helvetica", "Helvetica Neue", "Verdana", "Tahoma", "Trebuchet MS", "Futura", "Avenir", "Gill Sans", "Segoe UI",
    "DejaVu Sans", "Liberation Sans", "Times New Roman", "Georgia", "Palatino", "Courier New", "Menlo", "Consolas", "sans-serif", "serif", "monospace"];
  const DEFAULT_LAYERS = [["Silk", "Top Overlay"], ["Bottom silk", "Bottom Overlay"], ["Top", "Top Layer"], ["Bottom", "Bottom Layer"],
    ["Top mask", "Top Solder"], ["Bottom mask", "Bottom Solder"], ["Mechanical", "Mechanical 1"]];
  let familyList = null;
  function fill(root, item, apply, units, o) {
    const {props, layoutItem, JUSTIFY} = globalThis.AtriumPCBText;
    const doc = root.ownerDocument || document, U = globalThis.Atrium?.units;
    const unit = U ? U.normal(units) : "mm";
    const el = (tag, text, cls) => AtriumNavCommon.elementIn(doc, tag, text, cls);
    const p = props(item, item.layer);
    const set = fn => apply(fn);
    const show = mm => U ? String(U.value(mm, unit)) : String(+mm.toFixed(4));
    // Property rows (docs/ui-library.md › Property rows): a unit sits inside its field, a check is a switch.
    function row(label, control, unit, tag = "label") {
      const l = el(tag, null, "ui-prop-row");
      if (control.matches("input,select,textarea")) control.classList.add("ui-field");
      l.append(el("span", label), unit ? AtriumNavCommon.measure(control, unit) : control); root.append(l); return control;
    }
    function register(input,path,spec) {
      const h=globalThis.AtriumNavHost;
      globalThis.AtriumLazy?.numericField?.(input,{...spec,target:path && h?.currentId?.() ? {scope:"item",documentId:h.currentId(),itemId:item.id,path} : undefined});
    }
    function length(label, value, update, min = 0, path) {
      const i = el("input"); i.type = "text"; i.inputMode = "decimal"; i.autocomplete = "off"; i.spellcheck = false; i.dataset.unit = unit;
      register(i,path,{unit,storageUnit:"mm",nanometres:true,min,max:1000});
      i.value = show(value); i.setAttribute("aria-label", label + " (" + unit + ")"); i.title = "Value in " + unit + ". Suffixes such as mil, mm or in are accepted.";
      i.onchange = () => {
        const v = U ? U.parse(i.value, unit) : Number(i.value);
        if (!Number.isFinite(v) || v < min || v > 1000) { i.value = show(value); o.info?.("Enter a length of at least " + show(min) + " " + unit + "."); return; }
        set(it => update(it, v));
      };
      return row(label, i, unit);
    }
    /** @param {{min?:number, max?:number, step?:number|string, unit?:string, path?:string[], period?:number, positiveWrap?:boolean, omitZero?:boolean}} [limits] */
    function number(label, value, update, limits = {}) {
      const {min = -Infinity, max = Infinity, step = "any"} = limits;
      const i = el("input"); i.type = "number"; i.step = String(step); i.value = String(value); i.setAttribute("aria-label", label);
      register(i,limits.path,{unit:limits.unit || "",min,max,integer:step===1,
        period:limits.period,positiveWrap:limits.positiveWrap,omitZero:limits.omitZero});
      i.onchange = () => { const v = Number(i.value); if (!i.value || !Number.isFinite(v) || v < min || v > max) { i.value = String(value); return; } set(it => update(it, v)); };
      const m = / \(([^()]{1,4})\)$/.exec(label);
      return m ? row(label.slice(0, m.index), i, limits.unit === "deg" ? "°" : m[1]) : row(label, i);
    }
    function select(label, values, value, update) {
      const s = el("select"); s.setAttribute("aria-label", label);
      for (const [v, t] of values) s.add(new Option(t, v));
      s.value = value; s.onchange = () => set(it => update(it, s.value));
      return row(label, s);
    }
    function check(label, value, update) {
      return AtriumNavCommon.appendSwitchRow(root, label, !!value, on => set(it => update(it, on)));
    }
    // Text (multiline).
    const ta = el("textarea"); ta.rows = Math.min(5, Math.max(1, String(item.text).split("\n").length)); ta.value = item.text ?? "";
    ta.setAttribute("aria-label", "Text"); ta.spellcheck = false;
    ta.onchange = () => { if (!ta.value.trim()) { ta.value = item.text; return; } set(it => { it.text = ta.value; }); };
    ta.onkeydown = e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ta.blur(); } };
    row("Text", ta);
    // Font type.
    const kinds = el("div", null, "pcbtext-segment ui-segmented"); kinds.setAttribute("role", "radiogroup"); kinds.setAttribute("aria-label", "Font type");
    for (const [k, t] of [["stroke", "Stroke"], ["truetype", "TrueType"], ["barcode", "BarCode"]]) {
      const b = el("button", t, "ui-segment"); b.type = "button"; b.dataset.size = "sm";
      b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(p.font === k)); b.tabIndex = p.font === k ? 0 : -1;
      b.onclick = () => { if (p.font !== k) set(it => { if (k === "stroke") delete it.font; else it.font = k;
        if (k === "barcode") { it.barcode = it.barcode || {type: "code128"}; if (!(it.size >= 2)) it.size = 4; } }); };
      kinds.append(b);
    }
    row("Font type", kinds, "", "div");
    if (o.layers !== false) select("Layer", o.layers || DEFAULT_LAYERS.map(([v, t]) => [v, globalThis.AtriumPCBAppearance?.name?.(v) || t]), item.layer || "Silk", (it, v) => { it.layer = v; });
    if (p.font === "stroke") {
      const fonts = [["default", "Default"], ["sans", "Sans Serif"], ["serif", "Serif"], ["kicad", "KiCad Newstroke"]];
      const strokeFont = select("Stroke font", fonts, p.strokeFont, (it, v) => {
        if (v === "default") delete it.strokeFont;
        else it.strokeFont = v;
      });
      strokeFont.querySelector('option[value="kicad"]').setAttribute("translate", "no");
    }
    if (p.font === "truetype") {
      const f = el("input"); f.type = "text"; f.value = p.family; f.setAttribute("aria-label", "Font family"); f.autocomplete = "off";
      const listId = "pcbtext-families"; f.setAttribute("list", listId);
      if (!doc.getElementById(listId)) { const dl = el("datalist"); dl.id = listId; for (const name of familyList || FAMILIES) dl.append(new Option(name, name)); doc.body.append(dl); }
      f.onchange = () => { const v = f.value.trim(); if (!v) { f.value = p.family; return; } set(it => { it.family = v; }); };
      row("Font", f);
      if (typeof globalThis.queryLocalFonts === "function" && !familyList) {
        const more = el("button", "Load system font list", "pcbtext-font-load"); more.type = "button";
        globalThis.AtriumUI?.button(more, "secondary");
        more.onclick = async () => {
          try { const fonts = await globalThis.queryLocalFonts(); familyList = [...new Set(fonts.map(x => x.family))].sort();
            const dl = doc.getElementById(listId); dl.replaceChildren(...familyList.map(n => new Option(n, n))); more.remove(); }
          catch (e) { o.info?.("System fonts are unavailable: " + e.message); }
        };
        root.append(more);
      }
    }
    if (p.font !== "barcode") { check("Bold", p.bold, (it, v) => { if (v) it.bold = true; else delete it.bold; }); check("Italic", p.italic, (it, v) => { if (v) it.italic = true; else delete it.italic; }); }
    length(p.font === "barcode" ? (p.barcode.type === "qr" ? "Size" : "Bar height") : "Text height", p.height, (it, v) => { it.size = v; }, .05,["size"]);
    if (p.font === "stroke" || p.frame) length("Stroke width", p.width, (it, v) => { it.width = v; }, .01,["width"]);
    number("Rotation (°)", +(item.angle || 0).toFixed(3), (it, v) => { it.angle = ((v % 360) + 360) % 360; if (!it.angle) delete it.angle; },{unit:"deg",path:["angle"],period:360,positiveWrap:true,omitZero:true});
    // Justification: 3 x 3 anchor grid.
    const grid = el("div", null, "pcbtext-justify"); grid.setAttribute("role", "radiogroup"); grid.setAttribute("aria-label", "Justification");
    for (const j of JUSTIFY) {
      const b = el("button", null, "ui-choice ui-choice-tinted ui-choice-marker"); b.type = "button"; b.title = j.replace("-", " "); b.setAttribute("aria-label", b.title);
      b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(p.justify === j));
      b.onclick = () => set(it => { it.justify = j; delete it.align; });
      grid.append(b);
    }
    row("Justification", grid, "", "div");
    select("Mirror", [["auto", "Auto (bottom side)"], ["on", "Mirrored"], ["off", "Not mirrored"]], typeof item.mirrored === "boolean" ? (item.mirrored ? "on" : "off") : "auto",
      (it, v) => { if (v === "auto") delete it.mirrored; else it.mirrored = v === "on"; });
    if (String(item.text).includes("\n")) number("Line spacing (×)", +p.lineSpacing.toFixed(3), (it, v) => { it.lineSpacing = v; }, {min: .5, max: 10, step: .05,path:["lineSpacing"]});
    if (p.font === "barcode") {
      const b = p.barcode;
      select("Barcode", [["code128", "Code 128"], ["code39", "Code 39"], ["qr", "QR code"]], b.type, (it, v) => { it.barcode = {...(it.barcode || {}), type: v}; delete it.barcode.module; delete it.barcode.quiet; });
      if (b.type !== "qr") length("Narrow bar", b.module, (it, v) => { it.barcode = {...it.barcode, module: v}; }, .05,["barcode","module"]);
      if (b.type === "code39") number("Wide ratio", b.ratio, (it, v) => { it.barcode = {...it.barcode, ratio: v}; }, {min: 2, max: 3, step: .1,path:["barcode","ratio"]});
      if (b.type === "qr") select("Error correction", [["L", "L (7%)"], ["M", "M (15%)"], ["Q", "Q (25%)"], ["H", "H (30%)"]], b.ecc, (it, v) => { it.barcode = {...it.barcode, ecc: v}; });
      number("Quiet zone (modules)", b.quiet, (it, v) => { it.barcode = {...it.barcode, quiet: v}; }, {min: 0, max: 40, step: 1,path:["barcode","quiet"]});
      if (b.type !== "qr") check("Show text", b.text, (it, v) => { it.barcode = {...it.barcode, text: v}; });
    }
    check("Inverted", p.inverted, (it, v) => { if (v) it.inverted = true; else delete it.inverted; });
    if (!p.inverted) check("Frame", p.frame, (it, v) => { if (v) it.frame = true; else delete it.frame; });
    if (p.inverted || p.frame) length(p.inverted ? "Inverted margin" : "Frame margin", p.margin, (it, v) => { it.margin = v; }, 0,["margin"]);
    // Summary and warnings.
    try {
      const l = layoutItem(item, item.layer), notes = [];
      notes.push(l.strokes.length + " strokes · " + l.polygons.length + " regions · " + l.vertices + " vertices");
      if (l.unsupported) notes.push(l.unsupported + " character" + (l.unsupported === 1 ? " is" : "s are") + " not in the stroke font and plot as \"?\".");
      if (l.fallback) notes.push(l.fallback);
      if (p.font === "stroke" && p.width < .1) notes.push("Stroke width is below 0.1 mm; check the fabricator's minimum silkscreen line.");
      if (p.font !== "barcode" && p.height < .6) notes.push("Text height is below 0.6 mm and may not be legible.");
      for (const n of notes) root.append(el("p", n, "side-note pcbtext-note"));
    } catch (e) { root.append(el("p", e.message, "side-note pcbtext-note")); }
  }

  return {fill};
})();
