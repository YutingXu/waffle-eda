"use strict";

// Store-only ZIP writer. Entries are written without compression, so the
// archive needs no inflate code and opens in every ZIP reader.
//   AtriumZip.create([{name, data}], {date}) -> Uint8Array
// `data` is a string (encoded as UTF-8) or a Uint8Array. `date` (optional, on
// the options or on each entry) sets the DOS modification time; it defaults
// to the current local time.
globalThis.AtriumZip = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  // Carry the previous result across consecutive chunks, starting at zero.
  function crc32(bytes, previous = 0) {
    let c = previous ^ 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function utf8(text) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(text);
    const out = [];
    for (let i = 0; i < text.length; i++) {
      let c = text.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) {
        const d = text.charCodeAt(i + 1);
        if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
      }
      if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | c >> 6, 0x80 | c & 63);
      else if (c < 0x10000) out.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
      else out.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    }
    return Uint8Array.from(out);
  }
  function dosTime(date) {
    const d = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
    const year = Math.min(2107, Math.max(1980, d.getFullYear()));
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }
  function entryName(name) {
    const clean = String(name ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!clean || clean.split("/").some(part => part === "..") || /[\u0000-\u001f]/.test(clean)) throw Error("Invalid ZIP entry name: " + name);
    return clean;
  }
  function create(entries, options = {}) {
    if (!Array.isArray(entries)) throw Error("ZIP entries must be an array.");
    if (entries.length > 0xfffe) throw Error("Too many ZIP entries.");
    const seen = new Set(), files = [];
    let size = 22, centralSize = 0;
    for (const entry of entries) {
      const name = entryName(entry?.name), nameBytes = utf8(name);
      if (seen.has(name)) throw Error("Duplicate ZIP entry name: " + name);
      seen.add(name);
      const data = typeof entry.data === "string" ? utf8(entry.data) : entry.data instanceof Uint8Array ? entry.data : null;
      if (!data) throw Error("ZIP entry data must be a string or Uint8Array: " + name);
      if (nameBytes.length > 0xffff) throw Error("ZIP entry name is too long: " + name);
      files.push({nameBytes, data, crc: crc32(data), stamp: dosTime(entry.date || options.date)});
      size += 30 + nameBytes.length + data.length + 46 + nameBytes.length;
      centralSize += 46 + nameBytes.length;
    }
    if (size > 0xffffffff) throw Error("The ZIP archive exceeds 4 GB.");
    const out = new Uint8Array(size), view = new DataView(out.buffer);
    let pos = 0;
    const u16 = v => { view.setUint16(pos, v, true); pos += 2; };
    const u32 = v => { view.setUint32(pos, v >>> 0, true); pos += 4; };
    const flags = 0x0800; // UTF-8 names
    for (const f of files) {
      f.offset = pos;
      u32(0x04034b50); u16(20); u16(flags); u16(0); u16(f.stamp.time); u16(f.stamp.date);
      u32(f.crc); u32(f.data.length); u32(f.data.length); u16(f.nameBytes.length); u16(0);
      out.set(f.nameBytes, pos); pos += f.nameBytes.length;
      out.set(f.data, pos); pos += f.data.length;
    }
    const central = pos;
    for (const f of files) {
      u32(0x02014b50); u16(options.portableFiles ? 0x0314 : 20); u16(20); u16(flags); u16(0); u16(f.stamp.time); u16(f.stamp.date);
      u32(f.crc); u32(f.data.length); u32(f.data.length); u16(f.nameBytes.length); u16(0); u16(0);
      u16(0); u16(0); u32(options.portableFiles ? 0o100644 * 65536 : 0); u32(f.offset);
      out.set(f.nameBytes, pos); pos += f.nameBytes.length;
    }
    u32(0x06054b50); u16(0); u16(0); u16(files.length); u16(files.length); u32(centralSize); u32(central); u16(0);
    return out;
  }
  return Object.freeze({create, crc32, utf8});
})();
