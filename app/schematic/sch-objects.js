"use strict";
// Schematic place objects beyond parts, wires, junctions and net labels: power ports,
// ports, off-sheet connectors, sheet symbols with sheet entries, buses and bus entries,
// No ERC markers, text frames and notes, images, and the line/rectangle/arc/polygon
// drawing tools (stored as "graphic" items). Also part parameters with per-parameter
// visibility, and hop-over wire crossings as a sheet option.
//
// Stored formats (all coordinates in millimetres, y down, like every schematic item):
//   power      {kind,x,y,text,style,direction,showName?}   style: gnd|signal|earth|bar|arrow|circle|wave
//                                                         direction: 0 right, 1 up, 2 left, 3 down
//   port       {kind,x,y,text,io,width?,angle?}           io: unspecified|input|output|bidirectional
//   offsheet   {kind,x,y,text,angle?,io?}                 omitted io is unspecified
//   sheetsymbol{kind,x,y,w,h,name,sheet,file?,entries:[{id,name,side,offset,io}]}
//              x,y is the upper left corner; sheet is the child document id; side left|right|top|bottom
//              name "Repeat(CH,1,4)" (or repeat:{from,to}) makes a multi-channel symbol
//   bus        {kind,points,width?}
//   busentry   {kind,x,y,angle?,size?}                   from (x,y) to world([size,-size])
//   noerc      {kind,x,y}
//   textframe  {kind,x,y,w,h,text,note?,border?,fill?,size?}
//   textframe.role:"frame" is an organisational frame. Its existing text field is its title.
//   image      {kind,x,y,w,h,src}                          src: data:image/... URL
//   part.parameters {NAME:"value"} (read by the BOM), part.paramShow {NAME:true}
//   document.hopOvers true draws hop-overs at unjoined wire crossings.
globalThis.AtriumSchObjects = (() => {
  const A = Atrium;
  const KINDS = new Set(["power", "port", "offsheet", "sheetsymbol", "bus", "busentry", "noerc", "textframe", "image"]);
  const POWER = {circle:0, arrow:1, bar:2, wave:3, gnd:4, signal:5, earth:6};
  const POWER_TITLES = {gnd:"Power ground", signal:"Signal ground", earth:"Earth", bar:"Bar", arrow:"Arrow", circle:"Circle", wave:"Wave"};
  const IO = ["unspecified", "input", "output", "bidirectional"];
  const SIDES = ["left", "right", "top", "bottom"];
  const INK = {power:"#800000", port:"#800000", portFill:"#ffff80", portText:"#800000", wire:"#000080", bus:"#000080",
    sheet:"#800000", sheetFill:"#f4f1c8", entry:"#800000", entryFill:"#ffff80", noerc:"#ff0000", frame:"#000000",
    note:"#b39d00", noteFill:"#ffffd5", text:"#000080", select:"#00a000"};
  const FONT = '"Times New Roman", Times, serif', SIZE = 2.032, GRID = 2.54;
  const SCH = () => globalThis.AtriumSchAppearance;

  // ------------------------------------------------------------------ names
  // Altium bus syntax D[0..7] (also D[7..0]); members D0..D7. KiCad bus groups
  // USB{DP DM} (or {DP, DM}; members may be vectors) have members USB.DP, USB.DM.
  const BUS = /^(.*?)\[(\d+)\.\.(\d+)\]$/, GROUP = /^([^{}]*)\{([^{}]+)\}$/;
  const isBus = text => typeof text === "string" && (BUS.test(text.trim()) || GROUP.test(text.trim()));
  function vector(m) {
    const a = +m[2], b = +m[3], step = a <= b ? 1 : -1, out = [];
    if (Math.abs(b - a) > 1023) return [];
    for (let n = a; ; n += step) {out.push([m[1] + n, n]); if (n === b) break;}
    return out;
  }
  // [[member, key]]: key is the vector index, or a group member's own name.
  function busParts(text) {
    const s = String(text || "").trim(), g = GROUP.exec(s), m = BUS.exec(s);
    if (m && !g) return vector(m);
    if (!g) return [[s, s]];
    const pre = g[1].trim() ? g[1].trim() + "." : "";
    return g[2].split(/[\s,]+/).filter(Boolean).flatMap(x => {const v = BUS.exec(x); return v ? vector(v).map(([n]) => [pre + n, n]) : [[pre + x, x]];});
  }
  const busMembers = text => isBus(text) ? busParts(text).map(p => p[0]) : [String(text || "")];
  const busWidth = text => isBus(text) ? busParts(text).length : 1;
  const busKind = text => !isBus(text) ? "" : GROUP.test(String(text).trim()) ? "group" : "vector";
  // Member pairs joined when two differently named buses meet (KiCad's rule): vectors by
  // index (D[0..7] on DATA[0..15]: D3 = DATA3), groups by member name (A{TX RX} on B{TX RX}).
  function busAlias(a, b) {
    if (!isBus(a) || !isBus(b) || busKind(a) !== busKind(b)) return [];
    const other = new Map(busParts(b).map(([n, k]) => [k, n]));
    return busParts(a).filter(([n, k]) => other.has(k) && other.get(k) !== n).map(([n, k]) => [n, other.get(k)]);
  }
  // Buses joined by their vertices, with the bus names on them: net labels, ports, off sheet
  // connectors and sheet entries that sit on a bus segment. [{names:[{name, item, entry?}], buses}]
  function busNetworks(doc, {includeUnnamed=false} = {}) {
    const buses = doc.items.filter(i => i.kind === "bus" && i.points?.length > 1);
    if (!buses.length) return [];
    const up = buses.map((_, n) => n), root = n => {while (up[n] !== n) n = up[n] = up[up[n]]; return n;};
    const on = (p, b) => b.points.some((q, n) => n && A.nearSegment(p, b.points[n - 1], q) < 1e-4);
    buses.forEach((b, x) => buses.forEach((c, y) => {if (y > x && (b.points.some(p => on(p, c)) || c.points.some(p => on(p, b)))) up[root(y)] = root(x);}));
    const nets = new Map();
    const place = (p, name) => {const n = buses.findIndex(b => on(p, b)); if (n < 0) return; const r = root(n); if (!nets.has(r)) nets.set(r, {names:[], buses:buses.filter((_, k) => root(k) === r)}); nets.get(r).names.push(name);};
    for (const i of doc.items) {
      if (i.kind === "sheetsymbol") {for (const e of i.entries || []) if (isBus(e.name)) place(entryPoint(i, e), {name:e.name, item:i, entry:e});}
      else if (["netlabel", "port", "offsheet", "power"].includes(i.kind) && isBus(i.text)) place([i.x, i.y], {name:i.text.trim(), item:i});
    }
    if (includeUnnamed) for (let n = 0; n < buses.length; n++) {
      const r = root(n);
      if (!nets.has(r)) nets.set(r, {names:[], buses:buses.filter((_, k) => root(k) === r)});
    }
    return [...nets.values()];
  }
  // Repeat(CH,1,4) on a sheet symbol; Repeat(SIG) on its entries.
  function repeatOf(symbol) {
    const m = /^\s*repeat\s*\(\s*([^,()]*?)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)\s*$/i.exec(symbol?.name || "");
    if (m) return {name:m[1] || "CH", from:+m[2], to:+m[3]};
    const r = symbol?.repeat;
    if (r && Number.isInteger(r.from) && Number.isInteger(r.to)) return {name:String(r.name || symbol.name || "CH"), from:r.from, to:r.to};
    return null;
  }
  const repeatEntry = name => /^\s*repeat\s*\(\s*([^()]+?)\s*\)\s*$/i.exec(name || "")?.[1] || null;

  // ------------------------------------------------------------------ geometry
  const rot = (p, a) => A.rotate(p, a || 0);
  function entryPoint(s, e) {
    const o = e.offset;
    return e.side === "right" ? [s.x + s.w, s.y + o] : e.side === "top" ? [s.x + o, s.y] : e.side === "bottom" ? [s.x + o, s.y + s.h] : [s.x, s.y + o];
  }
  const entryAngle = side => ({left:0, right:180, top:90, bottom:270})[side] ?? 0;
  function busEntryEnd(i) {const s = i.size || GRID; return A.world([s, -s], i);}
  // Connection points, used for snapping, wire termination and connectivity nodes.
  function hotspots(i) {
    switch (i.kind) {
      case "power": case "port": case "offsheet": case "noerc": return [[i.x, i.y]];
      case "busentry": return [[i.x, i.y], busEntryEnd(i)];
      case "bus": return i.points.map(p => p.slice());
      case "sheetsymbol": return (i.entries || []).map(e => entryPoint(i, e));
      default: return [];
    }
  }
  // Electrical net identifiers: [point, name]; a blank name is an anonymous node (a sheet
  // entry), so wires ending on it join and are not dangling. Used by Atrium.connectivity
  // and the ERC graph alike, so both see the same nets.
  function netSources(i) {
    if (i.kind === "power" || i.kind === "port" || i.kind === "offsheet") return i.text && !isBus(i.text) ? [[[i.x, i.y], i.text]] : [[[i.x, i.y], ""]];
    if (i.kind === "sheetsymbol") return (i.entries || []).map(e => [entryPoint(i, e), ""]);
    return [];
  }
  // A local frame for drawing objects that turn in 90° steps.
  function frame(i) {return {x:i.x, y:i.y, angle:i.kind === "power" ? -(i.direction || 0) * 90 : i.angle || 0};}
  const powerPaint = (i, ink) => ({type:"power", style:POWER[i.style] ?? 2, direction:i.direction || 0, showName:i.showName !== false,
    family:"Times New Roman", size:SIZE, ink:ink || INK.power});
  const globalLabelWidths = new Map();
  let labelMetrics;
  function globalLabelWidth(name) {
    if (globalLabelWidths.has(name)) return globalLabelWidths.get(name);
    // Measure at a larger font size so browser font-size quantization doesn't
    // clip wide names. Headless drawing has a conservative em-width fallback.
    if (labelMetrics === undefined) labelMetrics = globalThis.document?.createElement?.("canvas")?.getContext?.("2d") || null;
    let width = String(name || "").length * SIZE * .9;
    if (labelMetrics) {
      labelMetrics.font = "100px " + FONT;
      width = labelMetrics.measureText(name).width * SIZE * .009;
    }
    if (globalLabelWidths.size >= 512) globalLabelWidths.clear();
    globalLabelWidths.set(name, width);
    return width;
  }
  function portShape(i) {
    const h = 2.54, t = h / 2, io = A.offsheetIO(i.io);
    // The wire meets the left end. An input points into the sheet (at the wire), an output away.
    const left = io === "input" || io === "bidirectional", right = io === "output" || io === "bidirectional";
    const globalLabel = i.kind === "offsheet";
    const w = globalLabel ? globalLabelWidth(i.text) + 2 + t * (Number(left) + Number(right)) : i.width || textWidth(i.text) + 2.6;
    const pts = [[left ? t : 0, -t], [right ? w - t : w, -t]];
    if (right) pts.push([w, 0]);
    pts.push([right ? w - t : w, t], [left ? t : 0, t]);
    if (left) pts.push([0, 0]);
    return {w, h, points:pts, textX:globalLabel ? (w + (Number(left) - Number(right)) * t) / 2 : w / 2};
  }
  const textWidth = (text, size = SIZE) => String(text || "").length * size * .62;
  function box(i) {
    const B = pts => A.bounds(pts);
    switch (i.kind) {
      case "power": {
        const S = SCH(); if (S?.labelBox) return S.labelBox({...i, schPaint:powerPaint(i)});
        return [i.x - 2, i.y - 2, i.x + 2, i.y + 2];
      }
      case "port": {
        const s = portShape(i), f = frame(i);
        return B([[0, -s.h / 2], [s.w, -s.h / 2], [s.w, s.h / 2], [0, s.h / 2]].map(p => A.world(p, f)));
      }
      case "offsheet": {
        const f = {x:i.x, y:i.y, angle:A.offsheetAngle(i)};
        if (A.offsheetIO(i.io) === "unspecified") {
          if (i.schPaint?.offSheet && SCH()?.labelBox) return SCH().labelBox(i);
          const w = 2.6 + textWidth(i.text);
          return B([[0, -1.3], [w, -1.3], [w, 1.3], [0, 1.3]].map(p => A.world(p, f)));
        }
        const b = B(portShape(i).points.map(p => A.world(p, f)));
        const original = i.schPaint?.offSheet && SCH()?.labelBox(i);
        return original ? [Math.min(b[0], original[0]), Math.min(b[1], original[1]), Math.max(b[2], original[2]), Math.max(b[3], original[3])] : b;
      }
      case "sheetsymbol": {
        const b = [i.x, i.y - SIZE * 1.4, i.x + i.w, i.y + i.h + SIZE * 1.6];
        b[2] = Math.max(b[2], i.x + textWidth(i.name || "") + 1, i.x + textWidth(fileLabel(i)) + 1);
        return b;
      }
      case "bus": {const b = A.bounds(i.points), r = (i.width || .6) / 2 + .2; return [b[0] - r, b[1] - r, b[2] + r, b[3] + r];}
      case "busentry": {const e = busEntryEnd(i); return [Math.min(i.x, e[0]) - .2, Math.min(i.y, e[1]) - .2, Math.max(i.x, e[0]) + .2, Math.max(i.y, e[1]) + .2];}
      case "noerc": return [i.x - .9, i.y - .9, i.x + .9, i.y + .9];
      case "image": if (i.asset && globalThis.AtriumNotebookImages) return AtriumNotebookImages.bounds(i);
      // Earlier projects store upright images as inline data.
      case "textframe": return [Math.min(i.x, i.x + i.w), Math.min(i.y, i.y + i.h), Math.max(i.x, i.x + i.w), Math.max(i.y, i.y + i.h)];
      default: return [i.x - .5, i.y - .5, i.x + .5, i.y + .5];
    }
  }
  const isFrame = i => i?.kind === "textframe" && i.role === "frame";
  const frameBounds = i => [i.x, i.y, i.x + i.w, i.y + i.h];
  // Membership uses authored geometry: labels and ports attach at their anchor; captions do not
  // change the owner of a symbol. A crossing wire or a partially enclosed symbol stays outside.
  function frameContents(doc, frame, defs, candidates = doc.items) {
    const rect = frameBounds(frame), eps = 1e-6;
    return candidates.filter(i => {
      if (i === frame || i.id === frame.id) return false;
      let b;
      if (SIZED.has(i.kind)) b = i.kind === "sheetsymbol" ? frameBounds(i) : box(i);
      else if (i.kind === "busentry") b = A.bounds(hotspots(i));
      else if (i.kind === "part" || i.points) b = A.bounds(A.itemPoints(i, defs?.get(i.def), "schematic"));
      else b = [i.x, i.y, i.x, i.y];
      if (!b || !(b[0] >= rect[0]-eps && b[1] >= rect[1]-eps && b[2] <= rect[2]+eps && b[3] <= rect[3]+eps)) return false;
      return !isFrame(i) || b.some((n, k) => Math.abs(n - rect[k]) > eps);
    });
  }
  function hit(i, p, tol) {
    if (isFrame(i)) {
      const [x,y,r,b] = frameBounds(i), [px,py] = p;
      if (px >= x && px <= r && py >= y && py <= b) {
        if (px <= x + Math.min(i.w, textWidth(i.text) + 2) && py <= y + Math.min(i.h, SIZE * 1.5)) return 0;
        return Math.min(px-x, r-px, py-y, b-py);
      }
    }
    if (i.asset && i.kind === "image" && globalThis.AtriumNotebookImages) return AtriumNotebookImages.hit(i,p);
    if (i.kind === "bus") {
      let d = Infinity;
      for (let n = 1; n < i.points.length; n++) d = Math.min(d, A.nearSegment(p, i.points[n - 1], i.points[n]));
      return d - (i.width || .6) / 2;
    }
    if (i.kind === "busentry") return A.nearSegment(p, [i.x, i.y], busEntryEnd(i));
    if (i.kind === "sheetsymbol") {
      for (const e of i.entries || []) {const q = entryPoint(i, e); if (Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol) return 0;}
    }
    const b = box(i);
    return Math.hypot(Math.max(b[0] - p[0], p[0] - b[2], 0), Math.max(b[1] - p[1], p[1] - b[3], 0));
  }
  // The sheet entry under a point, for P A and double-click.
  function entryBox(symbol, e) {
    const [x,y] = entryPoint(symbol, e), f = {x, y, angle:entryAngle(e.side)};
    const label = textWidth(e.name, SIZE * .85), w = Math.max(3.2, label + 2.2) + .6 + label;
    return A.bounds([[0,-1],[w,-1],[w,1],[0,1]].map(p => A.world(p, f)));
  }
  function entryAt(symbol, p, tol = 1) {
    for (const e of symbol.entries || []) {const q = entryPoint(symbol, e); if (Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol) return e;}
    for (const e of symbol.entries || []) {
      const b = entryBox(symbol, e);
      if (p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]) return e;
    }
    return null;
  }
  // Where a click lands on a symbol's border: side and offset snapped to the grid.
  function edgeAt(s, p, grid = GRID) {
    const d = {left:Math.abs(p[0] - s.x), right:Math.abs(p[0] - s.x - s.w), top:Math.abs(p[1] - s.y), bottom:Math.abs(p[1] - s.y - s.h)};
    const side = Object.keys(d).sort((a, b) => d[a] - d[b])[0], span = side === "left" || side === "right" ? s.h : s.w;
    const raw = side === "left" || side === "right" ? p[1] - s.y : p[0] - s.x;
    const offset = Math.min(span - grid, Math.max(grid, Math.round(raw / grid) * grid));
    return {side, offset, distance:d[side]};
  }

  // ------------------------------------------------------------------ component kinds
  // Altium's Component Type (SchDoc COMPONENTKIND 0-6), kept on the part or its definition.
  // Graphical parts are drawings (no netlist, ERC or BOM); mechanical parts go to the board
  // but not into nets, ERC or the BOM; net ties join nets on purpose.
  const COMPONENT_KINDS = ["standard", "mechanical", "graphical", "netTie", "netTieNoBom", "standardNoBom", "jumper"];
  function componentKind(item, def) {
    const raw = item?.componentKind ?? def?.componentKind;
    if (Number.isInteger(raw)) return COMPONENT_KINDS[raw] || "standard";
    const k = String(raw ?? "").replace(/[\s_()-]+/g, "").toLowerCase();
    return COMPONENT_KINDS.find(c => c.toLowerCase() === k) || (/^\d$/.test(k) ? COMPONENT_KINDS[+k] : null) || "standard";
  }
  const notElectrical = (item, def) => ["graphical", "mechanical"].includes(componentKind(item, def));

  // ------------------------------------------------------------------ drag to size
  // Grips on a selected sheet symbol, text frame or image: corners and edge midpoints.
  const SIZED = new Set(["sheetsymbol", "textframe", "image"]);
  function grips(i) {
    if (i?.asset && i.angle && globalThis.AtriumNotebookImages) return AtriumNotebookImages.grips(i);
    if (i?.math === true || !SIZED.has(i?.kind) || !(i.w > 0 && i.h > 0)) return [];
    const out = [];
    for (const v of [0, .5, 1]) for (const u of [0, .5, 1]) if (u !== .5 || v !== .5) out.push({u, v, at:[i.x + u * i.w, i.y + v * i.h]});
    return out;
  }
  // Entries on one side keep their order and grid pitch and stay inside the side.
  function reflow(s, grid = GRID) {
    for (const side of SIDES) {
      const list = (s.entries || []).filter(e => e.side === side).sort((a, b) => a.offset - b.offset);
      const span = side === "left" || side === "right" ? s.h : s.w;
      let prev = -Infinity;
      const r6 = v => Math.round(v * 1e6) / 1e6;
      for (const e of list) {e.offset = r6(Math.max(prev + grid, Math.min(span - grid, Math.max(grid, Math.round(e.offset / grid) * grid)))); prev = e.offset;}
      let next = Infinity;
      for (const e of list.reverse()) {if (e.offset > Math.min(next - grid, span - grid)) e.offset = r6(Math.max(grid, Math.min(next - grid, span - grid))); next = e.offset;}
    }
    return s;
  }
  // The smallest size that holds the entries on the grid.
  function minSize(s, grid = GRID) {
    const n = side => (s.entries || []).filter(e => e.side === side).length;
    return [Math.max(grid * 2, (Math.max(n("top"), n("bottom")) + 1) * grid), Math.max(grid * 2, (Math.max(n("left"), n("right")) + 1) * grid)];
  }
  // A resize session when `p` is on a grip of `i` (editor drag): move(p, grid), cancel().
  // Entries keep their place on the sheet while the far edges move and reflow when a side shrinks.
  function resizeAt(i, p, tol) {
    if(globalThis.AtriumLabs?.notebookEnabled()===false && A.notebookItemKind(i))return null;
    const g = grips(i).find(q => Math.hypot(q.at[0] - p[0], q.at[1] - p[1]) <= tol);
    if (!g) return null;
    if (i.asset && i.angle && globalThis.AtriumNotebookImages) return AtriumNotebookImages.resizeAt(i,g);
    const was = {x:i.x, y:i.y, w:i.w, h:i.h, entries:(i.entries || []).map(e => ({...e}))};
    const fixed = [i.x + (1 - g.u) * i.w, i.y + (1 - g.v) * i.h], absolute = was.entries.map(e => entryPoint(was, e));
    return {grip:g, move(q, grid = GRID) {
      // The edges snap to the sheet grid; entries keep Altium's 2.54 mm pitch.
      const snap = v => Math.round((grid > 0 ? Math.round(v / grid) * grid : v) * 1e6) / 1e6, [mw, mh] = i.kind === "sheetsymbol" ? minSize(was) : [grid, grid];
      let x0 = was.x, x1 = was.x + was.w, y0 = was.y, y1 = was.y + was.h;
      if (g.u === 0) x0 = Math.min(snap(q[0]), fixed[0] - mw); else if (g.u === 1) x1 = Math.max(snap(q[0]), fixed[0] + mw);
      if (g.v === 0) y0 = Math.min(snap(q[1]), fixed[1] - mh); else if (g.v === 1) y1 = Math.max(snap(q[1]), fixed[1] + mh);
      if (i.widget && globalThis.AtriumSheetWidgets) {
        const [w,h]=AtriumSheetWidgets.size(i.widget.type,x1-x0,y1-y0);
        if (g.u===0) x0=x1-w; else if (g.u===1) x1=x0+w;
        if (g.v===0) y0=y1-h; else if (g.v===1) y1=y0+h;
      }
      const r6 = v => Math.round(v * 1e6) / 1e6;
      Object.assign(i, {x:r6(x0), y:r6(y0), w:r6(x1 - x0), h:r6(y1 - y0)});
      if (i.entries) {
        i.entries.forEach((e, n) => {const a = absolute[n]; e.offset = r6(e.side === "left" || e.side === "right" ? a[1] - y0 : a[0] - x0);});
        reflow(i);
      }
      return i;
    }, cancel() {Object.assign(i, {x:was.x, y:was.y, w:was.w, h:was.h}); if (i.entries) i.entries = was.entries;}};
  }

  // ------------------------------------------------------------------ validation
  const num = v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e8;
  const str = v => typeof v === "string";
  const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  // lenient: a file from a newer version (model.js): an unknown power style, direction, I/O type, entry
  // side or image type is kept as written; drawing falls back (power style 2, io and side defaults).
  const DIRECTIVE_KINDS = new Set(["netlabel", "port", "power", "offsheet", "wire"]);
  function validateItem(i, invalid, lenient) {
    if ((i.sticky != null || i.callout != null || i.ink != null) && globalThis.AtriumMarkup && !AtriumMarkup.valid(i)) invalid();
    if (i.widget != null && (i.kind !== "textframe" || i.role != null || i.math != null || i.richText != null || i.calculation != null ||
      globalThis.AtriumWidgetCatalogue && !AtriumWidgetCatalogue.valid(i))) invalid();
    const one = (v, ok) => ok || lenient && str(v) && v.length <= 64;
    if (i.kind === "part") {
      if (i.mirror != null && typeof i.mirror !== "boolean") invalid();
      if (i.parameters != null && (!plain(i.parameters) || Object.keys(i.parameters).length > 500 || !Object.values(i.parameters).every(v => str(v) || num(v)))) invalid();
      if (i.paramShow != null && (!plain(i.paramShow) || !Object.values(i.paramShow).every(v => typeof v === "boolean"))) invalid();
      return;
    }
    // Signal and tag directives (format 1.4, signals.js): signal name, polarity 1 | -1, tags; and the
    // older netClass ("A,B") and diffPair names.
    if (DIRECTIVE_KINDS.has(i.kind)) {
      if (i.signal != null && !(str(i.signal) && i.signal.length <= 256)) invalid();
      if (i.polarity != null && i.polarity !== 1 && i.polarity !== -1 && !lenient) invalid();
      if (i.tags != null && !(Array.isArray(i.tags) && i.tags.length <= 64 && i.tags.every(t => str(t) && t.length <= 256))) invalid();
      if (i.netClass != null && typeof i.netClass !== "string" || i.diffPair != null && typeof i.diffPair !== "string") invalid();
    }
    if (!KINDS.has(i.kind)) return;
    if (i.kind !== "bus" && (!num(i.x) || !num(i.y))) invalid();
    if (i.angle != null && !num(i.angle)) invalid();
    switch (i.kind) {
      case "power":
        if (!str(i.text) || !one(i.style, Object.hasOwn(POWER, i.style)) || !([0, 1, 2, 3].includes(i.direction) || lenient && Number.isInteger(i.direction)) || (i.showName != null && typeof i.showName !== "boolean")) invalid();
        break;
      case "port":
        if (!str(i.text) || !one(i.io, IO.includes(i.io)) || (i.width != null && (!num(i.width) || i.width <= 0))) invalid();
        break;
      case "offsheet": if (!str(i.text) || (i.io !== undefined && !one(i.io, IO.includes(i.io)))) invalid(); break;
      case "sheetsymbol":
        if (!num(i.w) || i.w <= 0 || !num(i.h) || i.h <= 0 || !str(i.name) || !str(i.sheet) || (i.file != null && !str(i.file)) || !Array.isArray(i.entries)) invalid();
        if (i.repeat != null && (!plain(i.repeat) || !Number.isInteger(i.repeat.from) || !Number.isInteger(i.repeat.to) || Math.abs(i.repeat.to - i.repeat.from) > 255)) invalid();
        for (const e of i.entries) if (!plain(e) || !str(e.id) || !str(e.name) || !one(e.side, SIDES.includes(e.side)) || !num(e.offset) || !one(e.io, IO.includes(e.io))) invalid();
        break;
      case "bus":
        if (!Array.isArray(i.points) || i.points.length < 2 || !i.points.every(p => Array.isArray(p) && p.length === 2 && p.every(num))) invalid();
        if (i.width != null && (!num(i.width) || i.width <= 0)) invalid();
        break;
      case "busentry": if (i.size != null && (!num(i.size) || i.size <= 0)) invalid(); break;
      case "textframe":
        if (i.role !== undefined && !one(i.role, i.role === "frame")) invalid();
        if (isFrame(i) && (!(i.w > 0 && i.h > 0) || !str(i.text) || !i.text.trim() || i.text.length > 300)) invalid();
        if(i.richText!=null && globalThis.AtriumNotebook && !AtriumNotebook.validate(i.richText)) invalid();
        if (i.math !== undefined && typeof i.math !== "boolean" || i.math === true && (i.role === "frame" || !str(i.text) || !i.text.trim() || i.text.length > 8192 || !(i.w > 0 && i.h > 0) || i.size !== undefined && !(num(i.size) && i.size > 0))) invalid();
        if (!num(i.w) || !num(i.h) || !str(i.text) || (i.note != null && typeof i.note !== "boolean") || (i.border != null && typeof i.border !== "boolean") ||
          (i.fill != null && !/^#[0-9a-f]{6}$/i.test(i.fill)) || (i.size != null && (!num(i.size) || i.size <= 0))) invalid();
        break;
      case "image":
        if (i.asset) break; // The shared model validates typed asset placements.
        if (!num(i.w) || !num(i.h) || !str(i.src) || !(lenient ? /^data:image\/[\w.+-]{1,32};base64,[A-Za-z0-9+/=]*$/ : /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]*$/).test(i.src) || i.src.length > 8e6) invalid();
        break;
    }
  }

  // ------------------------------------------------------------------ drawing
  function stroke(ctx, pts, closed, color, width) {
    ctx.beginPath(); ctx.moveTo(...pts[0]); for (let n = 1; n < pts.length; n++) ctx.lineTo(...pts[n]); if (closed) ctx.closePath();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  }
  // Text upright in the sheet's reading directions; the anchor is fixed.
  function text(ctx, s, x, y, o, scale) {
    const size = o.size || SIZE;
    if (!s || size * scale < 2.4) return;
    ctx.save(); ctx.translate(x, y);
    let angle = ((o.angle || 0) % 360 + 360) % 360, align = o.align || "left";
    if (angle > 90 && angle <= 270) {angle -= 180; align = {left:"right", right:"left"}[align] || align;}
    if (angle) ctx.rotate(A.rad(angle));
    ctx.font = (o.bold ? "bold " : "") + size + "px " + FONT; ctx.textAlign = align; ctx.textBaseline = o.baseline || "middle";
    // Negation overlines as on net labels and pins (AtriumSchAppearance.negation; the name stays raw).
    const neg = o.negate ? SCH()?.negation?.(s) : null; if (neg) s = neg.text;
    ctx.fillStyle = o.ink || INK.text; ctx.fillText(s, 0, 0);
    if (neg?.bars && s) {
      const w = t => ctx.measureText(t).width, W = w(s), left = align === "right" ? -W : align === "center" ? -W / 2 : 0, t = Math.max(size * .06, .8 / scale);
      const b = ctx.textBaseline, y = (b === "top" ? 0 : b === "bottom" || b === "alphabetic" ? -size * .72 : -size * .36) - size * .08 - t;
      if (neg.all) ctx.fillRect(left, y, W, t); else for (const k of neg.bars) ctx.fillRect(left + w(s.slice(0, k)), y, w(s.slice(0, k + 1)) - w(s.slice(0, k)), t);
    }
    ctx.restore();
  }
  const fileLabel = s => s.file || "";
  const images = new Map();
  function image(src) {
    let img = images.get(src);
    if (!img && typeof Image === "function") {
      img = new Image(); img.onload = () => globalThis.dispatchEvent?.(new Event("atrium-theme")); img.src = src; images.set(src, img);
      if (images.size > 64) images.delete(images.keys().next().value);
    }
    return img;
  }
  function wrap(ctx, s, width) {
    const lines = [];
    for (const para of String(s || "").split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        const next = line ? line + " " + word : word;
        if (line && ctx.measureText(next).width > width) {lines.push(line); line = word;} else line = next;
      }
      lines.push(line);
    }
    return lines;
  }
  function redrawWhenLoaded(name, redraw = () => globalThis.AtriumNavHost?.redraw?.()) {
    const lazy = globalThis.AtriumLazy;
    if (lazy && !lazy.pending(name)) lazy.need(name).then(redraw).catch(() => {});
  }
  const widgetLoads = new Set();
  function loadWidgetPainter(name) {
    const lazy = globalThis.AtriumLazy;
    if (!lazy || widgetLoads.has(name)) return;
    widgetLoads.add(name);
    // Another surface may have started this load. Both open sheets can still have fallback artwork.
    lazy.need(name).then(() => {
      if (globalThis.AtriumLabs?.notebookEnabled() === false) return;
      const host = globalThis.AtriumNavHost;
      for (const {docId} of host?.panes?.() || []) {
        if (host.docById(docId)?.kind === "schematic") host.invalidateDocument(docId,true);
      }
    }).catch(() => {}).finally(() => widgetLoads.delete(name));
  }
  // o: {scale, selected, lit, select, schBox(bounds)}
  function draw(ctx, i, o) {
    if(globalThis.AtriumLabs?.notebookEnabled()===false && A.notebookItemKind(i)){
      globalThis.AtriumNotebookCompat?.draw(ctx,i,o.doc,o);
      return;
    }
    const scale = o.scale, hot = o.selected || o.lit, sel = o.select || INK.select, thin = Math.max(.15, .8 / scale);
    const ink = base => hot ? sel : base;
    switch (i.kind) {
      case "power": {
        const S = SCH(), p = powerPaint(i);
        if (S?.label) S.label(ctx, {...i, angle:0, schPaint:p}, scale, hot);
        else {stroke(ctx, [[i.x, i.y], [i.x, i.y - GRID]], false, ink(INK.power), thin); text(ctx, i.text, i.x, i.y - 3.5, {align:"center", ink:ink(INK.power), negate:true}, scale);}
        break;
      }
      case "port": case "offsheet": {
        const off = i.kind === "offsheet", angle = off ? A.offsheetAngle(i) : i.angle || 0;
        if (off && A.offsheetIO(i.io) === "unspecified") {
          if (i.schPaint?.offSheet && SCH()?.label) SCH().label(ctx, i, scale, hot);
          else {
            // The untyped Altium-style connector predates the optional direction.
            const f = frame(i), c = ink(INK.port), w = Math.max(thin, .2);
            for (const dx of [0, 1.1]) stroke(ctx, [[dx, -1.1], [dx + 1.1, 0], [dx, 1.1]].map(q => A.world(q, f)), false, c, w);
            const at = A.world([2.9, 0], f), turned = ((angle % 360) + 360) % 360;
            text(ctx, i.text, at[0], at[1], {align:turned === 180 ? "right" : "left", angle:turned === 90 || turned === 270 ? -90 : 0, ink:c, negate:true}, scale);
          }
          break;
        }
        const s = portShape(i);
        ctx.save(); ctx.translate(i.x, i.y); ctx.rotate(A.rad(angle));
        ctx.beginPath(); ctx.moveTo(...s.points[0]); for (const q of s.points.slice(1)) ctx.lineTo(...q); ctx.closePath();
        if (!off) {ctx.fillStyle = INK.portFill; ctx.fill();}
        ctx.strokeStyle = ink(INK.port); ctx.lineWidth = thin; ctx.stroke();
        ctx.restore();
        const mid = A.world([s.textX, 0], {x:i.x, y:i.y, angle});
        text(ctx, i.text, mid[0], mid[1], {align:"center", ink:ink(INK.portText), angle:angle % 180 ? -90 : 0, size:SIZE * .9, negate:true}, scale);
        if (off && i.schPaint?.crossReferences) SCH()?.crossReferences(ctx, i, scale, hot);
        break;
      }
      case "sheetsymbol": {
        ctx.beginPath(); ctx.rect(i.x, i.y, i.w, i.h); ctx.fillStyle = INK.sheetFill; ctx.fill();
        ctx.strokeStyle = ink(INK.sheet); ctx.lineWidth = Math.max(thin, .254); ctx.stroke();
        const rep = repeatOf(i);
        if (rep) { // A stack of sheets: Altium draws repeated symbols as layered outlines.
          ctx.beginPath(); ctx.moveTo(i.x + .8, i.y - .8); ctx.lineTo(i.x + i.w + .8, i.y - .8); ctx.lineTo(i.x + i.w + .8, i.y + i.h - .8);
          ctx.strokeStyle = ink(INK.sheet); ctx.stroke();
        }
        text(ctx, i.name || "Sheet", i.x, i.y - .6, {baseline:"bottom", ink:ink("#000080")}, scale);
        text(ctx, fileLabel(i), i.x, i.y + i.h + .5, {baseline:"top", ink:ink("#000080"), size:SIZE * .9}, scale);
        for (const e of i.entries || []) drawEntry(ctx, i, e, o, ink);
        break;
      }
      case "bus": {
        ctx.beginPath(); ctx.moveTo(...i.points[0]); for (const q of i.points.slice(1)) ctx.lineTo(...q);
        ctx.strokeStyle = ink(INK.bus); ctx.lineWidth = Math.max(2 / scale, i.width || .6); ctx.lineCap = "round"; ctx.stroke();
        break;
      }
      case "busentry": stroke(ctx, [[i.x, i.y], busEntryEnd(i)], false, ink(INK.wire), Math.max(thin, .254)); break;
      case "noerc": {
        const r = .8, c = ink(INK.noerc), w = Math.max(thin, .25);
        stroke(ctx, [[i.x - r, i.y - r], [i.x + r, i.y + r]], false, c, w); stroke(ctx, [[i.x - r, i.y + r], [i.x + r, i.y - r]], false, c, w);
        break;
      }
      case "textframe": {
        if (isFrame(i)) {
          ctx.save();
          ctx.strokeStyle = ink("#496777"); ctx.lineWidth = Math.max(.25, 1 / scale);
          ctx.strokeRect(i.x, i.y, i.w, i.h);
          ctx.beginPath(); ctx.rect(i.x, i.y, i.w, i.h); ctx.clip();
          text(ctx, i.text, i.x + .8, i.y + .5, {size:SIZE, baseline:"top", ink:ink("#496777")}, scale);
          ctx.restore(); break;
        }
        if (i.widget) {
          const widgets = globalThis.AtriumWidgetCatalogue;
          if (widgets?.paint(ctx,i,o,loadWidgetPainter)) break;
          if (!widgets && (!o.purpose || o.purpose === "screen")) loadWidgetPainter("AtriumWidgetCatalogue");
        }
        if (i.calculation && o.calculationRecords && globalThis.AtriumCalculationDisplay) {
          AtriumCalculationDisplay.draw(ctx,i,o.calculationRecords.get(i.id),o);
          break;
        }
        if (i.calculation && globalThis.AtriumCalculationSheet) {
          AtriumCalculationSheet.draw(ctx,i,{...o,frozen:o.calculationRecords!=null,evaluated:o.calculationRecords?.get(i.id)});
          break;
        }
        if (i.calculation && !o.calculationRecords) redrawWhenLoaded("AtriumCalculationSheet");
        if(i.richText) {
          if(globalThis.AtriumRichText?.draw(ctx,i,o)) break;
          redrawWhenLoaded("AtriumRichText");
        }
        if (i.math === true) {
          if (globalThis.AtriumMath) AtriumMath.drawItem(ctx, i, ink(INK.text));
          else redrawWhenLoaded("AtriumMath",()=>dispatchEvent(new Event("atrium-theme")));
          break;
        }
        const b = box(i), w = b[2] - b[0], h = b[3] - b[1], size = i.size || SIZE, pad = .8;
        ctx.beginPath();
        if (i.note) {const f = Math.min(2.5, w / 4, h / 4); ctx.moveTo(b[0], b[1]); ctx.lineTo(b[2] - f, b[1]); ctx.lineTo(b[2], b[1] + f); ctx.lineTo(b[2], b[3]); ctx.lineTo(b[0], b[3]); ctx.closePath();}
        else ctx.rect(b[0], b[1], w, h);
        ctx.fillStyle = i.fill || (i.note ? INK.noteFill : "#ffffff"); ctx.fill();
        if (i.border !== false || i.note || hot) {ctx.strokeStyle = ink(i.note ? INK.note : INK.frame); ctx.lineWidth = thin; ctx.stroke();}
        if (size * scale >= 2.4) {
          ctx.save(); ctx.beginPath(); ctx.rect(b[0], b[1], w, h); ctx.clip();
          ctx.font = size + "px " + FONT; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillStyle = INK.text;
          wrap(ctx, i.text, w - 2 * pad).forEach((line, n) => ctx.fillText(line, b[0] + pad, b[1] + pad + n * size * 1.2));
          ctx.restore();
        }
        break;
      }
      case "image": {
        if (i.asset) {
          const painter = globalThis.AtriumNotebookImages;
          if (painter) painter.draw(ctx,i,o);
          else redrawWhenLoaded("AtriumNotebookImages");
          if (hot) o.schBox?.(box(i));
          break;
        }
        const b = box(i), img = image(i.src);
        if (img?.complete && img.naturalWidth) ctx.drawImage(img, b[0], b[1], b[2] - b[0], b[3] - b[1]);
        else {ctx.fillStyle = "#e9e9e9"; ctx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);}
        if (hot) {ctx.strokeStyle = sel; ctx.lineWidth = thin; ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);}
        break;
      }
    }
    if (o.selected && o.schBox) {
      o.schBox(box(i));
      const S = SCH();
      if (S?.grip) for (const q of i.kind === "bus" ? i.points : [...hotspots(i), ...grips(i).map(g => g.at)]) S.grip(ctx, q, scale);
    }
  }
  function drawEntry(ctx, s, e, o, ink) {
    const at = entryPoint(s, e), a = entryAngle(e.side), f = {x:at[0], y:at[1], angle:a};
    const w = Math.max(3.2, textWidth(e.name, SIZE * .85) + 2.2), t = .9, io = e.io || "unspecified";
    // Altium entries are drawn inside the symbol; the point shows the signal direction:
    // an input points into the symbol (away from the border), an output out of it.
    const tipOut = io === "input" || io === "bidirectional", tipIn = io === "output" || io === "bidirectional";
    const pts = [[tipIn ? t : 0, -t], [tipOut ? w - t : w, -t]];
    if (tipOut) pts.push([w, 0]);
    pts.push([tipOut ? w - t : w, t], [tipIn ? t : 0, t]);
    if (tipIn) pts.push([0, 0]);
    ctx.beginPath(); pts.map(q => A.world(q, f)).forEach((q, n) => n ? ctx.lineTo(...q) : ctx.moveTo(...q)); ctx.closePath();
    ctx.fillStyle = INK.entryFill; ctx.fill(); ctx.strokeStyle = ink(INK.entry); ctx.lineWidth = Math.max(.12, .7 / o.scale); ctx.stroke();
    const mid = A.world([w + .6, 0], f), vertical = a === 90 || a === 270;
    text(ctx, e.name, mid[0], mid[1], {size:SIZE * .85, ink:ink(INK.entry), align:a === 180 || a === 270 ? "right" : "left", angle:vertical ? -90 : 0, negate:true}, o.scale);
  }

  // ------------------------------------------------------------------ hop-overs
  // Crossings of a horizontal and a vertical wire segment that do not share a point and
  // carry no junction. The horizontal wire hops (KiCad 10 style).
  const HOP = .7;
  const hopCache = new WeakMap();
  function hops(doc, force = false) {
    if (!doc?.hopOvers) return null;
    // One drawing pass is one task: reuse the map until the task ends.
    const live = hopCache.get(doc);
    if (live?.fresh && !force) return live.map;
    const wires = doc.items.filter(i => i.kind === "wire"), junctions = new Set(doc.items.filter(i => i.kind === "junction").map(i => A.pointKey([i.x, i.y])));
    const sig = wires.length + ":" + wires.map(w => w.id + "=" + w.points.flat().join(",")).join(";") + "|" + [...junctions].join(";");
    const cached = hopCache.get(doc);
    const fresh = entry => {entry.fresh = true; (globalThis.queueMicrotask || (f => Promise.resolve().then(f)))(() => {entry.fresh = false;}); return entry.map;};
    if (cached?.sig === sig) return fresh(cached);
    const H = [], V = [];
    for (const w of wires) for (let n = 1; n < w.points.length; n++) {
      const a = w.points[n - 1], b = w.points[n];
      if (Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[0] - b[0]) > 1e-6) H.push({w, n, y:a[1], x0:Math.min(a[0], b[0]), x1:Math.max(a[0], b[0])});
      else if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) > 1e-6) V.push({w, x:a[0], y0:Math.min(a[1], b[1]), y1:Math.max(a[1], b[1])});
    }
    V.sort((p, q) => p.x - q.x);
    const map = new Map(), eps = HOP + 1e-3;
    for (const h of H) {
      let lo = 0, hi = V.length;
      while (lo < hi) {const m = lo + hi >> 1; if (V[m].x < h.x0 + eps) lo = m + 1; else hi = m;}
      for (let k = lo; k < V.length && V[k].x <= h.x1 - eps; k++) {
        const v = V[k];
        if (v.w === h.w || !(h.y > v.y0 + 1e-6 && h.y < v.y1 - 1e-6) || junctions.has(A.pointKey([v.x, h.y]))) continue;
        const key = h.w.id + "/" + h.n;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(v.x);
      }
    }
    const entry = {sig, map};
    hopCache.set(doc, entry);
    return fresh(entry);
  }
  // Stroke path for a wire with hops. Returns false when the wire has none.
  function hopPath(ctx, wire, doc, map = hops(doc)) {
    if (!map || !wire.points.some((_, n) => map.has(wire.id + "/" + n))) return false;
    const P = wire.points;
    ctx.beginPath(); ctx.moveTo(...P[0]);
    for (let n = 1; n < P.length; n++) {
      const a = P[n - 1], b = P[n], xs = map.get(wire.id + "/" + n);
      if (xs) {
        const dir = Math.sign(b[0] - a[0]), sorted = [...xs].sort((p, q) => (p - q) * dir);
        for (const x of sorted) {
          ctx.lineTo(x - dir * HOP, a[1]);
          if (dir > 0) ctx.arc(x, a[1], HOP, Math.PI, 2 * Math.PI, false); else ctx.arc(x, a[1], HOP, 0, Math.PI, true);
        }
      }
      ctx.lineTo(...b);
    }
    return true;
  }

  // ------------------------------------------------------------------ part parameters
  // Visible parameters stack under the comment (value) text, as in Altium.
  function shownParams(part) {
    if (!part.paramShow) return [];
    return Object.keys(part.paramShow).filter(k => part.paramShow[k] === true && String(part.parameters?.[k] ?? part.schPaint?.parameters?.[k]?.text ?? "").length);
  }
  function drawParams(ctx, part, pos, scale, selected) {
    const keys = shownParams(part);
    if (!keys.length) return;
    const base = part.valueAt ? A.world(part.valueAt, part) : pos?.value || [part.x, part.y];
    const align = part.valueAt ? "left" : pos?.align || "left";
    let stacked = 0;
    for (const k of keys) {
      const paint = part.schPaint?.parameters?.[k], value = String(part.parameters?.[k] ?? paint?.text ?? "");
      if (paint && SCH()?.glyph) {
        const at = A.world(paint.at, part);
        SCH().glyph(ctx, paint.caption ? paint.caption + ": " + value : value, ...at, {...paint, angle:paint.angle + (part.angle || 0)}, scale, selected ? INK.select : null);
      } else text(ctx, value, base[0], base[1] + ++stacked * SIZE * 1.15, {align, baseline:"alphabetic", ink:selected ? INK.select : INK.text}, scale);
    }
  }

  // ------------------------------------------------------------------ factories
  function make(kind, at, o = {}) {
    const base = {id:A.id(), kind};
    const xy = {x:at[0], y:at[1]};
    switch (kind) {
      case "power": return {...base, ...xy, text:o.text || "GND", style:o.style || "gnd", direction:o.direction ?? (["gnd", "signal", "earth"].includes(o.style || "gnd") ? 3 : 1), showName:o.showName ?? true};
      case "port": return {...base, ...xy, text:o.text || "PORT", io:o.io || "unspecified", angle:o.angle || 0, ...(o.width ? {width:o.width} : {})};
      case "offsheet": {
        const io = A.offsheetIO(o.io);
        return {...base, ...xy, text:o.text || "NET", angle:o.angle || 0, ...(io !== "unspecified" ? {io} : {})};
      }
      case "sheetsymbol": return {...base, ...xy, w:o.w || 20.32, h:o.h || 15.24, name:o.name || "U_Sheet", sheet:o.sheet || "", ...(o.file ? {file:o.file} : {}), entries:o.entries || []};
      case "bus": return {...base, points:o.points};
      case "busentry": return {...base, ...xy, angle:o.angle || 0};
      case "noerc": return {...base, ...xy};
      case "frame": return {...base, ...xy, kind:"textframe", role:"frame", w:o.w, h:o.h, text:o.text || "Frame"};
      case "textframe": return {...base, ...xy, w:o.w, h:o.h, text:o.text || "", ...(o.note ? {note:true} : {})};
      case "image": return {...base, ...xy, w:o.w, h:o.h, src:o.src};
    }
    throw Error("Unknown schematic object " + kind);
  }
  // Entries for a child's ports, spread down the left (inputs) and right (others) edges.
  function portsOf(doc) {
    const out = [], seen = new Set();
    for (const i of doc?.items || []) {
      const port = i.kind === "port" ? {name:i.text, io:i.io} : i.kind === "netlabel" && i.schPaint?.type === "port" ? {name:i.text, io:"unspecified"} : null;
      if (port && port.name && !seen.has(port.name)) {seen.add(port.name); out.push(port);}
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, "en", {numeric:true}));
  }
  function layoutEntries(ports, existing = []) {
    const have = new Set(existing.map(e => e.name)), sides = {left:[], right:[]};
    for (const e of existing) if (sides[e.side]) sides[e.side].push(e.offset);
    const out = [];
    for (const p of ports) {
      if (have.has(p.name)) continue;
      const side = p.io === "output" ? "right" : "left", used = sides[side];
      let offset = GRID * 2; while (used.includes(offset)) offset += GRID * 2;
      used.push(offset); out.push({id:A.id(), name:p.name, side, offset, io:p.io || "unspecified"});
    }
    return out;
  }
  // Grows the symbol to hold its entries; snug (placement, Fit to entries) sizes it to them exactly,
  // on the grid, no smaller than 4 x 3 grid units. A symbol without entries keeps its size.
  function fitSymbol(s, o = {}) {
    const side = k => s.entries.filter(e => k.includes(e.side));
    const rows = Math.max(0, ...side(["left", "right"]).map(e => e.offset)), cols = Math.max(0, ...side(["top", "bottom"]).map(e => e.offset));
    const wide = k => Math.max(0, ...side([k]).map(e => textWidth(e.name, SIZE * .85) + 4));
    const h = rows + GRID * 2, w = Math.max(Math.ceil((Math.max(wide("left") + wide("right"), 2 * Math.max(wide("left"), wide("right"))) + 4) / GRID) * GRID, cols + GRID * 2);
    if (o.snug && s.entries.length) {s.h = Math.max(h, GRID * 3); s.w = Math.max(w, GRID * 4); return s;}
    s.h = Math.max(s.h || 0, h); s.w = Math.max(s.w || 0, w);
    return s;
  }
  // Altium "Synchronize Sheet Entries and Ports": add entries for new child ports; report
  // entries that no longer match a port. Returns {added, unmatched}.
  function syncEntries(symbol, child, parent, defs = new Map()) {
    const previous = parent ? symbol.entries.map(entry => [entry, entryPoint(symbol, entry)]) : [];
    const ports = portsOf(child), names = new Set(ports.map(p => p.name));
    const added = layoutEntries(ports, symbol.entries);
    symbol.entries.push(...added);
    for (const e of symbol.entries) {const p = ports.find(q => q.name === e.name); if (p && e.io !== p.io && p.io !== "unspecified") e.io = p.io;}
    fitSymbol(symbol);
    const moved = new Map();
    for (const [entry, at] of previous) {
      const next = entryPoint(symbol, entry);
      if (!A.same(at, next)) moved.set(A.pointKey(at), next);
    }
    if (moved.size) {
      const attachments = A.schematicAttachments(parent, defs, previous.map(([, at]) => at), new Set([symbol.id]));
      attachments.apply(at => moved.get(A.pointKey(at)));
      attachments.finish();
    }
    return {added:added.map(e => e.name), unmatched:symbol.entries.filter(e => !names.has(e.name) && !names.has(repeatEntry(e.name))).map(e => e.name)};
  }

  // ------------------------------------------------------------------ editor tools
  // The editor calls command(action, ctx). Interactive placement runs while the editor's
  // tool is "sch-place": click(p), preview(p), rotate(step), finish() and cancel().
  const COMMANDS = {
    "sch-power":"Power port", "sch-port":"Port", "sch-offsheet":"Off sheet connector", "sch-sheet-symbol":"Sheet symbol",
    "sch-sheet-entry":"Sheet entry", "sch-bus":"Bus", "sch-bus-entry":"Bus entry", "sch-noerc":"Generic No ERC", "sch-text":"Text string",
    "sch-frame":"Frame", "sch-textframe":"Text frame", "sch-note":"Note", "sch-line":"Line", "sch-rect":"Rectangle", "sch-arc":"Arc", "sch-polygon":"Polygon",
    "sch-image":"Image", "sch-hierarchy-up":"Up hierarchy", "sch-hierarchy-down":"Down hierarchy", "sch-sync-entries":"Synchronize sheet entries and ports",
    "sch-hop-overs":"Hop-over wire crossings"
  };
  const handles = a => Object.hasOwn(COMMANDS, a);
  const el=(...args)=>AtriumNavCommon.el(...args), button=(label,fn,cls)=>cls==="sch-entry-remove"?AtriumNavCommon.button(label,fn,cls+" ui-dismiss-glyph ui-dismiss-glyph-small"):AtriumNavCommon.actionButton(label,fn,cls);
  // A Place command loads its tools on demand. Focusing or pointing at the command may prepare them.
  const T = () => globalThis.AtriumSchObjectTools;
  function command(a, c, target) {
    if (T()) return T().command(a, c, target);
    if (!globalThis.AtriumLazy) return Promise.reject(Error("This feature is unavailable in this build."));
    const doc = target && c.doc();
    return AtriumLazy.need("AtriumSchObjectTools").then(t => (!target || c.doc() === doc) && t.command(a, c, target));
  }
  const click = p => T()?.click(p), preview = p => T()?.preview(p) ?? null, finish = () => T()?.finish() ?? false;
  const rotate = step => T()?.rotate(step) ?? false, cancel = () => T()?.cancel(), active = () => !!T()?.active(), floating = () => T()?.floating() ?? null;
  const descend = (symbol, entry, c) => command("sch-hierarchy-down", c, {symbol, entry}).catch(e=>c.info(e.message));
  const toolHost = {el, button, descend, grid:GRID};
  const rotatable = i => (i?.kind==="image" && !!i.asset && globalThis.AtriumLabs?.notebookEnabled()!==false) || ["power", "port", "offsheet", "busentry"].includes(i?.kind);
  function rotateItem(i, step) {
    if (i.kind === "power") i.direction = ((i.direction || 0) + (step < 0 ? 1 : 3)) % 4;
    else i.angle = ((i.angle || 0) + (step < 0 ? 270 : 90)) % 360;
  }
  // Double-click: a sheet symbol (or one of its entries) opens the child sheet; a port on a
  // child sheet goes up to the parent's matching entry.
  function dblclick(item, p, c) {
    if(globalThis.AtriumLabs?.notebookEnabled()===false && A.notebookItemKind(item))return true;
    if (item?.kind==="image" && item.asset || item?.richText ||
        item?.kind==="textframe" && (item.widget || item.calculation || item.math===true)) {
      if (T() || globalThis.AtriumLazy) command("edit-notebook-object",c,item).catch(e=>c.info(e.message));
      return true;
    }
    if (item?.kind === "sheetsymbol") {descend(item, entryAt(item, p, 1.5), c); return true;}
    if (item && (item.kind === "port" || item.kind === "netlabel" && item.schPaint?.type === "port")) {
      const parent = globalThis.AtriumHierarchy?.parentOf(c.project(), c.doc().id);
      if (!parent) return false;
      command("sch-hierarchy-up", c, {parent, port:item});
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ inspector
  const LABELS = {power:"Power port", port:"Port", offsheet:"Off sheet connector", sheetsymbol:"Sheet symbol", bus:"Bus", busentry:"Bus entry",
    noerc:"No ERC", textframe:"Text frame", image:"Image"};
  function addControls(parent, build, info) {
    if (globalThis.AtriumSchObjectInspector) build(globalThis.AtriumSchObjectInspector, parent);
    else globalThis.AtriumLazy?.appendOnLoad("AtriumSchObjectInspector", parent, build, info);
  }
  function inspector(s, item, c) {
    if (item.kind === "bus" || item.kind === "busentry" || item.kind === "noerc") return;
    addControls(s, (ui, target) => ui.inspector(target, item, c, toolHost), c.info);
  }
  // Signal and tag directive fields (Signal, Polarity, Tags) for net labels, ports, power ports, off-sheet
  // connectors and wires: they act on the board live (signals.js).
  function directives(s, item, c) {
    if (!DIRECTIVE_KINDS.has(item.kind)) return;
    addControls(s, (ui, target) => ui.directives?.(target, item, c, toolHost), c.info);
  }
  function partParameters(panel, part, def, c) {
    addControls(panel, (ui, target) => ui.partParameters(target, part, def, c, toolHost), c.info);
  }
  return {floating, KINDS, POWER, POWER_TITLES, IO, offsheetIO:A.offsheetIO, SIDES, INK, COMMANDS, LABELS, isBus, busMembers, busWidth, busKind, busAlias, busNetworks,
    isFrame, frameBounds, frameContents, grips, reflow, resizeAt, COMPONENT_KINDS, componentKind, notElectrical, repeatOf, repeatEntry, entryPoint, entryAngle, busEntryEnd,
    hotspots, netSources, portShape, box, hit, entryBox, entryAt, edgeAt, validateItem, draw, hops, hopPath, shownParams, drawParams, make, portsOf, layoutEntries,
    fitSymbol, syncEntries, handles, command, click, preview, finish, rotate, rotatable, rotateItem, cancel, active, dblclick, inspector,
    partParameters, directives, toolHost, owns:i => KINDS.has(i?.kind)};
})();
globalThis.document && addEventListener("DOMContentLoaded", () => {
  const N = globalThis.AtriumNavCommon, id = "sch-noerc-unused";
  N?.menuItem("place", id, "Directives » No ERC on Unused Pins", {after:"sch-noerc", scope:"schematic"});
  try {globalThis.AtriumKeymap?.registerCommand?.({id, title:"Place No ERC on unused pins (selected parts or sheet)", category:"Place", action:id, when:"schematic", defaultKeys:[]});} catch {}
  N?.ready(h => h.registerAction(id, () => (globalThis.AtriumLazy ? AtriumLazy.need(["AtriumSchPlace", "AtriumERC"]) : Promise.resolve()).then(() => AtriumSchPlace.noErcCommand(h), e => h.info(e.message))));
}, {once:true});
