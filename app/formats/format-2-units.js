"use strict";
// Decimal-to-native conversion uses integer arithmetic before entering the editor's mm model.
globalThis.AtriumFormat2Units = (() => {
  const NM_PER_MM = 1000000;
  const NDEG_PER_DEG = 1000000000;
  const TURN = 360000000000n;
  const MAX = BigInt(Number.MAX_SAFE_INTEGER);
  const abs = n => n < 0n ? -n : n;

  function split(value) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
      throw Error("Expected a decimal quantity.");
    }
    const source = String(value);
    const match = source.length <= 2048 && /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(source);
    if (!match || Math.abs(Number(match[5] || 0)) > 1024) throw Error("Invalid decimal quantity.");
    const fractional = match[3] ?? match[4] ?? "";
    const digits = ((match[2] || "") + fractional).replace(/^0+/, "") || "0";
    return {negative: match[1] === "-" && digits !== "0", digits, shift: Number(match[5] || 0) - fractional.length};
  }
  function decimal(value) {
    const {negative, digits, shift} = split(value);
    if (digits === "0") return "0";
    let body;
    if (shift >= 0) body = digits + "0".repeat(shift);
    else {
      const point = digits.length + shift;
      body = point > 0 ? digits.slice(0, point) + "." + digits.slice(point) : "0." + "0".repeat(-point) + digits;
      body = body.replace(/0+$/, "").replace(/\.$/, "");
    }
    return (negative ? "-" : "") + body;
  }
  function isDecimal(value) {
    return typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(value) && value !== "-0";
  }
  function fraction(value) {
    if (value && typeof value === "object") {
      const {numerator, denominator} = value;
      if (!/^-?\d{1,2048}$/.test(String(numerator)) || !/^\d{1,2048}$/.test(String(denominator)) ||
          BigInt(denominator) <= 0n) throw Error("Invalid exact quantity fraction.");
      return [BigInt(numerator), BigInt(denominator)];
    }
    const {negative, digits, shift} = split(value);
    const n = BigInt(digits) * (negative ? -1n : 1n);
    return shift < 0 ? [n, 10n ** BigInt(-shift)] : [n * 10n ** BigInt(shift), 1n];
  }
  function gcd(a, b) {
    a = abs(a);
    while (b !== 0n) [a, b] = [b, a % b];
    return a;
  }
  function safe(n) {
    if (abs(n) > MAX) throw Error("Quantity is outside the interoperable integer range.");
    return Number(n);
  }
  function quantize(input, scale, wrap) {
    let [n, d] = fraction(input);
    n *= BigInt(scale);
    let value = n / d;
    const twice = 2n * abs(n % d);
    if (twice > d || twice === d && abs(value) % 2n === 1n) value += n < 0n ? -1n : 1n;
    const offset = n - value * d;
    const divisor = offset === 0n ? 1n : gcd(offset, d);
    return {
      value: safe(wrap ? (value % TURN + TURN) % TURN : value),
      residual: offset === 0n ? null : {numerator: String(offset / divisor), denominator: String(d / divisor)},
    };
  }
  const length = value => quantize(value, NM_PER_MM, false);
  const angle = (value, {signed = false} = {}) => quantize(value, NDEG_PER_DEG, !signed);
  const mm = nm => nm / NM_PER_MM;
  const degrees = nanodegrees => nanodegrees / NDEG_PER_DEG;
  return Object.freeze({NM_PER_MM, NDEG_PER_DEG, decimal, isDecimal, length, angle, mm, degrees});
})();
