"use strict";
if (!globalThis.AtriumLibraryPairing && typeof require === "function") require("./library-pairing.js");
// Project library: a DOM-free core shared by the editors, the MCP server and extensions,
// a small UI kit (dialog shell, zoomable preview stage) and the Library dock panel.
//
// Core (no DOM):
//   validateDef(def)            -> {ok, errors[], warnings[]}  (model validator + library checks)
//   checkFootprint(fp)          -> [{level, code, message, pads?, at?}]  live DRC-lite
//   pinsFromTable(text)         -> [{number, name, electrical, side?, part?, hidden?}]  CSV/TSV/paste
//   symbolFromPins(rows, opts)  -> {pins, shapes} editor model, grouped left/right/top/bottom
//   buildSymbol(model)          -> {symbol, schDrawing?}  pin lines, decorations and pin text
//   symbolForFootprint(fp)      -> {symbol, schDrawing?}  a default symbol for a footprint
//   usage(project, id), duplicate(project, def), remove(project, id)
//   replaceDef(project, def)    -> report; stores an edited def and runs updateParts
//   updateParts(project, def, {oldDef, sources}) -> {parts, rewired, retargeted, dropped}
//   search(library, query)      -> defs; "prefix:U pins>8 has:footprint pkg:SOIC value:10k"
//
// Symbol model extensions (all optional, ignored by older readers):
//   pin.electrical 0..7 (Altium order), pin.hidden, pin.length, pin.orientation
//   ("left"|"right"|"up"|"down", the way the pin points away from the body),
//   pin.inverted, pin.clock, pin.part (gate 1..n, 0 = every gate), shape.part,
//   shape.alt (true: De Morgan view only, false: normal view only), symbol.parts (gate
//   count), symbol.alternate (has a De Morgan view), shape.pinArt (derived from pins).
//   placed item.part / item.alt choose the gate and view (Atrium.gate filters them).
globalThis.AtriumLibrary = (() => {
  const A = globalThis.Atrium;
  const ELECTRICAL = ["Input", "I/O", "Output", "Open Collector", "Passive", "HiZ", "Open Emitter", "Power"];
  const r6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const GRID = 2.54;

  // ------------------------------------------------------------------ pins and names
  const POWER = /^(v(cc|dd|bat|in|bus|io|ref|aa|cca|dda|ddio|ddq|ddcore|ddio\d*|cc\d*|dd\d*|s?\+?)|[ad]?vdd\w*|[ad]?vcc\w*|\+?\d+v\d*|\d+v\d+|v\+|vpp|pvdd\w*|vm|vs\+?)$/i;
  const GROUND = /^([adpc]?gnd\w*|vss\w*|[ad]?vss|v-|vee|0v|ep|epad|pad|thermal|com)$/i;
  const INPUTS = /^(n?(rst|reset|en|enable|cs|ss|ce|oe|we|wr|rd|clk|sck|sclk|scl|xin|xtal1|osc_?in|in\w*|rx\w*|sdi|mosi|din|addr\w*|a\d+|sel\w*|mode\w*|boot\w*|trig\w*|shdn|sd|nsleep|sleep|ctrl\w*|pwm\w*|sync))$/i;
  const OUTPUTS = /^(n?(out\w*|tx\w*|sdo|miso|dout|int\w*|irq\w*|pg|pgood|rdy|ready|busy|fault|flt|alert|xout|xtal2|osc_?out|q\d*|led\w*|status))$/i;
  const NC = /^(nc|n\/c|dnc|nic|-)$/i;
  function electricalCode(text, name = "") {
    if (Number.isInteger(text) && text >= 0 && text <= 7) return text;
    const t = String(text ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
    const map = {input: 0, in: 0, i: 0, io: 1, "i/o": 1, inout: 1, bidi: 1, bidirectional: 1, b: 1, output: 2, out: 2, o: 2,
      "open collector": 3, oc: 3, "open drain": 3, od: 3, passive: 4, p: 4, pas: 4, hiz: 5, "tri state": 5, tristate: 5, "3 state": 5, z: 5,
      "open emitter": 6, oe: 6, "open source": 6, power: 7, pwr: 7, "power in": 7, "power out": 7, w: 7, supply: 7, ground: 7, gnd: 7, nc: 4, "no connect": 4};
    if (t && t in map) return map[t];
    if (/^\d$/.test(t) && +t <= 7) return +t;
    return inferElectrical(name);
  }
  function inferElectrical(name) {
    const n = String(name || "").trim().replace(/^[~!/]|[#*]$|_?n$/i, m => m === "_n" || m === "_N" ? "" : "").replace(/^~/, "");
    if (!n) return 4;
    if (POWER.test(n) || GROUND.test(n)) return 7;
    if (NC.test(n)) return 4;
    if (OUTPUTS.test(n)) return 2;
    if (INPUTS.test(n)) return 0;
    if (/^(p[a-k]\d+|gpio\w*|io\w*|d\d+|sda|swdio|usb_?d[pm+-]|d[pm+-]|dq\w*|ad\d+)$/i.test(n)) return 1;
    return 4;
  }
  const kindOf = row => {
    const n = String(row.name || "").replace(/^~/, "");
    if (row.electrical === 7 || POWER.test(n) || GROUND.test(n)) return GROUND.test(n) ? "ground" : POWER.test(n) || row.electrical === 7 ? "power" : "ground";
    if (NC.test(n)) return "nc";
    return ["input", "io", "output", "oc", "passive", "hiz", "oe", "power"][row.electrical ?? 4];
  };

  // ------------------------------------------------------------------ tables
  function parseTable(text) {
    const src = String(text ?? "").replace(/\r\n?/g, "\n");
    const lines = src.split("\n");
    const sample = lines.slice(0, 20).join("\n");
    const delim = sample.includes("\t") ? "\t" : (sample.match(/;/g) || []).length > (sample.match(/,/g) || []).length ? ";" : ",";
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
        else cell += c;
      } else if (c === '"' && !cell.trim()) { quoted = true; cell = ""; }
      else if (c === delim) { row.push(cell.trim()); cell = ""; }
      else if (c === "\n") { row.push(cell.trim()); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
    row.push(cell.trim()); rows.push(row);
    return rows.filter(r => r.some(c => c !== ""));
  }
  const HEAD = {
    number: /^(pin\s*(no\.?|number|num|#)?|no\.?|number|num|#|pad|ball|designator|pin\s*designator)$/i,
    name: /^(name|signal|pin\s*name|function|net|display\s*name)$/i,
    electrical: /^(type|electrical(\s*type)?|elec\w*|dir(ection)?|i\/o|pin\s*type)$/i,
    side: /^(side|position|edge|location|orientation)$/i,
    part: /^(part|gate|unit)$/i,
    hidden: /^(hidden|hide)$/i,
    length: /^(length|len)$/i,
    description: /^(desc\w*|comment|notes?)$/i
  };
  // Paste from a datasheet, spreadsheet or CSV. A header row is optional; without one the
  // columns are number, name, type, side. A number cell may list several pins ("5, 10, 15").
  function pinsFromTable(text) {
    const rows = parseTable(text);
    if (!rows.length) return [];
    let cols = null;
    const first = rows[0], mapped = {};
    first.forEach((c, i) => { for (const [k, re] of Object.entries(HEAD)) if (mapped[k] == null && re.test(c)) { mapped[k] = i; break; } });
    if (mapped.number != null || mapped.name != null) { cols = mapped; rows.shift(); }
    else if (rows.every(r => r.length === 1)) cols = {name: 0};
    else {
      // Name-first tables ("VDD, 1") are recognised when the second column is numeric.
      const numericSecond = rows.every(r => /^\d+$/.test(r[1] || "")) && !rows.every(r => /^\d+$/.test(r[0] || ""));
      cols = numericSecond ? {name: 0, number: 1, electrical: 2, side: 3} : {number: 0, name: 1, electrical: 2, side: 3};
    }
    const out = [];
    let auto = 1;
    for (const r of rows) {
      const get = k => cols[k] != null ? String(r[cols[k]] ?? "").trim() : "";
      const name = get("name"), numbers = cols.number != null ? get("number").split(/\s*[,;/]\s*|\s+(?=\S)/).filter(Boolean) : [String(auto)];
      if (!numbers.length && !name) continue;
      if (!numbers.length) numbers.push(String(auto));
      const typeText = get("electrical"), sideText = get("side").toLowerCase();
      const side = /^(l|left|w|west)/.test(sideText) ? "left" : /^(r|right|e|east)/.test(sideText) ? "right" : /^(t|top|n|north|up)/.test(sideText) ? "top" : /^(b|bottom|s|south|down)/.test(sideText) ? "bottom" : undefined;
      const part = cols.part != null ? (/^[A-Z]$/i.test(get("part")) ? get("part").toUpperCase().charCodeAt(0) - 64 : parseInt(get("part"), 10)) : undefined;
      for (const number of numbers) {
        const row = {number, name, electrical: electricalCode(typeText, name)};
        if (side) row.side = side;
        if (Number.isInteger(part) && part >= 0) row.part = part;
        if (/^(y|yes|true|1|x)$/i.test(get("hidden"))) row.hidden = true;
        const len = Number(get("length")); if (len > 0) row.length = len;
        out.push(row);
        auto = (parseInt(number, 10) || auto) + 1;
      }
    }
    return out;
  }
  function tableFromPins(pins, parts = 1) {
    const lines = ["Number\tName\tType\tSide\tPart\tHidden"];
    for (const p of pins) lines.push([p.number, p.name || "", ELECTRICAL[p.electrical ?? 4], sideOf(p), p.part ?? (parts > 1 ? 0 : ""), p.hidden ? "yes" : ""].join("\t"));
    return lines.join("\n");
  }
  const sideOf = p => ({left: "left", right: "right", up: "top", down: "bottom"}[p.orientation] || (p.x < 0 ? "left" : "right"));

  // ------------------------------------------------------------------ symbol generation
  const naturalKey = s => String(s).replace(/\d+/g, d => d.padStart(8, "0")).toLowerCase();
  const busKey = n => { const m = /^(.*?)(\d+)$/.exec(String(n || "")); return m && m[1] ? m[1].toUpperCase() : null; };
  const textWidth = s => String(s || "").length * 2.032 * .6;
  // Smart quick-create: power on top, ground at the bottom, inputs left, outputs right,
  // buses kept together in index order, the rest balanced. Every pin tip lies on 2.54 mm.
  function symbolFromPins(rows, opts = {}) {
    const g = opts.grid || GRID, len = opts.pinLength || 2 * GRID;
    const sides = {left: [], right: [], top: [], bottom: []}, loose = [];
    const groups = new Map();
    rows.forEach((r, i) => {
      const row = {...r, number: String(r.number), name: String(r.name ?? ""), electrical: r.electrical ?? inferElectrical(r.name), order: i};
      if (row.side && sides[row.side]) { sides[row.side].push([row]); return; }
      const k = kindOf(row);
      const target = k === "power" ? "top" : k === "ground" ? "bottom" : k === "input" ? "left" : k === "output" || k === "oc" || k === "oe" || k === "hiz" ? "right" : null;
      const key = (target || "loose") + "|" + (busKey(row.name) || "#" + (k === "nc" ? "nc" : row.name.toUpperCase() || row.number));
      if (!groups.has(key)) groups.set(key, {target, kind: k, rows: [], first: i});
      groups.get(key).rows.push(row);
    });
    for (const grp of groups.values()) {
      grp.rows.sort((a, b) => naturalKey(a.name).localeCompare(naturalKey(b.name)) || naturalKey(a.number).localeCompare(naturalKey(b.number)));
      if (grp.target) sides[grp.target].push(grp.rows); else loose.push(grp);
    }
    // Power and ground pins that share a name stay as separate pins (each needs a wire).
    const count = s => sides[s].reduce((n, grp) => n + grp.length, 0) + Math.max(0, sides[s].length - 1) * (sides[s].some(x => x.length > 1) ? 1 : 0);
    loose.sort((a, b) => (a.kind === "nc") - (b.kind === "nc") || a.first - b.first);
    for (const grp of loose) (count("left") <= count("right") ? sides.left : sides.right).push(grp.rows);
    // Too many power pins for the top edge? Overflow to the sides.
    const flat = list => list.flat();
    const slots = list => {
      const out = [];
      list.forEach((grp, i) => { if (i && (grp.length > 1 || list[i - 1].length > 1)) out.push(null); out.push(...grp); });
      return out;
    };
    let L = slots(sides.left), R = slots(sides.right), T = flat(sides.top), B = flat(sides.bottom);
    const lw = Math.max(0, ...L.filter(Boolean).map(p => textWidth(p.name))), rw = Math.max(0, ...R.filter(Boolean).map(p => textWidth(p.name)));
    const tw = Math.max(0, ...T.map(p => textWidth(p.name))), bw = Math.max(0, ...B.map(p => textWidth(p.name)));
    const rowsN = Math.max(L.length, R.length, 1);
    let width = Math.max(4 * g, lw + rw + 2 * g, (Math.max(T.length, B.length) + 1) * g);
    width = Math.ceil(width / (2 * g)) * 2 * g;
    // Top and bottom pin names run vertically inside the body: keep the side rows clear of them.
    const band = (list, w) => list.length ? Math.ceil((w + .8) / g) * g : 0;
    const topBand = band(T, tw), bottomBand = band(B, bw);
    const height = (rowsN + 1) * g + topBand + bottomBand;
    const x0 = -width / 2, x1 = width / 2, y0 = -Math.round(height / 2 / g) * g, y1 = y0 + height;
    const pins = [];
    const add = (p, x, y, orientation) => pins.push({number: p.number, name: p.name, x: r6(x), y: r6(y), electrical: p.electrical, orientation, length: p.length || len,
      ...(p.hidden ? {hidden: true} : {}), ...(p.part != null ? {part: p.part} : {})});
    const start = n => y0 + topBand + g + Math.floor((rowsN - n) / 2) * g;
    L.forEach((p, i) => p && add(p, x0 - (p.length || len), start(L.length) + i * g, "left"));
    R.forEach((p, i) => p && add(p, x1 + (p.length || len), start(R.length) + i * g, "right"));
    const across = n => -Math.floor((n - 1) / 2) * g;
    T.forEach((p, i) => add(p, across(T.length) + i * g, y0 - (p.length || len), "up"));
    B.forEach((p, i) => add(p, across(B.length) + i * g, y1 + (p.length || len), "down"));
    const shapes = [{kind: "path", style: "body", closed: true, fill: true, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(p => p.map(r6))}];
    if (opts.title) shapes.push({kind: "text", text: opts.title, x: r6(x0), y: r6(y0 - .6), size: 1.5, align: "left", style: "body"});
    return {pins, shapes, parts: 1};
  }
  const DIRS = {left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1]};
  // Infer a pin's orientation and length from its drawn line when the model lacks them.
  function pinGeometry(p, shapes) {
    if (p.orientation && DIRS[p.orientation]) return {dir: DIRS[p.orientation], length: p.length ?? 2 * GRID};
    const line = (shapes || []).find(s => s.kind === "path" && s.points?.length === 2 && A.same(s.points[0], [p.x, p.y]));
    if (line) {
      const [t, b] = line.points, dx = t[0] - b[0], dy = t[1] - b[1], l = Math.hypot(dx, dy) || 1;
      return {dir: Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dy) || 1], length: r6(l), line};
    }
    return {dir: p.x < 0 ? [-1, 0] : [1, 0], length: p.length ?? 2 * GRID};
  }
  const orientationOf = d => d[0] < 0 ? "left" : d[0] > 0 ? "right" : d[1] < 0 ? "up" : "down";
  // Editor model {pins, shapes, parts, alternate} -> stored symbol (+ schDrawing for one gate).
  function buildSymbol(model) {
    const parts = Math.max(1, model.parts | 0 || 1), multi = parts > 1 || !!model.alternate;
    const body = (model.shapes || []).filter(s => !s.pinArt).map(s => ({...s}));
    const art = [], text = [], pins = [];
    for (const p of model.pins) {
      const {dir, length} = pinGeometry(p, model.shapes);
      const tip = [r6(p.x), r6(p.y)], base = [r6(p.x - dir[0] * length), r6(p.y - dir[1] * length)];
      const tag = p.part > 0 ? {part: p.part} : {};
      // p.extra: fields a newer Waffle stored on the pin (symbolModel), kept as they are.
      const pin = {...(p.extra && typeof p.extra === "object" ? p.extra : {}), number: String(p.number), name: String(p.name ?? ""), x: tip[0], y: tip[1], electrical: p.electrical ?? 4, length: r6(length), orientation: orientationOf(dir), ...tag};
      for (const k of ["id", "nativeId", "nativeIdOwner"]) if (p[k] != null) pin[k] = p[k];
      for (const k of ["hidden", "inverted", "clock", "hideName", "hideNumber"]) if (p[k]) pin[k] = true;
      pins.push(pin);
      if (p.hidden) continue;
      const dot = p.inverted ? .5 : 0;
      art.push({kind: "path", style: "pin", points: [tip, [r6(base[0] + dir[0] * 2 * dot), r6(base[1] + dir[1] * 2 * dot)]], pinArt: true, ...tag});
      if (p.inverted) art.push({kind: "circle", style: "body", x: r6(base[0] + dir[0] * dot), y: r6(base[1] + dir[1] * dot), r: dot, pinArt: true, ...tag});
      if (p.clock) {
        const n = [-dir[1], dir[0]];
        art.push({kind: "path", style: "body", pinArt: true, ...tag, points: [[r6(base[0] + n[0] * .7), r6(base[1] + n[1] * .7)], [r6(base[0] - dir[0] * 1.1), r6(base[1] - dir[1] * 1.1)], [r6(base[0] - n[0] * .7), r6(base[1] - n[1] * .7)]]});
      }
      text.push({start: base, end: tip, direction: dir, name: p.hideName ? "" : pin.name, number: p.hideNumber ? "" : pin.number, part: p.part || 0});
    }
    const symbol = {...(model.extra && typeof model.extra === "object" ? model.extra : {}), pins, shapes: [...body, ...art]};
    if (parts > 1) symbol.parts = parts;
    if (model.alternate) symbol.alternate = true;
    if (!multi) return {symbol, schDrawing: {pins: text.map(({part, ...t}) => t)}};
    // Several gates: pin text becomes gate-tagged text shapes so each gate shows its own.
    for (const t of text) {
      const vertical = Math.abs(t.direction[1]) > .5, sign = vertical ? -Math.sign(t.direction[1]) : Math.sign(t.direction[0]);
      const tag = t.part > 0 ? {part: t.part} : {};
      if (t.name) symbol.shapes.push({kind: "text", text: t.name, x: r6(t.start[0] - t.direction[0] * .6), y: r6(t.start[1] - t.direction[1] * .6 + (vertical ? 0 : .7)), size: 2.032, align: sign > 0 ? "right" : "left", angle: vertical ? -90 : 0, pinArt: true, ...tag});
      if (t.number) symbol.shapes.push({kind: "text", text: t.number, x: r6((t.start[0] + t.end[0]) / 2 - (vertical ? .25 : 0)), y: r6((t.start[1] + t.end[1]) / 2 - (vertical ? 0 : .25)), size: 1.8, align: "center", angle: vertical ? -90 : 0, pinArt: true, ...tag});
    }
    return {symbol, schDrawing: null};
  }
  // Editor model from a stored symbol (any source: native, imported, catalogue).
  const PIN_KEYS = ["id", "nativeId", "nativeIdOwner", "number", "name", "x", "y", "electrical", "length", "orientation", "part", "hidden", "inverted", "clock", "hideName", "hideNumber", "extra"];
  function symbolModel(symbol) {
    const shapes = symbol?.shapes || [];
    const pinLines = new Set();
    const pins = (symbol?.pins || []).map(p => {
      const {dir, length, line} = pinGeometry(p, shapes);
      if (line) pinLines.add(line);
      const extra = Object.fromEntries(Object.entries(p).filter(([k]) => !PIN_KEYS.includes(k)));
      return {...p, number: String(p.number), name: p.name ?? "", electrical: p.electrical ?? 4, length, orientation: orientationOf(dir), ...(Object.keys(extra).length ? {extra} : {})};
    });
    // Fields this build doesn't know (a newer Waffle wrote them) ride along as `extra` and go back in buildSymbol.
    const extra = Object.fromEntries(Object.entries(symbol || {}).filter(([k]) => !["pins", "shapes", "parts", "alternate"].includes(k)));
    return {pins, shapes: shapes.filter(s => !s.pinArt && !pinLines.has(s)).map(s => ({...s})), parts: symbol?.parts || 1, alternate: !!symbol?.alternate, ...(Object.keys(extra).length ? {extra} : {})};
  }
  // A default symbol for a footprint made by the wizard: the standard resistor or
  // capacitor for two-terminal R/C parts, otherwise a box with one pin per pad number.
  function symbolForFootprint(fp, o = {}) {
    const numbers = [...new Set((fp.pads || []).filter(p => !p.thermalVia && String(p.number ?? "") !== "").map(p => String(p.number)))].sort((a, b) => naturalKey(a).localeCompare(naturalKey(b)));
    if (!numbers.length) return null;
    const std = {R: "std-r", C: "std-c"}[o.prefix];
    if (std && numbers.length === 2 && globalThis.AtriumParts) {
      const d = AtriumParts.catalogue.find(x => x.id === std);
      if (d) return {symbol: JSON.parse(JSON.stringify(d.symbol)), schDrawing: d.schDrawing ? JSON.parse(JSON.stringify(d.schDrawing)) : null};
    }
    if (numbers.length <= 64) return buildSymbol(symbolFromPins(numbers.map(n => ({number: n, name: numbers.length <= 3 ? "" : n, electrical: 4}))));
    // Large parts (BGAs, big connectors): gates of up to 48 pins, whole ball rows kept together.
    const groups = [];
    for (const n of numbers) { const k = /^([A-Z]+)\d+$/i.exec(n)?.[1] || ""; if (!groups.length || groups.at(-1).key !== k || !k) groups.push({key: k, list: []}); groups.at(-1).list.push(n); }
    const gates = [];
    for (const g of groups) for (let i = 0; i < g.list.length; i += 48) {
      const part = g.list.slice(i, i + 48);
      if (gates.length && gates.at(-1).length + part.length <= 48) gates.at(-1).push(...part); else gates.push(part);
    }
    const rows = gates.flatMap((list, k) => list.map(n => ({number: n, name: n, electrical: 4, part: k + 1})));
    return buildSymbol(symbolFromGates(rows, gates.length));
  }

  // ------------------------------------------------------------------ footprint DRC-lite
  const padRect = p => {
    const a = (p.angle || 0) * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const w = p.w * c + p.h * s, h = p.w * s + p.h * c;
    return [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2];
  };
  const overlap = (a, b, gap = 0) => a[0] < b[2] + gap && a[2] + gap > b[0] && a[1] < b[3] + gap && a[3] + gap > b[1];
  const isCourtyard = s => /court|crtyd/i.test(s.layer || "") || /^mechanical\s*15$/i.test(s.layer || "") || s.style === "courtyard";
  const isSilk = s => s.style === "silk" || /silk|overlay/i.test(s.layer || "");
  function segDistRect(a, b, r) {
    // Distance from segment a-b to rectangle r (0 when they touch).
    const inside = p => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];
    if (inside(a) || inside(b)) return 0;
    const corners = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
    const cross = (p, q, u, v) => { const d = (q[0] - p[0]) * (v[1] - u[1]) - (q[1] - p[1]) * (v[0] - u[0]); if (!d) return false;
      const t = ((u[0] - p[0]) * (v[1] - u[1]) - (u[1] - p[1]) * (v[0] - u[0])) / d, s = ((u[0] - p[0]) * (q[1] - p[1]) - (u[1] - p[1]) * (q[0] - p[0])) / d; return t >= 0 && t <= 1 && s >= 0 && s <= 1; };
    for (let i = 0; i < 4; i++) if (cross(a, b, corners[i], corners[(i + 1) % 4])) return 0;
    let d = Infinity;
    for (let i = 0; i < 4; i++) { d = Math.min(d, A.nearSegment(corners[i], a, b), A.nearSegment(a, corners[i], corners[(i + 1) % 4]), A.nearSegment(b, corners[i], corners[(i + 1) % 4])); }
    return d;
  }
  // A uniform grid over rectangles; query(box) yields the indices whose cells meet the box.
  function rectGrid(rects) {
    let sum = 0;
    for (const r of rects) sum += Math.max(r[2] - r[0], r[3] - r[1]);
    const cell = Math.max(.5, rects.length ? 2 * sum / rects.length : 1), cells = new Map();
    const span = (a, b) => [Math.floor(a / cell), Math.floor(b / cell)];
    rects.forEach((r, i) => {
      const [x0, x1] = span(r[0], r[2]), [y0, y1] = span(r[1], r[3]);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) { (cells.get("big") || cells.set("big", []).get("big")).push(i); return; }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = x + "," + y; (cells.get(k) || cells.set(k, []).get(k)).push(i); }
    });
    return {query(b) {
      const out = new Set(cells.get("big") || []), [x0, x1] = span(b[0], b[2]), [y0, y1] = span(b[1], b[3]);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 65536) return rects.map((_, i) => i);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (const i of cells.get(x + "," + y) || []) out.add(i);
      return out;
    }};
  }
  // Live checks while a footprint is edited. Levels: error, warning, info.
  function checkFootprint(fp, o = {}) {
    const out = [], pads = fp?.pads || [], shapes = fp?.shapes || [];
    const silkGap = o.silkClearance ?? .1;
    if (!pads.length) out.push({level: "warning", code: "no-pads", message: "The footprint has no pads."});
    // Numbering: duplicates (allowed when the pads overlap or are thermal vias of one pad), gaps.
    const byNum = new Map();
    pads.forEach((p, i) => { const k = String(p.number ?? ""); if (!byNum.has(k)) byNum.set(k, []); byNum.get(k).push(i); });
    // Unplated mechanical holes (NPTH) carry no number on purpose.
    const blank = byNum.get("")?.filter(i => !(pads[i].plated === false && pads[i].drill > 0));
    if (blank?.length) out.push({level: "warning", code: "unnumbered", message: blank.length + " pad(s) have no number.", pads: blank});
    for (const [k, list] of byNum) {
      if (!k || list.length < 2) continue;
      const solid = list.filter(i => !pads[i].thermalVia);
      const joined = solid.every((i, n) => !n || overlap(padRect(pads[i]), padRect(pads[solid[0]])));
      if (solid.length > 1 && !joined) out.push({level: "warning", code: "duplicate", message: "Pad number " + k + " is used by " + solid.length + " separate pads.", pads: solid});
    }
    const ints = [...byNum.keys()].filter(k => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
    if (ints.length > 1 && [...byNum.keys()].every(k => /^\d+$/.test(k) || !k)) {
      const missing = [];
      for (let n = ints[0]; n <= ints.at(-1) && missing.length < 20; n++) if (!byNum.has(String(n))) missing.push(n);
      if (missing.length) out.push({level: "warning", code: "gap", message: "Pad numbering skips " + missing.join(", ") + (missing.length === 20 ? "…" : "") + "."});
      if (ints[0] !== 1) out.push({level: "info", code: "start", message: "Pad numbering starts at " + ints[0] + "."});
    }
    // Pad geometry, paste and mask sanity.
    pads.forEach((p, i) => {
      const at = [p.x, p.y], label = "Pad " + (p.number ?? i + 1);
      if (!(p.w > 0 && p.h > 0)) out.push({level: "error", code: "size", message: label + " has no size.", pads: [i], at});
      if (p.drill > 0 && p.drill >= Math.min(p.w, p.h) - 1e-9 && p.plated !== false) out.push({level: "error", code: "annular", message: label + ": the hole is as large as the copper (no annular ring).", pads: [i], at});
      else if (p.drill > 0 && (Math.min(p.w, p.h) - p.drill) / 2 < .1 - 1e-9 && p.plated !== false && !p.thermalVia) out.push({level: "warning", code: "annular", message: label + ": annular ring under 0.10 mm.", pads: [i], at});
      // noPaste: fiducials, test pads and net ties shrink the paste to nothing on purpose.
      if (Number.isFinite(p.pasteExpansion) && p.pasteExpansion * 2 <= -Math.min(p.w, p.h) && !p.noPaste) out.push({level: "error", code: "paste", message: label + ": the paste expansion removes the whole opening.", pads: [i], at});
      if (p.drill > 0 && Number.isFinite(p.pasteExpansion) && p.pasteExpansion > 0) out.push({level: "warning", code: "paste", message: label + ": a through-hole pad has a paste opening.", pads: [i], at});
      if (Number.isFinite(p.maskExpansion) && p.maskExpansion > .3 && !p.fiducial) out.push({level: "warning", code: "mask", message: label + ": solder mask expansion over 0.3 mm.", pads: [i], at});
      if (Number.isFinite(p.maskExpansion) && p.maskExpansion < 0 && !p.thermalVia && p.maskExpansion * 2 <= -Math.min(p.w, p.h)) out.push({level: "warning", code: "mask", message: label + ": the mask covers the whole pad.", pads: [i], at});
    });
    // Pad pairs within reach, through a uniform grid (near O(n) for BGAs and big connectors).
    const rects = pads.map(padRect), minGap = o.minCopperGap ?? .1;
    const web = o.maskWeb ?? .1, maskDefault = o.maskExpansion ?? .05, reach = Math.max(minGap, web + 2 * Math.max(maskDefault, .05)) + 1e-6;
    const grid = rectGrid(rects);
    const shorts = [], close = [];
    let sliver = null;
    rects.forEach((ra, i) => {
      const a = pads[i];
      if (a.thermalVia) return;
      for (const j of grid.query([ra[0] - reach, ra[1] - reach, ra[2] + reach, ra[3] + reach])) {
        if (j <= i) continue;
        const b = pads[j];
        if (b.thermalVia || String(a.number) === String(b.number)) continue;
        // SMD pads on opposite copper layers (card-edge fingers) cannot short.
        if (!(a.drill > 0) && !(b.drill > 0) && (a.layer || "Top") !== (b.layer || "Top") && /^(Top|Bottom)$/.test(a.layer || "Top") && /^(Top|Bottom)$/.test(b.layer || "Top")) continue;
        const rb = rects[j], gap = Math.max(ra[0] - rb[2], rb[0] - ra[2], ra[1] - rb[3], rb[1] - ra[3]);
        if (gap <= 1e-9) shorts.push([i, j, gap]);
        else if (gap < minGap - 1e-9) close.push([i, j, gap]);
        else if (!sliver) {
          const ea = Number.isFinite(a.maskExpansion) ? a.maskExpansion : maskDefault, eb = Number.isFinite(b.maskExpansion) ? b.maskExpansion : maskDefault;
          if (gap - ea - eb < web && gap - ea - eb > -gap) sliver = [i, j];
        }
      }
    });
    const mid = (i, j) => [(pads[i].x + pads[j].x) / 2, (pads[i].y + pads[j].y) / 2];
    for (const [i, j, gap] of shorts.slice(0, 6)) out.push({level: "error", code: "short", message: "Pads " + pads[i].number + " and " + pads[j].number + (gap < -1e-9 ? " overlap." : " touch (no copper gap)."), pads: [i, j], at: mid(i, j)});
    if (shorts.length > 6) out.push({level: "error", code: "short", message: (shorts.length - 6) + " more pad pairs overlap or touch."});
    for (const [i, j, gap] of close.slice(0, 6)) out.push({level: "warning", code: "clearance", message: "Copper gap between pads " + pads[i].number + " and " + pads[j].number + " is " + (Math.round(gap * 1000) / 1000) + " mm, under " + minGap + " mm.", pads: [i, j], at: mid(i, j)});
    if (close.length > 6) out.push({level: "warning", code: "clearance", message: (close.length - 6) + " more pad pairs are closer than " + minGap + " mm."});
    if (sliver) out.push({level: "info", code: "mask-web", message: "Solder mask web between pads " + pads[sliver[0]].number + " and " + pads[sliver[1]].number + " is under " + web + " mm (gang relief).", pads: sliver});
    // Silkscreen over copper: only pads near each silk shape are measured.
    let silkHits = 0;
    for (const s of shapes) {
      if (!isSilk(s) || silkHits > 8) continue;
      const half = (s.width ?? .12) / 2, m = silkGap + half;
      const sb = s.kind === "circle" ? [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r] : s.kind === "text" ? (() => { const sz = s.size || .8, w = String(s.text || "").length * sz * .7; return [s.x - w, s.y - sz, s.x + w, s.y]; })() : A.bounds(s.points || []);
      if (!sb) continue;
      for (const i of grid.query([sb[0] - m, sb[1] - m, sb[2] + m, sb[3] + m])) {
        const p = pads[i], r = rects[i];
        let d = Infinity;
        if (s.kind === "path" && s.points?.length) {
          const pts = s.closed ? [...s.points, s.points[0]] : s.points;
          if (pts.length === 1) d = segDistRect(pts[0], pts[0], r);
          for (let k = 1; k < pts.length; k++) d = Math.min(d, segDistRect(pts[k - 1], pts[k], r));
        } else if (s.kind === "circle") d = Math.max(0, Math.hypot(Math.max(r[0] - s.x, 0, s.x - r[2]), Math.max(r[1] - s.y, 0, s.y - r[3])) - s.r);
        else if (s.kind === "text") { const sz = s.size || .8, w = String(s.text || "").length * sz * .7; d = overlap([s.x - (s.align === "center" ? w / 2 : 0), s.y - sz, s.x + w, s.y], r) ? 0 : 1; }
        if (d - half < silkGap) { silkHits++; out.push({level: "warning", code: "silk-pad", message: "Silkscreen " + (d - half <= 0 ? "over" : "within " + silkGap + " mm of") + " pad " + p.number + ".", pads: [i], at: [p.x, p.y]}); }
      }
    }
    const yard = shapes.filter(isCourtyard);
    if (!yard.length) out.push({level: "warning", code: "courtyard", message: "No courtyard (Mechanical 15). Placement checks need one."});
    else {
      const cb = A.bounds(yard.flatMap(s => s.points || (s.kind === "circle" ? [[s.x - s.r, s.y - s.r], [s.x + s.r, s.y + s.r]] : [])));
      const outside = [];
      rects.forEach((r, i) => { if (cb && (r[0] < cb[0] - 1e-6 || r[1] < cb[1] - 1e-6 || r[2] > cb[2] + 1e-6 || r[3] > cb[3] + 1e-6)) outside.push(i); });
      if (outside.length) out.push({level: "warning", code: "courtyard", message: outside.length + " pad(s) extend outside the courtyard.", pads: outside});
    }
    if (!shapes.some(isSilk) && pads.length) out.push({level: "info", code: "silk", message: "No silkscreen outline or pin-1 marker."});
    return out;
  }

  // ------------------------------------------------------------------ validation
  const validated = new WeakMap();
  // Panel rows re-render often; defs are replaced, not mutated, when edited, so cache per object.
  function cachedValidate(def) {
    let v = validated.get(def);
    const version = globalThis.AtriumUndoStore?.definitionVersion?.(def);
    if (!v || v.version !== version) { v = {version, result: validateDef(def)}; validated.set(def, v); }
    return v.result;
  }
  function validateDef(def, o = {}) {
    const errors = [], warnings = [];
    if (!isObj(def)) return {ok: false, errors: ["A definition must be an object."], warnings};
    if (typeof def.name !== "string" || !def.name.trim()) errors.push("Give the component a name.");
    if (def.prefix != null && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(String(def.prefix))) errors.push("Use a designator prefix beginning with a letter.");
    if (!def.symbol && !def.footprint) errors.push("Add a symbol or a footprint.");
    try {
      const copy = JSON.parse(JSON.stringify({...def, id: def.id || "check"}));
      A.validate({format: "atrium", version: 1, name: "check", library: [copy], documents: [A.sheet("schematic", "s")]});
    } catch (e) { errors.push("The definition does not match the Waffle model: " + e.message.replace("This file is not a supported Waffle project.", "check pins, pads and shapes.")); }
    const sym = def.symbol, fp = def.footprint;
    if (sym) {
      const seen = new Map();
      for (const p of sym.pins || []) {
        if (Number.isInteger(p.electrical) && p.electrical > 7 && p.electrical < 64) warnings.push("Pin " + p.number + " has an electrical type from a newer version of Waffle; it is kept and ERC does not check it here.");
        else if (p.electrical != null && !(Number.isInteger(p.electrical) && p.electrical >= 0 && p.electrical <= 7)) errors.push("Pin " + p.number + " has an unknown electrical type.");
        const k = String(p.number) + "|" + (p.part || 0);
        if (seen.has(k)) errors.push("Pin number " + p.number + " appears twice" + (p.part ? " in gate " + p.part : "") + ".");
        seen.set(k, p);
      }
      const tips = new Map();
      for (const p of sym.pins || []) {
        const k = A.pointKey([p.x, p.y]) + "|" + (p.part || 0);
        if (tips.has(k) && !p.hidden && !tips.get(k).hidden) warnings.push("Pins " + tips.get(k).number + " and " + p.number + " share a connection point.");
        tips.set(k, p);
      }
      if ((sym.parts || 1) > 1) for (let g = 1; g <= sym.parts; g++) if (!(sym.pins || []).some(p => p.part === g)) warnings.push("Gate " + String.fromCharCode(64 + g) + " has no pins.");
    }
    if (fp) for (const x of checkFootprint(fp, o)) if (x.level === "error") errors.push(x.message); else if (x.level === "warning" && o.footprintWarnings !== false) warnings.push(x.message);
    if (sym && fp) {
      const pads = new Set((fp.pads || []).map(p => String(p.number))), pins = new Set((sym.pins || []).map(p => String(p.number)));
      const {noPad, noPin} = globalThis.AtriumLibraryPairing.difference(pins, pads);
      if (noPad.length) warnings.push("Pins without a pad: " + noPad.slice(0, 12).join(", ") + (noPad.length > 12 ? "…" : "") + ".");
      if (noPin.length) warnings.push("Pads without a pin: " + noPin.slice(0, 12).join(", ") + (noPin.length > 12 ? "…" : "") + ".");
    }
    return {ok: !errors.length, errors, warnings};
  }

  // ------------------------------------------------------------------ project operations
  function usage(project, id) {
    const out = [];
    for (const d of project.documents || []) for (const i of d.items || []) if (i.kind === "part" && i.def === id) out.push({doc: d, item: i});
    const mirror = (project.library || []).find(x => x.mirrorOf === id);
    if (mirror) for (const d of project.documents || []) for (const i of d.items || []) if (i.kind === "part" && i.def === mirror.id) out.push({doc: d, item: i, mirrored: true});
    // Assembly variants that fit this def as an alternate part (variants.js) also use it.
    for (const v of Array.isArray(project.variants) ? project.variants : []) for (const [key, e] of Object.entries(v?.parts || {}))
      if (e?.alternate?.def === id) out.push({variant: v.name || v.id, item: {ref: key}});
    return out;
  }
  function uniqueName(project, base) {
    const names = new Set((project.library || []).map(d => d.name));
    if (!names.has(base)) return base;
    let i = 2; while (names.has(base + " " + i)) i++;
    return base + " " + i;
  }
  function duplicate(project, def) {
    const copy = JSON.parse(JSON.stringify(def));
    copy.id = A.id(); copy.name = uniqueName(project, def.name + " copy");
    delete copy.mirrorOf; delete copy.mirrorSig; delete copy.sourceName; delete copy.libraryRef;
    project.library.push(copy);
    return copy;
  }
  function remove(project, id) {
    const used = usage(project, id);
    const placed = used.filter(u => !u.variant), variants = used.filter(u => u.variant);
    if (placed.length) throw Error("This component is placed " + placed.length + " time" + (placed.length === 1 ? "" : "s") + " (" + [...new Set(placed.map(u => u.item.ref))].slice(0, 6).join(", ") + "). Delete or replace those parts first.");
    if (variants.length) throw Error("Variant " + [...new Set(variants.map(u => u.variant))].slice(0, 3).join(", ") + " fits this component as an alternate (" + [...new Set(variants.map(u => u.item.ref))].slice(0, 6).join(", ") + "). Change the variant first.");
    const i = project.library.findIndex(d => d.id === id);
    if (i < 0) throw Error("That component is not in the library.");
    project.library.splice(i, 1);
    for (let k = project.library.length - 1; k >= 0; k--) if (project.library[k].mirrorOf === id) project.library.splice(k, 1);
    globalThis.AtriumComponentFamilies?.forget(project, id);
  }
  // Wire endpoints that sat on a moved pin follow it with an orthogonal elbow (as Atrium.transformPart).
  // Anything else joined at the old point (power ports, net labels, ports, off-sheet connectors,
  // junctions, another part's pin) stays put and gets a wire stub to the new pin position, so
  // no connection is lost. moved: pointKey(old) -> new point; froms: pointKey(old) -> old point.
  const ANCHORED = new Set(["netlabel", "power", "port", "offsheet", "junction"]);
  function rewire(doc, moved, o = {}) {
    let n = 0, stubs = 0;
    const attached = new Set(o.stationary), skip = o.skip || new Set();
    const rows = new Map(), columns = new Map();
    for (const [k, p] of o.froms || []) for (const [axis, value] of [[rows, p[1]], [columns, p[0]]]) {
      const index = Math.round(value * 10000);
      if (!axis.has(index)) axis.set(index, []);
      axis.get(index).push([k, p]);
    }
    for (const i of doc.items) {
      if (ANCHORED.has(i.kind) && Number.isFinite(i.x) && Number.isFinite(i.y)) { const k = A.pointKey([i.x, i.y]); if (moved.has(k)) attached.add(k); }
      else if (i.kind === "part" && o.defs && !skip.has(i.id)) for (const p of A.pins(i, o.defs.get(i.def), "schematic")) { const k = A.pointKey(p.at); if (moved.has(k)) attached.add(k); }
    }
    for (const w of doc.items) {
      if (w.kind !== "wire" || w.points.length < 2) continue;
      const original = w.points, first = original[0], last = original.at(-1);
      const follows = moved.has(A.pointKey(first)) || moved.has(A.pointKey(last));
      const old = [first];
      for (let j = 1; j < original.length; j++) {
        const a = original[j - 1], b = original[j];
        const candidates = a[1] === b[1] ? rows.get(Math.round(a[1] * 10000)) :
          a[0] === b[0] ? columns.get(Math.round(a[0] * 10000)) : o.froms;
        const middle = [];
        for (const [k, p] of candidates || []) {
          if (A.same(p, first) || A.same(p, last) || A.nearSegment(p, a, b) >= .00011) continue;
          attached.add(k);
          // When an endpoint follows a different pin, preserve this contact as an elbow anchor.
          if (follows && !A.same(p, a) && !A.same(p, b)) middle.push(p);
        }
        if (middle.length) old.push(...middle.sort((p, q) => Math.hypot(p[0] - a[0], p[1] - a[1]) - Math.hypot(q[0] - a[0], q[1] - a[1])));
        old.push(b);
      }
      if (!follows) continue;
      w.points = old.slice();
      for (const end of [0, old.length - 1]) {
        const target = moved.get(A.pointKey(old[end]));
        if (!target || A.same(target, old[end])) continue;
        const start = end === 0, adj = start ? old[1] : old[old.length - 2];
        const horiz = Math.abs(old[end][1] - adj[1]) < 1e-4, elbow = horiz ? [adj[0], target[1]] : [target[0], adj[1]];
        if (start) w.points.splice(0, 1, target.slice(), elbow); else w.points.splice(-1, 1, elbow, target.slice());
        n++;
      }
      w.points = w.points.filter((p, i, a) => !i || !A.same(p, a[i - 1]));
    }
    for (const k of attached) {
      const from = o.froms?.get(k), to = moved.get(k);
      if (!from || !to || A.same(from, to)) continue;
      doc.items.push({id: A.id(), kind: "wire", points: A.pathBetween(from, to)});
      stubs++;
    }
    return o.detail ? {wires: n, stubs} : n;
  }
  const gated = (g, item) => A.gate ? A.gate(g, item) : g;
  function uniquePinsByNumber(pins) {
    const unique = new Map();
    for (const pin of pins) {
      const number = String(pin.number);
      unique.set(number, unique.has(number) ? null : pin);
    }
    return unique;
  }
  function joinedNets(before, after) {
    const groups = new Map();
    for (const side of ["byWire", "byPin"]) for (const [id, previous] of before[side]) {
      const now = after[side].get(id);
      if (!now) continue;
      if (!groups.has(now)) groups.set(now, new Set());
      groups.get(now).add(previous);
    }
    return [...groups.values()].filter(names => names.size > 1).map(names => [...names].sort());
  }
  // Re-sync placed parts with an edited def. Parts placed from `sources` (older copies)
  // are retargeted; schematic wires follow pins that moved (matched by number); pin nets
  // of pads that no longer exist are dropped; values that matched the old default follow
  // the new one. Run inside one undo step.
  function updateParts(project, def, o = {}) {
    const report = {parts: 0, rewired: 0, stubs: 0, retargeted: 0, dropped: 0, values: 0, disconnected: [], lostNets: [], joinedNets: []};
    const byId = new Map(project.library.map(d => [d.id, d]));
    const sources = new Set(o.sources || []);
    const oldDef = o.oldDef || byId.get(def.id), mirror = project.library.find(x => x.mirrorOf === def.id);
    const pads = new Set((def.footprint?.pads || []).map(p => String(p.number)));
    const beforeDefs = new Map(byId);
    if (oldDef) beforeDefs.set(def.id, oldDef);
    for (const d of project.documents) {
      const moved = new Map(), froms = new Map(), touched = new Set(), stationary = new Set(), branches = new Map();
      const targets = d.items.some(i => i.kind === "part" && (i.def === def.id || sources.has(i.def)));
      const before = targets && d.kind === "schematic" ? A.connectivity(d, beforeDefs) : null;
      for (const item of d.items) {
        const mirrored = d.kind === "pcb" && mirror && item.def === mirror.id;
        if (item.kind !== "part" || (!mirrored && item.def !== def.id && !sources.has(item.def))) continue;
        const before = mirrored || item.def === def.id ? oldDef : byId.get(item.def);
        if (!mirrored && item.def !== def.id) { item.def = def.id; report.retargeted++; }
        report.parts++; touched.add(item.id);
        if (d.kind === "schematic" && before?.symbol && def.symbol) {
          const pins = A.pins(item, def, "schematic");
          const identity = pin => pin.id ?? pin.nativeId;
          const gateKey = pin => JSON.stringify([String(pin.number), pin.part || 0]);
          const byIdentity = new Map(pins.filter(pin => identity(pin) != null).map(pin => [identity(pin), pin.at]));
          const byGate = new Map(pins.map(pin => [gateKey(pin), pin.at]));
          const previous = gated(before.symbol, item).pins || [];
          const byNumber = uniquePinsByNumber(pins), oldNumbers = uniquePinsByNumber(previous);
          for (const p of previous) {
            const number = String(p.number), at = A.world([p.x, p.y], item);
            const next = byIdentity.get(identity(p)) ?? byGate.get(gateKey(p)) ??
              (oldNumbers.get(number) === p ? byNumber.get(number)?.at : undefined);
            if (!next) continue;
            const key = A.pointKey(at);
            if (A.same(at, next)) { stationary.add(key); continue; }
            if (moved.has(key) && !A.same(moved.get(key), next)) branches.set(key + "/" + A.pointKey(next), [moved.get(key), next]);
            else { moved.set(key, next); froms.set(key, at); }
          }
        }
        if (item.pinNets && def.footprint) for (const k of Object.keys(item.pinNets)) if (!pads.has(k)) { delete item.pinNets[k]; report.dropped++; }
        if (before && before.value != null && item.value === before.value && def.value != null && def.value !== before.value) { item.value = def.value; report.values++; }
      }
      if (moved.size) {
        const r = rewire(d, moved, {froms, skip: touched, stationary, defs: beforeDefs, detail: true});
        report.rewired += r.wires; report.stubs += r.stubs;
        for (const [from, to] of branches.values()) {
          d.items.push({id: A.id(), kind: "wire", points: A.pathBetween(from, to)}); report.stubs++;
        }
      }
      if (before) {
        const after = A.connectivity(d, byId);
        for (const item of d.items) if (touched.has(item.id)) {
          for (const [key, net] of before.byPin) if (key.startsWith(item.id + "/") && !after.byPin.has(key)) {
            const pin = key.slice(item.id.length + 1);
            report.disconnected.push(item.ref + "." + pin);
            report.lostNets.push({ref: item.ref, pin, net, doc: d.name});
          }
        }
        for (const nets of joinedNets(before, after)) report.joinedNets.push({doc: d.name, nets});
      }
    }
    // Mirrored bottom-side copies regenerate from the edited footprint.
    if (!o.schematicPreview && globalThis.AtriumPCBEdit?.counterpart && project.library.some(x => x.mirrorOf === def.id)) AtriumPCBEdit.counterpart(project, def);
    for (const id of sources) if (id !== def.id && !usage(project, id).length && o.removeSources) {
      const k = project.library.findIndex(x => x.id === id);
      if (k >= 0) {project.library.splice(k, 1); globalThis.AtriumComponentFamilies?.forget(project, id);}
    }
    return report;
  }
  // Store an edited def (new or replacing the one with the same id) and update its parts.
  function replaceDef(project, def, o = {}) {
    const check = validateDef(def, {footprintWarnings: false});
    if (!check.ok) throw Error(check.errors[0]);
    const k = project.library.findIndex(d => d.id === def.id);
    const oldDef = k >= 0 ? project.library[k] : null;
    if (k >= 0) project.library[k] = def; else project.library.push(def);
    globalThis.AtriumLibraryStore?.hoist(project, def); // an embedded STEP model is stored once (project.blobs)
    const report = oldDef ? updateParts(project, def, {oldDef, sources: o.sources}) : {parts: 0, rewired: 0, stubs: 0, retargeted: 0, dropped: 0, values: 0, disconnected: []};
    return {...report, added: !oldDef, warnings: check.warnings};
  }
  // Older copies of a def, linked by provenance only: the same library entry (libraryRef) or the
  // same imported source symbol (sourceName). Duplicates made with Duplicate are never included.
  function similar(project, def) {
    const ref = def.libraryRef, src = String(def.sourceName || "").trim().toLowerCase();
    const members = globalThis.AtriumComponentFamilies?.memberships(project);
    const packageName = d => d.footprint?.name || d.footprintName || "";
    return project.library.filter(d => {
      if (d.id === def.id || d.mirrorOf || members?.has(def.id) && members.has(d.id)) return false;
      if (ref || d.libraryRef) return !!(ref && d.libraryRef && d.libraryRef.id === ref.id && (ref.library || ref.name) === (d.libraryRef.library || d.libraryRef.name));
      return src && String(d.sourceName || "").trim().toLowerCase() === src && d.name === def.name && packageName(d) === packageName(def);
    });
  }

  // ------------------------------------------------------------------ search
  function facts(def) {
    const pins = def.symbol?.pins?.length || 0, pads = def.footprint?.pads?.filter(p => !p.thermalVia).length || 0;
    return {pins, pads, prefix: def.prefix || "", pkg: def.footprint?.name || "", value: def.value || "", category: def.category || "",
      params: isObj(def.parameters) ? def.parameters : {}, height: def.footprint?.height || def.height || 0};
  }
  function search(library, query, o = {}) {
    const terms = String(query || "").trim().split(/\s+/).filter(Boolean);
    return library.filter(def => {
      if (def.mirrorOf && !o.mirrors) return false;
      const f = facts(def);
      // Folded (AtriumParts.fold): "D-" finds "D−", "uF" finds "µF", "ohm" finds "Ω"; pin names count too.
      const hay = fold([def.name, def.category, f.pkg, f.value, f.prefix, def.description, ...Object.entries(f.params).map(([k, v]) => k + " " + v),
        ...(def.symbol?.pins || []).map(p => p.name)].join(" ")), tight = hay.replace(/\s+/g, "");
      for (const raw of terms) {
        const t = fold(raw);
        let m;
        if ((m = /^(pins|pads|height)([<>]=?|=)(\d+(?:\.\d+)?)$/.exec(t))) {
          const v = f[m[1]], n = +m[3], op = m[2];
          if (!(op === ">" ? v > n : op === ">=" ? v >= n : op === "<" ? v < n : op === "<=" ? v <= n : v === n)) return false;
          continue;
        }
        if ((m = /^has:(symbol|footprint|model|3d)$/.exec(t))) {
          const ok = m[1] === "symbol" ? !!def.symbol : m[1] === "footprint" ? !!def.footprint : !!(def.model3d || def.footprint?.model3d || def.footprint?.bodies3d?.length);
          if (!ok) return false; continue;
        }
        if ((m = /^(prefix|pkg|package|footprint|value|category|cat):(.+)$/.exec(t))) {
          const key = {pkg: "pkg", package: "pkg", footprint: "pkg", cat: "category"}[m[1]] || m[1];
          if (!fold(f[key]).includes(m[2])) return false; continue;
        }
        if ((m = /^([^:]+):(.+)$/.exec(t)) && Object.keys(f.params).length) {
          const hit = Object.entries(f.params).some(([k, v]) => fold(k) === m[1] && fold(v).includes(m[2]));
          if (hit) continue;
        }
        if (!hay.includes(t) && !tight.includes(t)) return false;
      }
      return true;
    });
  }
  const fold = s => (globalThis.AtriumParts?.fold || (x => String(x ?? "").toLowerCase()))(s);

  // ------------------------------------------------------------------ gates
  // Quick-create for multi-gate parts: each gate gets its own body; pins with part 0
  // (shared, usually power) appear once and show on every gate.
  function symbolFromGates(rows, parts, opts) {
    const n = Math.max(1, parts | 0 || Math.max(1, ...rows.map(r => r.part || 1)));
    if (n <= 1) return symbolFromPins(rows, opts);
    const out = {pins: [], shapes: [], parts: n}, shared = new Set(rows.filter(r => r.part === 0).map(r => String(r.number)));
    for (let g = 1; g <= n; g++) {
      const sub = symbolFromPins(rows.filter(r => (r.part || 1) === g || r.part === 0), opts);
      for (const p of sub.pins) { if (shared.has(p.number)) { if (g === 1) out.pins.push({...p, part: 0}); } else out.pins.push({...p, part: g}); }
      out.shapes.push(...sub.shapes.map(s => ({...s, part: g})));
    }
    return out;
  }
  const gateLetter = u => u > 0 && u <= 26 ? String.fromCharCode(64 + u) : u > 26 ? "#" + u : "";

  // ------------------------------------------------------------------ MCP / extension entry points
  // createFootprint(project, {family, preset, density, dims, name, prefix, value, parameters, add_symbol,
  //   footprint (raw {pads, shapes, height}), replace_def_id}) -> {def, report, issues}
  function createFootprint(project, a = {}) {
    let def;
    if (a.family) {
      if (!globalThis.AtriumFootprintWizard) throw Error("The footprint wizard is not loaded.");
      def = AtriumFootprintWizard.generate({family: a.family, ...(a.preset ? {preset: a.preset} : {}), density: a.density || "B", ...(a.dims || {}), symbol: a.add_symbol !== false});
    } else if (isObj(a.footprint)) {
      const fp = JSON.parse(JSON.stringify(a.footprint));
      fp.pads = (fp.pads || []).map(p => ({drill: 0, angle: 0, shape: "roundrect", ...p, number: String(p.number ?? "")}));
      fp.shapes = fp.shapes || [];
      def = {id: A.id(), name: a.name || fp.name || "Footprint", prefix: a.prefix || "U", value: "", category: "Footprints", footprint: fp};
      if (!fp.name) fp.name = def.name;
      if (a.add_symbol) { const s = symbolForFootprint(fp, {prefix: def.prefix}); if (s) { def.symbol = s.symbol; if (s.schDrawing) def.schDrawing = s.schDrawing; } }
    } else throw Error("Pass a package family (with preset or dims) or a footprint.");
    if (a.name) def.name = String(a.name);
    if (a.footprint_name) def.footprint.name = String(a.footprint_name);
    if (a.prefix) def.prefix = String(a.prefix);
    if (a.value != null) def.value = String(a.value);
    if (isObj(a.parameters)) def.parameters = {...a.parameters};
    if (a.replace_def_id) {
      const old = project.library.find(d => d.id === a.replace_def_id) || (() => { throw Error("The library has no definition " + a.replace_def_id + "."); })();
      def.id = old.id;
      if (old.symbol && !a.add_symbol) { def.symbol = old.symbol; if (old.schDrawing) def.schDrawing = old.schDrawing; else delete def.schDrawing; }
      if (!a.name) def.name = old.name;
      for (const k of ["prefix", "value", "category", "parameters", "description"]) if (a[k] == null && old[k] != null) def[k] = old[k];
    }
    const report = replaceDef(project, def);
    return {def, report, issues: checkFootprint(def.footprint)};
  }
  // createSymbol(project, {name, prefix, value, pins: text | rows, gates, def_id, footprint_def_id, parameters}) -> {def, report}
  function createSymbol(project, a = {}) {
    const rows = typeof a.pins === "string" ? pinsFromTable(a.pins) : (a.pins || []).map(r => {
      const side = String(r.side || "").toLowerCase();
      return {number: String(r.number), name: String(r.name ?? ""), electrical: electricalCode(r.type ?? r.electrical, r.name),
        ...(["left", "right", "top", "bottom"].includes(side) ? {side} : {}), ...(Number.isInteger(r.part) ? {part: r.part} : {}), ...(r.hidden ? {hidden: true} : {})};
    });
    if (!rows.length) throw Error("Give at least one pin.");
    const model = symbolFromGates(rows, a.gates);
    const built = buildSymbol(model);
    const base = a.def_id ? project.library.find(d => d.id === a.def_id) || (() => { throw Error("The library has no definition " + a.def_id + "."); })() : null;
    const def = base ? JSON.parse(JSON.stringify(base)) : {id: A.id(), name: a.name || "Component", prefix: a.prefix || "U", value: a.value || "", category: "Project components"};
    if (a.name) def.name = String(a.name);
    if (a.prefix) def.prefix = String(a.prefix);
    if (a.value != null) def.value = String(a.value);
    if (isObj(a.parameters)) def.parameters = {...a.parameters};
    def.symbol = built.symbol;
    if (built.schDrawing) def.schDrawing = built.schDrawing; else delete def.schDrawing;
    delete def.sourceSymbolShapes;
    if (a.footprint_def_id) {
      const f = project.library.find(d => d.id === a.footprint_def_id);
      if (!f?.footprint) throw Error("Definition " + a.footprint_def_id + " has no footprint.");
      def.footprint = JSON.parse(JSON.stringify(f.footprint));
    }
    const report = replaceDef(project, def);
    return {def, report};
  }

  // ------------------------------------------------------------------ library files (.atrlib)
  // {format:"atrium-library", version:1, name, description, defs:[...]} — plain JSON, shareable
  // between projects. Values under keys that look like credentials are never written or read.
  const SECRET = /(api[_-]?key|token|secret|password|passwd|credential|auth(?!or(?:$|s$|name$|email$|edby$|ship$))|cookie|session)/i;
  const AUTHOR_FIELD = /^(?:author (?:email|name)|authored by)$/i;
  function scrub(v, removed = []) {
    if (Array.isArray(v)) return v.map(x => scrub(x, removed));
    if (!isObj(v)) return v;
    const o = {};
    for (const [k, x] of Object.entries(v)) { if (SECRET.test(k) && !AUTHOR_FIELD.test(k)) { removed.push(k); continue; } o[k] = scrub(x, removed); }
    return o;
  }
  const stable = v => Array.isArray(v) ? "[" + v.map(stable).join(",") + "]" : isObj(v) ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}" : JSON.stringify(v);
  // Content hash of a def, ignoring its id and library provenance (FNV-1a, 52-bit).
  // A library entry's readable revision (rev) is bookkeeping, not content.
  // A 3D model stored once in project.blobs counts as its STEP text, so the project copy and the
  // library entry (which keeps the text inline) still agree: pass the project for such defs.
  function defHash(def, project, portableModels = false) {
    const S = globalThis.AtriumLibraryStore;
    if (!portableModels && project && S?.hoisted(def)) def = S.inflate(project, def);
    const {id, libraryRef, mirrorOf, mirrorSig, rev, ...rest} = def || {};
    void id; void libraryRef; void mirrorOf; void mirrorSig; void rev;
    const content = scrub(rest);
    const s = stable(portableModels && S ? S.portableModels(project, content) : content);
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; }
    return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }
  function kiCadCredit(kind, licenceText, ref) {
    const project = "https://gitlab.com/kicad/libraries/kicad-" + kind;
    return {credit: "KiCad library contributors", licence: "CC-BY-SA-4.0 WITH KiCad-libraries-exception",
      sourceUrl: project + "/-/tree/" + (ref || "master"),
      licenceUrl: ref ? project + "/-/blob/" + ref + "/LICENSE.md" : "https://www.kicad.org/libraries/license/",
      ...(licenceText ? {licenceText} : {})};
  }
  function portableSource(def, notices = {}) {
    const official = def.libraryRef?.library === "kicad-official"; // older registered download copies
    const src = def.source || (official ? {kind: def.symbol ? "kicad-symbol" : "kicad-footprint"} : undefined);
    function credited(part) {
      const kind = part?.kind === "kicad-symbol" ? "symbols" : part?.kind === "kicad-footprint" ? "footprints" : null;
      if (!kind || part.attribution) return part;
      const credit = notices[kind] || (official ? kiCadCredit(kind) : null);
      return credit ? {...part, attribution: {...credit, modified: true}} : part;
    }
    const primary = credited(src), footprint = credited(src?.footprint);
    return footprint && footprint !== src.footprint ? {...primary, footprint} : primary;
  }
  function portableDefinition(project, def, removed) {
    const S = globalThis.AtriumLibraryStore;
    const {libraryRef, mirrorSig, ...rest} = def;
    void libraryRef; void mirrorSig;
    if (def.source || def.libraryRef?.library === "kicad-official") rest.source = portableSource(def);
    const entry = scrub(rest, removed);
    return S ? S.portableModels(project, entry) : entry;
  }
  function libraryFile(lib, project) {
    const removed = [];
    const defs = (lib.defs || []).filter(d => !d.mirrorOf).map(d => {
      const entry = portableDefinition(project, d, removed);
      if (d.stub || globalThis.AtriumLibraryStore?.hoisted(entry)) throw Error("Load the library geometry and its referenced STEP data before exporting " + (d.name || d.id) + ".");
      return entry;
    });
    const out = {format: "atrium-library", version: 1, name: String(lib.name || "Library"), description: String(lib.description || ""), defs};
    if (typeof lib.id === "string" && lib.id) out.id = lib.id;
    // Deleted entries (AtriumLibraryStore.tombstone): a peer that still has one learns it was removed.
    const gone = tombstonesOf(lib).filter(t => !defs.some(d => d.id === t.id));
    if (gone.length) out.tombstones = gone;
    if (lib.componentFamilies !== undefined) {
      const families = globalThis.AtriumComponentFamilies.forLibrary(lib, defs);
      if (families.length) out.componentFamilies = scrub(families, removed);
    }
    return {text: JSON.stringify(out, null, 2) + "\n", removed: [...new Set(removed)]};
  }
  function readLibraryFile(text, fileName = "", onEntry) {
    let data;
    try { data = JSON.parse(String(text).replace(/^﻿/, "")); } catch { throw Error("This is not a Waffle library file (.atrlib JSON)."); }
    if (!isObj(data) || data.format !== "atrium-library" || data.version !== 1 || !Array.isArray(data.defs)) throw Error("This is not a Waffle library file (format atrium-library, version 1).");
    const warnings = [], defs = [], ids = new Set(), removed = [];
    for (const [index,raw] of data.defs.entries()) {
      const def = scrub(raw, removed);
      if (!isObj(def) || typeof def.id !== "string" || !def.id || ids.has(def.id)) { const reason = "Skipped an entry without a unique id."; warnings.push(reason); onEntry?.(index,raw,false,reason); continue; }
      const v = validateDef(def, {footprintWarnings: false});
      if (!v.ok) { warnings.push((def.name || def.id) + ": " + v.errors[0]); onEntry?.(index,raw,false,v.errors[0]); continue; }
      ids.add(def.id); defs.push(def); onEntry?.(index,def,true);
    }
    const families = data.componentFamilies === undefined ? [] :
      globalThis.AtriumComponentFamilies.forLibrary({componentFamilies: scrub(data.componentFamilies, removed)}, defs, warnings);
    if (removed.length) warnings.push("Ignored credential-like fields: " + [...new Set(removed)].join(", ") + ".");
    const tombstones = tombstonesOf(data);
    return {...(typeof data.id === "string" && data.id ? {id: data.id} : {}), ...(families.length ? {componentFamilies: families} : {}), ...(tombstones.length ? {tombstones} : {}),
      name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : String(fileName).replace(/\.atrlib$/i, "") || "Library",
      description: typeof data.description === "string" ? data.description : "", defs, warnings};
  }
  const tombstonesOf = lib => (Array.isArray(lib?.tombstones) ? lib.tombstones : []).filter(t => isObj(t) && typeof t.id === "string" && t.id && Number.isInteger(t.rev))
    .map(t => ({id: t.id, rev: t.rev, deleted: true, ...(typeof t.date === "string" ? {date: t.date.slice(0, 40)} : {})}));
  // Human-readable differences between two defs (a = current, b = incoming).
  const LAND_FIELDS = ["w", "h", "shape", "drill", "angle", "plated", "layer", "maskExpansion", "pasteExpansion",
    "noPaste", "stackMode", "padStack", "holeShape", "slotLength", "slotAngle", "cornerRadius", "roundRectRatio"];
  function padValue(p, k) {
    if (k === "plated") return p.plated !== false;
    if (k === "drill" || k === "angle") return p[k] || 0;
    return p[k] ?? null;
  }
  function compareLands(a, b) {
    const added = [], removed = [], moved = [], resized = [], groups = new Map();
    const signature = p => stable([p.x, p.y, ...LAND_FIELDS.map(k => padValue(p, k))]);
    for (const [fp, side] of [[a, 0], [b, 1]]) for (const pad of fp?.pads || []) {
      const key = String(pad.number ?? "") + (pad.thermalVia ? "|via" : "|land");
      if (!groups.has(key)) groups.set(key, [[], []]);
      groups.get(key)[side].push(pad);
    }
    const compare = (before, pad) => {
      if (!before) { added.push(pad); return; }
      if (!pad) { removed.push(before); return; }
      const by = Math.hypot(before.x - pad.x, before.y - pad.y);
      if (by > .01) moved.push({before, pad, by: Math.round(by * 1000) / 1000});
      const fields = LAND_FIELDS.filter(k => {
        const left = padValue(before, k), right = padValue(pad, k);
        return left !== right && (typeof left !== "object" || stable(left) !== stable(right));
      });
      if (fields.length) resized.push({before, pad, fields});
    };
    const order = (p, q) => p.x - q.x || p.y - q.y || signature(p).localeCompare(signature(q));
    for (const [old, next] of groups.values()) {
      if (old.length <= 1 && next.length <= 1) { compare(old[0], next[0]); continue; }
      const exact = new Map(), changed = [];
      for (const p of old) {
        const key = signature(p);
        if (!exact.has(key)) exact.set(key, []);
        exact.get(key).push(p);
      }
      // Equivalent lands can occur in a different record order or on coincident layers.
      for (const p of next) if (!exact.get(signature(p))?.pop()) changed.push(p);
      const remaining = [...exact.values()].flat().sort(order); changed.sort(order);
      for (let i = 0; i < Math.max(remaining.length, changed.length); i++) compare(remaining[i], changed[i]);
    }
    return {added, removed, moved, resized};
  }
  function landChanges(change) {
    const {before, pad, fields} = change, text = [];
    if (fields.includes("w") || fields.includes("h")) text.push("size " + before.w + "×" + before.h + " → " + pad.w + "×" + pad.h);
    for (const k of fields) if (k !== "w" && k !== "h") {
      const label = k.replace(/[A-Z]/g, s => " " + s.toLowerCase());
      const pretty = v => v == null ? "default" : typeof v === "object" ? stable(v) : String(v);
      text.push(label + " " + pretty(padValue(before, k)) + " → " + pretty(padValue(pad, k)));
    }
    return text;
  }
  function modelChange(a, b) {
    const sig = d => {
      const fp = d?.footprint, m = d?.model3d || fp?.model3d;
      if (!m && !fp?.bodies3d?.length && !fp?.bodyModels?.length) return null;
      const digest = text => text && (globalThis.AtriumLibraryStore?.sha256(text) || text);
      const model = m && {...m, stepText: undefined, sha256: m.sha256 || digest(m.stepText)};
      const assets = (fp?.bodyModels || []).map(p => [p.id, p.file, p.assetId, digest(p.zlib), digest(p.stepText)]).sort();
      return stable([model || null, fp?.bodies3d || [], assets]);
    };
    const before = sig(a), after = sig(b);
    return before === after ? null : !before ? "added" : !after ? "removed" : "changed";
  }
  function sourceChanges(a, b) {
    const value = (def, side) => {
      const source = def?.source;
      return side === "Symbol" ? (def?.symbol && source?.kind !== "kicad-footprint" ? source : null) :
        source?.footprint || (!def?.symbol ? source : null);
    };
    const changes = [];
    for (const side of ["Symbol", "Footprint"]) {
      const left = value(a, side), right = value(b, side);
      for (const [label, old, next] of [["source file", left?.file, right?.file], ["source entry", left?.entry, right?.entry],
        ["credit", left?.attribution?.credit, right?.attribution?.credit], ["licence", left?.attribution?.licence, right?.attribution?.licence],
        ["source URL", left?.attribution?.sourceUrl, right?.attribution?.sourceUrl]]) {
        if ((old || "") !== (next || "")) changes.push({key: side + " " + label, before: old || "", after: next || ""});
      }
    }
    return changes;
  }
  function diffDefs(a, b) {
    const out = [], fmt = v => v == null || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
    for (const k of ["name", "prefix", "value", "category", "description", "state"]) if ((a?.[k] ?? "") !== (b?.[k] ?? "")) out.push(k + ": " + fmt(a?.[k]) + " → " + fmt(b?.[k]));
    const pa = a?.parameters || {}, pb = b?.parameters || {};
    for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) if (pa[k] !== pb[k]) out.push("parameter " + k + ": " + fmt(pa[k]) + " → " + fmt(pb[k]));
    const sa = a?.symbol, sb = b?.symbol;
    if (!!sa !== !!sb) out.push(sb ? "symbol added" : "symbol removed");
    else if (sa) {
      const ma = new Map((sa.pins || []).map(p => [String(p.number) + "|" + (p.part || 0), p])), mb = new Map((sb.pins || []).map(p => [String(p.number) + "|" + (p.part || 0), p]));
      for (const [k, p] of mb) {
        const q = ma.get(k), label = "pin " + p.number + (p.part ? " (gate " + gateLetter(p.part) + ")" : "");
        if (!q) { out.push(label + " added (" + (p.name || "") + ")"); continue; }
        if ((q.name || "") !== (p.name || "")) out.push(label + " name " + fmt(q.name) + " → " + fmt(p.name));
        if ((q.electrical ?? 4) !== (p.electrical ?? 4)) out.push(label + " type " + ELECTRICAL[q.electrical ?? 4] + " → " + ELECTRICAL[p.electrical ?? 4]);
        if (!A.same([q.x, q.y], [p.x, p.y])) out.push(label + " moved " + q.x + "," + q.y + " → " + p.x + "," + p.y);
        if (!!q.hidden !== !!p.hidden) out.push(label + (p.hidden ? " hidden" : " shown"));
      }
      for (const [k, q] of ma) if (!mb.has(k)) out.push("pin " + q.number + " removed");
      if ((sa.parts || 1) !== (sb.parts || 1)) out.push("gates " + (sa.parts || 1) + " → " + (sb.parts || 1));
      const art = s => stable((s.shapes || []).filter(x => !x.pinArt && x.style !== "pin"));
      if (art(sa) !== art(sb)) out.push("symbol drawing changed (" + (sa.shapes || []).length + " → " + (sb.shapes || []).length + " shapes)");
    }
    const fa = a?.footprint, fb = b?.footprint;
    if (!!fa !== !!fb) out.push(fb ? "footprint added" : "footprint removed");
    else if (fa) {
      if ((fa.name || "") !== (fb.name || "")) out.push("footprint " + fmt(fa.name) + " → " + fmt(fb.name));
      const changes = compareLands(fa, fb), label = p => "pad " + (p.number || "(unnumbered)");
      for (const p of changes.added) out.push(label(p) + " added");
      for (const p of changes.removed) out.push(label(p) + " removed");
      for (const {before, pad} of changes.moved) out.push(label(pad) + " moved " + before.x + "," + before.y + " → " + pad.x + "," + pad.y);
      for (const changed of changes.resized) for (const field of landChanges(changed)) out.push(label(changed.pad) + " " + field);
      if (stable(fa.shapes || []) !== stable(fb.shapes || [])) out.push("footprint graphics changed (" + (fa.shapes || []).length + " → " + (fb.shapes || []).length + " shapes)");
      if ((fa.height ?? null) !== (fb.height ?? null)) out.push("height " + fmt(fa.height) + " → " + fmt(fb.height));
    }
    const m3 = modelChange(a, b);
    if (m3) out.push("3D model " + m3);
    for (const f of sourceChanges(a, b)) out.push(f.key + " " + fmt(f.before) + " → " + fmt(f.after));
    return out;
  }
  // A copy of a library def for a project, remembering where it came from.
  // The provenance a project copy keeps: the library and entry, the entry's content fingerprint and
  // readable revision, and per-side fingerprints so a review can say "footprint changed, symbol not".
  const sourcePositions = new WeakMap();
  function sourceEntry(lib, ref) {
    if (!Array.isArray(lib?.defs)) return null;
    if (lib.kind === "folder" && globalThis.AtriumLibrarySources) return AtriumLibrarySources.findEntry(lib, ref.id, ref.hash);
    let index = sourcePositions.get(lib.defs);
    if (!index || index.size !== lib.defs.length || index.has(ref.id) && lib.defs[index.get(ref.id)]?.id !== ref.id) {
      index = new Map(lib.defs.map((d, i) => [d.id, i])); sourcePositions.set(lib.defs, index);
    }
    return lib.defs[index.get(ref.id)];
  }
  function libraryRefFor(lib, src) {
    const S = globalThis.AtriumLibraryStore, ref = {library: lib.id || lib.name, name: lib.name, id: src.id, hash: defHash(src), rev: Number.isInteger(src.rev) && src.rev > 0 ? src.rev : 1};
    if (lib.kind === "folder") {
      const revision = globalThis.AtriumLibrarySources?.revision(lib, src);
      if (revision) ref.folderRevision = revision;
    }
    if (lib.kind === "group" && lib.revisionKeys?.has(src.id)) ref.groupRevision = lib.revisionKeys.get(src.id);
    if (S) for (const side of ["symbol", "footprint"]) if (src[side]) ref[side] = {hash: S.sideHash(src, side)};
    return ref;
  }
  function fromLibrary(lib, libDef, project) {
    const def = JSON.parse(JSON.stringify(libDef));
    def.libraryRef = libraryRefFor(lib, libDef);
    def.id = A.id(); delete def.rev;
    void project;
    return def;
  }
  // Old files could use the library name as their id. Two modern sources may
  // share a display name and an entry id while containing different components.
  function legacyName(lib, ref) {
    return (!ref.library || ref.library === ref.name) && ref.name === lib.name;
  }
  function sameLibrary(lib, ref) {
    if (!lib || !ref) return false;
    // A project copy linked to a signed head may only resolve against the installed group.
    if (ref.groupRevision) return lib.kind === "group" && lib.id === ref.library;
    if (lib.id && lib.id === ref.library) return true;
    if (!legacyName(lib, ref) || !ref.hash) return false;
    const entry = sourceEntry(lib, ref);
    return !!entry && (entry.stub?.hash || (!entry.stub && defHash(entry))) === ref.hash;
  }
  const linksEntry = (lib, ref, id) => sameLibrary(lib, ref) && (ref.id === id || sourceEntry(lib, ref)?.id === id);
  function addFromLibrary(lib, libDef, project) {
    const existing = project.library.find(d => linksEntry(lib, d.libraryRef, libDef.id));
    if (existing) return existing;
    const def = fromLibrary(lib, libDef, project);
    const F = globalThis.AtriumComponentFamilies;
    const groups = lib.componentFamilies === undefined ? null : F.copiedFamilies(lib, libDef.id, project, def.id, true);
    project.library.push(def);
    globalThis.AtriumLibraryStore?.hoist(project, def);
    if (groups) F.store(project, groups);
    return def;
  }
  // The library def a project def came from, and whether either side changed since.
  function libraryStatus(def, libs, project) {
    const ref = def?.libraryRef;
    if (!ref) return null;
    let lib = libs.find(l => l.id && l.id === ref.library && (!ref.groupRevision || l.kind === "group"));
    if (!lib && !ref.groupRevision) {
      const named = libs.filter(l => legacyName(l, ref));
      // A sole legacy source can report legitimate upstream edits. With
      // multiple candidates only an unambiguous content fingerprint identifies it.
      const candidates = named.length > 1 ? named.filter(l => sameLibrary(l, ref)) : named;
      if (candidates.length === 1) lib = candidates[0];
    }
    const src = sourceEntry(lib, ref);
    if (!src) return lib?.unopened || lib?.scan ? {lib, pending: true, state: "pending"} : {lib, src: null, missing: true};
    const folder = lib.kind === "folder" && globalThis.AtriumLibrarySources;
    const folderRevision = folder && folder.revision(lib, src);
    let libHash;
    if (src.stub) {
      if (src.stub.hash) libHash = src.stub.hash;
      else if (ref.folderRevision && folderRevision) libHash = ref.folderRevision === folderRevision ? ref.hash : null;
      else if (folder && folder.matchesProvenance(lib, def, src)) libHash = ref.hash;
      else return {lib, src, pending: true, state: "pending"};
    } else {
      // Import dates are observations. Preserve them in the project and signed events while
      // comparing old references against the date under which that project copy was linked.
      const date = def.source?.date;
      const imported = folder && date && src.source && /^(altium-|kicad-)/.test(src.source.kind);
      libHash = ref.folderRevision && folderRevision === ref.folderRevision ? ref.hash :
        defHash(imported ? {...src, source: {...src.source, date}} : src);
    }
    const ownHash = defHash(def, project);
    // A linked native copy can still name the embedded STEP by its original full path.
    const portableHash = ownHash !== ref.hash && ownHash !== libHash && (def.model3d || def.footprint?.model3d)
      ? defHash(def, project, true) : ownHash;
    const newHead = !!ref.groupRevision && lib.kind === "group" && lib.revisionKeys?.get(ref.id) !== ref.groupRevision;
    const libraryChanged = newHead || libHash !== ref.hash, projectChanged = ownHash !== ref.hash && portableHash !== ref.hash,
      same = !newHead && (libHash === ownHash || libHash === portableHash);
    // current | update (the library moved ahead) | edited (here) | diverged (both changed)
    const state = same ? "current" : libraryChanged && projectChanged ? "diverged" : libraryChanged ? "update" : "edited";
    return {lib, src, libraryChanged, projectChanged, same, state, fromRev: Number.isInteger(ref.rev) ? ref.rev : 1, toRev: Number.isInteger(src.rev) ? src.rev : 1};
  }
  // Apply a library def to the project def (keeping its id) and re-sync its parts.
  function checkUpdate(project, def, src, refs) {
    if (!src || src.stub) throw Error("Read the source component before updating the project.");
    const v = validateDef(src, {footprintWarnings: false});
    if (!v.ok) throw Error(v.errors[0]);
    if ((!def.symbol || src.symbol) && (!def.footprint || src.footprint)) return;
    for (const u of usage(project, def.id)) {
      if (refs && !refs.includes(u.item.ref)) continue;
      const kind = u.variant ? "pcb" : u.doc.kind;
      if (kind === "pcb" && def.footprint && !src.footprint) throw Error("This update would remove the footprint used by " + u.item.ref + ". Choose a component with a footprint.");
      if (kind === "schematic" && def.symbol && !src.symbol) throw Error("This update would remove the symbol used by " + u.item.ref + ". Choose a component with a symbol.");
    }
  }
  function updateFromLibrary(project, def, lib, src) {
    checkUpdate(project, def, src);
    const next = JSON.parse(JSON.stringify(src));
    next.id = def.id; delete next.rev;
    next.libraryRef = libraryRefFor(lib, src);
    return replaceDef(project, next);
  }
  // Store a project def in a library (by its library id, else a new id). Returns the library entry.
  function saveToLibrary(lib, def, project, portable = def) {
    const ref = sameLibrary(lib, def.libraryRef) ? def.libraryRef.id : null;
    const entry = portableDefinition(project, portable);
    entry.id = ref || def.id;
    const F = globalThis.AtriumComponentFamilies;
    const groups = project && (project.componentFamilies !== undefined || lib.componentFamilies !== undefined)
      ? F.copiedFamilies(project, def.id, lib, entry.id, false) : null;
    const k = lib.defs.findIndex(d => d.id === entry.id);
    // The readable revision goes up by one each time the stored content changes.
    const was = k >= 0 ? lib.defs[k] : null, wasRev = Number.isInteger(was?.rev) && was.rev > 0 ? was.rev : 1;
    entry.rev = !was ? 1 : defHash(was) === defHash(entry) ? wasRev : wasRev + 1;
    if (k >= 0) lib.defs[k] = entry; else lib.defs.push(entry);
    if (Array.isArray(lib.tombstones)) lib.tombstones = lib.tombstones.filter(t => t?.id !== entry.id);
    if (groups) F.store(lib, groups);
    def.libraryRef = libraryRefFor(lib, entry);
    return entry;
  }
  // Library sources (Settings → Library sources): kept per browser. Each holds the file
  // name or host path and a cached copy of its defs, since a page cannot re-read a path.
  const SOURCES = "atrium.libraries.v1";
  let sourceText, sourceList = [];
  const parseSources = raw => { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter(l => isObj(l) && Array.isArray(l.defs)) : []; };
  const originals = new WeakMap();
  const sourceStore = {
    sources() {
      try {
        const raw = globalThis.localStorage?.getItem(SOURCES) || "[]";
        if (raw !== sourceText) { sourceList = parseSources(raw); sourceText = raw; }
        return sourceList;
      } catch { return []; }
    },
    list() {
      try {
        const raw = globalThis.localStorage?.getItem(SOURCES) || "[]", list = parseSources(raw);
        originals.set(list, raw); return list;
      } catch { return []; }
    },
    save(list) { try { if (!globalThis.localStorage) return false;
      if (originals.has(list) && originals.get(list) !== (globalThis.localStorage.getItem(SOURCES) || "[]")) return false;
      globalThis.localStorage.setItem(SOURCES, JSON.stringify(list.map(l => ({id: l.id, name: l.name, path: l.path || "", description: l.description || "", defs: l.defs, componentFamilies: l.componentFamilies, tombstones: l.tombstones, added: l.added, modified: !!l.modified}))));
      globalThis.dispatchEvent?.(new Event("waffle-library-sources"));
      return true; } catch { return false; } }
  };

  // Browser windows share the source registry. Serialize its explicit user writes, and
  // compare the selected source against the exact snapshot the dialog showed.
  const writeSources = fn => globalThis.navigator?.locks?.request ?
    navigator.locks.request("waffle-library-file-sources", () => fn(sourceStore.list())) : Promise.resolve().then(() => fn(sourceStore.list()));
  const sameSource = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
  function storeSources(list) {
    if (!sourceStore.save(list)) throw Error("The library could not be saved. Its sources changed or browser storage is unavailable.");
  }
  const changedSource = () => Error("This library changed in another window. Review its current contents before saving.");
  // ------------------------------------------------------------------ UI kit
  const mono = 'ui-monospace, "SFMono-Regular", Menlo, monospace';
  const ui = {
    mono,
    el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); },
    button(text, fn, cls, variant = "") {
      const b = ui.el("button", text, cls);
      b.type = "button"; if (fn) b.onclick = fn;
      // Filter and gate toggles are library chips, not buttons (docs/ui-library.md › Chips).
      if (b.classList.contains("lib-chip")) { b.classList.add("ui-chip"); return b; }
      const size = b.classList.contains("lib-mini") ? "sm" : undefined;
      if (globalThis.AtriumUI) return AtriumUI.button(b, variant, size);
      b.classList.add("ui-button");
      if (size) b.dataset.size = size;
      if (variant) b.dataset.variant = variant;
      return b;
    },
    shortcut(control, text, key, suffix) { AtriumNavCommon.shortcutTitle(control, text, key, suffix); return control; },
    editorTool(text, key, fn) {
      const b = ui.button(text, fn, "fe-tool");
      b.setAttribute("aria-label", text);
      b.append(AtriumShortcut.render(key, {variant:"inline"}));
      return ui.shortcut(b, text, key);
    },
    editorKeys(rotate) {
      const group = ui.el("span", null, "fe-keys");
      for (const [text, key] of [["Save", "Mod+S"], ["Undo", "Mod+Z"], [rotate, "Space"], ["Fit", "F"], ["Cancel tool", "Escape"]]) {
        const pair = ui.el("span", text + " ");
        pair.append(AtriumShortcut.render(key));
        group.append(pair);
      }
      return group;
    },
    activationKey(e) {
      return (e.key === "Enter" || e.key === " ") && !e.altKey && !e.ctrlKey && !e.metaKey &&
        e.target.matches?.("button, summary, a[href]");
    },
    label(text, control, cls = "lib-field") { const l = ui.el("label", null, cls); l.append(ui.el("span", text), control); if (!control.getAttribute("aria-label")) control.setAttribute("aria-label", text); return l; },
    rejectField(input, rejected) {
      if (rejected) input.dataset.editRejected = "ink";
      else delete input.dataset.editRejected;
    },
    propertyFields(grid) {
      return (parent, label, value, write, o = {}) => {
        let input;
        if (o.values) { input = ui.el("select"); for (const v of o.values) { const [val, text] = Array.isArray(v) ? v : [v, v]; input.add(new Option(text, val)); } input.value = value ?? ""; input.onchange = () => write(input.value); }
        else if (o.check) { input = ui.el("input"); input.type = "checkbox"; input.checked = !!value; input.onchange = () => write(input.checked); }
        else {
          input = ui.el("input"); input.value = value ?? ""; input.spellcheck = false;
          if (o.placeholder) input.placeholder = o.placeholder;
          if (o.number && grid) {input.inputMode="decimal";globalThis.AtriumLazy?.numericField?.(input,
            {unit:o.unit ?? "mm",integer:!!o.integer,nanometres:o.unit==null,min:o.min,optional:o.optional});}
          input.onchange = () => {
            if (!o.number) { write(input.value); return; }
            if (grid && o.optional && input.value.trim() === "") { write(undefined); return; }
            const v = grid && o.unit != null ? Number(input.value) : A.units.parse(input.value, "mm");
            const rejected = !Number.isFinite(v) || (o.min != null && v < o.min);
            ui.rejectField(input, rejected);
            if (!rejected) write(r6(v));
          };
          if (grid) input.onkeydown = e => { if (o.number && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); const v = Number(input.value) || 0, st = grid() * (e.shiftKey ? 10 : 1); input.value = r6(v + (e.key === "ArrowUp" ? st : -st)); input.onchange(); } };
        }
        const row = ui.label(label, input, "fe-field");
        if (o.title) row.title = o.title;
        if (grid && o.unit) {
          input.classList.add("ui-field-number");
          const measurement = ui.el("span", null, "ui-field-measure");
          input.replaceWith(measurement);
          measurement.append(input, ui.el("span", o.unit, "ui-field-unit"));
        }
        parent.append(row);
        return input;
      };
    },
    editorSection(parent, title) { const section = ui.el("section", null, "fe-section"); section.append(ui.el("h3", title)); parent.append(section); return section; },
    // Large modal work surface; Escape closes unless a child handled it.
    // d.requestClose (set by editors with unsaved state) decides whether × and Esc may close.
    dialog(title, cls = "") {
      const d = ui.el("dialog", null, "lib-dialog " + cls); d.setAttribute("aria-label", title);
      const head = ui.el("header", null, "lib-dialog-head"); head.append(ui.el("h2", title));
      const ask = () => { if (Object.hasOwn(d, "requestClose")) d.requestClose(); else d.close(); }; // not the native HTMLDialogElement.requestClose (re-fires cancel)
      d.addEventListener("cancel", e => { e.preventDefault(); ask(); });
      const close = ui.button("×", ask, "ui-close lib-close"); close.dataset.variant = "quiet"; close.setAttribute("aria-label", "Close");
      const drawingEditor = cls === "se-dialog" || cls === "fe-dialog";
      ui.shortcut(close, "Close", "Escape", drawingEditor ? " with no active tool or selection" : "");
      head.append(close); d.append(head); d.heading = head;
      d.addEventListener("close", () => d.remove(), {once: true});
      return d;
    },
    show(d) {
      const actions = d.querySelector(":scope > .lib-actions");
      const body = [...d.children].filter(n => n !== d.heading && n !== actions);
      globalThis.AtriumShell?.adoptDialog?.(d, {
        title:d.heading.querySelector("h2"), body, actions, defaultAction:d.classList.contains("lib-small"),
      });
      document.body.append(d); d.showModal();
      if (document.activeElement?.classList?.contains("lib-close"))
        d.querySelector("select:not(:disabled),input:not([type=hidden]):not(:disabled),textarea:not(:disabled)")?.focus();
    },
    // Each library editor has its own coordinates, draft and undo history.
    paletteSurface(dialog, kind, canvas, stage, actions) {
      let pointer = null;
      const toWorld = (x, y) => {
        const box = canvas.getBoundingClientRect();
        return stage.toLocal([x - box.left, y - box.top]);
      };
      for (const type of ["pointermove", "pointerdown"]) canvas.addEventListener(type, event => {
        pointer = toWorld(event.clientX, event.clientY);
      }, {passive: true});
      const surface = {
        kind, canvas, dialog, toWorld, units: "mm",
        point: () => pointer?.slice() || stage.toLocal([canvas.clientWidth / 2, canvas.clientHeight / 2]),
        centerOn(at) {
          const screen = stage.toScreen(at);
          stage.pan(canvas.clientWidth / 2 - screen[0], canvas.clientHeight / 2 - screen[1]);
          canvas.focus();
        },
        commands: () => [
          ...(actions.commands?.() || []),
          {key: "cmd:" + kind + ":fit", kind: "command", label: "Fit All Objects", detail: "View", run: () => {stage.fit(); canvas.focus();}}
        ],
        objects: () => (actions.pins?.() || []).map((p, i) => ({
          key: kind + ":pin:" + i, kind: "pin", label: (kind === "symbol" ? "Pin " : "Pad ") + p.number + (p.name && p.name !== p.number ? " · " + p.name : ""),
          detail: kind === "symbol" ? "Symbol Editor" : kind === "ipc" ? "Footprint Wizard" : "Footprint Editor",
          run: () => {actions.select?.(i); surface.centerOn([p.x, p.y]);}
        })),
        ...Object.fromEntries(Object.entries(actions).filter(([name]) => !["commands", "pins", "select"].includes(name)))
      };
      dialog.addEventListener("keydown", e => {
        if (e.isComposing || e.repeat || e.defaultPrevented || !globalThis.AtriumLabs?.notebookEnabled()) return;
        const field = e.target.isContentEditable || e.target.closest?.("input, textarea, select, [role=textbox]");
        const slash = !field && e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey;
        if (!slash && e.key !== "F1" && !(e.key.toLowerCase() === "p" && e.shiftKey && (e.metaKey || e.ctrlKey))) {
          if (!field) globalThis.AtriumExtensionPalette?.surfaceShortcut(e, surface);
          return;
        }
        e.preventDefault(); e.stopPropagation();
        globalThis.AtriumNavCommon.openPaletteAction(slash ? "insert-palette" : "command-palette", null, {target:e.target});
      }, true);
      const launcher = document.querySelector("#editor-panes > .palette-insert-launch").cloneNode(true);
      launcher.removeAttribute("title");
      dialog.append(launcher);
      dialog.paletteSurface = surface;
      return surface;
    },
    // A zoomable canvas showing one def exactly as the board or sheet draws a placed part.
    stage(canvas, o) {
      const view = AtriumCanvas.create(canvas), sch = o.kind === "schematic";
      const O = sch ? [190.5, 190.5] : [0, 0];
      const doc = {id: "library-stage", kind: o.kind, name: "Library", grid: o.grid || (sch ? 2.54 : .05), items: [], notes: [],
        outline: sch ? [] : [[-80, -80], [80, -80], [80, 80], [-80, 80]]};
      if (sch) doc.schDrawing = {width: 406.4, height: 406.4, grid: 2.54, frame: [], border: false};
      const part = {id: "library-stage-part", kind: "part", def: "library-stage-def", ref: "", value: "", x: O[0], y: O[1], angle: 0, pinNets: {}, showRef: false, showValue: false};
      doc.items.push(part);
      let defs = new Map(), dpr = 1, observer = null, queued = 0;
      const s = {
        doc, part, view, O,
        toScreen: p => view.worldToScreen([p[0] + O[0], p[1] + O[1]]),
        toLocal: p => { const w = view.screenToWorld(p); return [w[0] - O[0], w[1] - O[1]]; },
        scale: () => view.scale(),
        defs: () => defs,
        sync() {
          const def = o.def() || {name: "", symbol: {pins: [], shapes: []}, footprint: {pads: [], shapes: []}};
          // Editors change the def's footprint and symbol in place, and the board renderer keys its
          // paint boxes and level-of-detail caches on their identity: a fresh shallow copy per frame
          // makes every edit (a quick-add courtyard, a moved pad) repaint instead of reusing them.
          defs = new Map([[part.def, {...def, id: part.def,
            ...(def.footprint ? {footprint: {...def.footprint}} : {}), ...(def.symbol ? {symbol: {...def.symbol}} : {})}]]);
          if (o.item) Object.assign(part, o.item());
          view.invalidate(doc);
        },
        render() {
          if (!canvas.isConnected) return;
          s.sync();
          const r = canvas.getBoundingClientRect(); if (!r.width || !r.height) return;
          view.render(doc, defs, {grid: o.grid !== false, layer: o.layer?.() || "Top", hidden: o.hidden?.() || new Set(), origin: !sch, ...(o.options?.() || {})});
          const c = canvas.getContext("2d"); dpr = canvas.width / r.width || 1;
          c.save(); c.setTransform(dpr, 0, 0, dpr, 0, 0); o.overlay?.(c, s); c.restore();
        },
        schedule() { if (!queued) queued = (globalThis.requestAnimationFrame ? requestAnimationFrame : setTimeout)(() => { queued = 0; s.render(); }); },
        fit() {
          globalThis.AtriumCamera.stopWheel(view);
          s.sync();
          const outline = doc.outline; doc.outline = [];
          const g = sch ? defs.get(part.def)?.symbol : defs.get(part.def)?.footprint;
          const extra = o.extent?.();
          if (extra && (!g || !A.symbolPoints(g).length)) { part.x += 0; }
          view.fit(doc, defs);
          doc.outline = outline; view.invalidate(doc);
          s.render();
        },
        zoom(f, at) { globalThis.AtriumCamera.stopWheel(view); view.zoom(f, at); s.render(); },
        pan(dx, dy) { globalThis.AtriumCamera.stopWheel(view); view.pan(dx, dy); s.render(); },
        observe() {
          if (observer || !globalThis.ResizeObserver) { setTimeout(() => s.fit(), 0); return; }
          let first = true;
          observer = new ResizeObserver(() => { if (first) { first = false; s.fit(); } else s.render(); });
          observer.observe(canvas);
        }
      };
      globalThis.AtriumCanvasInput?.library(canvas,s,o.input);
      // Preview handles the library stage locally; Labs handles it through the canvas capture.
      const stageWheel = e => e.shiftKey && !e.ctrlKey ? {pan:[-e.deltaY,0]} :
        {zoom:Math.exp(-e.deltaY*(e.ctrlKey ? .01 : .0018)),at:"pointer"};
      canvas.addEventListener("wheel", e => {
        e.preventDefault();
        const r = canvas.getBoundingClientRect(), at = [e.clientX - r.left, e.clientY - r.top];
        globalThis.AtriumCamera.wheel(e, view, at, canvas, s.schedule, stageWheel);
      }, {passive: false});
      canvas.closest("dialog")?.addEventListener("close", () => globalThis.AtriumCamera.stopWheel(view), {once:true});
      let panFrom = null;
      canvas.addEventListener("pointerdown", e => {
        if (e.button === 1 || e.button === 2 || (e.button === 0 && s.spaceDown)) { panFrom = [e.clientX, e.clientY]; canvas.setPointerCapture?.(e.pointerId); e.preventDefault(); e.stopImmediatePropagation(); }
      });
      canvas.addEventListener("pointermove", e => { if (!panFrom) return; s.pan(e.clientX - panFrom[0], e.clientY - panFrom[1]); panFrom = [e.clientX, e.clientY]; e.stopImmediatePropagation(); });
      canvas.addEventListener("pointerup", e => { if (panFrom) { panFrom = null; e.stopImmediatePropagation(); } });
      canvas.addEventListener("contextmenu", e => e.preventDefault());
      return s;
    }
  };

  // ------------------------------------------------------------------ panel
  let panel = null;
  function mountPanel(ctx) {
    if (panel?.node?.isConnected) { if (ctx) panel.ctx = ctx; return panel; }
    panel?.dispose();
    const el = ui.el, P = {ctx, node: null, selected: null, filter: "all", lastRevision: -1, lastLibrary: null};
    const host = document.getElementById("properties") || document.body;
    const node = el("section", null, "panel panel-library"); node.setAttribute("aria-label", "Library");
    const head = el("header", null, "pane-heading"); head.append(el("h2", "Library"));
    const tools = el("div", null, "lib-panel-tools");
    const tool = (text, title, fn) => { const b = ui.button(text, fn, "lib-mini"); b.title = title; b.setAttribute("aria-label", title); return b; };
    const close = ui.button("×", () => togglePanel(P.ctx, false), "ui-close lib-panel-close", "quiet");
    close.title = "Close the Library panel"; close.setAttribute("aria-label", close.title);
    head.append(close);
    const manage = ui.button("Manage families…", () => manageFamilies(P.source === "project" ? P.selected : null), "lib-mini");
    const wizard = tool("IPC wizard", "IPC-7351B footprint wizard", () => openWizard(P.ctx));
    tools.append(tool("New symbol", "New symbol", () => openSymbolEditor(P.ctx, null)), tool("New footprint", "New footprint", () => openFootprintEditor(P.ctx, null)), wizard, manage,
      tool("Check…", "Check library: missing 3D models, pins without pads, duplicates", () => checkLibrary(P.ctx, P.lib)),
      tool("Catalogue…", "Component catalogue: place a part, or start the symbol editor or the IPC wizard", () => P.ctx.showCatalogue ? P.ctx.showCatalogue() : P.ctx.info?.("The catalogue is unavailable here.")));
    const notice = el("p", null, "lib-notice"); notice.hidden = true; notice.setAttribute("role", "status");
    const search = el("input", null, "ui-field"); search.type = "search"; search.placeholder = "Search families, components, packages…";
    search.setAttribute("aria-label", "Search the library"); search.spellcheck = false;
    const chips = el("div", null, "lib-chips");
    for (const [k, t] of [["all", "All"], ["symbol", "Symbols"], ["footprint", "Footprints"], ["used", "Placed"], ["unused", "Unused"], ["issues", "Issues"]]) {
      const b = ui.button(t, () => { P.filter = k; P.selected = null; render(); }, "lib-chip"); b.dataset.filter = k; chips.append(b);
    }
    const list = el("div", null, "lib-list"); list.setAttribute("role", "group"); list.setAttribute("aria-label", "Library components"); list.tabIndex = 0;
    const detail = el("div", null, "lib-detail");
    const gateBar = el("div", null, "lib-gate"); gateBar.hidden = true;
    const sourceSel = el("select", null, "lib-source ui-field"); sourceSel.setAttribute("aria-label", "Library source"); sourceSel.title = "Show this project's components or a library file";
    P.source = "project";
    sourceSel.onchange = () => {
      const v = sourceSel.value;
      if (v === "@open") { sourceSel.value = P.source; openLibraryFile(P.ctx).then(lib => { if (lib) { P.source = lib.id; P.selected = null; render(); } }); return; }
      if (v === "@group") {
        sourceSel.value = P.source;
        groupUI(u => u.dialog(P.ctx, P.lib?.kind === "group" ? P.lib.id : null, {
          onChoose: id => { if (id) { P.source = id; P.selected = null; } render(); }
        }));
        return;
      }
      if (v === "@manage") { sourceSel.value = P.source; manageLibraries(P.ctx, () => render()); return; }
      if (v === "@folder" || v === "@import" || v === "@kicad") {
        sourceSel.value = P.source;
        const selectSource = id => { if (id && P.source !== id) { P.source = id; P.selected = null; } render(); };
        folderUI(ui => ui[{"@folder": "addFolder", "@import": "importFiles", "@kicad": "getKiCad"}[v]](P.ctx,
          {started: selectSource, done: v === "@import" ? selectSource : () => render()}));
        return;
      }
      cancelIntent(); P.source = v; P.selected = null; render();
      if (P.lib?.unopened) folderUI(u => u.restore([P.lib.folder]));
    };
    const body = el("div", null, "lib-panel-body"); body.append(tools, sourceSel, notice, AtriumUI.searchField(search), chips, gateBar, list, detail);
    node.append(head, body);
    const components = host.querySelector(".panel-components");
    if (components) components.after(node); else host.append(node);
    P.node = node;
    const project = () => P.ctx.currentProject ? P.ctx.currentProject() : P.ctx.project;
    const visible = () => node.isConnected && !node.hidden && document.visibilityState !== "hidden" &&
      globalThis.AtriumPower?.visible?.() !== false &&
      (node.checkVisibility?.() ?? (!node.closest("[hidden], .dock-inactive") && (node.getClientRects?.().length ?? 1) > 0));
    let checkTimer = 0, tick = 0, showing = false, needsRender = true, focusOnShow = false, intent = 0;
    function cancelIntent() { intent++; P.detailRead = null; P.detailBody = null; }
    function guard(lib, placement = false) {
      const token = intent, owner = project(), rev = P.ctx.revision?.(), nav = globalThis.AtriumNavHost;
      const doc = nav?.doc?.() || P.ctx.doc, selected = P.selected, source = P.source;
      const camera = () => JSON.stringify(nav?.view?.()?.camera?.());
      const before = placement && camera();
      return () => token === intent && visible() && project() === owner && P.source === source && P.selected === selected &&
        (!lib || P.lib === lib || source === "project") &&
        (lib?.kind !== "folder" || globalThis.AtriumLibrarySources?.library(lib.folder) === lib) &&
        (!placement || rev === P.ctx.revision?.() && doc === (nav?.doc?.() || P.ctx.doc) && before === camera());
    }
    function select(id, row = null) {
      if (P.selected === id) return;
      const previous = list.querySelector(".lib-row[aria-pressed=true]");
      cancelIntent(); P.selected = id;
      if (previous) markSelected(previous);
      if (row) markSelected(row);
      render(false);
    }
    function row(def, used, issues, variant) {
      const r = ui.button(null, () => select(def.id, r), "lib-row");
      // The experimental file-drop receiver keeps the system drag; otherwise the part itself follows the pointer.
      r.dataset.def = def.id; r.draggable = dropReceiver();
      markSelected(r);
      const pics = globalThis.AtriumCatalogue?.rowIcons(def) || el("span");
      const f = facts(def), text = el("span", null, "lib-text");
      const name = el("strong", variant?.label || def.name); name.title = name.textContent;
      const meta = [f.prefix && f.prefix + "?", f.pkg, f.pins ? f.pins + " pins" : "", !f.pins && f.pads ? f.pads + " pads" : ""].filter(Boolean).join(" · ");
      const description = variant ? variant.description || [f.pins ? f.pins + " pins" : "", f.pads ? f.pads + " pads" : ""].filter(Boolean).join(" · ") : meta || def.category || "";
      const subtitle = el("small", description); subtitle.title = description;
      text.append(name, subtitle);
      if (variant) text.append(el("span", variant.context, "visually-hidden"));
      const badges = el("span", null, "lib-badges");
      // Library counts and badges (docs/ui-library.md › Badges): placements, issues and the library state.
      const mark = (cls, text, title, tone) => { const n = el("span", text, cls); n.title = title; if (tone) n.dataset.tone = tone; badges.append(n); };
      if (used) mark("ui-count lib-badge", "×" + used, "Placed " + used + " time(s)");
      if (issues) mark("ui-count lib-badge", "!", issues + " issue(s)", "warning");
      const st = P.lib ? null : statusOf(def);
      if (st) mark("ui-badge lib-badge lib-state-" + st.state, STATE_MARK[st.state], stateText(st), STATE_TONE[st.state]);
      r.append(pics, text, badges);
      r.ondblclick = () => placeEntry(P.lib, def);
      r.addEventListener("pointerdown", e => dragPlace(e, def, r));
      r.ondragstart = e => {
        const lib=P.lib, drop=globalThis.AtriumDropEditor;
        drop?.offer(e,{kind:"library-part",id:def.id},lib ? async signal=>{
          const full=def.stub ? await globalThis.AtriumLibrarySources.load(lib,def.id) : def;
          return signal.aborted ? null : {lib,def:full};
        } : null);
        e.dataTransfer.effectAllowed = "copy";
        select(def.id, r);
        globalThis.AtriumSpatialMotion?.lift(r);
      };
      r.ondragend = () => globalThis.AtriumSpatialMotion?.settle(r);
      return r;
    }
    function markSelected(row) {
      const selected = row.dataset.def === P.selected;
      row.setAttribute("aria-pressed", String(selected)); row.tabIndex = selected ? 0 : -1;
    }
    const folderLibs = () => globalThis.AtriumLibrarySources?.libraries() || [];
    const libs = () => [...sourceStore.sources(), ...folderLibs(), ...(globalThis.AtriumGroupLocal?.libraries() || [])];
    function renderSources(list) {
      if (P.source !== "project" && !list.some(l => l.id === P.source)) {
        P.source = list.find(l => l.folder && l.folder === P.lib?.folder)?.id || "project";
      }
      const count = project().library.filter(d => !d.mirrorOf).length;
      const signature = JSON.stringify([count, ...list.map(l => [l.id, l.name, l.kind, l.defs.length, !!l.modified])]);
      if (P.sourceMenu === signature) { sourceSel.value = P.source; return; }
      P.sourceMenu = signature;
      sourceSel.replaceChildren(new Option("This project (" + count + ")", "project"));
      for (const l of list) sourceSel.add(new Option(l.name + " (" + l.defs.length + ")" + (l.kind === "folder" ? " · folder" : l.kind === "group" ? " · group" : "") + (l.modified ? " •" : ""), l.id));
      sourceSel.add(new Option("Group library…", "@group"));
      sourceSel.add(new Option("Open library file…", "@open")); sourceSel.add(new Option("Add library folder…", "@folder"));
      sourceSel.add(new Option("Import library files…", "@import")); sourceSel.add(new Option("Get KiCad libraries…", "@kicad")); sourceSel.add(new Option("Library sources…", "@manage"));
      sourceSel.value = P.source;
    }
    const undo = () => globalThis.AtriumUndoStore;
    const versions = p => undo()?.documentVersions?.(p.documents[0], p);
    // Keep exact part-to-definition assignments per document, including removals and retargets.
    function placements(p, v) {
      const old = P.placements, U = undo();
      const reuse = old && old.project === p && v && old.v && v.floor === old.v.floor;
      if (reuse && v.assembly === old.v.assembly && v.library === old.v.library && v.project === old.v.project) {
        old.v = v; return old;
      }
      const byDoc = reuse ? old.byDoc : new Map(), direct = reuse ? old.direct : new Map();
      const bump = (id, n) => { if (id) direct.set(id, (direct.get(id) || 0) + n); };
      for (const doc of p.documents) {
        let parts = byDoc.get(doc);
        const diff = reuse && parts && U.recordedChanges(doc, old.v.seq);
        if (diff?.ids) {
          for (const id of diff.ids) {
            const before = parts.get(id), item = diff.items.get(id), after = item?.kind === "part" ? item.def : null;
            if (before === after) continue;
            if (before) { bump(before, -1); parts.delete(id); }
            if (after) { bump(after, 1); parts.set(id, after); }
          }
        } else {
          if (parts) for (const id of parts.values()) bump(id, -1);
          byDoc.set(doc, parts = new Map());
          for (const item of doc.items) if (item.kind === "part") { bump(item.def, 1); parts.set(item.id, item.def); }
        }
      }
      const counts = new Map(direct);
      for (const def of p.library) if (def.mirrorOf && direct.get(def.id)) counts.set(def.mirrorOf, (counts.get(def.mirrorOf) || 0) + direct.get(def.id));
      const used = new Set([...counts].filter(([, n]) => n).map(([id]) => id));
      for (const variant of Array.isArray(p.variants) ? p.variants : []) for (const value of Object.values(variant.parts || {})) if (value?.alternate?.def) used.add(value.alternate.def);
      return P.placements = {project: p, v, byDoc, direct, counts, used};
    }
    function filtered(owner, members) {
      const lib = owner.defs || owner.library, C = globalThis.AtriumCatalogue, k = P.filter, p = project();
      const usedSourceIds = P.lib && (k === "used" || k === "unused")
        ? new Set(p.library.filter(d => sameLibrary(P.lib, d.libraryRef) && P.placements.used.has(d.id)).map(d => sourceEntry(P.lib, d.libraryRef)?.id || d.libraryRef.id))
        : null;
      const accept = ({symbol: d => !!d.symbol, footprint: d => !!d.footprint,
        used: d => usedSourceIds ? usedSourceIds.has(d.id) : P.placements.used.has(d.id),
        unused: d => usedSourceIds ? !usedSourceIds.has(d.id) : !P.placements.used.has(d.id),
        issues: d => { if (d.stub) return false; const v = cachedValidate(d); return !v.ok || v.warnings.length; }})[k];
      let res, indexed = false;
      if (C && owner.search) {
        indexed = true;
        const state = C.state("panel");
        res = C.queryPrepared(lib, owner.search, search.value, {accept, state: state.facets,
          limit: 400, counts: !state.folded.has("@all")});
      } else {
        let defs = C ? lib : search.value.trim() ? AtriumLibrary.search(lib, search.value) : lib.filter(d => !d.mirrorOf);
        if (accept) defs = defs.filter(accept);
        if (!C) {
          globalThis.AtriumLazy?.need("AtriumCatalogue").then(() => { if (!node.hidden && node.isConnected) render(); }, () => {});
          return {items: members?.size ? [] : defs, matching: members?.size ? 0 : defs.length};
        }
        const placed = P.placements.used;
        res = C.query(defs, search.value, {ids: new Set(lib.map(d => d.id)), keep: d => !P.lib && placed.has(d.id), state: C.state("panel").facets, members});
      }
      const matching = res.matching ?? res.items.length;
      if (!P.facetBox?.isConnected) { P.facetBox = el("div", null, "cat-facet-box"); list.before(P.facetBox); }
      C.facetsUI(P.facetBox, "panel", res.counts, () => { P.selected = null; render(); }, {compact: true, deferCounts: indexed, total: matching});
      return {items: res.items, matching};
    }
    function render(full = true) {
      if (!visible()) { needsRender = true; return; }
      const p = project();
      if (full || needsRender) {
        if (P.lastProject !== p) { cancelIntent(); P.lastProject = p; P.selected = null; }
        needsRender = false; P.lastRevision = P.ctx.revision?.() ?? 0; P.lastLibrary = p.library;
        P.versions = versions(p); P.familyVersion = undo()?.familyVersion?.(); placements(p, P.versions);
        const sources = libs();
        if (!P.libraries || sources.length !== P.libraries.length || sources.some((s, i) => s !== P.libraries[i])) P.libraries = sources;
        renderSources(P.libraries);
        P.lib = P.source === "project" ? null : P.libraries.find(l => l.id === P.source) || null;
        manage.hidden = !!P.lib;
        const owner = P.lib || p;
        P.members = owner.search?.members || globalThis.AtriumComponentFamilies?.memberships(owner);
        for (const b of chips.children) b.setAttribute("aria-pressed", String(b.dataset.filter === P.filter));
        const {items: defs, matching} = filtered(owner, P.members);
        const shown = defs.slice(0, 400);
        if (P.selected && !shown.some(d => d.id === P.selected)) P.selected = null;
        const C = globalThis.AtriumCatalogue;
        const treeKey = JSON.stringify([P.source, !!C, !!search.value.trim(), matching, shown.map(d => {
          const m = P.members?.get(d.id), rec = C?.record(d);
          return [d.id, rec?.group, rec?.cat, m?.id, m?.name, m?.part, m ? d.footprint?.name : null];
        })]);
        P.shown = new Map(shown.map(d => [d.id, d]));
        const one = (original, variant) => {
          const def = P.shown.get(original.id) || original, used = P.lib ? 0 : P.placements.counts.get(def.id) || 0;
          const version = undo()?.definitionVersion?.(def);
          const state = P.lib ? null : statusOf(def);
          const status = state ? stateText(state) : "", errors = !def.stub && (def.footprint || def.symbol) ? cachedValidate(def).errors.length : 0;
          const prior = P.rows.get(def.id);
          if (prior && prior.def === def && prior.version === version && prior.used === used && prior.status === status && prior.errors === errors) return prior.node;
          const node = row(def, used, errors, variant);
          P.rows.set(def.id, {node, def, version, status, used, errors, variant});
          return node;
        };
        if (P.treeKey === treeKey && P.treeProject === p) {
          // Preserve disclosure state, focus and the scroll anchor for stable rows.
          for (const [id, prior] of P.rows) {
            const next = one(P.shown.get(id), prior.variant);
            if (next !== prior.node) {
              const focused = document.activeElement === prior.node;
              prior.node.replaceWith(next); if (focused) next.focus({preventScroll: true});
            }
          }
        } else {
          const choice = [P.source, P.filter, search.value].join("\0");
          const motion = P.treeProject === p && P.treeChoice === choice && !P.lib?.scan && !search.value.trim()
            ? globalThis.AtriumSpatialMotion : null;
          const rebuild = () => {
            P.treeKey = treeKey; P.treeProject = p; P.rows = new Map(); list.replaceChildren();
            if (C) C.componentTree(list, shown, one,
              {key: "panel", scope: p, source: P.source, owner, members: P.members, reveal: P.selected, open: !!search.value.trim(), onGroup: () => select(null)});
            else for (const def of shown) list.append(one(def));
            if (matching > 400) list.append(el("p", (matching - 400) + " more — refine the search.", "side-note"));
            if (!defs.length) list.append(el("p", P.lib?.scan ? "More components will appear as indexing continues." :
              !C && P.members?.size ? "Loading component library…" :
              (P.lib?.defs || p.library).length ? "No matching components." : "The library is empty.", "side-note"));
          };
          if (motion) motion.layout(list, ".lib-row[data-def]", row => row.dataset.def, rebuild); else rebuild();
          P.treeChoice = choice;
        }
        renderNotice();
      }
      P.lastSel = (P.ctx.selection?.() || []).join(",");
      renderDetail(); renderGate();
    }
    function detailActions() {
      const acts = el("div", null, "lib-detail-actions");
      return {acts, act(text, title, fn, disabled, key) {
        const b = ui.button(text, fn, "lib-mini");
        if (key) ui.shortcut(b, title, key, " from a component row");
        else b.title = title;
        b.disabled = !!disabled;
        acts.append(b);
        return b;
      }};
    }
    function renderDetail() {
      globalThis.AtriumCatalogue?.cancelPreview(detail);
      detail.replaceChildren();
      if (P.lib) { libraryDetail(P.lib); return; }
      const def = project().library.find(d => d.id === P.selected);
      if (!def) { detail.append(el("p", "Select a component. Drag it onto the sheet or board to place it.", "side-note")); return; }
      const used = usage(project(), def.id), v = cachedValidate(def), family = P.members?.get(def.id);
      const title = el("div", null, "lib-detail-title"); title.append(el("strong", def.name), el("small", (def.prefix || "") + (def.value ? " · " + def.value : "")));
      if (family) title.append(el("small", family.name + " › " + family.part));
      detail.append(title);
      globalThis.AtriumCatalogue?.preview(detail, def, {title: false, params: false, pins: true});
      const {acts, act} = detailActions(), kind = currentKind();
      act("Place on sheet", "Place the symbol", () => place(def, "schematic"), !def.symbol, kind === "schematic" && def.symbol ? "Enter" : "");
      act("Place on board", "Place the footprint", () => place(def, "pcb"), !def.footprint, kind === "pcb" && def.footprint ? "Enter" : "");
      act(def.symbol ? "Edit symbol" : "Create symbol", "Graphical symbol editor", () => editSelected(def.id, "schematic"), false, "E");
      act(def.footprint ? "Edit footprint" : "Create footprint", "Graphical footprint editor", () => editSelected(def.id, "pcb"), false, "Shift+E");
      if (globalThis.AtriumLibraryFamiliesUI) {
        const openAttach = variant => {
          const live = project().library.find(d => d.id === def.id);
          if (live) AtriumLibraryFamiliesUI.attach(P.ctx, live, {variant, done: id => { P.selected = id; render(); }});
        };
        if (def.symbol && def.footprint) act("Add package…", "Create another package for this chip using an existing footprint", () => openAttach(true));
        else if (def.symbol || def.footprint) {
          const other = def.symbol ? "footprint" : "symbol";
          act("Attach " + other + "…", "Use an existing " + other + " from this project's library", () => openAttach(false));
        }
        act(family ? "Edit family…" : "Group component…", "Manage this component's family and chip", () => manageFamilies(def.id));
      }
      if (def.footprint?.wizard) act("Wizard", "Re-open in the IPC footprint wizard", () => openWizard(P.ctx, def));
      act("Duplicate", "Duplicate", () => run(() => { const c = duplicate(project(), def); P.selected = c.id; }, "Duplicated " + def.name), false, "Mod+D");
      const older = similar(project(), def);
      act("Update parts", "Re-sync placed parts with this definition" + (older.length ? "; choose which of " + older.length + " linked older copies to retarget" : ""), () => {
        const go = ids => run(() => {
          const r = updateParts(project(), def, {sources: ids});
          P.ctx.info?.("Updated " + r.parts + " part(s): " + r.retargeted + " retargeted, " + r.rewired + " wire end(s) followed moved pins, " + (r.stubs ? r.stubs + " stub(s) kept connections, " : "") +
            r.dropped + " stale pin net(s) cleared" + (r.disconnected.length ? " · ⚠ now unconnected: " + r.disconnected.slice(0, 8).join(", ") : "") + ".");
        }, null);
        if (!older.length) { go([]); return; }
        chooseCopies(def, older, go);
      });
      const status = libraryStatus(def, P.libraries, project());
      if (status?.src && !status.same) act(status.pending ? "Compare with library…" : status.libraryChanged ? "Update from library •" : "Update from library",
        status.pending ? "Read this revision and compare the project copy" : stateText(status) + ". Review the symbol and pad overlays first",
        () => reviewUpdates([{def, lib: status.lib, src: status.src}]));
      act("Save to library…", "Store this definition in a library file (shows the differences first)", () => saveToLibraryDialog(P.ctx, def, () => render()));
      if (globalThis.AtriumHost?.chooseLibraryFolder || globalThis.showDirectoryPicker) {
        act("Save to folder…", "Save this component to a library folder", () => folderUI(u => u.saveToFolder(P.ctx, def, () => render())));
      }
      act("Delete", used.length ? "Placed " + used.length + " time(s): delete or replace those parts first" : "Delete", () => {
        try { run(() => remove(project(), def.id), def.name + " deleted"); P.selected = null; } catch (e) { P.ctx.info?.(e.message); }
      }, used.length > 0, used.length ? "" : "Backspace").dataset.variant = "danger";
      detail.append(acts);
      const dl = el("dl", null, "lib-facts");
      const f = facts(def);
      const add = (k, val) => { if (val === "" || val == null) return; dl.append(el("dt", k), el("dd", String(val))); };
      add("Footprint", f.pkg); add("Pins / pads", (f.pins || "–") + " / " + (f.pads || "–")); add("Height", f.height ? f.height + " mm" : "");
      add("Placed", used.length ? [...new Set(used.map(u => u.item.ref))].slice(0, 10).join(", ") : "not placed");
      if (def.symbol?.parts > 1) add("Gates", def.symbol.parts + (def.symbol.alternate ? " + De Morgan" : ""));
      for (const [k, val] of Object.entries(f.params).slice(0, 12)) add(k, val);
      detail.append(dl);
      for (const e of v.errors) detail.append(el("p", e, "lib-error"));
      for (const w of v.warnings.slice(0, 5)) detail.append(el("p", w, "lib-warning"));
    }
    function libraryDetail(lib) {
      const row = P.selected && sourceEntry(lib, {id: P.selected});
      const def = P.detailBody?.row === row && P.detailBody.lib === lib ? P.detailBody.def : row;
      const head = el("div", null, "lib-detail-title"); head.append(el("strong", lib.name), el("small", (lib.kind === "group" ? "Local group copy" : lib.path || "library file") + " · " + lib.defs.length + " components"));
      if (lib.kind === "group") detail.append(ui.button("Group library…", () => groupUI(u => u.dialog(P.ctx, lib.id)), "lib-mini"));
      if (!def) {
        detail.append(head);
        if (lib.kind === "folder") folderUI(u => u.folderDetail(P.ctx, detail, lib, {done: () => render()}));
        detail.append(el("p", "Select a library component to add it to the project or place it.", "side-note")); return;
      }
      if (def.stub) {
        detail.append(el("div", null, "lib-detail-title"), el("p", "Reading " + def.name + "…", "side-note"));
        detail.firstChild.append(el("strong", def.name), el("small", lib.name));
        if (P.detailRead?.row !== row || P.detailRead.lib !== lib) {
          const current = guard(lib), request = P.detailRead = {row, lib};
          globalThis.AtriumLibrarySources.load(lib, def.id).then(full => {
            if (P.detailRead !== request || !current()) return;
            P.detailRead = null; P.detailBody = {row, lib, def: full}; renderDetail();
          }, e => {
            if (P.detailRead !== request || !current()) return;
            P.detailRead = null; detail.lastChild.textContent = e.message; detail.lastChild.className = "lib-error";
          });
        }
        return;
      }
      const title = el("div", null, "lib-detail-title"), family = P.members?.get(def.id);
      title.append(el("strong", def.name), el("small", lib.name + (def.value ? " · " + def.value : "")));
      if (family) title.append(el("small", family.name + " › " + family.part));
      detail.append(title);
      globalThis.AtriumCatalogue?.preview(detail, def, {title: false, params: false, pins: true});
      const {acts, act} = detailActions(), kind = currentKind();
      const linked = project().library.filter(d => linksEntry(lib, d.libraryRef, def.id));
      act("Add to project", linked.length ? "Already in the project" : "Copy into this project's library", () => ensureFromSource(lib, def), linked.length > 0);
      act("Place on sheet", "Add to the project if needed and place the symbol", () => placeFromSource(lib, def, "schematic"), !def.symbol, kind === "schematic" && def.symbol ? "Enter" : "");
      act("Place on board", "Add to the project if needed and place the footprint", () => placeFromSource(lib, def, "pcb"), !def.footprint, kind === "pcb" && def.footprint ? "Enter" : "");
      if (linked[0]) {
        const changes = diffDefs(linked[0], def);
        if (!changes.length && !libraryStatus(linked[0], [lib], project())?.same) changes.push("Component metadata changed");
        act(changes.length ? "Update project (" + changes.length + ")" : "Up to date", "Show the differences and update the project's copy",
          () => reviewUpdates([{def: linked[0], lib, src: def}]), !changes.length);
      }
      detail.append(acts);
      const dl = el("dl", null, "lib-facts"), f = facts(def);
      const add = (k, val) => { if (val === "" || val == null) return; dl.append(el("dt", k), el("dd", String(val))); };
      add("Footprint", f.pkg); add("Pins / pads", (f.pins || "–") + " / " + (f.pads || "–")); add("In project", linked.length ? "yes" : "no");
      for (const [k, val] of Object.entries(f.params).slice(0, 12)) add(k, val);
      detail.append(dl);
    }
    // Gate and De Morgan switch for a selected multi-gate part.
    function renderGate() {
      gateBar.replaceChildren(); gateBar.hidden = true;
      const ids = P.ctx.selection?.() || [];
      if (ids.length !== 1) return;
      const p = project();
      let item = null;
      for (const d of p.documents) { item = d.items.find(i => i.id === ids[0]); if (item) break; }
      const def = item?.kind === "part" && p.library.find(d => d.id === item.def);
      const sym = def?.symbol;
      if (!sym || !((sym.parts || 1) > 1 || sym.alternate)) return;
      gateBar.hidden = false;
      gateBar.append(el("span", item.ref + " gate"));
      for (let g = 1; g <= (sym.parts || 1); g++) {
        const b = ui.button(String.fromCharCode(64 + g), () => run(() => { item.unit = g; delete item.part; }, item.ref + " now shows gate " + String.fromCharCode(64 + g)), "lib-chip");
        b.setAttribute("aria-pressed", String((item.unit || item.part || 1) === g)); gateBar.append(b);
      }
      if (sym.alternate) { const b = ui.button("De Morgan", () => run(() => { item.alt = !item.alt; if (!item.alt) delete item.alt; }, null), "lib-chip"); b.setAttribute("aria-pressed", String(!!item.alt)); gateBar.append(b); }
    }
    // Library status of project copies, once per full render (hashes only, no geometry walk).
    function statusOf(def) {
      if (!def.libraryRef || !P.libraries) return null;
      const version = undo()?.definitionVersion?.(def), lib = P.libraries.find(l => l.id === def.libraryRef.library && (!def.libraryRef.groupRevision || l.kind === "group"));
      const source = lib ? sourceEntry(lib, def.libraryRef) : null;
      const key = lib?.kind === "group" ? lib.revisionKeys.get(def.libraryRef.id) : source;
      const cache = P.statusCache ||= new WeakMap(), old = cache.get(def);
      if (old && old.version === version && old.key === key && old.lib === lib &&
          (lib || old.registry === P.libraries)) return old.result;
      const s = libraryStatus(def, P.libraries, project());
      const result = !s || s.pending || s.state === "current" ? null : s.missing ? {state: "missing", ref: def.libraryRef} : s;
      cache.set(def, {version, lib, key, registry: P.libraries, result});
      return result;
    }
    function renderNotice() {
      const focusStop = notice.contains(document.activeElement) && document.activeElement?.tagName === "BUTTON";
      notice.replaceChildren(); notice.hidden = true;
      if (P.lib) {
        if (P.lib.kind === "folder") globalThis.AtriumLibrarySourcesUI?.sourceNotice(notice, P.lib, focusStop);
        return;
      }
      const due = project().library.filter(d => !d.mirrorOf && ["update", "diverged"].includes(statusOf(d)?.state));
      if (!due.length) return;
      notice.hidden = false;
      notice.append(el("span", due.length + " component" + (due.length === 1 ? " has a library update" : "s have library updates") + " · "),
        ui.button("Review…", () => reviewUpdates(due.map(d => { const s = statusOf(d); return {def: d, lib: s.lib, src: s.src}; })), "lib-mini"));
    }
    async function reviewUpdates(entries) {
      if (!globalThis.AtriumLibraryDiff) { P.ctx.info?.("The library review is unavailable in this build."); return; }
      const current = guard(null), p = project(), rev = P.ctx.revision?.(), ready = [];
      const isCurrent = () => current() && rev === P.ctx.revision?.() && entries.every(e => {
        const live = libs().find(l => l.id === e.lib.id && l.kind === e.lib.kind);
        if (e.lib.kind === "group") return live?.revisionKeys?.get(e.src.id) === e.lib.revisionKeys?.get(e.src.id);
        return e.lib === live;
      });
      try {
        for (const e of entries) {
          if (!isCurrent()) return;
          const full = e.src.stub ? await globalThis.AtriumLibrarySources.load(e.lib, e.src.id) : e.src;
          if (!isCurrent()) return;
          if (!libraryStatus(e.def, [e.lib], p)?.same) ready.push({...e, src: full});
        }
        AtriumLibraryDiff.review(P.ctx, ready, {current: isCurrent, done: () => render()});
      } catch (e) { if (current()) P.ctx.info?.(e.message); }
    }
    function run(fn, message) { try { P.ctx.edit(fn); if (message) P.ctx.info?.(message); render(); } catch (e) { P.ctx.info?.(e.message); } }
    const dropReceiver = () => globalThis.AtriumPrefs?.get("butter.drop") === true;
    // Double-click, Enter and drag place; E edits. A library-file entry joins the project first.
    const kindFor = def => currentKind() === "pcb" && def.footprint ? "pcb" : def.symbol ? "schematic" : "pcb";
    function placeEntry(lib, def, kind = kindFor(def)) { if (lib) placeFromSource(lib, def, kind); else place(def, kind); }
    // Drag a row onto the canvas: placement starts when the pointer reaches it, so the real part follows the
    // pointer (Space rotates, X/Y mirror) and the release places it. Releasing elsewhere cancels, including the
    // project entry a library-file component got for the placement.
    function dragPlace(e, def, r) {
      if (e.button !== 0 || e.pointerType === "touch" || r.draggable) return;
      const host = globalThis.AtriumNavHost, lib = P.lib, id = e.pointerId, start = [e.clientX, e.clientY];
      let lifted = false, placing = false, full = null, at = null, added = null;
      const onCanvas = ev => !!host?.canvas?.() && document.elementFromPoint(ev.clientX, ev.clientY) === host.canvas();
      const listen = on => { for (const [type, fn] of [["pointermove", move], ["pointerup", up], ["pointercancel", cancel], ["keydown", key]]) (on ? addEventListener : removeEventListener)(type, fn, true); };
      const end = () => { listen(false); lifted && globalThis.AtriumSpatialMotion?.settle(r); lifted = false; };
      function begin(activate = false) {
        if (placing || !full || !at || !host.canvasAt?.(at[0], at[1], activate)) return false;
        placing = true;
        const before = host.revision();
        placeEntry(lib, full, currentKind());
        if (host.revision() !== before) added = host.revision();
        return true;
      }
      function abandon() {
        if (placing && host.placing?.()) host.act("select");
        if (added != null && host.revision() === added) host.act("undo");
      }
      function move(ev) {
        if (ev.pointerId !== id) return;
        if (!lifted) {
          if (Math.hypot(ev.clientX - start[0], ev.clientY - start[1]) < 4) return;
          lifted = true; select(def.id, r); globalThis.AtriumSpatialMotion?.lift(r);
          // A library-file entry may still be a stub: load it now so placement can start on arrival.
          const ready = lib && def.stub ? globalThis.AtriumLibrarySources.load(lib, def.id) : Promise.resolve(def);
          ready.then(d => { if (lifted) { full = d; begin(); } }, error => { end(); P.ctx.info?.(error.message); });
        }
        at = [ev.clientX, ev.clientY];
        if (!placing) begin();
      }
      function up(ev) {
        if (ev.pointerId !== id) return;
        end();
        if (placing && !host.placing?.()) return abandon(); // Escape during the drag cancelled it
        if (placing && onCanvas(ev)) return void host.placeAt(ev.clientX, ev.clientY);
        // Released over another split pane (or nowhere): that pane becomes active and the part lands there.
        abandon(); placing = false; added = null; at = [ev.clientX, ev.clientY];
        if (begin(true) && host.placing?.()) host.placeAt(ev.clientX, ev.clientY);
      }
      function cancel(ev) { if (ev.pointerId === id) { end(); abandon(); } }
      function key(ev) { if (ev.key === "Escape" && !placing) end(); }
      listen(true);
    }
    function place(def, kind) { if (P.ctx.placeDef) P.ctx.placeDef(def, kind); else P.ctx.info?.("Placement is unavailable in this build."); }
    function editSelected(id, kind) {
      const def = project().library.find(d => d.id === id);
      if (def && !P.lib) (kind === "pcb" || (!kind && !def.symbol && def.footprint) ? openFootprintEditor : openSymbolEditor)(P.ctx, def);
    }
    function manageFamilies(initial) {
      globalThis.AtriumLibraryFamiliesUI?.manage(P.ctx, {initial, done: id => { P.selected = id; render(); }});
    }
    function ensureFromSource(lib, def) {
      if (def.stub) {
        const current = guard(lib, true);
        globalThis.AtriumLibrarySources.load(lib, def.id).then(full => { if (current()) ensureFromSource(lib, full); }, e => { if (current()) P.ctx.info?.(e.message); });
        return null;
      }
      const p = project(), linked = p.library.find(d => linksEntry(lib, d.libraryRef, def.id));
      if (linked) return linked;
      let exact;
      run(() => { exact = addFromLibrary(lib, def, p); }, def.name + " added to the project from " + lib.name);
      return exact;
    }
    function placeFromSource(lib, def, kind) {
      if (def.stub) {
        const current = guard(lib, true);
        globalThis.AtriumLibrarySources.load(lib, def.id).then(full => { if (current()) placeFromSource(lib, full, kind); }, e => { if (current()) P.ctx.info?.(e.message); });
        return;
      }
      if (!A.geometries(def, kind)) return;
      const exact = ensureFromSource(lib, def);
      if (exact) place(exact, kind);
    }
    const documentKind = () => P.ctx.documentKind?.() || P.ctx.doc?.kind || "schematic";
    const currentKind = () => documentKind() === "pcb" ? "pcb" : "schematic";
    let hintsKind;
    function updateToolHints() {
      hintsKind = documentKind();
      const hint = (button, action, text) => ui.shortcut(button, text, AtriumKeymap.hintKey(action, hintsKind), " from the design canvas");
      hint(close, "library-panel", "Close the Library panel");
      hint(wizard, "footprint-wizard", "IPC-7351B footprint wizard");
    }
    const offKeys = AtriumKeymap.onChange(() => { if (visible()) updateToolHints(); });
    const visibleRows = () => globalThis.AtriumCatalogue?.visibleRows(list) || [...list.querySelectorAll(".lib-row")];
    function focusRow(row) {
      if (row?.matches(".lib-row")) select(row.dataset.def, row);
      row?.focus(); row?.scrollIntoView?.({block: "nearest"});
    }
    search.oninput = () => { cancelIntent(); P.selected = null; render(); };
    node.addEventListener("keydown", e => {
      if (e.key === "Escape") { cancelIntent(); select(null); return; }
      if (e.key !== "Tab" || e.metaKey || e.ctrlKey || e.altKey) return;
      const first = detail.querySelector(".cat-pv-pins > summary, .lib-detail-actions button:not(:disabled)");
      const selected = visibleRows().find(r => r.dataset.def === P.selected && r.closest(".cat-family-packages"));
      if (!first || !selected) return;
      const [from, to] = e.shiftKey ? [first, selected] : [selected, first];
      if (e.target === from) { e.preventDefault(); to.focus(); }
    });
    list.addEventListener("keydown", e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const rows = visibleRows(), index = e.target === list ? rows.findIndex(r => r.dataset.def === P.selected) : rows.indexOf(e.target);
        if (e.key === "ArrowUp" && index <= 0) search.focus();
        else focusRow(rows[Math.min(rows.length - 1, index + (e.key === "ArrowDown" ? 1 : -1))]);
        return;
      }
      if (e.target !== list && !e.target.matches(".lib-row")) return;
      const id = e.target.dataset.def || P.selected;
      if (e.target === list && !visibleRows().some(r => r.dataset.def === id)) return;
      // A library-file view acts on the file's entries, never on a project def that shares an id.
      const lib = P.lib;
      if (lib) {
        if (e.key === "Enter") { e.preventDefault(); const d = lib.defs.find(def => def.id === id); if (d) placeFromSource(lib, d, currentKind()); }
        else if (e.key === "Delete" || e.key === "Backspace" || e.key === "e" || e.key === "E") { e.preventDefault(); P.ctx.info?.("Library file entries are read-only here. Add the component to the project to edit it."); }
        return;
      }
      const def = project().library.find(d => d.id === id);
      if (!def) return;
      else if (e.key === "Enter") { e.preventDefault(); place(def, currentKind()); }
      else if (e.key === "e" || e.key === "E") { e.preventDefault(); editSelected(id, e.shiftKey ? "pcb" : "schematic"); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") { e.preventDefault(); run(() => { P.selected = duplicate(project(), def).id; }, "Duplicated " + def.name); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); try { run(() => remove(project(), def.id), def.name + " deleted"); } catch (err) { P.ctx.info?.(err.message); } }
    });
    search.addEventListener("keydown", e => { if (e.key === "ArrowDown") { e.preventDefault(); focusRow(visibleRows()[0] || list); } });
    // Follow project edits made elsewhere (undo, imports, other panels) cheaply.
    function check(forceHints = false) {
      checkTimer = 0;
      if (!visible()) return;
      const rev = P.ctx.revision?.() ?? 0, p = project(), lib = p.library;
      const sel = (P.ctx.selection?.() || []).join(",");
      const contextChanged = hintsKind !== documentKind();
      if (forceHints || contextChanged) updateToolHints();
      const prev = P.versions, v = versions(p);
      const sameScope = prev && v && prev.floor === v.floor && prev.library === v.library && prev.assembly === v.assembly &&
        prev.project === v.project && P.familyVersion === undo()?.familyVersion?.();
      if (needsRender || p !== P.lastProject || lib !== P.lastLibrary || rev !== P.lastRevision && !sameScope) render();
      else {
        P.lastRevision = rev;
        if (v) P.versions = v;
        if (contextChanged) renderDetail();
        if (sel !== P.lastSel) { P.lastSel = sel; renderGate(); }
      }
    }
    function scheduleCheck() { if (showing && !node.hidden && !checkTimer) checkTimer = setTimeout(check, 0); }
    const N = globalThis.AtriumNavHost;
    const offs = typeof N?.on === "function" ? ["change", "document", "selection"].map(t => N.on(t, scheduleCheck)) : null;
    function stop() {
      cancelIntent();
      if (globalThis.AtriumCatalogue?.cancelPreview(detail)) needsRender = true;
      clearTimeout(checkTimer); checkTimer = 0;
      clearInterval(tick); tick = 0;
    }
    function visibilityChanged() {
      if (!node.isConnected) { dispose(); return; }
      const on = visible();
      if (on && !P.groupRestored) {
        P.groupRestored = true;
        try { if (globalThis.localStorage?.getItem("atrium.group-library.v1")) groupUI(u => u.restore()); } catch { /* opened explicitly when storage is unavailable */ }
      }
      if (on !== showing) {
        showing = on;
        if (!on) { stop(); return; }
        folderUI(u => { if (!visible()) return; render(); u.restore(P.lib?.folder ? [P.lib.folder] :
          project().library.map(d => d.libraryRef?.library).filter(Boolean)); }, true);
        check(true);
        if (!offs) tick = setInterval(check, 500); // Hosts without editor events, while the panel is shown.
      }
      // The dock reveals a reopened tab after its hidden attribute changes.
      if (on && focusOnShow) { focusOnShow = false; search.focus(); }
    }
    const resize = globalThis.ResizeObserver && new ResizeObserver(visibilityChanged);
    resize?.observe(node);
    const offPower = globalThis.AtriumPower?.onChange?.(visibilityChanged);
    document.addEventListener("visibilitychange", visibilityChanged);
    const sourceStorage = e => { if (e.key === SOURCES || e.key == null) render(); };
    globalThis.addEventListener?.("storage", sourceStorage);
    function dispose() {
      stop();
      resize?.disconnect(); offPower?.(); offKeys(); offs?.forEach(off => off?.()); P.folderSub?.(); P.groupSub?.();
      document.removeEventListener("visibilitychange", visibilityChanged);
      globalThis.removeEventListener?.("storage", sourceStorage);
    }
    P.reveal = (def, source) => {
      P.source = source?.id || "project"; P.filter = "all"; search.value = def.name || def.id;
      render(); select(def.id);
      list.querySelector('[aria-pressed="true"]')?.scrollIntoView?.({block:"nearest"});
    };
    P.render = render; P.search = search; P.dispose = dispose;
    P.folderProgress = id => { if (P.lib?.folder === id && visible()) renderNotice(); };
    P.toggled = open => { focusOnShow = open; visibilityChanged(); };
    P.focusSearch = () => { focusOnShow = true; visibilityChanged(); if (document.activeElement === search) search.select?.(); };
    panel = P;
    visibilityChanged();
    return P;
  }
  function groupUI(fn) {
    const ready = globalThis.AtriumGroupLibraryUI ? Promise.resolve(globalThis.AtriumGroupLibraryUI) : globalThis.AtriumLazy?.need("AtriumGroupLibraryUI");
    ready?.then(u => {
      if (panel && !panel.groupSub) panel.groupSub = globalThis.AtriumGroupLocal.onChange((_id, _added, _from, installed) => { if (installed !== false) panel?.render?.(); });
      return fn(u);
    }).catch(e => panel?.ctx?.info?.(e.message));
  }
  // Folder libraries and KiCad import (library-sources.js, library-sources-ui.js): loaded on first use, or at
  // panel start when folders are registered (onlyIfUsed).
  function folderUI(fn, onlyIfUsed = false) {
    if (onlyIfUsed) { let used = false; try { used = (globalThis.localStorage?.getItem("atrium.library-folders.v1") || "[]") !== "[]"; } catch { /* storage blocked */ } if (!used) return; }
    const go = () => {
      // Scans and removals re-render the panel (it defers while hidden).
      if (panel && !panel.folderSub) panel.folderSub = globalThis.AtriumLibrarySources.onChange((kind, id) =>
        kind === "progress" ? panel?.folderProgress?.(id) : panel?.render?.());
      try { fn(globalThis.AtriumLibrarySourcesUI); } catch (e) { panel?.ctx?.info?.(e.message); }
    };
    if (globalThis.AtriumLibrarySourcesUI) go();
    else if (globalThis.AtriumLazy) AtriumLazy.need("AtriumLibrarySourcesUI").then(go, e => panel?.ctx?.info?.(e.message));
    else panel?.ctx?.info?.("Library folders are unavailable in this build.");
  }
  // Older copies linked by provenance; none is retargeted unless ticked.
  function chooseCopies(def, older, done) {
    const d = ui.dialog("Update parts from " + def.name, "lib-small"), box = ui.el("div", null, "lib-diff"), picks = new Map();
    box.append(ui.el("p", "Placed parts of " + def.name + " are re-synced. Parts placed from these linked copies can also be moved to " + def.name + ":", "fe-note"));
    for (const o of older) {
      const l = ui.el("label", null, "fw-check"), c = ui.el("input"); c.type = "checkbox"; picks.set(o.id, c);
      l.append(c, ui.el("span", o.name + (o.value ? " · " + o.value : "") + (o.libraryRef ? " (from " + (o.libraryRef.name || "library") + ")" : o.sourceName ? " (" + o.sourceName + ")" : "")));
      box.append(l);
    }
    const foot = ui.el("div", null, "lib-actions");
    foot.append(ui.button("Cancel", () => d.close()), ui.button("Update", () => {
      d.close(); done(older.filter(o => picks.get(o.id).checked).map(o => o.id));
    }, null, "primary"));
    d.append(box, foot); ui.show(d);
  }
  // ------------------------------------------------------------------ status and health
  const STATE_MARK = {update: "●", edited: "✎", diverged: "◆", missing: "○"};
  const STATE_TONE = {update: "accent", diverged: "warning"};
  function stateText(s) {
    const revs = "rev " + s.fromRev + (s.toRev !== s.fromRev ? " → rev " + s.toRev : "");
    if (s.state === "missing") return "Library " + (s.ref?.name || "source") + " is not registered on this computer. The project copy still works.";
    if (s.state === "update") return "Update available from " + s.lib.name + " (" + revs + ")";
    if (s.state === "edited") return "Edited in this project since it came from " + s.lib.name + " (" + revs + ")";
    if (s.state === "diverged") return "Changed here and in " + s.lib.name + " (" + revs + ")";
    return "Same as " + s.lib.name;
  }
  // Library › Check: health checks of the project library or a library source (AtriumLibraryStore.health).
  function checkLibrary(ctx, lib, checked) {
    const S = globalThis.AtriumLibraryStore;
    if (!S) { ctx.info?.("Library checks are unavailable in this build."); return null; }
    const project = ctx.currentProject ? ctx.currentProject() : ctx.project;
    if (lib?.kind === "folder" && !checked && lib.defs.some(d => d.stub)) {
      const d = ui.dialog("Check " + lib.name, "lib-small"), line = ui.el("p", "", "fe-note");
      const actions = ui.el("div", null, "lib-actions"); actions.append(ui.button("Cancel", () => d.close()));
      line.setAttribute("role", "status"); d.append(line, actions); ui.show(d);
      const source = globalThis.AtriumLibrarySources;
      const current = () => d.open && (!ctx.currentProject || ctx.currentProject() === project) &&
        (!panel || panel.lib === lib && !panel.node.hidden) && source.library(lib.folder) === lib;
      const rows = lib.defs, checked = new Map();
      // A duplicate-name check needs a content hash only for a repeated name/package.
      const seen = new Set(), repeated = new Set(), key = row => JSON.stringify([row.name?.trim().toLowerCase(), row.footprint?.name || row.package || ""]);
      for (const row of rows) { const k = key(row); if (seen.has(k)) repeated.add(k); seen.add(k); }
      (async () => {
        let last = -Infinity;
        for (let i = 0; i < rows.length && current(); i++) {
          if (performance.now() - last > 12) {
            line.textContent = "Checking " + i + " of " + rows.length + " components…";
            await new Promise(resolve => setTimeout(resolve, 0)); last = performance.now();
          }
          if (!current()) break;
          const row = rows[i];
          try {
            const full = await source.load(lib, row.id);
            checked.set(row.id, {issues: S.health([full]).issues, hash: repeated.has(key(row)) ? S.contentHash(full) : null});
          } catch (e) {
            checked.set(row.id, {issues: [{level: "error", code: "unavailable", def: row.id, name: row.name, message: e.message}]});
          }
        }
        const show = current(); if (d.open) d.close();
        if (show) checkLibrary(ctx, lib, checked);
      })().catch(e => { if (d.open) d.close(); ctx.info?.(e.message); });
      return d;
    }
    const r = S.health(lib ? lib.defs : project.library, lib ? {checked} : {project});
    const d = ui.dialog("Check " + (lib ? lib.name : "project library"), "lib-small"), box = ui.el("div", null, "lib-diff");
    box.append(ui.el("p", r.counts.error + " error(s), " + r.counts.warning + " warning(s), " + r.counts.info + " note(s) in " + (lib ? lib.defs : project.library).filter(x => !x.mirrorOf).length + " components.", "fe-note"));
    const t = ui.el("table", null, "se-table");
    for (const x of r.issues.slice(0, 500)) {
      const tr = ui.el("tr", null, "lib-health-" + x.level);
      const name = ui.el("td");
      if (x.def && !lib) name.append(ui.button(x.name, () => { d.close(); if (panel) { panel.source = "project"; panel.selected = x.def; panel.render?.(); } }, "lib-mini")); else name.append(ui.el("span", x.name));
      tr.append(ui.el("td", x.level), name, ui.el("td", x.message)); t.append(tr);
    }
    if (r.issues.length) box.append(t); else box.append(ui.el("p", "No issues found.", "fe-note"));
    const foot = ui.el("div", null, "lib-actions");
    if (!lib && r.issues.some(x => x.code === "inline-3d" || x.code === "unused-3d") && S.hoistAll) foot.append(ui.button("Store 3D models once", () => {
      let out; try { ctx.edit(() => { out = S.hoistAll(project); out.pruned = S.pruneBlobs(project); }, "Store 3D models once"); } catch (e) { ctx.info?.(e.message); return; }
      d.close(); ctx.info?.(out.models + " 3D model(s) now stored once" + (out.saved ? " · " + Math.round(out.saved / 1024) + " KB of duplicates removed" : "") + (out.pruned ? " · " + out.pruned + " unused removed" : ""));
    }));
    foot.append(ui.button("Close", () => d.close(), null, "primary"));
    d.append(box, foot); ui.show(d);
    return r;
  }
  // ------------------------------------------------------------------ library file dialogs
  function showDiff(title, changes, apply, applyLabel = "Apply") {
    const d = ui.dialog(title, "lib-small");
    const box = ui.el("div", null, "lib-diff");
    if (!changes.length) box.append(ui.el("p", "No differences.", "fe-note"));
    else { const ul = ui.el("ul"); for (const c of changes.slice(0, 400)) ul.append(ui.el("li", c)); box.append(ul); if (changes.length > 400) box.append(ui.el("p", (changes.length - 400) + " more…", "fe-note")); }
    const foot = ui.el("div", null, "lib-actions");
    foot.append(ui.button("Cancel", () => d.close()), ui.button(applyLabel, () => { d.close(); apply(); }, null, "primary"));
    d.append(box, foot); ui.show(d);
    return d;
  }
  async function readPortable(f,{signal}={}) {
    const bytes = typeof f.bytes === "function" ? await f.bytes() : f.bytes || new Uint8Array(await f.arrayBuffer());
    const client = globalThis.AtriumTranslatorClient || await AtriumLazy.need("AtriumTranslatorClient");
    const r = await client.import([{name:f.name,bytes}],{translator:"waffle-library",signal});
    const projection = globalThis.AtriumTranslatorProvenance || await AtriumLazy.need("AtriumTranslatorProvenance");
    // Registered portable files retain their draft metadata and per-asset licence notices.
    const model = projection.toLegacy(r.model,r.provenance);
    return {result:r,read:{...r.provenance.portableLibrary,defs:model.library,componentFamilies:model.componentFamilies}};
  }
  // Open and reload share this registry projection. Each caller passes its own path.
  function projectOpenedRegistry(lib, read, path) {
    Object.assign(lib, {name: read.name, description: read.description, defs: read.defs, path, modified: false});
    if (read.componentFamilies) lib.componentFamilies = read.componentFamilies; else delete lib.componentFamilies;
    if (read.tombstones) lib.tombstones = read.tombstones; else delete lib.tombstones;
  }
  function reportCurrentSession(session, result, fileName) {
    if (session === globalThis.AtriumNavHost?.fileSession?.()) return globalThis.AtriumNavHost?.showImportReport?.(result,[],[fileName],{adopt:false});
  }
  async function openPortableFiles(files) {
    if (files.length !== 1) throw Error("Open one portable library at a time.");
    return await openLibraryFile(globalThis.AtriumNavHost || {},files[0]);
  }
  async function openLibraryFile(ctx, selected) {
    try {
      const session = globalThis.AtriumNavHost?.fileSession?.(), before = sourceStore.sources();
      const f = selected || await (ctx.pickFile || (() => Promise.resolve(null)))([".atrlib", ".json"]);
      if (!f) return null;
      const {result,read} = await readPortable(f);
      const match = l => read.id ? l.id === read.id : l.path === (f.path || f.name);
      const opened = await writeSources(list => {
        const existing = list.find(match);
        if (!sameSource(existing, before.find(match))) throw changedSource();
        const lib = existing || {id: read.id || A.id(), added: new Date().toISOString()};
        projectOpenedRegistry(lib, read, f.path || f.name);
        if (!existing) list.push(lib);
        storeSources(list);
        ctx.info?.("Opened " + lib.name + ": " + read.defs.length + " component(s)" + (read.warnings.length ? " · " + read.warnings[0] : ""));
        return lib;
      });
      await reportCurrentSession(session, result, f.name);
      return opened;
    } catch (e) { ctx.info?.(e.message); return null; }
  }
  // native-library-reload: desktop builds re-read a library file the user opened before (AtriumHost.readFile).
  // Absolute paths only: /… on macOS and Linux; C:\… or \\server\share\… on Windows.
  const canReload = lib => typeof globalThis.AtriumHost?.readFile === "function" && /^(?:\/|[A-Za-z]:\\|\\\\[^\\?.])/.test(String(lib?.path || ""));
  async function reloadLibraryFile(ctx, lib) {
    const session = globalThis.AtriumNavHost?.fileSession?.();
    try {
      if (!canReload(lib)) throw Error("Open the library file again to refresh it.");
      if (lib.modified && typeof confirm === "function" && !confirm("Reload " + lib.name + " from disk? Unsaved changes to this library are lost.")) return null;
      const f = await globalThis.AtriumHost.readFile(lib.path);
      const {result,read} = await readPortable(f);
      const opened = await writeSources(list => {
        const l = list.find(x => x.id === lib.id);
        if (!sameSource(l, lib)) throw changedSource();
        if (read.id && read.id !== l.id) throw Error("This path now contains a different library. Open it as a separate source.");
        projectOpenedRegistry(l, read, f.path || l.path);
        storeSources(list);
        ctx.info?.("Reloaded " + l.name + ": " + read.defs.length + " component(s)" + (read.warnings.length ? " · " + read.warnings[0] : ""));
        return l;
      });
      await reportCurrentSession(session, result, f.name);
      return opened;
    } catch (e) { ctx.info?.(e.message); return null; }
  }
  async function exportLibrary(ctx, lib) {
    try {
      const {name,id,description,tombstones} = lib, model = A.project(name);
      model.documents = []; model.library = lib.defs;
      if (lib.componentFamilies) model.componentFamilies = lib.componentFamilies;
      const fileName = String(lib.path || name).split(/[\\/]/).pop();
      const snapshot = JSON.stringify(lib);
      const client = globalThis.AtriumTranslatorClient || await AtriumLazy.need("AtriumTranslatorClient");
      const r = await client.export("waffle-library",model,{library:{id,name,description,tombstones,fileName}});
      const f = r.files[0], removed = r.details.removed;
      const ok = !!(await ctx.exportFile?.(f.name,f.text));
      if (ok) await writeSources(list => {
        const entry = list.find(l => l.id === id);
        if (entry?.modified && JSON.stringify(entry) === snapshot) { entry.modified = false; storeSources(list); }
      }).catch(e => ctx.info?.(e.message));
      ctx.info?.(ok ? "Saved " + f.name + (removed.length ? " · left out credential-like fields " + removed.join(", ") : "") : "The library was not saved.");
      return ok;
    } catch (e) { ctx.info?.(e.message); return false; }
  }
  async function saveToLibraryDialog(ctx, def, done) {
    const owner = ctx.currentProject ? ctx.currentProject() : ctx.project, revision = ctx.revision?.();
    const provenance = globalThis.AtriumImportReports?.provenance();
    let portable = def;
    if (provenance?.length) {
      try {
        const projection = globalThis.AtriumTranslatorProvenance || await AtriumLazy.need("AtriumTranslatorProvenance");
        if (ctx.currentProject && ctx.currentProject() !== owner || revision !== ctx.revision?.()) return;
        portable = projection.toLegacy({documents:[],library:[def]},provenance).library[0];
      } catch (e) { ctx.info?.(e.message); return; }
    }
    const list = sourceStore.list();
    const d = ui.dialog("Save " + def.name + " to a library", "lib-small");
    const sel = ui.el("select"); sel.setAttribute("aria-label", "Target library");
    for (const l of list) sel.add(new Option(l.name + " (" + l.defs.length + ")", l.id));
    sel.add(new Option("New library…", "@new"));
    if (def.libraryRef && list.some(l => l.id === def.libraryRef.library)) sel.value = def.libraryRef.library;
    const name = ui.el("input"); name.placeholder = "Library name"; name.setAttribute("aria-label", "New library name"); name.value = "My parts";
    const box = ui.el("div", null, "lib-diff");
    const message = ui.el("p", null, "lib-error"); message.setAttribute("role", "status");
    let reviewed;
    const target = () => sel.value === "@new" ? null : sourceStore.sources().find(l => l.id === sel.value);
    function show() {
      name.hidden = sel.value !== "@new"; box.replaceChildren();
      const lib = target(), ref = def.libraryRef, old = lib?.defs.find(x => x.id === (sameLibrary(lib, ref) ? ref.id : def.id));
      reviewed = lib;
      const changes = old ? diffDefs(old, portable) : ["new entry " + def.name];
      const ul = ui.el("ul"); for (const c of changes.slice(0, 300)) ul.append(ui.el("li", c)); box.append(ui.el("p", old ? "Changes to the library's copy:" : "Adds a new entry:", "fe-note"), ul);
    }
    sel.onchange = show;
    const foot = ui.el("div", null, "lib-actions");
    const go = ui.button("Save and export .atrlib", async () => {
      go.disabled = true;
      try {
        const lib = await writeSources(all => {
          if (!d.open || ctx.currentProject && ctx.currentProject() !== owner || revision !== ctx.revision?.() ||
              owner.library.find(x => x.id === def.id) !== def) throw Error("The project changed. Reopen Save to library for the current component.");
          const create = sel.value === "@new";
          let lib = create ? null : all.find(l => l.id === sel.value);
          if (!create && (!lib || !sameSource(lib, reviewed))) { show(); throw changedSource(); }
          if (create) { lib = {id: A.id(), name: name.value.trim() || "Library", description: "", defs: [], path: "", added: new Date().toISOString()}; all.push(lib); }
          let saved = false;
          ctx.edit(() => {
            saveToLibrary(lib, def, owner, portable);
            lib.modified = true; storeSources(all); saved = true;
          });
          return saved ? lib : null;
        });
        if (!lib) return;
        d.close(); await exportLibrary(ctx, lib); done?.();
      } catch (e) { message.textContent = e.message; }
      finally { go.disabled = false; }
    });
    go.dataset.variant = "primary";
    foot.append(ui.button("Cancel", () => d.close()), go);
    d.append(ui.label("Library", sel), name, box, message, foot); ui.show(d); show();
  }
  // Settings → Library sources: the library files this browser knows, with their paths.
  function manageLibraries(ctx, done) {
    const d = ui.dialog("Library sources", "lib-small");
    const body = ui.el("div", null, "lib-sources");
    function render() {
      body.replaceChildren();
      const list = sourceStore.list();
      if (!list.length) body.append(ui.el("p", "No library files yet. Open a .atrlib file, or use Save to library on a project component.", "fe-note"));
      const table = ui.el("table", null, "se-table");
      const head = ui.el("tr"); for (const t of ["Library", "Path", "Parts", ""]) head.append(ui.el("th", t)); table.append(head);
      for (const l of list) {
        const tr = ui.el("tr");
        tr.append(ui.el("td", l.name + (l.modified ? " •" : "")), ui.el("td", l.path || "(not saved)"), ui.el("td", String(l.defs.length)));
        const td = ui.el("td");
        if (canReload(l)) td.append(ui.button("Reload", () => reloadLibraryFile(ctx, l).then(() => { render(); done?.(); }), "lib-mini")); // native-library-reload-button
        td.append(ui.button("Save…", () => exportLibrary(ctx, l).then(render), "lib-mini"), ui.button("Remove", () => writeSources(list => {
          const i = list.findIndex(x => x.id === l.id);
          if (!sameSource(list[i], l)) throw changedSource();
          list.splice(i, 1); storeSources(list); render(); done?.();
        }).catch(e => ctx.info?.(e.message)), "lib-mini"));
        tr.append(td); table.append(tr);
      }
      if (list.length) body.append(table);
      body.append(ui.el("p", "Each source keeps its file name or path and a copy of its components in this browser. Re-open a file to refresh it after it changes on disk. Library files never store API keys, tokens or passwords.", "fe-note"));
    }
    const foot = ui.el("div", null, "lib-actions");
    foot.append(ui.button("Open library file…", () => openLibraryFile(ctx).then(() => { render(); done?.(); })),
      ui.button("New empty library", () => writeSources(list => {
        list.push({id: A.id(), name: AtriumLibrary.uniqueName({library: list}, "New library"), defs: [], path: "", added: new Date().toISOString(), modified: true});
        storeSources(list); render(); done?.();
      }).catch(e => ctx.info?.(e.message))),
      ui.button("Done", () => d.close(), null, "primary"));
    if (globalThis.AtriumHost?.chooseLibraryFolder || globalThis.showDirectoryPicker) {
      foot.prepend(ui.button("KiCad 3D model folders…", () => folderUI(u => u.modelFolders())));
    }
    d.append(body, foot); ui.show(d); render();
  }
  function focusPanel(ctx) {
    const p = togglePanel(ctx, true);
    globalThis.AtriumDock?.reveal?.("library");
    p.focusSearch();
    return p;
  }
  function togglePanel(ctx, show) {
    const fresh = !panel?.node?.isConnected, p = mountPanel(ctx);
    const visible = show ?? (fresh || p.node.hidden);
    p.node.hidden = !visible;
    document.body.classList.toggle("library-panel-open", visible);
    if (visible && !globalThis.AtriumDock) document.body.classList.remove("hide-right");
    p.toggled(visible);
    return p;
  }
  // Commit helpers shared by the editors and the wizard.
  function commitDef(ctx, def, o = {}) {
    let report = null;
    const project = ctx.currentProject ? ctx.currentProject() : ctx.project;
    try { ctx.edit(() => { report = replaceDef(project, def, o); }); }
    catch (e) { ctx.info?.(e.message); return null; }
    ctx.info?.(updateMessage(def, report) + (report.warnings.length ? " · " + report.warnings[0] : ""));
    panel?.render?.();
    return report;
  }
  // What a save did to placed parts, including connections it could not keep.
  function updateMessage(def, r) {
    if (r.added) return def.name + " added to the library";
    let m = def.name + " saved";
    if (r.parts) m += " · " + r.parts + " placed part(s) updated" + (r.rewired ? ", " + r.rewired + " wire end(s) followed" : "") + (r.stubs ? ", " + r.stubs + " wire stub(s) added to keep connections" : "");
    if (r.disconnected?.length) m += " · ⚠ now unconnected: " + r.disconnected.slice(0, 8).join(", ") + (r.disconnected.length > 8 ? "…" : "");
    return m;
  }
  function openWizard(ctx, def) {
    return AtriumFootprintWizard.open({spec: def?.footprint?.wizard ? {...def.footprint.wizard, id: def.id} : undefined, info: ctx.info, commit: (made, place, edit) => {
      if (def) {
        made.id = def.id;
        if (def.symbol) { made.symbol = def.symbol; if (def.schDrawing) made.schDrawing = def.schDrawing; else delete made.schDrawing; }
        made.name = def.name === def.footprint?.name ? made.name : def.name;
        for (const k of ["prefix", "value", "category", "parameters", "model3d", "description", "libraryRef"]) if (def[k] != null) made[k] = def[k];
      }
      // "Open in Footprint Editor" commits nothing yet: the editor's Save does, Cancel leaves the library alone.
      if (edit) { openFootprintEditor(ctx, made); return true; }
      if (!commitDef(ctx, made)) return false;
      if (panel) panel.selected = made.id;
      if (place) ctx.placeDef?.(made, "pcb");
      return true;
    }});
  }
  function openFootprintEditor(ctx, def) {
    const project = ctx.currentProject ? ctx.currentProject() : ctx.project, S = globalThis.AtriumLibraryStore;
    if (def && S?.hoisted(def)) def = S.inflate(project, def); // the editor sees and saves STEP text inline
    return AtriumFootprintEditor.open({def, info: ctx.info, library: (ctx.currentProject ? ctx.currentProject() : ctx.project).library, reopenWizard: d => openWizard(ctx, d),
      commit: (made, place) => { if (!commitDef(ctx, made)) return false; if (panel) panel.selected = made.id; if (place) ctx.placeDef?.(made, "pcb"); return true; }});
  }
  function openSymbolEditor(ctx, def) {
    return AtriumSymbolEditor.open({def, info: ctx.info, library: (ctx.currentProject ? ctx.currentProject() : ctx.project).library,
      commit: (made, place) => { if (!commitDef(ctx, made)) return false; if (panel) panel.selected = made.id; if (place) ctx.placeDef?.(made, "schematic"); return true; }});
  }
  // editor.js workflow() modules: the editor passes its context to open(ctx).
  const workflows = {
    "library-panel": {open: ctx => togglePanel(ctx)},
    // Place › Component (P P, P C): the Library panel comes to the front with its search focused, as Altium's Components panel.
    "library-place": {open: ctx => focusPanel(ctx)},
    "library-sources": {open: ctx => manageLibraries(ctx, () => panel?.render?.())},
    "footprint-wizard": {open: ctx => openWizard(ctx)},
    "footprint-editor": {open: ctx => { const sel = selectedDef(ctx); openFootprintEditor(ctx, sel?.footprint ? sel : null); }},
    "symbol-editor": {open: ctx => { const sel = selectedDef(ctx); openSymbolEditor(ctx, sel?.symbol ? sel : null); }},
    "edit-footprint": {open: ctx => { const sel = selectedDef(ctx); if (sel?.footprint) openFootprintEditor(ctx, sel); else ctx.info?.("Select a placed part to edit its footprint."); }},
    "edit-symbol": {open: ctx => { const sel = selectedDef(ctx); if (sel?.symbol) openSymbolEditor(ctx, sel); else ctx.info?.("Select a placed part to edit its symbol."); }}
  };
  function selectedDef(ctx) {
    const p = ctx.currentProject ? ctx.currentProject() : ctx.project, ids = ctx.selection?.() || [];
    for (const d of p.documents) for (const i of d.items) if (ids.includes(i.id) && i.kind === "part") return p.library.find(x => x.id === i.def);
    if (panel?.selected && panel.source === "project" && panel.node && !panel.node.hidden) return p.library.find(x => x.id === panel.selected) || null;
    return null;
  }
  // Commands (palette and default keys) registered once the keymap is up.
  function registerCommands() {
    const K = globalThis.AtriumKeymap;
    if (!K?.registerCommand || registerCommands.done) return;
    registerCommands.done = true;
    const cmds = [["library-panel", "Library panel", "Window", "T L"], ["footprint-wizard", "IPC footprint wizard…", "Tools", "T F"],
      ["footprint-editor", "New footprint / edit selected footprint…", "Tools", null], ["symbol-editor", "New symbol / edit selected symbol…", "Tools", "T Y"],
      ["library-sources", "Library sources (.atrlib files)…", "Tools", null]];
    for (const [id, title, category, key] of cmds) try { K.registerCommand({id: "library:" + id, title, category, action: id, defaultKeys: key ? [key] : []}); } catch {}
  }
  if (globalThis.document) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", registerCommands, {once: true});
    else setTimeout(registerCommands, 0);
  }

  return Object.freeze({ELECTRICAL, electricalCode, inferElectrical, parseTable, pinsFromTable, tableFromPins, symbolFromPins, symbolFromGates, buildSymbol, symbolModel, symbolForFootprint,
    createFootprint, createSymbol, gateLetter, scrub, defHash, kiCadCredit, portableSource, portableDefinition, libraryFile, readLibraryFile, compareLands, landChanges, sourceChanges, modelChange, diffDefs, libraryRefFor, fromLibrary, sameLibrary, addFromLibrary, libraryStatus, checkUpdate, updateFromLibrary, saveToLibrary, sourceStore,
    pinGeometry, checkFootprint, validateDef, usage, duplicate, remove, rewire, updateParts, replaceDef, similar, search, facts, uniqueName,
    ui, workflows, mountPanel, togglePanel, focusPanel, reveal: (def, source) => panel?.reveal(def, source), commitDef, showDiff, checkLibrary, stateText, openLibraryFile, openPortableFiles, readPortable, exportLibrary, manageLibraries, openWizard, openFootprintEditor, openSymbolEditor, registerCommands});
})();
