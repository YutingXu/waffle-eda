"use strict";

// Draw the approved equation layout and a projected result. The PDF recorder supports the
// same glyph/rule stream as Canvas. This module only reads the supplied projection.
globalThis.AtriumCalculationDisplay = (() => {
  const layouts = new WeakMap();
  let mathLoad;
  const escaped = s => String(s).replace(/[\\{}$&%#]/g, c => "\\" + c);
  function mathSource(source) {
    const parsed = globalThis.AtriumCalculationCore?.parse(source);
    if (!parsed?.ok) return null;
    const literal = n => escaped(source.slice(n.span[0],n.span[1]));
    function render(n) {
      if (n.type === "group") return "(" + render(n.child) + ")";
      if (n.type === "unary") return n.op + render(n.arg);
      if (n.type === "binary") {
        const a = render(n.left), b = render(n.right);
        if (n.op === "/") return "\\frac{" + a + "}{" + b + "}";
        if (n.op === "^") return "{" + a + "}^{" + b + "}";
        const op = {"*":"\\cdot ", "||":"\\parallel ","<=":"\\le ",">=":"\\ge "}[n.op] || n.op;
        return a + op + b;
      }
      if (n.type === "call" && n.id === "sqrt" && n.args.length === 1) return "\\sqrt{" + render(n.args[0]) + "}";
      return literal(n);
    }
    return (parsed.name ? escaped(parsed.name)+"=" : parsed.asserted ? "\\mathrm{assert}\\;" : "") + render(parsed.ast);
  }
  function layout(item, source) {
    const math = globalThis.AtriumMath;
    if (!math) return null;
    const key = layouts.get(item);
    if (key?.source === source) return key.value;
    const tex = mathSource(source), shaped = tex && math.layout(tex,{display:true});
    // PDF selection uses the authored expression even when the same glyph layout
    // displays an operator as a fraction rule, radical or superscript.
    const value = shaped && {...shaped,plain:source};
    layouts.set(item,{source,value});
    return value;
  }
  function draw(ctx, item, evaluated, o = {}) {
    const loader = globalThis.AtriumLazy;
    if (!globalThis.AtriumMath && !o.frozen && !o.calculationRecords && !mathLoad && loader?.modules().includes("AtriumMath")) {
      mathLoad = loader.need("AtriumMath").then(() => globalThis.AtriumNavHost?.redraw?.(),() => {});
    }
    const r = globalThis.AtriumCalculationRecords, record = r.read(item), info = r.summary(record,evaluated);
    const {x,y,w,h} = item, pen = o.ink || "#23354a", secondary = o.muted || "#495c71", accent = o.accent || "#19685c";
    ctx.save(); ctx.beginPath(); ctx.rect(x,y,w,h); ctx.clip();
    ctx.fillStyle = o.paper || (o.purpose === "print" ? "#ffffff" : globalThis.AtriumSchAppearance?.paper || "#ffffff");
    ctx.fillRect(x,y,w,h);
    ctx.strokeStyle = o.selected ? o.select : secondary; ctx.lineWidth = o.selected ? .42 : .16; ctx.strokeRect(x,y,w,h);
    const left = x+1.8, l = layout(item,record.source);
    let baseline = y+3.9, row;
    ctx.fillStyle = pen; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    if (l && !l.errors.length && l.advance > 0 && (ctx.drawMath || typeof Path2D !== "undefined")) {
      const size = Math.max(.1,Math.min(2.4,(w-3.6)/l.advance,6/(l.ascent+l.descent || 1)));
      baseline = y + 1.2 + l.ascent*size;
      globalThis.AtriumMath.draw(ctx,l,{x:left,y:baseline,size,ink:pen});
      row = baseline+l.descent*size+3.6;
    } else {
      ctx.font = "2.3px serif"; ctx.fillText(record.source,left,baseline); row = baseline+4;
    }
    ctx.fillStyle = accent; ctx.font = "bold 2.65px sans-serif"; ctx.fillText(info.value,left,row);
    ctx.font = "1.85px sans-serif"; ctx.fillStyle = secondary; row += 3.4;
    for (const msg of [...info.warnings,...info.states.map(a => a.label + " · " + a.source)]) {
      if (row > y+h-.35) break;
      ctx.fillText(msg,left,row); row += 2.8;
    }
    ctx.restore();
  }
  return Object.freeze({draw,mathSource});
})();
