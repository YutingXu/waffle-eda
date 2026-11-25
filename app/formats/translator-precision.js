"use strict";
// A foreign serializer may recover one physical scalar from an adopted import. Work on
// the emitted primitive only: hit testing, cached copper and editable geometry stay native.
globalThis.AtriumTranslatorPrecision = (() => {
  const U = globalThis.AtriumFormat2Units, M = globalThis.AtriumFormat2Model;
  const NM = 1000000, NDEG = 1000000000n;
  const coordinates = new Set(["part", "pad", "via", "label", "junction", "netlabel", "power", "port", "offsheet",
    "sheetsymbol", "noerc", "busentry"]);
  const paths = new Set(["track", "graphic", "polygon", "wire", "bus"]);
  const sizes = new Set(["width", "height", "size", "diameter", "drill", "w", "h", "slotLength",
    "maskExpansion", "pasteExpansion", "clearance", "hatchWidth", "hatchPitch", "minPrimLength", "neckWidth"]);
  const limits = new Set(["gap", "gapMin", "gapMax", "gapPreferred", "widthMin", "widthMax", "widthPreferred",
    "holeMin", "clearance", "expansion", "airGap", "conductorWidth", "reliefConductorWidth", "reliefAirGap",
    "minWeb", "setbackMin", "setbackMax", "maxUncoupled"]);
  const own = (obj, key) => obj != null && Object.hasOwn(obj, key);

  function index(groups, projectId) {
    const byOwner = new Map();
    for (const group of Array.isArray(groups) ? groups : [groups]) {
      const scope = group?.precision;
      if (scope?.version !== 1 || !scope.scopeId || !Array.isArray(scope.documents) || !Array.isArray(scope.rows)) continue;
      const documents = new Set(scope.documents);
      const libraries = new Set((group.files || []).flatMap(file => file.library || []));
      const oldKinds = new Map();
      for (const field of group.fields || []) {
        if (field.type !== "item") continue;
        const record = /^(vias|components)6?\/data#\d+$/i.exec(field.values?.sourceRecord || "");
        if (record) oldKinds.set(field.id, record[1].toLowerCase() === "vias" ? "via" : "part");
      }
      for (const row of scope.rows) {
        if (!row || typeof row.owner !== "string" || typeof row.id !== "string" || typeof row.property !== "string") continue;
        if (!documents.has(row.owner) && !libraries.has(row.owner) && row.owner !== projectId) continue;
        if (!byOwner.has(row.owner)) byOwner.set(row.owner, new Map());
        const owner = byOwner.get(row.owner);
        if (!owner.has(row.id)) owner.set(row.id, new Map());
        const fields = owner.get(row.id);
        // Independent imports claiming the same native field are ambiguous, even if one
        // happens to match its current number. A same-named item in another owner is fine.
        fields.set(row.property, fields.has(row.property) ? null : {row, documents, libraries, oldKind:documents.size === 1 && documents.has(row.owner) ? oldKinds.get(row.id) : undefined});
      }
    }
    return byOwner;
  }
  function nearest(n, d) {
    const q = n / d, rem = n % d, twice = (rem < 0n ? -rem : rem) * 2n;
    return twice > d || twice === d && q % 2n !== 0n ? q + (n < 0n ? -1n : 1n) : q;
  }
  function targetLength(exact, target, schematic) {
    if (target === "gerber") {
      // Stroke geometry is scaled and rotated before the Gerber writer rounds its output grid.
      const text = decimalFraction(BigInt(exact.numerator), BigInt(exact.denominator) * BigInt(NM));
      return text === null ? null : Number(text);
    }
    // PCB/sheet KiCad files allow 1 nm and 100 nm respectively. Each Altium tick is 127/50 nm.
    const step = target === "altium" ? 127n : schematic ? 100n : 1n;
    const divisor = target === "altium" ? 50n : 1n;
    const ticks = nearest(BigInt(exact.numerator) * divisor, BigInt(exact.denominator) * step);
    return Number(ticks * step) / (Number(divisor) * NM);
  }

  function decimalFraction(n, d) {
    const sign = n < 0n ? "-" : "";
    if (n < 0n) n = -n;
    const whole = n / d;
    let rem = n % d, digits = "";
    // Source decimal quantities terminate. Keep the authored value if the
    // proposed exact fraction has no finite decimal representation.
    while (rem && digits.length < 2058) {
      rem *= 10n;
      digits += String(rem / d);
      rem %= d;
    }
    return rem ? null : sign + String(whole) + (digits ? "." + digits : "");
  }
  function decimalAngle(n, d) {
    const turn = 360n * d;
    return decimalFraction((n % turn + turn) % turn, d);
  }
  function angle(clockwise) {
    const value = Number(clockwise || 0);
    if (Number.isInteger(value)) {
      const signed = -value % 360;
      return String(signed < 0 ? signed + 360 : signed || 0);
    }
    const native = U.angle(-value).value;
    if (value === (360 - U.degrees(native)) % 360 || value === -U.degrees(native))
      return decimalAngle(BigInt(native), NDEG);
    const [whole, frac = ""] = U.decimal(-value).split(".");
    return decimalAngle(BigInt(whole + frac), 10n ** BigInt(frac.length));
  }
  const legendLayer = layer => layer === "Silk" || layer === "Bottom silk";
  const inkSizes = new Set(["width","height","size","strokeWidth","margin"]);
  function filmPath(kind, parts, item) {
    if (kind === "track" && parts.length === 3 && parts[0] === "points" &&
        /^(0|[1-9]\d*)$/.test(parts[1]) && /^[01]$/.test(parts[2])) return parts;
    if (kind === "label") {
      if (legendLayer(item.layer || "Silk") && parts.length === 2 && parts[0] === "sourceTextBox" && inkSizes.has(parts[1])) return parts;
      return null;
    }
    const [list, ordinal, field, child] = parts;
    if (kind !== "part" || !["boardLabels","hiddenBoardLabels"].includes(list) || !/^(0|[1-9]\d*)$/.test(ordinal)) return null;
    const row = item[list]?.[ordinal];
    if (!row || !["ref","value"].includes(row.field) || !legendLayer(row.layer)) return null;
    if (parts.length === 3 && ["width","size","margin"].includes(field)) return parts;
    if (parts.length === 4 && (field === "at" && /^[01]$/.test(child) || field === "sourceTextBox" && inkSizes.has(child))) return parts;
    return null;
  }
  function pathFor(kind, pointer, wrapped, target, item) {
    const parts = pointer.slice(1).split("/").map(key => key.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (target === "gerber") return filmPath(kind, parts, item);
    if (wrapped && parts.length === 1 && (parts[0] === "x" || parts[0] === "y"))
      return target === "kicad" ? parts : null; // KiCad pads are relative; Altium uses the placed world transform.
    if (!wrapped && parts.length === 2 && parts[0] === "at" && coordinates.has(kind) && /^[01]$/.test(parts[1]))
      return [parts[1] === "0" ? "x" : "y"];
    if (parts.length === 3 && parts[0] === "points" && paths.has(kind) && /^(0|[1-9]\d*)$/.test(parts[1]) && /^[01]$/.test(parts[2])) return parts;
    if (kind === "rule") {
      if (limits.has(parts.at(-1)) && (parts.length === 1 || parts.length === 3 && ["layers", "kinds"].includes(parts[0]))) return parts;
    } else if (coordinates.has(kind) || paths.has(kind)) {
      if (parts.length === 1 && sizes.has(parts[0])) return parts;
      if (kind === "pad" && parts.length === 3 && parts[0] === "padStack" && ["Top", "Mid", "Bottom"].includes(parts[1]) && ["w", "h"].includes(parts[2])) return parts;
    }
    return null;
  }
  function valueAt(object, path) {
    let value = object;
    for (const key of path) {
      if (!own(value, key)) return;
      value = value[key];
    }
    return value;
  }
  function assign(source, copies, path, value) {
    function copy(original) {
      if (!copies.has(original)) copies.set(original, Array.isArray(original) ? original.slice() : {...original});
      return copies.get(original);
    }
    let current = source;
    const result = copy(source);
    let output = result;
    for (const key of path.slice(0, -1)) {
      current = current[key];
      output = output[key] = copy(current);
    }
    output[path.at(-1)] = value;
    return result;
  }

  function forExport(project, groups, target) {
    const records = index(groups, project.id);
    if (!records.size) return null;
    const angles = new WeakMap(), originals = new WeakMap(), documents = new WeakMap(), footprints = new WeakMap();
    function unique(list) {
      const objects = new Map();
      for (const item of list) if (item.id) objects.set(item.id, objects.has(item.id) ? null : item);
      return objects;
    }
    const rules = unique(project.rules?.list || []);
    function projectFields(doc, item, owner, kind, emitted = item, wrapped = false) {
      const proofs = records.get(owner)?.get(item.id);
      if (!proofs) return emitted;
      let out = emitted;
      const turns = new Map(), copies = new Map();
      for (const [property, entry] of proofs) {
        if (!entry || (wrapped ? !entry.libraries.has(owner) : !entry.documents.has(doc.id))) continue;
        // A legacy untyped row needs independent, unambiguous original-kind evidence.
        if ((entry.row.recordKind ?? entry.oldKind) !== kind) continue;
        let value, unit, path;
        const orientation = target !== "gerber" && (property === "/angle" && ["part", "pad", "label"].includes(kind) ||
          property === "/slotAngle" && kind === "pad");
        if (orientation) {
          const current = item[property.slice(1)];
          if (!Number.isFinite(current)) continue;
          value = U.angle(-current).value; unit = "nanodeg";
          if (current !== (360 - U.degrees(value)) % 360 && current !== -U.degrees(value)) continue;
        } else {
          path = pathFor(kind, property, wrapped, target, item);
          if (!path) continue;
          const current = valueAt(item, path);
          if (!Number.isFinite(current) || Math.abs(current) > Number.MAX_SAFE_INTEGER / NM || valueAt(emitted, path) !== current) continue;
          value = U.length(current).value; unit = "nm";
          if (U.mm(value) !== current) continue;
        }
        const exact = M.restoreResidual({owner, id:item.id, recordKind:kind, property, unit, value}, entry.row);
        if (!exact) continue;
        if (orientation) {
          const text = decimalAngle(BigInt(exact.numerator), BigInt(exact.denominator) * NDEG);
          if (text !== null) turns.set(property.slice(1), text);
        } else {
          const v = targetLength(exact, target, doc.kind === "schematic");
          if (v !== null && v !== valueAt(out, path)) out = assign(emitted, copies, path, v);
        }
      }
      if (turns.size) { angles.set(item, turns); angles.set(out, turns); }
      if (out !== item) originals.set(out, item);
      return out;
    }
    function item(doc, original) {
      if (!records.has(doc.id)) return original;
      let items = documents.get(doc);
      if (!items) {
        items = new Map();
        for (const object of unique(doc.items).values()) if (object) items.set(object, null);
        documents.set(doc, items);
      }
      if (!items.has(original)) return original;
      let output = items.get(original);
      if (!output) {
        // The source-assisted writer can expose a component's native label array in the drawing table.
        // Use the current placements for the proof and keep the original item on a miss.
        const labels = target === "gerber" && original.kind === "part" && !Array.isArray(original.boardLabels)
          && doc.pcbDrawing?.annotations?.[original.sourceRecord];
        const source = Array.isArray(labels) ? {...original,boardLabels:labels} : original;
        output = projectFields(doc, source, doc.id, original.kind);
        if (output === source) output = original;
        items.set(original, output);
      }
      return output;
    }
    function footprint(doc, definition) {
      const fp = definition?.footprint;
      if (!fp || !records.has(definition.id) || !fp.pads) return fp;
      if (footprints.has(fp)) return footprints.get(fp);
      // A leaf with an authored ID survives a move/reorder. A legacy pad's ordinal
      // cannot prove which native row the current placement uses after a library edit.
      let changed = false;
      const byId = unique(fp.pads);
      const pads = fp.pads.map(pad => {
        if (byId.get(pad.id) !== pad) return pad;
        const out = projectFields(doc, pad, definition.id, "pad", pad, true);
        if (out !== pad) changed = true;
        return out;
      });
      const result = changed ? {...fp, pads} : fp;
      footprints.set(fp, result);
      return result;
    }
    function rule(doc, effective) {
      const authored = rules.get(effective.id);
      if (!authored || authored.type !== effective.type || !records.has(project.id)) return effective;
      // Effective rules can include defaults absent from the source rule. Never bind those.
      return projectFields(doc, authored, project.id, "rule", effective);
    }
    return {item, rule, footprint, original:item => originals.get(item) || item, angle:(source, key = "angle") => angles.get(source)?.get(key)};
  }
  return Object.freeze({forExport, angle});
})();
