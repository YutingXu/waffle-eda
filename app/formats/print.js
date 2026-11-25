"use strict";
// Printing and PDF output (File → Print… Mod+P, File → Export PDF…).
// Every page is drawn by the editor's own renderer (AtriumCanvas) into
// AtriumPDF's recording context, so print matches the screen. Schematic sheets
// keep their sheet template and title block (filled from parameters); boards
// print as layer sets, one per page, plus assembly (fab-outputs) and drill
// drawings. Smart PDF: parts link between schematic and board, sheet symbols
// and ports link to their sheets, and bookmarks list sheets, parts and nets.
//
//   AtriumPrint.build(project, options) -> {pages, notes, bytes()}
//   AtriumPrint.prepareDocument(project, options, providers, consume)
//   AtriumPrint.exportPDF(project, options) -> Uint8Array   (= AtriumPDF.export)
//   AtriumPrint.open(ctx, {mode: "print" | "pdf"})          dialog
//   AtriumPrint.output({pages, bytes()}, name)               the one print path (also print-report.js)
globalThis.AtriumPrint = (() => {
  const PDF = globalThis.AtriumPDF, MM = 72 / 25.4, R = 4;
  const A = () => globalThis.Atrium, PCB = () => globalThis.AtriumPCBAppearance, SCH = () => globalThis.AtriumSchAppearance;
  // Portrait width × height in mm.
  const PAPER = {A4: [210, 297], A3: [297, 420], A2: [420, 594], Letter: [215.9, 279.4], Legal: [215.9, 355.6], Tabloid: [279.4, 431.8],
    "ANSI B": [279.4, 431.8], "ANSI C": [431.8, 558.8], "ANSI D": [558.8, 863.6]};
  const LAYER_SETS = [
    {id: "top", name: "Top layer, overlay and outline", layers: ["Top", "Silk", "Multi", "Mechanical", "Mechanical 1"]},
    {id: "bottom", name: "Bottom layer and overlay (mirrored)", layers: ["Bottom", "Bottom silk", "Multi", "Mechanical", "Mechanical 1"], flip: true, active: "Bottom"},
    {id: "inner", name: "Inner layers (one page each)", inner: true},
    {id: "composite", name: "Composite (all visible layers)", composite: true},
    {id: "silk-top", name: "Top overlay", layers: ["Silk", "Mechanical 1"], active: "Silk"},
    {id: "silk-bottom", name: "Bottom overlay (mirrored)", layers: ["Bottom silk", "Mechanical 1"], flip: true, active: "Bottom silk"},
    {id: "mask-top", name: "Top solder mask", layers: ["Top mask", "Mechanical 1"], active: "Top mask"},
    {id: "assembly-top", name: "Assembly drawing, top", assembly: "Top"},
    {id: "assembly-bottom", name: "Assembly drawing, bottom (mirrored)", assembly: "Bottom"},
    {id: "drill", name: "Drill drawing and table", drill: true}
  ];
  const SET = new Map(LAYER_SETS.map(s => [s.id, s]));
  const DEFAULTS = {paper: "A4", orientation: "auto", scale: "fit", margin: 10, color: "color", whiteBackground: true,
    layerSets: ["top", "bottom", "assembly-top", "drill"], links: true, bookmarks: true, viewerLayers:true, searchable:true, footer: true, parameters: {}};
  const INFINITE_LAYOUTS = [["fit", "Fit whole drawing on one page"], ["frames", "One page per frame"], ["tile", "Tile at chosen scale"]];
  const notebookEnabled = () => globalThis.AtriumLabs?.notebookEnabled() !== false;
  function settle(o = {}) {
    const s = {...DEFAULTS, ...o};
    s.recordLinks = o.recordLinks === true || globalThis.AtriumPrefs?.get("butter.links") === true;
    if (!notebookEnabled()) Object.assign(s,{viewerLayers:false, properties:false, searchable:false, attachments:false,
      includeProject:false, projectArchive:null, notebook:null, widgetViews:null, calculationRecords:null});
    if (!Array.isArray(s.paper) && !PAPER[s.paper]) throw Error("Unknown paper size " + s.paper + ".");
    if (Array.isArray(s.paper) && !(s.paper.length === 2 && s.paper.every(v => v >= 20 && v <= 5000))) throw Error("Paper size must be [width, height] in mm.");
    if (!["auto", "landscape", "portrait"].includes(s.orientation)) s.orientation = "auto";
    if (s.scale !== "fit" && !(+s.scale > 0 && +s.scale <= 100)) throw Error("Scale must be \"fit\" or a positive ratio (1 = 1:1).");
    if (s.scale !== "fit") s.scale = +s.scale;
    s.infiniteLayout = INFINITE_LAYOUTS.some(([key]) => key === s.infiniteLayout) ? s.infiniteLayout : "fit";
    s.infiniteScale = Number.isFinite(+s.infiniteScale) && +s.infiniteScale > 0 ? +s.infiniteScale : 1;
    s.tile = s.tile !== false;
    s.margin = Math.max(0, Math.min(50, +s.margin || 0));
    if (!["color", "grey", "mono"].includes(s.color)) s.color = "color";
    s.layerSets = (Array.isArray(s.layerSets) ? s.layerSets : DEFAULTS.layerSets).filter(id => SET.has(id));
    return s;
  }

  // ------------------------------------------------------------ recording context
  // A CanvasRenderingContext2D that records device-space display lists, so
  // AtriumCanvas renders print pages unmodified. Arcs become bounded-error cubic Béziers.
  const TAU = Math.PI * 2, {rgba, fontOf, runs, NAMES, NARGS, radius} = PDF, REC = PDF.paths, G = PDF.glyph.scale;
  const N = v => String(Math.round(v * 100) / 100);
  const FIELDS = ["fillStyle", "strokeStyle", "lineWidth", "lineCap", "lineJoin", "globalAlpha", "lineDashOffset", "font", "textAlign", "textBaseline", "miterLimit"];
  const images = new WeakMap();
  function recorder(width, height, opt = {}) {
    const k0 = opt.unit || 1, ink = opt.ink || (c => c), list = [];
    let layer = null;
    const record = op => { if (layer) op.layer = layer; list.push(op); };
    const textSpans = [];
    let path = [], open = false, cx = 0, cy = 0, sx = 0, sy = 0;
    const fresh = () => ({m: [1, 0, 0, 1, 0, 0], fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, lineCap: "butt", lineJoin: "miter", globalAlpha: 1,
      dash: [], lineDashOffset: 0, font: "10px sans-serif", textAlign: "start", textBaseline: "alphabetic", miterLimit: 10, clip: null});
    let s = fresh();
    const stack = [];
    const T = (x, y) => { const m = s.m; return [k0 * (m[0] * x + m[2] * y + m[4]), k0 * (m[1] * x + m[3] * y + m[5])]; };
    const scaleOf = () => k0 * (Math.sqrt(Math.abs(s.m[0] * s.m[3] - s.m[1] * s.m[2])) || 1);
    function move(x, y) { const p = T(x, y); path.push(0, p[0], p[1]); cx = sx = x; cy = sy = y; open = true; }
    function line(x, y) { if (!open) return move(x, y); const p = T(x, y); path.push(1, p[0], p[1]); cx = x; cy = y; }
    function curve(ax, ay, bx, by, x, y) {
      if (!open) move(ax, ay);
      path.push(2, ...T(ax, ay), ...T(bx, by), ...T(x, y)); cx = x; cy = y;
    }
    function close() { if (open) { path.push(3); cx = sx; cy = sy; } }
    function quad(qx, qy, x, y) { if (!open) move(qx, qy); curve(cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy), x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y); }
    function ellipse(x, y, rx, ry, rot, a0, a1, ccw) {
      if (!(rx >= 0 && ry >= 0) || ![x,y,rx,ry,rot,a0,a1].every(Number.isFinite)) return;
      let d = ccw ? a0 - a1 : a1 - a0;
      d = d >= TAU ? TAU : (d % TAU + TAU) % TAU;
      const sweep = ccw ? -d : d, c = Math.cos(rot), sn = Math.sin(rot);
      const pt = t => [x + rx * Math.cos(t) * c - ry * Math.sin(t) * sn, y + rx * Math.cos(t) * sn + ry * Math.sin(t) * c];
      const der = t => [-rx * Math.sin(t) * c - ry * Math.cos(t) * sn, -rx * Math.sin(t) * sn + ry * Math.cos(t) * c];
      const p0 = pt(a0); (open ? line : move)(p0[0], p0[1]);
      if (sweep === 0) return;
      let n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-12));
      // The tangent cubic's maximum squared radial excess is (4/27) sin⁶(a/4)/cos²(a/4).
      // Half of that bounds the radial error, scaled by the larger radius (PCB units: mm).
      const r = Math.max(rx, ry);
      while (n < 4096) { // Bounds recorder work even for coordinates outside the project format's range.
        const q = Math.abs(sweep) / (4 * n);
        if (r * (2 / 27) * Math.sin(q) ** 6 / Math.cos(q) ** 2 <= .005) break;
        n *= 2;
      }
      const step = sweep / n, kk = 4 / 3 * Math.tan(step / 4);
      for (let i = 0; i < n; i++) {
        const t0 = a0 + step * i, t1 = t0 + step, P0 = pt(t0), D0 = der(t0), P1 = pt(t1), D1 = der(t1);
        curve(P0[0] + kk * D0[0], P0[1] + kk * D0[1], P1[0] - kk * D1[0], P1[1] - kk * D1[1], P1[0], P1[1]);
      }
    }
    function rect(x, y, w, h) { move(x, y); line(x + w, y); line(x + w, y + h); line(x, y + h); close(); }
    function roundRect(x, y, w, h, r) {
      r = Math.min(Math.abs(radius(r)), Math.abs(w) / 2, Math.abs(h) / 2);
      if (!r) return rect(x, y, w, h);
      const H = Math.PI / 2;
      move(x + r, y); ellipse(x + w - r, y + r, r, r, 0, -H, 0); ellipse(x + w - r, y + h - r, r, r, 0, 0, H);
      ellipse(x + r, y + h - r, r, r, 0, H, 2 * H); ellipse(x + r, y + r, r, r, 0, 2 * H, 3 * H); close();
    }
    function arcTo(x1, y1, x2, y2, r) {
      if (!open) return move(x1, y1);
      const ax = cx - x1, ay = cy - y1, bx = x2 - x1, by = y2 - y1, la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      const cross = ax * by - ay * bx;
      if (!r || !la || !lb || Math.abs(cross) < 1e-12 * la * lb) return line(x1, y1);
      const ux = ax / la, uy = ay / la, vx = bx / lb, vy = by / lb, angle = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
      const t = r / Math.tan(angle / 2), bis = Math.hypot(ux + vx, uy + vy), h = r / Math.sin(angle / 2);
      const ox = x1 + (ux + vx) / bis * h, oy = y1 + (uy + vy) / bis * h, t1 = [x1 + ux * t, y1 + uy * t], t2 = [x1 + vx * t, y1 + vy * t];
      const a0 = Math.atan2(t1[1] - oy, t1[0] - ox), a1 = Math.atan2(t2[1] - oy, t2[0] - ox);
      line(t1[0], t1[1]); ellipse(ox, oy, r, r, 0, a0, a1, cross > 0);
    }
    const FN = [move, line, curve, close, quad, (x, y, r, a0, a1, ccw) => ellipse(x, y, r, r, 0, a0, a1, ccw), ellipse, rect, roundRect, arcTo];
    function replay(p) {
      const saved = [path, open, cx, cy, sx, sy];
      path = []; open = false;
      const o = REC.get(p);
      if (o) for (let i = 0; i < o.length;) { const k = o[i++]; FN[k](...o.slice(i, i += NARGS[k])); }
      else if (Array.isArray(p?.ops)) for (const [name, args] of p.ops) { const k = NAMES.indexOf(name); if (k >= 0) FN[k](...args); }
      const d = path;
      [path, open, cx, cy, sx, sy] = saved;
      return d;
    }
    const isPath = a => a && typeof a === "object";
    function emit(d, kind, rule) {
      if (!d.length) return;
      const c = ink(rgba(kind === "fill" ? s.fillStyle : s.strokeStyle), kind), a = c[3] * s.globalAlpha;
      if (a <= .003) return;
      const op = {k: "p", d: d.slice(), c, a, clip: s.clip};
      if (kind === "fill") { op.fill = 1; if (rule === "evenodd") op.eo = 1; }
      else {
        const k = scaleOf();
        op.w = Math.max(.05, s.lineWidth * k); op.cap = s.lineCap; op.join = s.lineJoin;
        if (s.dash.length) { op.dash = s.dash.map(v => v * k); op.off = s.lineDashOffset * k; }
      }
      record(op);
    }
    function text(str, x, y, maxW, stroke) {
      str = String(str ?? ""); if (!str || !Number.isFinite(x) || !Number.isFinite(y)) return;
      const f = fontOf(s.font), r = runs(str, f.key);
      let w = r.width * f.size, kx = 1;
      if (maxW !== undefined) { if (!(maxW > 0)) return; if (w > maxW) { kx = maxW / w; w = maxW; } }
      const al = s.textAlign, dx = al === "center" ? -w / 2 : al === "right" || al === "end" ? -w : 0;
      const dy = {top: .8, hanging: .72, middle: .32, bottom: -.22, ideographic: -.22}[s.textBaseline] * f.size || 0;
      const m = s.m, X = x + dx, Y = y + dy, z = f.size;
      const M = [k0 * m[0] * kx * z, k0 * m[1] * kx * z, -k0 * m[2] * z, -k0 * m[3] * z, k0 * (m[0] * X + m[2] * Y + m[4]), k0 * (m[1] * X + m[3] * Y + m[5])];
      if (f.synthItalic) { M[2]+=M[0]*.21256; M[3]+=M[1]*.21256; }
      const c = ink(rgba(stroke ? s.strokeStyle : s.fillStyle), stroke ? "stroke" : "fill"), a = c[3] * s.globalAlpha;
      if (a <= .003) return;
      const at = (u, v) => [M[0] * u + M[2] * v + M[4], M[1] * u + M[3] * v + M[5]], em = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]));
      for (const run of r.runs) {
        if (run.glyph) {
          const d = [];
          for (const pl of run.glyph) pl.forEach((q, i) => d.push(i ? 1 : 0, ...at(run.x + .04 + q[0] * G, q[1] * G)));
          if (d.length) record({k: "p", d, c, a, w: Math.max(.1, em * .085), cap: "round", join: "round", clip: s.clip});
          continue;
        }
        const p = at(run.x, 0);
        record({k: "t", f: run.f || f.key, s: run.s, u: run.u, ...(run.g ? {g: run.g} : {}), ...(f.synthBold ? {synthBold:true} : {}), m: [M[0], M[1], M[2], M[3], p[0], p[1]], c, a, sw: stroke ? Math.max(.05, s.lineWidth * scaleOf()) : 0, clip: s.clip});
      }
    }
    function image(img, ...a) {
      let [dx, dy, dw, dh] = a.length >= 8 ? a.slice(4) : a;
      const iw = img?.naturalWidth || img?.width || 0, ih = img?.naturalHeight || img?.height || 0;
      if (!iw || !ih) return;
      if (dw === undefined) { dw = iw; dh = ih; }
      let clip = s.clip;
      if (a.length === 8) {
        let [sx, sy, sw, sh] = a;
        if (sw < 0) { sx+=sw; sw=-sw; } if (sh < 0) { sy+=sh; sh=-sh; }
        if (dw < 0) { dx+=dw; dw=-dw; } if (dh < 0) { dy+=dh; dh=-dh; }
        if (!(sw && sh && dw && dh)) return;
        clip={d:[0,...T(dx,dy),1,...T(dx+dw,dy),1,...T(dx+dw,dy+dh),1,...T(dx,dy+dh),3],parent:clip};
        const ax=dw/sw, ay=dh/sh; dx-=sx*ax; dy-=sy*ay; dw=iw*ax; dh=ih*ay;
      }
      let data = images.get(img);
      if (!data) {
        data = img.rgb instanceof Uint8Array && img.rgb.length === iw*ih*3 &&
          (!img.alpha || img.alpha instanceof Uint8Array && img.alpha.length === iw*ih) ? {w:iw,h:ih,rgb:img.rgb,alpha:img.alpha} : null;
        try {
          const src = typeof img.src === "string" ? img.src : "", jpeg = /^data:image\/jpe?g;base64,/i.exec(src);
          if (jpeg) data = {w: iw, h: ih, jpeg: Uint8Array.from(atob(src.slice(jpeg[0].length)), ch => ch.charCodeAt(0)), src};
          else if (!data) {
            let px=globalThis.AtriumNotebookImages?.pixelsOf?.(img)?.rgba, cv;
            if (!px && globalThis.document) {
              cv=document.createElement("canvas"); cv.width=iw; cv.height=ih;
              const c2=cv.getContext("2d"); c2.drawImage(img,0,0); px=c2.getImageData(0,0,iw,ih).data;
            }
            if (!px || px.length!==iw*ih*4) return;
            const rgb = new Uint8Array(iw * ih * 3), al = new Uint8Array(iw * ih);
            let opaque = true;
            for (let i = 0, j = 0; i < al.length; i++) { rgb[j++] = px[i * 4]; rgb[j++] = px[i * 4 + 1]; rgb[j++] = px[i * 4 + 2]; al[i] = px[i * 4 + 3]; if (al[i] < 255) opaque = false; }
            data = {w: iw, h: ih, rgb, alpha: opaque ? null : al, src: src || cv?.toDataURL()};
          }
        } catch { data = null; }
        if (img && typeof img === "object") images.set(img, data);
      }
      if (!data) return;
      const m = s.m;
      const M = [k0 * m[0] * dw, k0 * m[1] * dw, -k0 * m[2] * dh, -k0 * m[3] * dh, k0 * (m[0] * dx + m[2] * (dy + dh) + m[4]), k0 * (m[1] * dx + m[3] * (dy + dh) + m[5])];
      record({k: "i", img: data, m: M, a: s.globalAlpha, clip});
    }
    const tmp = fn => { const saved = [path, open]; path = []; open = false; fn(); const d = path; [path, open] = saved; return d; };
    const ctx = {
      get canvas() { return canvas; },
      withLayer(next, draw) {
        const prior = layer, start = list.length;
        layer = next;
        try { return draw(); }
        finally {
          for (let i = start; i < list.length; i++) if (list[i].layer === undefined) list[i] = {...list[i], layer: next};
          layer = prior;
        }
      },
      save() { stack.push({...s, m: s.m.slice(), dash: s.dash.slice()}); },
      restore() { if (stack.length) s = stack.pop(); },
      setTransform(a, b, c, d, e, f) { s.m = typeof a === "object" && a ? [a.a, a.b, a.c, a.d, a.e, a.f] : a === undefined ? [1, 0, 0, 1, 0, 0] : [a, b, c, d, e, f]; },
      resetTransform() { s.m = [1, 0, 0, 1, 0, 0]; },
      getTransform() { const [a, b, c, d, e, f] = s.m; return {a, b, c, d, e, f, is2D: true}; },
      transform(a, b, c, d, e, f) {
        const m = s.m;
        s.m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]];
      },
      translate(x, y) { ctx.transform(1, 0, 0, 1, x, y); },
      scale(x, y) { ctx.transform(x, 0, 0, y, 0, 0); },
      rotate(a) { const c = Math.cos(a), n = Math.sin(a); ctx.transform(c, n, -n, c, 0, 0); },
      beginPath() { path = []; open = false; },
      moveTo: move, lineTo: line, bezierCurveTo: curve, closePath: close, quadraticCurveTo: quad, ellipse, rect, roundRect, arcTo,
      arc(x, y, r, a0, a1, ccw) { ellipse(x, y, r, r, 0, a0, a1, ccw); },
      fill(a, b) { if (isPath(a)) emit(replay(a), "fill", b); else emit(path, "fill", a); },
      stroke(p) { emit(isPath(p) ? replay(p) : path, "stroke"); },
      clip(a, b) {
        const d = isPath(a) ? replay(a) : path.slice(), rule = isPath(a) ? b : a;
        s.clip = {d, eo: rule === "evenodd", parent: s.clip};
      },
      fillRect(x, y, w, h) { emit(tmp(() => rect(x, y, w, h)), "fill"); },
      strokeRect(x, y, w, h) { emit(tmp(() => rect(x, y, w, h)), "stroke"); },
      clearRect() {},
      beginActualText(text) { textSpans.push({text:String(text),start:list.length}); },
      endActualText() {
        const span=textSpans.pop();
        if (span && !textSpans.length) for (let i=span.start;i<list.length;i++) list[i].actualText=span;
      },
      drawMath(layout, x, y, size) {
        if (!(size > 0) || !layout.commands.length) return;
        const c = ink(rgba(s.fillStyle), "fill"), a = c[3] * s.globalAlpha;
        if (a <= .003) return;
        const m = s.m, em = size * k0;
        record({k:"math",layout,m:[m[0]*em,m[1]*em,m[2]*em,m[3]*em,...T(x,y)],c,a,clip:s.clip});
      },
      fillText(t, x, y, w) { text(t, x, y, w, false); },
      strokeText(t, x, y, w) { text(t, x, y, w, true); },
      measureText(t) {
        const f = fontOf(s.font), w = runs(t, f.key).width * f.size;
        return {width: w, actualBoundingBoxAscent: f.size * .72, actualBoundingBoxDescent: f.size * .21, actualBoundingBoxLeft: 0, actualBoundingBoxRight: w,
          fontBoundingBoxAscent: f.size * .9, fontBoundingBoxDescent: f.size * .21};
      },
      setLineDash(d) { s.dash = Array.isArray(d) && d.every(v => Number.isFinite(v) && v >= 0) ? (d.length % 2 ? [...d, ...d] : d.slice()) : s.dash; },
      getLineDash() { return s.dash.slice(); },
      createLinearGradient() { return {addColorStop() {}}; },
      createRadialGradient() { return {addColorStop() {}}; },
      createPattern() { return null; },
      drawImage: image, putImageData() {}, getImageData: (x, y, w, h) => ({width: w, height: h, data: new Uint8ClampedArray(w * h * 4)}),
      isPointInPath() { return false; }, isPointInStroke() { return false; }
    };
    for (const k of FIELDS) Object.defineProperty(ctx, k, {get: () => s[k], set: v => {
      if (k === "lineWidth" || k === "miterLimit") { if (v > 0 && Number.isFinite(+v)) s[k] = +v; }
      else if (k === "globalAlpha") { if (v >= 0 && v <= 1) s[k] = +v; }
      else if (k === "fillStyle" || k === "strokeStyle") s[k] = typeof v === "string" ? v : "#808080";
      else s[k] = v;
    }});
    for (const k of ["globalCompositeOperation", "imageSmoothingEnabled", "shadowBlur", "shadowColor", "shadowOffsetX", "shadowOffsetY", "filter", "direction", "letterSpacing", "fontKerning"])
      Object.defineProperty(ctx, k, {get: () => undefined, set: () => {}});
    const rectOf = () => ({left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0});
    const canvas = {width, height, style: {}, clientWidth: width, clientHeight: height, getContext: () => ctx, getBoundingClientRect: rectOf};
    return {canvas, ctx, list, setLayer(next) { layer=next; }, get elements() { return list.length; }};
  }

  // ------------------------------------------------------------ SVG (preview, browser print)
  const FAMILY = {H: "Helvetica,Arial,sans-serif", T: "'Times New Roman',Times,serif", C: "'Courier New',Courier,monospace", U: "'DejaVu Sans',Verdana,Helvetica,Arial,sans-serif"};
  // XML text and double-quoted attributes; control characters are not allowed in XML 1.0.
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  const css = c => "rgb(" + c.slice(0, 3).map(v => Math.round(v * 255)).join(",") + ")";
  function svgPath(d) {
    let s = "";
    for (let i = 0; i < d.length;) {
      const k = d[i++];
      if (k === 3) { s += "Z"; continue; }
      const n = k === 2 ? 6 : 2;
      s += "MLC"[k] + d.slice(i, i += n).map(N).join(" ");
    }
    return s;
  }
  function svg(w, h, list, o = {}) {
    const defs = [], body = [], ids = new Map(), mathGlyphs = new Set(), faces = new Map();
    let clip = null, depth = 0;
    const clipId = c => {
      if (!ids.has(c)) { const id = "c" + ids.size; ids.set(c, id); defs.push("<clipPath id=\"" + id + "\"><path d=\"" + svgPath(c.d) + "\"" + (c.eo ? " clip-rule=\"evenodd\"" : "") + "/></clipPath>"); }
      return ids.get(c);
    };
    for (const op of list) {
      if (op.clip !== clip) {
        body.push("</g>".repeat(depth)); depth = 0;
        const nodes = []; for (let c = op.clip; c; c = c.parent) nodes.unshift(c);
        for (const c of nodes) { body.push("<g clip-path=\"url(#" + clipId(c) + ")\">"); depth++; }
        clip = op.clip;
      }
      const alpha = op.a < 1 ? " opacity=\"" + N(op.a) + "\"" : "";
      if (op.k === "i") { body.push("<image href=\"" + esc(op.img.src || "") + "\" width=\"1\" height=\"1\" preserveAspectRatio=\"none\" transform=\"matrix(" + [op.m[0], op.m[1], -op.m[2], -op.m[3], op.m[2] + op.m[4], op.m[3] + op.m[5]].map(v => Math.round(v * 1e4) / 1e4).join(" ") + ")\"" + alpha + "/>"); continue; }
      if (op.k === "math") { body.push(AtriumMathPDF.svg(op,defs,mathGlyphs,css(op.c),alpha,esc)); continue; }
      if (op.k === "t") {
        const m = [op.m[0] / 100, op.m[1] / 100, -op.m[2] / 100, -op.m[3] / 100, op.m[4], op.m[5]].map(v => +v.toFixed(5));
        const face=globalThis.AtriumPDFFonts?.typeface?.(op.f);
        let family=FAMILY[op.f[0]];
        if (face) {
          if (!faces.has(face)) faces.set(face,{alias:"WaffleFace"+(faces.size+1),gids:new Set()});
          const usage=faces.get(face);family=usage.alias;
          for (const gid of op.g) usage.gids.add(gid);
        }
        body.push("<text transform=\"matrix(" + m.join(" ") + ")\" font-size=\"100\" font-family=\"" + family + "\"" + ((face ? op.synthBold : op.f[1]) ? " font-weight=\"bold\"" : "") +
          (op.sw ? " fill=\"none\" stroke=\"" + css(op.c) + "\"" : " fill=\"" + css(op.c) + "\"") + alpha + " xml:space=\"preserve\">" + esc(op.u) + "</text>");
        continue;
      }
      body.push("<path d=\"" + svgPath(op.d) + "\"" + (op.fill ? " fill=\"" + css(op.c) + "\"" + (op.eo ? " fill-rule=\"evenodd\"" : "")
        : " fill=\"none\" stroke=\"" + css(op.c) + "\" stroke-width=\"" + N(op.w) + "\"" + (op.cap !== "butt" ? " stroke-linecap=\"" + op.cap + "\"" : "") +
          (op.join !== "miter" ? " stroke-linejoin=\"" + op.join + "\"" : "") + (op.dash ? " stroke-dasharray=\"" + op.dash.map(N).join(" ") + "\"" : "")) + alpha + "/>");
    }
    body.push("</g>".repeat(depth));
    if (faces.size) defs.push("<style>"+[...faces].map(([face,u])=>AtriumPDFFonts.svgTypeface(face,u.gids,u.alias)).join("")+"</style>");
    return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + N(o.width || w) + (o.unit || "") + "\" height=\"" + N(o.height || h) + (o.unit || "") + "\" viewBox=\"0 0 " + N(w) + " " + N(h) + "\">" +
      (defs.length ? "<defs>" + defs.join("") + "</defs>" : "") + "<rect width=\"100%\" height=\"100%\" fill=\"" + (o.background || "#fff") + "\"/>" + body.join("") + "</svg>";
  }

  // ------------------------------------------------------------ colours
  // Print colours: white paper; bright inks (yellow overlay) darkened to read on
  // white; greyscale by luminance; monochrome thresholds every ink to black.
  function inkFor(o, pcb, whites = []) {
    const W = whites.filter(Boolean).map(c => PDF.rgba(c));
    return c => {
      let [r, g, b, a] = c;
      if (W.some(w => Math.abs(w[0] - r) + Math.abs(w[1] - g) + Math.abs(w[2] - b) < .01)) r = g = b = 1;
      let L = .299 * r + .587 * g + .114 * b;
      if (pcb && L > .72 && Math.max(r, g, b) - Math.min(r, g, b) > .2) { const k = .5 / L; r *= k; g *= k; b *= k; L = .5; }
      if (o.color === "grey") r = g = b = L;
      else if (o.color === "mono") { const v = L > .9 ? 1 : 0; r = g = b = v; if (!v && a > 0) a = 1; }
      return [r, g, b, a];
    };
  }
  function withPrintColours(pcb, o, fn, copperPage) {
    if (pcb) {
      const P = PCB(), saved = {...P.system};
      Object.assign(P.system, {workspace: "#ffffff", board: "#ffffff", edge: "#000000", origin: "#ffffff",
        ...(copperPage ? {hole:"transparent", padHole:"transparent", drillEdge:"transparent"} : {hole:"#ffffff", padHole:"#ffffff", drillEdge:"#000000"}),
        ...(o.selectionInk && {selection:o.selectionInk})});
      try { return fn(); } finally { Object.assign(P.system, saved); }
    }
    const S = SCH();
    if (!S) return fn();
    const prior = {workspace: S.workspace, paper: S.paper};
    S.setTheme({workspace: "#ffffff", paper: o.whiteBackground ? "#ffffff" : prior.paper});
    try { return fn(); } finally { S.setTheme(globalThis.AtriumTheme?.canvasPalette?.("sch") || prior); }
  }

  // ------------------------------------------------------------ geometry
  function pageSize(o, aspect) {
    const [a, b] = Array.isArray(o.paper) ? o.paper : PAPER[o.paper], lo = Math.min(a, b), hi = Math.max(a, b);
    const land = o.orientation === "landscape" || o.orientation === "auto" && aspect >= 1;
    return land ? [hi * MM, lo * MM] : [lo * MM, hi * MM];
  }
  function areaOf(W, H, o, footer) { const m = o.margin * MM; return [m, m, W - m, H - m - (footer ? 16 : 0)]; }
  function fit(box, ar, o) {
    const w = Math.max(1e-3, box[2] - box[0]), h = Math.max(1e-3, box[3] - box[1]);
    return o.scale === "fit" ? Math.min((ar[2] - ar[0]) / w, (ar[3] - ar[1]) / h) : o.scale * MM;
  }
  const ratio = s => { const r = s / MM; return r >= 1 ? +r.toFixed(2) + ":1" : "1:" + +(1 / r).toFixed(2); };
  const clipTo = (ctx, ar, k) => { ctx.beginPath(); ctx.rect(ar[0] * k, ar[1] * k, (ar[2] - ar[0]) * k, (ar[3] - ar[1]) * k); ctx.clip(); };
  const overflows = (box, s, ar) => (box[2] - box[0]) * s > ar[2] - ar[0] + .5 || (box[3] - box[1]) * s > ar[3] - ar[1] + .5;
  const layerOf = (doc, name) => ({id:JSON.stringify([doc.id,name]), name:doc.name+" · "+name});
  function boardOptions(ctx, job, rec) {
    const {doc, o, project, geometry, defs} = ctx, {set} = job, active = set.active || "Top";
    const opts = {project, grid:false, origin:false, viaMarks:false, hideRegionGuides:true, exactProfile:true,
      visibleLayers:set.layers, layer:active, showUnrouted:false, selectedIds:new Set(), netNames:false};
    if (o.viewerLayers) opts.recordLayer = name => rec.setLayer(name ? layerOf(doc,name) : null);
    if (!set.layers?.includes(active) || PCB().index(active) < 0) return opts;
    opts.copperPage = true;
    const M = AtriumGeometryMaterial, B = AtriumBoardShape;
    if (!geometry.has(doc)) {
      const {copper} = M.datum(doc,defs), bores = [];
      for (const item of doc.items) M.collect({doc, defs, item, copper, bore:(_,bore) => bores.push(bore),
        diagnose:() => ctx.note("Unresolved physical drill depth on " + (item.ref || item.id) + ".")});
      geometry.set(doc,{copper, cutters:M.cutterIndex(bores)});
    }
    // The copper and Multi passes keep their vector ink and share a mask at the page's depth.
    const {copper, cutters} = geometry.get(doc), z = copper.get(active);
    let mask;
    opts.clipLayer = (layer, [x,y,r,b]) => {
      if (!z || layer !== active && layer !== "Multi") return;
      if (mask !== undefined) return mask;
      const stock = [{outer:AtriumGeometryCurves.lineEdges([[x,y],[r,y],[r,b],[x,b],[x,y]]),holes:[]}];
      const area = M.clip(stock,cutters,z);
      return mask = area === stock ? null : area.flatMap(({outer,holes}) => [outer,...holes]).map(loop => loop.map(edge =>
        edge.kind === "arc" ? B.arc(edge.center,edge.radius,edge.start,edge.start+edge.sweep,edge.sweep>0) : edge));
    };
    return opts;
  }

  // Passing even an empty calculation map tells the ordinary sheet renderer to
  // use the frozen export revision. Printing must never start an editor worker.
  function sheetOptions(ctx, job) {
    const opts = {project:ctx.project, doc:job.doc, grid:false, origin:false, hidden:new Set(), selectedIds:new Set(), purpose:"print",print:true};
    opts.titleBlockParameters = parametersFor(ctx.project,ctx.o.parameters,ctx.o.date);
    opts.notesPurpose = "print";
    opts.includeNotes = ctx.o.includeNotes;
    opts.notesDeferred = !!ctx.o.notebook;
    if (ctx.o.viewerLayers) opts.notesLayerTag = layerOf(job.doc,"Notes");
    // An empty prepared collection suppresses live image scheduling in print
    // previews and in synchronous headless exports with unavailable sources.
    opts.assets = ctx.o.assets || new Map();
    opts.calculationRecords = ctx.calculations?.sheet(job.doc,job.instanceId) || new Map();
    const widgets = notebookEnabled() ? globalThis.AtriumSheetWidgets : null;
    opts.widgetViews = ctx.o.widgetViews ? ctx.o.widgetViews.get(job.doc.id) :
      widgets?.views(ctx.project,job.doc,{...ctx.o.widgetContext,defs:ctx.defs,purpose:"print",
        revision:ctx.o.snapshotId ?? ctx.o.revision,calculation:ctx.calculations?.lookup}) || new Map();
    return opts;
  }

  // A sheet or layer-set page drawn by AtriumCanvas.
  function canvasPage(job, ctx) {
    const {doc, o, defs} = ctx, pcb = doc.kind === "pcb", Ah = A();
    let box = pcb ? doc.outline?.length >= 3 ? Ah.bounds(doc.outline) : Ah.docBounds(doc, defs) : job.box || (job.infinite ? SCH()?.drawingBounds?.(doc, defs) : SCH()?.pageBounds(doc, defs)) || Ah.docBounds(doc, defs);
    box = box || [0, 0, 100, 80];
    if (pcb) { const m = Math.max(1, Math.max(box[2] - box[0], box[3] - box[1]) * .02); box = [box[0] - m, box[1] - m, box[2] + m, box[3] + m]; }
    const [W, H] = pageSize(o, (box[2] - box[0]) / Math.max(1e-3, box[3] - box[1]));
    const ar = areaOf(W, H, o, pcb && o.footer), s = fit(box, ar, o), S = s * R;
    const dpr = Math.max(1, Math.min(4, globalThis.devicePixelRatio || 1));
    // At a fixed scale (1:1) a drawing larger than the paper is tiled over several sheets.
    if (o.scale !== "fit" && o.tile !== false && overflows(box, s, ar)) return tiledPages(job, ctx, box, W, H, ar, s, dpr);
    const rec = PDF.recorder(W * R, H * R, {unit: 1 / (R * dpr), ink: inkFor(o, pcb, !pcb && o.whiteBackground ? [doc.schDrawing?.paper, doc.schRestored?.sheet?.paper] : [])});
    const view = globalThis.AtriumCanvas.create(rec.canvas), flip = !!job.set?.flip;
    const ax = (ar[0] + ar[2]) / 2 * R - W * R / 2, ay = (ar[1] + ar[3]) / 2 * R - H * R / 2, cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    view.restoreCamera({cx: flip ? cx + ax / S : cx - ax / S, cy: cy - ay / S, scale: S, referenceScale: S, flipped: flip});
    const opts = pcb ? boardOptions(ctx, job, rec) : sheetOptions(ctx, job);
    const pins = o.comments && globalThis.AtriumReviewComments?.printOverlay?.(ctx.project, doc, defs); // review-comments
    if (pins) opts.overlay = [pins];
    // Crop the frame itself. The unused space on paper of a different aspect ratio must stay blank.
    const content = job.frame ? [(ar[0]+ar[2]-(box[2]-box[0])*s)/2, (ar[1]+ar[3]-(box[3]-box[1])*s)/2,
      (ar[0]+ar[2]+(box[2]-box[0])*s)/2, (ar[1]+ar[3]+(box[3]-box[1])*s)/2] : ar;
    rec.ctx.save(); clipTo(rec.ctx, content, R * dpr);
    withPrintColours(pcb, o, () => view.render(doc, defs, opts), opts.copperPage);
    rec.ctx.restore();
    const map = p => { const q = view.worldToScreen(p); return [q[0] / R, q[1] / R]; };
    const page = {w: W, h: H, list: rec.list, map, scale: s, area: content, frame: job.frame?.id};
    if (o.scale !== "fit" && overflows(box, s, ar)) ctx.note("“" + job.title + "” is larger than the page at " + ratio(s) + " and was clipped.");
    if (pcb && o.footer) footer(page, job, ctx);
    return page;
  }
  // Tiles: the whole drawing is recorded once at the chosen scale, then each sheet shows one
  // window of it (AtriumPDF.tiles/shift) with a 6 mm overlap, dashed glue lines where the next
  // tile starts, corner marks and a "Tile n of m" label.
  function tiledPages(job, ctx, box, W, H, ar, s, dpr) {
    const {doc, o, defs} = ctx, pcb = doc.kind === "pcb", S = s * R, cw = (box[2] - box[0]) * s, ch = (box[3] - box[1]) * s, ov = 6 * MM;
    const grid = PDF.tiles(cw, ch, ar, ov, job.infinite ? 2048 : Infinity);
    const rec = PDF.recorder(cw * R, ch * R, {unit: 1 / (R * dpr), ink: inkFor(o, pcb, !pcb && o.whiteBackground ? [doc.schDrawing?.paper, doc.schRestored?.sheet?.paper] : [])});
    const view = globalThis.AtriumCanvas.create(rec.canvas), flip = !!job.set?.flip, cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    view.restoreCamera({cx, cy, scale: S, referenceScale: S, flipped: flip});
    const opts = pcb ? boardOptions(ctx, job, rec) : sheetOptions(ctx, job);
    withPrintColours(pcb, o, () => view.render(doc, defs, opts), opts.copperPage);
    ctx.note("“" + job.title + "” is larger than the page at " + ratio(s) + " and was tiled over " + grid.length + " pages (" + grid[0].cols + " × " + grid[0].rows + ", 6 mm overlap).");
    return grid.map(t => {
      const list = PDF.shift(rec.list, t.dx, t.dy, ar);
      const marks = PDF.recorder(W, H, {ink: inkFor(o, false)}), c = marks.ctx;
      c.strokeStyle = "#000"; c.lineWidth = .4; c.beginPath();
      for (const [x, y, sx, sy] of [[ar[0], ar[1], -1, -1], [ar[2], ar[1], 1, -1], [ar[0], ar[3], -1, 1], [ar[2], ar[3], 1, 1]]) { c.moveTo(x + sx * 2, y); c.lineTo(x + sx * 8, y); c.moveTo(x, y + sy * 2); c.lineTo(x, y + sy * 8); }
      c.stroke();
      c.setLineDash([3, 2]); c.lineWidth = .3; c.beginPath();
      if (t.col < t.cols - 1) { c.moveTo(ar[2] - ov, ar[1]); c.lineTo(ar[2] - ov, ar[3]); }
      if (t.row < t.rows - 1) { c.moveTo(ar[0], ar[3] - ov); c.lineTo(ar[2], ar[3] - ov); }
      c.stroke(); c.setLineDash([]);
      c.fillStyle = "#000"; c.font = "6.5px Helvetica"; c.textBaseline = "bottom"; c.textAlign = "left";
      c.fillText("Tile " + (t.index + 1) + " of " + t.count + " · row " + (t.row + 1) + ", column " + (t.col + 1) + " · " + ratio(s) + " · overlap 6 mm (dashed)", ar[0] + 10, ar[1] - 2);
      const map = p => { const q = view.worldToScreen(p); return [q[0] / R + t.dx, q[1] / R + t.dy]; };
      const page = {w: W, h: H, list: [...list, ...marks.list], map, scale: s, area: ar, tile: t};
      if (pcb && o.footer) footer(page, job, ctx);
      return page;
    });
  }
  function footer(page, job, ctx) {
    const {o} = ctx, rec = PDF.recorder(page.w, page.h, {ink: inkFor(o, false)}), c = rec.ctx, ar = page.area, y = ar[3] + 4;
    c.strokeStyle = "#000"; c.lineWidth = .5; c.beginPath(); c.moveTo(ar[0], y); c.lineTo(ar[2], y); c.stroke();
    c.fillStyle = "#000"; c.font = "bold 7.5px Helvetica"; c.textBaseline = "top"; c.textAlign = "left";
    c.fillText(job.doc.name + " — " + job.label, ar[0], y + 3);
    c.font = "7px Helvetica"; c.textAlign = "right";
    c.fillText("Scale " + ratio(page.scale) + (job.set?.flip ? " · viewed from bottom" : "") + " · " + (ctx.project.name || "") + " · Waffle", ar[2], y + 3.5);
    // Scale bar: a whole number of millimetres, about 40–90 pt long.
    const len = [.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find(v => v * page.scale >= 40) || 1000, w = len * page.scale, x0 = (ar[0] + ar[2]) / 2 - w / 2;
    for (let i = 0; i < 4; i++) { c.fillStyle = i % 2 ? "#fff" : "#000"; c.fillRect(x0 + w * i / 4, y + 3, w / 4, 3.5); }
    c.strokeStyle = "#000"; c.lineWidth = .4; c.strokeRect(x0, y + 3, w, 3.5);
    c.fillStyle = "#000"; c.font = "6px Helvetica"; c.textAlign = "left"; c.fillText("0", x0 - 1, y + 7.5);
    c.textAlign = "right"; c.fillText(len + " mm", x0 + w + 4, y + 7.5);
    page.list.push(...rec.list);
  }

  // Drawing documents: their sheets as drawn by drawing.js (vector, 1:1 at the sheet size).
  function drawingPages(job, ctx) {
    const D = globalThis.AtriumDrawing;
    if (!D) throw Error("Drawings need the drawing module (drawing.js).");
    const r = D.pages(ctx.project, job.doc, {date: ctx.o.date instanceof Date ? ctx.o.date : null,
      dateText:exportDay(ctx.project,ctx.o.date), color:ctx.o.color});
    for (const n of r.notes) ctx.note(job.doc.name + ": " + n);
    // drawing2: a sheet larger than the paper is tiled at 1:1 (6 mm overlap, glue lines, "tile n of m"),
    // exactly as export_drawing and the drawing output job tile it; Tile off prints each sheet whole.
    const tiled = [], o = ctx.o, list = o.tile !== false && D.tile ? r.list.flatMap(p => D.tile(p, o.paper, tiled, {orientation: o.orientation, margin: o.margin})) : r.list;
    for (const n of tiled) ctx.note(n);
    return list.map(p => ({...p, label: p.title.slice(job.doc.name.length + 3) || p.title}));
  }
  // Assembly drawings come from fab-outputs (the same SVG the fab package ships).
  function attrs(s) { const a = {}; for (const m of s.matchAll(/([\w:-]+)="([^"]*)"/g)) a[m[1]] = unxml(m[2]); return a; }
  const unxml = s => s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : {amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'"}[e.toLowerCase()]);
  function drawSVG(c, text, vw, vh, exactPaths) {
    const stack = [{}], INHERIT = ["fill", "stroke", "stroke-width", "stroke-linejoin", "stroke-linecap", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline"];
    for (const m of text.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>([^<]*)/g)) {
      const [, close, tag, raw, self, body] = m;
      if (close) { if (tag === "g" || tag === "svg") stack.pop(); continue; }
      const own = attrs(raw), a = {...stack.at(-1), ...own};
      if ((tag === "g" || tag === "svg") && !self) { const keep = {}; for (const k of INHERIT) if (a[k] != null) keep[k] = a[k]; stack.push(keep); continue; }
      const fill = a.fill ?? "#000", stroke = a.stroke ?? "none";
      c.save(); c.lineWidth = +a["stroke-width"] || 1; c.lineJoin = a["stroke-linejoin"] || "miter"; c.lineCap = a["stroke-linecap"] || "butt";
      c.setLineDash(a["stroke-dasharray"] ? a["stroke-dasharray"].split(/[\s,]+/).map(Number) : []);
      const paint = () => { if (fill !== "none") { c.fillStyle = fill; c.fill(a["fill-rule"] || "nonzero"); } if (stroke !== "none") { c.strokeStyle = stroke; c.stroke(); } };
      c.beginPath();
      if (tag === "path" && exactPaths?.has(own.d)) {
        const {contours, closed} = exactPaths.get(own.d);
        for (const contour of contours) AtriumBoardShape.traceContour(c, contour, closed);
        paint();
      } else if (tag === "polygon" || tag === "polyline") {
        const n = (own.points || "").trim().split(/[\s,]+/).map(Number);
        for (let i = 0; i + 1 < n.length; i += 2) i ? c.lineTo(n[i], n[i + 1]) : c.moveTo(n[i], n[i + 1]);
        if (tag === "polygon") c.closePath(); else if (fill !== "none" && a.fill == null) { c.restore(); continue; }
        paint();
      } else if (tag === "circle") { c.arc(+own.cx || 0, +own.cy || 0, +own.r || 0, 0, Math.PI * 2); c.closePath(); paint(); }
      else if (tag === "rect") {
        const w = /%$/.test(own.width) ? vw : +own.width || 0, h = /%$/.test(own.height) ? vh : +own.height || 0;
        c.rect(+own.x || 0, +own.y || 0, w, h); paint();
      } else if (tag === "line") { c.moveTo(+own.x1, +own.y1); c.lineTo(+own.x2, +own.y2); if (stroke !== "none") { c.strokeStyle = stroke; c.stroke(); } }
      else if (tag === "text") {
        const x = +own.x || 0, y = +own.y || 0, r = /rotate\(\s*([-\d.]+)(?:[\s,]+([-\d.]+)[\s,]+([-\d.]+))?/.exec(own.transform || "");
        if (r) { c.translate(+r[2] || 0, +r[3] || 0); c.rotate(+r[1] * Math.PI / 180); c.translate(-(+r[2] || 0), -(+r[3] || 0)); }
        c.font = (/^(bold|[6-9]00)$/.test(a["font-weight"] || "") ? "bold " : "") + (+a["font-size"] || 3) + "px " + (a["font-family"] || "Helvetica");
        c.textAlign = {middle: "center", end: "right"}[a["text-anchor"]] || "left";
        c.textBaseline = {central: "middle", middle: "middle", hanging: "top"}[a["dominant-baseline"]] || "alphabetic";
        c.fillStyle = fill === "none" ? "#000" : fill; c.fillText(unxml(body), x, y);
      }
      c.restore();
    }
  }
  function fab(ctx) {
    const F = globalThis.AtriumFabOutputs;
    if (!F) throw Error("Assembly and drill drawings need the fabrication outputs module.");
    if (!ctx.models.has(ctx.doc.id)) ctx.models.set(ctx.doc.id, F.analyse(ctx.project, ctx.doc.id));
    return [F, ctx.models.get(ctx.doc.id)];
  }
  function assemblyPage(job, ctx) {
    const [F, model] = fab(ctx), {o} = ctx;
    const exactPaths = new Map();
    const svg = F.assembly(model, job.set.assembly, F.settle({date:o.date instanceof Date ? o.date : new Date(0),
      dateText:exportDay(ctx.project,o.date)}),exactPaths).content;
    const vb = (/viewBox="([^"]+)"/.exec(svg)?.[1] || "0 0 100 100").split(/\s+/).map(Number), vw = vb[2], vh = vb[3];
    const [W, H] = pageSize(o, vw / vh), ar = areaOf(W, H, o, false), s = fit([0, 0, vw, vh], ar, o);
    const rec = PDF.recorder(W, H, {ink: inkFor(o, false)}), c = rec.ctx;
    c.save(); clipTo(c, ar, 1);
    c.translate((ar[0] + ar[2]) / 2 - vw * s / 2, (ar[1] + ar[3]) / 2 - vh * s / 2); c.scale(s, s);
    drawSVG(c, svg, vw, vh, exactPaths); c.restore();
    if (o.scale !== "fit" && overflows([0, 0, vw, vh], s, ar)) ctx.note("“" + job.title + "” is larger than the page and was clipped.");
    return {w: W, h: H, list: rec.list, scale: s, area: ar};
  }
  // Drill drawing: one symbol per hole size, and the drill table.
  function symbol(c, n, x, y, r) {
    c.beginPath();
    const poly = (k, a0) => { for (let i = 0; i < k; i++) { const a = a0 + i * 2 * Math.PI / k; i ? c.lineTo(x + r * Math.cos(a), y + r * Math.sin(a)) : c.moveTo(x + r * Math.cos(a), y + r * Math.sin(a)); } c.closePath(); };
    const cross = (k, a0) => { for (let i = 0; i < k; i++) { const a = a0 + i * Math.PI / k * 2; c.moveTo(x, y); c.lineTo(x + r * Math.cos(a), y + r * Math.sin(a)); } };
    switch (n % 10) {
      case 0: c.arc(x, y, r, 0, Math.PI * 2); c.moveTo(x - r, y); c.lineTo(x + r, y); c.moveTo(x, y - r); c.lineTo(x, y + r); break;
      case 1: c.rect(x - r * .8, y - r * .8, r * 1.6, r * 1.6); break;
      case 2: poly(3, -Math.PI / 2); break;
      case 3: poly(4, 0); break;
      case 4: cross(4, Math.PI / 4); break;
      case 5: cross(4, 0); break;
      case 6: c.arc(x, y, r, 0, Math.PI * 2); break;
      case 7: poly(6, 0); break;
      case 8: c.rect(x - r * .8, y - r * .8, r * 1.6, r * 1.6); cross(4, Math.PI / 4); break;
      default: poly(3, Math.PI / 2);
    }
    c.stroke();
    if (n >= 10) { c.font = "bold " + r + "px Helvetica"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(String.fromCharCode(65 + (n - 10) % 26), x, y); }
  }
  function drillPage(job, ctx) {
    const [, model] = fab(ctx), {o, doc} = ctx, Ah = A();
    const groups = new Map();
    for (const h of model.drills) {
      if (h.backdrill) continue;
      const key = h.d.toFixed(3) + (h.plated ? "P" : "N");
      if (!groups.has(key)) groups.set(key, {d: h.d, plated: h.plated, hits: []});
      groups.get(key).hits.push(h);
    }
    const list = [...groups.values()].sort((a, b) => a.d - b.d || b.plated - a.plated);
    const outline = doc.outline?.length >= 3 ? doc.outline : model.outline;
    let box = Ah.bounds(outline.length ? outline : model.drills.map(h => h.at)) || [0, 0, 50, 40];
    const m = Math.max(1, (box[2] - box[0]) * .03); box = [box[0] - m, box[1] - m, box[2] + m, box[3] + m];
    const [W, H] = pageSize(o, (box[2] - box[0]) / (box[3] - box[1]) * 1.3), area = areaOf(W, H, o, false), table = 190;
    const ar = [area[0], area[1] + 22, area[2] - table - 12, area[3]], s = fit(box, ar, o);
    const ox = (ar[0] + ar[2]) / 2 - (box[0] + box[2]) / 2 * s, oy = (ar[1] + ar[3]) / 2 - (box[1] + box[3]) / 2 * s, P = p => [ox + p[0] * s, oy + p[1] * s];
    const rec = PDF.recorder(W, H, {ink: inkFor(o, false)}), c = rec.ctx;
    c.fillStyle = "#000"; c.font = "bold 12px Helvetica"; c.textBaseline = "top"; c.fillText(doc.name + " — Drill drawing", area[0], area[1]);
    c.font = "7.5px Helvetica"; c.fillText("Viewed from top · Scale " + ratio(s) + " · " + model.drills.length + " holes · dimensions in mm", area[0], area[1] + 14);
    c.save(); clipTo(c, ar, 1);
    if (outline.length >= 3) {
      c.beginPath();
      if (model.boardShape) {
        c.save(); c.translate(ox, oy); c.scale(s, s);
        for (const contour of AtriumBoardShape.profileContours(model.boardShape)) AtriumBoardShape.traceContour(c, contour, true);
        c.restore();
      } else { outline.forEach((p, i) => i ? c.lineTo(...P(p)) : c.moveTo(...P(p))); c.closePath(); }
      c.strokeStyle = "#000"; c.lineWidth = .8; c.stroke();
    }
    c.lineWidth = .45; c.strokeStyle = "#000"; c.fillStyle = "#000";
    list.forEach((g, n) => { const r = Math.max(2, Math.min(5, g.d * s * .8)); for (const h of g.hits) symbol(c, n, ...P(h.at), r); });
    c.restore();
    const tx = area[2] - table;
    let y = area[1] + 22;
    const cols = [tx + 10, tx + 40, tx + 100, tx + 140];
    c.font = "bold 7.5px Helvetica"; c.textBaseline = "middle"; c.textAlign = "left";
    ["Sym", "Size (mm)", "Count", "Type"].forEach((t, i) => c.fillText(t, cols[i] - (i ? 0 : 8), y + 6));
    c.lineWidth = .5; c.beginPath(); c.moveTo(tx, y + 12); c.lineTo(area[2], y + 12); c.stroke(); y += 12;
    c.font = "7.5px Helvetica";
    list.forEach((g, n) => {
      if (y > area[3] - 24) return;
      c.lineWidth = .45; symbol(c, n, cols[0], y + 7, 3.5);
      c.textAlign = "left"; c.textBaseline = "middle"; c.font = "7.5px Helvetica";
      c.fillText(g.d.toFixed(3), cols[1], y + 7); c.fillText(String(g.hits.length), cols[2], y + 7); c.fillText(g.plated ? "Plated" : "Non-plated", cols[3], y + 7);
      y += 14;
    });
    c.lineWidth = .5; c.beginPath(); c.moveTo(tx, y + 2); c.lineTo(area[2], y + 2); c.stroke();
    c.font = "bold 7.5px Helvetica"; c.textAlign = "left"; c.textBaseline = "middle";
    c.fillText("Total", cols[1], y + 9); c.fillText(String(list.reduce((n, g) => n + g.hits.length, 0)), cols[2], y + 9);
    return {w: W, h: H, list: rec.list, scale: s, area: ar, map: P};
  }

  // Presentation jobs reuse the same vector canvas and Smart PDF annotations as print.
  const selectionInk = "#1453a3";
  function viewportBounds(job) {
    const {camera, viewport} = job;
    const w = viewport.pixelWidth / (2 * camera.scale), h = viewport.pixelHeight / (2 * camera.scale);
    const c = Math.abs(Math.cos(camera.rotation || 0)), s = Math.abs(Math.sin(camera.rotation || 0));
    const x = c * w + s * h, y = s * w + c * h, pad = 7 / camera.scale;
    return [camera.cx - x - pad,camera.cy - y - pad,camera.cx + x + pad,camera.cy + y + pad];
  }

  function presentationFilter(rec, view, job, scene, defs, scale, render) {
    const filter = job.filter, Q = globalThis.AtriumQuery;
    if (filter?.status !== "complete" || !Q || !(filter.mask || filter.highlight)) return;
    const {ids, subitems} = globalThis.AtriumSavedViews.highlightRecords(filter, scene, defs);
    if (!ids.length && !subitems.length) return;
    const {boxes, lines} = Q.shapesOf(scene, defs, ids, subitems, viewportBounds(job));
    const {ctx:c, canvas} = rec;
    c.save();
    view.internals().boardTransform();
    c.lineCap = c.lineJoin = "round";
    if (filter.mask) {
      // The opaque editor backdrop repaints the matching windows at full ink.
      // Vector clips keep the artwork editable and visible beneath the mask.
      c.save(); c.setTransform(1,0,0,1,0,0);
      c.fillStyle = "#fff"; c.globalAlpha = .7; c.fillRect(0,0,canvas.width,canvas.height);
      c.restore();
      if (boxes.length || lines.length) {
        c.save(); c.beginPath();
        for (const [x,y,r,b] of boxes) c.rect(x,y,r-x,b-y);
        for (const {points,w} of lines) {
          const radius = Math.round(w * 100) / 200 + 1 / scale;
          for (const [x,y] of points) { c.moveTo(x+radius,y); c.arc(x,y,radius,0,TAU); c.closePath(); }
          for (let i = 1; i < points.length; i++) {
            const [x,y] = points[i-1], [r,b] = points[i], length = Math.hypot(r-x,b-y);
            if (!length) continue;
            const nx = (b-y)*radius/length, ny = -(r-x)*radius/length;
            c.moveTo(x+nx,y+ny); c.lineTo(r+nx,b+ny); c.lineTo(r-nx,b-ny); c.lineTo(x-nx,y-ny); c.closePath();
          }
        }
        c.clip(); render(); c.restore();
      }
    }
    if (filter.highlight) {
      c.strokeStyle = selectionInk; c.globalAlpha = .9; c.lineWidth = 2 / scale; c.beginPath();
      for (const [x,y,r,b] of boxes) c.rect(x,y,r-x,b-y);
      c.stroke(); c.globalAlpha = .45;
      for (const {points,w} of lines) {
        c.lineWidth = Math.round(w * 100) / 100 + 4 / scale; c.beginPath();
        points.forEach(([x,y], i) => i ? c.lineTo(x,y) : c.moveTo(x,y));
        c.stroke();
      }
    }
    c.restore();
  }

  function viewportPage(job, ctx) {
    const {doc, viewport: saved, camera} = job, {project, defs, o} = ctx;
    const scene = doc.kind === "panel" ? globalThis.AtriumPanel?.view(doc,defs,project) : doc;
    if (!scene) throw Error("The panel renderer is unavailable.");
    const pcb = scene.kind === "pcb";
    const {pixelWidth, pixelHeight} = saved, coordinateScale = Math.min(.75, 1440 / Math.max(pixelWidth, pixelHeight));
    const [W, H] = job.paper ?? [pixelWidth * coordinateScale, pixelHeight * coordinateScale + 24];
    const margin = job.margin ?? 0, titleHeight = 24;
    const zoom = Math.min((W - 2 * margin) / pixelWidth, (H - titleHeight - 2 * margin) / pixelHeight);
    const w = pixelWidth * zoom, h = pixelHeight * zoom, x = (W - w) / 2, y = titleHeight + (H - titleHeight - h) / 2;
    const area = [x, y, x + w, y + h], box = viewportBounds(job), dpr = Math.max(1, Math.min(4, globalThis.devicePixelRatio || 1));
    const rec = PDF.recorder(w, h, {unit:1 / dpr, ink:inkFor(o, pcb)});
    const view = globalThis.AtriumCanvas.create(rec.canvas), scale = camera.scale * zoom;
    view.restoreCamera({...camera, scale, referenceScale:camera.referenceScale * zoom});
    const selectedIds = new Set(job.selection ?? []);
    const opts = {...sheetOptions(ctx, job), selectedIds, exactProfile:true, noReuse:true,
      hidden:new Set(job.layers?.hidden ?? []), layer:job.layers?.active, layerMode:job.layers?.mode,
      viaMarks:false, hideRegionGuides:true, showUnrouted:false, netNames:false, highlight:job.netHighlight || ""};
    if (doc.kind === "drawing") {
      const D = globalThis.AtriumDrawing;
      if (!D) throw Error("The drawing renderer is unavailable.");
      const c = rec.ctx;
      c.setTransform(dpr,0,0,dpr,0,0);c.translate(w/2,h/2);c.rotate(camera.rotation || 0);
      c.scale(scale,scale);c.translate(-camera.cx,-camera.cy);
      for (const issue of D.paintPresentation(c, project, doc, {...o,selection:job.selection})) ctx.note(issue);
    } else withPrintColours(pcb, {...o,selectionInk}, () => {
      const notes = notebookProjection(doc,ctx,box);
      const render = () => {
        view.render(scene, globalThis.AtriumPanel?.definitionsFor(scene, defs) || defs, opts);
        if (notes?.length) {
          const c = rec.ctx;
          c.save();
          try {
            view.internals().boardTransform();
            paintNotebook(c,doc,ctx,notes);
          } finally { c.restore(); }
        }
      };
      render();
      presentationFilter(rec,view,job,scene,defs,scale,render);
    });
    const title = PDF.recorder(W, H);
    title.ctx.fillStyle = "#000000";title.ctx.font = "10px Helvetica";
    title.ctx.fillText(job.title, Math.max(8, margin), 15, Math.max(1, W - Math.max(16, margin * 2)));
    const list = [...title.list, ...PDF.shift(rec.list, x, y, area)];
    const map = doc.kind === "drawing" ? undefined : pt => {
      const [px, py] = view.worldToScreen(pt); return [px + x, py + y];
    };
    return {w:W, h:H, list, scale, area, map, linkRect:[0,0,W,titleHeight]};
  }

  // ------------------------------------------------------------ plan and build
  function plan(project, o, defs) {
    if (o.presentation) return o.presentation.map(job => {
      const doc = project.documents.find(d => d.id === job.documentId);
      if (!doc) throw Error("A presentation document is no longer available.");
      return {...job, doc, kind:doc.kind, label:job.title};
    });
    const want = Array.isArray(o.documents) ? new Set(o.documents) : null;
    const docs = project.documents.filter(d => !want || want.has(d.id));
    const jobs = [];
    for (const doc of docs) if (doc.kind === "schematic") {
      const infinite = doc.sheet?.infinite === true;
      if (infinite && o.infiniteLayout === "frames") {
        const frames = doc.items.filter(i => i.kind === "textframe" && i.role === "frame");
        if (!frames.length) throw Error("“" + doc.name + "” has no frames. Add a frame or choose another infinite sheet layout.");
        for (const frame of frames) jobs.push({doc, infinite, frame, kind: "schematic", title: doc.name + " — " + frame.text,
          label: frame.text, box: [frame.x,frame.y,frame.x+frame.w,frame.y+frame.h]});
      } else jobs.push({doc, infinite, kind: "schematic", title: doc.name, label: "Schematic"});
    }
    for (const doc of docs) if (doc.kind === "pcb") for (const id of o.layerSets) {
      const set = SET.get(id);
      if (set.inner)
        for (const l of AtriumStackup.copperLayers(doc, defs ??= new Map((project.library || []).map(def => [def.id, def]))).slice(1, -1))
          jobs.push({doc, kind: "pcb", set: {id: "inner", layers: [l, "Multi", "Mechanical 1"], active: l}, label: PCB().name(l), title: doc.name + " — " + PCB().name(l)});
      else jobs.push({doc, kind: set.assembly ? "assembly" : set.drill ? "drill" : "pcb", set, label: set.name, title: doc.name + " — " + set.name});
    }
    // Drawing documents (drawing.js): one page per sheet at the sheet's own size.
    if (o.drawings !== false) for (const doc of docs) if (doc.kind === "drawing") jobs.push({doc, kind: "drawing", label: "Drawing", title: doc.name});
    return jobs;
  }
  const exportDay=(project,date)=>date instanceof Date ? date.toISOString().slice(0,10) : String(project.revision?.date || "").slice(0,10);
  function parametersFor(project, extra, date) {
    const stamp=date instanceof Date ? date.toISOString() : "";
    const day=exportDay(project,date) || "—", clock=stamp.slice(11,19) || "—";
    const own = project.parameters, merged = {CurrentDate:day,CurrentTime:clock,Date:day,Time:clock};
    if (Array.isArray(own)) for (const p of own) { if (p && typeof p.name === "string") merged[p.name] = String(p.value ?? ""); }
    else if (own && typeof own === "object") Object.assign(merged, own);
    for (const [k, v] of Object.entries(extra || {})) if (v != null && String(v).trim() !== "") merged[k] = String(v);
    return merged;
  }
  const collator = new Intl.Collator("en", {numeric:true});
  const natural = (a, b) => collator.compare(a,b) || (a < b ? -1 : a > b ? 1 : 0);
  function electrical(project, defs) {
    const H=globalThis.AtriumHierarchy, compiled=H?.compileCached?.(project,{defs}) || H?.compile(project,{defs});
    const names = new WeakMap(), endpointNets = new WeakMap(), endpoints = new Map();
    function bind(item, net) {
      if (!names.has(item)) names.set(item,new Set());
      names.get(item).add(net.name);
    }
    for (const net of compiled?.nets || []) {
      const sites=[]; endpoints.set(net, sites);
      for (const {inst,net:local} of net.local) {
        for (const w of local.wires) bind(w,net);
        for (const source of [...local.sources,...local.entries]) {
          const item=source.item || source.symbol, entry=source.entry, kind=entry ? "entry" : source.type;
          bind(entry || item,net);
          if (!["entry","offsheet","port"].includes(kind)) continue;
          const key=entry || item;
          if (!endpointNets.has(key)) endpointNets.set(key,new Set());
          endpointNets.get(key).add(net);
          sites.push({doc:inst.doc,item,entry,kind,instance:inst});
        }
      }
    }
    let index;
    const targets = (docId, m, instanceId) => {
      if (compiled && globalThis.AtriumSheetConnections) {
        index ||= globalThis.AtriumSheetConnections.index(compiled);
        return index.targetsFor(docId,m.item.id,m.entry?.id,instanceId)?.direct || [];
      }
      // The base compiler already publishes the actual electrical unions. Never link
      // two disconnected scopes just because their display strings happen to agree.
      const nets=endpointNets.get(m.entry || m.item);
      if (!nets || nets.size!==1) return [];
      return endpoints.get([...nets][0]).filter(t => t.doc.id!==docId &&
        (m.kind==="offsheet" ? t.kind==="offsheet" : m.kind==="entry" ? t.kind==="port" : t.kind==="entry" || t.kind==="port"));
    };
    return {compiled,names,targets};
  }
  function marksFor(page, job, defs, electrical) {
    const doc = job.doc, Ah = A(), marks = [];
    if (!page.map || job.kind === "assembly" || job.kind === "drill") return marks;
    const rectOf = b => {
      const points = [[b[0], b[1]], [b[2], b[3]]];
      if (job.camera?.rotation) points.push([b[2], b[1]], [b[0], b[3]]);
      return Ah.bounds(points.map(page.map));
    };
    const inside = r => r[2] > page.area[0] && r[0] < page.area[2] && r[3] > page.area[1] && r[1] < page.area[3];
    const clamp = r => [Math.max(r[0],page.area[0]), Math.max(r[1],page.area[1]), Math.min(r[2],page.area[2]), Math.min(r[3],page.area[3])];
    const anchor = item => {
      const points=item.points;
      if (!points?.length) return [item.x,item.y];
      let a=points[0], pa=page.map(a);
      for (let i=1; i<points.length; i++) {
        const b=points[i], pb=page.map(b);
        let lo=0,hi=1;
        for (let axis=0; axis<2; axis++) {
          const delta=pb[axis]-pa[axis], low=page.area[axis], high=page.area[axis+2];
          if (!delta) { if (pa[axis]<low || pa[axis]>high) hi=-1; }
          else {
            const u=(low-pa[axis])/delta, v=(high-pa[axis])/delta;
            lo=Math.max(lo,Math.min(u,v));hi=Math.min(hi,Math.max(u,v));
          }
        }
        if (lo<=hi) return [a[0]+(b[0]-a[0])*lo,a[1]+(b[1]-a[1])*lo];
        a=b; pa=pb;
      }
      return a;
    };
    const visibleText=new Map();
    for (const op of page.list) if (op.k==="t" && !visibleText.has(op.u)) visibleText.set(op.u,op);
    function partAreas(item,box) {
      // The body opens properties. Its designator is the separate cross-probe
      // target. For stroked/hidden designators reserve the left side instead.
      const op=visibleText.get(item.ref);
      if (op) {
        const [a,b,c,d,x,y]=op.m, w=PDF.runs(item.ref,"H").width;
        const points=[[0,-.2],[w,-.2],[w,.85],[0,.85]].map(([u,v])=>[x+a*u+c*v,y+b*u+d*v]);
        const label=Ah.bounds(points);
        if (inside(label) && (label[2]<=box[0] || label[0]>=box[2] || label[3]<=box[1] || label[1]>=box[3]))
          return {linkRect:clamp(label),noteRect:box};
      }
      const [l,t,r,b]=box, split=l+(r-l)*.22;
      return {linkRect:[l,t,split,b],noteRect:[split,t,r,b]};
    }
    const words = new Set(), nets = new Set(), visibility = job.viewport ? {hidden:new Set(job.layers?.hidden ?? [])} : {visibleLayers:job.set?.layers,layer:job.set?.active || "Top"};
    function word(value, point, net=false, layer=null) {
      if (!value || !point) return;
      const at=page.map(point), s=String(value);
      if (!inside([at[0]-.01,at[1]-.01,at[0]+.01,at[1]+.01])) return;
      const firstNet=net && !nets.has(s);
      if (firstNet) nets.add(s);
      const firstWord=!words.has(s); words.add(s);
      if (firstWord || firstNet) marks.push({at,...(firstWord?{word:s}:{}),...(firstNet?{net:s}:{}),layer});
    }
    for (const i of doc.items) {
      let key = null, b = null;
      if (i.kind === "part") {
        const def=defs.get(i.def), point=[i.x,i.y];
        key = "part:" + (i.link || i.ref); b = Ah.bounds(Ah.itemPoints(i, def, doc.kind));
        word(i.ref,point); word(i.value ?? def?.value,point);
        for (const pin of Ah.pins(i,def,doc.kind)) {
          word(pin.name,pin.at);
          if (doc.kind==="pcb") word(i.pinNets?.[pin.number] ?? pin.net,pin.at,true);
          else word(electrical.compiled?.byDoc.get(doc.id)?.byPin.get(i.id+"/"+pin.number),pin.at,true);
        }
      }
      else if (doc.kind !== "schematic") {
        if (i.net && PCB().visible(i.layer || "Multi",i,visibility)) word(i.net,anchor(i),true,layerOf(doc,i.layer || "Multi"));
        continue;
      }
      else if (i.kind === "sheetsymbol") {
        key = "sheet:" + i.sheet; b = i.w && i.h ? [i.x, i.y, i.x + i.w, i.y + i.h] : Ah.bounds(Ah.itemPoints(i, null, doc.kind));
        for (const entry of i.entries || []) {
          const pt=globalThis.AtriumSchObjects?.entryPoint(i,entry);
          if (!pt) continue;
          const rr=rectOf([pt[0]-1.5,pt[1]-1.5,pt[0]+1.5,pt[1]+1.5]);
          if (inside(rr)) marks.push({key:"port:"+entry.name,kind:"entry",item:i,entry,rect:clamp(rr),at:page.map(pt)});
        }
      }
      else if (i.kind === "port" || i.kind === "offsheet") { const n = i.text ?? i.name; if (n) { key = "port:" + n; b = [i.x - 2.5, i.y - 2.5, i.x + 2.5, i.y + 2.5]; } }
      if (doc.kind==="schematic" && i.kind!=="part") {
        const names=electrical.names.get(i);
        if (names?.size) for (const name of names) word(name,anchor(i),true);
        else if (i.kind==="netlabel" || i.kind==="power") word(i.text ?? i.name ?? i.net,anchor(i));
      }
      if (!key || !b) continue;
      if (b[2] - b[0] < 1) b = [b[0] - .5, b[1], b[2] + .5, b[3]];
      if (b[3] - b[1] < 1) b = [b[0], b[1] - .5, b[2], b[3] + .5];
      const rect = rectOf(b);
      if (inside(rect)) {
        const box=clamp(rect);
        marks.push({key,rect:box,at:[box[0],box[1]],item:i,kind:i.kind,...(i.kind==="part" ? partAreas(i,box) : {})});
      }
    }
    return marks;
  }
  function partNote(item, def, kind) {
    const fields = A().partParameters, params = fields.parameters(item,def);
    const mpn = fields.fieldOf(params).mpn || item.mpn || def?.mpn;
    const footprint = kind === "pcb" ? def?.footprint?.name || def?.name : def?.footprintName || def?.footprint?.name;
    const description = fields.parameters(item).DESCRIPTION || item.description || def?.description || params.DESCRIPTION;
    const rows = [["Value",item.value ?? def?.value],["MPN",mpn],["Footprint",footprint || params.FOOTPRINT],["Description",description]];
    // Retain human-readable parameter spelling while using the same precedence
    // and Altium procurement aliases as the BOM.
    const labels = new Map();
    for (const source of [def?.parameters,item.parameters]) for (const label of Object.keys(source || {})) labels.set(fields.paramKey(label),label);
    for (const key of Object.keys(params).sort()) {
      if (["VALUE","DESCRIPTION","FOOTPRINT"].includes(key) || fields.FIELD_KEYS.mpn.test(key)) continue;
      rows.push([labels.get(key) || key,params[key]]);
    }
    return {title:item.ref || def?.name || "Part", contents:rows.map(([key,v])=>key+": "+(v || "—")).join("\n")};
  }
  function searchable(page, viewerLayers) {
    const existing=new Set(page.list.filter(op=>op.k==="t").map(op=>op.u)), extra=[];
    for (const m of page.marks) if (m.word && !existing.has(m.word)) {
      existing.add(m.word);
      const size=5, [x,y]=m.at;
      for (const run of PDF.runs(m.word,"H").runs) if (!run.glyph) extra.push({k:"t", f:run.f || "H", s:run.s, u:run.u,
        ...(run.g?{g:run.g}:{}),m:[size,0,0,-size,x+run.x*size,y],invisible:true,c:[0,0,0,1],a:1,layer:viewerLayers ? m.layer : null,clip:null});
    }
    return extra;
  }
  function notebookProjection(doc, ctx, clip) {
    const source=ctx.o.notebook;
    if (!source || doc.kind!=="schematic" || ctx.o.includeNotes===false) return;
    return source.sheetNotes({sheetId:doc.id,clip,purpose:"print",includeNotes:ctx.o.includeNotes,
      fieldResolver:ctx.o.fieldResolver,reviewIndex:ctx.o.reviewIndex,objectBounds:ctx.o.objectBounds});
  }
  function paintNotebook(c, doc, ctx, projection) {
    const paint=()=>ctx.o.notebook.draw(c,projection);
    if (ctx.o.viewerLayers) c.withLayer(layerOf(doc,"Notes"),paint); else paint();
  }
  function notebook(page, doc, ctx) {
    if (!page.map || !ctx.o.notebook || doc.kind!=="schematic") return;
    const [x,y]=page.map([0,0]), [x1,y1]=page.map([1,0]), [x2,y2]=page.map([0,1]), sx=x1-x,sy=y2-y;
    const [l,t,r,b]=page.area, clip=[(l-x)/sx,(t-y)/sy,(r-x)/sx,(b-y)/sy], projection=notebookProjection(doc,ctx,clip);
    if (!projection?.length) return;
    const draw=PDF.recorder(page.w,page.h), c=draw.ctx;
    c.beginPath();c.rect(l,t,r-l,b-t);c.clip();c.setTransform(sx,y1-y,x2-x,sy,x,y);
    paintNotebook(c,doc,ctx,projection);
    page.list.push(...draw.list);
  }
  function attachData(pdf, project, o) {
    if (o.attachments) {
      const B=globalThis.AtriumBOM, N=globalThis.AtriumNetlistText;
      if (!B || !N) throw Error("Attaching the project BOM and netlist requires the BOM and netlist modules.");
      const encode=globalThis.AtriumZip.utf8;
      const boards=o.board ? [o.board] : N.boards(project).map(b=>b.id);
      if (!boards.length) boards.push(undefined);
      // Multiple independent layouts keep their individual, canonical electrical
      // projections. The first sorted board retains the standard attachment names.
      boards.forEach((board,index)=>{
        const suffix=index ? "-"+(index+1)+"-"+fileName(project.documents.find(d=>d.id===board)).slice(0,-4) : "";
        const bom=B.report(project,{titleBlock:false,variant:o.variant,board});
        pdf.attach({name:"bom"+suffix+".csv",mime:"text/csv",bytes:encode(B.csv(bom))});
        pdf.attach({name:"netlist"+suffix+".txt",mime:"text/plain",bytes:encode(N.compile(project,{board}).text)});
      });
    }
    if (o.projectArchive) {
      const a=o.projectArchive;
      if (o.snapshotId==null || a.snapshotId!==o.snapshotId || !/\.zip$/i.test(a.name)) throw Error("The project archive belongs to a different saved snapshot.");
      pdf.attach({name:a.name,mime:"application/zip",bytes:a.bytes});
    }
  }
  // The synchronous writer receives its data from one snapshot. The preview uses
  // the current document without acquiring a saved export lease.
  function prepareNotebook(project, ids, resolveAsset, options) {
    const notebook=notebookEnabled(), output=globalThis.AtriumNotebookOutput;
    if (notebook && output) return output.prepare(project,ids,resolveAsset);
    const compat=globalThis.AtriumNotebookCompat;
    if (!notebook && compat?.prepare) return compat.prepare(project,ids,resolveAsset,options);
    const chosen=Array.isArray(ids) ? new Set(ids) : null;
    if (!project.documents.some(doc=>doc.kind==="schematic" && (!chosen || chosen.has(doc.id)) &&
        doc.items.some(item=>A().notebookItemKind?.(item)))) return null;
    const lazy=globalThis.AtriumLazy;
    if (!notebook) return !compat && lazy?.need("AtriumNotebookCompat").then(module=>module.prepare?.(project,ids,resolveAsset,options));
    if (lazy) return lazy.need("AtriumNotebookOutput").then(module=>module.prepare(project,ids,resolveAsset));
    return null;
  }
  async function prepareDocument(project, options, providers, consume) {
    const o = settle(options), original = project, notebook = notebookEnabled();
    const labsSignal = notebook ? globalThis.AtriumLabs?.notebookSignal() : null;
    const host = globalThis.AtriumNavHost;
    const folder = host?.project?.() === project ? host.folderProject?.() : null;
    const checkCancel = () => { if (o.signal?.aborted || labsSignal?.aborted) throw Error("PDF export cancelled."); };
    let lease, assets;
    try {
      checkCancel();
      if (o.includeProject) {
        if (!providers.acquireSavedExportSnapshot) throw Error("A saved portable project snapshot is required to attach the project ZIP.");
        lease=await providers.acquireSavedExportSnapshot({project,signal:o.signal});
        if (lease==null) throw Error("PDF export cancelled.");
        if (!lease?.project || lease.snapshotId==null) throw Error("No saved project snapshot is available.");
        checkCancel();
        project=lease.project;
        o.snapshotId=lease.snapshotId;
        o.projectArchive=await lease.projectArchive({signal:o.signal});
        if (!o.projectArchive || o.projectArchive.snapshotId !== o.snapshotId)
          throw Error("The project archive is unavailable for this saved snapshot.");
      } else project=A().clone(project);
      checkCancel();
      const resolveAsset = lease ? request => lease.resolveAsset?.({...request,signal:o.signal}) ?? null :
        providers.resolveAsset || o.resolveAsset || (request=>folder?.readAsset(request));
      if (o.attachments && globalThis.AtriumLazy?.need) await globalThis.AtriumLazy.need(["AtriumBOM","AtriumNetlistText"]);
      if (project.variantApplied===undefined && globalThis.AtriumVariants) project=globalThis.AtriumVariants.forOutput(project,o.variant);
      const jobs=plan(project,settle(o)).filter(j=>j.kind==="schematic");
      if (jobs.length) {
        const documentIds=[...new Set(jobs.map(j=>j.doc.id))];
        if (providers.loadNotebookModules && notebook)
          await providers.loadNotebookModules(globalThis.AtriumNotebookOutput?.roots(project,documentIds) ?? []);
        checkCancel();
        await prepareNotebook(project,documentIds,resolveAsset,{includeNotes:o.includeNotes});
        checkCancel();
        const windows=jobs.map(j=>({sheetId:j.doc.id,clip:j.viewport ? viewportBounds(j) : j.box || SCH()?.pageBounds(j.doc),purpose:"print"}));
        const clipsBySheet=new Map();
        for (const {sheetId,clip} of windows) if (clip) {
          if (!clipsBySheet.has(sheetId)) clipsBySheet.set(sheetId,[]);
          clipsBySheet.get(sheetId).push(clip);
        }
        const sheets = new Map(jobs.map(j=>[j.doc.id,j.doc]));
        const registered = new Set(globalThis.AtriumLazy?.modules?.() || []), modules = new Set();
        const widgetItems = new Map(), calculationSheets = new Set();
        for (const doc of sheets.values()) {
          const clips=clipsBySheet.get(doc.id);
          const visible=item=>!clips || clips.some(box=>
            item.x+(item.w || 0)>=box[0] && item.y+(item.h || 0)>=box[1] && item.x<=box[2] && item.y<=box[3]);
          for (const item of doc.items) {
            if (o.links!==false && ["port","offsheet","sheetsymbol"].includes(item.kind)) modules.add("AtriumSheetConnections");
            if (item.kind==="image" && item.asset || item.widget?.fallback?.assetRef ||
                notebook && item.widget?.state?.tableVersion===1 && item.widget.state.cells.some(c=>c.content?.kind==="image")) modules.add("AtriumNotebookImages");
            if (!notebook && item.kind==="imageMarkup") modules.add("AtriumSchNoteMarkup");
            if (!notebook || !(item.widget || item.calculation || item.kind==="calculation") || !visible(item)) continue;
            if (item.widget) {
              if (!widgetItems.has(doc.id)) widgetItems.set(doc.id,[]);
              widgetItems.get(doc.id).push(item);
            }
            if (item.calculation || item.kind==="calculation") calculationSheets.add(doc.id);
          }
        }
        const need=[...modules].filter(n=>registered.has(n) && !globalThis[n]);
        if (need.length) await globalThis.AtriumLazy.need(need);
        const prepareAssets=providers.prepareAssets || (modules.has("AtriumNotebookImages") && globalThis.AtriumNotebookImages?.prepareAssets);
        if (prepareAssets) {
          assets=await prepareAssets(project,{documentIds,windows:clipsBySheet,resolveAsset,decodeAsset:providers.decodeAsset,signal:o.signal});
          o.assets=assets?.assets || assets;
          o.assetNotes=assets?.notes;
        }
        const recordAPI=globalThis.AtriumCalculationRecords, records=providers.frozenCalculations || recordAPI?.frozen;
        const revision=o.snapshotId ?? o.revision;
        if (notebook && records) {
          o.calculationRecords=new Map();
          for (const job of jobs) {
            if (!calculationSheets.has(job.doc.id)) continue;
            const key=recordAPI ? recordAPI.scopeKey(job.doc.id,job.instanceId) : JSON.stringify([job.doc.id,job.instanceId ?? null]);
            if (!o.calculationRecords.has(key)) o.calculationRecords.set(key,
              await records(project,job.doc,revision,job.instanceId));
          }
        }
        const widgets=globalThis.AtriumSheetWidgets;
        const calculations=notebook ? recordAPI?.forOutput(project,revision,o.calculationRecords) : null;
        const defs=new Map(project.library.map(def=>[def.id,def]));
        o.widgetViews=new Map();
        if (widgets) for (const [sheetId,items] of widgetItems) {
          const views=new Map(), doc=sheets.get(sheetId);
          const context={...o.widgetContext,defs,revision,signal:o.signal,purpose:"print",calculation:calculations?.lookup};
          for (const item of items) {
            checkCancel();
            const view=providers.widgetView ? await providers.widgetView(project,doc,item,context) : widgets.view(project,doc,item,context);
            if (view) views.set(item.id,view);
          }
          o.widgetViews.set(sheetId,views);
        }
        const scene = providers.notebookScene || globalThis.AtriumMarkup?.notebookScene;
        if (notebook && !o.notebook && scene && o.includeNotes !== false) {
          o.notebook=await scene(project,{documentIds,windows,signal:o.signal,widgetViews:o.widgetViews,frozen:true});
        }
      }
      checkCancel();
      try { return consume(build(project,o)); }
      finally { SCH()?.setProject?.(globalThis.AtriumNavHost?.project?.() || original); }
    } finally { try { await assets?.release?.(); } finally { await lease?.release?.(); } }
  }
  const preparePDF=(project,options={},providers={})=>prepareDocument(project,options,providers,result=>result.bytes());
  function pageRecordLinks(project, doc, page) {
    const layout = globalThis.AtriumRichTextView?.recordLinkRects;
    if (!layout) return [];
    const links = [];
    for (const item of doc.items) {
      if (!item.richText) continue;
      for (const {href, world:[x,y,r,b]} of layout(project, doc, item)) {
        const rect = A().bounds([[x,y],[x,b],[r,y],[r,b]].map(page.map));
        const clipped = [Math.max(rect[0],page.area[0]), Math.max(rect[1],page.area[1]),
          Math.min(rect[2],page.area[2]), Math.min(rect[3],page.area[3])];
        if (clipped[2] > clipped[0] && clipped[3] > clipped[1]) links.push({href, rect:clipped});
      }
    }
    return links;
  }
  function build(project, options = {}) {
    if(!PDF.embeddedFont)globalThis.AtriumPDFFonts?.install();
    const o = settle(options), Ah = A();
    globalThis.AtriumNotebookFonts?.registerPDF?.(PDF);
    if (project.variantApplied===undefined && globalThis.AtriumVariants) project=globalThis.AtriumVariants.forOutput(project,o.variant);
    if (!globalThis.AtriumCanvas) throw Error("Printing needs the editor renderer (canvas.js).");
    const defs = new Map(project.library.map(d => [d.id, d])), notes = [...(o.assetNotes ?? [])], models = new Map(), geometry = new Map();
    const calculations = notebookEnabled() ? globalThis.AtriumCalculationRecords?.forOutput(project,o.snapshotId ?? o.revision,o.calculationRecords) : undefined;
    const note = m => { if (!notes.includes(m)) notes.push(m); };
    const jobs = plan(project, o, defs);
    if (!jobs.length) throw Error("Choose at least one document (and, for boards, a layer set) to print.");
    const S = SCH(), started = Date.now();
    S?.setProject?.({...project, parameters: parametersFor(project, o.parameters,o.date)});
    const pages = [], metadata = jobs.some(j=>j.kind==="schematic") && (o.links || o.bookmarks || o.searchable) ?
      electrical(project,defs) : {names:new WeakMap(),targets:()=>[]};
    try {
      for (const job of jobs) {
        const pageOptions = job.infinite ? {...o, scale: o.infiniteLayout === "tile" ? o.infiniteScale : "fit", tile: o.infiniteLayout === "tile"} : o;
        const ctx = {project, doc: job.doc, defs, o: pageOptions, models, geometry, calculations, note};
        let made;
        try { made = job.viewport ? viewportPage(job, ctx) : job.kind === "assembly" ? assemblyPage(job, ctx) : job.kind === "drill" ? drillPage(job, ctx) : job.kind === "drawing" ? drawingPages(job, ctx) : canvasPage(job, ctx); }
        catch (e) { if (job.infinite || job.viewport) throw e; note(job.title + ": " + (e.message || e)); continue; }
        for (const page of Array.isArray(made) ? made : [made]) {
          if (!job.viewport) notebook(page,job.doc,ctx);
          Object.assign(page, {title: job.kind === "drawing" && !job.viewport ? page.title : job.title + (page.tile ? " — tile " + (page.tile.index + 1) + " of " + page.tile.count : ""), label: job.kind === "drawing" && !job.viewport ? page.label : job.label, doc: job.doc.id, kind: job.kind, set: job.set?.id || null, flip: !!(job.camera?.flipped || job.set?.flip)});
          if (job.viewport) Object.assign(page,{viewId:job.id, sourceLink:job.uri});
          if (o.links && o.recordLinks && job.doc.kind === "schematic" && page.map)
            page.recordLinks = pageRecordLinks(project, page.rendered ?? job.doc, page);
          page.marks = o.links || o.bookmarks || o.searchable || o.properties ? marksFor(page, page.rendered ? {...job, doc:page.rendered} : job, defs,metadata) : [];
          delete page.rendered;
          pages.push(page);
        }
      }
    } finally { S?.setProject?.(project); }
    if (!pages.length) throw Error(notes[0] || "Nothing to print.");
    const destination = (k,m) => ({page:k,x:Math.max(0,m.at[0]-72),y:Math.max(0,m.at[1]-72)});
    const endpointKey = (doc,id,entry) => JSON.stringify([doc,id,entry ?? null]);
    const ports = new Map(), parts = new Map(), firstPage = new Map();
    const append = (index,key,hit) => { if (!index.has(key)) index.set(key,[]); index.get(key).push(hit); };
    pages.forEach((p,k) => {
      if (!firstPage.has(p.doc)) firstPage.set(p.doc,k);
      for (const m of p.marks) {
        if (m.key?.startsWith("port:")) append(ports,endpointKey(p.doc,m.item.id,m.entry?.id),{k,m});
        if (m.kind==="part") append(parts,p.kind+"/"+m.key,{k,m,flip:p.flip});
      }
    });
    // Smart PDF cross references.
    const links = [], linkedParts = new Set();
    if (o.links) pages.forEach((p, n) => {
      if (p.sourceLink && p.linkRect) links.push([n,p.linkRect,{uri:p.sourceLink}]);
      for (const {href, rect} of p.recordLinks ?? []) links.push([n,rect,{uri:href}]);
      for (const m of p.marks) {
        if (!m.key) continue;
        let target = null;
        if (m.key.startsWith("part:")) {
          const hits=parts.get((p.kind==="pcb" ? "schematic" : "pcb")+"/"+m.key) || [];
          const side=hits.find(hit=>hit.flip===(hit.m.item.layer==="Bottom")) || hits[0];
          if (side) target=destination(side.k,side.m);
        } else if (m.key.startsWith("sheet:")) {
          const k = firstPage.get(m.key.slice(6));
          if (k !== undefined) target = {page: k, x: 0, y: 0};
        } else if (m.key.startsWith("port:")) {
          const hits=metadata.targets(p.doc,m,p.instance).flatMap(t=>ports.get(endpointKey(t.doc.id,t.item.id,t.entry?.id)) || []);
          const hit=hits.filter(h=>h.k!==n).sort((a,b)=>(a.k-n+pages.length)%pages.length-(b.k-n+pages.length)%pages.length)[0];
          if (hit) target=destination(hit.k,hit.m);
        }
        if (target) {
          links.push([n,(o.properties ?? o.links) && m.linkRect || m.rect,target]);
          if (m.kind==="part") linkedParts.add(m);
        }
      }
    });
    const outline = [];
    if (o.bookmarks && o.presentation) {
      pages.forEach((p,page) => outline.push({title:p.title,page,x:0,y:0}));
    } else if (o.bookmarks) {
      const docs = [...new Set(pages.map(p => p.doc))];
      for (const id of docs) {
        const doc = project.documents.find(d => d.id === id), first = pages.findIndex(p => p.doc === id), own = pages.map((p, k) => [p, k]).filter(([p]) => p.doc === id);
        const parts = new Map(), nets = new Map();
        for (const [p, k] of own) for (const m of p.marks) {
          if (m.key?.startsWith("part:") && !parts.has(m.item.ref)) parts.set(m.item.ref || m.key.slice(5), {title: (m.item.ref || "?") + (m.item.value ? " — " + m.item.value : ""), page: k, x: m.at[0], y: m.at[1]});
          if (m.net && !nets.has(m.net)) nets.set(m.net, {title:m.net,...destination(k,m)});
        }
        const sorted = map => [...map.keys()].sort(natural).map(k => map.get(k));
        const children = doc.kind === "pcb" || doc.kind === "drawing" || own.some(([p]) => p.frame) ? own.map(([p, k]) => ({title: p.label, page: k, x: 0, y: 0})) : [];
        if (parts.size) children.push(...(doc.kind === "pcb" ? [{title: "Components", children: sorted(parts)}] : sorted(parts)));
        if (nets.size) children.push({title: "Nets", children: sorted(nets)});
        outline.push({title: doc.name, page: first, x: 0, y: 0, open: doc.kind === "pcb", children});
      }
    }
    const elapsed = Date.now() - started;
    return {pages, notes, links: links.length, elapsed, options: o,
      bytes(extra = {}) {
        const pdf = PDF.document({title: o.title || project.name, subject: "Waffle print", date: o.date instanceof Date ? o.date : null, compress: o.compress});
        for (const p of pages) pdf.page(p.w, p.h, o.searchable ? p.list.concat(searchable(p,o.viewerLayers)) : p.list);
        for (const [n, rect, target] of links) pdf.link(n, rect, target);
        if (o.properties ?? o.links) pages.forEach((p,n)=>{
          for (const m of p.marks) if (m.kind==="part") {
            pdf.note(n,linkedParts.has(m) ? m.noteRect : m.rect,partNote(m.item,defs.get(m.item.def),p.kind));
          }
        });
        attachData(pdf,project,o);
        if (outline.length) pdf.outline(outline);
        return pdf.bytes(extra);
      }};
  }
  function exportPDF(project, options={}) {
    const pending=prepareNotebook(project,options.documents,options.resolveAsset,{includeNotes:options.includeNotes});
    return pending ? pending.then(()=>build(project,options).bytes()) : build(project,options).bytes();
  }
  Object.assign(PDF, {recorder, svg, export: exportPDF});

  // ------------------------------------------------------------ browser print
  // Pages are mounted as SVG in a print-only container (print.css hides the
  // editor). macOS (WKWebView has no window.print) and Linux hosts print natively
  // through AtriumHost.printPDF; browsers use window.print().
  function mount(result) {
    unmount();
    const root = document.createElement("div"); root.id = "atrium-print-root";
    const sizes = new Map(), style = document.createElement("style");
    root.append(style);
    for (const p of result.pages) {
      const sheet = document.createElement("div"); sheet.className = "atrium-print-page";
      const size = (p.w / MM).toFixed(3) + "mm " + (p.h / MM).toFixed(3) + "mm";
      if (!sizes.has(size)) sizes.set(size, "waffle" + sizes.size);
      sheet.style.page = sizes.get(size);
      sheet.innerHTML = PDF.svg(p.w, p.h, p.list, {width: p.w / MM, height: p.h / MM, unit: "mm"});
      root.append(sheet);
    }
    style.textContent = [...sizes].map(([size, name]) => "@page " + name + "{size:" + size + ";margin:0}").join("\n");
    document.body.append(root);
    return root;
  }
  function unmount() { document.getElementById("atrium-print-root")?.remove(); }
  async function print(project, options, name, providers={}) {
    const result=await prepareDocument(project,{...options,attachments:false,includeProject:false,projectArchive:undefined},providers,r=>r);
    return output(result, name || fileName(project));
  }
  // The one print path: every print (documents here, reports in print-report.js) ends in it.
  // result = {pages: [{w, h, list}], bytes()}. The app hosts get the PDF bytes (macOS: PDFKit and
  // the system print panel) and the mounted pages (Linux, Windows); only a plain browser uses
  // window.print. A failure is thrown for the caller's dialog status.
  async function output(result, name) {
    if (!result?.pages?.length) throw Error("There is nothing to print.");
    const job = String(name || "Waffle.pdf");
    const root = mount(result);
    try {
      if (globalThis.AtriumHost?.printPDF) return await AtriumHost.printPDF(job, result.bytes());
      if (globalThis.AtriumHost) throw Error("Printing is unavailable in this version of the app.");
      await new Promise(resolve => {
        let done = false; const finish = () => { if (!done) { done = true; resolve(); } };
        addEventListener("afterprint", finish, {once: true});
        globalThis.print(); setTimeout(finish, 600);
      });
      return true;
    } finally { setTimeout(() => root.remove(), 1000); }
  }
  const fileName = project => String(project.name || "Waffle").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim() + ".pdf";

  // ------------------------------------------------------------ dialog
  let remembered = null;
  try { remembered = JSON.parse(localStorage.getItem("atrium.print.v1") || "null"); } catch {}
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function dialogControls(dialog, changed) {
    const body = el("div", null, "print-body"), form = el("div", null, "print-form");
    const side = el("div", null, "print-preview"), status = el("p", null, "print-status");
    status.setAttribute("role", "status");
    const grid = el("div", null, "print-pages"), zoom = el("div", null, "print-zoom ui-page-zoom");
    zoom.hidden = true; zoom.onclick = () => { zoom.hidden = true; };
    side.append(grid, zoom); body.append(form, side);
    const urls = [];
    const releasePages = () => urls.splice(0).forEach(url => URL.revokeObjectURL(url));
    function paintPages(pages, svgFor, caption) {
      releasePages();
      grid.replaceChildren(...pages.map((p, n) => {
        const thumb = el("button", null, "print-thumb"); thumb.type = "button"; thumb.title = p.title;
        const img = el("img", null, "ui-page-art"), url = URL.createObjectURL(new Blob([svgFor(p)], {type: "image/svg+xml"}));
        urls.push(url); img.src = url; img.alt = p.title; img.style.aspectRatio = p.w + " / " + p.h;
        thumb.append(img, el("span", caption(p, n + 1)));
        thumb.onclick = () => { zoom.replaceChildren(img.cloneNode()); zoom.hidden = false; };
        return thumb;
      }));
    }
    function choice(label, values, value, onSelect) {
      const row = el("label", null, "print-row"), select = el("select", null, "ui-field");
      for (const [key, text] of values) { const option = el("option", text); option.value = String(key); select.append(option); }
      select.value = String(value);
      select.onchange = () => { onSelect(select.value); changed(); };
      row.append(el("span", label), select); return row;
    }
    const printBtn = el("button", "Print…"), pdfBtn = el("button", "Export PDF…"), close = el("button", "Close");
    for (const button of [printBtn, pdfBtn, close]) { button.type = "button"; button.classList.add("ui-button"); }
    dialog.addEventListener("atrium-print", e => { e.stopPropagation(); (e.detail?.mode === "pdf" ? pdfBtn : printBtn).click(); });
    return {body, form, status, choice, paintPages, clearPages: () => grid.replaceChildren(), releasePages, printBtn, pdfBtn, close};
  }
  function open(ctx, how = {}) {
    const project = ctx.project, docs = project.documents.filter(d => d.kind === "schematic" || d.kind === "pcb" || d.kind === "drawing" && globalThis.AtriumDrawing);
    if (!docs.length) { ctx.info?.("This project has no sheets or boards to print."); return; }
    const o = {...DEFAULTS, attachments:true, ...(remembered || {}), includeProject:false, documents: docs.map(d => d.id), parameters: {...(remembered?.parameters || {})}};
    const d = el("dialog", null, "work-dialog ui-dialog print-dialog"); d.setAttribute("aria-label", how.mode === "pdf" ? "Export PDF" : "Print");
    d.dataset.printTarget = "";
    const operation = new AbortController(), offLabs = globalThis.AtriumLabs?.onChange(() => d.close());
    const {body, form, status, choice, paintPages, clearPages, releasePages, printBtn, pdfBtn, close} = dialogControls(d, changed);
    const section = (title, ...rows) => { const s = el("fieldset"); s.append(el("legend", title), ...rows); form.append(s); return s; };
    const check = (label, on, fn) => { const l = el("label", null, "print-check"), b = el("input", null, "ui-checkbox"); b.type = "checkbox"; b.checked = on; b.onchange = () => { fn(b.checked); changed(); }; l.append(b, el("span", label)); return l; };
    // Documents.
    const current = ctx.doc?.id, chosen = new Set(how.documents || o.documents);
    const docBoxes = docs.map(doc => check(doc.name + (doc.kind === "pcb" ? " (board)" : doc.kind === "drawing" ? " (drawing)" : ""), chosen.has(doc.id), v => { v ? chosen.add(doc.id) : chosen.delete(doc.id); }));
    const quick = el("div", null, "print-quick");
    const pick = ids => () => { chosen.clear(); ids.forEach(i => chosen.add(i)); docBoxes.forEach((l, n) => { l.firstChild.checked = chosen.has(docs[n].id); }); changed(); };
    const all = el("button", "Whole project"); all.type = "button"; all.onclick = pick(docs.map(x => x.id));
    const cur = el("button", "Current document"); cur.type = "button"; cur.onclick = pick(current ? [current] : []);
    quick.append(all, cur);
    section("Documents", quick, ...docBoxes);
    const sets = new Set(o.layerSets);
    section("Board layer sets (one page each)", ...LAYER_SETS.map(s => check(s.name, sets.has(s.id), v => { v ? sets.add(s.id) : sets.delete(s.id); })));
    section("Page",
      choice("Paper", Object.keys(PAPER).map(k => [k, k + " · " + PAPER[k].map(v => +v.toFixed(1)).join(" × ") + " mm"]), o.paper, v => { o.paper = v; }),
      choice("Orientation", [["auto", "Automatic (per page)"], ["landscape", "Landscape"], ["portrait", "Portrait"]], o.orientation, v => { o.orientation = v; }),
      choice("Scale", [["fit", "Fit to page"], ["1", "1:1 (exact)"], ["2", "2:1"], ["4", "4:1"], ["0.5", "1:2"]], o.scale, v => { o.scale = v === "fit" ? "fit" : +v; }),
      choice("Margins", [[5, "5 mm"], [10, "10 mm"], [15, "15 mm"], [20, "20 mm"]], o.margin, v => { o.margin = +v; }),
      check("Tile at 1:1 when larger than the paper (drawings, fixed scales)", o.tile !== false, v => { o.tile = v; }));
    if (docs.some(doc => doc.sheet?.infinite === true)) {
      const ratio = el("label", null, "print-row"), input = el("input", null, "ui-field");
      input.type = "number"; input.step = "any"; input.min = "0.000001"; input.value = String(o.infiniteScale || 1);
      input.oninput = () => { if (input.valueAsNumber > 0) { o.infiniteScale = input.valueAsNumber; changed(); } };
      ratio.append(el("span", "Tile scale (1 = 1:1)"), input);
      const layout = choice("Layout", INFINITE_LAYOUTS, settle(o).infiniteLayout, v => { o.infiniteLayout = v; ratio.hidden = v !== "tile"; });
      ratio.hidden = settle(o).infiniteLayout !== "tile";
      section("Infinite sheets", layout, ratio);
    }
    section("Output",
      choice("Colour", [["color", "Colour"], ["grey", "Greyscale"], ["mono", "Monochrome"]], o.color, v => { o.color = v; }),
      check("White schematic sheet", o.whiteBackground, v => { o.whiteBackground = v; }),
      check("Links and bookmarks (Smart PDF)", o.links, v => { o.links = o.bookmarks = v; }),
      check("Board footer and scale bar", o.footer, v => { o.footer = v; }),
      check("Include comments", !!o.comments, v => { o.comments = v; needComments(); }));
    const providers={...ctx.pdfProviders}, host=globalThis.AtriumNavHost;
    if (notebookEnabled() && !providers.acquireSavedExportSnapshot && host?.folderProject?.() &&
        (globalThis.AtriumProjectArchiveUI || globalThis.AtriumLazy?.modules?.().includes("AtriumProjectArchiveUI"))) {
      providers.acquireSavedExportSnapshot=async args=>{
        const archive=globalThis.AtriumProjectArchiveUI || await globalThis.AtriumLazy.need("AtriumProjectArchiveUI");
        return (archive.chooseSavedExportSnapshot || archive.acquireSavedExportSnapshot)({...args,host});
      };
    }
    const archive=check("Attach portable project ZIP",false,v=>{o.includeProject=v;});
    archive.firstChild.disabled=!providers.acquireSavedExportSnapshot;
    archive.title=archive.firstChild.disabled ? "Requires a saved portable project snapshot." : "Pages, BOM, netlist and ZIP use the same saved project.";
    if (notebookEnabled()) section("Smart PDF",check("Viewer layers",o.viewerLayers,v=>{o.viewerLayers=v;}),
      choice("Schematic notes",[["sheet","Sheet print setting"],["yes","Include"],["no","Exclude"]],
        o.includeNotes==null ? "sheet" : o.includeNotes ? "yes" : "no",v=>{o.includeNotes=v==="sheet" ? undefined : v==="yes";}),
      check("Part property notes",o.properties ?? o.links,v=>{o.properties=v;}),
      check("Attach whole-project BOM and netlist",o.attachments,v=>{o.attachments=v;}),archive);
    // review-comments: comment pins stay out of outputs unless chosen here; the module loads on demand.
    const needComments = () => { if (o.comments && !globalThis.AtriumReviewComments) globalThis.AtriumLazy?.need?.("AtriumReviewComments").then(() => changed(), () => {}); };
    needComments();
    const params = el("div", null, "print-params");
    for (const [key, label] of [["DocumentNumber", "Document number"], ["Revision", "Revision"], ["DrawnBy", "Drawn by"], ["CompanyName", "Company"]]) {
      const l = el("label", null, "print-row"), input = el("input", null, "ui-field"); input.value = o.parameters[key] || ""; input.placeholder = "From the sheet or project";
      input.oninput = () => { o.parameters[key] = input.value; changed(); }; l.append(el("span", label), input); params.append(l);
    }
    section("Title block values", params, el("small", "Sheet parameters win; these fill blanks for this print (=DocumentNumber, =Revision…)."));
    let timer = 0, busy = false, revision = 0, preview;
    const options = () => ({...o, documents: docs.filter(x => chosen.has(x.id)).map(x => x.id), layerSets: LAYER_SETS.filter(s => sets.has(s.id)).map(s => s.id)});
    const activeOptions = () => notebookEnabled() ? options() : {...options(),includeNotes:undefined};
    function changed() {
      revision++; preview?.abort(); clearTimeout(timer); timer = setTimeout(refresh, 160);
      try { const {documents, ...keep} = options(); void documents; localStorage.setItem("atrium.print.v1", JSON.stringify(keep)); remembered = keep; } catch {}
    }
    async function refresh() {
      const ticket=++revision, selected=activeOptions();
      preview=new AbortController();
      const opened=preview;
      let result, pages;
      const record=output=>{
        result=output;
        return output.pages.map(p=>({title:p.title,w:p.w,h:p.h,svg:PDF.svg(p.w,p.h,p.list)}));
      };
      try {
        const media=docs.some(doc=>chosen.has(doc.id) && doc.items.some(item=>item.kind==="image" && item.asset || item.widget?.fallback?.assetRef));
        if (media) {
          pages=await prepareDocument(project,{...selected,includeProject:false,attachments:false,signal:opened.signal},providers,record);
        } else {
          await prepareNotebook(project,selected.documents,providers.resolveAsset,{includeNotes:selected.includeNotes});
          if (opened.signal.aborted || !d.open) return;
          pages=record(build(project,selected));
        }
      } catch (e) {
        if (ticket===revision && d.open) { clearPages(); status.textContent=e.message || String(e); }
        return;
      }
      if (ticket!==revision || !d.open) return;
      paintPages(pages, p => p.svg, (p, n) => n + ". " + p.title);
      status.textContent = result.pages.length + " page" + (result.pages.length === 1 ? "" : "s") + " · " + result.links + " cross-reference links · built in " + result.elapsed + " ms" +
        (result.notes.length ? " · " + result.notes.join(" ") : "");
    }
    const actions = el("div", null, "work-actions ui-dialog-actions");
    const run = fn => async () => {
      if (busy) return; busy = true; status.textContent = "Working…";
      try { await fn(); } catch (e) { status.textContent = e.message || String(e); } finally { busy = false; }
    };
    // Match the primary action to the command that opened the dialog.
    const primary = how.mode === "pdf" ? pdfBtn : printBtn, secondary = primary === pdfBtn ? printBtn : pdfBtn;
    primary.classList.add("is-primary"); primary.dataset.variant = "primary"; primary.dataset.uiDefault = "false";
    printBtn.onclick = run(async () => {
      const done = await print(project,{...activeOptions(),signal:operation.signal},undefined,providers);
      status.textContent = done === false ? "Printing cancelled." : "Sent to the printer.";
    });
    pdfBtn.onclick = run(async () => {
      const t = Date.now(), bytes = await preparePDF(project, {...activeOptions(),signal:operation.signal},providers), name = fileName(project);
      if (operation.signal.aborted) return;
      if (await ctx.exportFile(name, bytes)) { status.textContent = "Exported " + name + " · " + Math.round(bytes.length / 1024) + " KB in " + (Date.now() - t) + " ms"; ctx.info?.("Exported " + name); }
    });
    close.onclick = () => d.close();
    actions.append(status, close, secondary, primary);
    const title = el("h2", how.mode === "pdf" ? "Export PDF" : "Print");
    d.append(title, body, actions);
    globalThis.AtriumShell.openDialog(d, {title, body, actions, initialFocus: () => form.querySelector("select, input, button"),
      onClose() {
        offLabs?.(); clearTimeout(timer); preview?.abort(); operation.abort();
        releasePages();
      }});
    refresh();
    return d;
  }

  return Object.freeze({open, dialogControls, build, exportPDF, prepareDocument, preparePDF, print, output, plan, settle, PAPER, LAYER_SETS, DEFAULTS, inkFor, drawSVG, mount, unmount});
})();
