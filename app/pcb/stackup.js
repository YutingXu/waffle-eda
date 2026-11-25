"use strict";

// Layer Stack Manager. A PCB document may carry its physical build-up as
// doc.stackup = {version, layers, drillPairs}. Layers run from the top of the
// board to the bottom. Copper layers (Signal or Plane) map to the Waffle layer
// keys in stack order: the first is Top, the last is Bottom and the ones
// between are Inner 1, Inner 2, ... The key of a copper layer is therefore its
// position, and every edit that changes positions renumbers the objects that
// sit on those layers. A document without a stored stack gets Altium's default
// two-layer build-up, widened to the inner layers its objects already use.
//
// Rigid-flex (optional keys; older readers ignore them):
//   main: {name, flex}             the master stack's substack name and kind
//   substacks: [{id, name, flex, layers}]  further substacks. Copper records
//                                  carry `key`, the master copper layer they
//                                  share; their own dielectrics, coverlay,
//                                  adhesive and stiffener layers sit between.
//   regions, bends                 board regions and bend lines (rigid-flex.js)
//   impedanceProfiles: [{id, name, type:"single"|"diff"|"cpw"|"cpw-diff",
//     target, tolerance (%), window? (%), policy?:"fab", neck?:{maxLength},
//     stack?, layers:{KEY:{width?, gap?, ground?, reference:[KEY|null, KEY|null],
//     etch, enabled}}}]
//     width null = solved from the target; gap = pair gap; ground = gap to
//     coplanar ground. Keys follow the master copper layers when they move.
//     tolerance is the fab's spec (DRC flags outside it); window is the DRC
//     design window (warns outside it). policy "fab" (new and generated
//     profiles): limits from the board's fab preset, the gap order of
//     SOLVER_POLICY and window = tolerance / 2 by default. Profiles without
//     a policy keep the calculator defaults and window = tolerance.
globalThis.AtriumStackup = (() => {
  const VERSION = 1, OZ = 0.035, MAX_COPPER = 128, TARGET = 1.6;
  const TYPES = Object.freeze(["Signal", "Plane", "Dielectric", "Solder Mask", "Overlay", "Surface Finish", "Coverlay", "Adhesive", "Stiffener"]);
  const FLEX = {coverlay:{material:"Polyimide coverlay", thickness:0.0125, dk:3.4, df:0.004}, adhesive:{material:"Acrylic adhesive", thickness:0.025, dk:3.6, df:0.02},
    core:{material:"Polyimide", thickness:0.05, dk:3.4, df:0.004}, stiffener:{material:"FR-4", thickness:0.2, dk:4.4}};
  const INSULATING = new Set(["Dielectric", "Adhesive"]);
  const DIELECTRICS = Object.freeze(["Core", "Prepreg"]);
  const MASK = {material:"Solder Resist", thickness:0.01016, dk:3.5};
  const CORE = {material:"FR-4", dk:4.8, df:0.02}, PREPREG = {material:"FR-4 Prepreg", dk:4.2, df:0.02};
  const isCopper = l => !!l && (l.type === "Signal" || l.type === "Plane");
  const obj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const round = (v, digits = 6) => Number(v.toFixed(digits)) + 0;
  const sum = list => list.reduce((s, v) => s + v, 0);
  function copperIndex(key) {
    if (key === "Top") return 0;
    if (key === "Bottom") return 127;
    const m = /^Inner ([1-9]\d?|1[01]\d|12[0-6])$/.exec(key || "");
    return m ? Number(m[1]) : -1;
  }
  const keyAt = (i, n) => i === 0 ? "Top" : i === n - 1 ? "Bottom" : "Inner " + i;
  const weight = thickness => round(thickness / OZ, 3);

  // ---- Layer records ----
  function copper(type, name, thickness = OZ) {return {type, name, material:"Copper", thickness};}
  function dielectric(kind, name, thickness) {
    const base = kind === "Prepreg" ? PREPREG : CORE;
    return {type:"Dielectric", name, material:base.material, thickness, dielectric:kind, dk:base.dk, df:base.df};
  }
  const mask = side => ({type:"Solder Mask", name:side + " Solder", material:MASK.material, thickness:MASK.thickness, dk:MASK.dk});
  const overlay = side => ({type:"Overlay", name:side + " Overlay", material:"", thickness:0});
  const finish = side => ({type:"Surface Finish", name:side + " Surface Finish", material:"ENIG", thickness:0.0001});
  function blank(type, name) {
    if (type === "Signal" || type === "Plane") return copper(type, name || (type === "Plane" ? "Plane" : "Signal"));
    if (type === "Core" || type === "Prepreg") return dielectric(type, name || "Dielectric", type === "Core" ? 0.2 : 0.1);
    if (type === "Dielectric") return dielectric("Core", name || "Dielectric", 0.2);
    if (type === "Solder Mask") return {...mask("Top"), name:name || "Solder Mask"};
    if (type === "Overlay") return {...overlay("Top"), name:name || "Overlay"};
    if (type === "Surface Finish") return {...finish("Top"), name:name || "Surface Finish"};
    if (type === "Coverlay") return {type, name:name || "Coverlay", ...FLEX.coverlay};
    if (type === "Adhesive") return {type, name:name || "Adhesive", ...FLEX.adhesive};
    if (type === "Stiffener") return {type, name:name || "Stiffener", ...FLEX.stiffener};
    if (type === "Polyimide") return {type:"Dielectric", name:name || "Polyimide", dielectric:"Core", ...FLEX.core};
    throw Error("Unknown layer type " + type + ".");
  }
  function innerName(type, i, names) {
    return names?.[i] || (type === "Plane" ? "Internal Plane " + i : "Mid-Layer " + i);
  }
  // A symmetric build-up near 1.6 mm. Dielectrics alternate prepreg and core
  // from the outside in; cores take up what the copper, prepreg and solder
  // mask leave of the target thickness.
  function build(kinds, names = []) {
    const n = kinds.length;
    if (n < 2 || n > MAX_COPPER) throw Error("A layer stack needs 2 to " + MAX_COPPER + " copper layers.");
    const copperT = kinds.map((t, i) => i === 0 || i === n - 1 || n <= 4 || t === "Plane" ? OZ : OZ / 2);
    const gaps = Array.from({length:n - 1}, (_, i) => n === 2 ? "Core" : i % 2 ? "Core" : "Prepreg");
    const prepreg = n <= 4 ? 0.2 : n <= 6 ? 0.12 : 0.1, cores = gaps.filter(g => g === "Core").length;
    const fixed = 2 * MASK.thickness + sum(copperT) + (gaps.length - cores) * prepreg;
    const core = Math.max(0.1, Math.round((TARGET - fixed) / cores * 100) / 100);
    const layers = [overlay("Top"), mask("Top")];
    kinds.forEach((type, i) => {
      const name = i === 0 ? names[0] || "Top Layer" : i === n - 1 ? names[n - 1] || "Bottom Layer" : innerName(type, i, names);
      layers.push(copper(type, name, copperT[i]));
      if (i < n - 1) layers.push(dielectric(gaps[i], "Dielectric " + (i + 1), gaps[i] === "Core" ? core : prepreg));
    });
    layers.push(mask("Bottom"), overlay("Bottom"));
    return finishStack({version:VERSION, layers, drillPairs:[]});
  }
  const S = "Signal", P = "Plane";
  const PRESETS = Object.freeze([
    {id:"2", label:"2 layers", kinds:[S, S], names:[]},
    {id:"4", label:"4 layers · Signal / GND / PWR / Signal", kinds:[S, P, P, S], names:[, "GND", "PWR"]},
    {id:"6", label:"6 layers · Signal / GND / Signal / Signal / PWR / Signal", kinds:[S, P, S, S, P, S], names:[, "GND", , , "PWR"]},
    {id:"8", label:"8 layers · Signal / GND / Signal / GND / PWR / Signal / GND / Signal", kinds:[S, P, S, P, P, S, P, S], names:[, "GND", , "GND", "PWR", , "GND"]}
  ].map(p => Object.freeze(p)));
  function preset(id) {
    const p = PRESETS.find(v => v.id === String(id));
    if (!p) throw Error("Unknown layer stack preset " + id + ".");
    return build(p.kinds, p.names);
  }

  // ---- Validation ----
  function cleanLayer(raw, n) {
    const where = "Layer " + (n + 1);
    if (!obj(raw) || !TYPES.includes(raw.type)) throw Error(where + " has an unknown type.");
    const thickness = Number(raw.thickness);
    if (!Number.isFinite(thickness) || thickness < 0 || thickness > 10) throw Error(where + " has an invalid thickness.");
    if ((isCopper(raw) || raw.type === "Dielectric" || raw.type === "Coverlay" || raw.type === "Adhesive" || raw.type === "Stiffener") && !(thickness > 0)) throw Error(where + " needs a thickness above zero.");
    const layer = {type:raw.type, name:typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 80) : raw.type,
      material:typeof raw.material === "string" ? raw.material.slice(0, 80) : "", thickness:round(thickness)};
    if (raw.type === "Dielectric") layer.dielectric = DIELECTRICS.includes(raw.dielectric) ? raw.dielectric : "Core";
    for (const [field, low, high] of [["dk", 1, 20], ["df", 0, 1]]) {
      if (raw[field] == null || raw[field] === "") continue;
      const v = Number(raw[field]);
      if (!Number.isFinite(v) || v < low || v > high) throw Error(where + " has an invalid " + (field === "dk" ? "Dk" : "Df") + ".");
      if (raw.type === "Dielectric" || raw.type === "Solder Mask" || raw.type === "Coverlay" || raw.type === "Adhesive" || raw.type === "Stiffener" && field === "dk") layer[field] = v;
    }
    return keepUnknown(layer, raw, LAYER_KEYS);
  }
  // Forward compatibility: fields a newer Waffle wrote on a layer or the stack are carried through
  // normalize (so through every stack edit) unchanged. A stack of a newer version, or with a layer
  // type this build doesn't know, can't be read: the board shows a derived stack (stored() is null)
  // and every writer refuses (guard), so the saved stack stays untouched.
  const LAYER_KEYS = ["type", "name", "material", "thickness", "dielectric", "dk", "df", "key", "source", "orig", "uid"]; // the last three: editor rows
  function keepUnknown(o, raw, known) {
    for (const k of Object.keys(raw)) if (!known.includes(k) && !Object.hasOwn(o, k) && k !== "__proto__") o[k] = JSON.parse(JSON.stringify(raw[k] ?? null));
    return o;
  }
  const newerStack = raw => obj(raw) && (typeof raw.version === "number" && raw.version > VERSION || Array.isArray(raw.layers) && raw.layers.some(l => obj(l) && typeof l.type === "string" && !TYPES.includes(l.type)));
  function guard(doc) {
    if (newerStack(doc?.stackup)) throw Error("This board's layer stack was saved by a newer version of Waffle. This version can't change it; it shows a stack derived from the board and keeps the saved one unchanged.");
  }
  // Problems with the order of layers, as sentences. Empty when valid.
  // A substack (minCopper 1) may be a single-sided flex.
  function problems(layers, minCopper = 2) {
    const out = [], idx = layers.map((l, i) => isCopper(l) ? i : -1).filter(i => i >= 0);
    if (idx.length < minCopper) out.push(minCopper > 1 ? "A board needs at least two copper layers." : "A substack needs at least one copper layer.");
    if (idx.length > MAX_COPPER) out.push("Waffle supports at most " + MAX_COPPER + " copper layers.");
    if (!idx.length) return out;
    const first = idx[0], last = idx.at(-1);
    layers.forEach((l, i) => {
      if (l.type === "Dielectric" && (i < first || i > last)) out.push(l.name + ": dielectric layers belong between copper layers.");
      if (!isCopper(l) && !INSULATING.has(l.type) && i > first && i < last) out.push(l.name + ": " + l.type.toLowerCase() + " layers belong outside the copper layers.");
    });
    for (let k = 1; k < idx.length; k++) {
      if (!layers.slice(idx[k - 1] + 1, idx[k]).some(l => INSULATING.has(l.type)))
        out.push(layers[idx[k - 1]].name + " and " + layers[idx[k]].name + " need a dielectric between them.");
    }
    return out;
  }
  function finishStack(stack) {
    const n = stack.layers.filter(isCopper).length;
    let i = 0;
    for (const l of stack.layers) if (isCopper(l)) l.key = keyAt(i++, n);
    return stack;
  }
  function cleanPairs(list, keys) {
    const out = [], seen = new Set();
    for (const p of Array.isArray(list) ? list : []) {
      if (!obj(p) || !keys.includes(p.from) || !keys.includes(p.to) || p.from === p.to) continue;
      const [from, to] = copperIndex(p.from) < copperIndex(p.to) ? [p.from, p.to] : [p.to, p.from];
      if (seen.has(from + "|" + to)) continue;
      seen.add(from + "|" + to); out.push({from, to});
    }
    return out;
  }
  // A clean copy of a stored stack. Throws a readable Error when it is unusable.
  function normalize(raw) {
    if (!obj(raw) || !Array.isArray(raw.layers)) throw Error("The layer stack is not readable.");
    if (raw.version != null && raw.version !== VERSION) throw Error("This layer stack was saved by a newer version of Waffle.");
    const layers = raw.layers.map(cleanLayer), issues = problems(layers);
    if (issues.length) throw Error(issues[0]);
    const stack = finishStack({version:VERSION, layers, drillPairs:[]});
    stack.drillPairs = cleanPairs(raw.drillPairs, stack.layers.filter(isCopper).map(l => l.key));
    if (typeof raw.source === "string") stack.source = raw.source.slice(0, 40);
    Object.assign(stack, cleanExtras(raw, stack));
    return keepUnknown(stack, raw, ["version", "layers", "drillPairs", "source", "derived", ...EXTRAS]);
  }

  // ---- Rigid-flex and impedance extras ----
  const str = (v, max = 80) => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
  const pt = p => Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(+v) && Math.abs(v) < 1e8);
  function cleanSubstack(raw, n, keys, master) {
    const name = str(raw?.name) || "Substack " + (n + 2);
    if (!obj(raw) || !Array.isArray(raw.layers)) throw Error(name + " is not readable.");
    const layers = raw.layers.map((l, i) => {
      const c = cleanLayer(l, i);
      if (!isCopper(c)) return c;
      if (!keys.includes(l.key)) throw Error(name + ": copper layer " + (c.name || i + 1) + " must share a copper layer of the main stack.");
      const m = master.find(x => x.key === l.key);
      return {type:m.type, name:m.name, material:m.material, thickness:m.thickness, key:l.key};
    });
    const issue = problems(layers, 1)[0];
    if (issue) throw Error(name + ": " + issue);
    const ck = layers.filter(isCopper).map(l => copperIndex(l.key));
    if (ck.some((v, i) => i && v <= ck[i - 1])) throw Error(name + ": shared copper layers must keep the main stack order.");
    return {id:str(raw.id, 64) || "substack-" + (n + 1), name, flex:!!raw.flex, layers};
  }
  const PROFILE_TYPES = ["single", "diff", "cpw", "cpw-diff"];
  function cleanProfile(raw, n, keys) {
    if (!obj(raw)) return null;
    const num = (v, lo, hi) => {const x = Number(v); return v != null && v !== "" && Number.isFinite(x) && x >= lo && x <= hi ? x : null;};
    const p = {id:str(raw.id, 64) || "profile-" + (n + 1), name:str(raw.name) || "Profile " + (n + 1), type:PROFILE_TYPES.includes(raw.type) ? raw.type : "single",
      target:num(raw.target, 1, 1000) ?? 50, tolerance:num(raw.tolerance, 0, 100) ?? 10, layers:{}};
    const win = num(raw.window, 0, 100);
    if (win != null) p.window = win;
    if (raw.policy === "fab") p.policy = "fab";
    const neck = obj(raw.neck) ? num(raw.neck.maxLength, 0, 1000) : null;
    if (neck != null) p.neck = {maxLength:neck};
    if (str(raw.stack, 64)) p.stack = str(raw.stack, 64);
    for (const [k, e] of Object.entries(obj(raw.layers) ? raw.layers : {})) {
      if (!keys.includes(k) || !obj(e)) continue;
      const ref = Array.isArray(e.reference) ? e.reference : [];
      const out = {enabled:e.enabled !== false, reference:[keys.includes(ref[0]) ? ref[0] : null, keys.includes(ref[1]) ? ref[1] : null], etch:num(e.etch, 0, 100) ?? 0};
      for (const f of ["width", "gap", "ground"]) {const v = num(e[f], 1e-4, 100); if (v != null && v > 0) out[f] = v;}
      if (!Array.isArray(e.reference)) delete out.reference;
      p.layers[k] = out;
    }
    return p;
  }
  function cleanExtras(raw, stack) {
    const out = {}, cu = copperOf(stack), keys = cu.map(l => l.key);
    if (obj(raw.main) && (str(raw.main.name) || raw.main.flex)) out.main = {name:str(raw.main.name) || "Main", flex:!!raw.main.flex};
    if (Array.isArray(raw.substacks) && raw.substacks.length) {
      const subs = raw.substacks.map((s, i) => cleanSubstack(s, i, keys, cu)), ids = new Set(["main"]);
      for (const s of subs) {while (ids.has(s.id)) s.id += "-2"; ids.add(s.id);}
      out.substacks = subs;
    }
    const ids = new Set(["main", ...(out.substacks || []).map(s => s.id)]);
    if (Array.isArray(raw.regions) && raw.regions.length) {
      const seen = new Set();
      out.regions = raw.regions.filter(r => obj(r) && Array.isArray(r.points) && r.points.length >= 3 && r.points.every(pt)).map((r, i) => {
        let id = str(r.id, 64) || "region-" + (i + 1);
        while (seen.has(id)) id += "-2";
        seen.add(id);
        return {id, name:str(r.name) || id, stack:ids.has(r.stack) ? r.stack : "main", points:r.points.map(q => [+q[0], +q[1]])};
      });
      if (!out.regions.length) delete out.regions;
    }
    if (Array.isArray(raw.bends) && raw.bends.length) {
      out.bends = raw.bends.filter(b => obj(b) && pt(b.a) && pt(b.b)).map((b, i) => ({id:str(b.id, 64) || "bend-" + (i + 1), name:str(b.name) || "Bend " + (i + 1),
        a:[+b.a[0], +b.a[1]], b:[+b.b[0], +b.b[1]], angle:Number.isFinite(+b.angle) ? Math.max(-180, Math.min(180, +b.angle)) : 90,
        radius:+b.radius > 0 && +b.radius <= 1000 ? +b.radius : 1, width:+b.width >= 0 && +b.width <= 1000 ? +b.width : 0, dynamic:!!b.dynamic,
        ...(Number.isInteger(+b.order) && +b.order >= 1 && +b.order <= 99 ? {order:+b.order} : {})}));
      if (!out.bends.length) delete out.bends;
    }
    if (Array.isArray(raw.impedanceProfiles) && raw.impedanceProfiles.length) {
      const seen = new Set();
      out.impedanceProfiles = raw.impedanceProfiles.map((p, i) => cleanProfile(p, i, keys)).filter(p => p && !seen.has(p.id) && seen.add(p.id));
      for (const p of out.impedanceProfiles) if (p.stack && !ids.has(p.stack)) delete p.stack;
      if (!out.impedanceProfiles.length) delete out.impedanceProfiles;
    }
    return out;
  }
  const EXTRAS = ["main", "substacks", "regions", "bends", "impedanceProfiles"];
  // Copy of the extras with copper keys renamed by `target` (null drops a key).
  function remapExtras(stack, target) {
    const out = {};
    for (const k of EXTRAS) if (stack[k] != null) out[k] = JSON.parse(JSON.stringify(stack[k]));
    for (const s of out.substacks || []) {
      s.layers = s.layers.filter(l => !isCopper(l) || target(l.key)).map(l => isCopper(l) ? {...l, key:target(l.key)} : l);
      // A dropped shared layer can leave dielectrics outside the copper; remove them.
      const a = s.layers.findIndex(isCopper), b = s.layers.length - 1 - [...s.layers].reverse().findIndex(isCopper);
      if (a >= 0) s.layers = s.layers.filter((l, i) => l.type !== "Dielectric" || (i > a && i < b));
    }
    for (const p of out.impedanceProfiles || []) {
      const layers = {};
      for (const [k, e] of Object.entries(p.layers)) {
        const t = target(k);
        if (!t) continue;
        if (e.reference) e.reference = e.reference.map(r => r == null ? null : target(r) || null);
        layers[t] = e;
      }
      p.layers = layers;
    }
    return out;
  }
  // Every substack, the main (master) stack first, as {id, name, flex, layers}.
  function substacks(stackOrDoc, defs) {
    const stack = stackOrDoc?.layers ? stackOrDoc : get(stackOrDoc, defs);
    return [{id:"main", name:stack.main?.name || (stack.substacks?.length ? "Rigid" : "Main"), flex:!!stack.main?.flex, layers:stack.layers, main:true},
      ...(stack.substacks || []).map(s => ({...s, layers:s.layers.map(l => isCopper(l) ? {...stack.layers.find(m => m.key === l.key), key:l.key} : l)}))];
  }
  // A flex substack sharing the given master copper keys: coverlay, adhesive,
  // copper, polyimide core, ... mirrored at the bottom.
  function flexLayers(keys, master) {
    const out = [{type:"Coverlay", name:"Top Coverlay", ...FLEX.coverlay}, {type:"Adhesive", name:"Top Coverlay Adhesive", ...FLEX.adhesive}];
    keys.forEach((k, i) => {
      const m = master.find(l => l.key === k) || {type:"Signal", name:k, material:"Copper", thickness:OZ / 2};
      out.push({type:m.type, name:m.name, material:"Copper", thickness:m.thickness, key:k});
      if (i < keys.length - 1) out.push({type:"Dielectric", name:"Polyimide " + (i + 1), dielectric:"Core", ...FLEX.core});
    });
    out.push({type:"Adhesive", name:"Bottom Coverlay Adhesive", ...FLEX.adhesive}, {type:"Coverlay", name:"Bottom Coverlay", ...FLEX.coverlay});
    return out;
  }

  // ---- Reading a document ----
  const parts = doc => (doc?.items || []).filter(i => i.kind === "part");
  function footprints(doc, defs) {
    const seen = new Set(), out = [];
    for (const p of parts(doc)) {
      const def = defs?.get?.(p.def);
      if (def?.footprint && !seen.has(def)) {seen.add(def); out.push(def);}
    }
    return out;
  }
  // Every reader of a board without a stored stack derives it, several times per edit. The undo
  // journal shows when the edits since the last scan kept every changed item's layers and footprint.
  const innerMemo = new WeakMap();
  const sameLayers = (was, i) => was.layer === i.layer && was.fromLayer === i.fromLayer && was.toLayer === i.toLayer && was.def === i.def;
  function deepestInner(doc, defs, index) {
    let deepest = 0;
    const see = o => {for (const k of [o.layer, o.fromLayer, o.toLayer]) {const n = copperIndex(k); if (n > 0 && n < 127) deepest = Math.max(deepest, n);}};
    const U = globalThis.AtriumUndoStore, v = doc?.items ? U?.documentVersions?.(doc) : null, m = v && innerMemo.get(doc);
    if (m && m.items === doc.items && m.length === doc.items.length && m.defs === defs && m.library === v.library && m.pours === v.pours &&
        m.outer === v.outer && m.seq >= v.floor && m.seq <= v.seq && (m.seq === v.seq || U.onlyRecordedItemUpdates?.(doc, m.seq, sameLayers))) {
      m.seq = v.seq;
      return m.value;
    }
    const used = new Set();
    if (index?.board === doc && index.defs === defs) {
      for (const l of index.stackLayers.keys()) if (l > 0 && l < 127) deepest = Math.max(deepest, l);
      for (const id of index.footprintIds.keys()) used.add(id);
    } else for (const item of doc?.items || []) {
      see(item);
      if (item.kind === "part") used.add(item.def);
    }
    for (const id of used) {
      const fp = defs?.get?.(id)?.footprint;
      fp?.pads?.forEach(see); fp?.shapes?.forEach(see);
    }
    for (const r of doc?.pcbDrawing?.pours || []) see(r);
    if (v) innerMemo.set(doc, {items: doc.items, length: doc.items.length, defs, library: v.library, pours: v.pours, outer: v.outer, seq: v.seq, value: deepest});
    return deepest;
  }
  function derive(doc, defs, index) {
    const stack = build(Array(deepestInner(doc, defs, index) + 2).fill("Signal"));
    stack.derived = true;
    return stack;
  }
  // The stored stack, or null when there is none (or it cannot be read).
  function stored(doc) {
    if (doc?.stackup == null) return null;
    try {return normalize(doc.stackup);} catch {return null;}
  }
  const get = (doc, defs, index) => stored(doc) || derive(doc, defs, index);
  const copperOf = stack => stack.layers.filter(isCopper);
  const copperLayers = (doc, defs) => copperOf(get(doc, defs)).map(l => l.key);
  const total = stack => round(sum(stack.layers.map(l => l.thickness)));
  const thickness = (doc, defs, stack = get(doc, defs)) => total(stack);
  function layerDepths(stack) {
    let depth = 0;
    return stack.layers.map(row => {
      const z = depth;
      depth += row.thickness;
      return {row, z, end: depth};
    });
  }

  const SIDES = {Silk:["Overlay", "Top"], "Bottom silk":["Overlay", "Bottom"], "Top mask":["Solder Mask", "Top"],
    "Bottom mask":["Solder Mask", "Bottom"], "Top paste":["Paste", "Top"], "Bottom paste":["Paste", "Bottom"]};
  // Physical facts about one Waffle layer key, with the Gerber X2 file function
  // (TF.FileFunction) a fabrication exporter would write for it.
  function layerInfo(doc, key, defs, stack = get(doc, defs)) {
    const list = stack.layers, cu = copperOf(stack);
    const at = l => round(sum(list.slice(0, list.indexOf(l)).map(v => v.thickness)));
    const n = cu.findIndex(l => l.key === key);
    if (n >= 0) {
      const l = cu[n], side = n === 0 ? "Top" : n === cu.length - 1 ? "Bottom" : "Inner";
      return {key, name:l.name, type:l.type, material:l.material, thickness:l.thickness, weight:weight(l.thickness),
        copper:true, number:n + 1, count:cu.length, side, z:at(l), stackIndex:list.indexOf(l),
        fileFunction:"Copper,L" + (n + 1) + "," + (side === "Inner" ? "Inr" : side === "Top" ? "Top" : "Bot") + "," + (l.type === "Plane" ? "Plane" : "Signal"),
        filePolarity:"Positive"};
    }
    const flexKey = /^(Top|Bottom) (coverlay|stiffener)$/.exec(key || "");
    if (flexKey) {
      const [, side, what] = flexKey, type = what === "coverlay" ? "Coverlay" : "Stiffener", x2 = side === "Top" ? "Top" : "Bot";
      const subs = substacks(stack), hit = subs.map(s => {const c = s.layers.findIndex(isCopper), d = s.layers.length - 1 - [...s.layers].reverse().findIndex(isCopper);
        return (side === "Top" ? s.layers.slice(0, c) : s.layers.slice(d + 1)).find(l => l.type === type);}).find(Boolean);
      if (!hit) return null;
      // X2 has Coverlay (2021+ spec); stiffeners have no file function, so Other.
      return {key, name:hit.name, type, material:hit.material || "", thickness:hit.thickness, copper:false, side, stackIndex:-1,
        fileFunction:type === "Coverlay" ? "Other,Coverlay" + x2 : "Other,Stiffener" + x2, filePolarity:"Positive"};
    }
    const fixed = SIDES[key];
    if (!fixed) return null;
    const [type, side] = fixed, x2 = side === "Top" ? "Top" : "Bot";
    const fileFunction = (type === "Overlay" ? "Legend" : type === "Solder Mask" ? "Soldermask" : "Paste") + "," + x2;
    const filePolarity = type === "Solder Mask" ? "Negative" : "Positive";
    const outer = side === "Top" ? list.slice(0, list.indexOf(cu[0])) : list.slice(list.indexOf(cu.at(-1)) + 1);
    const l = type === "Paste" ? null : (side === "Top" ? [...outer].reverse() : outer).find(v => v.type === type);
    return {key, name:l?.name || (side + " " + type), type, material:l?.material || "", thickness:l?.thickness || 0, copper:false, side,
      z:l ? at(l) : side === "Top" ? 0 : total(stack), stackIndex:l ? list.indexOf(l) : -1, fileFunction, filePolarity};
  }

  // ---- Drill pairs ----
  const nonPlated = o => o.drill > 0 && (o.plated === false || o.layer === "Mechanical" || o.drill >= Math.min(o.w ?? o.diameter ?? Infinity, o.h ?? o.diameter ?? Infinity));
  function pairName(stack, from, to) {
    const name = k => copperOf(stack).find(l => l.key === k)?.name || k;
    return name(from) + " - " + name(to);
  }
  // Every hole span: Altium's drill pairs. Through (Top to Bottom) always
  // comes first; blind spans touch one outer layer, buried spans none.
  function drillPairs(doc, defs, stack = get(doc, defs)) {
    const keys = copperOf(stack).map(l => l.key), top = keys[0], bottom = keys.at(-1);
    const pairs = new Map();
    function entry(a, b) {
      const [from, to] = copperIndex(a) <= copperIndex(b) ? [a, b] : [b, a];
      const id = from + "|" + to;
      if (!pairs.has(id)) {
        const i = keys.indexOf(from), j = keys.indexOf(to), valid = i >= 0 && j >= 0 && i !== j;
        const kind = from === top && to === bottom ? "through" : from === top || to === bottom ? "blind" : "buried";
        pairs.set(id, {from, to, kind, name:pairName(stack, from, to), vias:0, pads:0, npth:0, defined:kind === "through", valid,
          fileFunction:valid ? "Plated," + (i + 1) + "," + (j + 1) + "," + (kind === "through" ? "PTH" : kind === "blind" ? "Blind" : "Buried") : "",
          npthFunction:kind === "through" ? "NonPlated,1," + keys.length + ",NPTH" : ""});
      }
      return pairs.get(id);
    }
    entry(top, bottom);
    for (const p of stack.drillPairs || []) entry(p.from, p.to).defined = true;
    const hole = o => {
      if (!(o.drill > 0) && o.kind !== "via") return;
      const span = o.fromLayer || o.toLayer;
      const e = entry(o.fromLayer || top, o.toLayer || bottom);
      if (o.kind === "via" || span) e.vias++;
      else if (nonPlated(o)) e.npth++;
      else e.pads++;
    };
    for (const item of doc?.items || []) if (item.kind === "via" || item.kind === "pad") hole(item);
    for (const part of parts(doc)) for (const pad of defs?.get?.(part.def)?.footprint?.pads || []) hole(pad);
    return [...pairs.values()].map(p => ({...p, used:p.vias + p.pads + p.npth > 0}))
      .sort((a, b) => (a.kind !== "through") - (b.kind !== "through") || copperIndex(a.from) - copperIndex(b.from) || copperIndex(a.to) - copperIndex(b.to));
  }

  // ---- Objects on a copper layer ----
  const FIELDS = ["layer", "fromLayer", "toLayer"];
  const refers = (o, key) => FIELDS.some(f => o[f] === key);
  function usage(doc, defs, key) {
    const u = {total:0, tracks:0, vias:0, pads:0, other:0, footprints:0, pours:0};
    for (const item of doc?.items || []) {
      if (!refers(item, key)) continue;
      u.total++;
      if (item.kind === "track") u.tracks++;
      else if (item.kind === "via") u.vias++;
      else if (item.kind === "pad") u.pads++;
      else u.other++;
    }
    for (const part of parts(doc)) {
      const g = defs?.get?.(part.def)?.footprint;
      for (const o of [...(g?.pads || []), ...(g?.shapes || [])]) if (refers(o, key)) {u.total++; u.footprints++;}
    }
    for (const r of doc?.pcbDrawing?.pours || []) if (r.layer === key) {u.total++; u.pours++;}
    return u;
  }
  function describe(u) {
    const words = [["tracks", "track"], ["vias", "via"], ["pads", "pad"], ["footprints", "footprint primitive"], ["pours", "stored pour region"], ["other", "other object"]];
    return words.filter(([k]) => u[k]).map(([k, w]) => u[k] + " " + w + (u[k] === 1 ? "" : "s")).join(", ");
  }

  // ---- Changing the stack ----
  // nextLayers: the new layer list, top to bottom. A copper layer that already
  // existed carries `source`, its current key; new copper layers have none.
  // opts.moves maps a removed copper key to the current key of the layer that
  // receives its objects. opts.drillPairs, when given, uses the new keys.
  // Returns {ok, problems, stackup, map}; nothing is changed until apply().
  function plan(doc, defs, nextLayers, opts = {}) {
    const issues = [], before = get(doc, defs), oldKeys = copperOf(before).map(l => l.key);
    let stack;
    try {stack = normalize({version:VERSION, layers:nextLayers});}
    catch (error) {return {ok:false, problems:[error.message]};}
    const extra = problems(stack.layers);
    if (extra.length) return {ok:false, problems:extra};
    const map = new Map(), sources = new Set(), newCu = copperOf(stack);
    nextLayers.filter(isCopper).forEach((l, i) => {
      if (l.source == null) return;
      if (!oldKeys.includes(l.source) || sources.has(l.source)) issues.push("Copper layer " + l.source + " appears more than once.");
      sources.add(l.source); map.set(l.source, newCu[i].key);
    });
    const moves = opts.moves || {};
    for (const key of oldKeys.filter(k => !sources.has(k))) {
      const name = copperOf(before).find(l => l.key === key)?.name || key;
      if (moves[key] != null) {
        const target = map.get(moves[key]);
        if (!target) issues.push("The destination for objects on " + name + " is no longer in the stack.");
        else map.set(key, target);
        continue;
      }
      const u = usage(doc, defs, key);
      if (u.total) issues.push(name + " (" + key + ") still holds " + u.total + " object" + (u.total === 1 ? "" : "s") + ": " + describe(u) + ". Move them to another copper layer before removing it.");
      else map.set(key, null);
    }
    const target = k => map.has(k) ? map.get(k) : k;
    let collapsed = 0;
    const checkSpan = o => {if (o.fromLayer && o.toLayer && o.fromLayer !== o.toLayer && target(o.fromLayer) === target(o.toLayer)) collapsed++;};
    for (const item of doc?.items || []) checkSpan(item);
    const changing = [...map].filter(([a, b]) => a !== b);
    for (const def of footprints(doc, defs)) {
      for (const pad of def.footprint.pads || []) checkSpan(pad);
      const g = def.footprint, touches = changing.some(([k]) => [...(g.pads || []), ...(g.shapes || [])].some(o => refers(o, k)));
      const shared = touches && (opts.project?.documents || []).some(d => d !== doc && parts(d).some(p => p.def === def.id));
      if (shared) issues.push("Footprint " + (def.name || def.id) + " has copper on a renumbered layer and is also used by another document.");
    }
    if (collapsed) issues.push(collapsed + " blind or buried via" + (collapsed === 1 ? "" : "s") + " would start and end on the same layer. Change their spans first.");
    const keys = newCu.map(l => l.key);
    stack.drillPairs = cleanPairs(opts.drillPairs ?? (before.drillPairs || []).map(p => ({from:target(p.from), to:target(p.to)})), keys);
    // Substacks, profiles, regions and bends: given in the new keys, or carried over.
    try {Object.assign(stack, cleanExtras(opts.extras ?? remapExtras(before, target), stack));}
    catch (error) {issues.push(error.message);}
    for (const [k, v] of map) if (v === null) map.delete(k);
    return issues.length ? {ok:false, problems:issues} : {ok:true, problems:[], stackup:stack, map};
  }
  // Apply a successful plan inside the caller's undoable edit.
  function apply(doc, defs, result) {
    guard(doc);
    if (!result?.ok) throw Error(result?.problems?.[0] || "The layer stack change is not valid.");
    const map = new Map([...result.map].filter(([a, b]) => a !== b));
    let moved = 0;
    const remap = o => {for (const f of FIELDS) if (map.has(o[f])) {o[f] = map.get(o[f]); moved++;}};
    if (map.size) {
      for (const item of doc.items) remap(item);
      for (const def of footprints(doc, defs)) {(def.footprint.pads || []).forEach(remap); (def.footprint.shapes || []).forEach(remap);}
      for (const r of doc.pcbDrawing?.pours || []) remap(r);
    }
    const stack = JSON.parse(JSON.stringify(result.stackup));
    delete stack.derived;
    doc.stackup = stack;
    touch(doc);
    return moved;
  }

  // ---- Stack-up revision ----
  // Caches of values derived from doc.stackup (profile tables, delays, the
  // signature rules.js and router.js key on) compare a revision number instead
  // of serialising the stack on every lookup. One counter numbers every stack
  // object (WeakMap, so nothing is stored in the document): a stack object not
  // seen before gets a fresh number, so replacing doc.stackup (apply, imports,
  // Open, a collaborator's value, templates) needs no call. Code that edits
  // doc.stackup in place calls touch(doc): rigid-flex region and bend edits,
  // and undo-store.js for every record it applies or records under
  // doc.stackup (undo, redo, history jumps and the idle sync of an edit).
  let revCounter = 0;
  const revs = new WeakMap();
  // The stack's revision: a positive integer, or 0 for a document without a stored stack.
  function revision(doc) {
    const st = doc?.stackup;
    if (!obj(st)) return 0;
    let r = revs.get(st);
    if (r === undefined) revs.set(st, r = ++revCounter);
    return r;
  }
  // Mark doc.stackup as changed in place. Returns the new revision.
  function touch(doc) {
    const st = doc?.stackup;
    if (!obj(st)) return 0;
    const r = ++revCounter;
    revs.set(st, r);
    return r;
  }

  // ---- Impedance profiles (AtriumImpedance) ----
  const r4 = v => Number.isFinite(v) ? round(v, 4) : null;
  // Solver policy. Profiles without `policy` (every profile made before it existed) keep the
  // calculator's: width 0.025-10 mm, auto gap clamp(h, 0.075, 0.5), DRC window = tolerance.
  // policy "fab": width and gap limits from the board's fab preset (min track / min space;
  // DEFAULT_FAB on a board without one), and for an auto pair gap this order:
  //   1. gap = max(min space, clearance, gapPerH * h), solve the width;
  //   2. the width would be below the fab minimum: pin it there and widen the gap (Zdiff rises
  //      with the gap) up to maxGapPerH * h;
  //   3. still out of reach: unreachable, with the width it needs (impedance-plan.js ranks fixes).
  // DRC flags outside the spec tolerance and warns outside the window (windowShare * tolerance).
  const LEGACY_POLICY = Object.freeze({minWidth:0.025, maxWidth:10, gapMin:0.075, gapMax:0.5, gapSolveMin:0.02});
  const SOLVER_POLICY = Object.freeze({maxWidth:10, gapPerH:1, maxGapPerH:5, windowShare:0.5});
  const DEFAULT_FAB = Object.freeze({track:0.1, space:0.1, source:"default"});
  function policyLimits(opts) {
    const L = opts?.limits || {}, track = +L.track > 0 ? +L.track : DEFAULT_FAB.track, space = +L.space > 0 ? +L.space : DEFAULT_FAB.space;
    const clearance = +opts?.clearance > 0 ? +opts.clearance : +L.clearance > 0 ? +L.clearance : 0;
    return {track, space, clearance, source:L.source || (opts?.limits ? "given" : DEFAULT_FAB.source)};
  }
  // The board's fab limits {track, space, source}: its fab preset's minimum track and space
  // (fab-presets.js, when it and the vendor data are loaded), else DEFAULT_FAB.
  function fabLimits(doc) {
    let L = null;
    try {L = doc?.fabPreset && globalThis.AtriumFabPresets?.limits ? AtriumFabPresets.limits(doc) : null;} catch {L = null;}
    const track = +L?.track > 0 ? +L.track : null, space = +L?.space > 0 ? +L.space : null;
    return track || space ? {track:track ?? DEFAULT_FAB.track, space:space ?? DEFAULT_FAB.space, source:L.preset || "preset"} : {track:DEFAULT_FAB.track, space:DEFAULT_FAB.space, source:"default"};
  }
  // Resolved values of one profile on one copper layer of a stack:
  // {width, gap, ground, z, target, tolerance, minWidth, maxWidth, minGap,
  //  maxGap, result (AtriumImpedance.solve), geometry, within, stack}, or {error}.
  // stackId selects the substack whose geometry is used (a board region's
  // stack). The profile's layer rows (fixed width, references, etch) belong to
  // its own substack (profile.stack, default "main"); on any other substack
  // the width is solved from the target on that substack's build-up, keeping
  // the pair gap, coplanar gap and etch, and the references when that
  // substack has both reference layers.
  // minWidth/maxWidth are always the widths that give target (1 +/- tol), so
  // a fixed width outside the tolerance never widens the window; `within`
  // reports the fixed width separately.
  // opts.limits {track, space} (mm): the fab limits a policy "fab" profile
  // uses (profileValues passes fabLimits(doc)); opts.clearance (mm) the
  // layer's Clearance rule, which also floors the auto gap.
  function resolveProfileLayer(stack, profile, key, stackId, opts = {}) {
    const I = globalThis.AtriumImpedance;
    if (!I) return {error:"Impedance solver unavailable."};
    const home = profile.stack || "main", want = stackId || home;
    const own = profile.layers?.[key];
    if (!own || own.enabled === false) return null;
    const subs = substacks(stack), sub = subs.find(x => x.id === want) || (stackId ? null : subs[0]);
    if (!sub) return {error:"Unknown substack " + want + "."};
    if (!sub.layers.some(l => l.key === key)) return {error:"Layer is not in substack " + sub.name + "."};
    const foreign = sub.id !== home;
    let entry = own;
    if (foreign) {
      const has = k => k == null || sub.layers.some(l => l.key === k);
      entry = {enabled:true, etch:own.etch || 0, gap:own.gap, ground:own.ground};
      if (own.reference && own.reference.every(has)) entry.reference = own.reference;
    }
    const g = I.geometry(sub.layers, key, entry.reference || undefined);
    if (!g || g.structure === "none") return {error:"Choose a reference plane" + (foreign ? " in substack " + sub.name : "") + "."};
    const diff = profile.type === "diff" || profile.type === "cpw-diff", cop = profile.type === "cpw" || profile.type === "cpw-diff";
    const hRef = g.structure === "stripline" ? Math.min(g.h1, g.h2) : g.h, fab = profile.policy === "fab";
    const L = fab ? policyLimits(opts) : null, lim = fab ? {min:L.track, max:SOLVER_POLICY.maxWidth} : {min:LEGACY_POLICY.minWidth, max:LEGACY_POLICY.maxWidth};
    // Auto gaps: legacy clamp(h, 0.075, 0.5); fab max(min space, clearance, gapPerH * h).
    const dflt = fab ? Math.max(L.space, L.clearance, SOLVER_POLICY.gapPerH * hRef) : Math.min(LEGACY_POLICY.gapMax, Math.max(LEGACY_POLICY.gapMin, hRef));
    const geom = {structure:g.structure, t:g.t, er:g.er, tanD:g.tanD, h:g.h, h1:g.h1, h2:g.h2, cover:g.cover, etch:entry.etch || 0};
    if (diff) geom.s = entry.gap > 0 ? entry.gap : dflt;
    if (cop) geom.g = entry.ground > 0 ? entry.ground : dflt;
    const target = profile.target, tol = profile.tolerance / 100;
    const winPct = profile.window != null ? Math.min(profile.window, profile.tolerance) : fab ? profile.tolerance * SOLVER_POLICY.windowShare : profile.tolerance, win = winPct / 100;
    let width = entry.width > 0 ? entry.width : null, solved = false, step = entry.width > 0 ? "fixed" : fab ? "gap" : "legacy";
    const base = {stack:sub.id, policy:fab ? "fab" : "legacy", ...(fab ? {limits:L} : null)};
    if (!width) {
      const r = I.synthesize(geom, {target, ...lim});
      width = r.w; solved = true;
      if (!r.ok && fab && diff && !(entry.gap > 0) && r.w === lim.min) {
        // Gap order, step 2: the width would fall below the fab minimum, so pin it there and
        // widen the gap (Zdiff rises with the gap) up to maxGapPerH * h.
        const sMax = Math.max(geom.s * 1.001, SOLVER_POLICY.maxGapPerH * hRef), q = I.synthesize({...geom, w:lim.min}, {target, vary:"s", min:geom.s, max:sMax});
        if (q.ok) {geom.s = q.s; step = "pin-width";}
        else return {error:"The target needs a width below the fab minimum " + r4(lim.min) + " mm even at gap " + r4(sMax) + " mm.", unreachable:true, reason:"width", width:r4(lim.min), geometry:g, solved, ...base};
      } else if (!r.ok) {
        if (!fab) return {error:r.error, width:r4(width), geometry:g, solved, stack:sub.id};
        const need = I.synthesize(geom, {target, min:0.001, max:100}).w, low = r.w === lim.min;
        return {error:low ? "The target needs " + r4(need) + " mm, below the fab minimum width " + r4(lim.min) + " mm." : "The target needs " + r4(need) + " mm, above the " + lim.max + " mm width limit.",
          unreachable:true, reason:low ? "width" : "maxWidth", need:r4(need), width:r4(width), geometry:g, solved, ...base};
      }
    }
    const result = I.solve({...geom, w:width});
    if (!result.ok) return {error:result.error, geometry:g, stack:sub.id};
    const w = z => I.synthesize({...geom}, {target:z, ...lim}), sGap = z => I.synthesize({...geom, w:width}, {target:z, vary:"s", min:fab ? L.space : LEGACY_POLICY.gapSolveMin, max:5});
    // Wider is lower impedance: the max width gives target (1 - tol).
    const lo = tol > 0 ? w(target * (1 + tol)) : {w:width}, hi = tol > 0 ? w(target * (1 - tol)) : {w:width};
    const band = (f, at, edge, keyOf) => win > 0 && win < tol ? f(at) : win >= tol ? edge : {[keyOf]:keyOf === "w" ? width : geom.s};
    const wlo = band(w, target * (1 + win), lo, "w"), whi = band(w, target * (1 - win), hi, "w");
    const fixedZ = solved ? target : result.z;
    const out = {key, stack:sub.id, stackName:sub.name, width:r4(width), solved, gap:diff ? r4(geom.s) : null, ground:cop ? r4(geom.g) : null, z:result.z, target, tolerance:profile.tolerance,
      minWidth:r4(Math.min(lo.w, hi.w)), maxWidth:r4(Math.max(lo.w, hi.w)), within:Math.abs(fixedZ - target) <= target * tol * (1 + 1e-9) + 1e-9, result, geometry:g, geom:{...geom, w:width},
      window:winPct, warnMinWidth:r4(Math.min(wlo.w, whi.w)), warnMaxWidth:r4(Math.max(wlo.w, whi.w)), policy:base.policy, step};
    if (fab) out.limits = L;
    if (!out.within) out.warning = "Width " + r4(width) + " mm gives " + result.z.toFixed(1) + " \u03a9, outside " + target + " \u03a9 \u00b1" + profile.tolerance + " %.";
    if (diff) {
      const a = tol > 0 ? sGap(target * (1 - tol)) : {s:geom.s}, b = tol > 0 ? sGap(target * (1 + tol)) : {s:geom.s};
      out.minGap = r4(Math.min(a.s, b.s)); out.maxGap = r4(Math.max(a.s, b.s));
      const c = band(sGap, target * (1 - win), a, "s"), d = band(sGap, target * (1 + win), b, "s");
      out.warnMinGap = r4(Math.min(c.s, d.s)); out.warnMaxGap = r4(Math.max(c.s, d.s));
    }
    return out;
  }
  const profileCache = new WeakMap();
  function profileTable(doc, defs) {
    const st = doc?.stackup;
    if (!obj(st) || !Array.isArray(st.impedanceProfiles) || !st.impedanceProfiles.length) return null;
    const sig = revision(doc);
    let c = profileCache.get(st);
    if (!c || c.sig !== sig) {
      const stack = stored(doc);
      c = {sig, stack, values:new Map()};
      profileCache.set(st, c);
    }
    return c.stack ? c : null;
  }
  // A signature of everything the profile values depend on (the stored stack
  // with its regions and profiles): its revision. Callers that cache resolved
  // rules key them on it, because editor edits mutate doc.stackup in place.
  function signature(doc) {
    return obj(doc?.stackup) ? "rev:" + revision(doc) : "derived";
  }
  // The board's profiles (cleaned), or [].
  function impedanceProfiles(doc, defs) {const t = profileTable(doc, defs); return t ? t.stack.impedanceProfiles || [] : [];}
  // Profile values on a layer (cached per stack revision), or null. stackId
  // picks a substack (see resolveProfileLayer); omitted, the profile's own.
  // Policy "fab" profiles use the board's fab limits. They are read again when doc.fabPreset is
  // replaced, or while a recorded preset's data is not loaded yet.
  function tableLimits(t, doc) {
    if (!t.limits || t.fabRef !== doc.fabPreset || doc.fabPreset && t.limits.source === "default") {
      const L = fabLimits(doc);
      if (t.limits && (L.track !== t.limits.track || L.space !== t.limits.space)) t.values.clear();
      t.limits = L; t.fabRef = doc.fabPreset;
    }
    return t.limits;
  }
  function profileValues(doc, id, key, defs, stackId) {
    const t = profileTable(doc, defs);
    if (!t) return null;
    const k = id + "\u0001" + key + "\u0001" + (stackId || "");
    const limits = tableLimits(t, doc);
    if (!t.values.has(k)) {
      const p = (t.stack.impedanceProfiles || []).find(x => x.id === id || x.name === id);
      let v = null;
      try {v = p ? resolveProfileLayer(t.stack, p, key, stackId, {limits}) : null;} catch {v = null;}
      t.values.set(k, v);
    }
    return t.values.get(k);
  }
  // Substack id of the board region at point p, or null on a board without
  // regions (every point then uses the profile's own substack).
  function stackAt(doc, p, defs) {
    const RFx = globalThis.AtriumRigidFlex;
    if (!RFx || !Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    try {const R = RFx.regionsResolved(doc, defs); return R.split ? R.regionAt(p)?.stack || null : null;} catch {return null;}
  }
  // Profile values for a track path: one entry per substack the path runs
  // through, [{stack, region, at, values}], or a single {stack:null} entry on
  // a board without regions. values is null where the profile has no row.
  function profileAlong(doc, id, key, points, defs) {
    const RFx = globalThis.AtriumRigidFlex;
    let parts = null;
    try {parts = RFx?.stacksAlong ? RFx.stacksAlong(doc, points, defs) : null;} catch {parts = null;}
    if (!parts || !parts.length) return [{stack:null, region:null, at:points?.[0] || null, values:profileValues(doc, id, key, defs)}];
    return parts.map(p => ({...p, values:profileValues(doc, id, key, defs, p.stack)}));
  }
  // Propagation delay (ps/mm) of a track on a layer from its stack geometry,
  // or null without the impedance solver. Cached per stack revision.
  // opts (optional) makes it a differential pair's delay: the odd mode of the
  // edge-coupled pair (eeffOdd), which is what P and N travel at.
  //   opts.gap      pair gap (mm)
  //   opts.profile  an impedance profile id or name: its geometry on that layer
  //                 (references, etch, coplanar ground) and, without opts.gap,
  //                 its solved gap
  // A single track of the same width (no opts) is a few % off for tightly
  // coupled pairs, which matters when matching delay across layers.
  const delayCache = new WeakMap();
  function delay(doc, key, width, defs, opts) {
    const I = globalThis.AtriumImpedance;
    if (!I) return null;
    let c = delayCache.get(doc);
    const sig = obj(doc?.stackup) ? "rev:" + revision(doc) : "derived:" + (opts?.index ? deepestInner(doc, defs, opts.index) : "items:" + (doc?.items?.length || 0));
    if (!c || c.sig !== sig) {c = {sig, stack:get(doc, defs, opts?.index), values:new Map()}; delayCache.set(doc, c);}
    const w = width > 0 ? width : 0.15, pv = opts?.profile ? profileValues(doc, opts.profile, key, defs) : null, prof = pv && !pv.error ? pv : null;
    const gap = opts?.gap > 0 ? +opts.gap : prof?.gap > 0 ? prof.gap : 0;
    const k = key + "|" + Math.round(w * 1e4) + (gap ? "|s" + Math.round(gap * 1e4) : "") + (prof ? "|p" + opts.profile : "");
    if (!c.values.has(k)) {
      const g = prof ? prof.geom : I.geometry(c.stack.layers, key);
      const r = g && g.structure !== "none" ? I.solve({...g, w, ...(gap ? {s:gap} : null)}) : null;
      // No reference plane (or no solution): AtriumImpedance's one fallback, with the layer's Dk and height when known.
      c.values.set(k, r?.ok ? r.delay : I.delayFallback({outer:key === "Top" || key === "Bottom", w, er:g?.er, h:g?.h}).delay);
    }
    return c.values.get(k);
  }
  // Odd-mode delay (ps/mm) of a differential pair: delay(doc, key, width, defs, {gap}).
  const pairDelay = (doc, key, width, gap, defs, profile) => delay(doc, key, width, defs, {gap, profile});

  // ---- Rigid-flex (rigid-flex.js) ----
  const RF = () => globalThis.AtriumRigidFlex || (() => {throw Error("Rigid-flex support (rigid-flex.js) is not loaded.");})();
  const regions = doc => RF().regions(doc);
  const splitRegion = (doc, line, opts) => RF().splitRegion(doc, line, opts);
  const assignStack = (doc, regionId, stackId, defs) => RF().assignStack(doc, regionId, stackId, defs);
  const regionsResolved = (doc, defs) => RF().regionsResolved(doc, defs);
  const setPlanning = on => globalThis.AtriumRigidFlex ? AtriumRigidFlex.setPlanning(on) : false;
  const planning = () => !!globalThis.AtriumRigidFlex?.planning();

  // ---- KiCad ----
  // Board layer table and (setup (stackup ...)) lines for a KiCad 6 board. KiCad
  // supports even copper counts only; odd stacks return stackup: null.
  function kicad(doc, defs) {
    const stack = get(doc, defs), list = stack.layers, cu = copperOf(stack), n = cu.length;
    const name = l => l.key === "Top" ? "F.Cu" : l.key === "Bottom" ? "B.Cu" : "In" + copperIndex(l.key) + ".Cu";
    const q = s => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    const num = v => String(round(v, 6));
    const copperTable = cu.map(l => [l.key === "Top" ? 0 : l.key === "Bottom" ? 31 : copperIndex(l.key), name(l), l.type === "Plane" ? "power" : "signal", l.name]);
    if (n % 2) return {copper:copperTable, stackup:null, thickness:total(stack)};
    const lines = [], first = list.indexOf(cu[0]), last = list.indexOf(cu.at(-1));
    const outside = (side, layers) => {
      const silk = layers.find(l => l.type === "Overlay"), m = layers.find(l => l.type === "Solder Mask");
      const F = side === "Top" ? "F" : "B", word = side === "Top" ? "Top" : "Bottom";
      return {silk:silk ? "(layer " + q(F + ".SilkS") + " (type " + q(word + " Silk Screen") + "))" : null,
        mask:m ? "(layer " + q(F + ".Mask") + " (type " + q(word + " Solder Mask") + ") (thickness " + num(m.thickness) + ")" + (m.dk ? " (epsilon_r " + num(m.dk) + ")" : "") + ")" : null};
    };
    const top = outside("Top", list.slice(0, first)), bottom = outside("Bottom", list.slice(last + 1));
    if (top.silk) lines.push(top.silk);
    if (top.mask) lines.push(top.mask);
    let d = 0;
    cu.forEach((l, i) => {
      lines.push("(layer " + q(name(l)) + " (type \"copper\") (thickness " + num(l.thickness) + "))");
      if (i === n - 1) return;
      const between = list.slice(list.indexOf(l) + 1, list.indexOf(cu[i + 1])).filter(v => v.type === "Dielectric");
      const h = sum(between.map(v => v.thickness)), main = between[0];
      const dk = sum(between.map(v => v.thickness * (v.dk || CORE.dk))) / h, df = sum(between.map(v => v.thickness * (v.df ?? CORE.df))) / h;
      lines.push("(layer " + q("dielectric " + ++d) + " (type " + q(main.dielectric === "Prepreg" ? "prepreg" : "core") + ") (thickness " + num(h) + ") (material " + q(main.material || "FR4") +
        ") (epsilon_r " + num(dk) + ") (loss_tangent " + num(df) + "))");
    });
    if (bottom.mask) lines.push(bottom.mask);
    if (bottom.silk) lines.push(bottom.silk);
    const surface = list.find(l => l.type === "Surface Finish");
    lines.push("(copper_finish " + q(surface?.material || "None") + ")", "(dielectric_constraints no)");
    return {copper:copperTable, stackup:["(stackup", ...lines.map(s => "  " + s), ")"], thickness:total(stack)};
  }

  // ---- Layer Stack Manager dialog ----
  function el(tag, text, cls, attrs) { return AtriumNavCommon.elWithAttributes(tag, text, cls, attrs); }
  const button = (text, act, cls, title) => globalThis.AtriumUI.nativeButton(text, act, cls, title, title ? {ariaLabel: title} : undefined);
  function option(select, value, label, selected) {
    const o = el("option", label ?? value); o.value = value;
    if (selected) o.selected = true;
    select.append(o);
    return o;
  }
  function open(ctx) {
    const doc = ctx.doc;
    if (doc?.kind !== "pcb") {ctx.info?.("Open a board layout to edit its layer stack."); return;}
    const A = globalThis.Atrium, units = A?.units, project = ctx.project, defs = ctx.defs;
    const unit = units ? units.normal(project?.units) : "mm";
    const show = mm => units ? String(units.value(mm, unit, unit === "mil" ? 3 : 5)) : String(round(mm, 5));
    const parse = text => units ? units.parse(text, unit) : Number(text);
    const both = mm => units ? units.format(mm, "mm", 4) + " (" + units.format(mm, "mil", 2) + ")" : round(mm, 4) + " mm";
    const start = get(doc, defs);
    let uid = 0;
    let rows = start.layers.map(l => ({uid:++uid, layer:{...l}, orig:isCopper(l) ? l.key : null}));
    const byKey = key => rows.find(r => r.orig === key);
    let pairs = (start.drillPairs || []).map(p => ({a:byKey(p.from), b:byKey(p.to)})).filter(p => p.a && p.b);
    let moves = new Map(), selected = rows.find(r => isCopper(r.layer)) || rows[0], dirty = false, tab = "stackup";
    // Substacks: their copper rows point at the main-stack row they share (ref),
    // so they follow it when the main stack is reordered or renumbered.
    const mainInfo = {name:start.main?.name || "", flex:!!start.main?.flex};
    let subs = (start.substacks || []).map(s => ({id:s.id, name:s.name, flex:!!s.flex,
      rows:s.layers.map(l => ({uid:++uid, layer:{...l}, ref:isCopper(l) ? byKey(l.key) : null})).filter(r => !isCopper(r.layer) || r.ref)}));
    let view = null;
    const cur = () => view ? view.rows : rows;
    let regionsState = JSON.parse(JSON.stringify(start.regions || [])), bendsState = JSON.parse(JSON.stringify(start.bends || []));
    const refRow = k => k ? byKey(k) || null : null;
    let profiles = (start.impedanceProfiles || []).map(p => ({...JSON.parse(JSON.stringify(p)),
      layers:new Map(Object.entries(p.layers).map(([k, e]) => [byKey(k), {...e, ...(e.reference ? {reference:e.reference.map(refRow)} : {})}]).filter(([r]) => r))}));
    let profile = profiles[0] || null, profileRow = null;
    const usageCache = new Map();
    const usageOf = key => {if (!usageCache.has(key)) usageCache.set(key, usage(doc, defs, key)); return usageCache.get(key);};
    // Objects that will land on a row: its own plus any moved onto it.
    const objectsOn = row => (row.orig ? usageOf(row.orig).total : 0) + [...moves].filter(([, r]) => r === row).reduce((s, [k]) => s + usageOf(k).total, 0);
    const copperRows = () => rows.filter(r => isCopper(r.layer));
    const keyOfRow = row => {const cu = copperRows(), i = cu.indexOf(row); return i < 0 ? null : keyAt(i, cu.length);};
    const rowLayer = row => row.ref ? {...row.ref.layer, key:keyOfRow(row.ref)} : row.layer;
    const curLayers = () => cur().map(rowLayer);

    // The edited stack-up as a stored record (keys as they will be saved).
    function extras() {
      const out = {}, live = r => r && rows.includes(r) ? keyOfRow(r) : null;
      if (mainInfo.name || mainInfo.flex) out.main = {name:mainInfo.name || "Main", flex:mainInfo.flex};
      if (subs.length) out.substacks = subs.map(s => ({id:s.id, name:s.name, flex:s.flex,
        layers:s.rows.filter(r => !r.ref || rows.includes(r.ref)).map(r => r.ref ? {type:r.ref.layer.type, name:r.ref.layer.name, material:"Copper", thickness:r.ref.layer.thickness, key:live(r.ref)} : {...r.layer})}));
      if (regionsState.length) out.regions = regionsState;
      if (bendsState.length) out.bends = bendsState;
      if (profiles.length) out.impedanceProfiles = profiles.map(p => {
        const layers = {};
        for (const [r, e] of p.layers) if (live(r)) layers[live(r)] = {...e, ...(e.reference ? {reference:e.reference.map(live)} : {})};
        return {...p, layers};
      });
      return JSON.parse(JSON.stringify(out));
    }
    const draft = () => normalize({version:VERSION, layers:rows.map(r => ({...r.layer})), drillPairs:[], ...extras()});
    const draftDoc = () => ({kind:"pcb", name:doc.name, outline:doc.outline, boardShape:doc.boardShape, items:[], notes:[], stackup:draft()});

    const d = el("dialog", null, "ui-dialog work-dialog stk-dialog", {"aria-label":"Layer Stack Manager"});
    const head = el("div", null, "stk-head");
    head.append(el("h2", "Layer Stack Manager", "ui-dialog-title"), el("span", doc.name || "Board", "stk-doc"));
    if (start.derived) head.append(el("span", "Default stack · not yet saved with this board", "ui-badge", {"data-tone": "accent"}));
    const tabs = el("div", null, "stk-tabs ui-tabs", {"data-strip":"", role:"tablist", "aria-label":"Layer stack views"});
    const panels = {}, tabButtons = {};
    for (const [id, label] of [["stackup", "Stackup"], ["vias", "Via Types"], ["impedance", "Impedance"], ["regions", "Board Regions"]]) {
      const b = button(label, () => select(id), "stk-tab ui-tab");
      b.setAttribute("role", "tab"); b.id = "stk-tab-" + id; b.setAttribute("aria-controls", "stk-panel-" + id);
      tabButtons[id] = b; tabs.append(b);
      panels[id] = el("section", null, "stk-panel ui-dialog-body", {role:"tabpanel", id:"stk-panel-" + id, "aria-labelledby":"stk-tab-" + id});
    }
    tabs.addEventListener("keydown", e => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const ids = Object.keys(tabButtons), next = ids[(ids.indexOf(tab) + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length];
      select(next); tabButtons[next].focus(); e.preventDefault();
    });
    const message = el("div", null, "stk-message", {role:"status", "aria-live":"polite"});
    const summary = el("div", null, "stk-summary");
    function say(text, kind) {message.replaceChildren(); message.dataset.kind = kind || ""; if (text) message.append(el("span", text));}
    function changed() {dirty = true; paintSummary();}

    // Stackup tab: substack bar, layer commands and the layer table.
    const subBar = el("div", null, "stk-toolbar stk-subbar", {role:"toolbar", "aria-label":"Substacks"});
    const subSelect = el("select", null, "stk-select", {"aria-label":"Substack"});
    const subName = el("input", null, "stk-text stk-subname", {type:"text", "aria-label":"Substack name", spellcheck:"false"});
    const subFlex = el("input", null, "ui-checkbox", {type:"checkbox", "aria-label":"Flex substack"});
    const flexLabel = el("label", null, "stk-check"); flexLabel.append(subFlex, el("span", "Flex"));
    const delSub = button("Delete substack", () => deleteSub(), "stk-danger", "Delete this substack; its regions return to the main stack");
    subBar.append(el("span", "Substack", "stk-label"), subSelect, subName, flexLabel, el("span", null, "stk-sep"),
      button("New flex substack", () => newSub(), "", "Add a two-layer flex substack sharing the outer copper layers"), delSub);
    subSelect.onchange = () => {view = subs.find(s => s.id === subSelect.value) || null; selected = cur().find(r => isCopper(rowLayer(r))) || cur()[0]; paintSubBar(); paintRows();};
    subName.onchange = () => {const v = subName.value.trim().slice(0, 80); if (view) view.name = v || view.name; else mainInfo.name = v; changed(); paintSubBar();};
    subFlex.onchange = () => {if (view) view.flex = subFlex.checked; else mainInfo.flex = subFlex.checked; changed();};
    function paintSubBar() {
      subSelect.replaceChildren();
      option(subSelect, "main", (mainInfo.name || (subs.length ? "Rigid" : "Main")) + " (main)", !view);
      for (const s of subs) option(subSelect, s.id, s.name + (s.flex ? " · flex" : ""), view === s);
      subName.value = view ? view.name : mainInfo.name || (subs.length ? "Rigid" : "Main");
      subFlex.checked = view ? view.flex : mainInfo.flex; delSub.disabled = !view;
    }
    function newSub() {
      const cu = copperRows(), refs = [cu[0], cu.at(-1)], ids = new Set(["main", ...subs.map(s => s.id)]);
      let n = subs.length + 1; while (ids.has("flex-" + n)) n++;
      const layers = flexLayers(refs.map(keyOfRow), refs.map(r => ({...r.layer, key:keyOfRow(r)})));
      const s = {id:"flex-" + n, name:"Flex " + n, flex:true, rows:layers.map(l => ({uid:++uid, layer:{...l}, ref:isCopper(l) ? refs.find(r => keyOfRow(r) === l.key) : null}))};
      subs.push(s); view = s; selected = s.rows.find(r => r.ref); changed(); paintSubBar(); paintRows();
      say(s.name + " added. Assign it to board regions on the Board Regions tab.", "");
    }
    function deleteSub() {
      if (!view) return;
      const gone = view;
      subs = subs.filter(s => s !== gone);
      for (const r of regionsState) if (r.stack === gone.id) r.stack = "main";
      for (const p of profiles) if (p.stack === gone.id) delete p.stack;
      view = null; selected = rows[0]; changed(); paintSubBar(); paintRows();
      say(gone.name + " deleted. Its regions use the main stack.", "");
    }

    const toolbar = el("div", null, "stk-toolbar", {role:"toolbar", "aria-label":"Layer commands"});
    const addType = el("select", null, "stk-add-type", {"aria-label":"Layer type to add"});
    for (const [v, label] of [["Signal", "Signal"], ["Plane", "Plane"], ["Core", "Dielectric · Core"], ["Prepreg", "Dielectric · Prepreg"], ["Polyimide", "Dielectric · Polyimide"],
      ["Solder Mask", "Solder Mask"], ["Coverlay", "Coverlay"], ["Adhesive", "Adhesive"], ["Stiffener", "Stiffener"], ["Overlay", "Overlay"], ["Surface Finish", "Surface Finish"]]) option(addType, v, label);
    const presetSelect = el("select", null, "stk-preset", {"aria-label":"Apply a preset stack"});
    presetSelect.onchange = () => {const v = presetSelect.value; presetSelect.value = ""; if (v) usePreset(v);};
    function paintPresets() {
      presetSelect.replaceChildren(); option(presetSelect, "", "Presets…");
      if (view) {option(presetSelect, "flex1", "Flex · 1 layer (Top)"); option(presetSelect, "flex2", "Flex · 2 layers (Top, Bottom)");}
      else for (const p of PRESETS) option(presetSelect, p.id, p.label);
    }
    const upBtn = button("Move up", () => shift(-1), "", "Move the selected layer up");
    const downBtn = button("Move down", () => shift(1), "", "Move the selected layer down");
    const delBtn = button("Delete", () => remove(selected), "stk-danger", "Delete the selected layer");
    toolbar.append(el("span", "Add", "stk-label"), addType, button("Above", () => insert(0), "", "Add the layer above the selected layer"),
      button("Below", () => insert(1), "", "Add the layer below the selected layer"), el("span", null, "stk-sep"), upBtn, downBtn, delBtn,
      el("span", null, "stk-sep"), presetSelect);
    const wrap = el("div", null, "stk-table-wrap");
    const table = el("table", null, "stk-table", {"aria-label":"Layer stack, top to bottom"});
    const thickHead = "Thickness (" + unit + ")";
    const thead = el("thead"), hr = el("tr");
    for (const h of ["#", "Name", "Material", "Type", "Weight", thickHead, "Dk", "Df"]) hr.append(el("th", h, null, {scope:"col"}));
    thead.append(hr); const tbody = el("tbody"); table.append(thead, tbody); wrap.append(table);
    const note = el("p", null, "stk-note");
    panels.stackup.append(subBar, toolbar, wrap, note);

    function cell(row, field, input) {input.dataset.uid = row.uid; input.dataset.field = field; return input;}
    function numberInput(row, field, value, label, onValue, opts = {}) {
      const input = cell(row, field, el("input", null, "stk-num", {type:"text", inputmode:"decimal", "aria-label":label, spellcheck:"false"}));
      input.value=value;
      if(field==="thickness")input.dataset.unit=unit;else input.dataset.numericUnit=field==="weight"?"oz/ft²":"";
      input.onchange = () => {
        const v = opts.parse ? opts.parse(input.value) : Number(input.value);
        if (!Number.isFinite(v) || v < (opts.min ?? 0) || v > (opts.max ?? 1e6) || (opts.positive && !(v > 0))) {
          say(label + ": enter " + (opts.hint || "a valid number") + ".", "error"); input.value = opts.text ? opts.text() : value; input.select(); return;
        }
        onValue(v); say(""); changed();
      };
      return input;
    }
    function paintRows() {
      tbody.replaceChildren();
      paintPresets();
      note.textContent = view ? "Substack " + view.name + ": copper layers are shared with the main stack (choose which under Type). Add coverlay, adhesive, polyimide and stiffener layers around them."
        : "Copper layers map to Top, Inner 1… and Bottom in stack order. Objects follow their layer when it moves.";
      const cu = copperRows(), list = cur(), used = view ? new Set(view.rows.map(r => r.ref).filter(Boolean)) : null;
      for (const row of list) {
        const l = rowLayer(row), shared = !!row.ref, tr = el("tr", null, "stk-row stk-" + l.type.toLowerCase().replace(/\s+/g, "-"));
        tr.dataset.uid = row.uid; tr.setAttribute("aria-selected", String(row === selected));
        tr.onclick = e => {
          if (selected !== row) {
            selected = row;
            for (const r of tbody.children) {r.setAttribute("aria-selected", String(r === tr)); r.tabIndex = r === tr ? 0 : -1;}
            syncButtons();
          }
          if (e.target === tr || e.target.tagName === "TD") tr.focus();
        };
        tr.tabIndex = row === selected ? 0 : -1;
        tr.onkeydown = e => {
          if (e.target !== tr) return;
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            const i = list.indexOf(row) + (e.key === "ArrowUp" ? -1 : 1);
            if (list[i]) {selected = list[i]; paintRows(); tbody.querySelector('[data-uid="' + list[i].uid + '"]')?.focus();}
            e.preventDefault();
          } else if (e.key === "Delete" || e.key === "Backspace") {remove(row); e.preventDefault();}
        };
        const copperN = cu.indexOf(shared ? row.ref : row);
        tr.append(el("td", copperN >= 0 ? String(copperN + 1) : "", "stk-num-cell", copperN >= 0 ? {title:keyAt(copperN, cu.length)} : {}));
        const nameCell = el("td", null, "stk-name-cell"), nameLine = el("span", null, "stk-name-line");
        nameCell.append(nameLine);
        if (shared) nameLine.append(el("span", l.name, "stk-shared-name"));
        else {
          const name = cell(row, "name", el("input", null, "stk-text", {type:"text", "aria-label":"Layer name", spellcheck:"false"}));
          name.value = l.name; name.onchange = () => {row.layer.name = name.value.trim() || row.layer.type; name.value = row.layer.name; changed();};
          nameLine.append(name);
        }
        if (copperN >= 0) nameLine.append(el("small", keyAt(copperN, cu.length) + (shared ? " · shared" : row.orig && row.orig !== keyAt(copperN, cu.length) ? " · was " + row.orig : row.orig ? "" : " · new"), "stk-key"));
        tr.append(nameCell);
        const mCell = el("td");
        if (shared) mCell.append(el("span", "Copper", "stk-type"));
        else if (l.type !== "Overlay") {
          const material = cell(row, "material", el("input", null, "stk-text", {type:"text", "aria-label":"Material", spellcheck:"false"}));
          material.value = l.material || ""; material.onchange = () => {row.layer.material = material.value.trim(); changed();};
          mCell.append(material);
        }
        tr.append(mCell);
        const typeCell = el("td");
        if (shared) {
          const s = cell(row, "shares", el("select", null, "stk-select", {"aria-label":"Shared main-stack copper layer"}));
          for (const r of cu) if (r === row.ref || !used.has(r)) option(s, String(r.uid), r.layer.name + " (" + keyOfRow(r) + ")", r === row.ref);
          s.onchange = () => {row.ref = cu.find(r => String(r.uid) === s.value) || row.ref; changed(); paintRows();};
          typeCell.append(s);
        } else if (isCopper(l) || l.type === "Dielectric") {
          const s = cell(row, "type", el("select", null, "stk-select", {"aria-label":"Layer type"}));
          for (const v of isCopper(l) ? ["Signal", "Plane"] : DIELECTRICS) option(s, v, v, (isCopper(l) ? l.type : l.dielectric) === v);
          s.onchange = () => {if (isCopper(l)) row.layer.type = s.value; else row.layer.dielectric = s.value; changed(); paintRows();};
          typeCell.append(s);
        } else typeCell.append(el("span", l.type, "stk-type"));
        tr.append(typeCell);
        const wCell = el("td"), tCell = el("td");
        if (shared) {wCell.append(el("span", String(weight(l.thickness)), "stk-ro"), el("span", "oz", "stk-unit")); tCell.append(el("span", show(l.thickness), "stk-ro"));}
        else {
          let wInput = null;
          const tInput = numberInput(row, "thickness", show(l.thickness), "Thickness in " + unit, v => {row.layer.thickness = round(v); if (wInput) wInput.value = String(weight(row.layer.thickness));},
            {parse, positive:isCopper(l) || l.type !== "Solder Mask" && l.type !== "Overlay" && l.type !== "Surface Finish", max:10, hint:"a thickness in " + unit, text:() => show(row.layer.thickness)});
          if (isCopper(l)) {
            wInput = numberInput(row, "weight", String(weight(l.thickness)), "Copper weight in ounces", v => {row.layer.thickness = round(v * OZ); tInput.value = show(row.layer.thickness);},
              {positive:true, max:20, hint:"a weight in oz, such as 0.5, 1 or 2", text:() => String(weight(row.layer.thickness))});
            wCell.append(wInput, el("span", "oz", "stk-unit"));
          }
          if (l.type !== "Overlay") tCell.append(tInput);
        }
        tr.append(wCell, tCell);
        const dkCell = el("td"), dfCell = el("td"), dkTypes = ["Dielectric", "Solder Mask", "Coverlay", "Adhesive", "Stiffener"];
        if (!shared && dkTypes.includes(l.type)) dkCell.append(numberInput(row, "dk", l.dk ?? "", "Dielectric constant", v => {row.layer.dk = v;}, {min:1, max:20, hint:"a Dk between 1 and 20"}));
        if (!shared && ["Dielectric", "Coverlay", "Adhesive"].includes(l.type)) dfCell.append(numberInput(row, "df", l.df ?? "", "Loss tangent", v => {row.layer.df = v;}, {min:0, max:1, hint:"a Df between 0 and 1"}));
        tr.append(dkCell, dfCell);
        tbody.append(tr);
      }
      syncButtons(); paintSummary();
    }
    function syncButtons() {
      const list = cur(), i = list.indexOf(selected);
      upBtn.disabled = i <= 0; downBtn.disabled = i < 0 || i >= list.length - 1; delBtn.disabled = i < 0;
    }
    function viewProblems() {
      const layers = curLayers(), out = problems(layers, view ? 1 : 2);
      if (view) {const k = layers.filter(isCopper).map(l => copperIndex(l.key)); if (k.some((v, i) => i && v <= k[i - 1])) out.push("Shared copper layers must keep the main stack order.");}
      return out;
    }
    function paintSummary() {
      const layers = curLayers(), cu = layers.filter(isCopper).length, issues = viewProblems();
      summary.replaceChildren(el("strong", (view ? view.name + " thickness " : "Total thickness ") + both(sum(layers.filter(l => l.type !== "Stiffener").map(l => Number(l.thickness) || 0)))),
        el("span", cu + " copper layer" + (cu === 1 ? "" : "s") + " · " + layers.filter(l => INSULATING.has(l.type)).length + " dielectric" + (subs.length ? " · " + (subs.length + 1) + " substacks" : "")));
      if (issues.length) summary.append(el("span", issues[0], "stk-warn"));
    }
    function insert(after) {
      const list = cur(), type = addType.value;
      let layer = blank(type), row;
      if (isCopper(layer) && view) {
        const used = new Set(view.rows.map(r => r.ref).filter(Boolean)), ref = copperRows().find(r => !used.has(r));
        if (!ref) {say("Every main-stack copper layer is already in " + view.name + ".", "error"); return;}
        row = {uid:++uid, layer:{...ref.layer}, ref};
      } else {
        if (isCopper(layer) && copperRows().length >= MAX_COPPER) {say("Waffle supports at most " + MAX_COPPER + " copper layers.", "error"); return;}
        if (isCopper(layer)) layer.name = type === "Plane" ? "Plane " + (copperRows().length) : "Signal " + (copperRows().length);
        if (layer.type === "Dielectric") layer.name = (type === "Polyimide" ? "Polyimide " : "Dielectric ") + (list.filter(r => r.layer.type === "Dielectric").length + 1);
        row = {uid:++uid, layer, orig:null};
      }
      const i = selected ? list.indexOf(selected) + after : list.length;
      list.splice(i, 0, row);
      // New copper comes with a dielectric on whichever side keeps the stack valid.
      if (isCopper(layer)) {
        const gap = {uid:++uid, layer:{...blank(view?.flex ? "Polyimide" : "Prepreg"), name:"Dielectric " + (list.filter(r => r.layer.type === "Dielectric").length + 1)}, orig:null};
        const tries = after ? [i, i + 1] : [i + 1, i];
        for (const at of tries) {
          list.splice(at, 0, gap);
          if (!problems(list.map(rowLayer), view ? 1 : 2).length) break;
          list.splice(at, 1);
        }
        if (!list.includes(gap)) list.splice(tries[0], 0, gap);
      }
      selected = row; changed(); paintRows();
      const issue = viewProblems()[0];
      say(rowLayer(row).name + " added." + (issue ? " " + issue : ""), issue ? "error" : "");
      tbody.querySelector('[data-uid="' + row.uid + '"] input, [data-uid="' + row.uid + '"] select')?.focus();
    }
    function shift(step) {
      const list = cur(), i = list.indexOf(selected), j = i + step;
      if (i < 0 || !list[j]) return;
      [list[i], list[j]] = [list[j], list[i]]; changed(); paintRows();
      tbody.querySelector('[data-uid="' + selected.uid + '"]')?.focus();
    }
    function drop(row) {
      const list = cur(), i = list.indexOf(row);
      list.splice(i, 1);
      if (!view) {
        pairs = pairs.filter(p => p.a !== row && p.b !== row);
        for (const s of subs) s.rows = s.rows.filter(r => r.ref !== row);
        for (const p of profiles) {p.layers.delete(row); for (const e of p.layers.values()) if (e.reference) e.reference = e.reference.map(r => r === row ? null : r);}
      }
      selected = list[Math.min(i, list.length - 1)] || null;
      changed(); paintRows(); paintVias();
    }
    function remove(row) {
      if (!row) return;
      const l = rowLayer(row);
      if (view) {
        if (row.ref && view.rows.filter(r => r.ref).length <= 1) {say("A substack needs at least one copper layer.", "error"); return;}
        drop(row); say(l.name + " removed from " + view.name + ".", ""); return;
      }
      if (isCopper(l) && copperRows().length <= 2) {say("A board needs at least two copper layers.", "error"); return;}
      const count = isCopper(l) ? objectsOn(row) : 0;
      if (!count) {
        if (row.orig) moves.delete(row.orig);
        drop(row); say(l.name + " removed." + (subs.some(s => s.rows.some(r => r.ref === row)) ? " Substacks sharing it lose it too." : ""), ""); return;
      }
      // The layer still has objects: removing it is blocked unless they move.
      const u = row.orig ? usageOf(row.orig) : {total:0};
      const others = copperRows().filter(r => r !== row && r.orig);
      say("", "error");
      message.append(el("span", l.name + " holds " + count + " object" + (count === 1 ? "" : "s") + (u.total ? " (" + describe(u) + ")" : "") + ". Removing it would orphan them."));
      if (!others.length) {message.append(el("span", " No other existing copper layer can receive them.")); return;}
      const target = el("select", null, "stk-select", {"aria-label":"Move objects to"});
      for (const r of others) option(target, String(r.uid), r.layer.name + " (" + keyOfRow(r) + ")");
      const go = button("Move objects and delete", () => {
        const dest = others.find(r => String(r.uid) === target.value);
        if (!dest) return;
        for (const [k, r] of moves) if (r === row) moves.set(k, dest);
        if (row.orig) moves.set(row.orig, dest);
        drop(row); say("Objects from " + l.name + " will move to " + dest.layer.name + " when you click OK.", "");
      }, "stk-danger");
      const keep = button("Keep layer", () => say(""), "");
      const line = el("span", null, "stk-move"); line.append(el("label", "Move them to "), target, go, keep);
      message.append(line); target.focus();
    }
    function usePreset(id) {
      if (view) {
        const cu = copperRows(), refs = id === "flex1" ? [cu[0]] : [cu[0], cu.at(-1)];
        view.rows = flexLayers(refs.map(keyOfRow), refs.map(r => ({...r.layer, key:keyOfRow(r)}))).map(l => ({uid:++uid, layer:{...l}, ref:isCopper(l) ? refs.find(r => keyOfRow(r) === l.key) : null}));
        selected = view.rows[0]; changed(); paintRows(); say("Applied the " + (id === "flex1" ? "one" : "two") + "-layer flex preset to " + view.name + ".", ""); return;
      }
      const p = preset(id), cu = p.layers.filter(isCopper), n = cu.length, old = copperRows();
      const next = p.layers.map(l => ({uid:++uid, layer:{...l}, orig:null}));
      const nextCu = next.filter(r => isCopper(r.layer));
      // Outer layers keep their identity; inner layers by position.
      const keep = new Map();
      if (old.length) {keep.set(nextCu[0], old[0]); keep.set(nextCu[n - 1], old.at(-1));}
      for (let i = 1; i < n - 1 && i < old.length - 1; i++) keep.set(nextCu[i], old[i]);
      const dropped = old.filter(r => ![...keep.values()].includes(r));
      const busy = dropped.filter(r => objectsOn(r) > 0);
      if (busy.length) {say("The " + PRESETS.find(v => v.id === id).label.split(" · ")[0] + " preset would remove " + busy.map(r => r.layer.name + " (" + objectsOn(r) + " objects)").join(", ") + ". Move those objects first or choose a larger preset.", "error"); return;}
      for (const [r, was] of keep) {r.orig = was.orig; for (const [k, t] of moves) if (t === was) moves.set(k, r);}
      for (const [k, t] of moves) if (!next.includes(t)) moves.delete(k);
      const into = new Map([...keep].map(([a, b]) => [b, a]));
      pairs = pairs.map(pr => ({a:into.get(pr.a), b:into.get(pr.b)})).filter(pr => pr.a && pr.b);
      for (const s of subs) s.rows = s.rows.filter(r => !r.ref || into.has(r.ref)).map(r => r.ref ? {...r, ref:into.get(r.ref)} : r);
      for (const pf of profiles) pf.layers = new Map([...pf.layers].filter(([r]) => into.has(r)).map(([r, e]) => [into.get(r), {...e, ...(e.reference ? {reference:e.reference.map(x => x ? into.get(x) || null : null)} : {})}]));
      rows = next; selected = nextCu[0]; changed(); paintRows(); paintVias();
      say("Applied the " + PRESETS.find(v => v.id === id).label + " preset. Click OK to keep it.", "");
    }
    // Via Types tab
    const viaTable = el("table", null, "stk-table stk-vias", {"aria-label":"Drill pairs"});
    const viaBody = el("tbody"), vh = el("tr");
    for (const h of ["Drill pair", "First layer", "Last layer", "Type", "Vias", "Pads", "Status", ""]) vh.append(el("th", h, null, {scope:"col"}));
    const vhead = el("thead"); vhead.append(vh); viaTable.append(vhead, viaBody);
    const addRow = el("div", null, "stk-toolbar");
    const fromSel = el("select", null, "stk-select", {"aria-label":"First layer"}), toSel = el("select", null, "stk-select", {"aria-label":"Last layer"});
    addRow.append(el("span", "Allow span", "stk-label"), fromSel, el("span", "to", "stk-label"), toSel, button("Add drill pair", () => {
      const a = rows.find(r => String(r.uid) === fromSel.value), b = rows.find(r => String(r.uid) === toSel.value);
      if (!a || !b || a === b) {say("Choose two different copper layers for the drill pair.", "error"); return;}
      const [x, y] = rows.indexOf(a) < rows.indexOf(b) ? [a, b] : [b, a], cu = copperRows();
      if (x === cu[0] && y === cu.at(-1)) {say("The through-hole pair is always available.", ""); return;}
      if (pairs.some(p => p.a === x && p.b === y)) {say("That drill pair is already defined.", ""); return;}
      pairs.push({a:x, b:y}); changed(); paintVias(); say("Drill pair " + x.layer.name + " – " + y.layer.name + " added.", "");
    }));
    panels.vias.append(el("p", "Hole spans used by vias and pads on this board, and the spans you allow for new blind and buried vias. Through holes run from the first to the last copper layer.", "stk-note"), viaTable, addRow);
    function paintVias() {
      const cu = copperRows(), top = cu[0], bottom = cu.at(-1), fromRow = new Map(cu.filter(r => r.orig).map(r => [r.orig, r]));
      const used = drillPairs(doc, defs), list = [];
      const find = (a, b) => list.find(p => p.a === a && p.b === b);
      const add = (a, b) => {
        const [x, y] = rows.indexOf(a) <= rows.indexOf(b) ? [a, b] : [b, a];
        return find(x, y) || (list.push({a:x, b:y, vias:0, pads:0, defined:false}), list.at(-1));
      };
      if (top && bottom) add(top, bottom).defined = true;
      for (const p of pairs) add(p.a, p.b).defined = true;
      const orphan = [];
      for (const u of used) {
        if (!u.used) continue;
        const target = k => fromRow.get(k) || moves.get(k);
        const a = target(u.from), b = target(u.to);
        if (!a || !b) {orphan.push(u); continue;}
        const e = add(a, b); e.vias += u.vias; e.pads += u.pads + u.npth;
      }
      viaBody.replaceChildren();
      for (const p of list) {
        const kind = p.a === top && p.b === bottom ? "Through" : p.a === top || p.b === bottom ? "Blind" : "Buried";
        const tr = el("tr");
        tr.append(el("td", p.a.layer.name + " – " + p.b.layer.name), el("td", keyOfRow(p.a)), el("td", keyOfRow(p.b)), el("td", kind),
          el("td", String(p.vias)), el("td", String(p.pads)), el("td", p.defined ? "Allowed" : "In use, not defined", p.defined ? "" : "stk-warn"));
        const act = el("td");
        if (kind !== "Through" && p.defined && pairs.some(v => v.a === p.a && v.b === p.b))
          act.append(button("Remove", () => {pairs = pairs.filter(v => !(v.a === p.a && v.b === p.b)); changed(); paintVias();}, "", "Remove drill pair " + p.a.layer.name + " – " + p.b.layer.name));
        else if (!p.defined) act.append(button("Allow", () => {pairs.push({a:p.a, b:p.b}); changed(); paintVias();}, "", "Allow drill pair " + p.a.layer.name + " – " + p.b.layer.name));
        tr.append(act); viaBody.append(tr);
      }
      for (const u of orphan) {
        const tr = el("tr");
        tr.append(el("td", u.from + " – " + u.to), el("td", u.from), el("td", u.to), el("td", u.kind), el("td", String(u.vias)), el("td", String(u.pads + u.npth)), el("td", "Layer missing from the stack", "stk-warn"), el("td"));
        viaBody.append(tr);
      }
      for (const s of [fromSel, toSel]) {
        const keep = s.value; s.replaceChildren();
        for (const r of cu) option(s, String(r.uid), r.layer.name + " (" + keyOfRow(r) + ")", String(r.uid) === keep);
      }
      if (!fromSel.value || fromSel.value === toSel.value) {fromSel.value = String(cu[0]?.uid); toSel.value = String(cu[1]?.uid);}
    }

    // Impedance tab: profiles (Altium's Impedance tab), solved live from the edited stack.
    const TYPE_LABEL = {single:"Single-ended", diff:"Differential", cpw:"Coplanar (CPWG)", "cpw-diff":"Coplanar differential"};
    const impList = el("div", null, "ui-list stk-imp-list", {role:"listbox", "aria-label":"Impedance profiles"});
    const impMain = el("div", null, "stk-imp-main");
    const newType = el("select", null, "stk-select", {"aria-label":"New profile type"});
    for (const [k, v] of Object.entries(TYPE_LABEL)) option(newType, k, v);
    const impTools = el("div", null, "stk-toolbar");
    const addBtn = button("Add profile · Single-ended", () => addProfile(newType.value), "", "Add an impedance profile of the type chosen on the left");
    newType.onchange = () => {addBtn.textContent = "Add profile · " + TYPE_LABEL[newType.value];};
    impTools.append(newType, addBtn,
      button("Delete profile", () => {if (!profile) return; profiles = profiles.filter(p => p !== profile); profile = profiles[0] || null; changed(); paintImpedance();}, "stk-danger", "Delete the selected profile"),
      button("Field solver", () => verifyField(), "", "Check each layer of this profile with the 2D field solver (field-solver.js)")/* hs-field */);
    const impBody = el("div", null, "stk-imp");
    const impSide = el("div", null, "stk-imp-side"); impSide.append(impTools, impList);
    impBody.append(impSide, impMain);
    panels.impedance.append(impBody, el("p", "Quasi-static models: Hammerstad-Jensen microstrip with a filling-factor solder mask / coverlay model (±3 %), Cohn and Wheeler stripline (0.5 %), Kirschning-Jansen coupled microstrip (about 1 %), Cohn coupled stripline with a field-solver thickness correction (0.6 %), Ghione CPWG (3–5 %). Offset stripline beyond h2/h1 = 3 and coplanar pairs are rougher (5–10 %); confirm controlled-impedance widths with your fabricator. In rigid-flex boards each region is checked against the profile solved on its own substack. Width left blank is solved from the target. Width and Differential Pairs Routing rules can use a profile.", "stk-note stk-approx"));
    // hs-field: the selected profile's layers solved by the 2D field solver, against the closed-form models.
    async function verifyField() {
      if (!profile) return;
      let st; try {st = draft();} catch (error) {say(error.message, "error"); return;}
      const cleaned = (st.impedanceProfiles || []).find(x => x.id === profile.id); if (!cleaned) return;
      let FS = globalThis.AtriumFieldSolver;
      try {FS ||= await globalThis.AtriumLazy?.need("AtriumFieldSolver");} catch (error) {say(error.message, "error"); return;}
      if (!FS) {say("The field solver (field-solver.js) is not available.", "error"); return;}
      say("Solving the cross-sections…");
      const sub = substacks(st).find(s => s.id === (profile.stack || "main")) || substacks(st)[0], parts = [];
      for (const key of sub.layers.filter(isCopper).map(l => l.key)) {
        let v = null; try {v = resolveProfileLayer(st, cleaned, key);} catch {v = null;}
        if (!v || v.error || !v.geom) continue;
        let r = null; try {r = await FS.async(v.geom, {quality:"normal"});} catch {r = null;}
        if (r?.ok) {const d = (r.z - v.z) / v.z * 100; parts.push(key + " " + r.z.toFixed(1) + " Ω (closed form " + v.z.toFixed(1) + ", " + (d >= 0 ? "+" : "") + d.toFixed(1) + " %)");}
      }
      say(parts.length ? "Field solver: " + parts.join("; ") : "No enabled layers to solve.");
    }
    function addProfile(type) {
      const ids = new Set(profiles.map(p => p.id));
      let n = profiles.length + 1; while (ids.has("profile-" + n)) n++;
      const target = type === "diff" || type === "cpw-diff" ? 90 : 50, layers = new Map();
      for (const r of copperRows().filter(r => r.layer.type === "Signal")) layers.set(r, {enabled:true, etch:0});
      profile = {id:"profile-" + n, name:TYPE_LABEL[type] + " " + target + " Ω", type, target, tolerance:10, policy:"fab", layers};
      profiles.push(profile); profileRow = null; changed(); paintImpedance();
    }
    const svgNS = "http://www.w3.org/2000/svg";
    function svg(tag, attrs, text) {const n = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v); if (text != null) n.textContent = text; return n;}
    // Cross-section of the line on its layer: references, dielectrics, cover, traces.
    function crossSection(sub, p, v) {
      const g = v.geometry, layers = sub.layers, at = layers.findIndex(l => l.key === g.key);
      const iTop = g.refTop ? layers.findIndex(l => l.key === g.refTop) : 0, iBot = g.refBottom ? layers.findIndex(l => l.key === g.refBottom) : layers.length - 1;
      const band = layers.slice(iTop, iBot + 1).filter(l => l.thickness > 0 && l.type !== "Stiffener"), W = 480, X0 = 64;
      const real = band.reduce((s, l) => s + l.thickness, 0), px = Math.min(130 / real, 1e4), hOf = l => Math.max(isCopper(l) ? 14 : 10, l.thickness * px);
      const H = band.reduce((s, l) => s + hOf(l), 0) + 34, out = svg("svg", {viewBox:"0 0 " + W + " " + H, class:"stk-xsec", role:"img", "aria-label":"Cross-section of " + p.name + " on " + g.key});
      const diff = p.type.includes("diff"), cop = p.type.startsWith("cpw"), w = v.width, s = v.gap || 0, gg = v.ground || 0;
      const span = (diff ? 2 * w + s : w) + (cop ? 2 * (gg + w * 1.2) : 3 * w), sx = (W - X0 - 20) / span, cx = X0 + (W - X0 - 20) / 2;
      let y = 14;
      for (const l of band) {
        const h = hOf(l), signal = layers.indexOf(l) === at, ref = l.key && (l.key === g.refTop || l.key === g.refBottom);
        const cls = isCopper(l) ? (ref ? "stk-x-plane" : "stk-x-air") : l.type === "Solder Mask" || l.type === "Coverlay" ? "stk-x-mask" : "stk-x-diel";
        out.append(svg("rect", {x:X0, y, width:W - X0 - 20, height:h, class:signal ? "stk-x-air" : cls}));
        out.append(svg("text", {x:X0 - 6, y:y + h / 2 + 3, class:"stk-x-label", "text-anchor":"end"}, isCopper(l) ? (l.key || "") : (l.dk ? "Dk " + round(l.dk, 2) : l.type)));
        if (signal) {
          const t = h, top = e => e > 0 ? Math.min(w * sx / 2 - 1, (l.thickness / e) * sx) : 0, etch = top(v.geom?.etch || 0);
          const trace = (x0, ww) => out.append(svg("path", {d:"M" + x0 + " " + (y + t) + "h" + ww + "l" + (-etch) + " " + (-t) + "h" + (-(ww - 2 * etch)) + "z", class:"stk-x-trace"}));
          const left = diff ? cx - (s / 2 + w) * sx : cx - w / 2 * sx;
          trace(left, w * sx); if (diff) trace(cx + s / 2 * sx, w * sx);
          if (cop) {const gx = (diff ? (s / 2 + w + gg) : (w / 2 + gg)) * sx; out.append(svg("rect", {x:X0, y, width:cx - gx - X0, height:t, class:"stk-x-plane"}), svg("rect", {x:cx + gx, y, width:W - 20 - cx - gx, height:t, class:"stk-x-plane"}));}
          out.append(svg("text", {x:left + w * sx / 2, y:y - 3, class:"stk-x-dim", "text-anchor":"middle"}, "W " + show(w)));
          if (diff) out.append(svg("text", {x:cx, y:y + t + 11, class:"stk-x-dim", "text-anchor":"middle"}, "S " + show(s)));
          if (cop) out.append(svg("text", {x:cx + (diff ? (s / 2 + w + gg / 2) : (w / 2 + gg / 2)) * sx, y:y + t + 11, class:"stk-x-dim", "text-anchor":"middle"}, "G " + show(gg)));
        }
        y += h;
      }
      out.append(svg("text", {x:W - 20, y:H - 6, class:"stk-x-dim", "text-anchor":"end"}, g.structure === "stripline" ? "H1 " + show(g.h1) + " · H2 " + show(g.h2) + " · T " + show(g.t) : "H " + show(g.h) + " · T " + show(g.t) + (g.cover ? " · cover " + show(g.cover.t) : "")));
      return out;
    }
    function paintImpedance() {
      impList.replaceChildren();
      for (const p of profiles) {
        // A library list row: the profile, then its type and target as the detail.
        const b = el("button", null, "ui-row stk-imp-item"), text = el("span", null, "ui-row-text"); b.type = "button"; b.onclick = () => {profile = p; profileRow = null; paintImpedance();};
        b.setAttribute("role", "option"); b.setAttribute("aria-selected", String(p === profile));
        text.append(el("span", p.name, "ui-row-title"), el("span", TYPE_LABEL[p.type] + " · " + p.target + " Ω ±" + p.tolerance + " %", "ui-row-detail")); b.append(text);
        impList.append(b);
      }
      impMain.replaceChildren();
      if (!profile) {impMain.append(el("p", "No impedance profiles yet. Add one, then point Width or Differential Pairs Routing rules at it.", "stk-note")); return;}
      let st = null;
      try {st = draft();} catch (error) {impMain.append(el("p", "Fix the layer stack to calculate impedance: " + error.message, "stk-warn")); return;}
      const p = profile, form = el("div", null, "stk-imp-form");
      const field = (label, input, suffix) => {const f = el("label", null, "stk-field"); input.classList.add("ui-field"); f.append(el("span", label)); const box = el("span", null, "stk-field-box"); box.append(input); if (suffix) box.append(el("span", suffix, "stk-unit")); f.append(box); return f;};
      const name = el("input", null, "stk-text", {type:"text", "aria-label":"Profile name"}); name.value = p.name;
      name.onchange = () => {p.name = name.value.trim().slice(0, 80) || p.name; changed(); paintImpedance();};
      const type = el("select", null, "stk-select", {"aria-label":"Profile type"});
      for (const [k, v] of Object.entries(TYPE_LABEL)) option(type, k, v, k === p.type);
      type.onchange = () => {p.type = type.value; changed(); paintImpedance();};
      const num = (value, label, set, lo, hi, u) => {const i = el("input", null, "stk-num", {type:"text", inputmode:"decimal", "aria-label":label});i.dataset.numericUnit=u;i.value = String(value);
        i.onchange = () => {const x = Number(i.value); if (!(x >= lo && x <= hi)) {say(label + ": enter a value from " + lo + " to " + hi + ".", "error"); i.value = String(value); return;} set(x); say(""); changed(); paintImpedance();}; return i;};
      const stackSel = el("select", null, "stk-select", {"aria-label":"Substack"});
      for (const s of substacks(st)) option(stackSel, s.id, s.name, s.id === (p.stack || "main"));
      stackSel.onchange = () => {if (stackSel.value === "main") delete p.stack; else p.stack = stackSel.value; changed(); paintImpedance();};
      form.append(field("Name", name), field("Type", type), field("Target", num(p.target, "Target impedance in ohms", x => {p.target = x;}, 1, 1000,"Ω"), "Ω"),
        field("Tolerance", num(p.tolerance, "Tolerance in percent", x => {p.tolerance = x;}, 0, 100,"%"), "%"), field("Substack", stackSel));
      impMain.append(form);
      const cleaned = (st.impedanceProfiles || []).find(x => x.id === p.id), sub = substacks(st).find(s => s.id === (p.stack || "main")) || substacks(st)[0];
      const subKeys = sub.layers.filter(isCopper).map(l => l.key), subRows = subKeys.map(k => copperRows()[copperRows().findIndex(r => keyOfRow(r) === k)]).filter(Boolean);
      const diff = p.type.includes("diff"), cop = p.type.startsWith("cpw");
      const tw = el("div", null, "stk-table-wrap stk-imp-table"), t = el("table", null, "stk-table", {"aria-label":"Profile values per layer"}), th = el("tr"), tb = el("tbody");
      for (const h of ["On", "Layer", "Reference above", "Reference below", "Width (" + unit + ")", diff ? "Gap" : null, cop ? "Ground gap" : null, "Etch E", diff ? "Zdiff" : "Z0", diff ? "Zodd / Zeven" : null, "εeff", "Delay", "Loss @1 GHz", "Model"].filter(Boolean)) th.append(el("th", h, null, {scope:"col"}));
      const thd = el("thead"); thd.append(th); t.append(thd, tb); tw.append(t);
      let shown = null;
      for (const r of subRows) {
        const key = keyOfRow(r), entry = p.layers.get(r), on = !!entry && entry.enabled !== false, tr = el("tr", null, "stk-row");
        tr.setAttribute("aria-selected", String(r === profileRow));
        let v = null;
        if (on && cleaned) try {v = resolveProfileLayer(st, cleaned, key, undefined, {limits:fabLimits(doc)});} catch (error) {v = {error:error.message};}
        if (on && !profileRow) profileRow = r;
        if (r === profileRow && v && !v.error) shown = v;
        tr.onclick = e => {if (profileRow !== r && !["INPUT", "SELECT"].includes(e.target.tagName)) {profileRow = r; paintImpedance();}};
        const box = el("input", null, null, {type:"checkbox", "aria-label":"Use " + r.layer.name});
        box.checked = on; box.onchange = () => {if (box.checked) p.layers.set(r, {...(entry || {}), enabled:true, etch:entry?.etch || 0}); else p.layers.delete(r); profileRow = r; changed(); paintImpedance();};
        const c0 = el("td"); c0.append(box); tr.append(c0, el("td", r.layer.name + " (" + key + ")"));
        const refs = [0, 1].map(side => {
          const s = el("select", null, "stk-select", {"aria-label":(side ? "Reference below " : "Reference above ") + r.layer.name});
          option(s, "auto", "Adjacent"); option(s, "none", "None");
          const idx = subKeys.indexOf(key);
          for (const k of side ? subKeys.slice(idx + 1) : subKeys.slice(0, idx)) {const rr = copperRows().find(x => keyOfRow(x) === k); option(s, String(rr.uid), rr.layer.name);}
          const cur = entry?.reference ? entry.reference[side] : undefined;
          s.value = cur === undefined ? "auto" : cur === null ? "none" : String(cur.uid);
          s.disabled = !on;
          s.onchange = () => {
            const val = x => x === "auto" ? undefined : x === "none" ? null : copperRows().find(rr => String(rr.uid) === x);
            const pick = [refsSel[0].value, refsSel[1].value];
            if (pick.every(x => x === "auto")) delete entry.reference;
            else {const auto = v?.geometry ? [v.geometry.refTop, v.geometry.refBottom].map(k => k ? copperRows().find(rr => keyOfRow(rr) === k) : null) : [null, null];
              entry.reference = pick.map((x, i) => x === "auto" ? auto[i] : val(x));}
            changed(); paintImpedance();
          };
          const td = el("td"); td.append(s); tr.append(td); return s;
        });
        const refsSel = refs;
        const lenInput = (f, label, placeholder) => {
          const i = el("input", null, "stk-num", {type:"text", inputmode:"decimal", "aria-label":label + " " + r.layer.name}); i.dataset.unit=unit;i.value = entry?.[f] > 0 ? show(entry[f]) : ""; i.placeholder = placeholder || ""; i.disabled = !on;
          i.onchange = () => {const s = i.value.trim(); if (!s) delete entry[f]; else {const x = parse(s); if (!(x > 0 && x <= 100)) {say(label + ": enter a length.", "error"); return;} entry[f] = round(x);} say(""); changed(); paintImpedance();};
          const td = el("td"); td.append(i); tr.append(td);
        };
        lenInput("width", "Width", v?.solved && v.width ? show(v.width) : "auto");
        if (diff) lenInput("gap", "Gap", v?.gap ? show(v.gap) : "");
        if (cop) lenInput("ground", "Ground gap", v?.ground ? show(v.ground) : "");
        const etch = el("input", null, "stk-num", {type:"text", inputmode:"decimal", "aria-label":"Etch factor " + r.layer.name}); etch.value = entry?.etch ? String(entry.etch) : ""; etch.placeholder = "none"; etch.disabled = !on;
        etch.onchange = () => {const x = Number(etch.value || 0); if (!(x >= 0 && x <= 100)) {say("Etch factor: enter 0 (rectangular) to 100.", "error"); return;} entry.etch = x; changed(); paintImpedance();};
        const te = el("td"); te.append(etch); tr.append(te);
        const R = v?.result, ok = v && !v.error && R;
        const zc = el("td", ok ? R.z.toFixed(1) + " Ω" : v?.error ? "—" : "", ok ? (v.within ? "stk-strong" : "stk-warn") : "");
        if (v?.error) zc.title = v.error;
        tr.append(zc);
        if (diff) tr.append(el("td", ok ? R.zodd.toFixed(1) + " / " + R.zeven.toFixed(1) : ""));
        tr.append(el("td", ok ? R.eeff.toFixed(3) : ""), el("td", ok ? R.delay.toFixed(2) + " ps/mm" : ""), el("td", ok ? (R.loss.total * 1000).toFixed(1) + " dB/m" : ""),
          el("td", ok ? R.model : v?.error || "", v?.error ? "stk-warn" : "stk-muted"));
        tb.append(tr);
      }
      impMain.append(tw);
      if (shown) {
        const xs = el("div", null, "stk-xsec-wrap"); xs.append(crossSection(sub, p, shown));
        const facts = el("dl", null, "stk-imp-values"), row = (k, val) => facts.append(el("dt", k), el("dd", val));
        row("Width range for ±" + p.tolerance + " %", show(shown.minWidth) + " – " + show(shown.maxWidth) + " " + unit);
        if (shown.window < p.tolerance) row("DRC warns outside ±" + round(shown.window, 2) + " %", show(shown.warnMinWidth) + " – " + show(shown.warnMaxWidth) + " " + unit);
        if (diff) row("Gap range", show(shown.minGap) + " – " + show(shown.maxGap) + " " + unit);
        row("Zcommon", shown.result.zcommon.toFixed(1) + " Ω");
        row("Loss @1 GHz", (shown.result.loss.conductor * 1000).toFixed(2) + " conductor + " + (shown.result.loss.dielectric * 1000).toFixed(2) + " dielectric dB/m");
        if (shown.result.warnings.length) row("Note", shown.result.warnings.join(" "));
        xs.append(facts); impMain.append(xs);
      }
    }

    // Board Regions tab: the region inspector and bend lines.
    const regionsBody = el("div", null, "stk-regions");
    panels.regions.append(regionsBody);
    const ratios = () => {try {return globalThis.AtriumRules?.resolver?.(doc, {project})("bendRadius", {}) || null;} catch {return null;}};
    function ensureRegions() {
      if (regionsState.length) return true;
      if (!Array.isArray(doc.outline) || doc.outline.length < 3) {say("Define the board shape before splitting it into regions.", "error"); return false;}
      regionsState = [{id:"board", name:"Board", stack:"main", points:doc.outline.map(p => [p[0], p[1]])}];
      return true;
    }
    function splitAt(axis, value) {
      if (!Number.isFinite(value) || !ensureRegions() || !globalThis.AtriumRigidFlex) return;
      const ys = doc.outline.map(p => p[axis === "x" ? 1 : 0]), lo = Math.min(...ys) - 1, hi = Math.max(...ys) + 1;
      const a = axis === "x" ? [value, lo] : [lo, value], b = axis === "x" ? [value, hi] : [hi, value];
      const next = [], ids = new Set(regionsState.map(r => r.id));
      let n = regionsState.length, count = 0;
      for (const r of regionsState) {
        const pieces = AtriumRigidFlex.splitPolygon(r.points, a, b);
        if (pieces.length < 2) {next.push(r); continue;}
        count++;
        pieces.forEach((pts, i) => {
          if (!i) {next.push({...r, points:pts}); return;}
          while (ids.has("region-" + ++n));
          ids.add("region-" + n); next.push({id:"region-" + n, name:"Region " + n, stack:r.stack, points:pts});
        });
      }
      if (!count) {say("A " + (axis === "x" ? "vertical" : "horizontal") + " line at " + show(value) + " " + unit + " crosses no region.", "error"); return;}
      regionsState = next; changed(); paintRegions(); say("Split " + count + " region" + (count === 1 ? "" : "s") + ". Assign substacks below.", "");
    }
    function paintRegions() {
      regionsBody.replaceChildren();
      if (!globalThis.AtriumRigidFlex) {regionsBody.append(el("p", "Rigid-flex support is not loaded.", "stk-warn")); return;}
      let res, st;
      try {st = draft(); res = AtriumRigidFlex.regionsResolved(draftDoc(), defs);} catch (error) {regionsBody.append(el("p", "Fix the layer stack first: " + error.message, "stk-warn")); return;}
      const subsList = substacks(st);
      regionsBody.append(el("p", "Board regions split the outline; each uses one substack. Draw split and bend lines on the board in Board Planning mode (View › Board planning mode, key 1), or split here by coordinate.", "stk-note"));
      const splitBar = el("div", null, "stk-toolbar");
      for (const axis of ["x", "y"]) {
        const i = el("input", null, "stk-num", {type:"text", inputmode:"decimal", "data-unit":unit,"aria-label":"Split at " + axis.toUpperCase() + " in " + unit});
        splitBar.append(el("span", "Split at " + axis.toUpperCase(), "stk-label"), i, button("Split", () => splitAt(axis, parse(i.value)), "", "Split the regions crossed by a " + (axis === "x" ? "vertical" : "horizontal") + " line"));
      }
      splitBar.append(el("span", null, "stk-sep"), button("Merge all", () => {regionsState = []; changed(); paintRegions();}, "stk-danger", "Return to one region on the main stack"));
      regionsBody.append(splitBar);
      const t = el("table", null, "stk-table", {"aria-label":"Board regions"}), th = el("tr"), tb = el("tbody");
      for (const h of ["Region", "Substack", "Area (mm²)", "Copper layers", "Thickness", "Notes"]) th.append(el("th", h, null, {scope:"col"}));
      const thd = el("thead"); thd.append(th); t.append(thd, tb);
      for (const g of res.regions) {
        const tr = el("tr", null, "stk-row"), name = el("input", null, "stk-text", {type:"text", "aria-label":"Region name"});
        name.value = g.name; name.onchange = () => {if (!ensureRegions()) return; const r = regionsState.find(x => x.id === g.id); if (r) r.name = name.value.trim().slice(0, 80) || r.name; changed();};
        const s = el("select", null, "stk-select", {"aria-label":"Substack of " + g.name});
        for (const x of subsList) option(s, x.id, x.name + (x.flex ? " · flex" : ""), x.id === g.stack);
        s.onchange = () => {if (!ensureRegions()) return; const r = regionsState.find(x => x.id === g.id); if (r) r.stack = s.value; changed(); paintRegions();};
        const c1 = el("td"), c2 = el("td"); c1.append(name); c2.append(s);
        const notes = [g.flex ? "Flex" : "Rigid", ...g.stiffeners.map(x => x.side + " stiffener " + show(x.thickness) + " " + unit)];
        tr.append(c1, c2, el("td", g.area.toFixed(1)), el("td", g.copper.join(", ")), el("td", show(g.thickness) + " " + unit), el("td", notes.join(" · ")));
        tb.append(tr);
      }
      const tw = el("div", null, "stk-table-wrap"); tw.append(t); regionsBody.append(tw);
      if (!res.coverage.ok) regionsBody.append(el("p", "Regions cover " + res.coverage.regionArea.toFixed(1) + " of " + res.coverage.outlineArea.toFixed(1) + " mm². Redo the splits so every area has exactly one region.", "stk-warn"));
      // Bends
      regionsBody.append(el("h3", "Bend lines", "stk-h3"));
      const bt = el("table", null, "stk-table", {"aria-label":"Bend lines"}), bh = el("tr"), bb = el("tbody");
      for (const h of ["Name", "Region", "From", "To", "Angle (°)", "Radius (" + unit + ")", "Zone width", "Fold order", "Dynamic", "IPC-2223 minimum", ""]) bh.append(el("th", h, null, {scope:"col"}));
      const bhd = el("thead"); bhd.append(bh); bt.append(bhd, bb);
      const r = ratios();
      bendsState.forEach((b, i) => {
        const rb = res.bends[i], tr = el("tr", null, "stk-row"), td = n => {const c = el("td"); c.append(n); tr.append(c);};
        const txt = (val, label, set, isLen) => {const x = el("input", null, isLen === "name" ? "stk-text" : "stk-num", {type:"text", inputmode:"decimal", "aria-label":label});if(isLen==="name")x.inputMode="text";else if(isLen)x.dataset.unit=unit;else x.dataset.numericUnit="deg";x.value = val;
          x.onchange = () => {const s = x.value.trim(), q = isLen === "name" ? s : isLen ? parse(s) : Number(s); if (isLen !== "name" && !Number.isFinite(q)) {say(label + ": enter a number.", "error"); return;} set(q); changed(); paintRegions();}; return x;};
        td(txt(b.name, "Bend name", q => {b.name = q || b.name;}, "name"));
        tr.append(el("td", res.regions.find(g => g.id === rb?.region)?.name || "Outside"));
        td(el("span", show(b.a[0]) + ", " + show(b.a[1]), "stk-ro")); td(el("span", show(b.b[0]) + ", " + show(b.b[1]), "stk-ro"));
        td(txt(String(b.angle), "Bend angle", q => {b.angle = Math.max(-180, Math.min(180, q));}));
        td(txt(show(b.radius), "Bend radius", q => {if (q > 0) b.radius = round(q);}, true));
        td(txt(b.width ? show(b.width) : "", "Bend zone width", q => {b.width = q >= 0 ? round(q) : 0;}, true));
        // Fold order (flex-fold.js): lower folds first in the 3D view; empty folds with the first group.
        td(txt(b.order ? String(b.order) : "", "Fold order", q => {if (Number.isInteger(q) && q >= 1 && q <= 99) b.order = q; else delete b.order;}));
        const dyn = el("input", null, null, {type:"checkbox", "aria-label":"Dynamic flexing"}); dyn.checked = !!b.dynamic; dyn.onchange = () => {b.dynamic = dyn.checked; changed(); paintRegions();}; td(dyn);
        const need = rb?.flex ? AtriumRigidFlex.minBendRadius(rb.thickness, rb.copperCount, b.dynamic, r || undefined) : null;
        tr.append(el("td", need ? show(need.radius) + " " + unit + " (" + need.ratio + "× " + show(rb.thickness) + ")" : rb?.region ? "Rigid region" : "—", need && b.radius + 1e-9 < need.radius ? "stk-warn" : ""));
        td(button("Remove", () => {bendsState.splice(i, 1); changed(); paintRegions();}, "", "Remove bend " + b.name));
        if (rb && !b.width) tr.title = "Zone width defaults to the arc length, " + show(rb.width) + " " + unit;
        bb.append(tr);
      });
      const btw = el("div", null, "stk-table-wrap"); btw.append(bt); regionsBody.append(btw);
      const add = el("div", null, "stk-toolbar"), co = ["X1", "Y1", "X2", "Y2"].map(k => el("input", null, "stk-num", {type:"text", inputmode:"decimal", "data-unit":unit,"aria-label":"Bend line " + k + " in " + unit, placeholder:k}));
      add.append(el("span", "Add bend from", "stk-label"), co[0], co[1], el("span", "to", "stk-label"), co[2], co[3], button("Add bend", () => {
        const v = co.map(x => parse(x.value));
        if (!v.every(Number.isFinite) || Math.hypot(v[2] - v[0], v[3] - v[1]) < 1e-6) {say("Enter two different end points for the bend line.", "error"); return;}
        const ids = new Set(bendsState.map(x => x.id)); let n = bendsState.length + 1; while (ids.has("bend-" + n)) n++;
        bendsState.push({id:"bend-" + n, name:"Bend " + n, a:[v[0], v[1]], b:[v[2], v[3]], angle:90, radius:1, width:0, dynamic:false}); changed(); paintRegions();
      }));
      regionsBody.append(add);
    }

    function select(id) {
      tab = id;
      for (const [k, b] of Object.entries(tabButtons)) {b.setAttribute("aria-selected", String(k === id)); b.tabIndex = k === id ? 0 : -1; panels[k].hidden = k !== id;}
      if (id === "vias") paintVias();
      if (id === "impedance") paintImpedance();
      if (id === "regions") paintRegions();
    }

    function commit() {
      const layers = rows.map(r => ({...r.layer, source:isCopper(r.layer) ? r.orig ?? undefined : undefined}));
      const cu = copperRows(), drill = pairs.map(p => ({from:keyAt(cu.indexOf(p.a), cu.length), to:keyAt(cu.indexOf(p.b), cu.length)}));
      const movesByKey = {};
      for (const [k, r] of moves) if (r.orig) movesByKey[k] = r.orig;
      const result = plan(doc, defs, layers, {moves:movesByKey, drillPairs:drill, project, extras:extras()});
      if (!result.ok) {select("stackup"); say(result.problems.join(" "), "error"); return;}
      let moved = 0;
      try {ctx.edit(() => {moved = apply(doc, defs, result);});}
      catch (error) {say(error.message, "error"); return;}
      ctx.info?.("Layer stack saved · " + copperOf(result.stackup).length + " copper layers · " + both(total(result.stackup)) + (result.stackup.substacks ? " · " + (result.stackup.substacks.length + 1) + " substacks" : "") + (moved ? " · " + moved + " layer references updated" : ""));
      dirty = false; d.close();
    }
    const actions = el("div", null, "work-actions ui-dialog-actions");
    const ok = button("OK", commit);
    ok.dataset.variant = "primary";
    actions.append(button("Cancel", () => d.close()), ok);
    d.append(head, tabs, panels.stackup, panels.vias, panels.impedance, panels.regions, message, summary, actions);
    d.addEventListener("cancel", e => {if (dirty && !confirmDiscard()) e.preventDefault();});
    function confirmDiscard() {return typeof confirm !== "function" || confirm("Discard the layer stack changes?");}
    d.addEventListener("close", () => d.remove(), {once:true});
    document.body.append(d);
    paintSubBar(); paintRows(); select(ctx.tab && panels[ctx.tab] ? ctx.tab : "stackup"); globalThis.AtriumShell?.adoptDialog?.(d, {initialFocus: () => tbody.querySelector('[aria-selected="true"]'), defaultAction: false}); d.showModal();
    tbody.querySelector('[aria-selected="true"]')?.focus();
    return d;
  }

  return Object.freeze({VERSION, OZ, TYPES, PRESETS, guard, newerStack, copperIndex, keyAt, weight, isCopper, build, preset, blank, normalize, problems,
    stored, derive, get, copperLayers, thickness, layerDepths, layerInfo, drillPairs, usage, describe, plan, apply, kicad, open,
    substacks, flexLayers, impedanceProfiles, profileValues, profileAlong, stackAt, signature, revision, touch, resolveProfileLayer, delay, pairDelay,
    fabLimits, SOLVER_POLICY, LEGACY_POLICY, DEFAULT_FAB,
    regions, splitRegion, assignStack, regionsResolved, setPlanning, planning, isPlanning:planning});
})();
