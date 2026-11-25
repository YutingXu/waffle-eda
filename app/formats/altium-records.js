"use strict";
// One Altium record frame and one property view. The length is the low 24 bits.
// A 4-byte head carries a high-byte flag. Rules6 uses a 6-byte head: uint16 kind,
// then that length word, and rejects an empty payload. Ordinary text is Windows-1252.
// A %UTF8% field may replace the unprefixed value. CFB remains the outer container.
globalThis.AtriumAltiumRecords = (() => {
  const cp1252 = new TextDecoder("windows-1252"), utf8 = new TextDecoder();
  function frame(bytes, at, head, messages) {
    if (at + head > bytes.length) throw Error(messages[0]);
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const word = data.getUint32(at + (head === 6 ? 2 : 0), true);
    const size = word & 0xffffff, end = at + head + size;
    if ((head === 6 && !size) || end > bytes.length) throw Error(messages[1]);
    return {
      flag: head === 4 ? word >>> 24 : 0,
      kind: head === 6 ? data.getUint16(at, true) : 0,
      start: at + head, end, size, payload: bytes.subarray(at + head, end)
    };
  }
  function properties(text, stripNul, trimValue) {
    const fields = Object.create(null);
    for (const pair of (stripNul ? text.replace(/\0+$/, "") : text).split("|")) {
      const at = pair.indexOf("=");
      if (at > 0) fields[pair.slice(0, at).trim().toUpperCase()] = trimValue ? pair.slice(at + 1).trim() : pair.slice(at + 1);
    }
    return fields;
  }
  function propertyRecord(bytes, stripNul, trimValue) {
    const record = properties(cp1252.decode(bytes), stripNul, trimValue);
    if (Object.keys(record).some(key => key.startsWith("%UTF8%"))) {
      for (const [key, value] of Object.entries(properties(utf8.decode(bytes), stripNul, trimValue))) {
        if (key.startsWith("%UTF8%")) record[key.slice(6)] = value;
      }
    }
    return record;
  }
  function textLine(bytes, trimKey) {
    let line = cp1252.decode(bytes).replace(/\0+$/, "").replace(/^\|/, "");
    if (line.includes("%UTF8%")) {
      const encoded = properties(utf8.decode(bytes), true, true);
      line = line.split("|").map(field => {
        const at = field.indexOf("=");
        const key = (trimKey ? field.slice(0, at).trim() : field.slice(0, at)).toUpperCase();
        return key.startsWith("%UTF8%") && at > 0 ? field.slice(0, at + 1) + encoded[key] : field;
      }).join("|");
    }
    return line;
  }
  return {frame, properties, propertyRecord, textLine};
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumAltiumRecords;
