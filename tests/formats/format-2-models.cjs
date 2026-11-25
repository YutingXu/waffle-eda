"use strict";

const assert = require("node:assert/strict");
for (const name of ["zip", "source-file", "sexpr", "vendor/zipjs-deflate", "format-2-models"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const {encode, decode, verify} = AtriumFormat2Models, {sha256} = AtriumSourceFile;
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const step = new TextEncoder().encode("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n");
const ref = {byteLength: 62, sha256: "26bc00aab228090c3200c04badb0b00620df848f2fef515cd61dff8a07e85a7c"};
const gzip = encode(step);
assert.equal(hex(gzip), "1f8b08000000000002fff30cf6d73534303630d63532b4e6f2707574710db2e672f573097675b6e672710c7144f080b4ae278a7a00ff45e3cd3e000000");
assert.deepEqual(decode(gzip, ref), step);
const storedBlock = Uint8Array.of(...gzip.subarray(0, 10), 1, 62, 0, 193, 255, ...step, ...gzip.subarray(-8));
assert.deepEqual(decode(storedBlock, ref), step, "decode also accepts a bounded RFC 1951 stored block");
const legacy = Uint8Array.of(0x78, 0xda, ...gzip.subarray(10, -8), 0xc2, 0x4f, 0x0e, 0x08);
assert.deepEqual(AtriumFormat2Models.inflateLegacy(legacy), step);
assert.throws(() => AtriumFormat2Models.inflateLegacy(Uint8Array.of(...legacy, ...legacy)), /trailing/);
const corruptLegacy = legacy.slice(); corruptLegacy[corruptLegacy.length - 1] ^= 1;
assert.throws(() => AtriumFormat2Models.inflateLegacy(corruptLegacy), /checksum/);
assert.equal(hex(encode(new ArrayBuffer(0))), "1f8b08000000000002ff03000000000000000000");

// Independently compressed by stock zlib 1.2.12, level 9, 15-bit window and memory level 8.
// The mixed literal and repeated runs distinguish stock output from the older early-block heuristic.
const vectors = [
  [0, "repeat", "9ceffb7310338057cfe71a4ae1e2c98d2c485d81cdef906532a801f457a38d64"],
  [16383, "random", "ee4ecc28cc406f8f1bbddceae03761b237933ad7e458cc9fc0877ad08b9bea18"],
  [16384, "random", "1c1b90476933fcfe138bad54a18921642b9824a278ab589e9b89623c0948fd7f"],
  [32768, "repeat", "e6ca9ffe477adde00551aa50bfc4e27a16a20bcaaf8fbb7a5a86afbab85b9001"],
  [65537, "mixed", "498db70c1fadfb4cdba050f36a55c793a26c6f6d5dfccea2a5e1cfefd47ebdcf"],
  [131073, "mixed", "738b59ec31ca7e1d92e1e00d05a69549caf521c8d06edae616bce37ef6cb9129"]
];
for (const [length, kind, compressedDigest] of vectors) {
  const bytes = new Uint8Array(length + 4).subarray(2, length + 2);
  let seed = 0x27892ae3;
  for (let i = 0; i < length; i++) {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    if (kind === "random" || (kind === "mixed" && i % 2048 < 512)) bytes[i] = seed >>> 24;
    else if (kind === "repeat") bytes[i] = i % 251;
  }
  const original = sha256(bytes), compressed = encode(bytes);
  assert.equal(sha256(compressed), compressedDigest);
  const padded = new Uint8Array(compressed.length + 4);
  padded.set(compressed, 2);
  const result = decode(padded.subarray(2, -2), {sha256: original, byteLength: length});
  assert.ok(result.every((v, i) => v === bytes[i]) && result.length === length && sha256(bytes) === original);
}

const originalStored = hex(gzip);
for (const at of [0, 3, 4, 8, 9, gzip.length - 8, gzip.length - 4]) {
  const changed = gzip.slice(); changed[at] ^= 1;
  assert.throws(() => decode(changed, ref), /gzip/i);
}
assert.throws(() => decode(gzip, {...ref, sha256: "0".repeat(64)}), /SHA-256/);
assert.throws(() => decode(gzip, {...ref, byteLength: -1}), /length/);
assert.throws(() => decode(gzip, {...ref, byteLength: 32 * 1048576 + 1}), /oversized/);
const small = gzip.slice();
new DataView(small.buffer).setUint32(small.length - 4, 1, true);
assert.throws(() => decode(small, {...ref, byteLength: 1}), /declared size/);
const surplus = Uint8Array.of(...gzip, ...gzip);
assert.throws(() => decode(surplus, ref), /trailing/);
const trailing = Uint8Array.of(...gzip.subarray(0, -8), 0, ...gzip.subarray(-8));
assert.throws(() => decode(trailing, ref), /trailing/);
assert.throws(() => decode(gzip.subarray(0, -1), ref));
assert.throws(() => encode(step, {signal: {aborted: true}}), /cancelled/);
assert.throws(() => decode(gzip, {...ref, signal: {aborted: true}}), /cancelled/);
assert.equal(hex(gzip), originalStored);
globalThis.__testDone = (async () => {
  const crc = gzip.slice(); crc[crc.length-8] ^= 1;
  assert.deepEqual(await verify(gzip, ref), {length:step.length, sha256:ref.sha256});
  await assert.rejects(verify(gzip, {...ref, sha256:"0".repeat(64)}), /SHA-256/);
  await assert.rejects(verify(crc, ref), /CRC32/);
  await assert.rejects(verify(surplus, ref), /trailing/);
  await assert.rejects(verify(gzip, {...ref, signal:{aborted:true}}), /cancelled/);
  console.log("ok - canonical model gzip, bounded single-member decoding and exact source bytes");
})().catch(error => {console.error(error);process.exitCode=1;});
