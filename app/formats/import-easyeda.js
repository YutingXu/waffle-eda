"use strict";
// EasyEDA importer, from EasyEDA's published document formats.
//
// Standard edition (.json): a document {head:{docType}, canvas, shape:[...]} whose
// shapes are "~"-separated command strings ("TRACK~...", "LIB~...#@$PAD~...").
// docType 1 is a schematic, 3 a PCB; a project export holds {schematics:[{dataStr}]}.
// Units are 10 mil (0.254 mm) with Y down. PCB pad and component rotations turn
// the other way from Waffle's angles (see PAD). Component sub-shapes are stored in sheet coordinates, so each
// definition is taken back to the component origin and rotation.
//
// Professional edition: .esch/.epcb documents are one JSON array per line
// (["DOCTYPE","PCB",...], ["LINE",...]); an .epro project is a ZIP of them with
// SYMBOL/*.esym and FOOTPRINT/*.efoo libraries. Pro boards use mil with Y up.
// Pro support covers the record types listed in readPro and is less complete.
if (!globalThis.AtriumGeometryCurves && typeof require === "function") require("../pcb/resolved-geometry-curves.js");
globalThis.AtriumEasyEDAImport = (() => {
  const A = Atrium, F = () => AtriumImportFormats, G = () => AtriumImportFormats.geom;
  const U = .254, MIL = .0254;
  const r4 = v => Math.round(v * 1e4) / 1e4 + 0;
  const n360 = a => ((a % 360) + 360) % 360;
  const norm = a => { const v = n360(a); return v > 180 ? v - 360 : v; };
  // A missing field reads as its default. A field that is present but not a number rejects its
  // record (F().guard skips it with a note) instead of reading as 0. soft() keeps the default for
  // document settings and rules, which have no record to skip.
  const soft = (v, d = 0) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };
  const num = (v, d = 0) => {
    if (v == null || v === "") return d;
    const x = parseFloat(v);
    if (!Number.isFinite(x)) throw Error("Invalid EasyEDA number.");
    return x;
  };
  function pairs(s) {
    const n = String(s || "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (n.length % 2 || n.some(x => !Number.isFinite(x))) throw Error("Invalid EasyEDA point list.");
    F().spend(n.length / 2);
    const out = [];
    for (let i = 0; i < n.length; i += 2) out.push([n[i], n[i + 1]]);
    return out;
  }
  const para = s => { const p = String(s || "").split("`"), o = Object.create(null); for (let i = 0; i + 1 < p.length; i += 2) o[p[i]] = p[i + 1]; return o; };
  const has = (o, k) => o != null && Object.hasOwn(o, k);
  const pick = (o, k, d) => has(o, k) ? o[k] : d;

  // SVG path subset (M L H V A C Q Z, absolute and relative) -> polylines.
  function svgPath(d, tol = .02) {
    const text = String(d || ""), re = /[MLHVACQZmlhvacqz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g, tokens = text.match(re) || [], out = [];
    // Like a point list, a path with a stray token or a missing number is rejected rather than re-paired.
    if (/[^\s,STst]/.test(text.replace(re, ""))) throw Error("Invalid EasyEDA path.");
    let i = 0, cmd = "", cur = [0, 0], start = [0, 0], line = null;
    const next = () => { const v = +tokens[i++]; if (!Number.isFinite(v)) throw Error("Invalid EasyEDA path."); return v; };
    const more = () => i < tokens.length && !/^[a-z]$/i.test(tokens[i]);
    while (i < tokens.length) {
      if (/^[a-z]$/i.test(tokens[i])) cmd = tokens[i++];
      const rel = cmd === cmd.toLowerCase(), c = cmd.toUpperCase();
      const pt = () => { const x = next(), y = next(); return rel ? [cur[0] + x, cur[1] + y] : [x, y]; };
      if (c === "M") { cur = pt(); start = cur; line = [cur]; out.push(line); cmd = rel ? "l" : "L"; }
      else if (c === "L") { cur = pt(); (line ||= (out.push([cur]), out.at(-1))).push(cur); }
      else if (c === "H") { const x = next(); cur = [rel ? cur[0] + x : x, cur[1]]; line?.push(cur); }
      else if (c === "V") { const y = next(); cur = [cur[0], rel ? cur[1] + y : y]; line?.push(cur); }
      else if (c === "Z") { if (line && line.length) line.push(start); cur = start; line = null; if (more()) i++; continue; }
      else if (c === "A") {
        const rx = next(), ry = next(), rot = next(), large = next(), sweep = next(), end = pt();
        line?.push(...svgArc(cur, end, rx, ry, rot, large, sweep, tol).slice(1));
        cur = end;
      } else if (c === "C" || c === "Q") {
        const p = c === "C" ? [pt(), pt(), pt()] : [pt(), pt()], a = cur;
        for (let k = 1; k <= 12; k++) {
          const t = k / 12, u = 1 - t;
          line?.push(c === "C" ? [0, 1].map(j => u * u * u * a[j] + 3 * u * u * t * p[0][j] + 3 * u * t * t * p[1][j] + t * t * t * p[2][j])
            : [0, 1].map(j => u * u * a[j] + 2 * u * t * p[0][j] + t * t * p[1][j]));
        }
        cur = p.at(-1);
      } else i++;
    }
    const lines = out.filter(l => l.length >= 2);
    F().spend(lines.reduce((n, l) => n + l.length, 0));
    return lines;
  }
  // SVG elliptical arc, endpoint form -> points (W3C SVG implementation notes).
  function svgArc(a, b, rx, ry, rot, large, sweep, tol) {
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (!rx || !ry || (a[0] === b[0] && a[1] === b[1])) return [a, b];
    const phi = rot * Math.PI / 180, cs = Math.cos(phi), sn = Math.sin(phi);
    const dx = (a[0] - b[0]) / 2, dy = (a[1] - b[1]) / 2, x1 = cs * dx + sn * dy, y1 = -sn * dx + cs * dy;
    const lam = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry);
    if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const sign = (+large === +sweep) ? -1 : 1, nume = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const k = sign * Math.sqrt(Math.max(0, nume / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
    const cxp = k * rx * y1 / ry, cyp = -k * ry * x1 / rx;
    const cx = cs * cxp - sn * cyp + (a[0] + b[0]) / 2, cy = sn * cxp + cs * cyp + (a[1] + b[1]) / 2;
    const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
    let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
    if (!+sweep && dt > 0) dt -= 2 * Math.PI; else if (+sweep && dt < 0) dt += 2 * Math.PI;
    if (![cx, cy, t1, dt].every(Number.isFinite)) return [a, b];
    const degrees = 180 / Math.PI, center = [cx * U, cy * U];
    const edge = rx === ry ? {kind: "arc", center, radius: rx * U, start: -(t1 + phi) * degrees, sweep: -dt * degrees}
      : {kind: "ellipseArc", center, cosineAxis: [rx * cs * U, rx * sn * U], sineAxis: [-ry * sn * U, ry * cs * U],
        start: t1 * degrees, sweep: dt * degrees};
    const points = AtriumGeometryCurves.project([edge], tol * U, {minSegments: 2, maxSegments: 360,
      maxStep: tol < Math.max(rx, ry) ? 360 : .5 * degrees}).map(([x, y]) => [x / U, y / U]);
    points[0] = a; points[points.length - 1] = b;
    return points;
  }

  // Only the report path retains these records. A library row can supply many
  // placements, but accounts for one source object at its original location.
  const objectKinds = new Set("W B J N O BE F T LIB PL PG R E A PT I P TRACK ARC CIRCLE RECT TEXT VIA HOLE PAD COPPERAREA SOLIDREGION SVGNODE DIMENSION PROTRACTOR HEAD LAYER LINE POLY FILL POUR COMPONENT ATTR PADNET PAD_NET WIRE BUS PIN PART STRING".split(" "));
  const metadataKinds = new Set(["invalid shape", "invalid record", "header field", "layer settings", "design rule", "document field", "project field", "project symbols", "project footprints", "project devices", "archive member"]);
  function sourceEvidence(file, sink) {
    const records = [];
    /** @this {{object: string}} */
    function produced(doc, first) {
      if (!sink.produced) return;
      const source = {file, object: this.object};
      for (let i = first; i < doc.items.length; i++) sink.produced(doc.kind, source, doc.items[i]);
    }
    return {
      row(kind, object) {
        kind = typeof kind === "string" && kind ? kind.slice(0, 96) : "invalid record";
        if (!objectKinds.has(kind) && !metadataKinds.has(kind)) {
          sink.add("Other EasyEDA record", "dropped", {file, object}, "Unsupported EasyEDA record " + kind + ".");
          return null;
        }
        const row = {kind, object, produced};
        records.push(row);
        return row;
      },
      finish() {
        for (const r of records) {
          const source = {file, object: r.object};
          const status = r.approximation ? "approximated" : r.represented ? "kept" : "dropped";
          const reason = r.approximation || (r.represented ? undefined : r.omission || "No native representation was produced for this EasyEDA record.");
          if (r.target && sink.track) sink.track(r.kind, status, source, r.target, reason);
          else sink.add(r.kind, status, source, reason);
        }
      }
    };
  }
  function used(record, target, reason) {
    if (!record) return;
    record.represented = true;
    if (target && !record.target) record.target = target;
    if (reason) record.approximation = reason;
  }
  function standardShapes(data, notes, evidence, scope, convert) {
    const shapes = Array.isArray(data.shape) ? data.shape : [];
    for (let i = 0; i < shapes.length; i++) F().guard(notes, () => {
      const raw = shapes[i];
      if (typeof raw !== "string") { evidence?.row("invalid shape", scope + ".shape[" + i + "]"); return; }
      const [head, ...subs] = raw.split("#@$"), fields = head.split("~");
      const record = evidence?.row(fields[0], scope + ".shape[" + i + "]");
      convert(raw, fields, subs, record, i);
    });
  }
  const sheetApprox = kind => ["A", "PT", "E"].includes(kind) ? "Curved artwork converted to a sampled path." :
    ["PL", "PG", "R"].includes(kind) ? "Geometry retained with native graphic styling." : kind === "F" ? "Flag redrawn as a native port." : undefined;
  function boardApprox(f, inFootprint) {
    const t = f[0];
    if (t === "ARC" || t === "CIRCLE" && !inFootprint) return "Curved graphic sampled into line segments.";
    if (t === "COPPERAREA") return "Imported the first pour boundary; native copper fill is regenerated.";
    if (t === "SOLIDREGION" && f[4] === "cutout") return "Cutout represented by a keepout outline.";
    if (t === "PAD") {
      if (num(f[13]) > 0 && !pairs(f[14]).length) return "Slotted drill length retained; slot axis follows the pad.";
      if (!stdLayer(f[6])) return "Unknown pad layer replaced by the native top layer.";
      if (!Object.hasOwn(PAD_SHAPE, f[1]) && f[1] !== "POLYGON" || f[1] === "ELLIPSE" && num(f[4]) !== num(f[5])) return "Pad mapped to a native basic shape.";
    }
    return undefined;
  }
  function outlineSource(records, edges, first, record, reason) {
    if (!record) return;
    if (reason) record.edgeApproximation = reason;
    for (let i = first; i < edges.length; i++) records[i] = record;
  }
  function finishOutline(doc, edges, records, notes) {
    const observe = records && ((index, status, reason) => {
      const record = records[index];
      if (status === "dropped") {
        record.edgeDropped = true;
        record.omission = reason;
        if (record.represented) used(record, null, "Only part of the outline record was retained.");
      } else used(record, null, record.edgeDropped ? "Only part of the outline record was retained." : reason || record.edgeApproximation);
    });
    for (const warning of G().setOutline(doc, edges, observe)) notes.add(warning);
  }

  // ------------------------------------------------------------ Standard: schematic
  const ELECTRIC = {0: 7, 1: 0, 2: 2, 3: 1, 4: 7};
  function stdSheet(name, data, title, notes, defs, evidence, scope) {
    const doc = A.sheet("schematic", title);
    doc.sourceName = name; doc.sourceEncoding = "easyeda-standard"; doc.grid = 2.54;
    const mm = p => [r4(p[0] * U), r4(p[1] * U)], records = [];
    standardShapes(data, notes, evidence, scope, (raw, f, subs, record, index) => {
      const t = f[0], first = doc.items.length;
      if (t === "W" || t === "B") { const p = pairs(f[1]).map(mm); if (p.length >= 2) doc.items.push({id: A.id(), kind: t === "W" ? "wire" : "bus", points: p}); }
      else if (t === "J") { const p = mm([num(f[1]), num(f[2])]); doc.items.push({id: A.id(), kind: "junction", x: p[0], y: p[1]}); }
      else if (t === "N") { const p = mm([num(f[1]), num(f[2])]); if (f[5]) doc.items.push({id: A.id(), kind: "netlabel", x: p[0], y: p[1], text: f[5], angle: r4(norm(num(f[3])))}); }
      else if (t === "O") { const p = mm([num(f[1]), num(f[2])]); doc.items.push({id: A.id(), kind: "noerc", x: p[0], y: p[1]}); }
      else if (t === "BE") {
        const a = mm([num(f[2]), num(f[3])]), b = mm([num(f[4]), num(f[5])]), d = [b[0] - a[0], b[1] - a[1]], size = Math.hypot(...d) / Math.SQRT2;
        if (size > 0) doc.items.push({id: A.id(), kind: "busentry", x: a[0], y: a[1], size: r4(size), angle: r4(Math.atan2(d[1], d[0]) * 180 / Math.PI + 45)});
      } else if (t === "F") flag(raw, doc, mm, notes);
      else if (t === "T") { const p = mm([num(f[2]), num(f[3])]); if (f[12] && f[13] !== "0") doc.items.push({id: A.id(), kind: "label", x: p[0], y: p[1], text: f[12], angle: r4(norm(num(f[4]))), size: Math.max(.8, soft(String(f[7]).replace("pt", ""), 7) * .35)}); }
      else if (t === "LIB") records.push(stdSymbol(f, subs, mm, name, evidence, record, notes));
      else if (["PL", "PG", "R", "E", "A", "PT"].includes(t)) for (const p of stdGraphic(f)) doc.items.push({id: A.id(), kind: "graphic", points: p.points.map(mm), width: .254, ...(p.closed ? {closed: true} : {})});
      else if (t === "I") notes.add("Images omitted");
      else notes.add("Schematic " + t + " objects omitted");
      if (doc.items.length === first + 1) doc.items[first].sourceRecord = "easyeda/shape/" + index;
      if (record && doc.items[first]) { used(record, doc.items[first], sheetApprox(t)); record.produced(doc, first); }
    });
    stdFinish(records, doc, defs);
    doc.notes = [];
    return doc;
  }
  // Graphics shared by sheets and symbols, in source units.
  function stdGraphic(f) {
    const t = f[0];
    if (t === "PL" || t === "PG") { const p = pairs(f[1]); if (p.length < 2) return []; return [{points: t === "PG" ? [...p, p[0]] : p, closed: t === "PG", fill: t === "PG" && f[5] && f[5] !== "none"}]; }
    if (t === "R") {
      const x = num(f[1]), y = num(f[2]), w = num(f[5]), h = num(f[6]);
      return w > 0 && h > 0 ? [{points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], closed: true, fill: f[10] && f[10] !== "none"}] : [];
    }
    if (t === "E") {
      const c = [num(f[1]), num(f[2])], rx = num(f[3]), ry = num(f[4]) || rx;
      return rx > 0 ? [{points: Array.from({length: 49}, (_, i) => [c[0] + rx * Math.cos(i * Math.PI / 24), c[1] + ry * Math.sin(i * Math.PI / 24)]), closed: true, circle: rx === ry ? {c, r: rx} : null}] : [];
    }
    if (t === "A" || t === "PT") return svgPath(f[1]).map(points => ({points, closed: false}));
    return [];
  }
  function flag(raw, doc, mm, notes) {
    const seg = raw.split("^^"), f = seg[0].split("~"), dot = (seg[1] || "").split("~"), label = (seg[2] || "").split("~");
    const at = mm(dot.length >= 2 && dot[0] !== "" ? [num(dot[0]), num(dot[1])] : [num(f[2]), num(f[3])]);
    const kind = f[1] || "", text = label[0] || "";
    if (!text) return;
    if (/netport/i.test(kind)) { doc.items.push({id: A.id(), kind: "offsheet", x: at[0], y: at[1], text, angle: r4(norm(num(f[4])))}); return; }
    const style = /gnd|ground/i.test(kind) ? (/protect|analog|earth/i.test(kind) ? "earth" : "gnd") : "bar", base = style === "bar" ? 1 : 3;
    doc.items.push({id: A.id(), kind: "power", x: at[0], y: at[1], text, style, direction: ((base - Math.round(num(f[4]) / 90)) % 4 + 4) % 4});
  }
  function stdSymbol(f, subs, mm, source, evidence, record, notes) {
    const origin = [num(f[1]), num(f[2])], angle = r4(norm(num(f[4]))), p = para(f[3]);
    const local = q => A.rotate([(q[0] - origin[0]) * U, (q[1] - origin[1]) * U], -angle).map(r4);
    const shapes = [], pins = [];
    let ref = "", value = "", refAt = null, valueAt = null, showRef, showValue;
    for (let i = 0; i < subs.length; i++) F().guard(notes, () => {
      const s = subs[i], g = s.split("~"), t = g[0], firstShape = shapes.length, firstPin = pins.length;
      const child = evidence?.row(t, record.object + "#@$" + (i + 1));
      if (t === "P") {
        const seg = s.split("^^"), h = seg[0].split("~"), name = (seg[3] || "").split("~"), numb = (seg[4] || "").split("~");
        // The pin dot ("^^x~y", second segment) is the connection point. The header x~y usually
        // equals it, but some files keep a stale header (both pins of a resistor at one point).
        const dot = (seg[1] || "").split("~"), useDot = Number.isFinite(parseFloat(dot[0])) && Number.isFinite(parseFloat(dot[1]));
        const at = local(useDot ? [num(dot[0]), num(dot[1])] : [num(h[4]), num(h[5])]);
        const label = name[0] === "1" && name[4] ? local([num(name[1]), num(name[2])]) : null;
        pins.push({x: at[0], y: at[1], number: numb[4] || h[3] || "", name: name[4] || "", hidden: h[1] === "0", electrical: pick(ELECTRIC, h[2], 7)});
        for (const line of svgPath((seg[2] || "").split("~")[0])) shapes.push({kind: "path", style: "body", points: line.map(local), closed: false, fill: false, width: 0});
        if (label) shapes.push({kind: "text", x: label[0], y: label[1], text: name[4], size: 1.27, style: "body"});
      } else if (t === "T") {
        const q = local([num(g[2]), num(g[3])]);
        if (g[1] === "P") { ref = g[12] || ""; refAt = q; showRef=g[13]!=="0"; }
        else if (g[1] === "N") { value = g[12] || ""; valueAt = q; showValue=g[13]!=="0"; }
        else if (g[12] && g[13] !== "0") shapes.push({kind: "text", x: q[0], y: q[1], text: g[12], size: 1.27, style: "body"});
      } else for (const gr of stdGraphic(g)) {
        if (gr.circle) { const c = local(gr.circle.c); shapes.push({kind: "circle", style: "body", x: c[0], y: c[1], r: r4(gr.circle.r * U), width: .254}); }
        else shapes.push({kind: "path", style: "body", points: gr.points.map(local), closed: !!gr.closed, fill: !!gr.fill, width: .254});
      }
      if (child) {
        const target = pins[firstPin] || shapes[firstShape];
        if (target) used(child, target, t === "E" && target.kind === "circle" ? undefined : sheetApprox(t));
        else if (t === "T" && (g[1] === "P" || g[1] === "N")) used(child);
      }
    });
    if (!valueAt) value=p.value ?? p.Value ?? p.name ?? "";
    const params = {};
    for (const k of ["Manufacturer", "Manufacturer Part", "Supplier Part", "LCSC Part Name"]) if (p[k]) params[k] = p[k];
    return {p, ref, value, refAt, valueAt, showRef, showValue, shapes, pins, at: mm(origin), angle, params, source, record};
  }
  // Placed symbols -> definitions. Sub-parts of one package ("U1.1", "U1.2", from a
  // prefix such as "U?.1") become the gates of one definition.
  function stdFinish(records, doc, defs) {
    const groups = new Map();
    for (const r of records) {
      const m = /^(.+)\.(\d+)$/.exec(r.ref), multi = m && /\.\d+$/.test(String(r.p.pre || ""));
      r.base = multi ? m[1] : r.ref; r.unit = multi ? +m[2] : 0;
      if (multi) { const k = r.base + "\u001f" + (r.p.package || ""); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    }
    const gated = new Map();
    for (const list of groups.values()) {
      const parts = Math.max(...list.map(r => r.unit));
      if (parts < 2 || parts > 64) continue;
      const symbol = {shapes: [], pins: [], parts}, seen = new Set();
      for (const r of list.sort((a, b) => a.unit - b.unit)) {
        if (seen.has(r.unit)) continue;
        seen.add(r.unit);
        for (const sh of r.shapes) symbol.shapes.push(Object.assign(sh, {part: r.unit}));
        for (const pin of r.pins) symbol.pins.push(Object.assign(pin, {part: r.unit}));
      }
      const r0 = list[0], def = defs.add({id: A.id(), name: r0.p.spiceSymbolName || r0.p.name || r0.p.package || "Symbol", category: "EasyEDA symbols",
        prefix: String(r0.p.pre || r0.base).replace(/[?\d.]+$/, "") || "U", value: r0.value, symbol, footprintName: r0.p.package || "", parameters: {}, sourceName: r0.source});
      for (const r of list) gated.set(r, def);
    }
    for (const r of records) {
      let def = gated.get(r), ref = r.ref;
      if (def) ref = r.base;
      else {
        const prefix = String(r.p.pre || r.ref || "U").replace(/[?\d]+$/, "") || "U";
        def = defs.add({id: A.id(), name: r.p.spiceSymbolName || r.p.name || r.p.package || "Symbol", category: "EasyEDA symbols", prefix, value: r.value,
          symbol: {shapes: r.shapes, pins: r.pins}, footprintName: r.p.package || "", parameters: {}, sourceName: r.source});
        ref ||= prefix + "?";
      }
      const item = {id: A.id(), kind: "part", def: def.id, ref, value: r.value, link: "easyeda-" + (ref || A.id()), pinNets: {}, x: r.at[0], y: r.at[1], angle: r.angle};
      if (gated.has(r)) item.unit = r.unit;
      if (r.showRef===false)item.showRef=false;
      if (r.showValue===false)item.showValue=false;
      if (r.refAt) item.refAt = r.refAt;
      if (r.valueAt) item.valueAt = r.valueAt;
      if (Object.keys(r.params).length) item.parameters = r.params;
      used(r.record, item);
      doc.items.push(item);
      r.record?.produced(doc, doc.items.length - 1);
    }
  }

  // ------------------------------------------------------------ Standard: PCB
  const STD_LAYERS = {1: "Top", 2: "Bottom", 3: "Silk", 4: "Bottom silk", 5: "Top paste", 6: "Bottom paste", 7: "Top mask", 8: "Bottom mask",
    11: "Multi", 12: "Mechanical", 13: "Mechanical 13", 14: "Mechanical 14", 15: "Mechanical"};
  const stdLayer = id => { const n = +id; return n >= 21 && n <= 52 ? "Inner " + (n - 20) : pick(STD_LAYERS, n, null); };
  const isCopper = l => l === "Top" || l === "Bottom" || /^Inner \d+$/.test(l || "");
  const PAD_SHAPE = {ELLIPSE: "round", RECT: "rect", OVAL: "oval", POLYGON: "rect"};
  function standardDimensions(rule) {
    // Keep the same rounding as the board objects so a via at the minimum passes DRC.
    return {clearance:r4(soft(rule.clearance,NaN)*U),trackWidth:r4(soft(rule.trackWidth,NaN)*U),viaDrill:r4(soft(rule.viaHoleD,NaN)*U)};
  }
  function stdBoard(name, data, notes, defs, evidence, scope) {
    const doc = A.sheet("pcb", F().stem(name));
    doc.sourceName = name; doc.sourceEncoding = "easyeda-standard";
    const ca = String(data.canvas || "").split("~"), ox = soft(ca[16]), oy = soft(ca[17]);
    const mm = p => [r4((p[0] - ox) * U), r4((p[1] - oy) * U)], edges = [];
    const outlineRecords = evidence && [];
    function pathEdges(d) { for (const line of svgPath(d)) edges.push({kind: "path", points: line.map(mm)}); }
    function shape(f, sink, frame) {
      const t = f[0];
      if (t === "TRACK") {
        const l = stdLayer(f[2]), p = pairs(f[4]).map(mm);
        if (+f[2] === 10) { edges.push({kind: "path", points: p}); return; }
        if (p.length < 2 || !l) { if (!l) notes.add("Tracks on unsupported layers omitted"); return; }
        // Only copper carries a net: silk and mechanical lines may name EasyEDA's "$BOARDOUTLINENET".
        sink({kind: isCopper(l) && !frame ? "track" : isCopper(l) ? "path" : "graphic", points: p, layer: l, width: r4(num(f[1]) * U), ...(isCopper(l) ? {net: f[3] || ""} : {})});
      } else if (t === "ARC") {
        const l = stdLayer(f[2]);
        if (+f[2] === 10) { pathEdges(f[4]); return; }
        if (!l) return;
        for (const line of svgPath(f[4])) sink({kind: isCopper(l) && !frame ? "track" : isCopper(l) ? "path" : "graphic", points: line.map(mm), layer: l, width: r4(num(f[1]) * U), net: f[3] || ""});
      } else if (t === "CIRCLE") {
        const c = mm([num(f[1]), num(f[2])]), r = num(f[3]) * U, l = stdLayer(f[5]);
        if (+f[5] === 10) { edges.push({kind: "circle", c, r}); return; }
        if (l && r > 0) sink({kind: "circle", c, r, layer: l, width: r4(num(f[4]) * U)});
      } else if (t === "RECT") {
        const x = num(f[1]), y = num(f[2]), w = num(f[3]), h = num(f[4]), l = stdLayer(f[5]);
        const p = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]].map(mm);
        if (+f[5] === 10) { edges.push({kind: "path", points: p}); return; }
        if (l) sink({kind: "graphic", points: p, layer: l, width: 0, closed: true, fill: true});
      } else if (t === "TEXT") {
        const l = stdLayer(f[7]), q = mm([num(f[2]), num(f[3])]);
        // A hidden designator or value ("none" display) still names its footprint.
        const hidden = f[12] === "none";
        if (l && (f[10] || f[1]==="N" || f[1]==="P") && (!hidden || f[1] === "P" || f[1] === "N")) sink({kind: "label", x: q[0], y: q[1], text: f[10], angle: r4(norm(num(f[5]))), size: r4(Math.max(.5, num(f[9]) * U)), layer: l, role: f[1], ...(hidden ? {hidden: true} : {})});
      } else if (t === "VIA") {
        const q = mm([num(f[1]), num(f[2])]), d = num(f[3]) * U, drill = num(f[5]) * 2 * U;
        if (d > 0) sink({kind: "via", x: q[0], y: q[1], diameter: r4(d), drill: r4(drill || d / 2), layer: "Multi", net: f[4] || ""});
      } else if (t === "HOLE") {
        const q = mm([num(f[1]), num(f[2])]), d = r4(num(f[3]) * 2 * U);
        if (d > 0) sink({kind: "pad", number: "", x: q[0], y: q[1], w: d, h: d, drill: d, shape: "round", layer: "Multi", plated: false});
      } else if (t === "PAD") {
        // Only multi-layer pads (layer 11) are drilled: surface pads sometimes keep a stray hole radius.
        const q = mm([num(f[2]), num(f[3])]), l = stdLayer(f[6]), drill = l === "Multi" ? r4(num(f[9]) * 2 * U) : 0;
        let w = num(f[4]) * U, h = num(f[5]) * U;
        const shapeName = String(f[1]).toUpperCase();
        let poly = null;
        if (shapeName === "POLYGON") {
          // Polygon pads keep their outline, relative to the pad and unrotated.
          const pts = pairs(f[10]).map(mm).map(v => A.rotate([v[0] - q[0], v[1] - q[1]], -num(f[11])).map(r4));
          if (pts.length >= 3) {
            const m = pts.reduce((e, v) => [Math.max(e[0], Math.abs(v[0])), Math.max(e[1], Math.abs(v[1]))], [0, 0]);
            poly = pts; w = 2 * m[0]; h = 2 * m[1];
          }
        }
        if (!(w > 0 && h > 0)) return;
        if (num(f[13]) > 0) notes.add("Slotted holes import as round holes");
        // Pad and component rotations turn the other way from Waffle's angles: the outline points of
        // 45° oval pads in real boards lie along -rotation. Polygon pads keep their exact outline.
        const pad = {kind: "pad", number: String(f[8] || ""), x: q[0], y: q[1], w: r4(w), h: r4(h), drill: drill > 0 ? drill : 0, rotation: poly ? num(f[11]) : -num(f[11]),
          shape: shapeName === "ELLIPSE" && Math.abs(w - h) > 1e-6 ? "round" : pick(PAD_SHAPE, shapeName, "rect"), layer: l === "Multi" || drill > 0 ? "Multi" : l || "Top", net: f[7] || ""};
        if (f[15] === "N") pad.plated = false;
        if(Number.isFinite(parseFloat(f[17])))pad.pasteExpansion=r4(num(f[17])*U);
        if(Number.isFinite(parseFloat(f[18])))pad.maskExpansion=r4(num(f[18])*U);
        if (drill>0 && num(f[13])*U>drill) {
          pad.slotLength=r4(num(f[13])*U);
          const ends=pairs(f[14]);
          if(ends.length>=2)pad.slotAngle=r4(norm(Math.atan2(ends[1][1]-ends[0][1],ends[1][0]-ends[0][0])*180/Math.PI-pad.rotation));
        }
        if (poly) { pad.shape = "custom"; pad.poly = poly; }
        sink(pad);
      } else if (t === "COPPERAREA") {
        const l = stdLayer(f[2]), lines = svgPath(f[4]);
        if (!isCopper(l) || !lines.length) return;
        const pts = lines[0].map(mm);
        if (pts.length > 1 && A.same(pts[0], pts.at(-1))) pts.pop();
        if (pts.length < 3) return;
        const item = {kind: "polygon", points: pts, closed: true, layer: l, net: f[3] || "", connectStyle: f[8] === "direct" ? "direct" : "relief",
          viaConnectStyle: "direct", pourOverSameNet: true, removeDeadCopper: f[9] !== "yes", fillMode: "solid", pourIndex: 0};
        if (num(f[5]) > 0) item.clearance = r4(num(f[5]) * U);
        sink(item);
        notes.add("Copper areas import as unpoured polygon pours. Repour them before fabrication");
      } else if (t === "SOLIDREGION") {
        const l = stdLayer(f[1]), type = f[4];
        if (type === "npth" || +f[1] === 10 || +f[1] === 11 && type === "npth") { pathEdges(f[3]); return; }
        for (const line of svgPath(f[3])) {
          const p = line.map(mm);
          if (type === "cutout") sink({kind: "graphic", points: p, layer: "Keepout", width: .1, closed: true});
          else if (l) sink({kind: "graphic", points: p, layer: l, width: 0, closed: true, fill: true, ...(f[2] ? {net: f[2]} : {})});
        }
      } else if (["SVGNODE", "DIMENSION", "PROTRACTOR"].includes(t)) notes.add(t === "SVGNODE" ? "3D outlines omitted" : "Dimensions omitted");
      else if (t) notes.add("PCB " + t + " objects omitted");
    }
    const parts = new Map();
    standardShapes(data, notes, evidence, scope, (_raw, f, subs, record, index) => {
      if (f[0] !== "LIB") {
        const first = doc.items.length, edgeStart = edges.length;
        shape(f, o => {
          if (o.kind === "label" && o.hidden) return;
          if (o.kind === "circle") o = {kind: "graphic", points: G().circlePoints(o.c, o.r), layer: o.layer, width: o.width, closed: true};
          if (o.kind === "pad") { o.angle = r4(norm(o.rotation || 0)); delete o.rotation; }
          doc.items.push({id: A.id(), ...o});
        }, null);
        if (doc.items.length === first + 1) doc.items[first].sourceRecord = "easyeda/shape/" + index;
        if (record && doc.items[first]) { used(record, doc.items[first], boardApprox(f, false)); record.produced(doc, first); }
        if (record && edges.length > edgeStart) outlineSource(outlineRecords, edges, edgeStart, record, f[0] === "ARC" ? "Curved outline sampled into segments." : undefined);
        return;
      }
      const p = para(f[3]), origin = mm([num(f[1]), num(f[2])]), angle = r4(norm(-num(f[4])));
      const frame = {x: origin[0], y: origin[1], angle}, local = q => A.rotate([q[0] - origin[0], q[1] - origin[1]], -angle).map(r4);
      const pads = [], shapes = [];
      const item = {id: A.id(), kind: "part", def: "", ref: "", value: "", x: origin[0], y: origin[1], angle, layer: "Top", link: "", pinNets: {}};
      let bottom = 0, top = 0;
      for (let i = 0; i < subs.length; i++) F().guard(notes, () => {
        const fields = subs[i].split("~"), child = evidence?.row(fields[0], record.object + "#@$" + (i + 1));
        const padStart = pads.length, shapeStart = shapes.length, itemStart = doc.items.length, edgeStart = edges.length;
        const refAt = item.refAt, valueAt = item.valueAt;
        shape(fields, o => {
          if (o.kind === "pad") {
            const c = local([o.x, o.y]);
            if (o.layer === "Bottom") bottom++; else if (o.layer === "Top") top++;
            const pad = {number: o.number, x: c[0], y: c[1], w: o.w, h: o.h, drill: o.drill, shape: o.shape, angle: r4(norm(o.rotation - angle)), layer: o.layer, ...(o.poly ? {poly: o.poly} : {}),
              ...(o.slotLength ? {slotLength:o.slotLength,slotAngle:o.slotAngle || 0}:{}),
              ...(o.maskExpansion!=null?{maskExpansion:o.maskExpansion}:{}),...(o.pasteExpansion!=null?{pasteExpansion:o.pasteExpansion}:{})};
            if (o.plated === false) pad.plated = false;
            pads.push(pad);
            if (o.number && o.net) F().put(item.pinNets, o.number, o.net);
          } else if (o.kind === "label") {
            if (o.role === "P") { item.ref = o.text; item.refAt = local([o.x, o.y]); if (o.hidden) item.showRef = false; }
            else if (o.role === "N") { item.value = o.text; item.valueAt = local([o.x, o.y]); if (o.hidden) item.showValue = false; }
            else shapes.push({kind: "text", ...xy(local([o.x, o.y])), text: o.text, size: o.size, angle: r4(norm(o.angle - angle)), layer: o.layer, style: "silk"});
            if (o.layer === "Bottom silk" && o.role === "P") bottom++;
          } else if (o.kind === "circle") {
            const c = local(o.c);
            shapes.push({kind: "circle", x: c[0], y: c[1], r: r4(o.r), width: o.width, layer: o.layer, style: o.layer === "Silk" || o.layer === "Bottom silk" ? "silk" : "body"});
          } else if (o.kind === "via") doc.items.push({id: A.id(), ...o});
          else if (o.kind === "polygon") doc.items.push({id: A.id(), ...o});
          else if (o.points) {
            const style = /^Mechanical 1[34]$/.test(o.layer) ? "package" : o.layer === "Silk" || o.layer === "Bottom silk" ? "silk" : "body";
            shapes.push({kind: "path", points: o.points.map(local), style, width: o.width || 0, ...(style === "package" ? {} : {layer: o.layer}), closed: !!o.closed, fill: !!o.fill});
          }
        }, frame);
        if (child) {
          const target = pads[padStart] || shapes[shapeStart] || doc.items[itemStart] || (refAt !== item.refAt || valueAt !== item.valueAt ? item : null);
          if (target) used(child, target, boardApprox(fields, true));
          if (doc.items[itemStart]) child.produced(doc, itemStart);
          if (edges.length > edgeStart) outlineSource(outlineRecords, edges, edgeStart, child, fields[0] === "ARC" ? "Curved outline sampled into segments." : undefined);
        }
      });
      if (bottom > top) item.layer = "Bottom";
      item.ref ||= (p.pre || "U?").replace(/\?$/, "") + "?";
      if (!item.valueAt)item.value=p.value || "";
      item.link = "easyeda-" + item.ref;
      const fpName = p.package || "Footprint";
      const def = defs.add({id: A.id(), name: fpName, category: "EasyEDA footprints", prefix: item.ref.match(/^[A-Za-z]+/)?.[0] || "U", value: fpName,
        footprint: {name: fpName, pads, shapes}, sourceName: name}, JSON.stringify([fpName, pads, shapes]));
      item.def = def.id;
      parts.set(item.id, item);
      used(record, item);
      doc.items.push(item);
      record?.produced(doc, doc.items.length - 1);
    });
    finishOutline(doc, edges, outlineRecords, notes);
    const rule = data.DRCRULE?.Default;
    if (rule && typeof rule==="object")F().setClassRules(doc,standardDimensions(rule),{},evidence);
    const layerCount = (data.layers || []).map(l => +String(l).split("~")[0]).filter(n => n >= 21 && n <= 52).length;
    if (layerCount) notes.add("Inner layers are named Inner 1–" + layerCount + "; set the stack in Layer Stack Manager");
    return doc;
  }
  const xy = p => ({x: p[0], y: p[1]});

  // ------------------------------------------------------------ Professional
  const PRO_LAYER = {1: "Top", 2: "Bottom", 3: "Silk", 4: "Bottom silk", 5: "Top mask", 6: "Bottom mask", 7: "Top paste", 8: "Bottom paste",
    9: "Mechanical 13", 10: "Mechanical 14", 12: "Multi", 13: "Mechanical", 14: "Mechanical"};
  const proLayer = (id, names) => names.get(+id) || (+id >= 15 && +id <= 46 ? "Inner " + (+id - 14) : pick(PRO_LAYER, +id, null));
  function lines(text, evidence, member = "") {
    const result = [], input = String(text).split(/\r?\n/);
    for (let i = 0; i < input.length; i++) {
      const line = input[i].trim();
      if (!line) continue;
      let row;
      if (line[0] === "[") try { row = JSON.parse(line); } catch { /* incomplete line */ }
      const record = evidence && row?.[0] !== "DOCTYPE" && evidence.row(row?.[0], (member ? member + "#" : "") + "line " + (i + 1));
      if (Array.isArray(row)) { Object.assign(row,{line:i}); if (record) Object.assign(row, {fidelity: record}); result.push(row); }
      else if (record) record.omission = "Line is not a readable EasyEDA Pro JSON record.";
    }
    return result;
  }
  function proPadApprox(r) {
    const current = Array.isArray(r[10]) && typeof r[10][0] === "string";
    const shape = current ? r[10] : r[9];
    const hole = current ? r[9] : r.find((v, i) => i > 9 && Array.isArray(v) && /SLOT/i.test(String(v[0])));
    if (current && (r[17]!==r[18] || r[19]!==r[20]))return "Independent mask or paste expansion on the two sides is not represented by the native scalar.";
    if (Array.isArray(hole) && String(hole[0]).toUpperCase()==="RECT") return "Rectangular drill represented by an oblong slot.";
    if (!Array.isArray(shape) || !/^(RECT|ELLIPSE|ROUND|CIRCLE|OVAL|POLY)$/i.test(shape[0]) || Array.isArray(r[11]) && r[11].length) return "Pad stack represented by a native basic pad shape.";
    return undefined;
  }
  // Pro path arrays: [x, y, "L", x, y, ..., "ARC", angle, x, y, "CIRCLE", cx, cy, r, "R", x, y, w, h, ...].
  function proPath(a, map, depth = 0) {
    const out = [];
    if (!Array.isArray(a) || depth > 8) return out;
    if (Array.isArray(a[0])) { for (const sub of a) out.push(...proPath(sub, map, depth + 1)); return out; }
    let i = 0, line = null, cur = null;
    const n = () => {
      const v = a[i++], x = typeof v === "number" ? v : typeof v === "string" && v.trim() ? +v : NaN;
      if (!Number.isFinite(x)) throw Error("Invalid EasyEDA path.");
      return x;
    };
    while (i < a.length) {
      const t = a[i];
      if (t === "CIRCLE") { i++; const c = [n(), n()], r = n(); out.push(G().circlePoints(c, r).map(map)); line = null; continue; }
      if (t === "R") { i++; const x = n(), y = n(), w = n(), h = n(); out.push([[x, y], [x + w, y], [x + w, y - h], [x, y - h], [x, y]].map(map)); line = null; continue; }
      if (t === "L") { i++; continue; }
      if (t === "ARC" || t === "CARC") {
        i++; const ang = n(), end = [n(), n()];
        if (cur) { const pts = G().arcByAngle(cur, end, ang); line.push(...pts.slice(1).map(map)); }
        cur = end; continue;
      }
      if (typeof t === "string") { i++; continue; }
      const p = [n(), n()];
      if (!line) { line = []; out.push(line); }
      line.push(map(p)); cur = p;
    }
    const lines = out.filter(l => l.length >= 2);
    F().spend(lines.reduce((n, l) => n + l.length, 0));
    return lines;
  }
  function proBoard(name, rows, library, notes, defs, evidence) {
    const doc = A.sheet("pcb", F().stem(name));
    doc.sourceName = name; doc.sourceEncoding = "easyeda-pro";
    const mm = p => [r4(p[0] * MIL), r4(-p[1] * MIL)], names = new Map(), edges = [];
    const outlineRecords = evidence && [];
    for (const r of rows) if (r[0] === "LAYER") {
      const id = +r[1], s = String(r[2] || r[3] || "").toUpperCase();
      const m = /INNER[_ ]?(\d+)/.exec(s);
      const l = s === "TOP" ? "Top" : s === "BOTTOM" ? "Bottom" : m ? "Inner " + m[1] : /TOP_?SILK/.test(s) ? "Silk" : /BOT\w*_?SILK/.test(s) ? "Bottom silk" : /OUTLINE/.test(s) ? "Outline" : null;
      if (l) { names.set(id, l); used(r.fidelity, null, "Layer identity mapped to a native layer; source styling omitted."); }
    }
    const layerOf = id => proLayer(id, names);
    const parts = new Map(), attrs = [], padNets = [];
    for (const r of rows) F().guard(notes, () => {
      const t = r[0], first = doc.items.length;
      if (t === "LINE" || t === "ARC") {
        const l = layerOf(r[4]), a = [num(r[5]), num(r[6])], b = [num(r[7]), num(r[8])];
        const pts = t === "ARC" ? G().arcByAngle(a, b, num(r[9])).map(mm) : [mm(a), mm(b)], width = r4(num(t === "ARC" ? r[10] : r[9]) * MIL);
        if (l === "Outline") { edges.push(pts.length > 2 ? {kind: "arc", a: pts[0], m: pts[pts.length >> 1], b: pts.at(-1)} : {kind: "line", a: pts[0], b: pts[1]}); outlineRecords?.push(r.fidelity); return; }
        if (!l) return;
        doc.items.push({id: A.id(), kind: isCopper(l) ? "track" : "graphic", points: pts, layer: l, width, ...(isCopper(l) ? {net: String(r[3] || "")} : {})});
      } else if (t === "STRING") {
        const layer = layerOf(r[3]);
        if (layer) { const p = mm([num(r[4]), num(r[5])]); doc.items.push({id:A.id(),kind:"label",x:p[0],y:p[1],layer,text:String(r[6] ?? ""),size:r4(num(r[8],50)*MIL),angle:r4(norm(-num(r[13])))}); }
      } else if (t === "VIA") {
        const p = mm([num(r[5]), num(r[6])]), drill = r4(num(r[7]) * MIL), d = r4(num(r[8]) * MIL);
        if (d > 0) doc.items.push({id: A.id(), kind: "via", x: p[0], y: p[1], diameter: d, drill: drill > 0 && drill < d ? drill : r4(d / 2), layer: "Multi", net: String(r[3] || ""), ...(Number.isFinite(r[10]) && r[10]===r[11]?{maskExpansion:r4(r[10]*MIL)}:{})});
      } else if (t === "POLY" || t === "FILL") {
        const l = layerOf(r[4]), shapes = proPath(t === "POLY" ? r[6] : r[7], mm);
        if (l === "Outline") {
          const edgeStart = edges.length;
          for (const s of shapes) edges.push({kind: "path", points: s});
          outlineSource(outlineRecords, edges, edgeStart, r.fidelity, "Path converted to native outline segments.");
          return;
        }
        if (!l) return;
        for (const s of shapes) doc.items.push({id: A.id(), kind: "graphic", points: s, layer: l, width: r4(num(r[5]) * MIL), closed: t === "FILL", fill: t === "FILL", ...(t === "FILL" && r[3] ? {net: String(r[3])} : {})});
      } else if (t === "POUR") {
        const l = layerOf(r[4]), shapes = proPath(r[8], mm);
        if (!isCopper(l) || !shapes.length) return;
        const pts = shapes[0];
        if (A.same(pts[0], pts.at(-1))) pts.pop();
        if (pts.length >= 3) doc.items.push({id: A.id(), kind: "polygon", points: pts, closed: true, layer: l, net: String(r[3] || ""), name: String(r[6] || ""), pourIndex: num(r[7], 0),
          connectStyle: "relief", viaConnectStyle: "direct", pourOverSameNet: true, removeDeadCopper: true, fillMode: "solid"});
        notes.add("Pours import as unpoured polygon pours. Repour them before fabrication");
      } else if (t === "PAD") {
        const pad = proPad(r, mm, layerOf);
        if (pad) doc.items.push({id: A.id(), kind: "pad", ...pad.pad, net: String(r[3] || "")});
      } else if (t === "COMPONENT") {
        const p = mm([num(r[4]), num(r[5])]), angle = r4(norm(-num(r[6])));
        const item = {id: A.id(), kind: "part", def: "", ref: "", value: "", x: p[0], y: p[1], angle, layer: layerOf(r[3]) === "Bottom" ? "Bottom" : "Top", link: "", pinNets: {}};
        parts.set(String(r[1]), {item, source: r, attrs: Object.assign(Object.create(null), r[7] && typeof r[7] === "object" ? r[7] : {})});
      } else if (t === "ATTR") attrs.push(r);
      // Like ATTR, pad nets name their component by id: read them once every component is known.
      else if (t === "PADNET" || t === "PAD_NET") padNets.push(r);
      if (doc.items.length === first+1 && ["LINE","ARC","VIA","PAD","POLY","FILL","POUR","STRING"].includes(t)) doc.items[first].sourceRecord = "easyeda/line/" + r.line;
      if (r.fidelity && doc.items[first]) {
        const reason = t === "ARC" ? "Curved track sampled into segments." : t === "POUR" ? "First pour boundary imported; native fill is regenerated." :
          t === "POLY" || t === "FILL" ? "Path geometry converted to native graphics." : t === "PAD" ? proPadApprox(r) :
          t === "VIA" && !(num(r[7]) > 0 && num(r[7]) < num(r[8])) ? "Missing or invalid drill replaced by half the via diameter." : undefined;
        used(r.fidelity, doc.items[first], reason);
        r.fidelity.produced(doc, first);
      }
    });
    for (const r of padNets) {
      // PADNET: [.., componentId (3), padNumber, net]. EasyEDA Pro 2.x: ["PAD_NET", componentId, padNumber, net, padId].
      const k = r[0] === "PADNET" ? 3 : 1, part = parts.get(String(r[k]));
      if (part && F().put(part.item.pinNets, String(r[k + 1]), String(r[k + 2] || ""))) used(r.fidelity, part.item);
    }
    for (const a of attrs) {
      const part = parts.get(String(a[3]));
      if (part && typeof a[7] === "string") {
        part.attrs[a[7]] = a[8];
        if (a.fidelity) (part.attrRows ||= new Map()).set(a[7], a.fidelity);
      }
    }
    for (const {item, source, attrs: at, attrRows} of parts.values()) {
      item.ref = String(at.Designator || at.designator || "U?");
      const device = proDevice(library, at.Device);
      item.value = proText(at.Value ?? at.Name ?? device?.attributes?.Value ?? device?.attributes?.Name ?? device?.title ?? "", at, device);
      item.link = "easyeda-" + item.ref;
      const fpKey = String(at.Footprint || at.footprint || device?.attributes?.Footprint || ""), fp = library.footprints.get(fpKey);
      const fpName = fp?.title || String(at["Footprint Name"] || fpKey || "Footprint");
      const pads = [], shapes = [], toLocal = q => [r4(q[0] * MIL), r4(-q[1] * MIL)];
      if (fp) for (const r of fp.rows) F().guard(notes, () => {
        const firstPad = pads.length, firstShape = shapes.length;
        if (r[0] === "PAD") { const p = proPad(r, toLocal, layerOf); if (p) pads.push(p.pad); }
        else if (r[0] === "LINE" || r[0] === "ARC") {
          const l = layerOf(r[4]), a = [num(r[5]), num(r[6])], b = [num(r[7]), num(r[8])];
          if (!l || l === "Outline") return;
          shapes.push({kind: "path", points: r[0] === "ARC" ? G().arcByAngle(a, b, num(r[9])).map(toLocal) : [toLocal(a), toLocal(b)], style: l === "Silk" || l === "Bottom silk" ? "silk" : "body", layer: l,
            width: r4(num(r[0] === "ARC" ? r[10] : r[9]) * MIL), closed: false, fill: false});
        }
        else if (r[0] === "POLY" || r[0] === "FILL") {
          const layer = layerOf(r[4]), fill = r[0] === "FILL";
          if (!layer) return;
          for (const points of proPath(r[fill?7:6],toLocal)) shapes.push({kind:"path",layer,points,style:/silk/i.test(layer)?"silk":"body",width:r4(num(r[5])*MIL),closed:fill || A.same(points[0],points.at(-1)),fill});
        } else if (r[0] === "STRING") {
          const layer = layerOf(r[3]), p = toLocal([num(r[4]),num(r[5])]);
          if (layer) shapes.push({kind:"text",layer,x:p[0],y:p[1],size:r4(num(r[8],50)*MIL),text:String(r[6] ?? ""),angle:r4(norm(-num(r[13])))});
        }
        if (r.fidelity) {
          const target = pads[firstPad] || shapes[firstShape];
          if (target) used(r.fidelity, target, r[0] === "ARC" ? "Footprint arc sampled into segments." : r[0] === "PAD" ? proPadApprox(r) : undefined);
        }
      });
      if (!fp) notes.add("Components whose footprint is not in the project file have no pads");
      if (!pads.length && !shapes.length) shapes.push({kind: "circle", x: 0, y: 0, r: .5, width: .1, layer: "Silk", style: "silk"});
      if (item.layer === "Bottom") {
        for (const p of pads) { p.y = -p.y; p.angle = r4(norm(-p.angle)); if(p.slotAngle)p.slotAngle=-p.slotAngle;if(p.poly)p.poly=p.poly.map(q=>[q[0],-q[1]]);if (p.layer === "Top") p.layer = "Bottom"; }
        for (const s of shapes) { if (s.points) s.points = s.points.map(q => [q[0], -q[1]]); else s.y = -s.y; if (s.layer === "Silk") s.layer = "Bottom silk"; }
      }
      const def = defs.add({id: A.id(), name: fpName, category: "EasyEDA footprints", prefix: item.ref.match(/^[A-Za-z]+/)?.[0] || "U", value: fpName,
        footprint: {name: fpName, pads, shapes}, sourceName: name}, JSON.stringify([fpName, item.layer, pads, shapes]));
      item.def = def.id;
      doc.items.push(item);
      if (source.fidelity) {
        source.fidelity.produced(doc, doc.items.length - 1);
        used(source.fidelity, item, !fp ? "Placed without its missing footprint; placeholder graphics substituted." : undefined);
        if (attrRows) {
          const fields = [at.Designator ? "Designator" : "designator", at.Value ? "Value" : "Name", at.Footprint ? "Footprint" : "footprint"];
          if (device) fields.push("Device");
          if (!fp?.title) fields.push("Footprint Name");
          for (const key of fields) if (at[key]) used(attrRows.get(key), item, "Attribute applied to the native component.");
        }
        used(fp?.header, def, "Library metadata supplied a footprint definition.");
        used(fp?.meta, def, "Footprint title and identity supplied by the project metadata.");
        if (device) used(library.deviceRecords?.get(String(at.Device)), item, "Selected device fields supplied the native component.");
      }
    }
    finishOutline(doc, edges, outlineRecords, notes);
    notes.add("EasyEDA Pro boards are read from the published line format; check layers and footprints");
    return doc;
  }
  // EasyEDA Pro 2.x (the published format): ["PAD", id, group, net, layer, number, x, y, rotation,
  // hole ([ROUND|SLOT, w, h] or null), [shape, w, h, ...], specialPads, ...]. Older or hand-written
  // files put the shape at index 9 with the hole after it; an empty index 10 tells them apart.
  function proPad(r, map, layerOf) {
    const current = Array.isArray(r[10]) && r[10].length > 0 && typeof r[10][0] === "string";
    const s = current ? r[10] : Array.isArray(r[9]) ? r[9] : [], shape = String(s[0] || "RECT").toUpperCase(), c = map([num(r[6]), num(r[7])]);
    const custom=shape==="POLY"?proPath(s[1],q=>[r4(q[0]*MIL),r4(-q[1]*MIL)])[0]:null;
    const box=custom?.length ? A.bounds(custom):null;
    const w = box?r4(box[2]-box[0]):r4(num(s[1]) * MIL), h = box?r4(box[3]-box[1]):r4(num(s[2] ?? s[1]) * MIL);
    if (!(w > 0 && h > 0)) return null;
    const hole = current ? (Array.isArray(r[9]) && /ROUND|SLOT|CIRCLE|RECT/i.test(String(r[9][0])) ? r[9] : null) : r.find((v, i) => i > 9 && Array.isArray(v) && /ROUND|SLOT|CIRCLE/i.test(String(v[0])));
    const drill = hole ? r4(Math.min(num(hole[1]), num(hole[2] ?? hole[1])) * MIL) : 0, l = layerOf(r[4]);
    return {pad: {number: String(r[5] ?? ""), x: c[0], y: c[1], w, h, drill, angle: r4(norm(-num(r[8]))), layer: drill > 0 || l === "Multi" ? "Multi" : l || "Top",
      ...(current && Number.isFinite(r[17]) && r[17]===r[18]?{maskExpansion:r4(r[17]*MIL)}:{}),
      ...(current && Number.isFinite(r[19]) && r[19]===r[20]?{pasteExpansion:r4(r[19]*MIL)}:{}),
      ...(hole && num(hole[1])!==num(hole[2] ?? hole[1]) ? {slotLength:r4(Math.max(num(hole[1]),num(hole[2]))*MIL),slotAngle:r4(norm((num(hole[2])>num(hole[1])?90:0)-num(r[14])))} : {}),
      ...(current && r[15] === 0 ? {plated:false} : {}), ...(custom?{poly:custom}:{}), ...(shape === "RECT" && num(s[3])>0 ? {roundrectRadiusRatio:Math.min(.5,num(s[3])/Math.min(num(s[1]),num(s[2]))) } : {}),
      shape: custom?"custom":shape === "ELLIPSE" || shape === "ROUND" || shape === "CIRCLE" ? (w === h ? "round" : "oval") : shape === "OVAL" ? "oval" : num(s[3]) > 0 ? "roundrect" : "rect"}};
  }
  function proSheet(name, rows, library, notes, defs, title) {
    const doc = A.sheet("schematic", title || F().stem(name));
    doc.sourceName = name; doc.sourceEncoding = "easyeda-pro"; doc.grid = 2.54;
    const mm = p => [r4(p[0] * U), r4(-p[1] * U)], comps = new Map(), wires = new Map(), attrs = [];
    const styles = new Map(rows.filter(r=>r[0]==="FONTSTYLE" || r[0]==="LINESTYLE").map(r=>[r[1],r]));
    for (const r of rows) F().guard(notes, () => {
      if (r[0] === "WIRE" || r[0] === "BUS") {
        const ids = [];
        for (const seg of Array.isArray(r[2]) ? r[2] : []) { const p = []; for (let i = 0; i + 1 < seg.length; i += 2) p.push(mm([num(seg[i]), num(seg[i + 1])])); if (p.length >= 2) { const it = {id: A.id(), kind: r[0]==="BUS"?"bus":"wire", points: p}; doc.items.push(it); ids.push(it); } }
        wires.set(String(r[1]), ids);
        if (ids.length && r.fidelity) {
          used(r.fidelity, ids[0], ids.length > 1 ? "Wire split into separate native segments." : undefined);
          r.fidelity.produced(doc, doc.items.length - ids.length);
        }
      } else if (r[0] === "TEXT" || r[0] === "POLY" || r[0] === "RECT" || r[0] === "CIRCLE") {
        let item;
        if (r[0]==="TEXT") {
          const p=mm([num(r[2]),num(r[3])]);
          item={kind:"label",x:p[0],y:p[1],angle:r4(norm(-num(r[4]))),text:String(r[5] ?? ""),size:r4(soft(styles.get(r[6])?.[5],7)*U)};
        } else {
          let points, closed=true;
          if (r[0]==="POLY") {
            points=[];for(let i=0;i+1<(r[2]?.length || 0);i+=2)points.push(mm([num(r[2][i]),num(r[2][i+1])]));
            closed=!!r[3];
          } else if (r[0]==="RECT") { const [x1,y1,x2,y2]=[r[2],r[3],r[4],r[5]].map(v=>num(v)); points=[[x1,y1],[x2,y1],[x2,y2],[x1,y2]].map(mm); }
          else points=G().circlePoints([num(r[2]),num(r[3])],num(r[4])).map(mm);
          if(points.length>=2) {const style=styles.get(r[r[0]==="POLY"?4:r[0]==="RECT"?9:5]);item={kind:"graphic",points,closed,fill:!!style?.[4],width:r4(soft(style?.[5],1)*U)};}
        }
        if(item){item.id=A.id();doc.items.push(item);used(r.fidelity,item,r[0]==="CIRCLE"?"Circle converted to editable vertices.":undefined);r.fidelity?.produced(doc,doc.items.length-1);}
      } else if (r[0] === "COMPONENT") comps.set(String(r[1]), {r, attrs: Object.create(null), pos: mm([num(r[3]), num(r[4])]), turn: num(r[5])});
      else if (r[0] === "ATTR") attrs.push(r);
    });
    for (const a of attrs) F().guard(notes, () => {
      const key = String(a[3] ?? ""), value = a[4], parent = String(a[2] ?? "");
      if (comps.has(parent)) {
        const comp = comps.get(parent);
        comp.attrs[key] = value;
        if (a.fidelity) (comp.attrRows ||= new Map()).set(key, a.fidelity);
        if (key==="Designator" || key==="Value") (comp.display ||= new Map()).set(key,a);
      } else if (wires.has(parent) && /^NET$/i.test(key) && value) {
        const native = wires.get(parent);
        for (const w of native) w.net = String(value);
        if (a[6] && Number.isFinite(a[7]) && Number.isFinite(a[8])) {
          const p=mm([a[7],a[8]]);doc.items.push({id:A.id(),kind:"netlabel",x:p[0],y:p[1],text:String(value),angle:r4(norm(-num(a[9])))});
          a.fidelity?.produced(doc,doc.items.length-1);
        }
        if (native.length) used(a.fidelity, native[0]);
      }
    });
    for (const {r, attrs: at, attrRows, display, pos: p, turn} of comps.values()) {
      const mirror=!!r[6], angle=r4(norm((mirror?1:-1)*turn));
      // Pro 2.x names the symbol through the component's Device (project.json devices) or a Symbol
      // attribute; older files name it in the COMPONENT row ("<symbol>.<part>").
      const device = proDevice(library, at.Device);
      const symKey = String(at.Symbol || device?.attributes?.Symbol || String(r[2] || "").split(".")[0]);
      const sym = library.symbols.get(symKey) || library.symbols.get(String(r[2] || "").split(".")[0]);
      const netName = at["Global Net Name"] || at.Name || "";
      if (sym?.type === "frame") { if (r.fidelity) r.fidelity.omission = "Drawing frame omitted."; notes.add("Drawing frames omitted"); continue; }
      if (sym?.type === "netflag" || /^(gnd|vcc|power)/i.test(String(at["Symbol Type"] || ""))) {
        if (netName) { doc.items.push({id: A.id(), kind: "power", x: p[0], y: p[1], text: String(netName), style: /gnd|ground/i.test(netName) ? "gnd" : "bar", direction: /gnd|ground/i.test(netName) ? 3 : 1});
          r.fidelity?.produced(doc, doc.items.length - 1);
          used(sym?.meta, doc.items.at(-1), "Symbol type mapped to a native net flag.");
          used(r.fidelity, doc.items.at(-1), "Net flag redrawn as a native power port."); used(attrRows?.get(at["Global Net Name"] ? "Global Net Name" : "Name"), doc.items.at(-1));
        }
        continue;
      }
      if (sym?.type === "netport") {
        if (netName) { doc.items.push({id: A.id(), kind: "offsheet", x: p[0], y: p[1], text: String(netName), angle}); r.fidelity?.produced(doc, doc.items.length - 1); used(r.fidelity, doc.items.at(-1)); used(attrRows?.get(at["Global Net Name"] ? "Global Net Name" : "Name"), doc.items.at(-1)); }
        continue;
      }
      if (!sym) { if (r.fidelity) r.fidelity.omission = "Referenced library symbol is missing."; notes.add("Components whose symbol is not in the project file omitted"); continue; }
      const geo = proSymbol(sym, notes);
      const ref = String(at.Designator || "U?").replace(/\.\d+$/, ""), value = proText(at.Value ?? at.Name ?? device?.attributes?.Value ?? device?.attributes?.Name ?? device?.title ?? "", at, device);
      const fpName = String(at["Footprint Name"] || library.footprints.get(String(device?.attributes?.Footprint || ""))?.title || "");
      const def = defs.add({id: A.id(), name: sym.title || symKey, category: "EasyEDA symbols", prefix: ref.replace(/[?\d]+$/, "") || "U", value, symbol: geo,
        footprintName: fpName, parameters: {}, sourceName: name}, JSON.stringify([symKey, fpName]));
      const item = {id: A.id(), kind: "part", def: def.id, ref, value, link: "easyeda-" + ref, pinNets: {}, x: p[0], y: p[1], angle};
      if (mirror) item.mirror = true;
      for(const [key,a] of display || []) {
        const ref=key==="Designator";
        if(a[6]!=null)item[ref?"showRef":"showValue"]=!!a[6];
        if(Number.isFinite(a[7]) && Number.isFinite(a[8])) {
          const q=mm([a[7],a[8]]), local=A.rotate([q[0]-p[0],q[1]-p[1]],-angle);
          item[ref?"refAt":"valueAt"]=[r4(mirror?-local[0]:local[0]),r4(local[1])];
        }
      }
      for (const [key,value] of Object.entries(at)) if (!["Device","Symbol","Designator","Value","Name","Footprint","Footprint Name"].includes(key) && (typeof value==="string" || typeof value==="number")) F().put(item.parameters ||= {},key,String(value));
      if (geo.parts > 1) item.unit = Math.max(1, Math.min(geo.parts, +(/(?:^|\.)(\d+)$/.exec(String(r[2] || ""))?.[1] || 1)));
      doc.items.push(item);
      if (r.fidelity) {
        r.fidelity.produced(doc, doc.items.length - 1);
        used(r.fidelity, item);
        used(sym.header, def, "Library metadata supplied a symbol definition.");
        used(sym.meta, def, "Symbol title and type supplied by the project metadata.");
        if (device) used(library.deviceRecords?.get(String(at.Device)), item, "Selected device fields supplied the native component.");
        if (attrRows) {
          const fields = ["Designator", at.Value ? "Value" : "Name", "Footprint Name"];
          if (device) fields.push("Device");
          if (at.Symbol && library.symbols.get(String(at.Symbol)) === sym) fields.push("Symbol");
          for (const key of fields) if (at[key]) used(attrRows.get(key), item, "Attribute applied to the native component.");
        }
      }
    }
    notes.add("EasyEDA Pro schematics are read from the published line format; check symbols and net labels");
    return doc;
  }
  // A Pro symbol; ["PART", "<name>.<n>", ...] rows start gate n of a multi-part symbol.
  function proSymbol(sym, notes) {
    const map = p => [r4(p[0] * U), r4(-p[1] * U)], shapes = [], pins = [], pinAttrs = new Map();
    const partOf = v => { const m = /\.(\d+)$/.exec(String(v || "")); return m ? Math.min(64, +m[1]) : 0; };
    const parts = Math.max(1, ...sym.rows.filter(r => r[0] === "PART").map(r => partOf(r[1])));
    let part = 0;
    const attrSources = sym.reported ? new Map() : null;
    for (const r of sym.rows) if (r[0] === "ATTR" && r[2]) { if (!pinAttrs.has(String(r[2]))) pinAttrs.set(String(r[2]), Object.create(null)); pinAttrs.get(String(r[2]))[String(r[3])] = r[4];
      if (attrSources && r.fidelity) attrSources.set(String(r[2]) + "\u001f" + r[3], r.fidelity);
    }
    const tag = () => parts > 1 && part > 0 ? {part} : {};
    for (const r of sym.rows) F().guard(notes, () => {
      if (r[0] === "PART") { part = partOf(r[1]); if (part) used(r.fidelity); return; }
      const n0 = shapes.length, p0 = pins.length;
      if (r[0] === "PIN") {
        const c = [num(r[4]), num(r[5])], len = num(r[6]), a = num(r[7]) * Math.PI / 180, inner = [c[0] + len * Math.cos(a), c[1] + len * Math.sin(a)];
        const at = pinAttrs.get(String(r[1])) || {}, hot = map(c);
        pins.push({x: hot[0], y: hot[1], number: String(at["Pin Number"] ?? at.NUMBER ?? ""), name: String(at["Pin Name"] ?? at.NAME ?? ""), hidden: r[2]===0, electrical: pick(ELECTRIC,r[3],7)});
        if (len) shapes.push({kind: "path", style: "body", points: [hot, map(inner)], closed: false, fill: false, width: 0});
      } else if (r[0] === "RECT") {
        const x1 = num(r[2]), y1 = num(r[3]), x2 = num(r[4]), y2 = num(r[5]);
        shapes.push({kind: "path", style: "body", points: [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]].map(map), closed: true, fill: false, width: .254});
      } else if (r[0] === "POLY") {
        const a = Array.isArray(r[2]) ? r[2] : [], p = [];
        for (let i = 0; i + 1 < a.length; i += 2) p.push(map([num(a[i]), num(a[i + 1])]));
        if (p.length >= 2) shapes.push({kind: "path", style: "body", points: p, closed: !!r[3], fill: false, width: .254});
      } else if (r[0] === "CIRCLE") { const c = map([num(r[2]), num(r[3])]); shapes.push({kind: "circle", style: "body", x: c[0], y: c[1], r: r4(num(r[4]) * U), width: .254}); }
      if (r.fidelity) {
        const target = pins[p0] || shapes[n0];
        if (target) used(r.fidelity, target, r[0] === "PIN" && (r[3]==null || !Object.hasOwn(ELECTRIC,r[3])) ? "Unspecified electrical pin type." : undefined);
        if (pins[p0] && attrSources) for (const key of ["Pin Number", "NUMBER", "Pin Name", "NAME"]) used(attrSources.get(String(r[1]) + "\u001f" + key), pins[p0]);
      }
      for (let i = n0; i < shapes.length; i++) Object.assign(shapes[i], tag());
      for (let i = p0; i < pins.length; i++) Object.assign(pins[i], tag());
    });
    return parts > 1 ? {shapes, pins, parts} : {shapes, pins};
  }
  function proLibrary(files, io, evidence) {
    const symbols = new Map(), footprints = new Map();
    let meta = {};
    const pj = [...files.keys()].find(k => /(^|\/)project\.json$/i.test(k));
    if (pj) try { meta = JSON.parse(io.utf8(files.get(pj))); } catch { meta = {}; }
    const metaRecords = evidence && {symbols: new Map(), footprints: new Map(), devices: new Map()};
    if (metaRecords && pj) {
      for (const [field, values] of Object.entries(meta || {})) {
        const group = Object.hasOwn(metaRecords, field) && metaRecords[field];
        const locator = pj + "#$[" + JSON.stringify(field) + "]";
        if (!group || !values || typeof values !== "object") { evidence.row("project field", locator); continue; }
        for (const key of Object.keys(values)) group.set(key, evidence.row("project " + field, locator + "[" + JSON.stringify(key) + "]"));
      }
    }
    for (const [k, bytes] of files) {
      const m = /(?:^|\/)(SYMBOL|FOOTPRINT)\/([^/]+)\.(esym|efoo)$/i.exec(k);
      if (!m) continue;
      const rows = lines(io.utf8(bytes), evidence, k), key = m[2], header = rows.find(r => r[0] === "HEAD"), head = header?.[1] || {};
      const info = pick((m[1].toUpperCase() === "SYMBOL" ? meta.symbols : meta.footprints), key, null) || {};
      const group = m[1].toUpperCase() === "SYMBOL" ? "symbols" : "footprints";
      const entry = {rows, title: info.title || head.title || key, type: proType(info.type ?? head.symbolType)};
      if (evidence) Object.assign(entry, {reported: true, header: (!info.title && head.title || info.type == null && head.symbolType != null) ? header?.fidelity : null,
        meta: info.title || info.type != null ? metaRecords[group].get(key) : null});
      (m[1].toUpperCase() === "SYMBOL" ? symbols : footprints).set(key, entry);
    }
    const devices = new Map();
    if (meta.devices && typeof meta.devices === "object") for (const [k, v] of Object.entries(meta.devices)) if (v && typeof v === "object") devices.set(k, v);
    return {symbols, footprints, devices, deviceRecords: metaRecords?.devices, pcbs:meta.pcbs, schematics:meta.schematics};
  }
  // Pro 2.x symbol types are numbers: 2 component, 18 net flag (power/ground), 20 drawing frame.
  const proType = t => { const v = String(t ?? "").toLowerCase(); return v === "18" ? "netflag" : v === "20" ? "frame" : v; };
  const proDevice = (library, id) => id != null && library.devices?.get(String(id)) || null;
  // Pro attribute values may be references to another attribute: "={Manufacturer Part}".
  function proText(v, at, device) {
    const m = /^=\{([^{}]+)\}$/.exec(String(v ?? "").trim());
    if (!m) return String(v ?? "");
    const ref = at?.[m[1]] ?? device?.attributes?.[m[1]];
    return ref == null || /^=\{/.test(String(ref)) ? "" : String(ref);
  }

  function standardMetadata(data, scope, doc, evidence) {
    if (!evidence) return;
    for (const key of Object.keys(data)) {
      if (key === "shape" || key === "docType") continue;
      const at = scope + "[" + JSON.stringify(key) + "]";
      if (key === "head") {
        if (data.head && typeof data.head === "object") for (const field of Object.keys(data.head)) if (field !== "docType") evidence.row("header field", at + "[" + JSON.stringify(field) + "]");
      } else if (key === "layers" && Array.isArray(data.layers)) {
        for (let i = 0; i < data.layers.length; i++) evidence.row("layer settings", at + "[" + i + "]");
      } else if (key === "DRCRULE" && data[key] && typeof data[key] === "object") {
        const mapping = {clearance: "clearance", trackWidth: "trackWidth", viaHoleD: "viaDrill"};
        for (const [group, rules] of Object.entries(data[key])) {
          const groupAt = at + "[" + JSON.stringify(group) + "]";
          if (!rules || typeof rules !== "object") { evidence.row("design rule", groupAt); continue; }
          for (const [field, value] of Object.entries(rules)) {
            const record = evidence.row("design rule", groupAt + "[" + JSON.stringify(field) + "]");
            const native = doc.rules?.defaults, mm = r4(soft(value, NaN) * U);
            if (group === "Default" && Object.hasOwn(mapping, field) && mm > 0 && native?.[mapping[field]] === mm) used(record);
          }
        }
      } else {
        const record = evidence.row("document field", at);
        if (key === "canvas" && doc.kind === "pcb") used(record, null, "Canvas origin used for coordinates; display settings omitted.");
        else if (key === "title" && data.title === doc.name) used(record, doc);
      }
    }
  }
  // ------------------------------------------------------------ entry
  // An edit compares against the geometry the user actually received. Persist the
  // bounded digest on the existing source reference, never a second design model.
  let recordEncoder;
  function fingerprint(item) {
    const canonical=v=>Array.isArray(v)?v.map(canonical):v && typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
    const {id,sourceRecord,...geometry}=item;
    recordEncoder ||= new TextEncoder();
    return AtriumSourceFile.sha256(recordEncoder.encode(JSON.stringify(canonical(geometry))));
  }
  function read(name, bytes, io) {
    const sink=io.fidelity, omissions=new Map(), capture=sink?.captureEasyEDA;
    const observer=capture?{...sink,add(kind,status,ref,reason,count=1){
      sink.add(kind,status,ref,reason,count);
      if(status!=="dropped")return;
      const scope=kind==="archive member"?"@archive":ref.object.includes(".shape[")?ref.object.split(".shape[")[0]:
        /#line \d+$/.test(ref.object)?ref.object.slice(0,ref.object.lastIndexOf("#line ")):
        /^line \d+$/.test(ref.object)?name:null;
      if(!scope)return;
      const key=JSON.stringify([scope,kind,reason]), old=omissions.get(key);
      if(old)old.count+=count;else omissions.set(key,{scope,kind,object:ref.object,reason,count});
    }}:sink;
    const evidence=observer && sourceEvidence(name,observer);
    const result=readDocument(name,bytes,io,evidence,"");
    evidence?.finish();
    if(capture){
      for(const d of result.documents)for(const i of d.items)if(i.sourceRecord)i.sourceRecord+="/"+fingerprint(i);
      capture([...omissions.values()]);
    }
    io.fidelity?.note?.("EasyEDA counts shapes and their nested records, project metadata entries, and Pro records by their original member and line. Format headers and individual style values have no separate rows.");
    return result;
  }
  function readDocument(name, bytes, io, evidence, member, parsed) {
    const notes = F().notebook(), defs = F().definitions(), documents = [];
    const done = () => { const list = notes.list(); for (const d of documents) d.notes = list.slice(); return {documents, library: defs.list, notes: list}; };
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const files = io.unzip(bytes), library = proLibrary(files, io, evidence);
      const docs = [...files.keys()].filter(k => /\.(esch|epcb)$/i.test(k)).sort();
      for (const k of docs) {
        const rows = lines(io.utf8(files.get(k)), evidence, k);
        if (/\.epcb$/i.test(k)) {
          const d = proBoard(F().stem(name) + ".epcb", rows, library, notes, defs, evidence);
          const title = pick(library.pcbs, F().stem(k), null);
          if (typeof title === "string" && title) d.name = title;
          documents.push(d);
        } else {
          const m = /(?:^|\/)SHEET\/([^/]+)\/(\d+)\.esch$/i.exec(k);
          const info = m && pick(library.schematics, m[1], null);
          const title = Array.isArray(info?.sheets) && info.sheets.find(s => String(s?.id) === m[2])?.name;
          documents.push(proSheet(F().stem(name) + ".esch", rows, library, notes, defs, typeof title === "string" && title || F().stem(name) + " " + (documents.filter(d => d.kind === "schematic").length + 1)));
        }
      }
      if (!docs.length) {
        const results=[];
        for (const [path,inner] of files) {
          if (!/\.json$/i.test(path) || /(?:^|\/)project\.json$/i.test(path)) { evidence?.row("archive member",path);continue; }
          // All source documents in a Standard project ZIP share the outer byte and geometry budget.
          if (inner[0]===0x50 && inner[1]===0x4b) throw F().fatal("This EasyEDA archive contains another archive ("+path+"). Nested archives are not opened; extract it first.");
          let data;
          try {data=JSON.parse(io.utf8(inner));} catch { /* optional non-design member */ }
          if (!Array.isArray(data?.schematics) && !["1","3"].includes(String(data?.head?.docType ?? data?.docType))) { evidence?.row("archive member",path);continue; }
          results.push(readDocument(F().baseName(path),inner,io,evidence,path,data));
        }
        if (results.length) return {documents:results.flatMap(r=>r.documents),library:results.flatMap(r=>r.library),notes:[...new Set(results.flatMap(r=>r.notes))]};
        throw Error("The EasyEDA project archive contains no schematic or PCB documents.");
      }
      if (evidence) for (const path of files.keys()) {
        if (/\.(esch|epcb)$/i.test(path) || /(?:^|\/)(SYMBOL|FOOTPRINT)\/[^/]+\.(esym|efoo)$/i.test(path) || /(^|\/)project\.json$/i.test(path)) continue;
        evidence.row("archive member", path);
      }
      return done();
    }
    const rawText = parsed ? "" : io.utf8(bytes), text = rawText.trim();
    if (text.startsWith("[")) {
      const rows = lines(rawText, evidence, member), type = String(rows.find(r => r[0] === "DOCTYPE")?.[1] || "").toUpperCase();
      if (!rows.length) throw Error("This is not an EasyEDA Pro document.");
      const library = {symbols: new Map(), footprints: new Map(), devices: new Map()};
      documents.push(type === "PCB" || /\.epcb$/i.test(name) ? proBoard(name, rows, library, notes, defs, evidence) : proSheet(name, rows, library, notes, defs));
      return done();
    }
    let data;
    try { data = parsed || JSON.parse(text); } catch { throw Error("This is not an EasyEDA file (invalid JSON)."); }
    const base = member ? member + "#$" : "$";
    function standard(data, scope, sheet, title) {
      const doc = sheet ? stdSheet(name, data, title, notes, defs, evidence, scope) : stdBoard(name, data, notes, defs, evidence, scope);
      if (!sheet && typeof (title || data.title) === "string" && (title || data.title)) doc.name = title || data.title;
      standardMetadata(data, scope, doc, evidence);
      documents.push(doc);
    }
    if (Array.isArray(data?.schematics)) {
      data.schematics.forEach((s, i) => {
        const d = typeof s.dataStr === "string" ? JSON.parse(s.dataStr) : s.dataStr || s;
        standard(d, evidence && base + ".schematics[" + i + "]" + (s.dataStr ? ".dataStr" : ""), true, s.title || F().stem(name) + " " + (i + 1));
      });
      if (Array.isArray(data.pcbs)) data.pcbs.forEach((p, i) => standard(typeof p.dataStr === "string" ? JSON.parse(p.dataStr) : p.dataStr || p,
        evidence && base + ".pcbs[" + i + "]" + (p.dataStr ? ".dataStr" : ""), false, p.title));
      if (evidence) for (const key of Object.keys(data)) if (key !== "schematics" && key !== "pcbs") evidence.row("project field", base + "[" + JSON.stringify(key) + "]");
      return done();
    }
    const docType = String(data?.head?.docType ?? data?.docType ?? "");
    if (docType === "1") standard(data, base, true, data.title || F().stem(name));
    else if (docType === "3") standard(data, base, false);
    else if (docType === "2" || docType === "4") throw Error("EasyEDA library documents are not imported. Open a schematic or PCB.");
    else throw Error("This JSON file is not an EasyEDA schematic or PCB document.");
    return done();
  }
  return {read, svgPath, fingerprint, standardDimensions};
})();
