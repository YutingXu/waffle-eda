"use strict";
const assert = require("node:assert/strict");
require("../../app/core/base64.js");
const {encode, decode} = AtriumBase64;

for (const length of [0,1,2,3,8191,8192,8193,24575,24576,24577,32767,32768,32769,49151,49152,49153,1048576,1048577]) {
  const backing = Uint8Array.from({length:length + 8}, (_, i) => (173 * i + 7) & 255);
  const input = backing.subarray(4, 4 + length);
  const expected = Buffer.from(input).toString("base64");
  assert.equal(encode(input), expected);
  assert.equal(encode(input.slice().buffer), expected);
  assert.deepEqual(decode(expected), input);
}

assert.deepEqual(decode("  +/8=\n"), new Uint8Array([251,255]));
assert.deepEqual(decode("+/8"), new Uint8Array([251,255]));
assert.throws(() => decode("+/!"));
console.log("Standard Base64 is exact across byte views, ArrayBuffers, and fallback chunk boundaries.");
