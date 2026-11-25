"use strict";
// Both simulators write a text preamble followed immediately by the data. The newline
// terminating Binary: is part of the header. A binary float can itself start with whitespace.
const MAX_SAMPLES = 2_000_000, HEADER_BYTES = 1_048_576;
const invalid = reason => { throw Error("Invalid SPICE rawfile: " + reason + "."); };

function encoding(bytes) {
  if (bytes[0] === 255 && bytes[1] === 254 || bytes[1] === 0) return "utf-16le";
  if (bytes[0] === 254 && bytes[1] === 255 || bytes[0] === 0) return "utf-16be";
  return "utf-8";
}

function decode(bytes, enc = encoding(bytes)) {
  if (typeof TextDecoder === "function") return new TextDecoder(enc).decode(bytes);
  // The standalone JavaScriptCore harness has no TextDecoder.
  const chars = [], wide = enc !== "utf-8", big = enc === "utf-16be";
  for (let i = 0; i < bytes.length; i += wide ? 2 : 1)
    chars.push(String.fromCharCode(wide ? (big ? bytes[i] * 256 + bytes[i + 1] : bytes[i] + bytes[i + 1] * 256) : bytes[i]));
  return chars.join("").replace(/^\uFEFF/, "");
}

function header(bytes) {
  const enc = encoding(bytes), width = enc === "utf-8" ? 1 : 2, lowByte = enc === "utf-16be" ? 1 : 0;
  const vars = [], fields = Object.create(null);
  let start = 0, listing = false;
  for (let i = 0; i + width <= Math.min(bytes.length, HEADER_BYTES); i += width) {
    // UTF-16: a newline is the code unit 0x000A, not any unit with a 0x0A byte (U+0A0A, U+010A…).
    if (bytes[i + lowByte] !== 10 || width === 2 && bytes[i + 1 - lowByte] !== 0) continue;
    const line = decode(bytes.subarray(start, i), enc).trim();
    start = i + width;
    if (/^(binary|values):$/i.test(line)) return {fields, vars, offset: start, enc, ascii: /^values/i.test(line)};
    const field = /^([\w. ]+):\s*(.*)$/.exec(line);
    if (field) {
      const key = field[1].toLowerCase();
      fields[key] = field[2]; listing = key === "variables"; continue;
    }
    if (listing && line) {
      const match = /^(\d+)\s+(\S+)\s+(\S+)/.exec(line);
      if (!match || Number(match[1]) !== vars.length) invalid("invalid variable index");
      vars.push({name: match[2], kind: match[3].toLowerCase()});
    }
  }
  invalid("missing data header");
}

function binaryReader(bytes, h, engine, points, complex, op) {
  const n = h.vars.length, size = bytes.byteLength - h.offset;
  const scalar = complex ? 16 : 8;
  let widths = Array(n).fill(scalar);
  // LTspice normally stores a double axis and float real traces. Its higher precision
  // setting stores doubles throughout. AC traces are complex double pairs.
  if (engine === "ltspice" && size !== n * points * scalar) {
    if (!complex && op && size === n * points * 4) widths.fill(4);
    else { widths.fill(complex ? 16 : 4); widths[0] = 8; }
  }
  const offsets = [], view = new DataView(bytes.buffer, bytes.byteOffset + h.offset, size);
  let stride = 0;
  for (const width of widths) { offsets.push(stride); stride += width; }
  if (size !== points * stride) invalid("binary size does not match the declared samples");
  const planar = /\bfastaccess\b/i.test(h.fields.flags);
  const little = engine === "ltspice" || new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  return (row, col) => {
    const width = widths[col], at = planar ? offsets[col] * points + row * width : row * stride + offsets[col];
    return [width === 4 ? view.getFloat32(at, little) : view.getFloat64(at, little), width === 16 ? view.getFloat64(at + 8, little) : 0];
  };
}

function asciiReader(bytes, h, complex) {
  const data = decode(bytes.subarray(h.offset), h.enc), word = /\S+/g;
  const next = () => { const m = word.exec(data); if (!m) invalid("missing ASCII value"); return m[0]; };
  function read(row, col) {
    if (!col && next() !== String(row)) invalid("incorrect ASCII point index");
    const parts = next().replace(/^\(|\)$/g, "").split(",");
    if (!parts[0] || parts.length !== (complex ? 2 : 1) || (complex && !parts[1])) invalid("invalid ASCII value");
    return [Number(parts[0]), complex ? Number(parts[1]) : 0];
  }
  read.finish = () => { if (word.exec(data)) invalid("more ASCII values than declared"); };
  return read;
}

function parse(bytes, engine, analysis, design = {}) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const h = header(bytes), n = Number(h.fields["no. variables"]), points = Number(h.fields["no. points"]);
  if (!Number.isSafeInteger(n) || n < 1 || n !== h.vars.length || !Number.isSafeInteger(points) || points < 1 || points * n > MAX_SAMPLES)
    invalid("missing, inconsistent or excessive sample counts");
  const type = analysis.type, op = type === "op", ac = type === "ac", complex = /\bcomplex\b/i.test(h.fields.flags);
  const plots = {op: /operating point/i, tran: /transient/i, ac: /\bac\b/i, dc: /\bdc\b/i};
  if (!plots[type]?.test(h.fields.plotname) || ac !== complex || op && points !== 1) invalid("the plot does not match the selected analysis");
  if (/\bstepped\b/i.test(h.fields.flags)) invalid("stepped plots require separate benches");
  const read = h.ascii ? asciiReader(bytes, h, complex) : binaryReader(bytes, h, engine, points, complex, op);
  const nodeNames = new Map(Object.keys(design.nodeMap || {}).map(n => [n.toLowerCase(), n]));
  const elementNames = new Map((design.elements || []).map(e => e.line.split(/\s+/)[0]).map(n => [n.toLowerCase(), n]));
  const nodes = Object.create(null), currents = Object.create(null), signals = [], x = [];
  const columns = h.vars.map(({name, kind}, j) => {
    if (!op && j === 0) return null; // scale, including v(v-sweep) / i(i-sweep)
    const wrapper = /^(v|i)\((.+)\)$/i.exec(name), branch = /^(.*)#branch$/i.exec(name);
    const current = branch || (wrapper ? wrapper[1].toLowerCase() === "i" : kind.includes("current"));
    if (!current && !wrapper && kind !== "voltage") return null;
    const raw = wrapper?.[2] || branch?.[1] || name, k = current ? "i" : "v";
    const id = (current ? elementNames : nodeNames).get(raw.toLowerCase()) || raw;
    const signal = {name: k + "(" + id + ")", kind: k, re: [], ...(ac ? {im: []} : {})};
    if (!op) signals.push(signal);
    return {id, current, signal};
  });
  for (let row = 0; row < points; row++) for (let j = 0; j < n; j++) {
    const [re, im] = read(row, j), col = columns[j];
    if (!Number.isFinite(re) || col && complex && !Number.isFinite(im)) invalid("non-finite sample");
    if (!op && j === 0) x.push(engine === "ltspice" && type === "tran" ? Math.abs(re) : re);
    if (!col) continue;
    if (op) { (col.current ? currents : nodes)[col.id] = re; x.push(re); }
    else { col.signal.re.push(re); if (ac) col.signal.im.push(im); }
  }
  read.finish?.();
  return {type, analysis, title: h.fields.title || "", x, warnings: [], stats: {},
    ...(op ? {nodes, currents, devices: {}} : {xName: ac ? "frequency" : type === "dc" ? analysis.source : "time", signals})};
}

module.exports = {parse, decode};
