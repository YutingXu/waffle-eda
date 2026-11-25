"use strict";

// The native format worker loads this codec only for a model payload. Project and
// library references use the original byte length and SHA-256, including for .stp aliases.
globalThis.AtriumFormat2Models = (() => {
  const header = Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 255);
  const maxBytes = 32 * 1048576; // Same per-model limit as the native STEP reader.
  const maxStored = header.length + maxBytes + 5 * (Math.floor(maxBytes / 16383) + 1) + 8;

  function bytes(input) {
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input) && input.BYTES_PER_ELEMENT === 1)
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw Error("Expected binary model bytes.");
  }
  function check(signal) {
    if (signal?.aborted) throw Object.assign(Error("Model operation cancelled."), {name: "AbortError"});
  }
  function encode(input, {signal} = {}) {
    check(signal);
    const raw = bytes(input);
    if (raw.length > maxBytes) throw Error("The model exceeds the STEP byte limit.");
    const writer = new globalThis.AtriumZipDeflate({level: 9});
    const first = writer.append(raw, signal && (() => check(signal)));
    const last = writer.flush();
    const stored = new Uint8Array(header.length + (first?.length || 0) + last.length + 8);
    stored.set(header);
    if (first) stored.set(first, header.length);
    stored.set(last, stored.length - 8 - last.length);
    const trailer = new DataView(stored.buffer, stored.length - 8);
    trailer.setUint32(0, globalThis.AtriumZip.crc32(raw), true);
    trailer.setUint32(4, raw.length, true);
    check(signal);
    return stored;
  }
  function inflate(input, {sha256, byteLength, signal}) {
    check(signal);
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw Error("Expected the model's full lowercase SHA-256.");
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maxBytes) throw Error("Invalid or oversized model byte length.");
    const stored = bytes(input);
    if (stored.length < header.length + 2 + 8 || stored.length > maxStored || !header.every((value, i) => stored[i] === value))
      throw Error("Invalid native model gzip header or stored size.");
    const trailer = new DataView(stored.buffer, stored.byteOffset + stored.length - 8, 8);
    if (trailer.getUint32(4, true) !== byteLength) throw Error("The model gzip size differs from its reference.");
    // Exact mode consumes one complete DEFLATE stream and caps expansion at the declared length.
    const raw = globalThis.AtriumImportFormats.inflate(stored.subarray(header.length, -8), byteLength, byteLength, true);
    if (globalThis.AtriumZip.crc32(raw) !== trailer.getUint32(0, true)) throw Error("Invalid model gzip CRC32.");
    return raw;
  }
  function verifyDigest(actual, {sha256, signal}) {
    if (actual !== sha256) throw Error("The model bytes differ from their SHA-256 filename.");
    check(signal);
  }
  function decode(input, options = {}) {
    const raw = inflate(input, options);
    verifyDigest(globalThis.AtriumSourceFile.sha256(raw), options);
    return raw;
  }
  async function verify(input, options = {}) {
    const raw = inflate(input, options);
    const crypto = globalThis.crypto?.subtle;
    // Both implementations hash the inflated bytes after the exact frame and CRC checks.
    const sha256 = crypto ?
      Array.from(new Uint8Array(await crypto.digest("SHA-256", raw)), b => b.toString(16).padStart(2, "0")).join("") :
      globalThis.AtriumSourceFile.sha256(raw);
    verifyDigest(sha256, options);
    return {length:raw.length, sha256};
  }
  function inflateLegacy(input) {
    const stored = bytes(input);
    if (stored.length > maxStored) throw Error("The legacy model exceeds the STEP byte limit.");
    return globalThis.AtriumImportFormats.inflateStepBytes(stored, true);
  }
  return Object.freeze({encode, decode, verify, inflateLegacy});
})();
