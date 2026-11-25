"use strict";
// A small two-colour PNG, drawn from the package's own pads. Works in a worker without a DOM or canvas.
const width = 96, height = 64, stride = 1 + width / 8;
const u32 = n => [n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255];
function chunk(type, bytes) {
  const name = [...type].map(c => c.charCodeAt(0)); let crc = -1;
  for (const byte of [...name, ...bytes]) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return [...u32(bytes.length), ...name, ...bytes, ...u32(~crc)];
}
function encode(pixels) {
  let a = 1, b = 0;
  for (const x of pixels) { a = (a + x) % 65521; b = (b + a) % 65521; }
  const n = pixels.length, data = [120, 1, 1, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255, ...pixels, ...u32((b << 16) | a)];
  const png = [137, 80, 78, 71, 13, 10, 26, 10, ...chunk("IHDR", [...u32(width), ...u32(height), 1, 3, 0, 0, 0]),
    ...chunk("PLTE", [31, 44, 47, 242, 181, 107]), ...chunk("IDAT", data), ...chunk("IEND", [])];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; let result = "";
  for (let i = 0; i < png.length; i += 3) {
    const v = png[i] << 16 | (png[i + 1] || 0) << 8 | (png[i + 2] || 0);
    result += alphabet[v >>> 18] + alphabet[v >>> 12 & 63] + (i + 1 < png.length ? alphabet[v >>> 6 & 63] : "=") + (i + 2 < png.length ? alphabet[v & 63] : "=");
  }
  return "data:image/png;base64," + result;
}
module.exports = (source, name) => {
  const pads = source.slice(0, 512).filter(p => [p.x, p.y, p.w, p.h].every(Number.isFinite) && p.w > 0 && p.h > 0);
  if (!pads.length) return null;
  const bounds = pads.map(p => { const r = Math.hypot(p.w, p.h) / 2; return [p.x - r, p.y - r, p.x + r, p.y + r]; });
  const left = Math.min(...bounds.map(b => b[0])), top = Math.min(...bounds.map(b => b[1]));
  const w = Math.max(...bounds.map(b => b[2])) - left, h = Math.max(...bounds.map(b => b[3])) - top;
  const scale = Math.min((width - 8) / w, (height - 8) / h), pixels = new Uint8Array(stride * height);
  for (const p of pads) {
    const cx = width / 2 + (p.x - left - w / 2) * scale, cy = height / 2 + (p.y - top - h / 2) * scale;
    const phi = (p.angle || 0) * Math.PI / 180, cs = Math.cos(phi), sn = Math.sin(phi), r = Math.hypot(p.w, p.h) * scale / 2;
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(height, cy + r); y++) for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(width, cx + r); x++) {
      const dx = (x + 0.5 - cx) / scale, dy = (y + 0.5 - cy) / scale, px = 2 * (dx * cs + dy * sn) / p.w, py = 2 * (dy * cs - dx * sn) / p.h;
      if (Math.abs(px) > 1 || Math.abs(py) > 1 || (p.shape === "round" && px * px + py * py > 1) || Math.hypot(dx, dy) < (p.drill || 0) / 2) continue;
      pixels[y * stride + 1 + (x >> 3)] |= 128 >> (x & 7);
    }
  }
  return {kind: "png", data: encode(pixels), alt: name + ", " + pads.length + (pads.length === 1 ? " pad" : " pads")};
};
