"use strict";

const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");

for (const [text, reference] of [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
  ["a".repeat(1_000_000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"]
]) assert.equal(createHash("sha256").update(text).digest("hex"), reference);
assert.equal(createHash("sha1").update("a").update("bc").digest("hex"), "a9993e364706816aba3e25717850c26c9cd0d89d");

const bytes = Uint8Array.from({length: 145}, (_, i) => (i * 29 + 17) & 255);
const hash = createHash("SHA-256").update("Rµ🙂")
  .update(bytes.subarray(3, 26))
  .update(new DataView(bytes.buffer, 31, 19))
  .update(new Uint16Array(bytes.buffer, 62, 25))
  .update("00ff72", "hex");
bytes.fill(0);
const binary = hash.digest();
assert.ok(Buffer.isBuffer(binary));
// Independently computed with Python hashlib over these four data chunks plus the UTF-8 prefix.
assert.equal(binary.toString("hex"), "a4df2f564ba29f6a36060bd2150681620898c8fe2c00c2a955a448be2da5af0a");
assert.throws(() => hash.update("late"));
assert.throws(() => createHash("constructor"));
if (!process.versions.node) assert.throws(() => createHash("sha512"), /unsupported/i);
console.log("PASS SHA-1 and SHA-256 vectors, chunked binary views, and unsupported algorithms");
