"use strict";
// Parametric connectors and headers for generic parts (generic-parts.js family "connector").
//
//   AtriumConnectorGen.defaults(type)         -> a ready spec for header, socket, box, jst, terminal, cardedge
//   AtriumConnectorGen.normalise(spec)        -> checked spec (throws with a plain message)
//   AtriumConnectorGen.make(spec)             -> library def: symbol, footprint (IPC-style lands, courtyard,
//                                               silk pin-1 marker, assembly outline) and 3D height
//   AtriumConnectorGen.layout(spec)           -> [{number, row, col, x, y}] pad positions in number order
//
// Spec: {type, pitch (mm), rows, cols (pins per row), numbering, gender, orientation, mount,
// shrouded, key, pegs, split}. Numbering schemes:
//   odd-even    1-2 across the rows, then 3-4 (KiCad "odd/even", the IPC wizard's "zigzag")
//   row-by-row  1…N along row A, then N+1…2N along row B in the same direction
//   ccw         counter-clockwise like a DIP: row A down, row B back up
//   zigzag      staggered: row B is offset by half a pitch and the numbers alternate rows
// Lands follow the footprint wizard's through-hole goals (hole = lead diagonal + allowance, land =
// hole + 2 × annular ring, kept 0.25 mm apart); SMD lands scale from the common 2.54 mm SMD header
// lands. Heights and body outlines are typical of each connector style, for the 3D body and
// collision checks; check them against the drawing of the part you buy.
//
// Placed connectors are generic parts: changing a parameter regenerates the definition (a new
// deterministic id), and AtriumGenericParts.edit keeps the connections of every pin that still
// exists (by pin number), refusing (unless forced) when connected pins would disappear.
globalThis.AtriumConnectorGen = (() => {
  const GP = () => globalThis.AtriumGenericParts, L = () => globalThis.AtriumLibrary;
  const G = 2.54, r6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const fail = m => { throw Error(m); };
  const PITCHES = [1, 1.27, 2, 2.54, 3.5, 3.81, 5, 5.08];
  const TYPES = {
    header: {title: "Pin header", gender: "male", rows: [1, 3], cols: 4, pitch: 2.54},
    socket: {title: "Pin socket", gender: "female", rows: [1, 3], cols: 4, pitch: 2.54},
    box: {title: "Box header (IDC)", gender: "male", rows: [2, 2], cols: 5, pitch: 2.54, shrouded: true, key: true},
    jst: {title: "Wire-to-board (JST style)", gender: "male", rows: [1, 2], cols: 4, pitch: 2, shrouded: true, key: true},
    terminal: {title: "Terminal block", gender: "female", rows: [1, 1], cols: 2, pitch: 5.08, shrouded: true},
    cardedge: {title: "Card edge fingers", gender: "male", rows: [1, 2], cols: 10, pitch: 1.27, mount: "smd"}
  };
  const NUMBERING = [["odd-even", "Odd/even (1–2 across rows)"], ["row-by-row", "Row by row (1…N, then N+1…)"], ["ccw", "Counter-clockwise (DIP style)"], ["zigzag", "Zigzag (staggered rows)"]];
  const SHAPE_KEYS = ["type", "pitch", "rows", "cols", "numbering", "gender", "orientation", "mount", "shrouded", "key", "pegs", "split"];
  const MAX_PINS = 400;

  function defaults(type = "header") {
    const t = TYPES[type] || TYPES.header;
    return {family: "connector", type: TYPES[type] ? type : "header", pitch: t.pitch, rows: t.rows[0], cols: t.cols, numbering: "odd-even", gender: t.gender,
      orientation: "vertical", mount: t.mount || "tht", shrouded: !!t.shrouded, key: !!t.key, pegs: false, split: 0};
  }
  const bool = v => v === true || v === "true" || v === 1;
  function normalise(spec) {
    const type = spec.type ?? "header";
    const t = TYPES[type] || fail("Unknown connector type " + String(type).slice(0, 40) + ". Use one of: " + Object.keys(TYPES).join(", ") + ".");
    const d = defaults(type), s = {...d, ...Object.fromEntries(Object.entries(spec).filter(([k, v]) => SHAPE_KEYS.includes(k) && v !== undefined && v !== null))};
    s.family = "connector"; s.type = type;
    s.pitch = Number(s.pitch);
    if (!Number.isFinite(s.pitch) || s.pitch < .5 || s.pitch > 10) fail("Enter a pitch from 0.5 to 10 mm.");
    s.pitch = r6(Math.round(s.pitch * 1000) / 1000);
    s.rows = Math.round(Number(s.rows)); s.cols = Math.round(Number(s.cols));
    if (!(s.rows >= t.rows[0] && s.rows <= t.rows[1])) fail("A " + t.title.toLowerCase() + " has " + (t.rows[0] === t.rows[1] ? t.rows[0] : t.rows[0] + " to " + t.rows[1]) + " row" + (t.rows[1] > 1 ? "s" : "") + ".");
    if (!(s.cols >= 1 && s.cols <= 100)) fail("Enter 1 to 100 pins per row.");
    if (s.rows * s.cols > MAX_PINS) fail("A connector has at most " + MAX_PINS + " pins.");
    if (!NUMBERING.some(([k]) => k === s.numbering)) fail("Numbering is one of " + NUMBERING.map(n => n[0]).join(", ") + ".");
    if (s.rows === 1 && s.numbering !== "zigzag") s.numbering = "odd-even";
    if (s.numbering === "zigzag" && s.rows !== 2 && s.rows !== 1) fail("Zigzag numbering needs one or two rows.");
    if (s.rows === 1 && s.numbering === "zigzag") s.rows = 2;
    s.gender = s.gender === "female" ? "female" : "male";
    s.orientation = s.orientation === "right-angle" ? "right-angle" : "vertical";
    s.mount = s.mount === "smd" ? "smd" : "tht";
    if (type === "cardedge") { s.mount = "smd"; s.orientation = "vertical"; s.gender = "male"; s.shrouded = false; s.pegs = false; }
    if (type === "terminal" && s.mount === "smd") fail("Terminal blocks are through-hole.");
    if (s.mount === "smd" && s.orientation === "right-angle" && type !== "jst") fail("Right-angle SMD is generated for JST-style connectors only. Choose through-hole or vertical.");
    if (s.mount === "smd" && s.rows > 2) fail("SMD headers have one or two rows.");
    for (const k of ["shrouded", "key", "pegs"]) s[k] = bool(s[k]);
    s.split = Math.max(0, Math.min(MAX_PINS, Math.round(Number(s.split) || 0)));
    if (s.split && s.split < 2) s.split = 2;
    if (s.split >= s.rows * s.cols) s.split = 0;
    const out = {};
    for (const k of ["family", ...SHAPE_KEYS]) out[k] = s[k];
    return out;
  }

  // ------------------------------------------------------------------ pads
  // Pad k (number order): row r (0 = A), column c. Pins run down the Y axis, rows across X.
  function layout(spec) {
    const s = spec, n = s.rows * s.cols, out = [];
    const rowGap = s.type === "cardedge" ? 0 : s.pitch;
    const xOf = r => (r - (s.rows - 1) / 2) * rowGap, yOf = c => (c - (s.cols - 1) / 2) * s.pitch;
    if (s.numbering === "zigzag") {
      for (let k = 0; k < n; k++) { const r = k % 2; out.push({number: String(k + 1), row: r, col: k, x: r6(xOf(r)), y: r6((k - (n - 1) / 2) * s.pitch / 2)}); }
      return out;
    }
    const order = [];
    if (s.numbering === "row-by-row") for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) order.push([r, c]);
    else if (s.numbering === "ccw") for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) order.push([r, r % 2 ? s.cols - 1 - c : c]);
    else for (let c = 0; c < s.cols; c++) for (let r = 0; r < s.rows; r++) order.push([r, c]);
    order.forEach(([r, c], k) => out.push({number: String(k + 1), row: r, col: c, x: r6(xOf(r)), y: r6(yOf(c))}));
    return out;
  }
  // Square post size for a pitch (round leads for terminal blocks).
  function lead(s) {
    if (s.type === "terminal") return s.pitch >= 5 ? 1.2 : 1;
    if (s.pitch >= 2.54) return .64;
    if (s.pitch >= 2) return .5;
    if (s.pitch >= 1.27) return .4;
    return r6(Math.max(.2, s.pitch * .3));
  }
  function height(s) {
    if (s.type === "cardedge") return 0;
    if (s.type === "terminal") return s.pitch >= 5 ? 10 : 8.5;
    if (s.type === "box") return 9;
    if (s.type === "jst") return s.orientation === "right-angle" ? r6(Math.max(3, s.pitch * 2.5)) : r6(Math.max(4, s.pitch * 3));
    if (s.orientation === "right-angle") return r6(Math.max(1, s.pitch * s.rows));
    return r6(Math.max(2.5, 8.5 * s.pitch / 2.54));
  }
  function footprint(s) {
    const W = GP(), pads = [], shapes = [], pts = layout(s), p = s.pitch;
    const ext = {x0: Math.min(...pts.map(q => q.x)), x1: Math.max(...pts.map(q => q.x)), y0: Math.min(...pts.map(q => q.y)), y1: Math.max(...pts.map(q => q.y))};
    let body, land = 0, hole = 0;
    if (s.type === "cardedge") {
      // Gold fingers: odd pins on top, even on the bottom (two rows), the board edge below the fingers.
      const w = r6(p * .6), h = 4;
      for (const q of pts) pads.push({...W.smd(q.number, q.y, 0, w, h, "rect"), ...(s.rows === 2 && q.row === 1 ? {layer: "Bottom"} : {})});
      for (const pad of pads) pad.x = r6(pad.x);
      shapes.push({kind: "path", layer: "Mechanical 1", width: .1, points: [[r6(ext.y0 - p), r6(h / 2)], [r6(ext.y1 + p), r6(h / 2)]], style: "edge"});
      const fp = {name: "", pads, shapes};
      W.dress(fp, null, {courtyard: .25});
      fp.shapes.push(W.silk([[r6(ext.y0 - w / 2 - .4), r6(-h / 2 - .3)], [r6(ext.y0 - w / 2 - .4), r6(-h / 2 + .7)]]));
      return {fp, land: w, hole: 0};
    }
    if (s.mount === "tht") {
      const t = W.thtLand(lead(s) * (s.type === "terminal" ? 1 : Math.SQRT2), Math.min(p, s.numbering === "zigzag" ? p / 2 * Math.SQRT2 * 1.2 : p));
      land = t.land; hole = t.hole;
      if (s.type === "terminal") { hole = Math.max(hole, 1.3); land = Math.max(land, Math.min(r6(hole + 1), r6(p - .4))); }
      for (const q of pts) pads.push(W.tht(q.number, q.x, q.y, land, hole, q.number === "1" ? "rect" : "round"));
    } else {
      // SMD: lands run outward from each row (two rows) or alternate sides (one row), pin 1 on the left.
      const k = p / 2.54, len = r6(Math.max(1, 3.15 * k)), w = r6(Math.max(.3, Math.min(p * .55, 1 * k + .02)));
      const vertical1 = s.rows === 1 || (s.rows === 2 && s.numbering === "zigzag");
      for (const q of pts) {
        let x;
        if (s.orientation === "right-angle") x = 0;
        else if (vertical1) x = (Number(q.number) % 2 ? -1 : 1) * r6(len / 2 + .3 * k);
        else x = (q.row === 0 ? -1 : 1) * r6(p / 2 + len / 2 - .3 * k);
        pads.push({...W.smd(q.number, x, q.y, len, w, "rect")});
      }
      land = w;
      ext.x0 = Math.min(...pads.map(q => q.x - q.w / 2)); ext.x1 = Math.max(...pads.map(q => q.x + q.w / 2));
    }
    // Housing outline (Mechanical 13; the 3D body) by connector style.
    const half = p / 2, margin = s.type === "box" ? 3.8 : s.type === "jst" ? Math.max(1.5, p * .95) : s.type === "terminal" ? .5 : 0;
    const across = s.type === "box" ? 2.9 : s.type === "jst" ? Math.max(1.4, p * 1.1) : s.type === "terminal" ? Math.max(3.2, p * .8) : half;
    if (s.orientation === "right-angle" && s.mount === "tht") {
      const start = ext.x1 + 1.5, depth = s.type === "jst" ? Math.max(4, p * 2.4) : Math.max(2.54, p);
      body = [r6(start), r6(ext.y0 - half - margin), r6(start + depth), r6(ext.y1 + half + margin)];
    } else if (s.orientation === "right-angle") {
      body = [0, 0, 0, 0];
    } else if (s.mount === "smd") {
      // Vertical SMD: the housing spans the rows (plus the shroud); the lands reach out beyond it.
      const hw = r6((s.rows === 2 && s.numbering !== "zigzag" ? p : p * .5) + (s.shrouded ? .6 : 0) + .02);
      body = [-hw, r6(ext.y0 - half - margin), hw, r6(ext.y1 + half + margin)];
    } else body = [r6(ext.x0 - across), r6(ext.y0 - half - margin), r6(ext.x1 + across), r6(ext.y1 + half + margin)];
    if (s.mount === "smd" && s.orientation === "right-angle") {
      // Right-angle SMD (JST SH/GH style): one row of lands in front, along X; the housing behind.
      pts.forEach((q, i) => { pads[i].x = r6(q.y); pads[i].y = r6(-p * 1.5); pads[i].w = r6(Math.max(.3, Math.min(p * .6, .8))); pads[i].h = r6(Math.max(1.2, p * 1.2)); });
      const hw = r6((ext.y1 - ext.y0) / 2 + Math.max(1.5, p * 1.5));
      body = [-hw, r6(-p * .9), hw, r6(p * 1.6)];
    }
    // Mounting pegs (or SMD retention tabs on SMD parts) beyond both ends.
    if (s.pegs) {
      if (s.mount === "smd") {
        const along = s.orientation === "right-angle";
        const off = along ? r6((body[2] - body[0]) / 2 - .5) : r6((body[3] - body[1]) / 2 + .6);
        for (const sg of [-1, 1]) pads.push(along ? W.smd("MP", sg * r6(off + .7), r6(p * .8), 1.2, 1.8, "rect") : W.smd("MP", 0, sg * r6(off + .9), 2, 1.4, "rect"));
      } else {
        const off = r6((body[3] - body[1]) / 2 + 1.2), d = s.pitch >= 2 ? 1.6 : 1.1;
        const cx = r6((body[0] + body[2]) / 2);
        for (const sg of [-1, 1]) pads.push({number: "", x: cx, y: r6(sg * off + (body[1] + body[3]) / 2), w: d, h: d, drill: d, shape: "round", angle: 0, layer: "Multi", plated: false});
      }
    }
    const fp = {name: "", pads, shapes};
    if (s.type === "box" || s.shrouded) {
      shapes.push(...W.silkAround(body, pads));
      if (s.key && !(s.mount === "smd" && s.orientation === "right-angle")) {
        // The polarisation key: a notch in the shroud on the row-A side, centred.
        const mid = (body[1] + body[3]) / 2, kw = Math.min(4.5, (body[3] - body[1]) * .3), x = body[0] - .06;
        shapes.push(W.silk([[r6(x), r6(mid - kw / 2)], [r6(x + .9), r6(mid - kw / 2)], [r6(x + .9), r6(mid + kw / 2)], [r6(x), r6(mid + kw / 2)]]));
        shapes.push({kind: "path", layer: "Mechanical 13", width: .1, points: [[r6(body[0]), r6(mid - kw / 2)], [r6(body[0] + .9), r6(mid - kw / 2)], [r6(body[0] + .9), r6(mid + kw / 2)], [r6(body[0]), r6(mid + kw / 2)]]});
      }
    } else shapes.push(...W.silkAround(body, pads.filter(q => q.number !== "")));
    // Pin-1 marker: a silk triangle outside the body, beside pin 1.
    const p1 = pads.find(q => q.number === "1"), mx = r6(Math.min(body[0], p1.x - p1.w / 2) - 1.05);
    shapes.push({kind: "path", style: "silk", width: W.SILK_W || .18, closed: true, points: [[mx, r6(p1.y - .4)], [r6(mx + .55), r6(p1.y)], [mx, r6(p1.y + .4)]]});
    W.dress(fp, body, {courtyard: s.type === "terminal" ? .5 : .25});
    return {fp, land, hole};
  }
  function ipcName(s, f) {
    const c = v => String(Math.round(v * 100));
    const kind = {header: s.gender === "female" ? "SKT" : "HDR", socket: "SKT", box: "BOX", jst: "WTB", terminal: "TB", cardedge: "EDGE"}[s.type];
    return kind + (s.orientation === "right-angle" ? "RA" : "V") + (s.mount === "smd" ? "S" : "") + s.rows * s.cols + "P" + c(s.pitch) + "_" + s.rows + "X" + s.cols +
      (s.numbering !== "odd-even" ? "_" + {"row-by-row": "RB", ccw: "CCW", zigzag: "ZZ"}[s.numbering] : "") + (s.shrouded && s.type !== "box" ? "_SH" : "") + (s.key ? "_K" : "") + (s.pegs ? "_MP" : "") +
      (f.height > .1 ? "_H" + c(f.height) : "") + "N";
  }

  // ------------------------------------------------------------------ symbol
  // Odd/even and zigzag: odd pins left, even right. Row by row and ccw: row A left, row B right (ccw
  // lists row B bottom-up, as a DIP is drawn). One row: all pins on the left. Large connectors split
  // into parts of `split` pins, whole pin pairs kept together.
  function symbol(s) {
    const Lib = L() || fail("Connectors need the library module (library-panel.js).");
    const pts = layout(s), total = pts.length;
    const sideOf = q => s.rows === 1 ? "left" : s.numbering === "odd-even" || s.numbering === "zigzag" ? (Number(q.number) % 2 ? "left" : "right") : q.row % 2 ? "right" : "left";
    const groups = [];
    const per = s.split > 0 && s.split < total ? s.split : total, step = s.rows === 1 ? 1 : 2;
    const chunk = Math.max(step, per - per % step);
    for (let i = 0; i < total; i += chunk) groups.push(pts.slice(i, i + chunk));
    const multi = groups.length > 1, pins = [], shapes = [];
    groups.forEach((list, k) => {
      let rows = list.map(q => ({number: q.number, name: q.number, electrical: 4, side: sideOf(q)}));
      if (s.numbering === "ccw" && s.rows === 2) {
        const left = rows.filter(r => r.side === "left"), right = rows.filter(r => r.side === "right").reverse();
        rows = [...left, ...right];
      }
      const m = Lib.symbolFromPins(rows, {title: multi ? "" : undefined});
      // Anchor each part at its first pin's tip, so adding or removing pins per row leaves the
      // existing pins (and their wires) where they are.
      const first = m.pins.find(q => q.number === list[0].number) || m.pins[0], dx = -first.x, dy = -first.y;
      for (const q of m.pins) { q.x = r6(q.x + dx); q.y = r6(q.y + dy); }
      for (const sh of m.shapes) { if (sh.points) sh.points = sh.points.map(([x, y]) => [r6(x + dx), r6(y + dy)]); else if (sh.x != null) { sh.x = r6(sh.x + dx); sh.y = r6(sh.y + dy); } }
      for (const pin of m.pins) {
        pin.hideName = true;
        if (multi) pin.part = k + 1;
        pins.push(pin);
        // Contact art: a short stroke for a pin (male), a small cup for a socket (female).
        const dir = pin.orientation === "left" ? 1 : -1, base = r6(pin.x + dir * pin.length);
        const tag = multi ? {part: k + 1} : {};
        if (s.gender === "female") shapes.push({kind: "path", style: "body", points: Array.from({length: 7}, (_, i) => { const a = (-90 + i * 30) * Math.PI / 180; return [r6(base + dir * (.6 - .6 * Math.cos(a))), r6(pin.y + .6 * Math.sin(a))]; }), ...tag});
        else shapes.push({kind: "path", style: "body", width: .5, points: [[base, pin.y], [r6(base + dir * 1.1), pin.y]], ...tag});
      }
      for (const sh of m.shapes) shapes.push(multi ? {...sh, part: k + 1} : sh);
    });
    return Lib.buildSymbol({pins, shapes, parts: groups.length, alternate: false});
  }

  // ------------------------------------------------------------------ definitions
  function title(s) {
    const t = TYPES[s.type].title;
    return (s.type === "header" && s.gender === "female" ? "Pin socket" : t) + " " + s.rows + "×" + s.cols + ", " + s.pitch + " mm";
  }
  function make(spec) {
    const s = spec.family === "connector" && spec.pitch != null ? spec : normalise(spec);
    const sym = symbol(s), {fp} = footprint(s);
    // Card-edge fingers are part of the board itself: a copper-thin 3D body and no BOM line.
    fp.height = height(s) || .035;
    fp.name = ipcName(s, fp);
    fp.ipc = {name: fp.name, family: "connector", standard: s.mount === "tht" ? "IPC-7251 (approximated through-hole allowances)" : "lands scaled from 2.54 mm SMD headers"};
    const bits = [s.orientation === "right-angle" ? "right-angle" : "vertical", s.mount === "smd" ? "SMD" : "through-hole", s.shrouded && s.type !== "box" ? "shrouded" : "", s.key ? "keyed" : "", s.pegs ? "with mounting pegs" : ""].filter(Boolean);
    const def = {id: "", name: title(s), category: "Connectors", prefix: s.type === "cardedge" ? "P" : "J", value: s.rows + "×" + s.cols,
      description: "Generic " + title(s).toLowerCase() + ", " + bits.join(", ") + ", " + NUMBERING.find(n => n[0] === s.numbering)[1].toLowerCase() + ". Check the land pattern against the connector you buy.",
      package: s.rows + "×" + s.cols + " " + s.pitch + " mm", ...(s.type === "cardedge" ? {excludeFromBOM: true} : {}), symbol: sym.symbol, ...(sym.schDrawing ? {schDrawing: sym.schDrawing} : {}), footprint: fp};
    return def;
  }
  // generic-parts.js hooks.
  const impl = {
    normalise, make, shapeKeys: SHAPE_KEYS, title: def => title(def.generic), value: def => def.value,
    fields: () => [], summary: def => ({type: def.generic.type, pitch: def.generic.pitch, rows: def.generic.rows, cols: def.generic.cols, numbering: def.generic.numbering,
      gender: def.generic.gender, orientation: def.generic.orientation, mount: def.generic.mount, gates: def.symbol?.parts || 1})
  };
  if (globalThis.AtriumGenericParts) AtriumGenericParts.registerFamily("connector", impl);
  return Object.freeze({TYPES, PITCHES, NUMBERING, SHAPE_KEYS, defaults, normalise, layout, footprint, symbol, make, height, lead, impl});
})();
