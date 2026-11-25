"use strict";

// Reads the pinned STIX Two Math TrueType font. GIDs stay identical for canvas, SVG and PDF.
// Positions returned by glyph(), constants(), variants() and kern() use em units. SVG paths
// use the original design units, with Y down at the baseline.
globalThis.AtriumMathFont = (() => {
  let bytes, data, offsets, cmap, units, glyphCount, longMetrics, longLocations;
  const glyphs = new Map(),
    paths = new Map(),
    substitutions = new Map();
  const u16 = p => data.getUint16(p),
    i16 = p => data.getInt16(p),
    u32 = p => data.getUint32(p);
  const tag = p => String.fromCharCode(...bytes.subarray(p, p + 4));
  const offset = (base, field) => {
    const n = u16(base + field);
    return n ? base + n : 0;
  };
  const constantNames = (
    "MathLeading AxisHeight AccentBaseHeight FlattenedAccentBaseHeight SubscriptShiftDown SubscriptTopMax SubscriptBaselineDropMin " +
    "SuperscriptShiftUp SuperscriptShiftUpCramped SuperscriptBottomMin SuperscriptBaselineDropMax SubSuperscriptGapMin SuperscriptBottomMaxWithSubscript " +
    "SpaceAfterScript UpperLimitGapMin UpperLimitBaselineRiseMin LowerLimitGapMin LowerLimitBaselineDropMin StackTopShiftUp StackTopDisplayStyleShiftUp " +
    "StackBottomShiftDown StackBottomDisplayStyleShiftDown StackGapMin StackDisplayStyleGapMin StretchStackTopShiftUp StretchStackBottomShiftDown " +
    "StretchStackGapAboveMin StretchStackGapBelowMin FractionNumeratorShiftUp FractionNumeratorDisplayStyleShiftUp FractionDenominatorShiftDown " +
    "FractionDenominatorDisplayStyleShiftDown FractionNumeratorGapMin FractionNumDisplayStyleGapMin FractionRuleThickness FractionDenominatorGapMin " +
    "FractionDenomDisplayStyleGapMin SkewedFractionHorizontalGap SkewedFractionVerticalGap OverbarVerticalGap OverbarRuleThickness OverbarExtraAscender " +
    "UnderbarVerticalGap UnderbarRuleThickness UnderbarExtraDescender RadicalVerticalGap RadicalDisplayStyleVerticalGap RadicalRuleThickness " +
    "RadicalExtraAscender RadicalKernBeforeDegree RadicalKernAfterDegree"
  ).split(" ");
  let constants, info, variantTable, scriptAlternates;
  function decode(base64) {
    if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(base64);
    if (typeof atob === "function") return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
      result = new Uint8Array((base64.length * 3) / 4);
    let acc = 0,
      n = 0,
      o = 0;
    for (let i = 0; i < base64.length; i++) {
      const digit = alphabet.indexOf(base64[i]);
      if (digit < 0) continue;
      acc = (acc << 6) | digit;
      n += 6;
      if (n >= 8) {
        n -= 8;
        result[o++] = (acc >> n) & 255;
      }
    }
    return result.subarray(0, o);
  }
  function load() {
    if (data) return;
    bytes = decode(globalThis.AtriumMathFontFile);
    data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    offsets = {};
    for (let i = 0; i < u16(4); i++) {
      const p = 12 + i * 16;
      offsets[tag(p)] = u32(p + 8);
    }
    units = u16(offsets.head + 18);
    glyphCount = u16(offsets.maxp + 4);
    longMetrics = u16(offsets.hhea + 34);
    longLocations = i16(offsets.head + 50);
    for (let i = 0; i < u16(offsets.cmap + 2); i++) {
      const p = offsets.cmap + 4 + 8 * i,
        table = offsets.cmap + u32(p + 4);
      if (u16(table) === 12) {
        cmap = table;
        break;
      }
    }
    const math = offsets.MATH,
      c = offset(math, 4);
    constants = {
      ScriptPercentScaleDown: i16(c) / 100,
      ScriptScriptPercentScaleDown: i16(c + 2) / 100,
      DelimitedSubFormulaMinHeight: u16(c + 4) / units,
      DisplayOperatorMinHeight: u16(c + 6) / units
    };
    constantNames.forEach((name, i) => {
      constants[name] = i16(c + 8 + 4 * i) / units;
    });
    constants.RadicalDegreeBottomRaisePercent = i16(c + 8 + 4 * constantNames.length) / 100;
    Object.freeze(constants);
    info = offset(math, 6);
    variantTable = offset(math, 8);
    scriptAlternates = featureTables("ssty");
  }
  function featureTables(name) {
    const g = offsets.GSUB;
    if (!g) return [];
    const features = offset(g, 6),
      lookups = offset(g, 8),
      out = [];
    for (let i = 0; i < u16(features); i++) {
      const p = features + 2 + 6 * i;
      if (tag(p) !== name) continue;
      const f = features + u16(p + 4);
      for (let j = 0; j < u16(f + 2); j++) {
        const index = u16(f + 4 + 2 * j),
          lookup = offset(lookups, 2 + 2 * index);
        if (u16(lookup) !== 3) continue;
        for (let k = 0; k < u16(lookup + 4); k++) out.push(offset(lookup, 6 + 2 * k));
      }
    }
    return out;
  }
  function coverage(base, id) {
    if (!base) return -1;
    const format = u16(base),
      count = u16(base + 2),
      stride = format === 1 ? 2 : 6;
    let low = 0,
      high = count - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1,
        p = base + 4 + mid * stride,
        start = u16(p),
        end = format === 1 ? start : u16(p + 2);
      if (id < start) high = mid - 1;
      else if (id > end) low = mid + 1;
      else return format === 1 ? mid : u16(p + 4) + id - start;
    }
    return -1;
  }
  function idFor(cp, level = 0) {
    load();
    let low = 0,
      high = u32(cmap + 12) - 1,
      id = 0;
    while (low <= high) {
      const mid = (low + high) >>> 1,
        p = cmap + 16 + mid * 12,
        first = u32(p),
        last = u32(p + 4);
      if (cp < first) high = mid - 1;
      else if (cp > last) low = mid + 1;
      else {
        id = u32(p + 8) + cp - first;
        break;
      }
    }
    if (!id || level < 1) return id;
    const key = id * 3 + Math.min(level, 2);
    if (substitutions.has(key)) return substitutions.get(key);
    let result = id;
    for (const t of scriptAlternates) {
      const i = coverage(offset(t, 2), id);
      if (i < 0) continue;
      const a = offset(t, 6 + i * 2),
        n = u16(a);
      if (n) result = u16(a + 2 + 2 * Math.min(n - 1, level - 1));
      break;
    }
    substitutions.set(key, result);
    return result;
  }
  function glyphOffset(id) {
    return longLocations ? u32(offsets.loca + 4 * id) : 2 * u16(offsets.loca + 2 * id);
  }
  function mathValue(field, id, fallback) {
    const t = offset(info, field);
    if (!t) return fallback;
    const i = coverage(offset(t, 0), id);
    return i < 0 ? fallback : i16(t + 4 + 4 * i) / units;
  }
  function glyph(id) {
    load();
    if (glyphs.has(id)) return glyphs.get(id);
    id = id >= 0 && id < glyphCount ? id : 0;
    const loc = glyphOffset(id),
      p = offsets.glyf + loc,
      empty = loc === glyphOffset(id + 1);
    const advance = u16(offsets.hmtx + 4 * Math.min(id, longMetrics - 1)) / units;
    const m = {
      advance,
      left: empty ? 0 : i16(p + 2) / units,
      descent: empty ? 0 : Math.max(0, -i16(p + 4) / units),
      right: empty ? 0 : i16(p + 6) / units,
      ascent: empty ? 0 : Math.max(0, i16(p + 8) / units),
      yMin: empty ? 0 : i16(p + 4) / units,
      yMax: empty ? 0 : i16(p + 8) / units,
      italic: mathValue(0, id, 0),
      accent: mathValue(2, id, advance / 2)
    };
    glyphs.set(id, Object.freeze(m));
    return m;
  }
  function kern(id, corner, height) {
    load();
    const table = offset(info, 6);
    if (!table) return 0;
    const at = coverage(offset(table, 0), id);
    if (at < 0) return 0;
    const p = offset(table, 4 + at * 8 + 2 * corner);
    if (!p) return 0;
    const count = u16(p);
    let i = 0;
    while (i < count && height >= i16(p + 2 + 4 * i) / units) i++;
    return i16(p + 2 + 4 * (count + i)) / units;
  }
  function variants(id, vertical = true) {
    load();
    const t = variantTable,
      at = coverage(offset(t, vertical ? 2 : 4), id);
    if (at < 0) return null;
    const c = offset(t, 10 + 2 * (at + (vertical ? 0 : u16(t + 6))));
    const choices = [];
    for (let i = 0; i < u16(c + 2); i++)
      choices.push({ gid: u16(c + 4 + i * 4), extent: u16(c + 6 + i * 4) / units });
    const a = offset(c, 0),
      parts = [];
    if (a)
      for (let i = 0; i < u16(a + 4); i++) {
        const p = a + 6 + i * 10;
        parts.push({
          gid: u16(p),
          start: u16(p + 2) / units,
          end: u16(p + 4) / units,
          extent: u16(p + 6) / units,
          extender: !!(u16(p + 8) & 1)
        });
      }
    return { choices, parts, minimumOverlap: u16(t) / units, italic: a ? i16(a) / units : 0 };
  }
  // TrueType simple and composite outlines (including point-number attachment of accents).
  function contours(id, depth = 0) {
    if (depth > 24 || id < 0 || id >= glyphCount || glyphOffset(id) === glyphOffset(id + 1)) return [];
    let p = offsets.glyf + glyphOffset(id);
    const count = i16(p);
    p += 10;
    if (count >= 0) {
      const ends = [];
      for (let i = 0; i < count; i++, p += 2) ends.push(u16(p));
      const n = (ends.at(-1) ?? -1) + 1;
      p += 2 + u16(p);
      const flags = [],
        xs = [],
        ys = [];
      while (flags.length < n) {
        const f = bytes[p++];
        flags.push(f);
        if (f & 8) for (let j = bytes[p++]; j; j--) flags.push(f);
      }
      for (const [axis, small, same] of [
        [xs, 2, 16],
        [ys, 4, 32]
      ]) {
        let x = 0;
        for (const f of flags) {
          if (f & small) x += (f & same ? 1 : -1) * bytes[p++];
          else if (!(f & same)) {
            x += i16(p);
            p += 2;
          }
          axis.push(x);
        }
      }
      const out = [];
      let first = 0;
      for (const end of ends) {
        const line = [];
        while (first <= end) {
          line.push([xs[first], ys[first], !!(flags[first] & 1)]);
          first++;
        }
        out.push(line);
      }
      return out;
    }
    const out = [],
      flat = [];
    let flags;
    do {
      flags = u16(p);
      const gid = u16(p + 2);
      p += 4;
      const xy = !!(flags & 2),
        words = !!(flags & 1);
      let a, b;
      if (words) {
        a = xy ? i16(p) : u16(p);
        b = xy ? i16(p + 2) : u16(p + 2);
        p += 4;
      } else {
        a = xy ? data.getInt8(p) : bytes[p];
        b = xy ? data.getInt8(p + 1) : bytes[p + 1];
        p += 2;
      }
      let xx = 1,
        xyScale = 0,
        yx = 0,
        yy = 1;
      if (flags & 8) {
        xx = yy = i16(p) / 16384;
        p += 2;
      } else if (flags & 64) {
        xx = i16(p) / 16384;
        yy = i16(p + 2) / 16384;
        p += 4;
      } else if (flags & 128) {
        xx = i16(p) / 16384;
        yx = i16(p + 2) / 16384;
        xyScale = i16(p + 4) / 16384;
        yy = i16(p + 6) / 16384;
        p += 8;
      }
      const child = contours(gid, depth + 1).map(line =>
        line.map(([x, y, on]) => [x * xx + y * xyScale, x * yx + y * yy, on])
      );
      let dx = a,
        dy = b;
      if (!xy) {
        const source = child.flat()[b],
          target = flat[a];
        dx = source && target ? target[0] - source[0] : 0;
        dy = source && target ? target[1] - source[1] : 0;
      } else if (flags & 2048) {
        dx = a * xx + b * xyScale;
        dy = a * yx + b * yy;
      }
      if (flags & 4) {
        dx = Math.round(dx);
        dy = Math.round(dy);
      }
      for (const line of child) {
        for (const pt of line) {
          pt[0] += dx;
          pt[1] += dy;
          flat.push(pt);
        }
        out.push(line);
      }
    } while (flags & 32);
    return out;
  }
  const midpoint = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, true];
  const round = n => +n.toFixed(4);
  const coords = p => round(p[0]) + " " + round(-p[1]);
  function path(id) {
    load();
    if (paths.has(id)) return paths.get(id);
    const segments = [];
    for (const pts of contours(id)) {
      if (!pts.length) continue;
      const first = pts[0],
        last = pts.at(-1),
        start = first[2] ? first : last[2] ? last : midpoint(last, first);
      segments.push("M" + coords(start));
      let control = null;
      const from = first[2] ? 1 : 0,
        to = !first[2] && last[2] ? pts.length - 1 : pts.length;
      for (let i = from; i < to; i++) {
        const pt = pts[i];
        if (pt[2]) {
          segments.push(control ? "Q" + coords(control) + " " + coords(pt) : "L" + coords(pt));
          control = null;
        } else {
          if (control) segments.push("Q" + coords(control) + " " + coords(midpoint(control, pt)));
          control = pt;
        }
      }
      if (control) segments.push("Q" + coords(control) + " " + coords(start));
      segments.push("Z");
    }
    const d = segments.join("");
    paths.set(id, d);
    return d;
  }
  function svgShapes(layout, glyphId) {
    const num = n => Number(n.toFixed(7));
    return layout.commands
      .map(c => {
        if (c.kind === "rule")
          return (
            '<rect x="' + num(c.x) + '" y="' + num(c.y) + '" width="' + num(c.w) + '" height="' + num(c.h) + '"/>'
          );
        const id = glyphId(c.gid); // Internal resource ID provided by the canvas or print host.
        if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(id)) return "";
        return (
          '<use href="#' +
          id +
          '" transform="translate(' +
          num(c.x) +
          " " +
          num(c.y) +
          ") scale(" +
          num(c.scale / units) +
          ')"/>'
        );
      })
      .join("");
  }
  return Object.freeze({
    bytes: () => {
      load();
      return bytes;
    },
    unitsPerEm: () => {
      load();
      return units;
    },
    idFor,
    glyph,
    kern,
    variants,
    path,
    svgShapes,
    constants: () => {
      load();
      return constants;
    }
  });
})();
