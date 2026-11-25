"use strict";
// The native byte model uses physical units. The current editor still uses mm and degrees.
globalThis.AtriumFormat2Values = (() => {
  const U = globalThis.AtriumFormat2Units;
  const lengths = new Set([
    "x", "y", "z", "w", "h", "r", "grid", "width", "height", "size", "fontWidth", "radius", "diameter", "thickness",
    "drill", "drillX", "drillY", "slot", "slotLength", "pitch", "step", "offset", "spacing", "length",
    "clearance", "boardClearance", "maskExpansion", "pasteExpansion", "coverlayExpansion",
    "holeMin", "setbackMin", "setbackMax", "gap", "gapMin", "gapMax", "gapPreferred", "maxUncoupled",
    "widthMin", "widthMax", "widthPreferred", "powerWidth", "conductorWidth", "reliefAirGap", "reliefConductorWidth",
    "neckWidth", "airGap", "expansion", "strokeWidth", "hatchPitch", "hatchWidth", "minPrimLength", "margin",
    "bendKeepout", "minWeb", "minStackRun", "stiffenerGap", "transition", "dz", "minZ", "maxZ",
  ]);
  const vectors = new Set([
    "at", "offset", "centre", "center", "c", "a", "b", "bounds", "outline", "points", "refAt", "valueAt",
    "origin", "position", "start", "end", "poly", "rings", "courtyard", "controlPoints", "path", "box",
  ]);
  const clockwise = new Set(["angle", "hatchAngle", "cornerAngle", "slotAngle"]);
  const scalar = new Set([
    "opacity", "roundrectRadiusRatio", "islandAreaThreshold", "dk", "df", "tempRise", "infiniteScale",
  ]);
  const geometryOwners = new Set([
    "value", "sheet", "clip", "crop", "ink", "regionShape", "pathArc", "arc", "body", "bodies3d",
    "symbol", "footprint", "stackup", "padStack", "boardShape", "pcbDrawing", "schDrawing",
    "drawing", "panel", "cells", "options", "outputs", "rules", "list", "boardLabels", "hiddenBoardLabels", "view",
    "shape", "shapes", "outline", "cutouts", "contours", "solids", "holes", "segments", "layers",
  ]);
  function nativeField(kind, path) {
    // The same names used by the native unit projection constrain the admitted physical tokens.
    // Crossing an unrecognized owner ends this projection, including explicit extension keys.
    const names = path.filter(key => typeof key === "string");
    if (!names.length || names.some(key => key.startsWith("x-"))) return;
    const key = names.pop();
    if (names.some(name => !geometryOwners.has(name))) return;
    if (kind === "widget" && path[0] === "widget") return;
    if (lengths.has(key) || clockwise.has(key) || vectors.has(key) ||
        key === "rotation" || key === "sweep" || key === "bendAngle" || (kind === "math" && key === "em")) return "integer";
  }
  // A typed decimal member distinguishes legacy author values whose field accepts either text or number.
  const NUMBER = "$number", LITERAL = "$literal";
  const jsonObject = v => !!v && typeof v === "object" && !Array.isArray(v);
  const reserved = v => Object.hasOwn(v, NUMBER) || Object.hasOwn(v, LITERAL);
  const named = (path, property) => path.concat(property);

  function physical(value, kind, path, onResidual) {
    let result;
    if (kind === "length") {
      if (typeof value === "number") {
        const exact = Math.round(value * U.NM_PER_MM);
        if (Number.isSafeInteger(exact) && U.mm(exact) === value) return exact || 0;
      }
      result = U.length(value);
    } else result = U.angle(kind === "clockwise" ? -value : value, {signed: kind === "sweep"});
    if (result.residual && onResidual) onResidual(path, result.residual, kind === "length" ? "nm" : "nanodeg", result.value);
    return result.value;
  }
  function mapArray(value, convert, path) {
    return value.map((part, index) => Array.isArray(part) ? mapArray(part, convert, named(path, index)) :
      typeof part === "number" ? convert(part, named(path, index)) : part);
  }
  const arcShape = v => v.kind === "arc" && Array.isArray(v.c) && typeof v.r === "number";
  function encode(value, key = "", path = [], onResidual, geometry = true) {
    if (key.startsWith("x-")) return value;
    if (Array.isArray(value)) {
      if (geometry && vectors.has(key)) return mapArray(value, (v, p) => physical(v, "length", p, onResidual), path);
      if (geometry && key === "rotation") return mapArray(value, (v, p) => physical(v, "angle", p, onResidual), path);
      return value.map((part, index) => encode(part, "", named(path, index), onResidual, geometry));
    }
    if (typeof value === "number") {
      if (geometry && lengths.has(key)) return physical(value, "length", path, onResidual);
      if (geometry && clockwise.has(key)) return physical(value, "clockwise", path, onResidual);
      if (geometry && (key === "sweep" || key === "bendAngle")) return physical(value, "sweep", path, onResidual);
      if (geometry && scalar.has(key)) return U.decimal(value);
      if (Number.isSafeInteger(value)) return value || 0;
      return {[NUMBER]: U.decimal(value)};
    }
    if (!jsonObject(value)) return value;
    const result = Object.create(null);
    const arc = geometry && arcShape(value) && typeof value.start === "number" && typeof value.end === "number" && typeof value.ccw === "boolean";
    for (const [name, part] of Object.entries(value)) {
      if (part === undefined || arc && (name === "start" || name === "end" || name === "ccw")) continue;
      result[name] = encode(part, name, named(path, name), onResidual, geometry);
    }
    if (arc) {
      const direction = value.ccw ? 1 : -1;
      const delta = (direction * (value.end - value.start) % 360 + 360) % 360;
      result.start = physical(value.start, "angle", named(path, "start"), onResidual);
      result.sweep = physical(direction * (delta || 360), "sweep", named(path, "sweep"), onResidual);
      if (result.sweep === 0) throw Error("Arc sweep rounds to zero.");
    }
    return reserved(value) ? {[LITERAL]: result} : result;
  }
  // Reading a physical vector needs no residual path. It can convert its leaves directly.
  function decodeVector(value, convert) {
    return value.map(part => Array.isArray(part) ? decodeVector(part, convert) :
      typeof part === "number" ? convert(part) : part);
  }
  function decode(value, key = "", literal = false, geometry = true, omit) {
    if (key.startsWith("x-")) return value;
    if (Array.isArray(value)) {
      if (geometry && vectors.has(key)) return decodeVector(value, U.mm);
      if (geometry && key === "rotation") return decodeVector(value, U.degrees);
      return value.map(part => decode(part, "", false, geometry));
    }
    if (typeof value === "number") {
      if (geometry && lengths.has(key)) return U.mm(value);
      if (geometry && clockwise.has(key)) return (360 - U.degrees(value)) % 360;
      if (geometry && (key === "sweep" || key === "bendAngle")) return U.degrees(value);
      return value;
    }
    if (!jsonObject(value)) return geometry && scalar.has(key) && U.isDecimal(value) ? Number(value) : value;
    const keys = Object.keys(value);
    if (!literal && keys.length === 1) {
      if (Object.hasOwn(value, NUMBER) && U.isDecimal(value[NUMBER])) return Number(value[NUMBER]);
      if (Object.hasOwn(value, LITERAL)) return decode(value[LITERAL], key, true, geometry);
    }
    const arc = geometry && arcShape(value) && typeof value.start === "number" && typeof value.sweep === "number";
    const result = {};
    for (const name of keys) {
      if (omit?.has(name) || arc && (name === "start" || name === "sweep")) continue;
      const part = decode(value[name], name, false, geometry);
      // JSON properties are data even when the normal object prototype defines a setter.
      if (name === "__proto__") Object.defineProperty(result, name, {value: part, writable: true, enumerable: true, configurable: true});
      else result[name] = part;
    }
    if (arc) {
      result.start = U.degrees(value.start);
      result.end = U.degrees((value.start + value.sweep + 360000000000) % 360000000000);
      result.ccw = value.sweep > 0;
    }
    return result;
  }
  function point(x, y, onResidual) {
    return [physical(x, "length", ["at", 0], onResidual), physical(y, "length", ["at", 1], onResidual)];
  }
  const decodeFields = (value, omit) => decode(value, "", false, true, omit);
  const encodeOpaque = value => encode(value, "", [], undefined, false);
  const decodeOpaque = value => decode(value, "", false, false);
  return Object.freeze({encode, decode, decodeFields, encodeOpaque, decodeOpaque, point, nativeField});
})();
