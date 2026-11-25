"use strict";
// Fab Capability Presets (Design › Fab Preset…).
//
// A preset is one board house's offer as data: design rules, the layer stack (with the house's
// own impedance stack-up and calculator inputs), board limits, DFM limits and the files the house
// wants (Gerber/drill naming, BOM and pick-and-place layouts, the release package). Vendors are data
// files, app/fab-presets/<vendor>.json, with a generated loader <vendor>.js that the app loads lazily
// (no fetch from file://) and headless runners require directly. Adding a fab is adding a file and
// one line in VENDORS below.
//
// Every value in a data file is either plain or {v, src, q?} (src names an entry of `sources`, which
// carries the URL and the date it was read) or {v, unverified:true, note} (a conservative default the
// source pages did not confirm). The UI shows both.
//
//   AtriumFabPresets.define(data)              register a vendor file (the loaders call this)
//   AtriumFabPresets.load(vendor) -> Promise    lazy-load a vendor file in the app
//   AtriumFabPresets.list() / get(id)           resolved presets (extends applied)
//   AtriumFabPresets.plan(project, doc, id, {defs})   what applying would change (nothing is changed)
//   AtriumFabPresets.apply(project, doc, id, {defs})  apply inside the caller's undoable edit; idempotent
//   AtriumFabPresets.update(doc)               the recorded preset against the current data (diff)
//   AtriumFabPresets.limits(doc | id)          numeric DFM limits for AtriumDFM
//   AtriumFabPresets.outputLayout(vendor)      the order-upload layout output-jobs.js reads
//   AtriumFabPresets.headless(op, args, env)   MCP: list_fab_presets, apply_fab_preset
//
// The project records the preset on the board: doc.fabPreset = {format, version, vendor, id, name,
// dataVersion, hash}. It is an optional field (older Waffle keeps it untouched) and has no dates, so
// applying twice writes the same bytes. AtriumCompat.stores lists it as "fab-preset".
globalThis.AtriumFabPresets = (() => {
  const FORMAT = "atrium-fab-preset", VERSION = 1, MIL = .0254, DASH = " – ";
  const VENDORS = Object.freeze([{vendor: "JLCPCB", global: "AtriumFabPresetsJLCPCB", script: "fab-presets/jlcpcb.js"}]);
  const plain = o => o !== null && typeof o === "object" && !Array.isArray(o);
  const val = x => plain(x) && "v" in x ? x.v : x;
  const round = v => Math.round(v * 1e6) / 1e6 + 0;
  const clone = o => JSON.parse(JSON.stringify(o));
  const data = new Map();
  const fail = m => { throw Error(m); };

  // ---------------------------------------------------------------- data files
  function readData(raw) {
    if (!plain(raw) || raw.format !== FORMAT) fail("Not a fab preset file (format " + FORMAT + ").");
    if (!Number.isInteger(raw.version) || raw.version < 1) fail("The fab preset file has no version.");
    if (raw.version > VERSION) fail("This fab preset file was made by a newer Waffle (version " + raw.version + "). Update Waffle to use it.");
    if (typeof raw.vendor !== "string" || !raw.vendor || !Array.isArray(raw.presets) || !raw.presets.length) fail("A fab preset file needs a vendor and presets.");
    const ids = new Set();
    for (const p of raw.presets) {
      if (!plain(p) || typeof p.id !== "string" || !/^[\w.-]{1,80}$/.test(p.id) || ids.has(p.id)) fail("Each preset needs a unique id.");
      ids.add(p.id);
      if (p.extends && !raw.presets.some(q => q.id === p.extends)) fail(p.id + " extends an unknown preset.");
    }
    return raw;
  }
  function define(raw) {
    const d = readData(raw);
    data.set(d.vendor, Object.freeze(d));
    return d;
  }
  function load(vendor) {
    const v = VENDORS.find(x => x.vendor === vendor);
    if (!v) return Promise.reject(Error("Unknown fab " + vendor + "."));
    if (data.has(vendor)) return Promise.resolve(data.get(vendor));
    const L = globalThis.AtriumLazy;
    if (!L) return Promise.reject(Error("The " + vendor + " presets are not loaded."));
    if (!L.modules?.().includes(v.global)) L.register(v.global, {scripts: [v.script], deps: ["AtriumFabPresets"]});
    return L.need(v.global).then(() => data.get(vendor));
  }
  const loadAll = () => Promise.all(VENDORS.map(v => load(v.vendor)));
  const vendors = () => VENDORS.map(v => v.vendor);

  // ---------------------------------------------------------------- resolving
  function merge(a, b) {
    if (!plain(a) || !plain(b) || "v" in b) return clone(b);
    const out = clone(a);
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : clone(v);
    return out;
  }
  function stackFrom(parent, child) {
    if (!child) return parent ? clone(parent) : null;
    if (child.layers) return clone(child);
    const st = clone(parent);
    if (child.name) st.name = child.name;
    if (child.core != null) for (const l of st.layers) if (l.type === "Dielectric") l.thickness = child.core;
    for (const [name, patch] of Object.entries(child.replace || {})) for (const l of st.layers) if (l.name === name) Object.assign(l, patch);
    for (const [i, patch] of Object.entries(child.replaceAt || {})) if (st.layers[+i]) Object.assign(st.layers[+i], patch);
    if (child.sourceNotes) st.sourceNotes = [...child.sourceNotes, ...(st.sourceNotes || []).filter(n => !child.sourceNotes.some(c => c.key === n.key))];
    return st;
  }
  const cache = new Map();
  function resolveIn(d, id, depth = 0) {
    const raw = d.presets.find(p => p.id === id);
    if (!raw || depth > 8) return null;
    let p;
    if (raw.extends) {
      const base = resolveIn(d, raw.extends, depth + 1);
      const {extends: _, stackup, ...rest} = raw;
      p = merge(base, rest);
      p.stackup = stackFrom(base.stackup, stackup);
      p.base = base.base || base.id;
      delete p.impedanceChecks;
      if (!raw.impedanceChecks && base.impedanceChecks && !stackup) p.impedanceChecks = clone(base.impedanceChecks);
    } else {
      p = clone(raw);
      p.limits = merge(d.common?.limits || {}, raw.limits || {});
      p.board = merge(d.common?.board || {}, raw.board || {});
      p.capabilities = clone(d.common?.capabilities || {});
      p.outputs = clone(d.outputs?.[raw.outputs] || {});
    }
    return p;
  }
  function get(id) {
    if (plain(id) && id.id) id = id.id;
    for (const d of data.values()) {
      if (!d.presets.some(p => p.id === id)) continue;
      const key = d.vendor + "|" + d.dataVersion + "|" + id;
      if (!cache.has(key)) {
        const p = resolveIn(d, id);
        p.vendor = d.vendor; p.dataVersion = d.dataVersion; p.retrieved = d.retrieved; p.notice = d.notice;
        p.sources = clone(d.sources);
        p.hash = hash(JSON.stringify(canon(p)));
        cache.set(key, Object.freeze(p));
      }
      return cache.get(key);
    }
    return null;
  }
  const list = () => [...data.values()].flatMap(d => d.presets.map(p => get(p.id)));
  function canon(v) {
    if (Array.isArray(v)) return v.map(canon);
    if (!plain(v)) return v;
    const o = {};
    for (const k of Object.keys(v).sort()) if (k !== "hash") o[k] = canon(v[k]);
    return o;
  }
  function hash(s) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822519); }
    return ((h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0"));
  }
  // Values that the sources did not confirm: [{key, value, note}].
  function unverified(p) {
    p = typeof p === "string" ? get(p) : p;
    const out = [];
    const walk = (o, path) => {
      if (Array.isArray(o)) { o.forEach((x, i) => walk(x, path + "[" + i + "]")); return; }
      if (!plain(o)) return;
      if (o.unverified) out.push({key: path, value: "v" in o ? o.v : null, note: o.note || ""});
      for (const [k, v] of Object.entries(o)) if (k !== "sources") walk(v, path ? path + "." + k : k);
    };
    walk(p, "");
    return out;
  }
  // The source of one value: {url, title, retrieved, quote} or {unverified, note}.
  function sourceOf(p, x) {
    if (!plain(x)) return null;
    if (x.unverified) return {unverified: true, note: x.note || ""};
    const s = x.src && p.sources?.[x.src];
    return s ? {url: s.url, title: s.title, retrieved: s.retrieved, quote: x.q || ""} : null;
  }
  // Numeric DFM limits of a preset (or of the preset recorded on a board).
  function limits(ref) {
    const p = typeof ref === "string" ? get(ref) : ref?.fabPreset ? get(ref.fabPreset.id) : ref?.limits ? ref : null;
    if (!p) return null;
    const L = {};
    for (const [k, x] of Object.entries(p.limits)) L[k] = val(x);
    L.layers = p.layers;
    L.thickness = val(p.build?.thickness);
    L.minSize = val(p.board?.minSize); L.maxSize = val(p.board?.maxSize);
    for (const [k, x] of Object.entries(p.capabilities || {})) L[k] = val(x);
    L.preset = p.id; L.name = p.name; L.vendor = p.vendor;
    return L;
  }

  // ---------------------------------------------------------------- stack-up
  const ST = () => globalThis.AtriumStackup || fail("The layer stack module is not loaded.");
  // Layers ready for AtriumStackup.plan, with impedance profiles (calculator etch per layer).
  function stackLayers(p) {
    return p.stackup.layers.map(l => { const o = {...l}; delete o.key; return o; });
  }
  function profilesFor(p, layers) {
    const imp = p.impedance;
    if (!imp?.profiles?.length) return [];
    const cuIdx = layers.map((l, i) => ST().isCopper(l) ? i : -1).filter(i => i >= 0), n = cuIdx.length;
    const keys = cuIdx.map((_, i) => ST().keyAt(i, n));
    const planes = cuIdx.map((i, k) => layers[i].type === "Plane" ? k : -1).filter(k => k >= 0);
    const undercut = val(imp.etchMil) * MIL / 2, tol = val(p.limits.impedanceTolerance) ?? 10;
    const rows = {};
    cuIdx.forEach((i, k) => {
      if (layers[i].type === "Plane") return;
      const up = [...planes].reverse().find(q => q < k), down = planes.find(q => q > k);
      const reference = [up != null ? keys[up] : null, down != null ? keys[down] : null];
      if (reference[0] == null && reference[1] == null) return;
      rows[keys[k]] = {enabled: true, reference, etch: round(layers[i].thickness / undercut)};
    });
    return imp.profiles.map(pr => ({id: pr.id, name: pr.name, type: pr.type, target: pr.target, tolerance: tol,
      layers: Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, {...r, ...(pr.gap ? {gap: pr.gap} : {})}]))}));
  }
  const STACK_KEYS = ["type", "name", "material", "thickness", "dielectric", "dk", "df"];
  const layerText = l => l.name + " · " + l.type + (l.dielectric ? " (" + l.dielectric + ")" : "") + " · " + round(l.thickness) + " mm" + (l.dk ? " · Dk " + l.dk : "");
  function stackPlan(project, doc, defs, p) {
    const S = ST(), before = S.get(doc, defs), oldKeys = S.copperLayers(doc, defs);
    if (before.substacks?.length || before.regions?.length || before.bends?.length)
      return {ok: false, skipped: true, problems: ["The board has rigid-flex substacks or regions: the preset leaves its layer stack alone. Apply the stack-up in the Layer Stack Manager."], changes: []};
    const layers = stackLayers(p), cu = layers.filter(S.isCopper);
    cu.forEach((l, i) => { const was = i === 0 ? "Top" : i === cu.length - 1 ? "Bottom" : S.keyAt(i, cu.length); if (oldKeys.includes(was)) l.source = was; });
    const presetProfiles = profilesFor(p, layers), ours = new Set(presetProfiles.map(x => x.id));
    const keep = oldKeys.length === cu.length ? (before.impedanceProfiles || []).filter(x => !ours.has(x.id)) : [];
    const result = S.plan(doc, defs, layers, {project, drillPairs: [], extras: {impedanceProfiles: [...keep, ...presetProfiles]}});
    if (!result.ok) return {ok: false, problems: result.problems, changes: []};
    const next = result.stackup;
    next.source = "preset:" + p.id;
    const a = before.layers, b = next.layers, changes = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i], y = b[i];
      if (!x) changes.push({kind: "added", text: layerText(y)});
      else if (!y) changes.push({kind: "removed", text: layerText(x)});
      else if (STACK_KEYS.some(k => (x[k] ?? null) !== (y[k] ?? null))) changes.push({kind: "changed", from: layerText(x), text: layerText(y)});
    }
    const was = JSON.stringify(canon(stripDerived(doc.stackup || null))), now = JSON.stringify(canon(stripDerived(next)));
    if (was !== now && !changes.length) changes.push({kind: "changed", text: "Impedance profiles and stack-up settings"});
    return {ok: true, problems: [], changes, same: was === now, result, layers: S.copperLayers({...doc, stackup: next}, defs).length,
      thickness: round(next.layers.reduce((s, l) => s + (l.thickness || 0), 0))};
  }
  function stripDerived(st) { if (!st) return null; const c = clone(st); delete c.derived; return c; }

  // ---------------------------------------------------------------- rules
  const R = () => globalThis.AtriumRules || fail("Design rules are unavailable in this build.");
  const COVERED = ["clearance", "width", "viaStyle", "holeSize", "annularRing", "holeToHole", "boardOutlineClearance", "solderMask", "silkToMask"];
  function ruleRecords(p) {
    const L = limits(p), short = p.vendor, Rs = R();
    const scopes = globalThis.AtriumDesignQueryRecord;
    const base = (key, type, label, props, scope = scopes.selector("all")) => {
      const presetKey = "fp-" + p.id + "-" + key;
      return {id: presetKey, presetKey, type, name: (short + DASH + label).slice(0, 128),
        comment: "From fab preset " + p.name + " (" + p.dataVersion + ").", enabled: true, priority: 1, scope, ...(Rs.types[type].two ? {scope2: scopes.selector("all")} : {}), ...props};
    };
    const out = [
      base("clearance", "clearance", "Clearance", {gap: L.space}),
      base("width", "width", "Width", {min: L.track, preferred: round(Math.max(L.track, .25)), max: null}),
      base("vias", "viaStyle", "Routing Vias", {diameterMin: L.viaDiameter, diameterPreferred: round(Math.max(L.viaDiameter, L.viaDiameterPreferred)), diameterMax: null,
        holeMin: L.viaDrill, holePreferred: round(Math.max(L.viaDrill, L.viaDrillPreferred)), holeMax: null}),
      base("holes", "holeSize", "Hole Size", {min: L.minHole, max: L.maxHole}),
      base("ring", "annularRing", "Annular Ring (vias)", {min: L.viaRing}),
      base("h2h", "holeToHole", "Hole To Hole", {gap: L.holeToHoleVia}),
      base("edge", "boardOutlineClearance", "Board Outline Clearance", {gap: L.edgeClearance}),
      base("mask", "solderMask", "Solder Mask Expansion", {expansion: L.maskExpansion}),
      base("silk", "silkToMask", "Silk To Mask", {gap: L.silkToPad})
    ];
    // Plated component holes have their own (larger) ring: a query-scoped rule ahead of the via ring.
    out.splice(5, 0, {...base("pthring", "annularRing", "Annular Ring (PTH)", {min: L.pthRing}, scopes.create("pad")), priority: 0});
    return out;
  }
  const boardWide = r => globalThis.AtriumDesignQueryRecord.isAll(r.scope) && (!r.scope2 || globalThis.AtriumDesignQueryRecord.isAll(r.scope2));
  // Rules in a rule set other than Default (rules.js, format 1.3) belong to that set: a preset never replaces them.
  const otherSet = r => typeof r.set === "string" && r.set.toLowerCase() !== "default";
  function rulesPlan(project, doc, p) {
    const rules = R(), key = rules.presetRuleKey;
    const current = rules.migrate(rules.stored(doc, project)), records = ruleRecords(p), covered = new Set(records.map(r => r.type));
    const kept = [], replaced = [];
    const sig = r => r.type + "|" + JSON.stringify(r.scope) + "|" + JSON.stringify(r.scope2 || null);
    for (const r of current.list) {
      const presetKey = key(r);
      const generated = presetKey?.startsWith("fp-") || presetKey?.startsWith("fab-");
      (covered.has(r.type) && !otherSet(r) && (generated || boardWide(r)) ? replaced : kept).push(r);
    }
    const priorRules = replaced.filter(r => key(r)?.startsWith("fp-"));
    const priorKeys = new Map(priorRules.map(r => [key(r), r]));
    const incoming = new Set(records.map(r => r.presetKey));
    const priorSlots = new Map(priorRules.filter(r => !incoming.has(key(r))).map(r => [sig(r), r]));
    const names = new Set(kept.map(r => r.name.toLowerCase())), ids = new Set(kept.map(r => r.id)), added = new Set();
    const list = [...kept];
    for (const r of records) {
      let name = r.name, n = 2;
      while (names.has(name.toLowerCase())) name = r.name + " " + n++;
      names.add(name.toLowerCase());
      const exact = priorKeys.get(r.presetKey);
      const previous = exact?.type === r.type ? exact : priorSlots.get(sig(r));
      let id = previous?.id ?? r.id;
      while (ids.has(id)) id = r.id + "-" + n++;
      ids.add(id);
      added.add(id);
      list.push({...r, id, presetKey: previous && key(previous) === r.presetKey ? previous.presetKey : r.presetKey, name});
    }
    const next = rules.validate(rules.normalize({...current, list}));
    // Diff by rule type and scope: added, changed (with the fields), removed, unchanged.
    const FIELDS = r => R().types[r.type].fields.map(f => f.key);
    // Each replaced rule is listed: the first of a type and scope as the one changed, any others as removed.
    const was = new Map(), rows = [], removedToo = [];
    for (const r of replaced) { if (was.has(sig(r))) removedToo.push(r); else was.set(sig(r), r); }
    for (const r of next.list.filter(r => added.has(r.id))) {
      const old = was.get(sig(r));
      was.delete(sig(r));
      if (!old) { rows.push({kind: "added", type: r.type, name: r.name, text: R().describe(r, "mm")}); continue; }
      const diff = FIELDS(r).filter(k => JSON.stringify(old[k] ?? null) !== JSON.stringify(r[k] ?? null)).map(k => ({field: k, from: old[k] ?? null, to: r[k] ?? null}));
      rows.push({kind: diff.length || old.name !== r.name ? "changed" : "unchanged", type: r.type, name: r.name, from: old.name, diff, text: R().describe(r, "mm")});
    }
    for (const r of [...was.values(), ...removedToo]) rows.push({kind: "removed", type: r.type, name: r.name, text: R().describe(r, "mm")});
    const same = JSON.stringify(canon(current)) === JSON.stringify(canon(next));
    return {rules: next, rows, same, kept: kept.length};
  }

  // ---------------------------------------------------------------- plan and apply
  function recordOf(p) {
    return {format: FORMAT, version: VERSION, vendor: p.vendor, id: p.id, name: p.name, dataVersion: p.dataVersion, hash: p.hash};
  }
  function boardChecks(doc, defs, p) {
    const out = [], L = limits(p), ol = Array.isArray(doc?.outline) ? doc.outline : [];
    if (ol.length >= 3) {
      const xs = ol.map(q => q[0]), ys = ol.map(q => q[1]), w = round(Math.max(...xs) - Math.min(...xs)), h = round(Math.max(...ys) - Math.min(...ys));
      const [a, b] = [Math.max(w, h), Math.min(w, h)];
      if (L.maxSize && (a > Math.max(...L.maxSize) || b > Math.min(...L.maxSize))) out.push({level: "error", text: "The board (" + w + " × " + h + " mm) is larger than " + L.maxSize.join(" × ") + " mm."});
      if (L.minSize && (a < Math.max(...L.minSize) || b < Math.min(...L.minSize))) out.push({level: "warning", text: "The board (" + w + " × " + h + " mm) is smaller than " + L.minSize.join(" × ") + " mm."});
    } else out.push({level: "info", text: "The board has no outline yet: size limits are " + (L.minSize || []).join(" × ") + " to " + (L.maxSize || []).join(" × ") + " mm."});
    return out;
  }
  function plan(project, doc, id, o = {}) {
    const p = typeof id === "string" ? get(id) : id;
    if (!p) fail("Unknown fab preset " + id + ".");
    if (doc?.kind !== "pcb") fail("Fab presets apply to a board layout.");
    const defs = o.defs || new Map((project?.library || []).map(d => [d.id, d]));
    const rules = rulesPlan(project, doc, p), stack = o.stackup === false ? null : stackPlan(project, doc, defs, p);
    const record = recordOf(p), recordSame = JSON.stringify(doc.fabPreset || null) === JSON.stringify(record);
    const noop = rules.same && (!stack || !stack.ok || stack.same) && recordSame;
    return {preset: p, record, recordSame, rules, stack, board: boardChecks(doc, defs, p), unverified: unverified(p), noop,
      summary: summaryOf(rules, stack, recordSame)};
  }
  function summaryOf(rules, stack, recordSame) {
    const n = k => rules.rows.filter(r => r.kind === k).length, bits = [];
    if (n("added")) bits.push(n("added") + " rule" + (n("added") === 1 ? "" : "s") + " added");
    if (n("changed")) bits.push(n("changed") + " changed");
    if (n("removed")) bits.push(n("removed") + " removed");
    if (stack?.ok && !stack.same) bits.push("layer stack: " + stack.changes.length + " change" + (stack.changes.length === 1 ? "" : "s"));
    if (stack && !stack.ok) bits.push("layer stack not changed");
    if (!recordSame) bits.push("preset recorded on the board");
    return bits.join(", ") || "Nothing to change: the board already uses this preset.";
  }
  // Applies a plan (or a preset id) to the board. Call inside one undoable edit.
  function apply(project, doc, ref, o = {}) {
    const pl = ref?.preset && ref.rules ? ref : plan(project, doc, ref, o);
    if (pl.noop) return {changed: false, summary: pl.summary, preset: pl.preset.id};
    const defs = o.defs || new Map((project?.library || []).map(d => [d.id, d]));
    if (!pl.rules.same) {
      const rules = R();
      rules.store(doc, project, rules.materializePresetRules(pl.rules.rules, rules.stored(doc, project)));
    }
    let moved = 0;
    if (pl.stack?.ok && !pl.stack.same) moved = ST().apply(doc, defs, pl.stack.result);
    doc.fabPreset = pl.record;
    const F = globalThis.AtriumFabProfiles;
    if (doc.fabProfile && F && !F.get(doc.fabProfile.id)) delete doc.fabProfile;
    return {changed: true, summary: pl.summary, preset: pl.preset.id, moved};
  }
  // The board's recorded preset against the loaded data: {recorded, current, outdated, plan} or null.
  function update(project, doc, o = {}) {
    const rec = doc?.fabPreset;
    if (!plain(rec) || rec.format !== FORMAT) return null;
    if (rec.version > VERSION) return {recorded: rec, current: null, outdated: false, newer: true};
    const p = get(rec.id);
    if (!p) return {recorded: rec, current: null, outdated: false, missing: true};
    const outdated = p.hash !== rec.hash;
    return {recorded: rec, current: recordOf(p), outdated, plan: outdated ? plan(project, doc, p, o) : null};
  }

  // ---------------------------------------------------------------- outputs
  // The upload layout output-jobs.js (vendor bundles) and fab-profiles.js read.
  function outputLayout(vendor) {
    const d = data.get(vendor);
    if (!d) return null;
    const o = d.outputs?.[d.presets[0].outputs] || Object.values(d.outputs || {})[0];
    if (!o) return null;
    const src = Object.values(d.sources).map(s => s.url);
    return Object.freeze({vendor, gerberZip: val(o.gerber.zip), gerberUnits: val(o.gerber.units), drillUnits: val(o.drill.units), x2: val(o.gerber.x2),
      gerberFormat: val(o.gerber.format), sources: Object.freeze(src), orderNotes: "{stem}-Order-Notes.txt",
      pnp: Object.freeze({style: o.cpl.style, name: o.cpl.name}), bom: Object.freeze({style: o.bom.style, format: o.bom.format, name: o.bom.name}),
      notes: Object.freeze(["Upload the Gerber zip for the PCB, then " + o.bom.name.replace("{stem}", "*") + " and " + o.cpl.name.replace("{stem}", "*") + " for assembly.",
        "BOM columns: " + val(o.bom.columns).join(", ") + " (from an LCSC/JLC part number parameter).",
        "CPL: " + val(o.cpl.columns).join(", ") + " in mm; rotation in degrees, counter-clockwise; check JLC's placement preview."])});
  }
  // A release job set (File › Release…) for a preset: the vendor bundle with the DFM gate on.
  function releaseSet(id) {
    const p = get(id);
    if (!p) fail("Unknown fab preset " + id + ".");
    const L = outputLayout(p.vendor), o = (kind, options = {}, extra = {}) => ({id: kind, kind, enabled: true, options, ...extra});
    return {name: p.name + " order", fabPreset: p.id, package: {mode: "vendor", vendor: p.vendor}, folder: "{project}-{rev}-" + p.vendor + "-{date}",
      description: "The files " + p.vendor + " asks for, from the " + p.name + " preset.", gates: {dfm: true}, outputs: [
        o("drc", {failOver: 0, format: "html"}),
        o("gerber", {units: L.gerberUnits, drillUnits: L.drillUnits, readme: false, pack: L.gerberZip, x2: L.x2}, {folder: ""}),
        o("bom", {style: L.bom.style, format: L.bom.format, source: "pcb", name: L.bom.name}, {folder: ""}),
        o("pnp", {style: L.pnp.style, units: "mm", name: L.pnp.name}, {folder: ""}),
        o("notes", {vendor: p.vendor}, {folder: ""}), o("readme")]};
  }

  // ---------------------------------------------------------------- headless (MCP)
  function presetRow(p, full) {
    const row = {id: p.id, name: p.name, vendor: p.vendor, layers: p.layers, variant: p.variant || null, base: p.base || null, cost_tier: val(p.costTier) || "base",
      cost_tier_verified: !(plain(p.costTier) && p.costTier.unverified), stackup: p.stackup?.name || null, data_version: p.dataVersion, retrieved: p.retrieved, hash: p.hash};
    if (full) Object.assign(row, {limits: limits(p), outputs: clone(p.outputs), unverified: unverified(p), sources: p.sources, summary: p.summary || ""});
    return row;
  }
  function headless(op, a = {}, env = {}) {
    if (op === "fab_presets_list") {
      const rows = list().filter(p => !a.vendor || p.vendor === a.vendor).filter(p => !a.layers || p.layers === a.layers);
      const doc = env.project ? (env.project().documents || []).find(d => d.kind === "pcb" && (!a.document_id || d.id === a.document_id || d.name === a.document_id)) : null;
      const up = doc ? update(env.project(), doc) : null;
      return {presets: rows.map(p => presetRow(p, a.detail === true || a.id === p.id)).filter(r => !a.id || r.id === a.id), board_preset: doc?.fabPreset || null,
        update_available: !!up?.outdated, notice: [...data.values()][0]?.notice || ""};
    }
    if (op === "fab_preset_apply") {
      const p = get(a.preset) || fail("Unknown fab preset " + a.preset + ". list_fab_presets lists them.");
      const proj = a.plan_only ? clone(env.project()) : env.mutable();
      const doc = (proj.documents || []).find(d => d.kind === "pcb" && (!a.document_id || d.id === a.document_id || d.name === a.document_id)) || fail("No board layout " + (a.document_id || "") + ".");
      const defs = new Map(proj.library.map(d => [d.id, d]));
      const pl = plan(proj, doc, p, {defs, stackup: a.stackup !== false});
      const report = {document_id: doc.id, preset: p.id, name: p.name, noop: pl.noop, summary: pl.summary,
        rules: pl.rules.rows.filter(r => r.kind !== "unchanged"), stackup: pl.stack ? {ok: pl.stack.ok, problems: pl.stack.problems, changes: pl.stack.changes, copper_layers: pl.stack.layers ?? null} : null,
        board: pl.board, unverified: pl.unverified.map(u => u.key)};
      if (a.plan_only || pl.noop) return report;
      apply(proj, doc, pl, {defs});
      env.touched?.();
      return {...report, applied: true};
    }
    fail("Unknown fab preset operation " + op + ".");
  }

  // ---------------------------------------------------------------- dialog (Design › Fab Preset…)
  function el(tag, text, cls, attrs) { return AtriumNavCommon.elWithAttributes(tag, text, cls, attrs); }
  function button(text, act, cls, title) { const b = el("button", text, cls); b.type = "button"; b.classList.add("ui-button"); b.onclick = act; if (title) b.title = title; return b; }
  const fmtMM = v => v == null ? "—" : Array.isArray(v) ? v.join(" × ") + " mm" : typeof v === "number" ? round(v) + " mm" : String(v);
  const LIMIT_ROWS = [["track", "Min track"], ["space", "Min spacing"], ["viaDrill", "Min via drill"], ["viaDiameter", "Min via diameter"], ["pthRing", "Min PTH annular ring"],
    ["minHole", "Min hole"], ["npthMin", "Min NPTH"], ["npthSlotMin", "Min unplated slot"], ["pthSlotMin", "Min plated slot"], ["holeToHolePad", "Pad hole to hole"],
    ["edgeClearance", "Copper to routed edge"], ["vScoreClearance", "Copper to V-score"], ["maskWeb", "Min solder mask web"], ["silkWidth", "Min silkscreen line"],
    ["silkHeight", "Min text height"], ["silkToPad", "Silkscreen to pad"], ["drillTolPlus", "Drill tolerance (+)"], ["acidTrapAngle", "Acid-trap angle"]];
  function open(ctx, opts = {}) {
    const doc = ctx.doc;
    if (doc?.kind !== "pcb") { ctx.info?.("Open a board layout to choose a fab preset."); return null; }
    const presets = list();
    if (!presets.length) { ctx.info?.("No fab presets are loaded."); return null; }
    let current = opts.preset || doc.fabPreset?.id || presets[0].id;
    if (!get(current)) current = presets[0].id;
    const d = el("dialog", null, "work-dialog ui-dialog fps-dialog", {"aria-label": "Fab preset"});
    const head = el("div", null, "fps-head");
    const title = el("h2", "Fab Preset");
    head.append(title, el("span", (doc.name || "Board") + (doc.fabPreset ? " · uses " + doc.fabPreset.name : ""), "fps-sub"));
    const body = el("div", null, "fps-body"), side = el("div", null, "ui-list fps-list", {role: "listbox", "aria-label": "Fab presets", "data-layout": "stacked", "data-row-focus": ""}), main = el("div", null, "fps-main");
    const status = el("p", null, "fps-status ui-dialog-status", {role: "status", "aria-live": "polite"});
    body.append(side, main);
    const up = update(ctx.project, doc, {defs: ctx.defs});
    function paintList() {
      side.replaceChildren();
      let group = null;
      for (const p of presets) {
        const g = p.vendor + " · " + p.layers + " layers";
        if (g !== group) { group = g; side.append(el("div", g, "fps-group")); }
        const it = el("div", null, "ui-row fps-item", {role: "option", tabindex: "0", "aria-selected": String(p.id === current)});
        const tier = val(p.costTier) || "base";
        it.append(el("strong", p.variant ? p.variant : p.name), el("small", (tier === "base" ? "Lowest-cost options" : tier === "extra" ? "Extra-cost option" : "Standard option") + (p.stackup?.name ? " · " + p.stackup.name : ""), "ui-row-subtitle"));
        if (doc.fabPreset?.id === p.id) it.append(el("span", "Applied", "fps-badge"));
        const pick = () => { current = p.id; paint(); };
        it.onclick = pick; it.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { pick(); e.preventDefault(); } };
        side.append(it);
      }
    }
    let pl = null;
    function paintMain() {
      const p = get(current);
      main.replaceChildren();
      main.append(el("h3", p.name), el("p", p.summary || "", "fps-note"));
      if (up?.outdated && up.recorded.id === p.id) main.append(el("p", "The " + p.vendor + " data was updated (" + up.recorded.dataVersion + " → " + p.dataVersion + "). The changes below adopt it.", "fps-warn"));
      const warn = el("div", null, "fps-warn", {role: "note"});
      const uv = unverified(p);
      warn.append(el("strong", "Read from " + p.vendor + "'s pages on " + p.retrieved + ". "), el("span", uv.length + " value" + (uv.length === 1 ? " is" : "s are") + " unverified and use conservative defaults (marked ⚠). Check " + p.vendor + "'s current capabilities before ordering."));
      main.append(warn);
      try { pl = plan(ctx.project, doc, p, {defs: ctx.defs}); } catch (e) { main.append(el("p", e.message, "fps-error")); pl = null; return; }
      // Changes.
      const ch = el("section", null, "fps-section"); ch.append(el("h4", "Changes: " + pl.summary));
      const rt = el("table", null, "fps-table"), rb = el("tbody");
      rt.append(el("thead")); rt.firstChild.append(row(["Rule", "Change", "Value"], "th"));
      const KIND = {added: "Added", changed: "Changed", removed: "Removed", unchanged: "Unchanged"};
      // Rule fields read as words: diameterMin → "min diameter", holePreferred → "preferred hole".
      const fieldName = f => { const w = String(f).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(" "); if (w.length > 1 && /^(min|max|preferred)$/.test(w[w.length - 1])) w.unshift(w.pop()); return w.join(" "); };
      for (const r of pl.rules.rows) {
        const tr = row([r.name, KIND[r.kind] + (r.diff?.length ? ": " + r.diff.map(x => fieldName(x.field) + " " + fmtMM(x.from) + " → " + fmtMM(x.to)).join(", ") : ""), r.text]);
        tr.className = "fps-" + r.kind; rb.append(tr);
      }
      rt.append(rb); ch.append(rt);
      if (pl.stack) {
        ch.append(el("h4", "Layer stack" + (p.stackup?.name ? ": " + p.stackup.name : "")));
        if (!pl.stack.ok) for (const m of pl.stack.problems) ch.append(el("p", m, "fps-error"));
        else if (pl.stack.same) ch.append(el("p", "Unchanged.", "fps-note"));
        else { const ul = el("ul", null, "fps-diff"); for (const c of pl.stack.changes) ul.append(el("li", (c.kind === "changed" && c.from ? c.from + " → " : "") + c.text, "fps-" + c.kind)); ch.append(ul); }
      }
      for (const b of pl.board) ch.append(el("p", b.text, b.level === "error" ? "fps-error" : "fps-note"));
      main.append(ch);
      // Limits with sources.
      const lim = el("section", null, "fps-section"); lim.append(el("h4", "Limits"));
      const lt = el("table", null, "fps-table"), lb = el("tbody");
      for (const [k, label] of LIMIT_ROWS) {
        const x = p.limits[k]; if (x == null) continue;
        const s = sourceOf(p, x), v = val(x);
        const tr = row([label, (k === "acidTrapAngle" ? v + "°" : fmtMM(v)) + (s?.unverified ? " ⚠" : ""), ""]);
        const cell = tr.lastChild;
        if (s?.unverified) cell.textContent = "Unverified: " + s.note;
        else if (s) { cell.textContent = s.quote ? "“" + s.quote + "” " : ""; cell.append(el("span", s.title + ", " + s.retrieved, "fps-src", {title: s.url})); }
        lb.append(tr);
      }
      lt.append(lb); lim.append(lt);
      const outs = p.outputs || {}, ob = el("ul", null, "fps-diff");
      if (outs.gerber) ob.append(el("li", "Gerber: " + val(outs.gerber.format) + (val(outs.gerber.x2) ? " with X2" : ", no X2 attributes") + ", " + val(outs.gerber.units) + ", Protel names (.GTL, .GBL, .GTS…), flat " + val(outs.gerber.zip)));
      if (outs.drill) ob.append(el("li", "Drill: " + val(outs.drill.format) + ", " + val(outs.drill.units) + ", " + outs.drill.files));
      if (outs.bom) ob.append(el("li", "BOM: " + outs.bom.name + " · " + val(outs.bom.columns).join(", ")));
      if (outs.cpl) ob.append(el("li", "CPL: " + outs.cpl.name + " · " + val(outs.cpl.columns).join(", ") + " (" + val(outs.cpl.units) + ", " + val(outs.cpl.rotation) + ")"));
      lim.append(el("h4", "Outputs (File › Release… vendor bundle)"), ob);
      main.append(lim);
      apply_.disabled = !!pl.noop;
      apply_.textContent = pl.noop ? "Applied" : "Apply";
    }
    function row(cells, tag = "td") { const tr = el("tr"); for (const c of cells) tr.append(el(tag, c, null, tag === "th" ? {scope: "col"} : null)); return tr; }
    const paint = () => { paintList(); paintMain(); };
    const apply_ = button("Apply", () => {
      if (!pl || pl.noop) return;
      try {
        let out;
        ctx.edit(() => { out = apply(ctx.project, doc, pl, {defs: ctx.defs}); }, "Apply fab preset " + pl.preset.name);
        ctx.info?.(pl.preset.name + ": " + out.summary + ".");
        ctx.refresh?.(); d.close();
      } catch (e) { status.textContent = e.message; }
    }, "work-primary");
    const actions = el("div", null, "work-actions ui-dialog-actions");
    actions.append(status, button("DFM Check", () => { d.close(); ctx.act?.("dfm-check"); }, "", "Check the board against this preset's manufacturing limits"), button("Cancel", () => d.close()), apply_);
    d.append(head, body, actions);
    apply_.dataset.variant = "primary"; apply_.dataset.uiDefault = "false";
    paint();
    globalThis.AtriumShell.openDialog(d, {title, body, actions, initialFocus: () => side.querySelector("[aria-selected=true]")});
    return d;
  }
  function attach(host) {
    const ctxOf = () => ({project: host.project(), doc: host.doc(), defs: host.defs(), edit: host.edit, info: host.info, act: host.act, refresh: () => host.invalidate?.()});
    host.registerAction("fab-preset", () => loadAll().then(() => open(ctxOf()), e => host.info?.(e.message)));
    // A board whose preset data changed since it was applied: say so once per session.
    const seen = new Set();
    host.on?.("document", () => {
      const doc = host.doc?.();
      if (doc?.kind !== "pcb" || !doc.fabPreset || seen.has(doc.id)) return;
      seen.add(doc.id);
      loadAll().then(() => { const u = update(host.project(), doc, {defs: host.defs()}); if (u?.outdated) host.info?.("New " + u.recorded.vendor + " preset data (" + u.current.dataVersion + "): Design › Fab Preset… shows the changes."); }, () => {});
    });
  }
  globalThis.AtriumNavCommon?.ready?.(attach);
  return Object.freeze({FORMAT, VERSION, VENDORS, define, readData, load, loadAll, vendors, get, list, unverified, sourceOf, limits, plan, apply, update, recordOf,
    outputLayout, releaseSet, profilesFor, ruleRecords, headless, open, attach, val, hash});
})();
