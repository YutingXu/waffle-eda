"use strict";
// Multichannel design: one schematic sheet instantiated several times, each instance a
// channel with its own designators, nets, board footprints and room.
//
// Channels come from the sheet hierarchy (hierarchy.js):
//   - a sheet symbol named Repeat(CH,1,4) (or with symbol.repeat) instantiates its child
//     sheet once per channel, labelled CH1..CH4;
//   - several sheet symbols pointing at one child sheet are one channel each, labelled by
//     the symbol's name (U_AmpL, U_AmpR -> U_AmpL, U_AmpR).
// decorate() runs on the hierarchy's instance list (hierarchy.js calls it) and gives every
// instance inside a channel a suffix (_CH1, _U_AmpL_CH2 when nested), a channelScope (the
// innermost channel's instance id) and a designator(part) function following the project's
// channel naming:
//   project.multichannel = {naming:"suffix"|"index"|"custom", template?, digits?, margin?}
//     suffix  R1 -> R1_CH1, R1_CH2 (default; the hierarchy's own convention)
//     index   R1 -> R101, R201 (prefix, channel index, number padded to `digits`)
//     custom  template with {ref} {prefix} {num} {num0} {gate} {ch} {path} {n} {alpha}
// Net labels inside a channel name per-channel nets in every net identifier scope; ports
// and power ports stay shared (hierarchy.js applies channelScope).
//
// Board side: each channel's footprints are separate board parts linked to the schematic
// part and the sheet instance:
//   part.link = schematicLink + "@" + instanceId, part.sourceLink = schematicLink,
//   part.channel = channelScope (the room's channel)
// syncPlan()/applySync() add missing channel footprints with their nets, update
// designators, values and nets, and create one room per channel (rooms.js).
// replicatePlan()/applyReplicate() copy a reference room's placement and routing to the
// other rooms of the same sheet (Altium's Copy Room Formats), as one edit.
// sheetParts(), ercParts() and netlist() give ECO, ERC, BOM and the netlist the expanded
// channels. Everything except the dialogs is DOM-free and runs headless.
globalThis.AtriumMultichannel = (() => {
  const A = () => globalThis.Atrium, H = () => globalThis.AtriumHierarchy, R = () => globalThis.AtriumRooms;
  const NAMING = {suffix:"Designator then channel (R1_CH1)", index:"Channel index then number (R101, R201)", custom:"Custom template"};
  const natural = new Intl.Collator("en", {numeric:true}).compare;
  const isPart = i => i.kind === "part";
  const plural = (n, one, many = one + "s") => globalThis.AtriumI18n?.plural?.(n, one, many) ?? n + " " + (n === 1 ? one : many);

  // ------------------------------------------------------------------ settings
  function settings(project) {
    const raw = project?.multichannel || {};
    const template = typeof raw.template === "string" && /\{(ref|num|num0)\}/.test(raw.template) ? raw.template : "{ref}_{path}";
    return {naming:Object.hasOwn(NAMING, raw.naming) ? raw.naming : "suffix", template,
      digits:Number.isInteger(raw.digits) && raw.digits >= 1 && raw.digits <= 4 ? raw.digits : 2,
      margin:typeof raw.margin === "number" && raw.margin >= 0 && raw.margin <= 50 ? raw.margin : 1};
  }
  // lenient: a file from a newer version (model.js): an unknown naming scheme is kept as written and
  // channels are named with the default (settings()) until that version opens the file again.
  function validate(v, lenient) {
    const bad = () => {throw Error("This file is not a supported Waffle project.");};
    if (!v || typeof v !== "object" || Array.isArray(v)) bad();
    if (v.naming != null && !Object.hasOwn(NAMING, v.naming) && !(lenient && typeof v.naming === "string" && v.naming.length <= 64)) bad();
    if (v.template != null && (typeof v.template !== "string" || v.template.length > 80 || !/\{(ref|num|num0)\}/.test(v.template))) bad();
    if (v.digits != null && !(Number.isInteger(v.digits) && v.digits >= 1 && v.digits <= 4)) bad();
    if (v.margin != null && !(typeof v.margin === "number" && v.margin >= 0 && v.margin <= 50)) bad();
    return v;
  }
  // The stored form keeps only what differs from the defaults.
  function store(project, value) {
    const s = {...settings({multichannel:value})}, was = project.multichannel && typeof project.multichannel === "object" ? project.multichannel : {};
    // Settings a newer Waffle stored (other keys, a naming scheme this build doesn't know) stay as they are.
    const out = Object.fromEntries(Object.entries(was).filter(([k]) => !["naming", "template", "digits", "margin"].includes(k)));
    if (typeof was.naming === "string" && !Object.hasOwn(NAMING, was.naming) && (value?.naming == null || value.naming === was.naming || value.naming === settings(project).naming)) { out.naming = was.naming; if (was.template != null) out.template = was.template; }
    else if (s.naming !== "suffix") out.naming = s.naming;
    if (s.naming === "custom" && out.naming === "custom") out.template = s.template;
    if (s.digits !== 2) out.digits = s.digits;
    if (s.margin !== 1) out.margin = s.margin;
    if (Object.keys(out).length) project.multichannel = out; else delete project.multichannel;
    return out;
  }

  // ------------------------------------------------------------------ naming
  const clean = s => String(s || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  function alpha(n) {let s = ""; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s;}
  function designator(cfg, ref, inst) {
    ref = String(ref ?? "");
    if (!inst?.suffix) return ref;
    const m = /^([A-Za-z_]*?)(\d+)([A-Za-z]*)$/.exec(ref);
    if (!m || cfg.naming === "suffix") return ref + inst.suffix;
    const n = inst.ordinal || 1, num = m[2], num0 = num.padStart(cfg.digits, "0");
    if (cfg.naming === "index") return m[1] + n + num0 + m[3];
    const tokens = {ref, prefix:m[1], num, num0, gate:m[3], ch:inst.channelLabel || "", path:inst.suffix.slice(1), n:String(n), alpha:alpha(n)};
    return cfg.template.replace(/\{(\w+)\}/g, (x, k) => tokens[k] ?? x);
  }
  // Called by AtriumHierarchy.instances on its preorder instance list (parents first).
  function decorate(project, insts) {
    if (!Array.isArray(insts) || insts.mcDecorated) return insts;
    const cfg = settings(project), byDoc = new Map();
    for (const i of insts) {if (!byDoc.has(i.doc.id)) byDoc.set(i.doc.id, []); byDoc.get(i.doc.id).push(i);}
    for (const list of byDoc.values()) {
      // Several sheet symbols on one child sheet: each symbol is a channel.
      const symbols = new Set(list.map(i => i.symbol?.id).filter(Boolean));
      if (symbols.size > 1) {
        const used = new Set();
        list.forEach((i, k) => {
          if (i.channel || !i.symbol) return;
          let label = clean(i.symbol.name) || "CH" + (k + 1);
          if (used.has(label)) {let n = 2; while (used.has(label + "_" + n)) n++; label += "_" + n;}
          used.add(label); i.mcLabel = label;
        });
      }
      list.forEach((i, k) => {i.ordinal = k + 1;});
    }
    for (const i of insts) {
      const own = i.channel ? i.channel.label : i.mcLabel || "";
      i.channelLabel = own || null;
      i.suffix = (i.parent?.suffix || "") + (own ? "_" + own : "");
      i.channelScope = own ? i.id : i.parent?.channelScope || "";
      i.designator = i.suffix ? part => designator(cfg, part.ref, i) : null;
    }
    Object.defineProperty(insts, "mcDecorated", {value:true});
    return insts;
  }
  function instances(project) {
    const r = H().instances(project);
    decorate(project, r.instances);
    return r;
  }
  const hasChannels = insts => insts.some(i => i.suffix);
  const chLink = (link, inst) => link && inst?.suffix ? link + "@" + inst.id : link;
  const baseLink = link => typeof link === "string" ? link.split("@")[0] : link;
  // Channels: instances that are themselves a channel (Repeat or a shared child sheet).
  function channels(project, insts = instances(project).instances) {
    decorate(project, insts);
    return insts.filter(i => i.channelLabel).map(i => ({id:i.id, label:i.suffix.slice(1), sheet:i.doc.id, sheetName:i.doc.name,
      ordinal:i.ordinal, symbol:i.symbol?.name || "", instance:i}));
  }

  // ------------------------------------------------------------------ expanded parts
  // A view of a schematic part as one channel's component: ref and link are the channel's,
  // every other field reads and writes the schematic part.
  function virtual(part, inst) {
    if (!inst?.suffix) return part;
    const ref = inst.designator(part), link = chLink(part.link, inst);
    return new Proxy(part, {
      get(t, k) {return k === "ref" ? ref : k === "link" ? link : k === "mcInstance" ? inst : k === "mcSource" ? t : k === "channel" ? inst.channelScope : t[k];},
      set(t, k, v) {if (k !== "ref" && k !== "link") t[k] = v; return true;}
    });
  }
  // The parts of one sheet across all its instances, or null when the sheet is not part
  // of a channel (callers then use the sheet's own parts).
  function sheetParts(project, sheet, hier) {
    const all = decorate(project, hier?.instances || H()?.instances(project).instances || []);
    const insts = all.filter(i => i.doc === sheet || i.doc.id === sheet.id);
    if (!insts.some(i => i.suffix)) return null;
    const parts = sheet.items.filter(isPart), out = [];
    for (const inst of insts) for (const p of parts) out.push(virtual(p, inst));
    return out;
  }
  function ercParts(project, sheets, cached = false) {
    if (!H()) return null;
    const all = (cached ? H().instancesCached(project) : instances(project)).instances;
    if (!hasChannels(all)) return null;
    return sheets.flatMap(s => (sheetParts(project, s, {instances:all}) || s.items.filter(isPart)).map(i => ({i, doc:s})));
  }
  // JSON netlist over every channel (the format of AtriumAPI's netlist, plus channel).
  function netlist(project, defs = new Map(project.library.map(d => [d.id, d]))) {
    if (!H() || !hasChannels(instances(project).instances)) return null;
    const hier = H().compile(project, {defs}), insts = decorate(project, hier.instances);
    const comps = [], nets = new Map();
    for (const inst of insts) {
      const map = hier.byInstance.get(inst.id);
      for (const item of inst.doc.items) {
        if (!isPart(item)) continue;
        const v = virtual(item, inst), def = defs.get(item.def);
        const pins = (A().geometries(def, "schematic")?.pins || []).filter(pin => !pin.hidden || pin.net);
        const rows = pins.map(pin => {
          const net = map?.byPin.get(item.id + "/" + pin.number) || pin.net || "NC_" + v.ref + "_" + pin.number;
          if (!nets.has(net)) nets.set(net, []);
          nets.get(net).push(v.ref + "." + pin.number);
          return {number:String(pin.number), name:pin.name || "", net, ...(typeof pin.fn === "string" && pin.fn ? {fn:pin.fn} : {}), ...(pin.part ? {unit:pin.part} : {})};
        }).sort((a, b) => natural(a.number, b.number));
        comps.push({id:item.id, ref:v.ref, value:item.value || "", definition:def?.name || "", footprint:def?.footprint?.name || null, sheet:inst.doc.id,
          channel:inst.suffix ? inst.suffix.slice(1) : null, pins:rows});
      }
    }
    comps.sort((a, b) => natural(a.ref, b.ref));
    return {project:project.name, components:comps, nets:[...nets].map(([name, pins]) => ({name, pins})).sort((a, b) => a.name.localeCompare(b.name))};
  }

  // ------------------------------------------------------------------ board sync
  function bboxOf(points) {return R().bbox(points);}
  // Footprint extent at the origin, unrotated.
  function footprintBox(def) {
    const b = bboxOf(A().itemPoints({kind:"part", x:0, y:0, angle:0}, def, "pcb"));
    return b || [-.5, -.5, .5, .5];
  }
  // Rows of footprints for a channel with no placed reference: returns offsets and size.
  function arrange(entries, defs) {
    const boxes = entries.map(e => footprintBox(defs.get(e.item.def)));
    const area = boxes.reduce((s, b) => s + (b[2] - b[0] + 1) * (b[3] - b[1] + 1), 0), width = Math.max(8, Math.sqrt(area) * 1.6);
    let x = 0, y = 0, row = 0, w = 0;
    const at = [];
    boxes.forEach(b => {
      const bw = b[2] - b[0], bh = b[3] - b[1];
      if (x > 0 && x + bw > width) {x = 0; y += row + 1; row = 0;}
      at.push([x - b[0], y - b[1]]); x += bw + 1; row = Math.max(row, bh); w = Math.max(w, x - 1);
    });
    return {at, size:[w, y + row]};
  }
  // ECO rooms (rooms.js ecoRoom): pack each channel's newly added footprints into its own
  // block, in schematic order so every channel has the same arrangement, with one room per
  // channel. Returns the rooms made, or null when none of the footprints is in a channel.
  function ecoRooms(project, board, ids, bounds, {name, sheet} = {}) {
    if (!H()) return null;
    const insts = instances(project).instances, byId = new Map(insts.map(i => [i.id, i])), want = new Set(ids);
    const groups = new Map(), rest = [];
    for (const p of board.items) {
      if (!isPart(p) || !want.has(p.id)) continue;
      const at = typeof p.link === "string" ? p.link.indexOf("@") : -1, inst = at >= 0 ? byId.get(p.link.slice(at + 1)) : null;
      if (!inst?.channelScope) {rest.push(p); continue;}
      p.channel = inst.channelScope; p.sourceLink = p.link.slice(0, at);
      if (!groups.has(inst.channelScope)) groups.set(inst.channelScope, []);
      groups.get(inst.channelScope).push({item:p, inst});
    }
    if (!groups.size) return null;
    const defs = new Map(project.library.map(d => [d.id, d])), cfg = settings(project), made = [];
    const have = new Set(R().list(board).map(r => r.channel).filter(Boolean));
    const blocks = [...groups].filter(([scope]) => !have.has(scope)).map(([scope, entries]) => {
      const order = new Map();
      for (const e of entries) e.inst.doc.items.filter(isPart).forEach((sp, k) => order.set(e.inst.id + "|" + sp.link, e.inst.order * 1e5 + k));
      entries.sort((a, b) => (order.get(a.inst.id + "|" + a.item.sourceLink) ?? 0) - (order.get(b.inst.id + "|" + b.item.sourceLink) ?? 0));
      return {scope, inst:byId.get(scope), entries, ar:arrange(entries, defs)};
    }).sort((a, b) => (a.inst?.order ?? 0) - (b.inst?.order ?? 0));
    const o = Array.isArray(bounds) && bounds.length === 4 ? [bounds[0], bounds[1]] : [0, 0];
    if (blocks.length) {
      const cols = Math.ceil(Math.sqrt(blocks.length)), cw = Math.max(...blocks.map(b => b.ar.size[0])) + 2 * cfg.margin + 2, ch = Math.max(...blocks.map(b => b.ar.size[1])) + 2 * cfg.margin + 2;
      blocks.forEach((b, k) => {
        const base = [o[0] + cfg.margin + (k % cols) * cw, o[1] + cfg.margin + Math.floor(k / cols) * ch];
        b.entries.forEach((e, n) => {e.item.x = Math.round((base[0] + b.ar.at[n][0]) * 100) / 100; e.item.y = Math.round((base[1] + b.ar.at[n][1]) * 100) / 100;});
        const points = R().around(b.entries.map(e => e.item), defs, cfg.margin);
        if (!points) return;
        const room = R().make({name:R().uniqueName(board, b.inst ? b.inst.suffix.slice(1) : name || "Room"), points, channel:b.scope, sheet:b.inst?.doc.id || sheet});
        (board.rooms ||= []).push(room); made.push(room);
      });
    }
    if (rest.length) {
      const points = R().around(rest, defs, cfg.margin);
      if (points) {const r = R().make({name:R().uniqueName(board, name || "Room"), points, sheet, members:rest.map(p => p.id)}); (board.rooms ||= []).push(r); made.push(r);}
    }
    return made;
  }
  function boardFor(project, boardId) {
    const board = boardId ? project.documents.find(d => d.id === boardId && d.kind === "pcb") : project.documents.find(d => d.kind === "pcb");
    if (!board) throw Error("Choose a board layout from this project.");
    return board;
  }
  function syncPlan(project, boardId, defs = new Map(project.library.map(d => [d.id, d])), opts = {}) {
    if (!H()) throw Error("The sheet hierarchy is not loaded.");
    const board = boardFor(project, boardId), cfg = settings(project);
    const hier = H().compile(project, {defs}), insts = decorate(project, hier.instances);
    const netMoves = new Map();
    const plan = {board:board.id, add:[], update:[], rooms:[], renames:[], issues:[], channels:insts.filter(i => i.channelLabel).length};
    if (!hasChannels(insts)) {plan.issues.push("This project has no channels. Give a sheet symbol a Repeat(CH,1,4) designator, or point several sheet symbols at one sheet."); return plan;}
    const parts = board.items.filter(isPart), byLink = new Map(), claimed = new Set(), expected = new Set();
    for (const p of parts) if (p.link && !byLink.has(p.link)) byLink.set(p.link, p);
    const scopes = new Map(); // channel scope -> {inst, adds:[]}
    const scopeOf = id => insts.find(i => i.id === id);
    for (const inst of insts) {
      if (!inst.suffix) continue;
      const map = hier.byInstance.get(inst.id);
      for (const p of inst.doc.items) {
        if (!isPart(p)) continue;
        const link = chLink(p.link, inst), ref = inst.designator(p);
        if (!p.link) {plan.issues.push(inst.doc.name + " / " + p.ref + " has no component link."); continue;}
        expected.add(link);
        let bp = byLink.get(link);
        // A board laid out before channels existed: its footprints become channel 1.
        if (!bp && inst.ordinal === 1) {const legacy = byLink.get(p.link); if (legacy && !legacy.channel && !claimed.has(legacy.id)) bp = legacy;}
        const def = defs.get(p.def), pads = def?.footprint?.pads || [];
        const nets = {};
        for (const pad of pads) if (pad.number !== "") nets[pad.number] = map?.byPin.get(p.id + "/" + pad.number) || "";
        if (bp) {
          claimed.add(bp.id);
          const set = {};
          if (bp.link !== link) set.link = link;
          if (bp.sourceLink !== p.link) set.sourceLink = p.link;
          if (bp.channel !== inst.channelScope) set.channel = inst.channelScope;
          if (bp.ref !== ref) {if (bp.designatorLocked === true) plan.issues.push(bp.ref + " is locked and keeps its designator (channel name " + ref + ")."); else set.ref = ref;}
          if (p.value != null && bp.value !== p.value) set.value = p.value;
          const pinNets = {...(bp.pinNets || {})};let netChange = false;
          for (const [k, v] of Object.entries(nets)) if (pinNets[k] !== v) {
            if (pinNets[k] && v) {if (!netMoves.has(pinNets[k])) netMoves.set(pinNets[k], new Set()); netMoves.get(pinNets[k]).add(v);}
            pinNets[k] = v; netChange = true;
          }
          if (netChange) set.pinNets = pinNets;
          if (Object.keys(set).length) plan.update.push({id:bp.id, ref:bp.ref, set});
        } else if (!def?.footprint) plan.issues.push(ref + " has no footprint.");
        else {
          const item = {id:A().id(), kind:"part", def:def.id, ref, value:p.value ?? def.value ?? def.name, link, sourceLink:p.link, channel:inst.channelScope, x:0, y:0, angle:0, pinNets:nets};
          const scope = inst.channelScope;
          if (!scopes.has(scope)) scopes.set(scope, {inst:scopeOf(scope), adds:[]});
          scopes.get(scope).adds.push({item, source:p});
          plan.add.push(item);
        }
      }
    }
    for (const p of parts) if ((p.channel || /@/.test(p.link || "")) && !expected.has(p.link) && !claimed.has(p.id))
      plan.issues.push(p.ref + " belongs to a channel that is no longer in the schematic.");
    // Copper on a net that became a channel net follows it (VIN -> VIN_CH1), when the old
    // net is left on no pad and maps to one channel net.
    const updates = new Map(plan.update.map(u => [u.id, u.set])), after = new Map(parts.map(p => [p.id, {...p, ...(updates.get(p.id) || {})}]));
    const padNets = new Set();
    for (const p of [...after.values(), ...plan.add]) for (const v of Object.values(p.pinNets || {})) if (v) padNets.add(v);
    for (const [from, to] of netMoves) if (to.size === 1 && !padNets.has(from)) plan.renames.push({from, to:[...to][0]});
    const members = scope => [...after.values()].filter(p => p.channel === scope);
    const occupied = [];
    if (board.outline?.length) occupied.push(...board.outline);
    for (const i of board.items) {const b = bboxOf(A().itemPoints(i, defs.get(i.def), "pcb")); if (b) occupied.push([b[0], b[1]], [b[2], b[3]]);}
    for (const r of R().list(board)) occupied.push(...r.points);
    const occ = bboxOf(occupied) || [0, 0, 0, 0];
    const fresh = [];
    for (const [scope, s] of scopes) {
      const have = members(scope);
      if (have.length) {
        // Missing parts of a channel already on the board go in a row under it.
        const b = bboxOf(have.flatMap(p => R().partPoints(p, defs.get(p.def))));
        const ar = arrange(s.adds, defs);
        s.adds.forEach((e, k) => {e.item.x = b[0] + ar.at[k][0]; e.item.y = b[3] + 2 + ar.at[k][1];});
        continue;
      }
      // A new channel: a packed block in schematic order, so every channel's block has the
      // same arrangement (Copy Room Formats then lays them out like the reference).
      fresh.push({scope, s, ar:arrange(s.adds, defs)});
    }
    if (fresh.length) {
      const cols = Math.ceil(Math.sqrt(fresh.length)), gap = 2 * cfg.margin + 2;
      // Leave room for a channel laid out like one already on the board (its room, or its
      // parts), so copying that layout later does not make rooms overlap.
      const laid = [0, 0];
      for (const scope of new Set([...after.values()].map(p => p.channel).filter(Boolean))) {
        const room = R().list(board).find(r => r.channel === scope), have = members(scope);
        const b = room ? bboxOf(room.points) : have.length ? bboxOf(have.flatMap(p => R().partPoints(p, defs.get(p.def)))) : null;
        if (b) {laid[0] = Math.max(laid[0], b[2] - b[0] + (room ? 0 : 2 * cfg.margin)); laid[1] = Math.max(laid[1], b[3] - b[1] + (room ? 0 : 2 * cfg.margin));}
      }
      const cw = Math.max(laid[0] + 2, ...fresh.map(f => f.ar.size[0] + gap)), ch = Math.max(laid[1] + 2, ...fresh.map(f => f.ar.size[1] + gap));
      fresh.sort((a, b) => (a.s.inst?.order ?? 0) - (b.s.inst?.order ?? 0));
      fresh.forEach((f, k) => {
        const base = [occ[2] + 6 + (k % cols) * cw, occ[1] + Math.floor(k / cols) * ch];
        f.s.adds.forEach((e, n) => {e.item.x = Math.round((base[0] + f.ar.at[n][0]) * 100) / 100; e.item.y = Math.round((base[1] + f.ar.at[n][1]) * 100) / 100;});
      });
    }
    // One room per channel with components.
    const all = [...after.values(), ...plan.add];
    const roomed = new Set(R().list(board).map(r => r.channel).filter(Boolean));
    for (const inst of insts) {
      if (!inst.channelLabel || roomed.has(inst.id)) continue;
      const mine = all.filter(p => p.channel === inst.id);
      if (!mine.length) continue;
      const points = R().around(mine, defs, cfg.margin);
      plan.rooms.push(R().make({name:inst.suffix.slice(1), points, channel:inst.id, sheet:inst.doc.id}));
    }
    for (const r of R().list(board)) if (r.channel && !insts.some(i => i.id === r.channel)) plan.issues.push("Room " + r.name + " belongs to a channel that is no longer in the schematic.");
    if (opts.renameOnly) {plan.add = []; plan.rooms = []; plan.renames = []; plan.update = plan.update.filter(u => u.set.ref).map(u => ({...u, set:{ref:u.set.ref}}));}
    return plan;
  }
  function applySync(project, plan) {
    const board = project.documents.find(d => d.id === plan.board), byId = new Map(board.items.map(i => [i.id, i]));
    for (const u of plan.update) {const i = byId.get(u.id); if (i) Object.assign(i, A().clone(u.set));}
    for (const i of plan.add) board.items.push(A().clone(i));
    if (plan.rooms.length) {board.rooms ||= []; board.rooms.push(...A().clone(plan.rooms));}
    const renames = new Map((plan.renames || []).map(r => [r.from, r.to]));
    if (renames.size) {
      for (const i of board.items) if (!isPart(i) && renames.has(i.net)) i.net = renames.get(i.net);
      for (const r of board.pcbDrawing?.pours || []) if (renames.has(r.net)) r.net = renames.get(r.net);
    }
    return plan.add.length + plan.update.length + plan.rooms.length + renames.size;
  }
  // Channel designators on the board follow renamed schematic parts (annotate.js calls this
  // inside its edit, after the schematic changes).
  function renameChannels(project, boards = "*") {
    if (!H() || !hasChannels(instances(project).instances)) return 0;
    let n = 0;
    for (const b of project.documents) {
      if (b.kind !== "pcb" || !(boards === "*" || boards === true || boards === b.id || Array.isArray(boards) && boards.includes(b.id))) continue;
      try {n += applySync(project, syncPlan(project, b.id, undefined, {renameOnly:true}));} catch {}
    }
    return n;
  }
  function syncSummary(plan) {
    const parts = [];
    if (plan.add.length) parts.push(plural(plan.add.length, "footprint") + " added");
    if (plan.update.length) parts.push(plural(plan.update.length, "footprint") + " updated");
    if (plan.rooms.length) parts.push(plural(plan.rooms.length, "room") + " created");
    if (plan.renames?.length) parts.push(plural(plan.renames.length, "net") + " renamed on copper");
    return (parts.join(", ") || "Board already matches the channels") + (plan.issues.length ? " · " + plural(plan.issues.length, "issue") : "") + ".";
  }

  // ------------------------------------------------------------------ copy room formats
  const COPY_FIELDS = ["designator", "refAt", "valueAt", "showRef", "showValue"];
  const keyOf = p => p.sourceLink || baseLink(p.link) || p.id;
  function findRoom(rooms, key) {
    if (key == null) return null;
    const k = String(key), lower = k.toLowerCase();
    return rooms.find(r => r.id === k) || rooms.find(r => r.name === k) || rooms.find(r => r.name.toLowerCase() === lower) || rooms.find(r => r.channel === k) || null;
  }
  // The room with the most copper among the given rooms: the likely reference.
  function referenceGuess(board, rooms) {
    let best = rooms[0] || null, n = -1;
    for (const r of rooms) {const c = R().copperIn(board, r).length * 1000 + R().members(board, r).length; if (c > n) {n = c; best = r;}}
    return best;
  }
  function replicatePlan(project, boardId, defs = new Map(project.library.map(d => [d.id, d])), o = {}) {
    const board = boardFor(project, boardId), rooms = R().list(board);
    if (!rooms.length) throw Error("This board has no rooms. Update the board from the channels first.");
    const ref = o.reference != null ? findRoom(rooms, o.reference) : referenceGuess(board, rooms.filter(r => r.sheet));
    if (!ref) throw Error("There is no room " + o.reference + ". Rooms: " + rooms.map(r => r.name).join(", ") + ".");
    const opt = {routing:o.routing !== false, replaceRouting:o.replaceRouting !== false, skipLocked:o.skipLocked !== false, copyShape:o.copyShape !== false};
    let targets;
    if (o.targets?.length) targets = o.targets.map(t => findRoom(rooms, t) || (() => {throw Error("There is no room " + t + ".");})());
    else targets = rooms.filter(r => r !== ref && ref.sheet && r.sheet === ref.sheet);
    targets = targets.filter(t => t !== ref);
    if (!targets.length) throw Error("No other room shows the same sheet as " + ref.name + ".");
    const refParts = R().members(board, ref);
    if (!refParts.length) throw Error("Room " + ref.name + " has no components.");
    const o0 = R().origin(ref), refByKey = new Map(refParts.map(p => [keyOf(p), p]));
    const baseDef = id => defs.get(id)?.mirrorOf || id;
    // Nets of the reference: a net whose pads are all in the reference room is channel-local.
    const refIds = new Set(refParts.map(p => p.id)), outside = new Set();
    for (const p of board.items) if (isPart(p) && !refIds.has(p.id)) for (const n of Object.values(p.pinNets || {})) if (n) outside.add(n);
    const refCopper = opt.routing ? R().copperIn(board, ref) : [];
    const crossing = opt.routing ? board.items.filter(i => (i.kind === "track" || i.kind === "polygon") && !refCopper.includes(i) &&
      R().itemPoints(i).some(p => R().inside(ref, p)) && i.net && !outside.has(i.net)) : [];
    const plan = {board:board.id, reference:ref.id, referenceName:ref.name, options:opt, moves:[], remove:[], add:[], shapes:[], rooms:[]};
    for (const t of targets) {
      const rep = {room:t.id, name:t.name, placed:0, locked:[], unmatched:[], extra:[], footprints:[], tracks:0, vias:0, polygons:0, removed:0,
        unmappedNets:[], conflicts:[], crossing:crossing.length, skipped:null};
      plan.rooms.push(rep);
      if (t.locked && opt.skipLocked) {rep.skipped = "Room " + t.name + " is locked."; continue;}
      const o1 = R().origin(t), dx = o1[0] - o0[0], dy = o1[1] - o0[1];
      const tParts = R().members(board, t), tByKey = new Map(tParts.map(p => [keyOf(p), p])), mates = [];
      for (const rp of refParts) {
        const tp = tByKey.get(keyOf(rp));
        if (!tp) {rep.unmatched.push(rp.ref); continue;}
        mates.push([rp, tp]);
        if (opt.skipLocked && tp.locked === true) {rep.locked.push(tp.ref); continue;}
        const set = {x:rp.x + dx, y:rp.y + dy, angle:rp.angle || 0}, unset = [];
        if (baseDef(rp.def) === baseDef(tp.def)) {set.def = rp.def; if (rp.layer != null) set.layer = rp.layer; else unset.push("layer");}
        else rep.footprints.push(tp.ref);
        for (const k of COPY_FIELDS) if (rp[k] !== undefined) set[k] = A().clone(rp[k]); else if (tp[k] !== undefined) unset.push(k);
        plan.moves.push({id:tp.id, set, unset}); rep.placed++;
      }
      const matched = new Set(mates.map(m => m[1].id));
      for (const tp of tParts) if (!matched.has(tp.id)) rep.extra.push(tp.ref);
      if (opt.copyShape) plan.shapes.push({id:t.id, points:ref.points.map(([x, y]) => [x + dx, y + dy])});
      if (!opt.routing) continue;
      // Reference net -> target net, from the pads of matched parts.
      const netMap = new Map();
      for (const [rp, tp] of mates) for (const [pad, net] of Object.entries(rp.pinNets || {})) {
        if (!net) continue;
        if (!netMap.has(net)) netMap.set(net, new Set());
        const tn = tp.pinNets?.[pad]; if (tn) netMap.get(net).add(tn);
      }
      const unmapped = new Set(), conflicts = new Set();
      const resolve = net => {
        if (!net) return net ?? null;
        const s = netMap.get(net);
        if (s?.size === 1) return [...s][0];
        if (s?.size > 1) {conflicts.add(net + " → " + [...s].join(" / ")); return undefined;}
        if (outside.has(net)) return net; // shared or global net (GND, VDD)
        unmapped.add(net); return undefined;
      };
      if (opt.replaceRouting) for (const i of R().copperIn(board, t)) {
        if (opt.skipLocked && i.locked === true) continue;
        plan.remove.push(i.id); rep.removed++;
      }
      for (const i of refCopper) {
        const net = resolve(i.net);
        if (net === undefined) continue;
        const copy = A().clone(i);
        copy.id = A().id(); delete copy.locked;
        if (i.net != null) copy.net = net;
        A().moveItem(copy, dx, dy);
        plan.add.push(copy);
        if (i.kind === "track") rep.tracks++; else if (i.kind === "via") rep.vias++; else rep.polygons++;
      }
      rep.unmappedNets = [...unmapped].sort(natural); rep.conflicts = [...conflicts].sort(natural);
    }
    plan.totals = {rooms:plan.rooms.filter(r => !r.skipped).length, placed:plan.rooms.reduce((n, r) => n + r.placed, 0), copper:plan.add.length, removed:plan.remove.length,
      problems:plan.rooms.reduce((n, r) => n + r.unmatched.length + r.locked.length + r.unmappedNets.length + r.conflicts.length + r.footprints.length + (r.skipped ? 1 : 0), 0)};
    return plan;
  }
  function applyReplicate(project, plan, defs = new Map(project.library.map(d => [d.id, d]))) {
    const board = project.documents.find(d => d.id === plan.board), byId = new Map(board.items.map(i => [i.id, i]));
    for (const m of plan.moves) {const i = byId.get(m.id); if (!i) continue; Object.assign(i, A().clone(m.set)); for (const k of m.unset) delete i[k];}
    const gone = new Set(plan.remove);
    if (gone.size) {
      for (let k = board.items.length - 1; k >= 0; k--) if (gone.has(board.items[k].id)) board.items.splice(k, 1);
      const pours = board.pcbDrawing?.pours;
      if (Array.isArray(pours)) {const kept = pours.filter(r => !gone.has(r.polygon)); if (kept.length) board.pcbDrawing.pours = kept; else delete board.pcbDrawing.pours;}
    }
    for (const i of plan.add) board.items.push(A().clone(i));
    const rooms = new Map(R().list(board).map(r => [r.id, r]));
    for (const s of plan.shapes) {const r = rooms.get(s.id); if (r) r.points = s.points.map(p => [...p]);}
    const polys = plan.add.filter(i => i.kind === "polygon").map(i => i.id);
    if (polys.length) R().repour(board, defs, polys);
    return plan.moves.length + plan.add.length + plan.remove.length;
  }
  function replicateSummary(plan) {
    const t = plan.totals;
    return "Copied " + plan.referenceName + " to " + plural(t.rooms, "room") + ": " + plural(t.placed, "component") + " placed" +
      (plan.options.routing ? ", " + plural(t.copper, "copper object") + " copied" + (t.removed ? ", " + t.removed + " replaced" : "") : "") +
      (t.problems ? " · " + plural(t.problems, "item") + " could not be mapped" : "") + ".";
  }
  // Plain-text lines of what could not be mapped, per room.
  function replicateIssues(plan) {
    const out = [];
    for (const r of plan.rooms) {
      if (r.skipped) {out.push(r.skipped); continue;}
      if (r.unmatched.length) out.push(r.name + ": no counterpart for " + r.unmatched.join(", "));
      if (r.locked.length) out.push(r.name + ": locked, left in place: " + r.locked.join(", "));
      if (r.footprints.length) out.push(r.name + ": different footprint, position only: " + r.footprints.join(", "));
      if (r.extra.length) out.push(r.name + ": not in the reference room: " + r.extra.join(", "));
      if (r.unmappedNets.length) out.push(r.name + ": nets with no counterpart (copper not copied): " + r.unmappedNets.join(", "));
      if (r.conflicts.length) out.push(r.name + ": nets that map to more than one net (copper not copied): " + r.conflicts.join("; "));
    }
    const crossing = plan.rooms[0]?.crossing || 0;
    if (crossing) out.push(plural(crossing, "track") + " leave the reference room and were not copied.");
    return out;
  }

  // ------------------------------------------------------------------ dialogs
  let HOST = null;
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function button(parent, text, fn, primary) {const b = el("button", text); b.type = "button"; b.onclick = fn; if (primary) b.classList.add("is-primary"); parent.append(b); return b;}
  // The dialogs' stylesheet loads with the first dialog, not at startup.
  function stylesheet() {
    if (document.querySelector('link[href="schematic/multichannel.css"]')) return;
    const l = el("link"); l.rel = "stylesheet"; l.href = "schematic/multichannel.css"; document.head.append(l);
  }
  function dialog(title, cls) {
    stylesheet();
    document.querySelectorAll("dialog.mc-dialog").forEach(d => d.close());
    const d = el("dialog", null, "work-dialog mc-dialog " + (cls || "")), h = el("h2", title);
    h.id = "mc-title-" + A().id(); d.setAttribute("aria-labelledby", h.id); d.append(h);
    document.body.append(d); d.addEventListener("close", () => d.remove(), {once:true});
    return d;
  }
  function check(parent, text, on, disabled) {
    const l = el("label", null, "mc-check"), c = el("input"); c.type = "checkbox"; c.checked = !!on; c.disabled = !!disabled;
    l.append(c, el("span", text)); parent.append(l); return c;
  }
  const boardOf = () => {
    const h = HOST, p = h.project(), d = h.doc();
    return d.kind === "pcb" ? d : globalThis.Atrium?.preferredDocument?.(p, "pcb", h.currentId?.()) || p.documents.find(x => x.kind === "pcb") || null;
  };
  function runSync() {
    const h = HOST, p = h.project(), board = boardOf();
    if (!board) {h.info("Add a board layout first."); return null;}
    let plan;
    try {plan = syncPlan(p, board.id, h.defs());} catch (e) {h.info(e.message); return null;}
    if (!plan.channels) {h.info(plan.issues[0]); return plan;}
    if (plan.add.length || plan.update.length || plan.rooms.length || plan.renames.length) {
      if (h.doc().id !== board.id) h.selectDocument(board.id);
      h.edit(() => applySync(h.project(), plan));
    }
    h.info(syncSummary(plan) + (plan.issues.length ? " " + plan.issues[0] : ""));
    return plan;
  }
  function openManager() {
    const h = HOST, p = h.project(), d = dialog("Multichannel");
    const cfg = settings(p), state = {...cfg};
    const form = el("div", null, "work-form mc-form");
    const naming = el("select"); naming.setAttribute("aria-label", "Channel naming");
    for (const [k, t] of Object.entries(NAMING)) naming.add(new Option(t, k));
    naming.value = cfg.naming;
    const template = el("input"); template.value = cfg.template; template.spellcheck = false; template.setAttribute("aria-label", "Naming template");
    const digits = el("select"); for (const n of [1, 2, 3, 4]) digits.add(new Option(n + " digit" + (n > 1 ? "s" : ""), n)); digits.value = String(cfg.digits);
    const lab = (t, n) => {const l = el("label"); l.append(el("span", t), n); form.append(l); return l;};
    lab("Channel naming", naming); const tRow = lab("Template", template), dRow = lab("Number width", digits);
    const preview = el("p", null, "work-note mc-preview");
    d.append(form, el("p", "Tokens: {ref} {prefix} {num} {num0} {gate} {ch} {path} {n} {alpha}. Net labels inside a channel are local to it; ports and power ports are shared.", "work-note"), preview);
    const table = el("div", null, "mc-table"); d.append(table);
    const status = el("p", null, "work-note"); status.setAttribute("role", "status"); d.append(status);
    function current() {return {...h.project(), multichannel:{naming:state.naming, template:state.template, digits:state.digits}};}
    function paint() {
      tRow.hidden = state.naming !== "custom"; dRow.hidden = state.naming !== "index";
      let list = [], insts = [];
      const cp = current();
      try {insts = decorate(cp, H().instances(cp).instances); list = channels(cp, insts);} catch (e) {status.textContent = e.message;}
      const first = insts.find(i => i.suffix && i.doc.items.some(isPart));
      const sample = first ? first.doc.items.find(isPart) : null;
      preview.textContent = sample ? sample.ref + " → " + insts.filter(i => i.doc === first.doc).slice(0, 4).map(i => i.designator(sample)).join(", ") + (insts.filter(i => i.doc === first.doc).length > 4 ? ", …" : "") : "No channels yet.";
      table.replaceChildren();
      const board = boardOf();
      if (!list.length) {table.append(el("p", "This project has no channels. Give a sheet symbol a Repeat(CH,1,4) designator, or point several sheet symbols at one sheet.", "work-note")); return;}
      const head = el("div", null, "mc-row mc-head"); for (const t of ["Channel", "Sheet", "Parts", "On board", "Room"]) head.append(el("span", t)); table.append(head);
      for (const c of list) {
        const row = el("div", null, "mc-row"), parts = insts.filter(i => i.channelScope === c.id).reduce((n, i) => n + i.doc.items.filter(isPart).length, 0);
        const placed = board ? board.items.filter(i => isPart(i) && i.channel === c.id).length : 0, room = board ? R().list(board).find(r => r.channel === c.id) : null;
        row.append(el("span", c.label), el("span", c.sheetName), el("span", String(parts)), el("span", board ? placed + " / " + parts : "—"), el("span", room ? room.name : "—"));
        table.append(row);
      }
    }
    naming.onchange = () => {state.naming = naming.value; paint();};
    template.oninput = () => {if (/\{(ref|num|num0)\}/.test(template.value)) {state.template = template.value; paint();}};
    digits.onchange = () => {state.digits = +digits.value; paint();};
    const actions = el("div", null, "work-actions");
    button(actions, "Close", () => d.close());
    button(actions, "Apply naming", () => {
      h.edit(() => {store(h.project(), state); renameChannels(h.project(), "*");});
      status.textContent = "Channel naming saved; board designators follow it."; paint();
    });
    button(actions, "Update Board from Channels", () => {
      if (JSON.stringify(settings(h.project())) !== JSON.stringify({...settings(h.project()), ...state})) h.edit(() => store(h.project(), state));
      const plan = runSync(); if (plan) {status.textContent = syncSummary(plan) + (plan.issues.length ? " " + plan.issues.slice(0, 3).join(" ") : ""); paint();}
    }, true);
    d.append(actions);
    globalThis.AtriumShell?.adoptDialog?.(d, {title:d.firstElementChild, body:[form,preview,table,status], actions});
    paint(); d.showModal();
  }
  function openReplicate() {
    const h = HOST, board = boardOf();
    if (!board) {h.info("Add a board layout first."); return;}
    if (h.doc().id !== board.id) h.selectDocument(board.id);
    const rooms = R().list(board);
    if (!rooms.length) {h.info("This board has no rooms. Use Design → Update Board from Channels to create channel rooms."); return;}
    const d = dialog("Copy Room Formats", "mc-replicate");
    const sel = new Set(h.selection()), picked = rooms.find(r => R().members(board, r).some(p => sel.has(p.id)));
    const form = el("div", null, "work-form mc-form"), refSel = el("select"); refSel.setAttribute("aria-label", "Reference room");
    for (const r of rooms) refSel.add(new Option(r.name + " (" + R().members(board, r).length + " parts, " + R().copperIn(board, r).length + " copper)", r.id));
    refSel.value = (picked || referenceGuess(board, rooms.filter(r => r.sheet)) || rooms[0]).id;
    const l = el("label"); l.append(el("span", "Reference room"), refSel); form.append(l); d.append(form);
    const targetsBox = el("fieldset", null, "mc-targets"); targetsBox.append(el("legend", "Apply to")); d.append(targetsBox);
    const opts = el("fieldset", null, "mc-options"); opts.append(el("legend", "Copy"));
    check(opts, "Component placement (relative to the room origin)", true, true);
    const routing = check(opts, "Routing: tracks, vias and polygon pours", true);
    const replace = check(opts, "Replace existing routing in the target rooms", true);
    const locked = check(opts, "Skip locked rooms, components and copper", true);
    const shape = check(opts, "Room shape", true);
    d.append(opts);
    const report = el("div", null, "mc-report"); report.setAttribute("role", "status"); d.append(report);
    let boxes = [];
    function targets() {
      targetsBox.querySelectorAll("label").forEach(n => n.remove()); boxes = [];
      const ref = rooms.find(r => r.id === refSel.value);
      for (const r of rooms) {
        if (r === ref) continue;
        const same = ref.sheet && r.sheet === ref.sheet, c = check(targetsBox, r.name + (r.locked ? " (locked)" : "") + (same ? "" : " · another sheet"), same);
        c.dataset.room = r.id; boxes.push(c);
      }
      if (!boxes.length) targetsBox.append(el("label", "No other rooms."));
    }
    const options = () => ({reference:refSel.value, targets:boxes.filter(b => b.checked).map(b => b.dataset.room), routing:routing.checked,
      replaceRouting:replace.checked, skipLocked:locked.checked, copyShape:shape.checked});
    function show(plan, done) {
      report.replaceChildren(el("p", (done ? "" : "Preview: ") + replicateSummary(plan)));
      const issues = replicateIssues(plan);
      if (issues.length) {const ul = el("ul"); for (const t of issues) ul.append(el("li", t)); report.append(ul);}
    }
    function plan() {
      const o = options(); if (!o.targets.length) {report.replaceChildren(el("p", "Choose at least one target room.")); return null;}
      try {return replicatePlan(h.project(), board.id, h.defs(), o);} catch (e) {report.replaceChildren(el("p", e.message)); return null;}
    }
    refSel.onchange = () => {targets(); report.replaceChildren();};
    const actions = el("div", null, "work-actions");
    button(actions, "Close", () => d.close());
    button(actions, "Preview", () => {const p = plan(); if (p) show(p, false);});
    button(actions, "Apply", () => {
      const p = plan(); if (!p) return;
      h.edit(() => applyReplicate(h.project(), p, h.defs()));
      show(p, true); h.info(replicateSummary(p));
    }, true);
    d.append(actions);
    globalThis.AtriumShell?.adoptDialog?.(d, {title:d.firstElementChild, body:[form,targetsBox,opts,report], actions});
    targets(); d.showModal();
  }
  const ACTIONS = {"multichannel":() => openManager(), "mc-sync":() => runSync(), "room-replicate":() => openReplicate()};
  let installed = false;
  function install(host) {
    HOST = host;
    for (const [a, f] of Object.entries(ACTIONS)) host.registerAction(a, () => {try {f();} catch (e) {host.info(e.message);}});
    if (installed) return;
    installed = true;
    const NC = globalThis.AtriumNavCommon;
    if (NC?.menuItem) {
      NC.menuItem("project", "multichannel", "Multichannel…", {after:"blocks"});
      NC.menuItem("design", "mc-sync", "Update Board from Channels", {separator:true});
      NC.menuItem("design", "room-replicate", "Rooms: Copy Room Formats…", {after:"mc-sync", scope:"pcb"});
    }
    const K = globalThis.AtriumKeymap;
    if (K?.registerCommand) for (const [id, title, cat, key, when] of [["multichannel", "Multichannel…", "Project", null, ""],
      ["mc-sync", "Update board from channels", "Design", "D M U", ""], ["room-replicate", "Copy room formats (replicate layout)…", "Design", "D M C", "pcb"]])
      try {K.registerCommand({id:"multichannel:" + id, title, category:cat, when, action:id, defaultKeys:key ? [key] : []});} catch {}
  }
  const boot = () => globalThis.AtriumNavCommon?.ready?.(install);
  if (globalThis.AtriumNavCommon) boot(); else if (globalThis.document?.addEventListener) document.addEventListener("DOMContentLoaded", boot, {once:true});

  return {NAMING, settings, validate, store, designator, decorate, instances, channels, chLink, baseLink, virtual, sheetParts, ercParts, netlist,
    ecoRooms, syncPlan, applySync, renameChannels, syncSummary, replicatePlan, applyReplicate, replicateSummary, replicateIssues, install};
})();
