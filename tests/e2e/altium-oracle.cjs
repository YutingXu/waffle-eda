"use strict";
// Independent minimal reader for Altium Designer binary PcbDoc files: the test oracle.
//
// It shares no code with the importer (app/formats/pcb-import.js, app/formats/io.js) or the vendored CFB
// library. The compound-file container and the record layouts are written from the public
// format descriptions (MS-CFB; the Altium layouts documented by the KiCad and pyAltiumLib
// readers). It reads only what the end-to-end suite compares: copper primitives, pads with
// their stack and alternate shapes, vias, nets, components, the board outline and region
// counts. Coordinates are in millimetres with Altium's Y axis kept (Y up).
//
// Keep it small and obvious. When the importer and this reader disagree, read the bytes.

const MM = 2.54e-6;  // one Altium internal unit (1/10000 mil) in millimetres

// ------------------------------------------------------------------ MS-CFB container
function compoundFile(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (!sig.every((b, i) => u8[i] === b)) throw Error("not a compound file");
  const sectorSize = 1 << v.getUint16(0x1e, true), miniSize = 1 << v.getUint16(0x20, true);
  const cutoff = v.getUint32(0x38, true);
  const sector = n => (n + 1) * sectorSize;
  const END = 0xfffffffe, FREE = 0xffffffff;
  // DIFAT: 109 entries in the header, then a chain of DIFAT sectors.
  const fatSectors = [];
  for (let i = 0; i < 109; i++) { const s = v.getUint32(0x4c + 4 * i, true); if (s < END) fatSectors.push(s); }
  let difat = v.getUint32(0x44, true), guard = 0;
  while (difat < END && guard++ < 1e5) {
    const at = sector(difat), n = sectorSize / 4 - 1;
    for (let i = 0; i < n; i++) { const s = v.getUint32(at + 4 * i, true); if (s < END) fatSectors.push(s); }
    difat = v.getUint32(at + 4 * n, true);
  }
  const fat = [];
  for (const s of fatSectors) for (let i = 0; i < sectorSize / 4; i++) fat.push(v.getUint32(sector(s) + 4 * i, true));
  function chain(start, table) {
    const out = [];
    for (let s = start, n = 0; s < END && s !== FREE; s = table[s]) {
      if (n++ > table.length) throw Error("cyclic sector chain");
      out.push(s);
    }
    return out;
  }
  function readChain(start, size) {
    const out = new Uint8Array(size);
    let o = 0;
    for (const s of chain(start, fat)) {
      const n = Math.min(sectorSize, size - o);
      if (n <= 0) break;
      out.set(u8.subarray(sector(s), sector(s) + n), o); o += n;
    }
    return out;
  }
  const dirBytes = (() => {
    const list = chain(v.getUint32(0x30, true), fat), out = new Uint8Array(list.length * sectorSize);
    list.forEach((s, i) => out.set(u8.subarray(sector(s), sector(s) + sectorSize), i * sectorSize));
    return out;
  })();
  const dv = new DataView(dirBytes.buffer);
  const entries = [];
  for (let at = 0; at + 128 <= dirBytes.length; at += 128) {
    const len = dv.getUint16(at + 64, true);
    let name = "";
    for (let i = 0; i + 2 < len; i += 2) name += String.fromCharCode(dv.getUint16(at + i, true));
    entries.push({name, type:dirBytes[at + 66], left:dv.getUint32(at + 68, true), right:dv.getUint32(at + 72, true),
      child:dv.getUint32(at + 76, true), start:dv.getUint32(at + 116, true), size:dv.getUint32(at + 120, true)});
  }
  const root = entries[0];
  const miniStream = readChain(root.start, root.size);
  const miniFat = (() => {
    const out = [], first = v.getUint32(0x3c, true);
    for (const s of chain(first, fat)) for (let i = 0; i < sectorSize / 4; i++) out.push(v.getUint32(sector(s) + 4 * i, true));
    return out;
  })();
  function readMini(start, size) {
    const out = new Uint8Array(size);
    let o = 0;
    for (const s of chain(start, miniFat)) {
      const n = Math.min(miniSize, size - o);
      if (n <= 0) break;
      out.set(miniStream.subarray(s * miniSize, s * miniSize + n), o); o += n;
    }
    return out;
  }
  // Walk the red-black tree of each storage. Paths are lower-case, "/"-separated.
  const streams = new Map();
  function walk(id, prefix, depth) {
    if (id >= entries.length || id === FREE || depth > 64) return;
    const e = entries[id];
    walk(e.left, prefix, depth + 1);
    const path = prefix + e.name.toLowerCase();
    if (e.type === 2) streams.set(path, e.size < cutoff ? readMini(e.start, e.size) : readChain(e.start, e.size));
    if (e.type === 1) walk(e.child, path + "/", depth + 1);
    walk(e.right, prefix, depth + 1);
  }
  walk(root.child, "", 0);
  return streams;
}

