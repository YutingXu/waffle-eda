"use strict";
// A recording CanvasRenderingContext2D that writes SVG, so the editor's own
// board and schematic renderer (AtriumCanvas) can draw headlessly. Paths are
// transformed to device coordinates as they are built; arcs become polylines.
// Text keeps its transform so rotated and mirrored labels stay exact.
//
//   const r = AtriumSVGCanvas.create(width, height);
//   AtriumCanvas.create(r.canvas).render(doc, defs, options);
//   r.svg() -> "<svg ...>…</svg>"
globalThis.AtriumSVGCanvas = (() => {
  const TAU = Math.PI * 2;
  const n2 = v => Math.round(v * 100) / 100;
  // XML text and double-quoted attributes; control characters are not allowed in XML 1.0.
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

  // Path2D: a list of commands replayed through the context's transform.
  class RecordedPath {
    constructor(other) { this.ops = other instanceof RecordedPath ? other.ops.slice() : []; }
  }
  for (const name of ["moveTo", "lineTo", "closePath", "rect", "arc", "ellipse", "arcTo", "quadraticCurveTo", "bezierCurveTo", "roundRect"])
    RecordedPath.prototype[name] = function(...args) { this.ops.push([name, args]); };
  if (typeof globalThis.Path2D !== "function") globalThis.Path2D = RecordedPath;

  function create(width, height, background) {
    const out = [], clips = [];
    let path = [], cx = 0, cy = 0, open = false;
    const fresh = () => ({m: [1, 0, 0, 1, 0, 0], fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, lineCap: "butt", lineJoin: "miter",
      globalAlpha: 1, dash: [], lineDashOffset: 0, font: "10px sans-serif", textAlign: "start", textBaseline: "alphabetic", clip: null});
    let s = fresh();
    const stack = [];
    const T = (x, y) => [s.m[0] * x + s.m[2] * y + s.m[4], s.m[1] * x + s.m[3] * y + s.m[5]];
    const scaleOf = () => Math.sqrt(Math.abs(s.m[0] * s.m[3] - s.m[1] * s.m[2])) || 1;
    function move(x, y) { const p = T(x, y); path.push("M" + n2(p[0]) + " " + n2(p[1])); cx = x; cy = y; open = true; }
    function line(x, y) { if (!open) return move(x, y); const p = T(x, y); path.push("L" + n2(p[0]) + " " + n2(p[1])); cx = x; cy = y; }
    function ellipse(x, y, rx, ry, rot, a0, a1, ccw) {
      // Canvas semantics: a sweep of a full turn or more draws the whole ellipse.
      const d = ccw ? a0 - a1 : a1 - a0, turn = d >= TAU ? TAU : (d % TAU + TAU) % TAU, sweep = ccw ? -turn : turn;
      const r = Math.max(rx, ry) * scaleOf(), steps = Math.max(6, Math.min(96, Math.ceil(Math.abs(sweep) * Math.sqrt(Math.max(r, 1)) * 1.2)));
      const c = Math.cos(rot), sn = Math.sin(rot);
      for (let i = 0; i <= steps; i++) {
        const t = a0 + sweep * i / steps, ex = rx * Math.cos(t), ey = ry * Math.sin(t), px = x + ex * c - ey * sn, py = y + ex * sn + ey * c;
        if (i === 0) (open ? line : move)(px, py); else line(px, py);
      }
    }
    const ops = {
      moveTo: move, lineTo: line,
      closePath() { if (open) path.push("Z"); },
      rect(x, y, w, h) { move(x, y); line(x + w, y); line(x + w, y + h); line(x, y + h); path.push("Z"); open = false; },
      roundRect(x, y, w, h, radii = 0) {
        const r = Math.max(0, Math.min(Array.isArray(radii) ? Number(radii[0]) || 0 : typeof radii === "number" ? radii : radii?.x || 0, Math.abs(w) / 2, Math.abs(h) / 2));
        if (!r) return ops.rect(x, y, w, h);
        open = false;
        ellipse(x + w - r, y + r, r, r, 0, -Math.PI / 2, 0, false); ellipse(x + w - r, y + h - r, r, r, 0, 0, Math.PI / 2, false);
        ellipse(x + r, y + h - r, r, r, 0, Math.PI / 2, Math.PI, false); ellipse(x + r, y + r, r, r, 0, Math.PI, Math.PI * 1.5, false);
        path.push("Z"); open = false;
      },
      arc(x, y, r, a0, a1, ccw) { ellipse(x, y, r, r, 0, a0, a1, ccw); },
      ellipse,
      arcTo(x1, y1) { line(x1, y1); },
      quadraticCurveTo(qx, qy, x, y) { if (!open) move(cx, cy); const q = T(qx, qy), p = T(x, y); path.push("Q" + n2(q[0]) + " " + n2(q[1]) + " " + n2(p[0]) + " " + n2(p[1])); cx = x; cy = y; },
      bezierCurveTo(ax, ay, bx, by, x, y) {
        if (!open) move(cx, cy);
        const a = T(ax, ay), b = T(bx, by), p = T(x, y);
        path.push("C" + [a, b, p].map(q => n2(q[0]) + " " + n2(q[1])).join(" ")); cx = x; cy = y;
      }
    };
    function replay(p) {
      const saved = [path, open];
      path = []; open = false;
      for (const [name, args] of p.ops) ops[name](...args);
      const d = path.join("");
      [path, open] = saved;
      return d;
    }
    const alpha = () => s.globalAlpha < 1 ? " opacity=\"" + n2(s.globalAlpha) + "\"" : "";
    const clipAttr = () => s.clip ? " clip-path=\"url(#c" + s.clip + ")\"" : "";
    function emit(d, kind, rule) {
      if (!d) return;
      if (kind === "fill") out.push("<path d=\"" + d + "\" fill=\"" + esc(s.fillStyle) + "\"" + (rule === "evenodd" ? " fill-rule=\"evenodd\"" : "") + alpha() + clipAttr() + "/>");
      else {
        const k = scaleOf(), dash = s.dash.length ? " stroke-dasharray=\"" + s.dash.map(v => n2(v * k)).join(" ") + "\"" : "";
        out.push("<path d=\"" + d + "\" fill=\"none\" stroke=\"" + esc(s.strokeStyle) + "\" stroke-width=\"" + n2(Math.max(0.1, s.lineWidth * k)) + "\"" +
          (s.lineCap !== "butt" ? " stroke-linecap=\"" + s.lineCap + "\"" : "") + (s.lineJoin !== "miter" ? " stroke-linejoin=\"" + s.lineJoin + "\"" : "") + dash + alpha() + clipAttr() + "/>");
      }
    }
    const fontSize = () => Number(/([\d.]+)px/.exec(s.font)?.[1]) || 10;
    function text(t, x, y, kind) {
      const anchor = {center: "middle", right: "end", end: "end"}[s.textAlign] || "start";
      const base = {middle: "central", top: "hanging", hanging: "hanging", bottom: "text-after-edge"}[s.textBaseline] || "alphabetic";
      const family = s.font.replace(/^.*?[\d.]+px\s*/, "") || "sans-serif", weight = /\b(bold|[6-9]00)\b/.test(s.font) ? " font-weight=\"bold\"" : "";
      const paint = kind === "fill" ? " fill=\"" + esc(s.fillStyle) + "\"" : " fill=\"none\" stroke=\"" + esc(s.strokeStyle) + "\" stroke-width=\"" + n2(s.lineWidth) + "\"";
      out.push("<text transform=\"matrix(" + s.m.map(v => Math.round(v * 1e4) / 1e4).join(" ") + ")\" x=\"" + n2(x) + "\" y=\"" + n2(y) + "\" font-size=\"" + n2(fontSize()) +
        "\" font-family=\"" + esc(family) + "\"" + weight + " text-anchor=\"" + anchor + "\" dominant-baseline=\"" + base + "\"" + paint + alpha() + clipAttr() + ">" + esc(t) + "</text>");
    }
    const ctx = {
      get canvas() { return canvas; },
      save() { stack.push({...s, m: s.m.slice(), dash: s.dash.slice()}); },
      restore() { if (stack.length) s = stack.pop(); },
      setTransform(a, b, c, d, e, f) { s.m = typeof a === "object" ? [a.a, a.b, a.c, a.d, a.e, a.f] : [a, b, c, d, e, f]; },
      resetTransform() { s.m = [1, 0, 0, 1, 0, 0]; },
      getTransform() { const [a, b, c, d, e, f] = s.m; return {a, b, c, d, e, f}; },
      transform(a, b, c, d, e, f) {
        const m = s.m;
        s.m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]];
      },
      translate(x, y) { ctx.transform(1, 0, 0, 1, x, y); },
      scale(x, y) { ctx.transform(x, 0, 0, y, 0, 0); },
      rotate(a) { const c = Math.cos(a), sn = Math.sin(a); ctx.transform(c, sn, -sn, c, 0, 0); },
      beginPath() { path = []; open = false; },
      ...ops,
      fill(a, b) { if (a instanceof RecordedPath || a instanceof globalThis.Path2D) emit(replay(a), "fill", b); else emit(path.join(""), "fill", a); },
      stroke(p) { emit(p ? replay(p) : path.join(""), "stroke"); },
      clip(a, b) {
        const d = a && typeof a === "object" ? replay(a) : path.join(""), rule = typeof a === "string" ? a : b;
        clips.push("<clipPath id=\"c" + clips.length + "\"><path d=\"" + d + "\"" + (rule === "evenodd" ? " clip-rule=\"evenodd\"" : "") + "/></clipPath>");
        s.clip = clips.length - 1;
      },
      fillRect(x, y, w, h) { const saved = [path, open]; path = []; ops.rect(x, y, w, h); emit(path.join(""), "fill"); [path, open] = saved; },
      strokeRect(x, y, w, h) { const saved = [path, open]; path = []; ops.rect(x, y, w, h); emit(path.join(""), "stroke"); [path, open] = saved; },
      clearRect() {},
      fillText(t, x, y) { text(t, x, y, "fill"); },
      strokeText(t, x, y) { text(t, x, y, "stroke"); },
      measureText(t) { const size = fontSize(), w = String(t).length * size * 0.56; return {width: w, actualBoundingBoxAscent: size * 0.72, actualBoundingBoxDescent: size * 0.2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: w}; },
      setLineDash(d) { s.dash = Array.isArray(d) ? d.filter(Number.isFinite) : []; },
      getLineDash() { return s.dash.slice(); },
      createLinearGradient() { return {addColorStop() {}}; },
      createRadialGradient() { return {addColorStop() {}}; },
      createPattern() { return null; },
      drawImage() {}, putImageData() {},
      isPointInPath() { return false; }, isPointInStroke() { return false; }
    };
    for (const k of ["fillStyle", "strokeStyle", "lineWidth", "lineCap", "lineJoin", "globalAlpha", "lineDashOffset", "font", "textAlign", "textBaseline"])
      Object.defineProperty(ctx, k, {get: () => s[k], set: v => { if (k === "fillStyle" || k === "strokeStyle") s[k] = typeof v === "string" ? v : "#808080"; else s[k] = v; }});
    for (const k of ["globalCompositeOperation", "imageSmoothingEnabled", "shadowBlur", "shadowColor", "miterLimit", "filter", "direction", "letterSpacing"])
      Object.defineProperty(ctx, k, {get: () => undefined, set: () => {}});
    const canvas = {width, height, style: {}, getContext: () => ctx, getBoundingClientRect: () => ({left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0})};
    return {
      canvas, ctx, get elements() { return out.length; },
      svg() {
        return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + width + "\" height=\"" + height + "\" viewBox=\"0 0 " + width + " " + height + "\">\n" +
          (clips.length ? "<defs>" + clips.join("") + "</defs>\n" : "") +
          (background ? "<rect width=\"100%\" height=\"100%\" fill=\"" + esc(background) + "\"/>\n" : "") + out.join("\n") + "\n</svg>\n";
      }
    };
  }
  return Object.freeze({create, Path2D: RecordedPath});
})();
