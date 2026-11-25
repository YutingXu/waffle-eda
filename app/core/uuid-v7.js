"use strict";

// RFC 9562 UUIDv7. The logical clock never moves backwards, even on counter overflow.
globalThis.AtriumUUID = (() => {
  const maxTime = 0xffffffffffff;
  const maxTail = (1n << 74n) - 1n;

  function create(now, tailSeed) {
    let time = -1, tail = 0n;
    return () => {
      const ms = now();
      if (!Number.isFinite(ms)) throw new RangeError("Invalid UUIDv7 timestamp.");
      const measured = Math.max(0, Math.min(maxTime, Math.trunc(ms)));
      if (measured > time) {
        tail = tailSeed() & maxTail;
        time = measured;
      } else if (tail < maxTail) tail++;
      else {
        if (time === maxTime) throw new RangeError("UUIDv7 timestamp and counter exhausted.");
        tail = tailSeed() & maxTail;
        time++;
      }
      const stamp = time.toString(16).padStart(12, "0");
      const version = 0x7000 | Number(tail >> 62n);
      const variant = 0x8000 | Number(tail >> 48n & 0x3fffn);
      const end = (tail & 0xffffffffffffn).toString(16).padStart(12, "0");
      return stamp.slice(0, 8) + "-" + stamp.slice(8) + "-" + version.toString(16) + "-" + variant.toString(16) + "-" + end;
    };
  }

  // Bare headless engines start with independent OS entropy supplied by their host.
  const seed = globalThis.__waffleUUIDSeed;
  delete globalThis.__waffleUUIDSeed;
  const initial = typeof seed === "string" && /^[0-9a-f]{20}$/.test(seed) ? BigInt("0x" + seed) : null;
  let crypto = globalThis.crypto;
  if (!crypto && initial === null && typeof require === "function") {
    const nodeRequire = require;
    crypto = /** @type {{webcrypto: Crypto}} */ (nodeRequire("node:crypto")).webcrypto;
  }
  const next = create(() => Date.now(), () => {
    if (crypto?.getRandomValues) {
      let tail = 0n;
      for (const byte of crypto.getRandomValues(new Uint8Array(10))) tail = tail << 8n | BigInt(byte);
      return tail;
    }
    if (initial !== null) return initial;
    throw Error("Secure UUIDv7 entropy is unavailable.");
  });
  const isV7 = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  return {next, isV7, create};
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumUUID;
