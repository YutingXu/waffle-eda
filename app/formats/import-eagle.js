"use strict";
// Eagle 6–9 importer: XML .sch schematics and .brd boards, read from the
// publicly documented eagle.dtd. Eagle works in millimetres with Y up and
// counter-clockwise angles; Waffle is Y down with clockwise angles, so a point
// (x, y) becomes (x, -y) and an angle a becomes -a. A rotation "MR90" mirrors
// about the Y axis before rotating; mirrored board elements sit on the bottom.
globalThis.AtriumEagleImport = (() => {
  const A = Atrium, F = () => AtriumImportFormats, G = () => AtriumImportFormats.geom;
  const r4 = v => Math.round(v * 1e4) / 1e4 + 0;
  const n360 = a => ((a % 360) + 360) % 360;
  const norm = a => { const v = n360(a); return v > 180 ? v - 360 : v; };

  // ------------------------------------------------------------ XML
  const ENT = {amp: "&", lt: "<", gt: ">", quot: '"', apos: "'"};
  const decode = s => s.indexOf("&") < 0 ? s : s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === "#" ? codePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : Object.hasOwn(ENT, e) ? ENT[e] : m);
  const codePoint = c => Number.isInteger(c) && c >= 0 && c <= 0x10ffff ? String.fromCodePoint(c) : "\ufffd";
  // Only the five predefined entities and character references are expanded: DTD entity
  // declarations are skipped, so nested-entity expansion ("billion laughs") cannot happen.
  const MAX_DEPTH = 256, MAX_ELEMENTS = 8e6;
  // A source element can supply several placements. Collect its outcome once, even
  // for unused library records, and leave file data out of the editable model.
  const containers = new Set("eagle drawing schematic settings layers libraries library packages symbols devicesets gates devices connects technologies parts sheets instances plain nets segments busses elements signals classes designrules".split(" "));
  const objectKinds = new Set("board sheet part instance symbol pin gate device deviceset connect package element wire text frame rectangle circle polygon vertex junction label net signal bus segment pinref contactref attribute param class clearance smd pad hole via dimension layer grid setting description technology".split(" "));
  function sourceEvidence(file, sink) {
    const records = [];
    const ref = el => ({file, object: "<" + el.name.slice(0, 96) + "> at character " + el.sourceOffset});
    return {
      see(el, start) {
        if (containers.has(el.name)) return;
        el.sourceOffset = start;
        if (!objectKinds.has(el.name)) {
          sink.add("Other Eagle element", "dropped", ref(el), "Unsupported Eagle element <" + el.name.slice(0, 96) + ">.");
          return;
        }
        records.push(el);
      },
      use(el, item, reason) {
        if (el?.sourceOffset == null) return;
        el.represented = true;
        if (item && !el.target) el.target = item;
        if (reason) el.approximation = reason;
      },
      drop(el, reason) { if (el) el.omission = reason; },
      produced(el, doc, first) {
        if (!sink.produced) return;
        const source = ref(el);
        for (let i = first; i < doc.items.length; i++) sink.produced(doc.kind, source, doc.items[i]);
      },
      finish() {
        for (const el of records) {
          const kind = el.name.slice(0, 96), source = ref(el);
          const status = el.approximation ? "approximated" : el.represented ? "kept" : "dropped";
          const reason = el.approximation || (el.represented ? undefined : el.omission || "No native representation was produced for this Eagle element.");
          if (el.target && sink.track) sink.track(kind, status, source, el.target, reason);
          else sink.add(kind, status, source, reason);
        }
      }
    };
  }
  function graphicApprox(el) {
    if (num(el.attrs.curve) || el.name === "polygon" && el.children.some(v => num(v.attrs.curve))) return "Curves were converted to line segments.";
    if (el.name === "frame") return "Only the rectangular drawing frame was imported.";
    if (el.name === "rectangle" && rotOf(el.attrs.rot).angle) return "The rectangle rotation was omitted.";
    return undefined;
  }
  function parseXML(text, evidence) {
    const root = {name: "#root", attrs: Object.create(null), children: [], text: ""}, stack = [root], n = text.length;
    let count = 0;
    const attr = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
    let i = 0;
    while (i < n) {
      const lt = text.indexOf("<", i);
      const top = stack[stack.length - 1];
      if (lt < 0) break;
      if (lt > i) { const t = text.slice(i, lt); if (/\S/.test(t)) top.text += decode(t); }
      if (text.startsWith("<!--", lt)) { const e = text.indexOf("-->", lt + 4); i = e < 0 ? n : e + 3; continue; }
      if (text.startsWith("<![CDATA[", lt)) { const e = text.indexOf("]]>", lt); top.text += text.slice(lt + 9, e < 0 ? n : e); i = e < 0 ? n : e + 3; continue; }
      if (text[lt + 1] === "?") { const e = text.indexOf("?>", lt); i = e < 0 ? n : e + 2; continue; }
      if (text[lt + 1] === "!") {
        let depth = 0, j = lt + 2;
        for (; j < n; j++) { const c = text[j]; if (c === "[") depth++; else if (c === "]") depth--; else if (c === ">" && depth <= 0) break; }
        i = j + 1; continue;
      }
      if (text[lt + 1] === "/") {
        const e = text.indexOf(">", lt);
        if (e < 0) throw Error("Malformed XML: the file is truncated.");
        const name = text.slice(lt + 2, e).trim();
        if (stack.length < 2 || stack[stack.length - 1].name !== name) throw Error("Malformed XML: unexpected </" + name + ">.");
        stack.pop(); i = e + 1; continue;
      }
      let j = lt + 1;
      while (j < n && !/[\s/>]/.test(text[j])) j++;
      const el = {name: text.slice(lt + 1, j), attrs: Object.create(null), children: [], text: ""};
      if (++count > MAX_ELEMENTS) throw Error("The XML file has too many elements.");
      attr.lastIndex = j;
      for (let m; (m = attr.exec(text));) { el.attrs[m[1]] = decode(m[2] ?? m[3]); j = attr.lastIndex; }
      while (j < n && /\s/.test(text[j])) j++;
      top.children.push(el);
      evidence?.see(el, lt);
      if (text[j] === "/" && text[j + 1] === ">") i = j + 2;
      else if (text[j] === ">") { if (stack.length > MAX_DEPTH) throw Error("The XML nests elements too deeply."); stack.push(el); i = j + 1; }
      else throw Error("Malformed XML near character " + j + ".");
    }
    if (stack.length !== 1) throw Error("Malformed XML: the file is truncated.");
    return root;
  }
  const kids = (el, name) => el ? el.children.filter(c => c.name === name) : [];
  const kid = (el, name) => el?.children.find(c => c.name === name);
  const path = (el, ...names) => names.reduce((e, n) => kid(e, n), el);
  const num = (v, d = 0) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };
  // "8mil", "0.2mm", "0.01in" -> mm; bare numbers are millimetres.
  const length = v => { const m = /^\s*(-?[\d.]+(?:e-?\d+)?)\s*(mm|mil|in|mic)?\s*$/i.exec(String(v ?? "")); if (!m) return NaN; return +m[1] * ({mil: .0254, in: 25.4, mic: .001}[(m[2] || "mm").toLowerCase()] || 1); };
  const rotOf = r => { const s = String(r || "R0"); return {mirror: /M/.test(s), angle: num(s.replace(/[^\d.-]/g, ""), 0)}; };
  const yesno = v => v === "yes";
  const flip = (x, y) => [r4(+x), r4(-y)];
  // Eagle circle: radius 0 with a width is a dot of that diameter (pin-1 markers); width 0 is filled.
  function circleSize(a, defaultWidth) {
    const r = num(a.radius, 1), width = num(a.width, defaultWidth);
    if (!(r > 0) && width > 0) return {r: r4(width / 2), width: 0, fill: true};
    return {r, width, ...(width === 0 ? {fill: true} : {})};
  }

  function wireCoordinates(a) {
    const coords = [a.x1, a.y1, a.x2, a.y2].map(value => value?.trim() ? Number(value) : NaN);
    return coords.every(Number.isFinite) ? coords : null;
  }
  // Wire with optional curve -> points in Waffle axes.
  function wirePoints(a, mapping = p => flip(p[0], p[1])) {
    const coords = wireCoordinates(a);
    if (!coords) throw Error("Invalid Eagle wire coordinates.");
    const [x1, y1, x2, y2] = coords, p1 = [x1, y1], p2 = [x2, y2], curve = num(a.curve);
    const pts = curve ? G().arcByAngle(p1, p2, curve) : [p1, p2];
    F().spend(pts.length);
    return pts.map(mapping);
  }
  // A Dimension-layer wire as a board edge: true arcs stay arcs.
  function edgeOf(a, mapping) {
    const pts = wirePoints(a, mapping);
    return pts.length > 2 ? {kind: "arc", a: pts[0], m: pts[pts.length >> 1], b: pts.at(-1)} : {kind: "line", a: pts[0], b: pts[1]};
  }
  function polygonPoints(el, mapping = p => flip(p[0], p[1])) {
    const v = kids(el, "vertex"), out = [];
    for (let i = 0; i < v.length; i++) {
      const a = [num(v[i].attrs.x), num(v[i].attrs.y)], b = [num(v[(i + 1) % v.length].attrs.x), num(v[(i + 1) % v.length].attrs.y)], c = num(v[i].attrs.curve);
      const seg = c ? G().arcByAngle(a, b, c) : [a, b];
      out.push(...seg.slice(0, -1));
    }
    F().spend(out.length);
    return out.map(mapping);
  }
  function libraries(drawingEl) {
    const libs = new Map();
    for (const lib of kids(path(drawingEl, "libraries"), "library")) {
      const key = lib.attrs.name + "\u001f" + (lib.attrs.urn || "");
      const entry = {packages: new Map(), symbols: new Map(), devicesets: new Map()};
      for (const p of kids(kid(lib, "packages"), "package")) entry.packages.set(p.attrs.name, p);
      for (const s of kids(kid(lib, "symbols"), "symbol")) entry.symbols.set(s.attrs.name, s);
      for (const d of kids(kid(lib, "devicesets"), "deviceset")) entry.devicesets.set(d.attrs.name, d);
      libs.set(key, entry);
      if (!libs.has(lib.attrs.name + "\u001f")) libs.set(lib.attrs.name + "\u001f", entry);
    }
    return (name, urn) => libs.get(name + "\u001f" + (urn || "")) || libs.get(name + "\u001f");
  }

  // Normally closed solder jumpers (SparkFun JUMPER-*_NC_TRACE, Adafruit SOLDERJUMPER_CLOSED…):
  // package copper on a copper layer (a trace, rectangle, polygon or bridge pad) that joins two
  // or more of the pads in `real`. Returns the joined pad groups (they import as net ties) and
  // the bridge pads that join them. Only jumper-like packages count, so a connector or sensor
  // whose pads share copper on purpose is not a tie.
  const JUMPER = /JUMP|SOLDER.?J|^SJ|BRIDGE|NET.?TIE|CLOSED|[_-]NC\b|NC_TRACE/i;
  // `pins` (schematic): pad lists of one pin each; a tie must join pads of two or more pins.
  function copperTies(pkg, real, names = [], pins = null) {
    const out = Object.assign([], {bridgePads: new Set()});
    if (!pkg || ![pkg.attrs.name, ...names].some(n => JUMPER.test(n || ""))) return out;
    const copper = e => e.attrs.layer === "1" || e.attrs.layer === "16", pads = [], bridges = [], box = pts => {
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };
    for (const e of pkg.children) {
      const a = e.attrs;
      if (e.name === "smd" && copper(e) || e.name === "pad") {
        const turned = Math.round(rotOf(a.rot).angle / 90) % 2 !== 0, w = e.name === "pad" ? num(a.diameter, num(a.drill, .8) * 1.6) : num(turned ? a.dy : a.dx), h = e.name === "pad" ? w : num(turned ? a.dx : a.dy);
        const b = [num(a.x) - w / 2, num(a.y) - h / 2, num(a.x) + w / 2, num(a.y) + h / 2];
        if (real.has(a.name)) pads.push({name: a.name, b}); else bridges.push(Object.assign(b, {pad: a.name}));
      } else if (copper(e) && e.name === "rectangle") bridges.push(box([[num(a.x1), num(a.y1)], [num(a.x2), num(a.y2)]]));
      else if (copper(e) && e.name === "wire") {
        const coords = wireCoordinates(a);
        if (!coords) continue;
        const [x1, y1, x2, y2] = coords, r = num(a.width) / 2, b = box([[x1, y1], [x2, y2]]);
        bridges.push([b[0] - r, b[1] - r, b[2] + r, b[3] + r]);
      }
      else if (copper(e) && e.name === "polygon") { const v = kids(e, "vertex").map(q => [num(q.attrs.x), num(q.attrs.y)]); if (v.length > 2) { const r = num(a.width) / 2, b = box(v); bridges.push([b[0] - r, b[1] - r, b[2] + r, b[3] + r]); } }
    }
    const meet = (a, b) => a[0] <= b[2] + 1e-3 && b[0] <= a[2] + 1e-3 && a[1] <= b[3] + 1e-3 && b[1] <= a[3] + 1e-3;
    // Pads and bridges are nodes; a bridge joins what it overlaps (a trace may be two touching halves).
    const boxes = [...pads.map(p => p.b), ...bridges], up = boxes.map((_, n) => n), root = n => { while (up[n] !== n) n = up[n] = up[up[n]]; return n; };
    for (let x = 0; x < boxes.length; x++) for (let y = Math.max(x + 1, pads.length); y < boxes.length; y++) if (meet(boxes[x], boxes[y])) up[root(y)] = root(x);
    bridges.forEach((b, n) => { if (b.pad && pads.filter((_, k) => root(k) === root(pads.length + n)).length > 1) out.bridgePads.add(b.pad); });
    const groups = new Map(), pinOf = n => pins ? pins.findIndex(l => l.includes(n)) : n;
    pads.forEach((p, n) => { const r = root(n); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(p.name); });
    out.push(...[...groups.values()].filter(g => new Set(g.map(pinOf)).size > 1));
    return out;
  }

  // ------------------------------------------------------------ schematics
  const DIRECTION = {in: 0, io: 1, out: 2, oc: 3, pas: 4, hiz: 5, nc: 4, pwr: 7, sup: 7};
  const PIN_LENGTH = {point: 0, short: 2.54, middle: 5.08, long: 7.62};
  const SHEET_LAYERS = new Set([91, 92, 94, 95, 96, 97, 98]);
  const pinLabel = s => String(s || "").replace(/@\d+$/, "");
  function symbolGeometry(sym, mirror, pinNumber, notes, morePads = () => [], evidence) {
    const mx = mirror ? -1 : 1, map = p => [r4(mx * p[0]), r4(-p[1])], shapes = [], pins = [], fields = {};
    for (const e of sym.children) {
      const a = e.attrs, width = num(a.width, .254), shapeStart = shapes.length, pinStart = pins.length;
      if (e.name === "wire") F().guard(notes, () =>
        shapes.push({kind: "path", style: "body", points: wirePoints(a, map), closed: false, fill: false, width}));
      else if (e.name === "rectangle") {
        const x1 = num(a.x1), y1 = num(a.y1), x2 = num(a.x2), y2 = num(a.y2);
        shapes.push({kind: "path", style: "body", points: [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]].map(map), closed: true, fill: true, width: 0});
      } else if (e.name === "circle") shapes.push({kind: "circle", style: "body", x: map([num(a.x), num(a.y)])[0], y: map([num(a.x), num(a.y)])[1], ...circleSize(a, .254)});
      else if (e.name === "polygon") { const p = polygonPoints(e, map); if (p.length >= 3) shapes.push({kind: "path", style: "body", points: [...p, p[0]], closed: true, fill: true, width}); }
      else if (e.name === "text") {
        const t = e.text.trim(), p = map([num(a.x), num(a.y)]);
        if (/^>NAME$/i.test(t)) fields.ref = p;
        else if (/^>VALUE$/i.test(t)) fields.value = p;
        else if (t && !t.startsWith(">")) shapes.push({kind: "text", x: p[0], y: p[1], text: t, size: num(a.size, 1.778), style: "body"});
      } else if (e.name === "pin") {
        const c = [num(a.x), num(a.y)], r = rotOf(a.rot).angle * Math.PI / 180, len = Object.hasOwn(PIN_LENGTH, a.length || "long") ? PIN_LENGTH[a.length || "long"] : 7.62;
        const body = [c[0] + len * Math.cos(r), c[1] + len * Math.sin(r)], hot = map(c), inner = map(body);
        const number = pinNumber(a.name), name = pinLabel(a.name), vis = a.visible || "both";
        pins.push({x: hot[0], y: hot[1], number, name, hidden: false, electrical: Object.hasOwn(DIRECTION, a.direction || "io") ? DIRECTION[a.direction || "io"] : 1});
        // A pin that connects several pads (connect pad="10 33") gets a stacked pin per extra pad.
        for (const pad of morePads(a.name)) pins.push({...pins.at(-1), number: pad});
        if (len > 0) shapes.push({kind: "path", style: "body", points: [hot, inner], closed: false, fill: false, width: .1524});
        const dx = Math.sign(r4(inner[0] - hot[0]));
        if ((vis === "both" || vis === "pin") && name && dx) {
          const size = 1.778 * .8, w = name.length * size * .6;
          shapes.push({kind: "text", x: r4(dx > 0 ? inner[0] + .6 : inner[0] - .6 - w), y: r4(inner[1] + size * .35), text: name, size, style: "body"});
        }
      } else if (e.name === "frame") {
        const x1 = num(a.x1), y1 = num(a.y1), x2 = num(a.x2), y2 = num(a.y2);
        shapes.push({kind: "path", style: "body", points: [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]].map(map), closed: true, fill: false, width: .254});
      }
      if (evidence) {
        const target = pins[pinStart] || shapes[shapeStart];
        if (target) evidence.use(e, target, graphicApprox(e));
        else if (e.name === "text" && /^>(NAME|VALUE)$/i.test(e.text.trim())) evidence.use(e);
        if (e.name === "polygon" && target) for (const v of kids(e, "vertex")) evidence.use(v, target, num(v.attrs.curve) ? "Curve sampled into polygon vertices." : undefined);
      }
    }
    if (!pins.length && !shapes.length) notes.add("Empty symbols omitted");
    return {shapes, pins, fields};
  }
  function readSchematic(name, root, evidence) {
    const notes = F().notebook(), defs = F().definitions(), drawing = path(root, "eagle", "drawing"), sch = kid(drawing, "schematic");
    if (!sch) throw Error("This Eagle file contains no schematic.");
    const lib = libraries(sch), parts = new Map();
    for (const p of kids(kid(sch, "parts"), "part")) parts.set(p.attrs.name, p);
    const sheets = kids(kid(sch, "sheets"), "sheet"), documents = [], base = F().stem(name);
    // Supply parts take the name of the net they sit on.
    const supplyNet = new Map();
    for (const s of sheets) for (const net of kids(kid(s, "nets"), "net")) for (const seg of kids(net, "segment"))
      for (const pr of kids(seg, "pinref")) supplyNet.set(pr.attrs.part + "\u001f" + pr.attrs.gate + "\u001f" + pr.attrs.pin, net.attrs.name);
    const gateDefs = new Map();
    sheets.forEach((sheet, index) => {
      const doc = A.sheet("schematic", sheets.length > 1 ? base + " " + (index + 1) : base);
      doc.sourceName = name; doc.grid = 2.54;
      evidence?.use(sheet, doc);
      const pinAt = new Map(), supplied = new Set();
      for (const inst of kids(kid(sheet, "instances"), "instance")) F().guard(notes, () => {
        const a = inst.attrs, sourcePart = parts.get(a.part), part = sourcePart?.attrs;
        if (!part) { evidence?.drop(inst, "The instance refers to a missing part."); notes.add("Instances of unknown parts omitted"); return; }
        const library = lib(part.library, part.library_urn), set = library?.devicesets.get(part.deviceset);
        const gate = kids(kid(set, "gates"), "gate").find(g => g.attrs.name === a.gate), sym = library?.symbols.get(gate?.attrs.symbol);
        if (!sym) { evidence?.drop(inst, "The referenced library symbol is missing."); notes.add("Instances whose library symbol is missing omitted"); return; }
        const device = kids(kid(set, "devices"), "device").find(d => (d.attrs.name || "") === (part.device || ""));
        const padLists = new Map(kids(kid(device, "connects"), "connect").map(c => [c.attrs.gate + "\u001f" + c.attrs.pin, String(c.attrs.pad || "").trim().split(/\s+/).filter(Boolean)]));
        const connects = new Map([...padLists].map(([k, v]) => [k, v[0] || ""]));
        // Eagle turns an instance by θ and then mirrors it (MR90 = rotate 90°, then mirror X).
        // Waffle mirrors local X and then rotates, so a mirrored instance turns the other way.
        const rot = rotOf(a.rot), x = num(a.x), y = -num(a.y), angle = r4(norm(rot.mirror ? rot.angle : -rot.angle));
        const symPins = kids(sym, "pin");
        const supply = !device?.attrs.package && symPins.length > 0 && symPins.every(p => p.attrs.direction === "sup");
        if (supply) {
          const pin = symPins[0], net = supplyNet.get(a.part + "\u001f" + a.gate + "\u001f" + pin.attrs.name) || pinLabel(pin.attrs.name);
          const local = [(rot.mirror ? -1 : 1) * num(pin.attrs.x), -num(pin.attrs.y)], at = A.world(local, {x, y, angle}).map(r4);
          const style = /gnd|vss|ground/i.test(net) ? "gnd" : /earth|chassis/i.test(net) ? "earth" : "bar";
          // A supply pin points from its connection towards the symbol body.
          const base = pin.attrs.length === "point" ? (style === "bar" ? 1 : 3) : ((Math.round(rotOf(pin.attrs.rot).angle / 90) % 4) + 4) % 4;
          // Rotate the pin direction by θ, then mirror X (right and left swap).
          const turned = ((base + Math.round(rot.angle / 90)) % 4 + 4) % 4;
          doc.items.push({id: A.id(), kind: "power", x: at[0], y: at[1], text: net, style, direction: rot.mirror ? (6 - turned) % 4 : turned});
          if (evidence) {
            evidence.produced(inst, doc, doc.items.length - 1);
            for (const record of [inst, sourcePart, sym, gate, set, device, pin]) evidence.use(record, doc.items.at(-1), "Supply symbol represented by a native power port.");
          }
          supplied.add(a.part + "\u001f" + a.gate);
          return;
        }
        // One definition per device: each gate's symbol becomes gate n (part n), drawn
        // in the gate's own frame; the placed instance names its gate with item.unit.
        const gateList = kids(kid(set, "gates"), "gate"), gates = gateList.length, unit = Math.max(1, gateList.findIndex(g => g.attrs.name === a.gate) + 1);
        const ref = a.part, value = part.value ?? (yesno(set.attrs.uservalue) ? "" : part.deviceset + (part.device || ""));
        const key = JSON.stringify([part.library, part.library_urn || "", part.deviceset, part.device || "", device?.attrs.package || ""]);
        let entry = gateDefs.get(key);
        if (!entry) {
          const symbol = {shapes: [], pins: []}, fields = [];
          const connectSources = evidence && new Map(kids(kid(device, "connects"), "connect").map(c => [c.attrs.gate + "\u001f" + c.attrs.pin, c]));
          gateList.forEach((g, i) => {
            const gs = library.symbols.get(g.attrs.symbol);
            if (!gs) return;
            const pinNumber = n => {
              const key = g.attrs.name + "\u001f" + n, number = connects.get(key);
              if (number && connectSources) evidence.use(connectSources.get(key));
              return number || pinLabel(n);
            };
            const geo = symbolGeometry(gs, false, pinNumber, notes, n => (padLists.get(g.attrs.name + "\u001f" + n) || []).slice(1), evidence), tag = gates > 1 ? {part: i + 1} : {};
            for (const sh of geo.shapes) symbol.shapes.push(Object.assign(sh, tag));
            for (const pin of geo.pins) symbol.pins.push(Object.assign(pin, tag));
            evidence?.use(g); evidence?.use(gs);
            fields[i + 1] = geo.fields;
          });
          if (gates > 1) symbol.parts = gates;
          const def = defs.add({id: A.id(), name: part.deviceset + (part.device || ""), category: "Eagle symbols",
            prefix: set.attrs.prefix || ref.replace(/\d+$/, "") || "U", value, symbol, footprintName: device?.attrs.package || "", parameters: {}, sourceName: name}, key);
          const ties = copperTies(library.packages.get(device?.attrs.package), new Set([...padLists.values()].flat()), [part.deviceset], [...padLists.values()]);
          if (ties.length && !symbol.netTie) { symbol.netTie = true; symbol.netTieGroups = ties.map(g => g.slice()); notes.add("Normally closed solder jumpers import as net ties"); }
          gateDefs.set(key, entry = {def, fields});
        }
        const item = {id: A.id(), kind: "part", def: entry.def.id, ref, value, link: "eagle-" + ref, pinNets: {}, x: r4(x), y: r4(y), angle};
        if (rot.mirror) item.mirror = true;
        for (const pin of symPins) pinAt.set(a.part + "\u001f" + a.gate + "\u001f" + pin.attrs.name, A.world([num(pin.attrs.x), -num(pin.attrs.y)], item).map(r4));
        if (gates > 1) item.unit = unit;
        const f = entry.fields[gates > 1 ? unit : 1] || {};
        if (f.ref) item.refAt = f.ref;
        if (f.value) item.valueAt = f.value;
        for (const at of kids(inst, "attribute")) {
          const q = A.rotate([num(at.attrs.x) - x, -num(at.attrs.y) - y], -angle), local = (rot.mirror ? [-q[0], q[1]] : q).map(r4);
          if (at.attrs.name === "NAME") { item.refAt = local; if (at.attrs.display === "off") item.showRef = false; }
          if (at.attrs.name === "VALUE") { item.valueAt = local; if (at.attrs.display === "off") item.showValue = false; }
        }
        doc.items.push(item);
        if (evidence) {
          evidence.produced(inst, doc, doc.items.length - 1);
          for (const record of [inst, sourcePart, gate, set, device]) evidence.use(record, item);
          for (const at of kids(inst, "attribute")) if (at.attrs.name === "NAME" || at.attrs.name === "VALUE") evidence.use(at, item);
        }
      });
      for (const net of kids(kid(sheet, "nets"), "net")) {
        const netName = net.attrs.name || "";
        for (const seg of kids(net, "segment")) {
          const wires = [], sourceWires = kids(seg, "wire"), first = doc.items.length;
          if (evidence) for (const pr of kids(seg, "pinref")) {
            const key = pr.attrs.part + "\u001f" + pr.attrs.gate;
            if (pinAt.has(key + "\u001f" + pr.attrs.pin) || supplied.has(key)) evidence.use(pr, null, "Pin membership is represented by named nets and native connectivity.");
          }
          for (const w of sourceWires) F().guard(notes, () => {
            const points = wirePoints(w.attrs);
            wires.push(points);
            doc.items.push({id: A.id(), kind: "wire", points, ...(netName ? {net: netName} : {})});
            evidence?.use(w, doc.items.at(-1), graphicApprox(w));
            evidence?.produced(w, doc, doc.items.length - 1);
          });
          // Pins that touch pins (no wire) still name their net: a zero-length named wire on the
          // first pin makes the name explicit, as Eagle's netlist and the board's signal have it.
          if (!sourceWires.length && netName && !kids(seg, "pinref").some(pr => supplied.has(pr.attrs.part + "\u001f" + pr.attrs.gate))) {
            const at = kids(seg, "pinref").map(pr => pinAt.get(pr.attrs.part + "\u001f" + pr.attrs.gate + "\u001f" + pr.attrs.pin)).find(Boolean);
            if (at) { doc.items.push({id: A.id(), kind: "wire", points: [at, at.slice()], net: netName}); evidence?.produced(seg, doc, doc.items.length - 1); notes.add("Nets joined pin to pin got zero-length named wires on the pins"); }
          }
          for (const j of kids(seg, "junction")) {
            doc.items.push({id: A.id(), kind: "junction", x: r4(num(j.attrs.x)), y: r4(-num(j.attrs.y))});
            evidence?.use(j, doc.items.at(-1));
            evidence?.produced(j, doc, doc.items.length - 1);
          }
          for (const l of kids(seg, "label")) {
            // A label names its segment; place it on the nearest wire.
            const p = [num(l.attrs.x), -num(l.attrs.y)];
            let best = p, d = Infinity;
            for (const w of wires) for (let k = 1; k < w.length; k++) {
              const q = project(p, w[k - 1], w[k]), dd = Math.hypot(q[0] - p[0], q[1] - p[1]);
              if (dd < d) { d = dd; best = q; }
            }
            const rot = rotOf(l.attrs.rot);
            doc.items.push({id: A.id(), kind: "netlabel", x: r4(best[0]), y: r4(best[1]), text: netName, angle: r4(norm(-rot.angle))});
            evidence?.produced(l, doc, doc.items.length - 1);
            evidence?.use(l, doc.items.at(-1), Number.isFinite(d) && d > 1e-4 ? "Label moved onto the nearest wire." : undefined);
          }
          if (doc.items.length > first) { evidence?.use(seg); evidence?.use(net); }
        }
      }
      for (const bus of kids(kid(sheet, "busses"), "bus")) for (const seg of kids(bus, "segment")) for (const w of kids(seg, "wire")) F().guard(notes, () => {
        doc.items.push({id: A.id(), kind: "bus", points: wirePoints(w.attrs)});
        evidence?.use(w, doc.items.at(-1), graphicApprox(w));
        evidence?.produced(w, doc, doc.items.length - 1);
        evidence?.use(seg); evidence?.use(bus, null, "Bus geometry imported without its Eagle member declaration.");
      });
      for (const e of kid(sheet, "plain")?.children || []) {
        const a = e.attrs, first = doc.items.length;
        if (e.name === "wire") F().guard(notes, () =>
          doc.items.push({id: A.id(), kind: "graphic", points: wirePoints(a), width: num(a.width, .1524)}));
        else if (e.name === "text" && e.text.trim()) doc.items.push({id: A.id(), kind: "label", x: r4(num(a.x)), y: r4(-num(a.y)), text: e.text.trim(), angle: r4(norm(-rotOf(a.rot).angle)), size: num(a.size, 1.778)});
        else if (e.name === "frame" || e.name === "rectangle") {
          const x1 = num(a.x1), y1 = num(a.y1), x2 = num(a.x2), y2 = num(a.y2);
          doc.items.push({id: A.id(), kind: "graphic", points: [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]].map(p => flip(...p)), width: .254, closed: true, fill: e.name === "rectangle"});
        } else if (e.name === "circle") doc.items.push({id: A.id(), kind: "graphic", points: G().circlePoints([num(a.x), -num(a.y)], num(a.radius, 1)), width: num(a.width, .254)});
        else if (e.name === "polygon") { const p = polygonPoints(e); if (p.length >= 3) doc.items.push({id: A.id(), kind: "graphic", points: [...p, p[0]], width: num(a.width, .254), closed: true, fill: true}); }
        if (evidence && doc.items[first]) {
          evidence.produced(e, doc, first);
          evidence.use(e, doc.items[first], e.name === "circle" ? "Circle sampled into a path." : graphicApprox(e));
          if (e.name === "polygon") for (const v of kids(e, "vertex")) evidence.use(v, doc.items[first]);
        }
      }
      doc.notes = notes.list();
      documents.push(doc);
    });
    if (sheets.length > 1) notes.add("Each Eagle sheet became a schematic document. Nets join across sheets by name");
    const list = notes.list();
    for (const d of documents) d.notes = list.slice();
    return {documents, library: defs.list, notes: list};
  }
  function project(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l));
    return [a[0] + t * dx, a[1] + t * dy];
  }

  // ------------------------------------------------------------ boards
  const TECH = {21: "Silk", 22: "Bottom silk", 25: "Silk", 26: "Bottom silk", 27: "Mechanical 13", 28: "Mechanical 14", 29: "Top mask", 30: "Bottom mask",
    31: "Top paste", 32: "Bottom paste", 35: "Mechanical 17", 36: "Mechanical 18", 39: "Mechanical 15", 40: "Mechanical 16",
    41: "Keepout", 42: "Keepout", 43: "Keepout", 47: "Mechanical", 48: "Mechanical", 49: "Mechanical", 51: "Mechanical 13", 52: "Mechanical 14"};
  const SWAP = {1: 16, 16: 1, 21: 22, 22: 21, 25: 26, 26: 25, 27: 28, 28: 27, 29: 30, 30: 29, 31: 32, 32: 31, 35: 36, 36: 35, 39: 40, 40: 39, 41: 42, 42: 41, 51: 52, 52: 51};
  const isCopper = l => l === "Top" || l === "Bottom" || /^Inner \d+$/.test(l || "");
  function readBoard(name, root, evidence) {
    const notes = F().notebook(), defs = F().definitions(), drawing = path(root, "eagle", "drawing"), brd = kid(drawing, "board");
    if (!brd) throw Error("This Eagle file contains no board.");
    const doc = A.sheet("pcb", F().stem(name));
    doc.sourceName = name;
    const lib = libraries(brd), edges = [], outlineRecords = evidence && [];
    evidence?.use(brd, doc);
    // Design rules: clearances, widths, drills and annular rings.
    const dr = F().dict(), ruleSources = evidence && new Map();
    for (const p of kids(kid(brd, "designrules"), "param")) {
      dr[p.attrs.name] = p.attrs.value;
      ruleSources?.set(p.attrs.name, p);
    }
    const rule = (k, d) => { const v = length(dr[k]); return Number.isFinite(v) ? v : d; };
    const ratio = (k, d) => { const v = parseFloat(dr[k]); return Number.isFinite(v) ? v : d; };
    const ring = (drill, k) => {
      if (ruleSources) for (const prefix of ["rv", "rlMin", "rlMax"]) {
        const key = prefix + k;
        if (Number.isFinite(prefix === "rv" ? ratio(key, NaN) : rule(key, NaN))) evidence.use(ruleSources.get(key), null, "Applied to a pad or via diameter; the rule itself was not retained.");
      }
      return Math.min(rule("rlMax" + k, .508), Math.max(rule("rlMin" + k, .254), drill * ratio("rv" + k, .25)));
    };
    // Inner copper layers keep their stack order.
    const used = new Set();
    const note = l => { if (l >= 2 && l <= 15) used.add(l); };
    for (const e of [...kids(kid(brd, "plain"), "wire"), ...kids(kid(brd, "signals"), "signal").flatMap(s => [...kids(s, "wire"), ...kids(s, "polygon")])]) note(+e.attrs.layer);
    for (const v of kids(kid(brd, "signals"), "signal").flatMap(s => kids(s, "via"))) for (const l of String(v.attrs.extent || "1-16").split("-")) note(+l);
    const inner = [...used].sort((a, b) => a - b);
    const layerOf = n => n === 1 ? "Top" : n === 16 ? "Bottom" : n >= 2 && n <= 15 ? "Inner " + (inner.indexOf(n) + 1) : Object.hasOwn(TECH, n) ? TECH[n] : null;
    // Pads that carry a signal, per element (a closed jumper's bridge pad carries none).
    const contacts = new Map();
    for (const s of kids(kid(brd, "signals"), "signal")) for (const c of kids(s, "contactref")) {
      if (!contacts.has(c.attrs.element)) contacts.set(c.attrs.element, new Set());
      contacts.get(c.attrs.element).add(c.attrs.pad);
    }
    // Footprints.
    for (const el of kids(kid(brd, "elements"), "element")) F().guard(notes, () => {
      const a = el.attrs, library = lib(a.library, a.library_urn), pkg = library?.packages.get(a.package);
      if (!pkg) { evidence?.drop(el, "The placed footprint refers to a missing package."); notes.add("Elements whose package is missing omitted"); return; }
      // Eagle rotates an element by θ, then mirrors it to the bottom (see the schematic note).
      const rot = rotOf(a.rot), mx = rot.mirror ? -1 : 1, angle = r4(norm(rot.mirror ? rot.angle : -rot.angle)), x = r4(num(a.x)), y = r4(-num(a.y));
      const map = p => [r4(mx * p[0]), r4(-p[1])], L = n => layerOf(rot.mirror && Object.hasOwn(SWAP, n) ? SWAP[n] : n);
      const ref = String(a.name || "U?");
      const item = {id: A.id(), kind: "part", def: "", ref, value: a.value || "", x, y, angle, layer: rot.mirror ? "Bottom" : "Top", link: "eagle-" + ref, pinNets: {}};
      const pads = [], shapes = [];
      const padAngle = r => r4(norm(rot.mirror ? r : -r));
      for (const e of pkg.children) {
        const p = e.attrs, padStart = pads.length, shapeStart = shapes.length;
        if (e.name === "smd") {
          const c = map([num(p.x), num(p.y)]), round = num(p.roundness), w = num(p.dx), h = num(p.dy);
          pads.push({number: p.name, x: c[0], y: c[1], w, h, drill: 0, layer: L(+p.layer || 1),
            shape: round >= 100 ? (Math.abs(w - h) < 1e-6 ? "round" : "oval") : round > 0 ? "roundrect" : "rect", angle: padAngle(rotOf(p.rot).angle)});
        } else if (e.name === "pad") {
          const c = map([num(p.x), num(p.y)]), drill = num(p.drill, .8);
          let d = num(p.diameter, 0);
          if (!(d > drill)) d = r4(drill + 2 * ring(drill, "PadTop"));
          const shape = p.shape || "round", long = shape === "long" || shape === "offset";
          pads.push({number: p.name, x: c[0], y: c[1], w: long ? d * 2 : d, h: d, drill, layer: "Multi",
            shape: shape === "square" ? "rect" : shape === "octagon" ? "octagon" : long ? "oval" : "round", angle: padAngle(rotOf(p.rot).angle)});
          if (shape === "offset") notes.add("Offset pads import as centred oblong pads");
        } else if (e.name === "hole") {
          const c = map([num(p.x), num(p.y)]), drill = num(p.drill, 1);
          pads.push({number: "", x: c[0], y: c[1], w: drill, h: drill, drill, layer: "Multi", shape: "round", plated: false, angle: 0});
        } else if (e.name === "wire" || e.name === "circle" || e.name === "rectangle" || e.name === "polygon") {
          const ln = +p.layer, l = L(ln), world = pt => A.world(pt, item);
          if (ln === 20 || ln === 46) {
            if (e.name === "wire") {
              const edge = F().guard(notes, () => edgeOf(p, q => world(map(q))));
              if (!edge) continue;
              edges.push(edge);
            }
            else if (e.name === "circle") edges.push({kind: "circle", c: world(map([num(p.x), num(p.y)])), r: num(p.radius)});
            if (e.name === "wire" || e.name === "circle") outlineRecords?.push(e);
            continue;
          }
          if (!l) { notes.add("Package graphics on unsupported Eagle layer " + ln + " omitted"); continue; }
          const style = /^Mechanical 1[34]$/.test(l) ? "package" : l === "Silk" || l === "Bottom silk" ? "silk" : "body", layer = style === "package" ? {} : {layer: l};
          if (e.name === "wire") F().guard(notes, () =>
            shapes.push({kind: "path", points: wirePoints(p, map), style, width: num(p.width, .127), ...layer, closed: false, fill: false}));
          else if (e.name === "circle") { const c = map([num(p.x), num(p.y)]); shapes.push({kind: "circle", x: c[0], y: c[1], ...circleSize(p, .127), style, ...layer}); }
          else if (e.name === "rectangle") {
            const x1 = num(p.x1), y1 = num(p.y1), x2 = num(p.x2), y2 = num(p.y2);
            shapes.push({kind: "path", points: [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]].map(map), style, width: 0, ...layer, closed: true, fill: true});
          } else { const q = polygonPoints(e, map); if (q.length >= 3) shapes.push({kind: "path", points: [...q, q[0]], style, width: num(p.width, .127), ...layer, closed: true, fill: true}); }
        } else if (e.name === "text") {
          const t = e.text.trim(), c = map([num(p.x), num(p.y)]);
          if (/^>NAME$/i.test(t)) item.refAt = c;
          else if (/^>VALUE$/i.test(t)) item.valueAt = c;
          else if (t && L(+p.layer)) shapes.push({kind: "text", x: c[0], y: c[1], text: t, size: num(p.size, 1.27), angle: padAngle(rotOf(p.rot).angle), layer: L(+p.layer), style: "silk"});
        }
        if (evidence) {
          const target = pads[padStart] || shapes[shapeStart];
          if (target) {
            const reason = p.shape === "offset" ? "Offset pad centred on its drill." : e.name === "smd" && num(p.roundness) > 0 && num(p.roundness) < 100 ? "Roundness mapped to a native rounded rectangle." : graphicApprox(e);
            evidence.use(e, target, reason);
            if (e.name === "polygon") for (const v of kids(e, "vertex")) evidence.use(v, target);
          } else if (e.name === "text" && /^>(NAME|VALUE)$/i.test(e.text.trim())) evidence.use(e, item);
        }
      }
      for (const at of kids(el, "attribute")) if (at.attrs.name === "NAME" && at.attrs.x != null) {
        item.refAt = A.rotate([num(at.attrs.x) - x, -num(at.attrs.y) - y], -angle).map(r4);
        if (at.attrs.display === "off") item.showRef = false;
        evidence?.use(at, item);
      }
      // A closed jumper's bridge pad (no signal) is tie copper, not a pad.
      const ties = copperTies(pkg, contacts.get(a.name) || new Set());
      for (const n of ties.bridgePads) {
        const k = pads.findIndex(q => q.number === n && !q.drill);
        if (k < 0) continue;
        const q = pads.splice(k, 1)[0], c = [[-q.w / 2, -q.h / 2], [q.w / 2, -q.h / 2], [q.w / 2, q.h / 2], [-q.w / 2, q.h / 2]].map(v => A.rotate(v, q.angle || 0)).map(v => [r4(v[0] + q.x), r4(v[1] + q.y)]);
        shapes.push({kind: "path", points: [...c, c[0]], style: "body", width: 0, layer: q.layer, closed: true, fill: true});
      }
      const def = defs.add({id: A.id(), name: a.package, category: "Eagle footprints", prefix: (ref.match(/^[A-Za-z]+/) || ["U"])[0], value: String(a.package || "Package"),
        footprint: {name: a.package, pads, shapes}, sourceName: name}, JSON.stringify([a.package, pads, shapes]));
      if (ties.length && !def.footprint.netTie) { def.footprint.netTie = true; def.footprint.netTieGroups = ties.map(g => g.slice()); notes.add("Normally closed solder jumpers import as net ties"); }
      item.def = def.id;
      doc.items.push(item);
      evidence?.use(el, item); evidence?.use(pkg, def);
      evidence?.produced(el, doc, doc.items.length - 1);
      if (evidence && ties.bridgePads.size) for (const child of pkg.children) if (child.name === "smd" && ties.bridgePads.has(child.attrs.name)) evidence.use(child, null, "Bridge pad replaced by native net-tie copper.");
    });
    const parts = new Map(doc.items.filter(i => i.kind === "part").map(i => [i.ref, i]));
    // Net classes: width, drill and same-class clearance.
    const classes = new Map(), classSources = evidence && new Map();
    for (const c of kids(kid(brd, "classes"), "class")) {
      const same = kids(c, "clearance").find(k => k.attrs.class === c.attrs.number);
      classSources?.set(c.attrs.number, c);
      classes.set(c.attrs.number, {trackWidth: length(c.attrs.width), viaDrill: length(c.attrs.drill), clearance: length(same?.attrs.value)});
    }
    const overrides = {};
    // Signals: copper, vias, pours and pad nets.
    for (const s of kids(kid(brd, "signals"), "signal")) {
      const net = s.attrs.name || "";
      const cls = classes.get(s.attrs.class || "0");
      if (cls && s.attrs.class && s.attrs.class !== "0") overrides[net] = cls;
      const first = doc.items.length;
      for (const c of kids(s, "contactref")) {
        const p = parts.get(c.attrs.element);
        if (p && F().put(p.pinNets, c.attrs.pad, net)) { evidence?.use(c, p); evidence?.use(s); }
      }
      for (const w of kids(s, "wire")) F().guard(notes, () => {
        const l = layerOf(+w.attrs.layer);
        if (+w.attrs.layer === 19) { evidence?.drop(w, "Unrouted airwire omitted."); return; }
        if (!isCopper(l)) { evidence?.drop(w, "Signal wire is on a non-copper layer."); notes.add("Signal wires on non-copper layers omitted"); return; }
        doc.items.push({id: A.id(), kind: "track", points: wirePoints(w.attrs), layer: l, width: num(w.attrs.width, .254), net});
        evidence?.use(w, doc.items.at(-1), graphicApprox(w));
        evidence?.produced(w, doc, doc.items.length - 1);
        if (num(w.attrs.curve)) notes.add("Curved tracks were converted to short straight segments");
      });
      for (const v of kids(s, "via")) {
        const drill = num(v.attrs.drill, .3);
        let d = num(v.attrs.diameter, 0);
        if (!(d > drill)) d = r4(drill + 2 * ring(drill, "ViaOuter"));
        const [from, to] = String(v.attrs.extent || "1-16").split("-").map(Number), via = {id: A.id(), kind: "via", x: r4(num(v.attrs.x)), y: r4(-num(v.attrs.y)), diameter: d, drill, layer: "Multi", net};
        if (!(from === 1 && to === 16) && layerOf(from) && layerOf(to)) { via.fromLayer = layerOf(from); via.toLayer = layerOf(to); }
        doc.items.push(via);
        evidence?.produced(v, doc, doc.items.length - 1);
        evidence?.use(v, via, !(from === 1 && to === 16) && !via.fromLayer ? "Unmapped via span replaced by a through via." : undefined);
      }
      for (const p of kids(s, "polygon")) {
        const l = layerOf(+p.attrs.layer), points = polygonPoints(p).map(G().P);
        if (!isCopper(l) || points.length < 3) continue;
        const iso = length(p.attrs.isolate), item = {id: A.id(), kind: "polygon", points, closed: true, layer: l, net, pourIndex: num(p.attrs.rank, 0),
          connectStyle: p.attrs.thermals === "no" ? "direct" : "relief", viaConnectStyle: "direct", pourOverSameNet: true,
          removeDeadCopper: p.attrs.orphans !== "yes", fillMode: p.attrs.pour === "hatch" ? "hatched" : "solid"};
        if (iso > 0) item.clearance = iso;
        if (item.fillMode === "hatched") { const w = num(p.attrs.width, .254), sp = length(p.attrs.spacing); item.hatchWidth = w; item.hatchPitch = Math.max(w * 1.5, sp > 0 ? sp : 1.27); item.hatchAngle = 90; }
        doc.items.push(item);
        if (evidence) {
          evidence.produced(p, doc, doc.items.length - 1);
          evidence.use(p, item, "Pour boundary imported; native fill is regenerated.");
          for (const v of kids(p, "vertex")) evidence.use(v, item, num(v.attrs.curve) ? "Curved polygon edge was sampled." : undefined);
        }
        notes.add("Signal polygons import as polygon pours. Eagle files store no fill, so Waffle pours them when the board is first opened, as Eagle's Ratsnest does");
      }
      if (doc.items.length > first) evidence?.use(s);
    }
    // Plain objects: outline, holes, text and graphics.
    for (const e of kid(brd, "plain")?.children || []) F().guard(notes, () => {
      const p = e.attrs, ln = +p.layer, l = layerOf(ln), first = doc.items.length;
      if ((ln === 20 || ln === 46) && e.name === "wire") { edges.push(edgeOf(p)); outlineRecords?.push(e); return; }
      if ((ln === 20 || ln === 46) && e.name === "circle") { edges.push({kind: "circle", c: [num(p.x), -num(p.y)], r: num(p.radius)}); outlineRecords?.push(e); return; }
      if (e.name === "hole") { const d = num(p.drill, 1); doc.items.push({id: A.id(), kind: "pad", number: "", x: r4(num(p.x)), y: r4(-num(p.y)), w: d, h: d, drill: d, shape: "round", layer: "Multi", plated: false}); evidence?.use(e, doc.items.at(-1)); evidence?.produced(e, doc, first); return; }
      if (e.name === "text") { if (l && e.text.trim()) doc.items.push({id: A.id(), kind: "label", x: r4(num(p.x)), y: r4(-num(p.y)), text: e.text.trim(), angle: r4(norm(-rotOf(p.rot).angle)), size: num(p.size, 1.27), layer: l}); if (doc.items[first]) { evidence?.use(e, doc.items[first]); evidence?.produced(e, doc, first); } return; }
      if (!l) { if (["wire", "circle", "rectangle", "polygon"].includes(e.name)) notes.add("Board graphics on unsupported Eagle layer " + ln + " omitted"); else if (e.name === "dimension") notes.add("Dimensions omitted"); return; }
      if (e.name === "wire") doc.items.push({id: A.id(), kind: isCopper(l) ? "track" : "graphic", points: wirePoints(p), layer: l, width: num(p.width, .254), ...(isCopper(l) ? {net: ""} : {})});
      else if (e.name === "circle") doc.items.push({id: A.id(), kind: "graphic", points: G().circlePoints([num(p.x), -num(p.y)], num(p.radius, 1)), layer: l, width: num(p.width, .254), closed: true});
      else if (e.name === "rectangle") {
        const x1 = num(p.x1), y1 = num(p.y1), x2 = num(p.x2), y2 = num(p.y2);
        doc.items.push({id: A.id(), kind: "graphic", points: [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]].map(q => flip(...q)), layer: l, width: 0, closed: true, fill: true});
      } else if (e.name === "polygon") {
        const q = polygonPoints(e);
        if (q.length < 3) return;
        if (isCopper(l)) doc.items.push({id: A.id(), kind: "polygon", points: q, closed: true, layer: l, net: "", pourIndex: num(p.rank, 0)});
        else doc.items.push({id: A.id(), kind: "graphic", points: [...q, q[0]], layer: l, width: num(p.width, .254), closed: true, fill: true});
      }
      if (evidence && doc.items[first]) {
        evidence.produced(e, doc, first);
        evidence.use(e, doc.items[first], e.name === "circle" ? "Circle sampled into a path." : graphicApprox(e));
        if (e.name === "polygon") for (const v of kids(e, "vertex")) evidence.use(v, doc.items[first]);
      }
    });
    const warnings = G().setOutline(doc, edges, evidence && ((index, status, reason) => {
      const record = outlineRecords[index];
      if (status === "dropped") evidence.drop(record, reason);
      else evidence.use(record, null, reason);
    }));
    for (const w of warnings) notes.add(w);
    const def = classes.get("0") || {};
    // Eagle checks a clearance per object pair (wire-wire, wire-pad, smd-via, …); Waffle has one
    // board clearance, so take the smallest so that a clean Eagle board stays clean.
    const gaps = ["mdWireWire", "mdWirePad", "mdWireVia", "mdPadPad", "mdPadVia", "mdViaVia", "mdSmdPad", "mdSmdVia", "mdSmdSmd"].map(k => rule(k, NaN)).filter(v => v > 0);
    if (new Set(gaps).size > 1) notes.add("Eagle's per-object clearances import as one board clearance, the smallest (" + r4(Math.min(...gaps)) + " mm)");
    doc.rules = F().rulesFrom({clearance: gaps.length ? Math.min(...gaps) : NaN, trackWidth: def.trackWidth > 0 ? def.trackWidth : rule("msWidth", NaN), viaDrill: def.viaDrill > 0 ? def.viaDrill : rule("msDrill", NaN)}, overrides);
    if (evidence) {
      for (const [key, p] of ruleSources) {
        if (/^md(WireWire|WirePad|WireVia|PadPad|PadVia|ViaVia|SmdPad|SmdVia|SmdSmd)$/.test(key) && rule(key, NaN) > 0) evidence.use(p, null, "Pair-specific rules contribute to one native clearance.");
        if ((key === "msWidth" && !(def.trackWidth > 0) || key === "msDrill" && !(def.viaDrill > 0)) && rule(key, NaN) > 0 && rule(key, NaN) <= 1000) evidence.use(p);
      }
      const converted = new Set(Object.keys(doc.rules.nets).map(net => overrides[net]));
      for (const [id, c] of classSources) {
        const cls = classes.get(id);
        if (id === "0" && (def.trackWidth > 0 || def.viaDrill > 0) || converted.has(cls)) {
          evidence.use(c, null, "Supported class widths, drill sizes and clearances mapped to native defaults or net overrides.");
          const clearance = kids(c, "clearance").find(v => v.attrs.class === id);
          if (id !== "0" && clearance && cls.clearance > 0) evidence.use(clearance);
        }
      }
    }
    const layers = String(dr.layerSetup || "");
    if (layers) notes.add("Eagle layer setup " + layers + " imported as " + (2 + inner.length) + " copper layers; set the stack thicknesses in Layer Stack Manager");
    // Pour the signal polygons on first inspection (AtriumPolygonPour.adopt), so they count for connectivity.
    if (doc.items.some(i => i.kind === "polygon" && i.net)) doc.pcbDrawing = {annotations: {}, ...doc.pcbDrawing, sourceFill: "pour"};
    doc.notes = notes.list();
    return {documents: [doc], library: defs.list, notes: doc.notes.slice()};
  }

  function read(name, bytes, io) {
    const evidence = io.fidelity && sourceEvidence(name, io.fidelity);
    const text = io.utf8(bytes), root = parseXML(text, evidence), eagle = kid(root, "eagle");
    if (!eagle) throw Error("This is not an Eagle XML file.");
    const drawing = kid(eagle, "drawing");
    if (kid(drawing, "board") || kid(drawing, "schematic")) {
      const result = kid(drawing, "board") ? readBoard(name, root, evidence) : readSchematic(name, root, evidence);
      evidence?.finish();
      io.fidelity?.note?.("Eagle counts source elements once across placements. XML grouping elements and individual attribute values have no separate rows.");
      return result;
    }
    if (kid(drawing, "library")) throw Error("Eagle libraries (.lbr) are not imported. Open a schematic or board.");
    throw Error("This Eagle file contains neither a schematic nor a board.");
  }
  return {read, parseXML};
})();
