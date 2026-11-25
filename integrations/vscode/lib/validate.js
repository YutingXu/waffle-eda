"use strict";
// Bounded checks for the JSON Schema keywords used by Waffle's published row schemas.
const typeOf = v => v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
const typeMatches = (v, t) => t === "number" ? typeof v === "number" && Number.isFinite(v) : t === "integer" ? Number.isInteger(v) : typeOf(v) === t;
const jsonKey = value => {
  if (Array.isArray(value)) return "[" + value.map(jsonKey).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ":" + jsonKey(value[key])).join(",") + "}";
  return JSON.stringify(value);
};
const same = (a, b) => a === b || typeof a === "object" && typeof b === "object" && jsonKey(a) === jsonKey(b);
const show = v => { const s = JSON.stringify(v); return s && s.length > 40 ? s.slice(0, 37) + "…" : s; };

function checkSchema(value, schema, {limit = 200} = {}) {
  const errors = [], root = schema, patterns = new Map();
  const resolve = ref => {
    const match = /^#\/(definitions|\$defs)\/([\w-]+)$/.exec(ref);
    if (!match) throw Error("Unsupported $ref " + ref);
    const table = root[match[1]];
    if (!table || !Object.hasOwn(table, match[2])) throw Error("Unknown $ref " + ref);
    return table[match[2]];
  };
  const regex = p => { if (!patterns.has(p)) patterns.set(p, new RegExp(p, "u")); return patterns.get(p); };
  // Returns true when valid; pushes errors only when `out` is given (sub-schemas of
  // anyOf/if are probed silently).
  function check(v, s, path, out) {
    if (errors.length >= limit) return false;
    if (s === true || s == null) return true;
    if (s === false) { out?.push({path, message: "This property is not allowed."}); return false; }
    let ok = !s.$ref || check(v, resolve(s.$ref), path, out);
    const err = message => { ok = false; out?.push({path, message}); };
    if (s.type) {
      const types = [].concat(s.type);
      if (!types.some(t => typeMatches(v, t))) { err("Expected " + types.join(" or ") + ", found " + typeOf(v) + "."); return false; }
    }
    if ("const" in s && !same(v, s.const)) err("Expected " + show(s.const) + ".");
    if (s.enum && !s.enum.some(e => same(e, v))) err("Expected one of " + s.enum.map(show).join(", ") + ".");
    if (typeof v === "number") {
      if (s.minimum != null && v < s.minimum) err("Must be at least " + s.minimum + ".");
      if (s.maximum != null && v > s.maximum) err("Must be at most " + s.maximum + ".");
      if (typeof s.exclusiveMinimum === "number" && v <= s.exclusiveMinimum) err("Must be greater than " + s.exclusiveMinimum + ".");
      if (typeof s.exclusiveMaximum === "number" && v >= s.exclusiveMaximum) err("Must be less than " + s.exclusiveMaximum + ".");
    }
    if (typeof v === "string") {
      if (s.minLength != null && v.length < s.minLength) err(s.minLength === 1 ? "Must not be empty." : "Must be at least " + s.minLength + " characters.");
      if (s.maxLength != null && v.length > s.maxLength) err("Must be at most " + s.maxLength + " characters.");
      if (s.pattern && !regex(s.pattern).test(v)) err("Does not match " + s.pattern + ".");
    }
    if (Array.isArray(v)) {
      if (s.minItems != null && v.length < s.minItems) err("Needs at least " + s.minItems + " entr" + (s.minItems === 1 ? "y." : "ies."));
      if (s.maxItems != null && v.length > s.maxItems) err("Allows at most " + s.maxItems + " entries.");
      if (s.uniqueItems && new Set(v.map(jsonKey)).size !== v.length) err("Entries must be unique.");
      const prefix = s.prefixItems || (Array.isArray(s.items) ? s.items : []);
      const rest = Array.isArray(s.items) ? s.additionalItems : s.items;
      for (let k = 0; k < v.length; k++) {
        if (!check(v[k], k < prefix.length ? prefix[k] : rest, path.concat(k), out)) {
          ok = false;
          if (!out) return false;
        }
      }
      if ("contains" in s) {
        const count = v.reduce((n, item) => n + +check(item, s.contains, path, null), 0);
        if (count < (s.minContains ?? 1) || count > (s.maxContains ?? Infinity)) err("Array entries do not meet the required match count.");
      }
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const key of s.required || []) if (!Object.hasOwn(v, key)) err("Missing required property \"" + key + "\".");
      const props = s.properties || {};
      for (const key of Object.keys(v)) {
        let matched = false;
        const location = path.concat(key);
        if ("propertyNames" in s && !check(key, s.propertyNames, location, out)) ok = false;
        if (Object.hasOwn(props, key)) {
          matched = true;
          if (!check(v[key], props[key], location, out)) ok = false;
        }
        for (const [pattern, part] of Object.entries(s.patternProperties || {})) {
          if (!regex(pattern).test(key)) continue;
          matched = true;
          if (!check(v[key], part, location, out)) ok = false;
        }
        if (!matched && "additionalProperties" in s && !check(v[key], s.additionalProperties, location, out)) ok = false;
        if (!ok && !out) return false;
      }
    }
    for (const sub of s.allOf || []) if (!check(v, sub, path, out)) ok = false;
    if (s.anyOf && !s.anyOf.some(sub => check(v, sub, path, null))) err(anyOfMessage(s.anyOf));
    if (s.oneOf && s.oneOf.filter(sub => check(v, sub, path, null)).length !== 1) err("Must match exactly one of the allowed shapes.");
    if ("not" in s && check(v, s.not, path, null)) err("This value is not allowed.");
    if ("if" in s) {
      const branch = check(v, s.if, path, null) ? s.then : s.else;
      if (!check(v, branch, path, out)) ok = false;
    }
    return ok;
  }
  const anyOfMessage = list => list.every(x => x.required?.length === 1) ? "Needs one of " + list.map(x => "\"" + x.required[0] + "\"").join(" or ") + "." : "Does not match any allowed shape.";
  check(value, schema, [], errors);
  return errors.slice(0, limit);
}

function nativeRowSchema(schema, file, row, header) {
  const owner = file.header.kind;
  const record = (owner === "import-index" ? "importIndex" : owner) + "Record";
  const knownOwner = Object.hasOwn(schema.$defs, record);
  let target;
  if (header) target = knownOwner ? "header" : "opaqueHeader";
  else target = !knownOwner || file.isOpaque(row.id) ? "opaqueRecord" : record;
  return {$defs: schema.$defs, $ref: "#/$defs/" + target};
}

module.exports = {checkSchema, nativeRowSchema};
