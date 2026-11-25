"use strict";
// Assembly variants (Altium Variant Management, KiCad 10 design variants).
//
// Data (saved in the project; validated by model.js through validate()):
//   project.variants = [{id, name, description?, parts: {<key>: <entry>}}]
//   project.activeVariant = <variant id>          // absent: the base design
//   <key>   = part.link (shared by a schematic part and its board footprint), else part.id
//   <entry> = {fitted: false}                     // not fitted in this variant
//           | {fitted: true}                      // fitted even where the base design says DNP
//           | {alternate: {def?, value?, params?}} // fitted with another library part / comment
//           | {params: {Name: "text" | null}}     // parameter overrides (null removes one)
//   An entry may combine alternate and params; fitted:false wins over an alternate.
//   The base design is "no variant": a part's existing DNP state (item.dnp, DNP or
//   Fitted parameters and comment marks, with AtriumBOM's rules when loaded) is the
//   base not-fitted state, and a variant inherits it unless its entry says otherwise.
//
// DOM-free API (outputs, automation, tests):
//   resolve(project, variant?)  -> {<key>: {key, ref, fitted, baseFitted, def, value, params, alternate, overridden, items:[{docId,id,kind}]}}
//   apply(project, variant?)    -> a resolved copy for outputs: activeVariant removed, variantApplied {id,name}|null,
//                                  each part's dnp, value and parameters set, and schematic parts' def (board
//                                  footprints keep theirs: variants never change copper). Only part objects are copied;
//                                  everything else is shared with the source, so treat the copy as read-only.
//   forOutput(project, variant?) -> the project itself when nothing changes, else apply()'s copy
//   includer(project, variant?) -> (item, def) => fitted?   (STEP / 3D include hook)
//   variant argument: undefined = the project's active variant; null or "" = the base design;
//   otherwise a variant id or name (case-insensitive). An unknown explicit variant throws.
//
// Output job sets (project.outputJobs): an output's options may carry `variant` with the same
// meaning (id or name; null or "" for the base design; absent for the active variant). Pass it to
// forOutput(project, options.variant) before generating, or to AtriumBOM.collect / report as
// settings.variant. BOM views (project.bomViews) may also store `variant`.
globalThis.AtriumVariants = (() => {
  const LIMIT = {variants: 64, name: 80, description: 1000, parts: 100000, params: 200, key: 300, text: 1000};
  const obj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const str = v => typeof v === "string";
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const clean = v => String(v ?? "").replace(/\s+/g, " ").trim();
  const sameName = (a, b) => clean(a).toUpperCase() === clean(b).toUpperCase();
  const newId = () => globalThis.Atrium?.id?.() || "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const keyOf = item => item.link || item.id;

  // ------------------------------------------------------------ validation
  function bad(msg) { throw Error("Assembly variants: " + msg); }
  function checkParams(p, where) {
    if (!obj(p)) bad(where + " parameters must be an object.");
    const keys = Object.keys(p);
    if (keys.length > LIMIT.params) bad(where + " has too many parameters.");
    for (const k of keys) {
      if (!k || k.length > LIMIT.name) bad(where + " has an invalid parameter name.");
      if (p[k] !== null && !str(p[k]) || str(p[k]) && p[k].length > LIMIT.text) bad(where + " parameter " + k + " must be text or null.");
    }
  }
  // Forward compatibility: in a project from a newer minor format (AtriumCompat marks project.variants
  // with this symbol while it validates such a file; setParts reads project.atriumCompat), fields this
  // build doesn't know are kept as they are instead of refused. In this format they are still invalid.
  const NEWER = Symbol.for("atrium.compat.newer");
  function checkEntry(e, where, lenient) {
    if (!obj(e)) bad(where + " must be an object.");
    if (!lenient) for (const k of Object.keys(e)) if (!["fitted", "alternate", "params"].includes(k)) bad(where + " has the unknown field " + k + ".");
    if (e.fitted != null && typeof e.fitted !== "boolean") bad(where + " fitted must be true or false.");
    if (e.alternate != null) {
      const a = e.alternate;
      if (!obj(a)) bad(where + " alternate must be an object.");
      if (!lenient) for (const k of Object.keys(a)) if (!["def", "value", "params"].includes(k)) bad(where + " alternate has the unknown field " + k + ".");
      if (a.def != null && (!str(a.def) || !a.def || a.def.length > LIMIT.key)) bad(where + " alternate def must be a library ID.");
      if (a.value != null && (!str(a.value) || a.value.length > LIMIT.text)) bad(where + " alternate value must be text.");
      if (a.params != null) checkParams(a.params, where + " alternate");
    }
    if (e.params != null) checkParams(e.params, where);
  }
  function validate(list) {
    if (!Array.isArray(list)) bad("project.variants must be a list.");
    if (list.length > LIMIT.variants) bad("at most " + LIMIT.variants + " variants are supported.");
    const ids = new Set(), names = new Set(), lenient = !!list[NEWER];
    for (const v of list) {
      if (!obj(v)) bad("each variant must be an object.");
      if (!str(v.id) || !v.id || v.id.length > LIMIT.key || ids.has(v.id)) bad("each variant needs a unique id.");
      ids.add(v.id);
      if (!str(v.name) || !clean(v.name) || v.name.length > LIMIT.name) bad("each variant needs a name of at most " + LIMIT.name + " characters.");
      const n = clean(v.name).toUpperCase();
      if (names.has(n)) bad("two variants are called " + v.name + ".");
      names.add(n);
      if (v.description != null && (!str(v.description) || v.description.length > LIMIT.description)) bad(v.name + " has an invalid description.");
      if (v.parts != null) {
        if (!obj(v.parts)) bad(v.name + " parts must be an object.");
        const keys = Object.keys(v.parts);
        if (keys.length > LIMIT.parts) bad(v.name + " lists too many parts.");
        for (const k of keys) { if (!k || k.length > LIMIT.key) bad(v.name + " has an invalid part key."); checkEntry(v.parts[k], v.name + " part " + k, lenient); }
      }
      if (!lenient) for (const k of Object.keys(v)) if (!["id", "name", "description", "parts"].includes(k)) bad(v.name + " has the unknown field " + k + ".");
    }
    return list;
  }

  // ------------------------------------------------------------ lookup
  const list = project => Array.isArray(project?.variants) ? project.variants.filter(v => obj(v) && str(v.id)) : [];
  function find(project, ref) {
    if (ref == null || ref === "") return null;
    if (obj(ref)) ref = ref.id;
    const all = list(project);
    return all.find(v => v.id === ref) || all.find(v => sameName(v.name, ref)) || null;
  }
  // The variant an output uses. undefined: the active one; null or "": the base design.
  function current(project, requested) {
    if (project?.variantApplied !== undefined) return null; // already resolved by apply()
    if (requested === undefined) return find(project, project?.activeVariant);
    if (requested === null || requested === "") return null;
    const v = find(project, requested);
    if (!v) throw Error("There is no assembly variant called " + (obj(requested) ? requested.name || requested.id : requested) + ". Variants: " +
      (list(project).map(x => x.name).join(", ") || "none") + ".");
    return v;
  }

  // ------------------------------------------------------------ parts
  // Every part instance grouped by key (link or id), in document order.
  function groups(project) {
    const out = new Map();
    for (const doc of project.documents || []) for (const item of doc.items || []) {
      if (item.kind !== "part") continue;
      const k = keyOf(item);
      let g = out.get(k);
      if (!g) { g = {key: k, items: []}; out.set(k, g); }
      g.items.push({doc, item});
    }
    return out;
  }
  const truthy = v => /^(1|y|yes|true|t|x|on)$/i.test(clean(v));
  const falsy = v => /^(0|n|no|false|f|off|none)$/i.test(clean(v));
  // Base not-fitted state. AtriumBOM holds the full rules (parameter spellings, comment marks).
  function baseDnp(item, def) {
    const B = globalThis.AtriumBOM;
    if (B?.isDnp) return B.isDnp(item, def);
    if (item?.dnp === false) return false;
    if (item?.dnp === true || item?.doNotPopulate === true || item?.populate === false || item?.fitted === false) return true;
    for (const src of [def?.parameters, item?.parameters]) if (obj(src)) for (const [k, v] of Object.entries(src)) {
      const key = clean(k).toUpperCase().replace(/[_\s]+/g, " ");
      if (["DNP", "DNI", "DNF", "DO NOT POPULATE", "NOT FITTED", "NO POP"].includes(key) && (truthy(v) || v === "")) return true;
      if (["FITTED", "POPULATE", "STUFF"].includes(key) && falsy(v)) return true;
    }
    return /^(dnp|dni|dnf)$/i.test(clean(item?.value));
  }
  const paramsOf = (...sources) => {
    const values = new Map(), {paramKey, FIELD_KEYS} = globalThis.Atrium.partParameters;
    for (const s of sources) if (obj(s)) for (const [k, v] of Object.entries(s)) {
      const normalized = paramKey(k);
      const field = Object.keys(FIELD_KEYS).find(f => FIELD_KEYS[f].test(normalized));
      const key = field ? "field:" + field : "parameter:" + clean(k).toLowerCase();
      if (v === null) values.delete(key);
      else if (typeof v !== "object") values.set(key, [k, String(v)]);
    }
    return Object.fromEntries(values.values());
  };
  function entryOf(variant, key) {
    const e = variant?.parts && own(variant.parts, key) ? variant.parts[key] : null;
    return obj(e) ? e : null;
  }
  function fittedBy(entry, base) {
    if (!entry) return base;
    if (entry.fitted === false) return false;
    if (entry.alternate) return true;
    return typeof entry.fitted === "boolean" ? entry.fitted : base;
  }
  // Applied views carry the complete parameters for these placements. A PCB
  // placement still references its physical footprint, even for another fitted part.
  function appliedParameters(project, defs) {
    const v = project.variantApplied && find(project, project.variantApplied.id);
    if (!v) return null;
    const {parameters, fallbackParameters} = globalThis.Atrium.partParameters;
    return (item, def, fallback) => {
      const e = entryOf(v, keyOf(item)), alt = e?.fitted === false ? null : e?.alternate;
      if (!alt && !e?.params) return fallbackParameters(parameters(item, def), fallback);
      if (!fallback || (alt?.def && defs.has(alt.def))) return parameters(item);
      // A parameter-only edit still inherits fields from its linked schematic.
      // Replay explicit removals after the merge so a cleared field stays clear.
      return parameters({parameters: paramsOf(fallback, item.parameters, alt?.params, e?.params)});
    };
  }

  function appliedDescription(project, defs) {
    const v = project?.variantApplied && find(project, project.variantApplied.id);
    if (!v) return null;
    const {parameters, clean} = globalThis.Atrium.partParameters;
    return (item, params) => {
      const e = entryOf(v, keyOf(item));
      const alternate = e?.fitted !== false && e?.alternate?.def && defs.get(e.alternate.def);
      if (!alternate) return undefined;
      return (params ?? parameters(item)).DESCRIPTION || clean(alternate.description);
    };
  }

  // ------------------------------------------------------------ resolve
  function resolve(project, variant) {
    const v = current(project, variant), defs = new Map((project.library || []).map(d => [d.id, d])), out = {};
    for (const g of groups(project).values()) {
      const first = g.items.find(x => x.doc.kind === "schematic") || g.items[0], item = first.item, def = defs.get(item.def);
      const baseFitted = !g.items.some(x => baseDnp(x.item, defs.get(x.item.def)));
      const e = entryOf(v, g.key), fitted = fittedBy(e, baseFitted);
      let defId = item.def, value = item.value ?? "", params = paramsOf(def?.parameters, item.parameters);
      const alt = fitted && e?.alternate ? e.alternate : null;
      if (alt) {
        const ad = alt.def && defs.get(alt.def);
        if (ad && ad.id !== item.def) { defId = ad.id; params = paramsOf(ad.parameters); if (alt.value == null) value = ad.value ?? ad.name ?? value; }
        if (alt.value != null) value = alt.value;
        params = paramsOf(params, alt.params);
      }
      if (e?.params) params = paramsOf(params, e.params);
      out[g.key] = {key: g.key, ref: String(item.ref ?? ""), fitted, baseFitted, def: defId, value: String(value), params,
        alternate: !!alt, overridden: !!e, items: g.items.map(x => ({docId: x.doc.id, id: x.item.id, kind: x.doc.kind}))};
    }
    return out;
  }
  function apply(project, variant) {
    const v = current(project, variant), defs = new Map((project.library || []).map(d => [d.id, d]));
    const copy = {...project, documents: (project.documents || []).map(d => ({...d, items: d.items.map(i => i.kind === "part" ? {...i, ...(obj(i.parameters) ? {parameters: {...i.parameters}} : {})} : i)}))};
    delete copy.activeVariant;
    copy.variantApplied = v ? {id: v.id, name: v.name} : null;
    if (!v) return copy;
    for (const doc of copy.documents) for (const item of doc.items) {
      if (item.kind !== "part") continue;
      const e = entryOf(v, keyOf(item));
      if (!e) continue;
      const explicit = e.fitted === false || !!e.alternate || typeof e.fitted === "boolean";
      const fitted = fittedBy(e, true);
      if (explicit) item.dnp = !fitted;
      const alt = fitted ? e.alternate : null;
      if (alt || e.params) {
        const ad = alt?.def && defs.get(alt.def);
        const switched = ad && ad.id !== item.def;
        item.parameters = paramsOf((switched ? ad : defs.get(item.def))?.parameters,
          switched ? null : item.parameters, alt?.params, e.params);
        if (switched) {
          // Variants never change copper: board footprints keep their library part (and pads);
          // the schematic part takes the alternate's symbol.
          if (doc.kind !== "pcb" && ad.symbol) item.def = ad.id;
          if (alt.value == null) item.value = String(ad.value ?? ad.name ?? item.value);
        }
        if (alt?.value != null) item.value = alt.value;
      }
    }
    return copy;
  }
  function forOutput(project, variant) {
    if (!project || project.variantApplied !== undefined) return project;
    const v = current(project, variant);
    if (!v && project.activeVariant == null) return project;
    return apply(project, v ? v.id : null);
  }
  function includer(project, variant) {
    const r = resolve(project, variant);
    return item => r[keyOf(item)]?.fitted !== false;
  }
  // Rows that differ between two variants (null for the base design).
  function compare(project, a, b) {
    const ra = resolve(project, a ?? null), rb = resolve(project, b ?? null), out = [];
    for (const k of Object.keys(ra)) {
      const x = ra[k], y = rb[k], fields = [];
      if (!y) continue;
      if (x.fitted !== y.fitted) fields.push("fitted");
      if (x.fitted && y.fitted) {
        if (x.def !== y.def) fields.push("def");
        if (x.value !== y.value) fields.push("value");
        if (JSON.stringify(sorted(x.params)) !== JSON.stringify(sorted(y.params))) fields.push("params");
      }
      if (fields.length) out.push({key: k, ref: x.ref, fields, a: pickState(x), b: pickState(y)});
    }
    return out.sort((p, q) => natural(p.ref, q.ref));
  }
  const sorted = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
  const pickState = r => ({fitted: r.fitted, def: r.def, value: r.value, params: r.params});
  const natural = (a, b) => String(a).localeCompare(String(b), "en", {numeric: true, sensitivity: "base"});

  // ------------------------------------------------------------ physical parts (manager rows)
  // One row per designator: the keys of its schematic units and board footprint.
  function rows(project) {
    const defs = new Map((project.library || []).map(d => [d.id, d])), byRef = new Map(), out = [];
    for (const g of groups(project).values()) {
      const onBoard = g.items.some(x => x.doc.kind === "pcb");
      const first = g.items.find(x => x.doc.kind === "schematic") || g.items[0], item = first.item, def = defs.get(item.def);
      const ref = clean(item.ref);
      if (/^#/.test(ref) || def?.power === true || def?.virtual === true || item.virtual === true || item.excludeFromBOM === true || def?.excludeFromBOM === true) continue;
      const pins = def?.symbol?.pins || [];
      const footprint = clean(onBoard ? defs.get(g.items.find(x => x.doc.kind === "pcb").item.def)?.footprint?.name : def?.footprintName || def?.footprint?.name || item.parameters?.Footprint);
      if (!onBoard && !footprint) continue; // power ports, graphics and symbol-only parts
      if (!onBoard && pins.length && pins.every(p => p.electrical === 7)) continue;
      const id = ref && !ref.includes("?") ? ref.toUpperCase() : "#" + g.key;
      let row = byRef.get(id);
      if (!row) {
        row = {id, ref: ref || "?", keys: [], comment: clean(item.value), footprint, def: item.def, prefix: def?.prefix || ref.replace(/\d.*$/, "")};
        byRef.set(id, row); out.push(row);
      }
      row.keys.push(g.key);
      if (!row.footprint) row.footprint = footprint;
    }
    return out.sort((a, b) => natural(a.ref, b.ref));
  }

  // ------------------------------------------------------------ editing (in place)
  function uniqueName(project, base, except) {
    let name = clean(base).slice(0, LIMIT.name) || "Variant", n = 1;
    const taken = x => list(project).some(v => v.id !== except && sameName(v.name, x));
    while (taken(name)) name = (clean(base).slice(0, LIMIT.name - 4) || "Variant") + " " + (++n);
    return name;
  }
  function create(project, {name, description, from} = {}) {
    if (list(project).length >= LIMIT.variants) throw Error("At most " + LIMIT.variants + " variants are supported.");
    const src = from != null ? find(project, from) : null;
    const v = {id: newId(), name: uniqueName(project, name || (src ? src.name + " copy" : "Variant " + (list(project).length + 1))), parts: src ? JSON.parse(JSON.stringify(src.parts || {})) : {}};
    const d = description ?? src?.description;
    if (d) v.description = String(d).slice(0, LIMIT.description);
    if (!Array.isArray(project.variants)) project.variants = [];
    project.variants.push(v);
    return v;
  }
  const duplicate = (project, id, name) => {
    const src = find(project, id) || fail(id);
    return create(project, {name: name || src.name + " copy", from: src.id});
  };
  function fail(id) { throw Error("There is no assembly variant called " + id + "."); }
  function rename(project, id, {name, description} = {}) {
    const v = find(project, id) || fail(id);
    if (name != null) {
      const n = clean(name);
      if (!n) throw Error("Give the variant a name.");
      if (n.length > LIMIT.name) throw Error("Variant names are at most " + LIMIT.name + " characters.");
      if (list(project).some(x => x !== v && sameName(x.name, n))) throw Error("There is already a variant called " + n + ".");
      v.name = n;
    }
    if (description != null) { const d = String(description).trim().slice(0, LIMIT.description); if (d) v.description = d; else delete v.description; }
    return v;
  }
  function remove(project, id) {
    const v = find(project, id);
    if (!v) return false;
    project.variants = project.variants.filter(x => x !== v);
    if (project.activeVariant === v.id) delete project.activeVariant;
    if (!project.variants.length) delete project.variants;
    return true;
  }
  function setActive(project, id) {
    if (id == null || id === "") { delete project.activeVariant; return null; }
    const v = find(project, id) || fail(id);
    project.activeVariant = v.id;
    return v;
  }
  // change: {fitted:true|false} | {alternate:{def,value,params}|null} | {params:{...}|null} | {reset:true}
  // variant null edits the base design (fitted only: the parts' DNP flag).
  function setParts(project, variant, keys, change) {
    keys = [...new Set(keys)];
    if (variant == null || variant === "") {
      if (typeof change.fitted !== "boolean" && !change.reset) throw Error("The base design only has fitted and not fitted.");
      const want = new Set(keys);
      let n = 0;
      for (const doc of project.documents) for (const item of doc.items) {
        if (item.kind !== "part" || !want.has(keyOf(item))) continue;
        if (change.reset) delete item.dnp; else item.dnp = !change.fitted;
        n++;
      }
      return n;
    }
    const v = find(project, variant) || fail(variant);
    if (!obj(v.parts)) v.parts = {};
    let base = null;
    const baseFitted = k => {
      if (!base) {
        const defs = new Map((project.library || []).map(d => [d.id, d]));
        base = new Map([...groups(project).values()].map(g => [g.key, !g.items.some(x => baseDnp(x.item, defs.get(x.item.def)))]));
      }
      return base.get(k) !== false;
    };
    for (const k of keys) {
      const e = {...(entryOf(v, k) || {})};
      if (change.reset) { delete v.parts[k]; continue; }
      if (own(change, "fitted")) {
        if (change.fitted === false) { e.fitted = false; delete e.alternate; }
        else if (change.fitted === true) { delete e.alternate; e.fitted = true; }
        else delete e.fitted;
      }
      if (own(change, "alternate")) {
        const a = change.alternate;
        if (a && (a.def || a.value != null && a.value !== "" || a.params && Object.keys(a.params).length)) {
          // Fields a newer Waffle wrote on the alternate stay (forward compatibility).
          const alt = Object.fromEntries(Object.entries(obj(e.alternate) ? e.alternate : {}).filter(([k]) => !["def", "value", "params"].includes(k)));
          if (a.def) alt.def = String(a.def);
          if (a.value != null && a.value !== "") alt.value = String(a.value);
          if (a.params && Object.keys(a.params).length) alt.params = {...a.params};
          e.alternate = alt; delete e.fitted;
        } else delete e.alternate;
      }
      if (own(change, "params")) {
        if (change.params && Object.keys(change.params).length) e.params = {...change.params}; else delete e.params;
      }
      if (e.fitted === true && !e.alternate) {
        // fitted:true only matters where the base design says not fitted.
        if (baseFitted(k)) delete e.fitted;
      }
      if (Object.keys(e).length) v.parts[k] = e; else delete v.parts[k];
    }
    checkEntryList(v, !!(project.atriumCompat?.newer || project.atriumCompat?.readOnly));
    return keys.length;
  }
  function checkEntryList(v, lenient) { for (const [k, e] of Object.entries(v.parts || {})) checkEntry(e, v.name + " part " + k, lenient); }
  // "Name = value" lines; "-Name" removes a parameter.
  function parseParams(text) {
    const out = {};
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^-/.test(line)) { const k = line.slice(1).trim(); if (k) out[k] = null; continue; }
      const i = line.indexOf("=");
      if (i <= 0) throw Error("Write each parameter as Name = value (or -Name to remove it): " + line);
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  }
  const formatParams = p => Object.entries(p || {}).map(([k, v]) => v === null ? "-" + k : k + " = " + v).join("\n");

  // ------------------------------------------------------------ canvas overlay
  // Not-fitted parts of one document as world boxes, drawn greyed with a red cross.
  function notFittedBoxes(project, doc, variant) {
    const r = resolve(project, variant), A = globalThis.Atrium, defs = new Map((project.library || []).map(d => [d.id, d])), out = [];
    if (!A) return out;
    for (const item of doc.items || []) {
      if (item.kind !== "part" || r[keyOf(item)]?.fitted !== false) continue;
      let b = null;
      try { b = A.bounds(A.itemPoints(item, defs.get(item.def), doc.kind)); } catch { b = null; }
      if (b) out.push(b);
    }
    return out;
  }
  function paint(ctx, boxes, scale, kind) {
    ctx.save();
    const grow = 0.25;
    for (const b of boxes) {
      const x0 = b[0] - grow, y0 = b[1] - grow, x1 = b[2] + grow, y1 = b[3] + grow;
      ctx.globalAlpha = kind === "pcb" ? 0.55 : 0.6;
      ctx.fillStyle = kind === "pcb" ? "#1b1b1b" : "#e9e9e6";
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = "#e0342c";
      ctx.lineWidth = Math.max(1.6 / scale, 0.12);
      ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.moveTo(x1, y0); ctx.lineTo(x0, y1); ctx.stroke();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ UI
  const hasDOM = () => typeof document !== "undefined" && !!document.createElement;
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function btn(text, fn, cls) {
    const b = el("button", text, cls); b.type = "button";
    b.classList.add("ui-button"); b.dataset.size = "lg";
    if (cls === "primary" || cls === "danger") b.dataset.variant = cls;
    b.onclick = fn;
    return b;
  }
  let host = null, switcher = null, switchSig = "";

  function contextFrom(ctx) {
    const live = () => ctx?.currentProject?.() || host?.project?.() || ctx?.project;
    const edit = fn => { if (typeof ctx?.edit === "function") ctx.edit(fn); else if (host?.edit) host.edit(fn); else fn(); };
    return {live, edit, info: m => (ctx?.info || host?.info)?.(m)};
  }
  function activate(c, id) {
    (globalThis.AtriumRevisions?.allow || (f => f()))(() => c.edit(() => setActive(c.live(), id))); // viewing a variant is not a design edit
    const v = find(c.live(), id);
    c.info("Active variant: " + (v ? v.name : "base design (no variations)"));
    syncSwitcher(true);
    host?.invalidate?.();
  }

  // ---- Variant Management dialog
  function open(ctx) {
    if (!hasDOM()) throw Error("The variant manager needs a window.");
    const c = contextFrom(ctx);
    const d = el("dialog", null, "work-dialog ui-dialog variants-dialog");
    d.setAttribute("aria-labelledby", "variants-heading");
    const heading = el("h2", "Variant Management"); heading.id = "variants-heading";
    const summary = el("p", null, "variants-summary"); summary.setAttribute("role", "status");
    const titleBox = el("div"); titleBox.append(heading, summary);
    const closeX = btn("×", () => d.close(), "ui-close variants-close"); closeX.setAttribute("aria-label", "Close variant management"); closeX.title = "Close";
    const top = el("header", null, "variants-head"); top.append(titleBox, closeX);

    const state = {focus: list(c.live())[0]?.id ?? null, sel: new Set(), anchor: null, cursor: {r: 0, c: 1}, query: "", compareA: "", compareB: "", diffOnly: false, panel: null};
    // Toolbar: variant operations (on the focused column) and comparison.
    const bNew = btn("New", () => run(p => { const v = create(p); state.focus = v.id; return "Added " + v.name + "."; }));
    const bDup = btn("Duplicate", () => run(p => { const v = duplicate(p, state.focus); state.focus = v.id; return "Duplicated as " + v.name + "."; }));
    const bRename = btn("Rename…", () => showPanel("rename"));
    const bDelete = btn("Delete", () => showPanel("delete"));
    const bActive = btn("Make active", () => { activate(c, state.focus); paint_(); });
    for (const b of [bNew, bDup, bRename, bDelete, bActive]) b.dataset.role = "variant-op";
    bNew.title = "Add a variant (all parts fitted as in the base design)";
    bDup.title = "Copy the selected variant"; bActive.title = "Show this variant in the editor and use it for outputs";
    const search = el("input", null, "ui-field"); search.type = "search"; search.placeholder = "Filter designators"; search.setAttribute("aria-label", "Filter designators");
    const cmpA = el("select", null, "ui-field"), cmpB = el("select", null, "ui-field"); cmpA.setAttribute("aria-label", "Compare variant"); cmpB.setAttribute("aria-label", "With variant");
    const diffOnly = el("input", null, "ui-checkbox"); diffOnly.type = "checkbox";
    const diffLabel = el("label", null, "variants-check"); diffLabel.append(diffOnly, el("span", "Differences only"));
    const cmpBox = el("div", null, "variants-compare"); cmpBox.append(el("span", "Compare"), cmpA, el("span", "with"), cmpB, diffLabel);
    const tools = el("div", null, "variants-toolbar");
    const ops = el("div", null, "variants-ops"); ops.append(bNew, bDup, bRename, bDelete, bActive);
    tools.append(ops, AtriumUI.searchField(search), cmpBox);

    const panel = el("div", null, "variants-panel"); panel.hidden = true;
    const table = el("table", null, "variants-grid"), thead = el("thead"), tbody = el("tbody");
    table.append(thead, tbody); table.setAttribute("role", "grid"); table.setAttribute("aria-label", "Parts by variant"); table.setAttribute("aria-multiselectable", "true");
    const wrap = el("div", null, "variants-grid-wrap"); wrap.tabIndex = 0; wrap.append(table);
    const empty = el("div", null, "variants-empty");

    // Bulk actions on the selected cells.
    const selInfo = el("span", null, "variants-selection");
    const aFit = btn("Fitted", () => bulk({fitted: true}, "fitted")), aNot = btn("Not fitted", () => bulk({fitted: false}, "not fitted"));
    const aAlt = btn("Alternate…", () => showPanel("alternate")), aPar = btn("Parameters…", () => showPanel("params"));
    const aReset = btn("Reset", () => bulk({reset: true}, "reset to the base design"));
    aFit.title = "Fitted (F)"; aNot.title = "Not fitted (N)"; aAlt.title = "Alternate part or comment (A)"; aPar.title = "Parameter overrides (P)"; aReset.title = "Inherit the base design (Delete)";
    const status = el("span", null, "variants-status"); status.setAttribute("role", "status");
    const foot = el("div", null, "work-actions ui-dialog-actions variants-actions");
    const bulkBox = el("div", null, "variants-bulk"); bulkBox.append(selInfo, aFit, aNot, aAlt, aPar, aReset);
    foot.append(bulkBox, status, btn("Close", () => d.close()));
    d.append(top, tools, panel, wrap, empty, foot);

    let model = {rows: [], variants: [], resolved: [], shown: [], diff: new Set()};
    function run(fn, after) {
      status.textContent = "";
      if (globalThis.AtriumRevisions?.locked?.(c.live())) { status.textContent = AtriumRevisions.message(c.live()); return false; }
      let msg = "";
      try { c.edit(() => { msg = fn(c.live()) || ""; }); } catch (e) { status.textContent = e.message || String(e); return false; }
      status.textContent = msg; paint_(); host?.invalidate?.(); syncSwitcher(true);
      after?.();
      return true;
    }
    // Columns: 0 Base, 1.. variants.
    const colVariant = ci => ci === 0 ? null : model.variants[ci - 1]?.id;
    function selectedCells() {
      const out = [];
      for (const s of state.sel) { const [r, ci] = s.split(":").map(Number); const row = model.shown[r]; if (row && ci <= model.variants.length) out.push({row, ci}); }
      return out;
    }
    function bulk(change, what) {
      const cells = selectedCells();
      if (!cells.length) { status.textContent = "Select cells in the grid first."; return; }
      if (cells.some(x => x.ci === 0) && typeof change.fitted !== "boolean" && !change.reset) { status.textContent = "The base design has only fitted and not fitted."; return; }
      const byVariant = new Map();
      for (const x of cells) { const v = colVariant(x.ci) ?? ""; if (!byVariant.has(v)) byVariant.set(v, []); byVariant.get(v).push(...x.row.keys); }
      run(p => { for (const [v, keys] of byVariant) setParts(p, v || null, keys, change); return "Set " + cells.length + " cell" + (cells.length === 1 ? "" : "s") + " " + what + "."; });
    }

    function showPanel(kind) {
      state.panel = kind; panel.replaceChildren(); panel.hidden = false;
      const close = () => { state.panel = null; panel.hidden = true; panel.replaceChildren(); wrap.focus(); };
      const cancel = btn("Cancel", close);
      const field = (label, control, hint) => { const l = el("label", null, "variants-field"); l.append(el("span", label), control); if (hint) l.append(el("small", hint)); return l; };
      const v = find(c.live(), state.focus);
      if (kind === "rename" || kind === "delete") {
        if (!v) { close(); status.textContent = "Add a variant first."; return; }
        if (kind === "delete") {
          const go = btn("Delete " + v.name, () => { close(); run(p => { remove(p, v.id); state.focus = list(p)[0]?.id ?? null; state.sel.clear(); return "Deleted " + v.name + "."; }); }, "danger");
          const box = el("div", null, "variants-confirm");
          box.append(el("span", "Delete the variant " + v.name + " and its " + Object.keys(v.parts || {}).length + " part settings? Undo restores it."), cancel, go);
          panel.append(box); go.focus(); return;
        }
        const name = el("input", null, "ui-field"); name.value = v.name; name.maxLength = LIMIT.name;
        const desc = el("textarea", null, "ui-field"); desc.value = v.description || ""; desc.rows = 2; desc.maxLength = LIMIT.description;
        const ok = btn("Save", () => { if (run(p => { rename(p, v.id, {name: name.value, description: desc.value}); return "Renamed to " + clean(name.value) + "."; })) close(); });
        ok.classList.add("primary"); ok.dataset.variant = "primary";
        name.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); ok.click(); } };
        panel.append(field("Name", name), field("Description", desc), el("div", null, "variants-panel-actions"));
        panel.lastChild.append(cancel, ok); name.focus(); name.select(); return;
      }
      const cells = selectedCells().filter(x => x.ci > 0);
      if (!cells.length) { close(); status.textContent = "Select cells in variant columns first (the base design has no alternates)."; return; }
      const firstEntry = entryOf(find(c.live(), colVariant(cells[0].ci)), cells[0].row.keys[0]) || {};
      const apply_ = btn("Apply to " + cells.length + " cell" + (cells.length === 1 ? "" : "s"), null, "primary");
      if (kind === "alternate") {
        const lib = el("select", null, "ui-field"), value = el("input", null, "ui-field"), params = el("textarea", null, "ui-field");
        params.spellcheck = false;
        const defs = (c.live().library || []).filter(x => x.symbol || x.footprint);
        const prefix = cells[0].row.prefix;
        lib.add(new Option("Keep the library part", ""));
        const near = el("optgroup"), rest = el("optgroup"); near.label = "Same prefix (" + (prefix || "?") + ")"; rest.label = "Library";
        for (const x of defs.sort((a, b) => natural(a.name, b.name))) (x.prefix && x.prefix === prefix ? near : rest).append(new Option(x.name + (x.description ? " — " + clean(x.description).slice(0, 50) : ""), x.id));
        if (near.childElementCount) lib.append(near);
        if (rest.childElementCount) lib.append(rest);
        lib.value = firstEntry.alternate?.def || "";
        value.value = firstEntry.alternate?.value || ""; value.placeholder = "Comment, e.g. 4.7k"; params.rows = 3;
        params.value = formatParams(firstEntry.alternate?.params); params.placeholder = "Manufacturer Part Number = RC0603FR-074K7L";
        apply_.onclick = () => {
          let p;
          try { p = parseParams(params.value); } catch (e) { status.textContent = e.message; return; }
          const alt = {def: lib.value || undefined, value: value.value.trim() || undefined, params: p};
          if (!alt.def && !alt.value && !Object.keys(p).length) { status.textContent = "Choose a library part, a comment or parameters."; return; }
          if (bulkCells(cells, {alternate: alt}, "an alternate part")) close();
        };
        panel.append(el("strong", "Alternate part"), field("Library part", lib), field("Comment", value), field("Parameters", params, "One per line: Name = value. -Name removes a parameter."));
        lib.focus();
      } else {
        const params = el("textarea", null, "ui-field"); params.rows = 4; params.spellcheck = false; params.value = formatParams(firstEntry.params);
        params.placeholder = "Value = 4.7k\nTolerance = 1%\n-Supplier";
        apply_.onclick = () => {
          let p;
          try { p = parseParams(params.value); } catch (e) { status.textContent = e.message; return; }
          if (bulkCells(cells, {params: p}, Object.keys(p).length ? "parameter overrides" : "no parameter overrides")) close();
        };
        panel.append(el("strong", "Parameter overrides"), field("Parameters", params, "One per line: Name = value. -Name removes a parameter. Empty clears the overrides."));
        params.focus();
      }
      const actions = el("div", null, "variants-panel-actions"); actions.append(cancel, apply_); panel.append(actions);
      panel.onkeydown = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
    }
    function bulkCells(cells, change, what) {
      const byVariant = new Map();
      for (const x of cells) { const v = colVariant(x.ci); if (!byVariant.has(v)) byVariant.set(v, []); byVariant.get(v).push(...x.row.keys); }
      return run(p => { for (const [v, keys] of byVariant) setParts(p, v, keys, change); return "Set " + what + " on " + cells.length + " cell" + (cells.length === 1 ? "" : "s") + "."; });
    }

    function cellState(r, key) {
      if (!r) return {text: "—", cls: "na"};
      if (!r.fitted) return {text: "Not fitted", cls: "nf", icon: "✕"};
      if (r.alternate) return {text: r.value || "Alternate", cls: "alt", icon: "⇄"};
      return {text: "Fitted", cls: "fit"};
    }
    function rebuild() {
      const p = c.live();
      model.variants = list(p);
      if (state.focus && !find(p, state.focus)) state.focus = model.variants[0]?.id ?? null;
      model.rows = rows(p);
      model.resolved = [resolve(p, null), ...model.variants.map(v => resolve(p, v.id))];
      const opt = (s, val) => { s.replaceChildren(new Option("—", ""), new Option("Base design", "@base"), ...model.variants.map(v => new Option(v.name, v.id))); s.value = [...s.options].some(o => o.value === val) ? val : ""; };
      opt(cmpA, state.compareA); opt(cmpB, state.compareB);
      state.compareA = cmpA.value; state.compareB = cmpB.value;
      model.diff = new Set();
      if (state.compareA && state.compareB && state.compareA !== state.compareB) {
        const id = x => x === "@base" ? null : x;
        for (const x of compare(p, id(state.compareA), id(state.compareB))) model.diff.add(x.key);
      }
      const q = state.query.trim().toLowerCase();
      model.shown = model.rows.filter(r => (!q || r.ref.toLowerCase().includes(q) || r.comment.toLowerCase().includes(q)) &&
        (!state.diffOnly || !model.diff.size && !(state.compareA && state.compareB) || r.keys.some(k => model.diff.has(k))));
    }
    function paint_() {
      rebuild();
      const p = c.live(), active = find(p, p.activeVariant);
      const nf = model.variants.map((v, i) => model.rows.filter(r => model.resolved[i + 1][r.keys[0]]?.fitted === false).length);
      summary.textContent = model.rows.length + " parts · " + model.variants.length + " variant" + (model.variants.length === 1 ? "" : "s") +
        " · Active: " + (active ? active.name : "base design") + (model.diff.size ? " · " + model.rows.filter(r => r.keys.some(k => model.diff.has(k))).length + " differ" : "");
      for (const b of [bDup, bRename, bDelete, bActive]) b.disabled = !state.focus;
      bActive.textContent = state.focus && active?.id === state.focus ? "Active" : "Make active";
      if (state.focus && active?.id === state.focus) bActive.disabled = true;
      // Header
      thead.replaceChildren();
      const hr = el("tr");
      for (const [t, cls] of [["Designator", "ref"], ["Comment", "comment"], ["Footprint", "fp"]]) { const th = el("th", t, "fixed " + cls); th.scope = "col"; hr.append(th); }
      const baseTh = el("th", null, "var base" + (!active ? " is-active" : "")); baseTh.scope = "col";
      baseTh.append(el("span", "Base design"), el("small", model.rows.filter(r => model.resolved[0][r.keys[0]]?.fitted === false).length + " not fitted"));
      baseTh.title = "The design without variations: parts marked DNP are not fitted.";
      hr.append(baseTh);
      model.variants.forEach((v, i) => {
        const th = el("th", null, "var" + (v.id === state.focus ? " is-focus" : "") + (v.id === active?.id ? " is-active" : "")); th.scope = "col";
        const name = el("span", v.name); th.append(name, el("small", nf[i] + " not fitted" + (v.id === active?.id ? " · active" : "")));
        th.title = (v.description ? v.description + "\n" : "") + "Click to select this variant; double-click to rename.";
        th.onclick = e => { state.focus = v.id; if (e.shiftKey || e.metaKey || e.ctrlKey) selectColumn(i + 1, true); paint_(); };
        th.ondblclick = () => { state.focus = v.id; paint_(); showPanel("rename"); };
        hr.append(th);
      });
      if (!model.variants.length) { const th = el("th", null, "var add"); th.append(btn("+ New variant", () => bNew.click())); hr.append(th); }
      thead.append(hr);
      // Body
      tbody.replaceChildren();
      const frag = document.createDocumentFragment();
      model.shown.forEach((row, ri) => {
        const tr = el("tr");
        if (row.keys.some(k => model.diff.has(k))) tr.classList.add("is-diff");
        const refTd = el("th", row.ref, "fixed ref"); refTd.scope = "row"; refTd.title = "Select this row";
        refTd.onclick = e => { selectRow(ri, e.shiftKey || e.metaKey || e.ctrlKey); paintSelection(); };
        tr.append(refTd, el("td", row.comment, "fixed comment"), el("td", row.footprint, "fixed fp"));
        for (let ci = 0; ci <= model.variants.length; ci++) {
          const r = model.resolved[ci][row.keys[0]], s = cellState(r);
          const mixed = row.keys.slice(1).some(k => model.resolved[ci][k]?.fitted !== r?.fitted);
          const td = el("td", null, "cell " + s.cls + (ci === 0 ? " base" : ""));
          td.setAttribute("role", "gridcell"); td.dataset.r = ri; td.dataset.c = ci;
          if (s.icon) td.append(el("span", s.icon, "icon"));
          td.append(el("span", mixed ? "Mixed" : s.text, "label"));
          if (r?.overridden && ci > 0) {
            const e = entryOf(model.variants[ci - 1], row.keys[0]);
            if (e?.params && Object.keys(e.params).length) td.append(el("span", "P", "badge"));
            const tip = [];
            if (r.alternate) { const ad = (p.library || []).find(x => x.id === r.def); tip.push("Alternate: " + (ad ? ad.name : r.def) + " · " + r.value); }
            if (e?.params) tip.push("Parameters: " + formatParams(e.params).replace(/\n/g, "; "));
            if (e && !r.alternate && r.fitted !== r.baseFitted) tip.push(r.fitted ? "Fitted (overrides DNP)" : "Not fitted");
            td.title = tip.join("\n");
          } else if (ci > 0) { td.classList.add("inherit"); td.title = "Inherited from the base design"; }
          tr.append(td);
        }
        frag.append(tr);
      });
      tbody.append(frag);
      empty.hidden = !!model.rows.length;
      empty.textContent = "No physical components yet. Place parts with footprints to manage variants.";
      if (!model.variants.length && model.rows.length) { empty.hidden = false; empty.textContent = "No variants yet. New adds one with every part fitted as in the base design; then mark parts Not fitted or give them an alternate."; }
      paintSelection();
    }
    function paintSelection() {
      for (const td of tbody.querySelectorAll("td.cell")) {
        const k = td.dataset.r + ":" + td.dataset.c, on = state.sel.has(k);
        td.classList.toggle("is-selected", on); td.setAttribute("aria-selected", String(on));
        td.classList.toggle("is-cursor", +td.dataset.r === state.cursor.r && +td.dataset.c === state.cursor.c);
      }
      const n = state.sel.size, cells = selectedCells(), base = cells.some(x => x.ci === 0);
      selInfo.textContent = n ? n + " cell" + (n === 1 ? "" : "s") + " selected" : "Select cells to set them";
      for (const b of [aFit, aNot, aReset]) b.disabled = !n;
      aAlt.disabled = aPar.disabled = !n || base && cells.every(x => x.ci === 0);
    }
    function selectRow(ri, add) {
      if (!add) state.sel.clear();
      for (let ci = 1; ci <= model.variants.length; ci++) state.sel.add(ri + ":" + ci);
      if (!model.variants.length) state.sel.add(ri + ":0");
      state.cursor = {r: ri, c: Math.max(1, Math.min(state.cursor.c, model.variants.length))};
    }
    function selectColumn(ci, add) {
      if (!add) state.sel.clear();
      for (let r = 0; r < model.shown.length; r++) state.sel.add(r + ":" + ci);
      paintSelection();
    }
    function selectRange(a, b, add) {
      if (!add) state.sel.clear();
      for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) for (let ci = Math.min(a.c, b.c); ci <= Math.max(a.c, b.c); ci++) state.sel.add(r + ":" + ci);
    }
    tbody.addEventListener("mousedown", e => {
      const td = e.target.closest("td.cell"); if (!td) return;
      e.preventDefault(); wrap.focus();
      const at = {r: +td.dataset.r, c: +td.dataset.c}, k = at.r + ":" + at.c;
      if (e.shiftKey && state.anchor) selectRange(state.anchor, at, e.metaKey || e.ctrlKey);
      else if (e.metaKey || e.ctrlKey) { if (state.sel.has(k)) state.sel.delete(k); else state.sel.add(k); state.anchor = at; }
      else { state.sel.clear(); state.sel.add(k); state.anchor = at; }
      state.cursor = at;
      if (at.c > 0) state.focus = colVariant(at.c);
      const drag = ev => {
        const t = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.("td.cell"); if (!t) return;
        selectRange(state.anchor, {r: +t.dataset.r, c: +t.dataset.c}, false); state.cursor = {r: +t.dataset.r, c: +t.dataset.c}; paintSelection();
      };
      const up = () => { removeEventListener("mousemove", drag); removeEventListener("mouseup", up); };
      addEventListener("mousemove", drag); addEventListener("mouseup", up);
      paintFocus(); paintSelection();
    });
    tbody.addEventListener("dblclick", e => {
      const td = e.target.closest("td.cell"); if (!td) return;
      const ci = +td.dataset.c, r = model.resolved[ci][model.shown[+td.dataset.r]?.keys[0]];
      bulk({fitted: r?.fitted === false}, r?.fitted === false ? "fitted" : "not fitted");
    });
    function paintFocus() { for (const th of thead.querySelectorAll("th.var")) th.classList.remove("is-focus"); const th = thead.querySelectorAll("th.var")[model.variants.findIndex(v => v.id === state.focus) + 1]; th?.classList.add("is-focus"); }
    wrap.addEventListener("keydown", e => {
      if (e.target !== wrap) return;
      const cols = model.variants.length, rowsN = model.shown.length;
      const move = (dr, dc) => {
        const next = {r: Math.max(0, Math.min(rowsN - 1, state.cursor.r + dr)), c: Math.max(0, Math.min(cols, state.cursor.c + dc))};
        if (e.shiftKey) { state.anchor ??= state.cursor; selectRange(state.anchor, next, false); }
        else { state.sel.clear(); state.sel.add(next.r + ":" + next.c); state.anchor = next; }
        state.cursor = next; if (next.c > 0) state.focus = colVariant(next.c);
        paintFocus(); paintSelection();
        tbody.querySelector('td[data-r="' + next.r + '"][data-c="' + next.c + '"]')?.scrollIntoView?.({block: "nearest", inline: "nearest"});
      };
      const keys = {ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1]};
      if (keys[e.key]) { e.preventDefault(); move(...keys[e.key]); return; }
      if (e.metaKey || e.ctrlKey) { if (e.key.toLowerCase() === "a") { e.preventDefault(); for (let r = 0; r < rowsN; r++) for (let ci = 1; ci <= cols; ci++) state.sel.add(r + ":" + ci); paintSelection(); } return; }
      const k = e.key.toLowerCase();
      if (!state.sel.size && rowsN) state.sel.add(state.cursor.r + ":" + state.cursor.c);
      if (k === "f") { e.preventDefault(); bulk({fitted: true}, "fitted"); }
      else if (k === "n") { e.preventDefault(); bulk({fitted: false}, "not fitted"); }
      else if (k === " ") {
        e.preventDefault();
        const x = selectedCells()[0], r = x && model.resolved[x.ci][x.row.keys[0]];
        if (r) bulk({fitted: r.fitted === false}, r.fitted === false ? "fitted" : "not fitted");
      }
      else if (k === "a") { e.preventDefault(); showPanel("alternate"); }
      else if (k === "p") { e.preventDefault(); showPanel("params"); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); bulk({reset: true}, "reset to the base design"); }
    });
    search.oninput = () => { state.query = search.value; state.sel.clear(); paint_(); };
    cmpA.onchange = () => { state.compareA = cmpA.value; paint_(); };
    cmpB.onchange = () => { state.compareB = cmpB.value; paint_(); };
    diffOnly.onchange = () => { state.diffOnly = diffOnly.checked; state.sel.clear(); paint_(); };
    d.oncancel = e => { if (state.panel) { e.preventDefault(); panel.hidden = true; panel.replaceChildren(); state.panel = null; wrap.focus(); } };
    d.onclose = () => d.remove();
    document.body.append(d);
    globalThis.AtriumShell.adoptDialog(d, {title: heading, body: wrap, actions: foot, initialFocus: wrap});
    d.showModal();
    if (list(c.live()).length) { state.compareA = "@base"; state.compareB = state.focus || ""; }
    paint_();
    if (model.shown.length && model.variants.length) { state.sel.add("0:1"); state.anchor = {r: 0, c: 1}; state.cursor = {r: 0, c: 1}; paintSelection(); }
    wrap.focus();
    return d;
  }

  // ---- Status bar switcher
  function syncSwitcher(force) {
    if (!switcher || !host) return;
    const p = host.project?.();
    const vs = list(p), sig = vs.map(v => v.id + "\u0001" + v.name).join("\u0002") + "|" + (p?.activeVariant || "");
    if (!force && sig === switchSig) return;
    switchSig = sig;
    const {root, select:s} = switcher;
    root.hidden = !vs.length;
    if (!vs.length) { s.replaceChildren(); return; }
    s.replaceChildren(new Option("Base design", ""), ...vs.map(v => new Option(v.name, v.id)));
    const sep = new Option("──────────", "@sep"); sep.disabled = true;
    s.append(sep, new Option("Manage variants…", "@manage"));
    const active = find(p, p?.activeVariant);
    s.value = active ? active.id : "";
    switcher.root.classList.toggle("has-variant", !!active);
    switcher.root.title = active ? "Active assembly variant: " + active.name + (active.description ? " — " + active.description : "") + ". Not-fitted parts are crossed out; outputs use this variant." :
      "Assembly variant: the base design. Choose a variant to see and output it.";
  }
  function installSwitcher() {
    const bar = document.querySelector("footer.statusbar");
    if (!bar || bar.querySelector(".variant-switch")) return;
    const root = el("label", null, "variant-switch");
    const select = el("select", null, "status-action"); select.setAttribute("aria-label", "Active assembly variant");
    root.append(el("span", "Variant", "variant-switch-label"), select);
    const anchor = bar.querySelector("#doc-kind");
    if (anchor) anchor.after(root); else bar.append(root);
    switcher = {root, select};
    select.onchange = () => {
      const v = select.value;
      if (v === "@manage") { syncSwitcher(true); open({}); return; }
      if (v === "@sep") return;
      activate(contextFrom({}), v || null);
    };
    syncSwitcher(true);
  }
  // No variants: only base do-not-populate parts are drawn not fitted. A part can be one only with a
  // fitted-state field, a parameter whose name could mark it, or a value that could; when no part of
  // the project has any of these, notFittedBoxes() returns nothing, so the overlay skips it.
  const DNP_KEY = /dn|pop|fit|stuff|variant|assembl|status/i, DNP_VALUE = /dn[pif]|pop|fit|stuff|place|mount/i;
  const maybeParams = o => { if (obj(o)) for (const k in o) if (DNP_KEY.test(k)) return true; return false; };
  function mayBeDnp(project, defs) {
    const byDef = new Map();
    for (const doc of project.documents || []) for (const i of doc.items || []) {
      if (i.kind !== "part") continue;
      if (i.dnp !== undefined || i.doNotPopulate !== undefined || i.populate !== undefined || i.fitted !== undefined || maybeParams(i.parameters)) return true;
      if (i.value != null && DNP_VALUE.test(String(i.value))) return true;
      let d = byDef.get(i.def);
      if (d === undefined) { const def = defs?.get?.(i.def) ?? (project.library || []).find(x => x.id === i.def); byDef.set(i.def, d = maybeParams(def?.parameters)); }
      if (d) return true;
    }
    return false;
  }
  function install(h) {
    host = h;
    h.registerAction?.("variants", () => { try { open({}); } catch (e) { h.info?.(e.message); } });
    globalThis.AtriumNavCommon?.menuItem?.("project", "variants", "Variants…", {after: "compare"});
    if (hasDOM()) installSwitcher();
    h.on?.("change", () => syncSwitcher(false));
    let cache = {project: null, key: "", boxes: []};
    h.addRenderer?.(doc => {
      syncSwitcher(false);
      const p = h.project?.();
      if (!p || !doc) return null;
      const key = h.revision?.() + "|" + doc.id + "|" + (p.activeVariant || "");
      if (cache.project !== p || cache.key !== key) {
        let boxes = [];
        try { boxes = list(p).length || mayBeDnp(p, h.defs?.()) ? notFittedBoxes(p, doc) : []; } catch { boxes = []; }
        cache = {project: p, key, boxes};
      }
      const boxes = cache.boxes;
      if (!boxes.length) return null;
      return {overlay: (ctx, v) => paint(ctx, boxes, v.scale, doc.kind)};
    });
  }
  globalThis.AtriumNavCommon?.ready?.(install);

  return Object.freeze({validate, list, find, current, resolve, apply, forOutput, appliedParameters, appliedDescription, includer, compare, rows, keyOf, baseDnp,
    create, duplicate, rename, remove, setActive, setParts, parseParams, formatParams, notFittedBoxes, paint, open, LIMIT});
})();
