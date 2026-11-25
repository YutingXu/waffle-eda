"use strict";

// PDF and SVG consume the same positioned glyphs and rule rectangles as the notebook canvas.
// This bridge loads with the maths feature. Only a PDF containing glyphs parses its font for embedding.
globalThis.AtriumMathPDF = (() => {
  const num = v => Number(v.toFixed(6));
  const matrix = m => m.map(num).join(" ");
  let parsed;
  function font() {
    if (!parsed) parsed = AtriumPDFFonts.parse(AtriumMathFont.bytes());
    return parsed;
  }

  // A shaped glyph can denote different source clusters in the same document (a ligature,
  // a styled alternate, or an assembly piece). Give each (GID, semantic text) its own CID.
  function resource() {
    const byGlyph = new Map(), unicode = new Map(), glyphs = [0];
    function cid(gid, text) {
      let variants = byGlyph.get(gid);
      if (!variants) byGlyph.set(gid, variants = new Map());
      if (variants.has(text)) return variants.get(text);
      const id = glyphs.length;
      if (id > 65535) throw Error("The mathematics in this PDF exceeds one font’s character limit.");
      glyphs.push(gid); unicode.set(id,text); variants.set(text,id);
      return id;
    }
    return {unicode, glyphs, cid};
  }

  function content(op, res, out, utf16) {
    // ActualText gives screen readers and copy/search the logical expression order across
    // fractions, indices, matrices and extensible delimiters. The visible ink is real text.
    const result = res.math ||= resource();
    out.push("q " + matrix(op.m) + " cm");
    if (!op.actualText) out.push("/Span << /ActualText " + utf16(op.layout.plain) + " >> BDC");
    for (const c of op.layout.commands) {
      if (c.kind === "glyph") {
        res.font.add("M");
        const code = result.cid(c.gid,c.text || "").toString(16).padStart(4,"0");
        const z = num(c.scale);
        out.push("BT /M 1 Tf 0 Tr " + [z,0,0,-z,num(c.x),num(c.y)].join(" ") + " Tm <" + code + "> Tj ET");
      } else if (c.kind === "rule") {
        out.push([c.x,c.y,c.w,c.h].map(num).join(" ") + " re f");
      }
    }
    if (!op.actualText) out.push("EMC");
    out.push("Q");
  }

  function svg(op, defs, seen, fill, alpha, escape) {
    const shapes = AtriumMathFont.svgShapes(op.layout, gid => {
      const id = "math-g" + gid;
      if (!seen.has(gid)) {
        seen.add(gid);
        defs.push('<path id="' + id + '" d="' + AtriumMathFont.path(gid) + '"/>');
      }
      return id;
    });
    return '<g transform="matrix(' + matrix(op.m) + ')" fill="' + fill + '"' + alpha +
      ' role="img" aria-label="' + escape(op.layout.plain) + '"><title>' + escape(op.layout.plain) + '</title>' + shapes + '</g>';
  }
  return Object.freeze({content,svg,font});
})();
