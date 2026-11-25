"use strict";
// Standard Base64 for byte payloads. Wire framing, limits, and authorization belong to callers.
globalThis.AtriumBase64 = (() => {
  // Encode complete triples at each boundary so only the last piece can have padding.
  const CHUNK = 24 * 1024;

  /** @param {Uint8Array | ArrayBuffer} input */
  function encode(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (typeof bytes.toBase64 === "function") return bytes.toBase64();
    const pieces = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      pieces.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))));
    }
    return pieces.join("");
  }

  /** @param {string} text */
  function decode(text) {
    if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(text);
    const raw = atob(text), bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  return Object.freeze({encode, decode});
})();
if (typeof module === "object" && module.exports) module.exports = globalThis.AtriumBase64;
