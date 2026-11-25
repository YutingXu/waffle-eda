"use strict";

// One little-endian three-slot stdio frame for Node. Callers pack arguments
// and encode responses; this module owns exact reads, the 12-byte header,
// and complete writes. Slot lengths are UTF-8 byte counts.
const fs = require("node:fs");

function readExact(size, allowEnd = false, incomplete = "Incomplete request.") {
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const length = fs.readSync(0, buffer, offset, size - offset);
    if (!length) { if (allowEnd && !offset) return null; throw Error(incomplete); }
    offset += length;
  }
  return buffer;
}

function writeExact(contents) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  for (let sent = 0; sent < bytes.length;) sent += fs.writeSync(1, bytes, sent, bytes.length - sent);
}

function readFrame(incomplete = "Incomplete request.") {
  const header = readExact(12, true, incomplete);
  if (!header) return null;
  const lengths = [header.readUInt32LE(0), header.readUInt32LE(4), header.readUInt32LE(8)];
  const slots = lengths.map(length => readExact(length, false, incomplete).toString("utf8"));
  return {lengths, slots, large: lengths[1] + lengths[2] >= 1048576};
}

module.exports = {readExact, writeExact, readFrame};
