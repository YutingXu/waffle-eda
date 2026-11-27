"use strict";

// IPC-2581 revision B export (File → Output Job Sets, MCP run_output_job).
//
// Revision B (IPC-2581B, 2013, with amendment 1, 2016) is the revision most
// CAM systems and board houses import (Valor, Genesis, CAM350, Altium,
// Allegro, KiCad 8+). Revision C (2020) adds DFx and BOM detail that importers
// adopt more slowly; this writer emits B.
//
// The board geometry comes from AtriumFabOutputs.analyse, the same model the
// Gerber and drill writers plot, so the XML and the Gerbers agree feature for
// feature: every copper, mask and paste flash becomes a Pad, every track and
// stroke a Line or Polyline, every pour and filled region a Contour (with
// Cutouts for holes), and every drill hit a Hole on its span's drill layer.
// The physical stack-up (materials, Dk/Df, thicknesses) comes from
// AtriumStackup, drill layers from the via spans the fab model resolves.
//
// Element order and attribute names follow the IPC-2581B schema as far as it
// could be reconstructed without the (paid) XSD, cross-checked against the
// element order of KiCad's IPC-2581 exporter. `check()` is a structural
// checker built from that knowledge: well-formedness, required elements and
// attributes, enumerations, child order and every cross-reference. It is not
// a substitute for XSD validation; see CHECK_NOTES.
//
// Coordinates: millimetres (or inches), Y up, from the same origin as the
// fabrication outputs ("auto": the board origin, else the lower-left corner of
// the outline). Angles are counter-clockwise degrees.
globalThis.AtriumIPC2581 = (() => {
  const REVISION = "B", NS = "http://webstds.ipc.org/2581";
  const CHECK_NOTES = Object.freeze([
    "The IPC-2581B XSD is not freely available, so the file was not validated against it.",
    "check() enforces the elements, attributes, enumerations, child order and references this writer relies on, reconstructed from IPC-2581B and KiCad's exporter.",
    "Optional details whose exact schema spelling is least certain (impedance Spec, PhyNetPoint attributes) are kept to the common subset; impedance Specs are opt-in."
  ]);
  const F = () => globalThis.AtriumFabOutputs || (() => { throw Error("IPC-2581 export needs the fabrication outputs module (fab-outputs.js)."); })();

  // ---------------------------------------------------------------- text helpers
  // Most values are numbers or plain names: one test, and the three replacements only when needed.
  const ESC_ANY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff\ud800-\udfff&<>"]/;
  const esc = s => typeof s === "number" ? String(s) : (s = String(s ?? ""), ESC_ANY.test(s) ? escAll(s) : s);
  const escAll = s => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(^|[^\ud800-\udbff])[\udc00-\udfff]/g, "$1")
    .replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"})[c]);
  const trim = (v, d) => {
    let s = (+v).toFixed(d);
    if (s.indexOf(".") >= 0) { let e = s.length; while (s.charCodeAt(e - 1) === 48) e--; if (s.charCodeAt(e - 1) === 46) e--; s = s.slice(0, e); }
    return s === "-0" ? "0" : s;
  };
  const norm360 = a => { const r = ((a % 360) + 360) % 360; return Math.abs(r - 360) < 1e-9 ? 0 : r; };
  const attrs = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => " " + k + "=\"" + esc(v) + "\"").join("");
  const tag = (name, o, inner) => inner == null || inner === "" ? "<" + name + attrs(o || {}) + "/>" : "<" + name + attrs(o || {}) + ">" + inner + "</" + name + ">";
  const ident = s => String(s ?? "").replace(/[^\w.\-+]+/g, "_").replace(/^_+|_+$/g, "") || "X";

  // ---------------------------------------------------------------- export
  // build(project, board, options) -> {name, content, stats, warnings}
  // options: fabrication options (origin, mask/paste expansion, tentVias, ...)
  //   plus units ("mm" | "in"), date (Date), impedance (bool: opt-in impedance
  //   Specs on controlled nets), phyNets (bool, default true).
  function build(project, requested, options = {}) {
    const FO = F(), model = options.model || FO.analyse(project, requested), {model: _m, ...rest} = options, o = FO.settle({...rest, units: options.units === "in" ? "in" : "mm"});
    const doc = model.doc, defs = model.defs, warnings = [...FO.warnings(model)];
    const inch = o.units === "in", k = inch ? 1 / 25.4 : 1, dp = inch ? 7 : 6, unitName = inch ? "INCH" : "MILLIMETER";
    const n = v => trim(v * k, dp);
    const locate = FO.projectCam(FO.originFor(model, o), n);
    const xy = p => { const [x, y] = locate(p); return {x, y}; };
    const stepName = ident(doc.name || "Board"), stats = {pads: 0, lines: 0, contours: 0, holes: 0, components: 0, packages: 0, nets: 0, layers: 0};
    const date = o.date, when = FO.isoDate(date);

    // ---- layers
    const layerName = new Map(), layerDefs = [];
    const addLayer = (key, name, fn, side, extra) => { layerName.set(key, name); layerDefs.push({key, name, fn, side, polarity: "POSITIVE", ...extra}); return name; };
    const copperName = key => key === "Top" ? "TOP" : key === "Bottom" ? "BOTTOM" : "INNER_" + (/\d+/.exec(key)?.[0] || key);
    const ST = globalThis.AtriumStackup;
    let stack = null;
    try { stack = (!model.panel && model.physicalStack) || (ST ? ST.get(doc, defs) : null); } catch { stack = null; }
    const stackCopper = stack ? stack.layers.filter(l => l.type === "Signal" || l.type === "Plane") : [];
    const copperType = key => stackCopper.find(l => l.key === key)?.type === "Plane" ? "PLANE" : "SIGNAL";
    // Silk, mask and paste follow the copper and dielectric order of the stack.
    addLayer("Silk", "SILKSCREEN_TOP", "SILKSCREEN", "TOP");
    addLayer("Top paste", "SOLDERPASTE_TOP", "SOLDERPASTE", "TOP");
    addLayer("Top mask", "SOLDERMASK_TOP", "SOLDERMASK", "TOP");
    const stackRows = [];
    if (stack && stackCopper.length === model.stack.length && stackCopper.every((l, i) => l.key === model.stack[i])) {
      let dielectric = 0, other = 0, seenCopper = false;
      for (const l of stack.layers) {
        if (l.type === "Signal" || l.type === "Plane") {
          seenCopper = true;
          addLayer(l.key, copperName(l.key), copperType(l.key), l.key === "Top" ? "TOP" : l.key === "Bottom" ? "BOTTOM" : "INTERNAL");
          stackRows.push({layer: copperName(l.key), l});
        } else if (l.type === "Dielectric" || l.type === "Adhesive" || l.type === "Coverlay") {
          const name = "DIELECTRIC_" + ++dielectric;
          addLayer("dielectric:" + dielectric, name, l.type === "Adhesive" ? "DIELADHV" : l.type === "Coverlay" ? "DIELBASE" : l.dielectric === "Prepreg" ? "DIELPREG" : "DIELCORE", "INTERNAL");
          stackRows.push({layer: name, l});
        } else if (l.type === "Solder Mask") stackRows.push({layer: seenCopper ? "SOLDERMASK_BOTTOM" : "SOLDERMASK_TOP", l});
        else if (l.type === "Stiffener") {
          const name = "STIFFENER_" + ++other;
          addLayer("stiffener:" + other, name, "OTHER", seenCopper ? "BOTTOM" : "TOP");
          stackRows.push({layer: name, l});
        }
      }
    } else {
      if (stack) warnings.push("The stored layer stack does not match the copper layers plotted; the IPC-2581 stack-up was left out.");
      for (const key of model.stack) addLayer(key, copperName(key), copperType(key), key === "Top" ? "TOP" : key === "Bottom" ? "BOTTOM" : "INTERNAL");
    }
    addLayer("Bottom mask", "SOLDERMASK_BOTTOM", "SOLDERMASK", "BOTTOM");
    addLayer("Bottom paste", "SOLDERPASTE_BOTTOM", "SOLDERPASTE", "BOTTOM");
    addLayer("Bottom silk", "SILKSCREEN_BOTTOM", "SILKSCREEN", "BOTTOM");
    // Rigid-flex coverlay and stiffener drawings (fab-outputs flex layers).
    for (const L of model.flex?.layers || []) if (!layerName.has(L.key)) addLayer(L.key, ident(L.key).toUpperCase(), "OTHER", /^Bottom/.test(L.key) ? "BOTTOM" : "TOP");
    // IPC separates routed slots from round holes on the same drill span.
    const groups = FO.drillGroups(model).flatMap(g => {
      const slots = g.hits.filter(h => h.endpoints);
      if (!slots.length) return [g];
      return [{...g, hits: g.hits.filter(h => !h.endpoints)}, {...g, hits: slots, slots: true}].filter(row => row.hits.length);
    }), drillLayer = new Map();
    for (const g of groups) {
      const from = copperName(model.stack[g.span[0]]), to = copperName(model.stack[g.span[1]]), last = model.stack.length - 1;
      const kind = g.backdrill ? "BACKDRILL" : g.laser ? "LASER" : !g.plated ? "NPTH" : "PTH";
      let name = (g.slots ? "SLOT_" : "DRILL_") + kind + "_" + from + "_" + to + (g.region ? "_" + ident(g.region.name).toUpperCase() : "");
      while (layerDefs.some(l => l.name === name)) name += "_";
      const side = g.span[0] === 0 && g.span[1] === last ? "ALL" : g.span[0] === 0 ? "TOP" : g.span[1] === last ? "BOTTOM" : "INTERNAL";
      layerDefs.push({key: name, name, fn: g.slots ? "ROUT" : "DRILL", side, polarity: "POSITIVE", span: g.backdrill === "bottom" ? [to, from] : [from, to]});
      drillLayer.set(g, name);
    }
    if (groups.some(g => g.backdrill)) warnings.push("Back-drills are written as non-plated DRILL layers spanning the removed stub (from the drilled side).");
    stats.layers = layerDefs.length;

    // ---- dictionaries
    const prims = new Map(), lines = new Map();
    function prim(g) {
      const w = n(g.w), h = n(g.h);
      let key, body;
      if (g.shape === "circle") { key = "CIRCLE_" + w; body = tag("Circle", {diameter: w}); }
      else if (g.shape === "obround") { key = "OVAL_" + w + "x" + h; body = tag("Oval", {width: w, height: h}); }
      else if (g.shape === "ellipse") { key = "ELLIPSE_" + w + "x" + h; body = tag("Ellipse", {width: w, height: h}); }
      else if (g.shape === "roundrect" && g.r > 1e-9) { const r = n(g.r); key = "RECTROUND_" + w + "x" + h + "_" + r; body = tag("RectRound", {width: w, height: h, radius: r, upperRight: "true", upperLeft: "true", lowerRight: "true", lowerLeft: "true"}); }
      else if (g.shape === "octagon" && g.t > 1e-9) { const t = n(g.t); key = "RECTCHAM_" + w + "x" + h + "_" + t; body = tag("RectCham", {width: w, height: h, chamfer: t, upperRight: "true", upperLeft: "true", lowerRight: "true", lowerLeft: "true"}); }
      else if (g.shape === "custom" && g.poly?.length > 2) {
        // Custom polygon pads: a Contour in pad-local coordinates (Y up), rotated by the Pad's Xform.
        const q = g.poly.map(p => ({x: n(p[0]), y: n(-p[1])})), text = q.map(p => p.x + "," + p.y).join(";");
        let hash = 2166136261; for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
        key = "CONTOUR_" + q.length + "_" + hash.toString(16);
        body = "<Contour><Polygon>" + tag("PolyBegin", q[0]) + q.slice(1).map(p => tag("PolyStepSegment", p)).join("") + tag("PolyStepSegment", q[0]) + "</Polygon></Contour>";
      }
      else { key = "RECT_" + w + "x" + h; body = tag("RectCenter", {width: w, height: h}); }
      if (!prims.has(key)) prims.set(key, body);
      return key;
    }
    function line(width) {
      const w = n(width > 0 ? width : .1), key = "LINE_" + w;
      if (!lines.has(key)) lines.set(key, tag("LineDesc", {lineEnd: "ROUND", lineWidth: w}));
      return key;
    }
    const lineRef = width => tag("LineDescRef", {id: line(width)});
    const rotation = a => { const r = norm360(a); return r ? tag("Xform", {rotation: trim(r, 4)}) : ""; };

    // ---- geometry
    const poly = (pts, el = "Polygon") => {
      const q = pts.map(xy).filter((p, i, a) => !i || p.x !== a[i - 1].x || p.y !== a[i - 1].y);
      if (q.length > 1 && q[0].x === q.at(-1).x && q[0].y === q.at(-1).y) q.pop();
      if (q.length < 3) return "";
      return "<" + el + ">" + tag("PolyBegin", q[0]) + q.slice(1).map(p => tag("PolyStepSegment", p)).join("") + tag("PolyStepSegment", q[0]) + "</" + el + ">";
    };
    const contour = (outer, holes = []) => { const p = poly(outer); return p ? "<Contour>" + p + holes.map(h => poly(h, "Cutout")).join("") + "</Contour>" : ""; };
    // Revision B stores the absolute outline of a SlotCavity. Two semicircles
    // preserve its end radii and the straight portion uses the Excellon centres.
    function slotOutline([a, b], diameter) {
      const cutter = {kind: "slot", centerline: [{kind: "line", a, b}], diameter};
      const [{outer}] = globalThis.AtriumGeometryMaterial.cutterArea({cutter});
      return tag("Outline", {}, shapeLoop(outer, "Polygon") + tag("LineDesc", {lineEnd: "ROUND", lineWidth: "0"}));
    }
    const feature = body => "<Features>" + tag("Location", {x: "0", y: "0"}) + body + "</Features>";
    function polyline(points, width) {
      const q = points.map(xy).filter((p, i, a) => !i || p.x !== a[i - 1].x || p.y !== a[i - 1].y);
      if (!q.length) return "";
      if (q.length === 1) return "<Pad>" + tag("Location", q[0]) + tag("StandardPrimitiveRef", {id: prim({shape: "circle", w: width, h: width})}) + "</Pad>";
      if (q.length === 2) return feature(tag("Line", {startX: q[0].x, startY: q[0].y, endX: q[1].x, endY: q[1].y}, lineRef(width)));
      return feature("<Polyline>" + tag("PolyBegin", q[0]) + q.slice(1).map(p => tag("PolyStepSegment", p)).join("") + lineRef(width) + "</Polyline>");
    }
    function arcFeature(g, width) {
      const center = xy(g.c), sweep = A.arcSweep(g);
      const angles = Math.abs(sweep) === 360 ? [g.start, g.start + sweep / 2, g.start + sweep] : [g.start, g.end];
      return angles.slice(1).map((angle, i) => {
        const a = xy(A.arcPoint(g, angles[i])), b = xy(A.arcPoint(g, angle));
        return feature(tag("Arc", {startX:a.x, startY:a.y, endX:b.x, endY:b.y, centerX:center.x, centerY:center.y,
          clockwise:g.ccw ? "false" : "true"}, lineRef(width)));
      }).join("");
    }
    const shapeLoop = (c, el) => {
      const S = globalThis.AtriumBoardShape;
      if (!c.length) return "";
      const out = ["<" + el + ">", tag("PolyBegin", xy(S.head(c[0])))];
      for (const g of c) {
        if (g.kind === "arc") {
          const cc = xy(g.center ?? g.c), cutter = g.sweep != null;
          const q = xy(cutter ? A.arcPoint({c:g.center, r:g.radius}, g.start + g.sweep) : S.tail(g));
          out.push(tag("PolyStepCurve", {...q, centerX: cc.x, centerY: cc.y, clockwise: String(cutter ? g.sweep < 0 : !g.ccw)}));
        } else out.push(tag("PolyStepSegment", xy(g.b)));
      }
      return out.join("") + "</" + el + ">";
    };
    function profile() {
      const shape = model.boardShape;
      if (shape && globalThis.AtriumBoardShape)
        return shapeLoop(shape.contour, "Polygon") + (shape.cutouts || []).map(c => shapeLoop(c, "Cutout")).join("");
      if (model.outline.length) return poly(model.outline);
      const b = model.extents || [0, 0, 1, 1];
      warnings.push("The board has no closed outline; the IPC-2581 profile is the design extents.");
      return poly([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]);
    }

    // ---- packages and components
    const A = globalThis.Atrium, packages = new Map(), pkgNames = new Set(), refNames = new Map();
    function packageOf(part) {
      // A part's mirror flag reflects its footprint (pcb-appearance.js); the reflected footprint is its own package.
      const mirror = part.item.mirror === true, key = part.def.id + (mirror ? "/mirror" : "");
      if (packages.has(key)) return packages.get(key);
      const fp = A.pcbMirror.placed(part.item, part.fp).footprint;
      let name = ident(fp.name || part.def.footprintName || part.def.name || part.def.id) + (mirror ? "_MIRRORED" : "");
      while (pkgNames.has(name)) name += "_" + (pkgNames.size + 1);
      pkgNames.add(name);
      const pins = [], seen = new Set(), pts = [];
      for (const p of fp.pads || []) {
        const w = p.w || p.diameter, h = p.h || p.diameter;
        if (!(w > 0 && h > 0) || p.number == null || p.number === "") continue;
        let num = String(p.number);
        while (seen.has(num)) num += "'";
        seen.add(num);
        const g = FO.padGeom(FO.padShape(p.shape, w, h) || "rect", w, h, 0);
        pins.push({number: num, at: [p.x, -p.y], angle: -(p.angle || 0), prim: prim(g), thru: p.drill > 0});
        pts.push([p.x - w / 2, p.y - h / 2], [p.x + w / 2, p.y + h / 2]);
      }
      for (const s of fp.shapes || []) {
        if (s.kind === "circle" && s.r > 0) pts.push([s.x - s.r, s.y - s.r], [s.x + s.r, s.y + s.r]);
        else for (const q of s.points || []) pts.push(q);
      }
      const b = pts.length ? A.bounds(pts) : [-.5, -.5, .5, .5];
      const local = p => ({x: n(p[0]), y: n(p[1])});
      const outline = [[b[0], -b[3]], [b[2], -b[3]], [b[2], -b[1]], [b[0], -b[1]]].map(local);
      const pkg = {name, pins, thru: pins.some(p => p.thru), pinOne: pins[0]?.number,
        outline: "<Polygon>" + tag("PolyBegin", outline[0]) + outline.slice(1).map(p => tag("PolyStepSegment", p)).join("") + tag("PolyStepSegment", outline[0]) + "</Polygon>",
        local};
      packages.set(key, pkg);
      return pkg;
    }
    const comps = [];
    for (const part of model.parts) {
      const pkg = packageOf(part);
      let ref = String(part.item.ref || "").trim() || "UNNAMED";
      if (refNames.has(ref)) { let i = 2; while (refNames.has(ref + "_" + i)) i++; warnings.push("Duplicate designator " + ref + " was renamed " + ref + "_" + i + " in IPC-2581."); ref += "_" + i; }
      refNames.set(ref, part);
      const value = String(part.item.value ?? part.def.parameters?.Value ?? "").trim();
      comps.push({part, ref, pkg, value, oem: ident(pkg.name + (value ? "_" + value : "")), dnp: !!model.dnp?.has(part.item)});
    }
    stats.components = comps.length; stats.packages = packages.size;

    // ---- nets
    const logical = new Map(), refOf = new Map(comps.map(c => [c.part.item, c.ref]));
    for (const c of comps) {
      const it = c.part.item, seen = new Set();
      for (const p of c.part.fp.pads || []) {
        if (p.number == null || p.number === "" || seen.has(String(p.number))) continue;
        seen.add(String(p.number));
        const net = it.pinNets?.[p.number] ?? p.net;
        if (!net) continue;
        if (!logical.has(net)) logical.set(net, []);
        logical.get(net).push({componentRef: c.ref, pin: String(p.number)});
      }
    }
    stats.nets = logical.size;

    // ---- impedance specs (opt-in)
    const specs = [], impedance = new Map();
    let zOf = () => null;
    if (options.impedance && globalThis.AtriumRules?.resolver) {
      try {
        const resolve = AtriumRules.resolver(doc, {project});
        zOf = (net, layer) => { try { return resolve("width", {net, layer})?.impedance || null; } catch { return null; } };
      } catch { warnings.push("Design rules could not be read; impedance Specs were left out."); }
    }
    const impedanceSpec = (z, width) => {
      const name = "IMPEDANCE_" + ident(z.profile) + "_" + trim(z.target ?? z.z, 2) + "_" + n(width);
      if (!impedance.has(name)) {
        const tol = Number.isFinite(z.tolerance) ? {tolPlus: trim(z.tolerance, 3), tolMinus: trim(z.tolerance, 3), tolPercent: "true"} : {};
        impedance.set(name, tag("Spec", {name}, tag("Impedance", {type: "IMPEDANCE"}, tag("Property", {value: trim(z.target ?? z.z, 3), ...tol})) +
          tag("Impedance", {type: "LINEWIDTH"}, tag("Property", {value: n(width)}))));
      }
      return name;
    };

    // ---- layer features
    const featureXML = [], phy = new Map();
    const useOf = f => f.use === "via" ? "VIA" : f.use === "pad" ? "TERMINATION" : null;
    for (const L of layerDefs) {
      if (L.fn === "DRILL" || L.fn === "ROUT") continue;
      const list = model.layers.get(L.key);
      if (!list?.length) continue;
      const cu = model.stack.includes(L.key), sets = new Map(), order = [];
      const signed = list.some(f => f.polarity === "clear");
      const rank = key => key.startsWith("pour|") ? 0 : key === "clear" ? 1 : 2;
      let index = 0;
      const set = (key, a) => {
        if (signed && rank(key) === 2) key += "|" + index;
        if (!sets.has(key)) { sets.set(key, {a, pads: [], features: [], specs: new Set()}); order.push(key); }
        return sets.get(key);
      };
      for (const f of list) {
        index++;
        const before = options.plottedFeature ? stats.pads + stats.contours + stats.lines : 0;
        const clear = f.polarity === "clear", net = cu && !clear ? f.net || "" : "";
        const artwork = () => set("art|" + net, clear ? {polarity: "NEGATIVE"} : {net: net || undefined});
        if (f.t === "flash") {
          const g = FO.plotPad(f, o);
          if (!g) { options.plottedFeature?.(f, false, L.key); continue; }
          const at = xy(f.at), id = prim({...g, angle: 0}), use = cu ? useOf(f) : null;
          const pinRef = cu && f.use === "pad" && f.ref != null && f.pin != null && refNames.has(f.ref) ? tag("PinRef", {componentRef: f.ref, pin: f.pin}) : "";
          set("pad|" + net + "|" + use, clear ? {polarity: "NEGATIVE"} : {net: net || undefined, padUsage: use || undefined}).pads.push("<Pad>" + rotation(-g.angle) + tag("Location", at) + tag("StandardPrimitiveRef", {id}) + pinRef + "</Pad>");
          stats.pads++;
          if (cu && net && (L.key === "Top" || L.key === "Bottom") && options.phyNets !== false) {
            if (!phy.has(net)) phy.set(net, []);
            const tented = f.use === "via" && o.tentVias;
            phy.get(net).push(tag("PhyNetPoint", {x: at.x, y: at.y, layerRef: L.name, netNode: f.use === "via" ? "MIDDLE" : "END", exposure: tented ? "COVERED" : "EXPOSED", via: f.use === "via" ? "true" : undefined},
              tag("StandardPrimitiveRef", {id})));
          }
        } else if (f.t === "clear") {
          set("clear", {polarity: "NEGATIVE"}).pads.push("<Pad>" + tag("Location", xy(f.at)) + tag("StandardPrimitiveRef", {id: prim({shape: "circle", w: f.d, h: f.d})}) + "</Pad>");
        } else if (f.t === "pour") {
          const rings = f.rings.map(r => { const pts = []; for (let i = 0; i < r.length; i += 2) pts.push([r[i], r[i + 1]]); return pts; });
          const c = contour(rings[0], rings.slice(1));
          if (c) { set("pour|" + net, {net: net || undefined, geometry: "POUR"}).features.push(feature(c)); stats.contours++; }
        } else if (f.t === "region") {
          const c = f.contour ? "<Contour>" + shapeLoop(f.contour,"Polygon") + (f.holeContours ? f.holeContours.map(h=>shapeLoop(h,"Cutout")) : (f.holes||[]).map(h=>poly(h,"Cutout"))).join("") + "</Contour>" : contour(f.points,f.holes);
          if (c) { artwork().features.push(feature(c)); stats.contours++; }
        } else if (f.t === "stroke") {
          const body = f.arc ? arcFeature(f.arc, f.width) : polyline(f.points, f.width);
          if (!body) { options.plottedFeature?.(f, false, L.key); continue; }
          const s = artwork();
          if (body.startsWith("<Pad>")) { s.pads.push(body); stats.pads++; } else { s.features.push(body); stats.lines++; }
          if (cu && net) { const z = zOf(net, L.key); if (z) s.specs.add(impedanceSpec(z, f.width)); }
        } else if (f.t === "circle") {
          artwork().features.push(arcFeature({c:f.c, r:f.r, start:0, end:360, ccw:true}, f.width));
          stats.lines++;
        }
        options.plottedFeature?.(f, f.t === "clear" || stats.pads + stats.contours + stats.lines > before, L.key);
      }
      // Pours and plane knockouts precede authored film. Signed artwork stays in draw order.
      const body = order.sort((a, b) => rank(a) - rank(b)).map(key => {
        const s = sets.get(key);
        return tag("Set", s.a, s.pads.join("") + [...s.specs].map(id => tag("SpecRef", {id})).join("") + s.features.join(""));
      }).join("");
      if (body) featureXML.push(tag("LayerFeature", {layerRef: L.name}, body));
    }
    let hole = 0;
    for (const g of groups) {
      const byNet = new Map();
      for (const h of g.hits) {
        const net = h.net || "", status = g.backdrill || !g.plated ? "NONPLATED" : h.via ? "VIA" : "PLATED";
        const key = net + "|" + status;
        if (!byNet.has(key)) byNet.set(key, {net, holes: []});
        const name = "H" + ++hole, finish = {platingStatus: status, plusTol: "0", minusTol: "0"};
        byNet.get(key).holes.push(h.endpoints ? tag("SlotCavity", {name, ...finish}, slotOutline(h.endpoints, h.d))
          : tag("Hole", {name, diameter: n(h.d), ...finish, ...xy(h.at)}));
        stats.holes++;
        options.plottedFeature?.(h, true, drillLayer.get(g));
      }
      const body = [...byNet.values()].map(s => tag("Set", {net: s.net || undefined}, s.holes.join(""))).join("");
      if (body) featureXML.push(tag("LayerFeature", {layerRef: drillLayer.get(g)}, body));
    }

    // ---- stack-up specs
    const specRef = new Map();
    for (const row of stackRows) {
      const l = row.l, name = "SPEC_" + row.layer;
      if (specRef.has(row.layer)) continue;
      const parts = [];
      if (Number.isFinite(l.dk)) parts.push(tag("Dielectric", {type: "DIELECTRIC_CONSTANT"}, tag("Property", {value: trim(l.dk, 4)})));
      if (Number.isFinite(l.df)) parts.push(tag("Dielectric", {type: "LOSS_TANGENT"}, tag("Property", {value: trim(l.df, 5)})));
      if (l.material) parts.push(tag("General", {type: "MATERIAL"}, tag("Property", {text: l.material})));
      if (!parts.length) continue;
      specs.push(tag("Spec", {name}, parts.join("")));
      specRef.set(row.layer, name);
    }
    specs.push(...impedance.values());

    // ---- assemble
    const out = [];
    out.push("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    out.push("<IPC-2581 revision=\"" + REVISION + "\" xmlns=\"" + NS + "\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">");
    const bomName = stepName + "_BOM";
    out.push("<Content roleRef=\"Owner\">" + tag("FunctionMode", {mode: "ASSEMBLY", level: "3"}) + tag("StepRef", {name: stepName}) +
      layerDefs.map(l => tag("LayerRef", {name: l.name})).join("") + (comps.length ? tag("BomRef", {name: bomName}) : "") +
      (lines.size ? tag("DictionaryLineDesc", {units: unitName}, [...lines].sort().map(([id, b]) => tag("EntryLineDesc", {id}, b)).join("")) : "") +
      (prims.size ? tag("DictionaryStandard", {units: unitName}, [...prims].sort().map(([id, b]) => tag("EntryStandard", {id}, b)).join("")) : "") + "</Content>");
    out.push("<LogisticHeader>" + tag("Role", {id: "Owner", roleFunction: "SENDER"}) + tag("Enterprise", {id: "Waffle", code: "NONE"}) +
      tag("Person", {name: "Waffle", enterpriseRef: "Waffle", roleRef: "Owner"}) + "</LogisticHeader>");
    out.push(tag("HistoryRecord", {number: "1", origination: when, software: "Waffle " + FO.VERSION, lastChange: when},
      tag("FileRevision", {fileRevisionId: "1", comment: options.comment || "Generated by Waffle", label: options.revision || undefined},
        tag("SoftwarePackage", {name: "Waffle", revision: FO.VERSION, vendor: "Waffle"}, tag("Certification", {certificationStatus: "SELFTEST"})))));
    if (comps.length) {
      const items = new Map();
      for (const c of comps) { if (!items.has(c.oem)) items.set(c.oem, []); items.get(c.oem).push(c); }
      out.push("<Bom name=\"" + esc(bomName) + "\">" + tag("BomHeader", {assembly: stepName, revision: options.revision || "1"}, tag("StepRef", {name: stepName})) +
        [...items].map(([oem, list]) => tag("BomItem", {OEMDesignNumberRef: oem, quantity: String(list.length), pinCount: String(list[0].pkg.pins.length), category: list[0].pkg.pins.length ? "ELECTRICAL" : "MECHANICAL"},
          list.map(c => tag("RefDes", {name: c.ref, packageRef: c.pkg.name, populate: c.dnp ? "false" : "true", layerRef: c.part.side === "Bottom" ? "BOTTOM" : "TOP"})).join("") +
          tag("Characteristics", {category: list[0].pkg.pins.length ? "ELECTRICAL" : "MECHANICAL"},
            list[0].value ? tag("Textual", {definitionSource: "Waffle", textualCharacteristicName: "Value", textualCharacteristicValue: list[0].value}) : ""))).join("") + "</Bom>");
    }
    out.push("<Ecad name=\"" + esc(stepName) + "\">");
    out.push(tag("CadHeader", {units: unitName}, specs.join("")));
    out.push("<CadData>");
    for (const l of layerDefs) out.push(tag("Layer", {name: l.name, layerFunction: l.fn, side: l.side, polarity: l.polarity}, l.span ? tag("Span", {fromLayer: l.span[0], toLayer: l.span[1]}) : ""));
    if (stackRows.length) {
      const total = stackRows.reduce((s, r) => s + (r.l.thickness || 0), 0);
      out.push(tag("Stackup", {name: "PRIMARY", overallThickness: n(total), tolPlus: "0", tolMinus: "0", whereMeasured: "MASK"},
        tag("StackupGroup", {name: "PRIMARY_GROUP", thickness: n(total), tolPlus: "0", tolMinus: "0"},
          stackRows.map((r, i) => tag("StackupLayer", {layerOrGroupRef: r.layer, thickness: n(r.l.thickness || 0), tolPlus: "0", tolMinus: "0", sequence: String(i + 1)},
            specRef.has(r.layer) ? tag("SpecRef", {id: specRef.get(r.layer)}) : "")).join(""))));
    }
    out.push("<Step name=\"" + esc(stepName) + "\">" + tag("Datum", {x: "0", y: "0"}) + "<Profile>" + profile() + "</Profile>");
    for (const p of packages.values()) {
      out.push(tag("Package", {name: p.name, type: "OTHER", pinOne: p.pinOne, pinOneOrientation: "OTHER"},
        "<Outline>" + p.outline + tag("LineDesc", {lineEnd: "ROUND", lineWidth: n(.1)}) + "</Outline>" +
        p.pins.map(q => tag("Pin", {number: q.number, type: q.thru ? "THRU" : "SURFACE", electricalType: "ELECTRICAL"},
          rotation(q.angle) + tag("Location", p.local(q.at)) + tag("StandardPrimitiveRef", {id: q.prim}))).join("")));
    }
    for (const c of comps) {
      const it = c.part.item;
      out.push(tag("Component", {refDes: c.ref, packageRef: c.pkg.name, layerRef: c.part.side === "Bottom" ? "BOTTOM" : "TOP", part: c.oem, mountType: c.pkg.thru ? "THMT" : c.pkg.pins.length ? "SMT" : "OTHER"},
        rotation(-(it.angle || 0)) + tag("Location", xy([it.x, it.y]))));
    }
    for (const [net, pins] of [...logical].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) out.push(tag("LogicalNet", {name: net}, pins.map(p => tag("PinRef", p)).join("")));
    if (phy.size) out.push(tag("PhyNetGroup", {name: "PHYNETS"}, [...phy].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(([net, pts]) => tag("PhyNet", {name: net}, pts.join(""))).join("")));
    out.push(...featureXML);
    out.push("</Step></CadData></Ecad></IPC-2581>", "");
    void refOf; void _m;
    if (o.tentVias) stats.tentedVias = true;
    return {name: FO.baseName(doc.name) + ".ipc2581.xml", content: out.join("\n"), stats, warnings, revision: REVISION, model};
  }

  // ---------------------------------------------------------------- XML reader
  // check() uses AtriumXML's bounded scanner. The IPC profile keeps source
  // element and attribute names and the line of each "<".
  if (!globalThis.AtriumXML && typeof require === "function") {
    // @ts-ignore: CommonJS side-effect load of a classic script.
    require("./mcad-xml.js");
  }
  function parse(text) {
    const xml = globalThis.AtriumXML;
    if (!xml) throw Error("IPC-2581 checking needs the shared XML reader (mcad-xml.js).");
    try { return xml.parse(String(text), {profile: "ipc"}); }
    catch (e) { if (xml.XMLError && e instanceof xml.XMLError) throw Error(e.message); throw e; }
  }

  // ---------------------------------------------------------------- structural check
  const E = (...v) => Object.freeze(v);
  const ENUM = {
    revision: E("B", "C"),
    mode: E("USERDEF", "BOM", "STACKUP", "FABRICATION", "ASSEMBLY", "TEST", "STENCIL", "DFX"),
    roleFunction: E("SENDER", "OWNER", "RECEIVER", "DESIGNER", "ENGINEER", "BUYER", "CUSTOMERSERVICE", "DELIVERTO", "BILLTO", "OTHER"),
    certificationStatus: E("ALPHA", "BETA", "SELFTEST", "CERTIFIED"),
    units: E("MILLIMETER", "MICRON", "INCH"),
    layerFunction: E("ASSEMBLY", "BOARDFAB", "BOARD_OUTLINE", "COATINGCOND", "COATINGNONCOND", "COMPONENT_BOTTOM", "COMPONENT_TOP", "CONDFILM", "CONDFOIL",
      "CONDUCTIVE_ADHESIVE", "CONDUCTOR", "DIELADHV", "DIELBASE", "DIELCORE", "DIELPREG", "DOCUMENT", "DRILL", "EMBEDDED_COMPONENT", "FIXTURE", "GLUE",
      "GRAPHIC", "HOLEFILL", "LANDPATTERN", "LEGEND", "MIXED", "OTHER", "PASTEMASK", "PLANE", "PROBE", "RESISTIVE", "REWORK", "ROUT", "SIGNAL",
      "SILKSCREEN", "SOLDERBUMP", "SOLDERMASK", "SOLDERPASTE", "STIFFENER", "V_CUT"),
    side: E("TOP", "BOTTOM", "BOTH", "INTERNAL", "ALL", "NONE"),
    polarity: E("POSITIVE", "NEGATIVE"),
    whereMeasured: E("METAL", "MASK", "LAMINATE", "OTHER"),
    lineEnd: E("ROUND", "SQUARE", "NONE"),
    pinType: E("THRU", "SURFACE", "BLIND", "BURIED", "PRESSFIT", "OTHER"),
    electricalType: E("ELECTRICAL", "MECHANICAL", "UNDEFINED"),
    mountType: E("SMT", "THMT", "OTHER"),
    netNode: E("END", "MIDDLE"),
    exposure: E("EXPOSED", "COVERED_PRIMARY", "COVERED_SECONDARY", "COVERED"),
    padUsage: E("TERMINATION", "VIA", "PLANE", "MASK", "TOOLING", "THIEVING", "NONE"),
    platingStatus: E("PLATED", "NONPLATED", "VIA"),
    category: E("ELECTRICAL", "MECHANICAL", "PROGRAMMABLE", "DOCUMENT", "MATERIAL", "ASSEMBLY"),
    bool: E("true", "false"),
    dielectricType: E("DIELECTRIC_CONSTANT", "LOSS_TANGENT", "GLASS_TYPE", "GLASS_STYLE", "RESIN_CONTENT", "PROCESSABILITY_TEMP", "OTHER"),
    generalType: E("ELECTRICAL", "THERMAL", "MATERIAL", "INSTRUCTION", "STANDARD", "CONFIGURATION", "OTHER"),
    impedanceType: E("IMPEDANCE", "LINEWIDTH", "SPACING", "REF_PLANE_LAYER_ID", "COPLANAR_GROUND_SPACING")
  };
  const NUM = "#num", POS = "#pos";
  const PRIMS = E("Circle", "RectCenter", "RectRound", "RectCham", "Oval", "Ellipse", "Contour", "Polygon", "Line", "Polyline", "Arc", "Butterfly", "Diamond", "Donut", "Hexagon", "Moire", "Octagon", "RectCorner", "Thermal", "Triangle");
  // element: {a: required attrs {name: enum|NUM|POS|true}, o: optional attrs, c: [[child, min, max]] in order}
  // max: 1 or Infinity. A "|" in the child name accepts any of the names.
  const INF = Infinity, POLY = [["PolyBegin", 1, 1], ["PolyStepSegment|PolyStepCurve", 1, INF]];
  const PRIM = "StandardPrimitiveRef|UserPrimitiveRef|" + PRIMS.join("|");
  const SCHEMA = {
    "IPC-2581": {a: {revision: ENUM.revision}, o: {xmlns: true, "xmlns:xsi": true}, c: [["Content", 1, 1], ["LogisticHeader", 0, 1], ["HistoryRecord", 0, 1], ["Bom", 0, INF], ["Ecad", 0, 1], ["Avl", 0, 1]]},
    Content: {a: {roleRef: true}, c: [["FunctionMode", 1, 1], ["StepRef", 1, INF], ["LayerRef", 1, INF], ["BomRef", 0, INF], ["AvlRef", 0, 1], ["DictionaryColor", 0, 1], ["DictionaryLineDesc", 0, 1],
      ["DictionaryFillDesc", 0, 1], ["DictionaryFont", 0, 1], ["DictionaryStandard", 0, 1], ["DictionaryUser", 0, 1], ["DictionaryFirmware", 0, 1]]},
    FunctionMode: {a: {mode: ENUM.mode}, o: {level: POS, comment: true}, c: []},
    StepRef: {a: {name: true}, c: []}, LayerRef: {a: {name: true}, c: []}, BomRef: {a: {name: true}, c: []},
    DictionaryLineDesc: {a: {units: ENUM.units}, c: [["EntryLineDesc", 1, INF]]},
    EntryLineDesc: {a: {id: true}, c: [["LineDesc", 1, 1]]},
    LineDesc: {a: {lineEnd: ENUM.lineEnd, lineWidth: POS}, o: {lineProperty: true}, c: []},
    DictionaryStandard: {a: {units: ENUM.units}, c: [["EntryStandard", 1, INF]]},
    EntryStandard: {a: {id: true}, c: [[PRIM.replace("StandardPrimitiveRef|UserPrimitiveRef|", ""), 1, 1]]},
    Circle: {a: {diameter: POS}, c: []},
    RectCenter: {a: {width: POS, height: POS}, c: []},
    Oval: {a: {width: POS, height: POS}, c: []},
    Ellipse: {a: {width: POS, height: POS}, c: []},
    RectRound: {a: {width: POS, height: POS, radius: POS}, o: {upperRight: ENUM.bool, upperLeft: ENUM.bool, lowerRight: ENUM.bool, lowerLeft: ENUM.bool}, c: []},
    RectCham: {a: {width: POS, height: POS, chamfer: POS}, o: {upperRight: ENUM.bool, upperLeft: ENUM.bool, lowerRight: ENUM.bool, lowerLeft: ENUM.bool}, c: []},
    LogisticHeader: {c: [["Role", 1, INF], ["Enterprise", 1, INF], ["Person", 0, INF]]},
    Role: {a: {id: true, roleFunction: ENUM.roleFunction}, c: []},
    Enterprise: {a: {id: true, code: true}, o: {name: true}, c: []},
    Person: {a: {name: true, enterpriseRef: true, roleRef: true}, c: []},
    HistoryRecord: {a: {number: NUM, origination: true, software: true, lastChange: true}, c: [["FileRevision", 1, INF], ["ChangeRec", 0, INF]]},
    FileRevision: {a: {fileRevisionId: true, comment: true}, o: {label: true}, c: [["SoftwarePackage", 1, 1]]},
    SoftwarePackage: {a: {name: true}, o: {revision: true, vendor: true}, c: [["Certification", 1, 1]]},
    Certification: {a: {certificationStatus: ENUM.certificationStatus}, c: []},
    Bom: {a: {name: true}, c: [["BomHeader", 1, 1], ["BomItem", 1, INF]]},
    BomHeader: {a: {assembly: true, revision: true}, c: [["StepRef", 1, INF]]},
    BomItem: {a: {OEMDesignNumberRef: true, quantity: NUM}, o: {pinCount: NUM, category: ENUM.category}, c: [["RefDes", 0, INF], ["Characteristics", 1, 1]]},
    RefDes: {a: {name: true, packageRef: true, populate: ENUM.bool, layerRef: true}, c: []},
    Characteristics: {a: {category: ENUM.category}, c: [["Measured|Ranged|Enumerated|Textual", 0, INF]]},
    Textual: {a: {textualCharacteristicName: true, textualCharacteristicValue: true}, o: {definitionSource: true}, c: []},
    Ecad: {a: {name: true}, c: [["CadHeader", 1, 1], ["CadData", 1, 1]]},
    CadHeader: {a: {units: ENUM.units}, c: [["Spec", 0, INF]]},
    Spec: {a: {name: true}, c: [["Backdrill|Compliance|Conductor|Dielectric|General|Impedance|Technology|Temperature|Tool|V-Cut", 1, INF]]},
    Dielectric: {a: {type: ENUM.dielectricType}, c: [["Property", 1, INF]]},
    General: {a: {type: ENUM.generalType}, c: [["Property", 1, INF]]},
    Impedance: {a: {type: ENUM.impedanceType}, c: [["Property", 1, INF]]},
    Property: {o: {value: NUM, text: true, unit: true, tolPlus: NUM, tolMinus: NUM, tolPercent: ENUM.bool}, c: []},
    CadData: {c: [["Layer", 1, INF], ["Stackup", 0, INF], ["Step", 1, INF]]},
    Layer: {a: {name: true, layerFunction: ENUM.layerFunction, side: ENUM.side, polarity: ENUM.polarity}, c: [["Span", 0, 1]]},
    Span: {a: {fromLayer: true, toLayer: true}, c: []},
    Stackup: {a: {name: true, overallThickness: NUM, tolPlus: NUM, tolMinus: NUM, whereMeasured: ENUM.whereMeasured}, c: [["StackupGroup", 1, INF]]},
    StackupGroup: {a: {name: true, thickness: NUM, tolPlus: NUM, tolMinus: NUM}, c: [["StackupLayer", 1, INF]]},
    StackupLayer: {a: {layerOrGroupRef: true, thickness: NUM, tolPlus: NUM, tolMinus: NUM}, o: {sequence: POS}, c: [["SpecRef", 0, INF]]},
    SpecRef: {a: {id: true}, c: []},
    Step: {a: {name: true}, c: [["Datum", 1, 1], ["Profile", 1, 1], ["Package", 0, INF], ["Component", 0, INF], ["LogicalNet", 0, INF], ["PhyNetGroup", 0, INF], ["LayerFeature", 0, INF]]},
    Datum: {a: {x: NUM, y: NUM}, c: []},
    Profile: {c: [["Polygon", 1, 1], ["Cutout", 0, INF]]},
    Polygon: {c: POLY}, Cutout: {c: POLY},
    PolyBegin: {a: {x: NUM, y: NUM}, c: []},
    PolyStepSegment: {a: {x: NUM, y: NUM}, c: []},
    PolyStepCurve: {a: {x: NUM, y: NUM, centerX: NUM, centerY: NUM, clockwise: ENUM.bool}, c: []},
    Package: {a: {name: true, type: true, pinOneOrientation: true}, o: {pinOne: true, height: NUM}, c: [["Outline", 1, 1], ["Pin", 0, INF]]},
    Outline: {c: [["Polygon", 1, 1], ["LineDesc|LineDescRef", 1, 1]]},
    Pin: {a: {number: true, type: ENUM.pinType, electricalType: ENUM.electricalType}, c: [["Xform", 0, 1], ["Location", 1, 1], [PRIM, 1, 1]]},
    Xform: {o: {rotation: NUM, mirror: ENUM.bool, scale: NUM, xOffset: NUM, yOffset: NUM}, c: []},
    Location: {a: {x: NUM, y: NUM}, c: []},
    StandardPrimitiveRef: {a: {id: true}, c: []},
    LineDescRef: {a: {id: true}, c: []},
    Component: {a: {refDes: true, packageRef: true, layerRef: true, part: true, mountType: ENUM.mountType}, c: [["Xform", 0, 1], ["Location", 1, 1]]},
    LogicalNet: {a: {name: true}, c: [["PinRef", 0, INF]]},
    PinRef: {a: {componentRef: true, pin: true}, c: []},
    PhyNetGroup: {a: {name: true}, c: [["PhyNet", 1, INF]]},
    PhyNet: {a: {name: true}, c: [["PhyNetPoint", 1, INF]]},
    PhyNetPoint: {a: {x: NUM, y: NUM, layerRef: true, netNode: ENUM.netNode, exposure: ENUM.exposure}, o: {via: ENUM.bool}, c: [[PRIM, 1, 1]]},
    LayerFeature: {a: {layerRef: true}, c: [["Set", 1, INF]]},
    Set: {o: {net: true, polarity: ENUM.polarity, padUsage: ENUM.padUsage, geometry: true}, c: [["Pad", 0, INF], ["Hole|SlotCavity", 0, INF], ["SpecRef", 0, INF], ["Features", 0, INF]]},
    Pad: {c: [["Xform", 0, 1], ["Location", 1, 1], [PRIM, 1, 1], ["PinRef", 0, 1]]},
    Hole: {a: {name: true, diameter: POS, platingStatus: ENUM.platingStatus, plusTol: NUM, minusTol: NUM, x: NUM, y: NUM}, c: []},
    SlotCavity: {a: {name: true, platingStatus: ENUM.platingStatus, plusTol: NUM, minusTol: NUM}, c: [["Outline", 1, 1]]},
    Features: {c: [["Xform", 0, 1], ["Location", 1, 1], ["Contour|Line|Polyline|Arc|" + PRIMS.join("|"), 1, 1]]},
    Contour: {c: [["Polygon", 1, 1], ["Cutout", 0, INF]]},
    Line: {a: {startX: NUM, startY: NUM, endX: NUM, endY: NUM}, c: [["LineDesc|LineDescRef", 1, 1]]},
    Arc: {a: {startX: NUM, startY: NUM, endX: NUM, endY: NUM, centerX: NUM, centerY: NUM, clockwise: ENUM.bool}, c: [["LineDesc|LineDescRef", 1, 1]]},
    Polyline: {c: [["PolyBegin", 1, 1], ["PolyStepSegment|PolyStepCurve", 1, INF], ["LineDesc|LineDescRef", 1, 1]]}
  };
  const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
  // check(xmlText | tree) -> {ok, errors, warnings, counts, notes}
  function check(input, o = {}) {
    let tree;
    const errors = [], warnings = [], max = o.maxErrors ?? 100;
    const err = (node, m) => { if (errors.length < max) errors.push((node?.line ? "line " + node.line + ": " : "") + m); };
    try { tree = typeof input === "string" ? parse(input) : input; }
    catch (e) { return {ok: false, errors: ["Not well-formed: " + e.message], warnings, counts: null, notes: CHECK_NOTES}; }
    if (tree.name !== "IPC-2581") err(tree, "the root element must be IPC-2581");
    if (tree.attrs.xmlns !== NS) err(tree, "the default namespace must be " + NS);
    const ids = {layer: new Map(), entry: new Map(), line: new Map(), pkg: new Map(), comp: new Map(), step: new Set(), bom: new Set(), spec: new Set(), hole: new Set(), oem: new Set(), net: new Set()};
    const refs = [];
    const counts = {layers: 0, packages: 0, components: 0, logicalNets: 0, phyNets: 0, holes: 0, bomItems: 0, stackupLayers: 0, byLayer: Object.create(null)};
    function visit(node, parent) {
      const rule = Object.hasOwn(SCHEMA, node.name) && SCHEMA[node.name];
      if (!rule) { err(node, "unexpected element <" + node.name + "> in <" + parent?.name + ">"); return; }
      for (const [a, kind] of Object.entries(rule.a || {})) {
        const v = node.attrs[a];
        if (v == null) { err(node, "<" + node.name + "> needs the " + a + " attribute"); continue; }
        attrCheck(node, a, v, kind);
      }
      for (const [a, v] of Object.entries(node.attrs)) {
        if (rule.a && Object.hasOwn(rule.a, a)) continue;
        if (rule.o && Object.hasOwn(rule.o, a)) { attrCheck(node, a, v, rule.o[a]); continue; }
        err(node, "<" + node.name + "> has the unexpected attribute " + a);
      }
      // Child order and cardinality.
      let k = 0;
      for (const [names, min, maxN] of rule.c || []) {
        const ok = new Set(names.split("|"));
        let n = 0;
        while (k < node.children.length && ok.has(node.children[k].name)) { n++; k++; }
        if (n < min) err(node, "<" + node.name + "> needs " + (min === 1 ? "a" : min) + " <" + names.split("|").slice(0, 3).join("|") + "> child" + (k < node.children.length ? " before <" + node.children[k].name + ">" : ""));
        if (n > maxN) err(node, "<" + node.name + "> has more than " + maxN + " <" + names + "> children");
      }
      if (k < node.children.length) err(node.children[k], "<" + node.children[k].name + "> is not allowed here in <" + node.name + "> (order or content)");
      // Identity, references and counts.
      const A = node.attrs;
      const unique = (map, key, what) => { if (map.has(key)) err(node, "duplicate " + what + " " + key); else map.set ? map.set(key, node) : map.add(key); };
      switch (node.name) {
        case "Layer": unique(ids.layer, A.name, "layer"); counts.layers++; break;
        case "Span": refs.push(["layer", A.fromLayer, node], ["layer", A.toLayer, node]); break;
        case "EntryStandard": unique(ids.entry, A.id, "standard primitive"); break;
        case "EntryLineDesc": unique(ids.line, A.id, "line description"); break;
        case "Package": unique(ids.pkg, A.name, "package"); counts.packages++; node.pins = new Set(node.children.filter(c => c.name === "Pin").map(c => c.attrs.number)); break;
        case "Component": unique(ids.comp, A.refDes, "component"); counts.components++; refs.push(["pkg", A.packageRef, node], ["layer", A.layerRef, node], ["oem", A.part, node]); break;
        case "Step": ids.step.add(A.name); break;
        case "Bom": ids.bom.add(A.name); break;
        case "BomItem": ids.oem.add(A.OEMDesignNumberRef); counts.bomItems++; break;
        case "RefDes": refs.push(["comp", A.name, node], ["pkg", A.packageRef, node], ["layer", A.layerRef, node]); break;
        case "Spec": unique(ids.spec, A.name, "spec"); break;
        case "SpecRef": refs.push(["spec", A.id, node]); break;
        case "StandardPrimitiveRef": refs.push(["entry", A.id, node]); break;
        case "LineDescRef": refs.push(["line", A.id, node]); break;
        case "LayerRef": refs.push(["layer", A.name, node]); break;
        case "StepRef": refs.push(["step", A.name, node]); break;
        case "BomRef": refs.push(["bom", A.name, node]); break;
        case "StackupLayer": refs.push(["layer", A.layerOrGroupRef, node]); counts.stackupLayers++; break;
        case "LogicalNet": unique(ids.net, A.name, "logical net"); counts.logicalNets++; break;
        case "PinRef": refs.push(["pin", A.componentRef + "\u0001" + A.pin, node]); break;
        case "PhyNet": counts.phyNets++; break;
        case "PhyNetPoint": refs.push(["layer", A.layerRef, node]); break;
        case "LayerFeature": refs.push(["layer", A.layerRef, node]); node.tally = counts.byLayer[A.layerRef] = counts.byLayer[A.layerRef] || {pads: 0, lines: 0, contours: 0, arcs: 0, holes: 0, negative: 0}; break;
        case "Hole": case "SlotCavity": unique(ids.hole, A.name, "hole"); counts.holes++; break;
        case "Polygon": case "Cutout": {
          const pts = node.children;
          if (pts.length >= 2 && (pts[0].attrs.x !== pts.at(-1).attrs.x || pts[0].attrs.y !== pts.at(-1).attrs.y)) err(node, "<" + node.name + "> must end where it begins");
          break;
        }
      }
      for (const c of node.children) { c.parent = node; c.feature = node.feature || (node.name === "LayerFeature" ? node.tally : null); c.negative = node.negative || node.name === "Set" && A.polarity === "NEGATIVE"; visit(c, node); }
      const t = node.feature;
      if (t) {
        if (node.name === "Pad") node.negative ? t.negative++ : t.pads++;
        else if (node.name === "Hole" || node.name === "SlotCavity") t.holes++;
        else if (node.name === "Contour") t.contours++;
        else if ((node.name === "Line" || node.name === "Polyline") && node.parent.name === "Features") t.lines++;
        else if (node.name === "Arc" && node.parent.name === "Features") t.arcs++;
      }
    }
    function attrCheck(node, a, v, kind) {
      if (kind === NUM || kind === POS) {
        if (!NUMBER.test(v) || !Number.isFinite(+v)) err(node, a + "=\"" + v + "\" on <" + node.name + "> is not a number");
        else if (kind === POS && !(+v > 0) && !(+v === 0 && a === "lineWidth" && node.parent?.name === "Outline"))
          err(node, a + " on <" + node.name + "> must be greater than zero");
      } else if (Array.isArray(kind) && !kind.includes(v)) err(node, a + "=\"" + v + "\" on <" + node.name + "> is not one of " + kind.slice(0, 8).join(", ") + (kind.length > 8 ? ", …" : ""));
      else if (kind === true && v === "") err(node, a + " on <" + node.name + "> is empty");
    }
    visit(tree, null);
    // Component pins for PinRef checks.
    const pinOK = key => {
      const [ref, pin] = key.split("\u0001"), comp = ids.comp.get(ref);
      return !!comp && !!ids.pkg.get(comp.attrs.packageRef)?.pins?.has(pin);
    };
    for (const [kind, key, node] of refs) {
      // The required-attribute pass already reported a missing reference.
      if (key == null) continue;
      const ok = kind === "pin" ? pinOK(key) : kind === "step" || kind === "bom" || kind === "spec" || kind === "oem" ? ids[kind].has(key) : ids[kind].has(key);
      if (!ok) err(node, "<" + node.name + "> refers to the unknown " + ({entry: "standard primitive", line: "line description", pkg: "package", comp: "component", oem: "BOM item", pin: "component pin"}[kind] || kind) + " " + JSON.stringify(key.replace("\u0001", " pin ")));
    }
    // Every LayerRef in Content names a layer, and every layer is listed.
    const listed = new Set();
    for (const c of tree.children.find(x => x.name === "Content")?.children || []) if (c.name === "LayerRef") listed.add(c.attrs.name);
    for (const name of ids.layer.keys()) if (!listed.has(name)) warnings.push("Layer " + name + " is not listed in Content (LayerRef).");
    for (const [name, layer] of ids.layer) if (layer.attrs.layerFunction === "DRILL" && !layer.children.some(c => c.name === "Span")) warnings.push("Drill layer " + name + " has no Span.");
    return {ok: !errors.length, errors, warnings, counts, notes: CHECK_NOTES};
  }

  return Object.freeze({REVISION, NS, CHECK_NOTES, SCHEMA, build, parse, check});
})();