// ------------------------------------------------------------------ record framing
function latin1(u8) { let s = ""; for (const c of u8) s += String.fromCharCode(c); return s; }
function properties(text) {
  const out = {};
  for (const field of text.replace(/\0+$/, "").split("|")) {
    const eq = field.indexOf("=");
    if (eq > 0) out[field.slice(0, eq).toUpperCase()] = field.slice(eq + 1);
  }
  return out;
}
// Text record streams: [u32 length][|KEY=VALUE|...\0] repeated.
function textRecords(data) {
  const out = [];
  if (!data) return out;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = 0; at + 4 <= data.length;) {
    const n = v.getUint32(at, true) & 0x00ffffff; at += 4;
    if (at + n > data.length) break;
    out.push(properties(latin1(data.subarray(at, at + n)))); at += n;
  }
  return out;
}
// Binary primitive streams: [u8 type] then a fixed number of [u32 length][bytes] blocks.
function binaryRecords(data, blocksFor) {
  const out = [];
  if (!data) return out;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = 0; at < data.length;) {
    const type = data[at++], blocks = [], count = blocksFor(type);
    if (!count) throw Error("unexpected record type " + type);
    for (let k = 0; k < count; k++) {
      const n = v.getUint32(at, true); at += 4;
      if (at + n > data.length) throw Error("truncated record");
      blocks.push(data.subarray(at, at + n)); at += n;
    }
    out.push({type, blocks});
  }
  return out;
}

// ------------------------------------------------------------------ layers
// Altium's legacy layer numbers. Copper: 1 top, 2..31 mid layers, 32 bottom; 39..54 planes.
function layerName(n) {
  if (n === 1) return "top";
  if (n === 32) return "bottom";
  if (n >= 2 && n <= 31) return "mid" + (n - 1);
  if (n >= 39 && n <= 54) return "plane" + (n - 38);
  return ({33:"top-overlay", 34:"bottom-overlay", 35:"top-paste", 36:"bottom-paste", 37:"top-solder", 38:"bottom-solder",
    55:"drill-guide", 56:"keepout", 73:"drill-drawing", 74:"multi"})[n] || (n >= 57 && n <= 72 ? "mech" + (n - 56) : "layer" + n);
}
const isCopper = name => name === "top" || name === "bottom" || /^mid\d+$/.test(name) || name === "multi";

// ------------------------------------------------------------------ board reader
function readBoard(bytes) { return readStreams(compoundFile(bytes)); }
function readStreams(s) {
  const get = name => s.get(name.toLowerCase() + "/data");
  const nets = textRecords(get("Nets6")).map(p => p.NAME || "");
  const components = textRecords(get("Components6")).map(p => ({
    designator:p.SOURCEDESIGNATOR || "", layer:/BOTTOM/i.test(p.LAYER || "") ? "bottom" : "top",
    x:mil(p.X), y:mil(p.Y), rotation:Number(p.ROTATION || 0), footprint:p.PATTERN || "",
    // Locked, or tied to others in a union or group: Altium does not let it move on its own.
    fixed:/^(true|t|1)$/i.test(p.LOCKED || "") || Number(p.UNIONINDEX || 0) !== 0 || Number(p.GROUPNUM || 0) !== 0}));
  const boardProps = textRecords(get("Board6"))[0] || {};
  const outline = [];
  for (let i = 0; boardProps["VX" + i] != null; i++) {
    outline.push({x:mil(boardProps["VX" + i]), y:mil(boardProps["VY" + i]), arc:Number(boardProps["KIND" + i] || 0) === 1,
      cx:mil(boardProps["CX" + i]), cy:mil(boardProps["CY" + i]), r:mil(boardProps["R" + i]),
      sa:Number(boardProps["SA" + i] || 0), ea:Number(boardProps["EA" + i] || 0)});
  }
  // Copper is named by its position in the layer stack (Board6 LAYER<id>NEXT chain from the top),
  // as fabrication outputs number it: the k-th layer below the top is "mid<k>" whatever its id.
  const stack = new Map();
  for (let id = 1, i = 0, guard = 0; id && guard++ < 64; id = Number(boardProps["LAYER" + id + "NEXT"]) || 0, i++) {
    if (boardProps["LAYER" + id + "NAME"] == null) break;
    stack.set(id, i);
    if (id === 32) { for (const [k, v] of stack) stack.set(k, k === 32 ? "bottom" : v === 0 ? "top" : "mid" + v); break; }
  }
  const complete = stack.get(32) === "bottom";
  const layerOf = n => (complete && typeof stack.get(n) === "string" ? stack.get(n) : layerName(n));
  const net = i => (i === 0xffff ? "" : nets[i] ?? "?" + i);
  const owner = i => (i === 0xffff ? null : components[i]?.designator ?? "?" + i);
  const common = (g) => {
    const dv = new DataView(g.buffer, g.byteOffset, g.byteLength);
    return {dv, layer:layerOf(g[0]), keepout:g[2] === 2, net:net(dv.getUint16(3, true)), polygon:dv.getUint16(5, true),
      component:owner(dv.getUint16(7, true)), i32:o => dv.getInt32(o, true) * MM, f64:o => dv.getFloat64(o, true)};
  };

  const tracks = binaryRecords(get("Tracks6"), t => t === 4 ? 1 : 0).map(({blocks:[g]}) => {
    const c = common(g);
    return {layer:c.layer, net:c.net, polygon:c.polygon, component:c.component, keepout:c.keepout,
      x1:c.i32(13), y1:c.i32(17), x2:c.i32(21), y2:c.i32(25), width:c.i32(29)};
  });
  const arcs = binaryRecords(get("Arcs6"), t => t === 1 ? 1 : 0).map(({blocks:[g]}) => {
    const c = common(g);
    return {layer:c.layer, net:c.net, polygon:c.polygon, component:c.component, keepout:c.keepout,
      cx:c.i32(13), cy:c.i32(17), r:c.i32(21), start:c.f64(25), end:c.f64(33), width:c.i32(41)};
  });
  const vias = binaryRecords(get("Vias6"), t => t === 3 ? 1 : 0).map(({blocks:[g]}) => {
    const c = common(g);
    // Flag bit 2 of the primitive header is "unlocked"; an owned or pour-generated via moves with its owner.
    return {net:c.net, x:c.i32(13), y:c.i32(17), diameter:c.i32(21), drill:c.i32(25),
      from:layerOf(g[29]), to:layerOf(g[30]), fixed:c.component != null || c.polygon !== 0xffff || (g[1] & 4) === 0};
  });
  const fills = binaryRecords(get("Fills6"), t => t === 6 ? 1 : 0).map(({blocks:[g]}) => {
    const c = common(g);
    return {layer:c.layer, net:c.net, component:c.component, keepout:c.keepout,
      x1:c.i32(13), y1:c.i32(17), x2:c.i32(21), y2:c.i32(25), rotation:c.f64(29)};
  });
  // Pads: name, three reserved blocks, the size-and-shape block, the per-layer extension.
  const SHAPE = {1:"round", 2:"rect", 3:"octagonal", 9:"roundrect"};
  const pads = binaryRecords(get("Pads6"), t => t === 2 ? 6 : 0).map(({blocks}) => {
    const name = latin1(blocks[0].subarray(1, 1 + blocks[0][0]));
    const g = blocks[4], c = common(g), x = blocks[5];
    const mode = g[62];  // 0 simple, 1 top-middle-bottom, 2 full stack
    const rows = {top:[21, 49], mid:[29, 50], bottom:[37, 51]};
    const stack = {};
    for (const [face, [size, shape]] of Object.entries(rows))
      stack[face] = {w:c.i32(size), h:c.i32(size + 4), shape:SHAPE[g[shape]] || "shape" + g[shape], cornerPct:null};
    // The extension: 29 inner sizes (x, then y), 29 inner shapes, 1 reserved, hole shape, slot
    // size and rotation, 32 hole offsets (x, then y), 1 reserved, 32 alternate shapes, 32 corner
    // radii in percent. Index 0 is the top layer, 31 the bottom layer.
    if (x && x.length >= 596) {
      const alt = i => x[532 + i], radius = i => x[564 + i];
      for (const [face, index] of [["top", 0], ["bottom", 31]])
        if (alt(index) === 9) Object.assign(stack[face], {shape:"roundrect", cornerPct:radius(index)});
    }
    if (mode === 0) { stack.mid = {...stack.top}; stack.bottom = {...stack.top}; }
    const cx = c.i32(13), cy = c.i32(17), rotation = c.f64(52);
    let drill = c.i32(45), slot = null;
    if (x && x.length >= 275 && x[262] === 2) {
      // At zero hole rotation the base dimension is along local Y, and the
      // extended one is along local X. Both axes follow the pad and hole rotations.
      const xv = new DataView(x.buffer, x.byteOffset, x.byteLength);
      const sizeX = xv.getInt32(263, true) * MM, sizeY = drill, holeTurn = xv.getFloat64(267, true);
      if (sizeX > 0 && sizeY > 0 && Number.isFinite(holeTurn)) {
        drill = Math.min(sizeX, sizeY);
        const path = Math.abs(sizeX - sizeY), length = drill + path;
        if (path > 0) {
          const turn = (rotation + holeTurn) * Math.PI / 180;
          const axis = sizeX > sizeY ? [Math.cos(turn), Math.sin(turn)] : [-Math.sin(turn), Math.cos(turn)];
          const ends = [-path / 2, path / 2].map(step => [cx + step * axis[0], cy + step * axis[1]]);
          slot = {width:drill, length, rotation:holeTurn, sizeX, sizeY, ends};
        }
      }
    }
    return {name, layer:c.layer, net:c.net, component:c.component, x:cx, y:cy,
      drill, rotation, plated:g[60] !== 0, mode, stack, slot};
  });
  // Regions: count by kind and layer only (the suite compares filled area through the plots).
  const regions = binaryRecords(get("Regions6"), t => t === 11 ? 1 : 0).map(({blocks:[g]}) => {
    const c = common(g), dv = c.dv, n = dv.getUint32(18, true);
    const p = properties(latin1(g.subarray(22, 22 + n)));
    return {layer:c.layer, net:c.net, polygon:c.polygon, component:c.component, kind:Number(p.KIND || 0),
      cutout:/^TRUE$/i.test(p.ISBOARDCUTOUT || ""), keepout:c.keepout};
  });
  const polygons = textRecords(get("Polygons6")).map(p => ({layer:p.LAYER || "", net:p.NET != null ? net(+p.NET) : "",
    type:p.POLYGONTYPE || "", hatch:p.HATCHSTYLE || "", name:p.NAME || ""}));
  return {nets, components, outline, tracks, arcs, vias, fills, pads, regions, polygons,
    origin:{x:mil(boardProps.ORIGINX), y:mil(boardProps.ORIGINY)}};
}

// Board6 and Components6 coordinates are written as "1234.5mil".
function mil(s) {
  if (s == null || s === "") return 0;
  const m = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*(mil|mm)?\s*$/i.exec(String(s));
  if (!m) return NaN;
  return (m[2] || "mil").toLowerCase() === "mm" ? +m[1] : +m[1] * 0.0254;
}

// Pin-to-net groups the board itself records: each net's sorted "REF.PAD" members.
function padNetGroups(board) {
  const groups = new Map();
  for (const p of board.pads) {
    if (!p.net || !p.component) continue;
    if (!groups.has(p.net)) groups.set(p.net, new Set());
    groups.get(p.net).add(p.component + "." + p.name);
  }
  return groups;
}

// Serialise binary records again (tests that build a variant of a real board).
function writeRecords(records) {
  const parts = [];
  for (const {type, blocks} of records) {
    parts.push(Uint8Array.of(type));
    for (const b of blocks) { const n = new Uint8Array(4); new DataView(n.buffer).setUint32(0, b.length, true); parts.push(n, b); }
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

module.exports = {compoundFile, readBoard, readStreams, writeRecords, textRecords, binaryRecords, layerName, isCopper, padNetGroups, MM};
