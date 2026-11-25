"use strict";
// Fabrication capability profiles and pre-defined rule sets (Design › Fab Profiles…).
//
// A profile describes what a board house can build: minimum track and space,
// drill and annular ring, aspect ratio, solder mask and silkscreen limits,
// thickness and copper options, blind/buried/microvia, via-in-pad and edge
// clearance. applyProfile() turns it into version 2 rules (rules.js) plus via
// templates (viastack.js); compare() checks the board against it.
//
// THE BUILT-IN VALUES ARE APPROXIMATE. They summarise published capability
// pages and common practice at the time of writing, are rounded, and change
// without notice. Always check the fab's current capabilities before ordering.
//
// User profiles are kept in localStorage ("atrium.fabProfiles.v1") and move
// between machines as .waffle-fab files: {format:"atrium-fab", version:1, profiles:[...]}.
globalThis.AtriumFabProfiles = (() => {
  const EPS = 1e-9, STORE = "atrium.fabProfiles.v1", DASH = " – ";
  const plain = o => o !== null && typeof o === "object" && !Array.isArray(o);
  const finite = v => typeof v === "number" && Number.isFinite(v);
  const round = v => Math.round(v * 1e6) / 1e6 + 0;
  const MIL = .0254;
  const APPROX = "Approximate values. Verify with the fab's current capability page before ordering.";

  // Length fields (mm) and their labels, in display order.
  const LENGTHS = [
    ["track", "Min track width"], ["space", "Min copper spacing"],
    ["viaDrill", "Min via drill"], ["viaDiameter", "Min via diameter"], ["annularRing", "Min annular ring"], ["pthRing", "Min PTH (component) annular ring"],
    ["minHole", "Min hole (any)"], ["maxHole", "Max hole"], ["holeToHole", "Hole to hole"],
    ["microviaDrill", "Min microvia drill"], ["maskExpansion", "Solder mask expansion"], ["maskWeb", "Min solder mask web (dam)"],
    ["silkWidth", "Min silkscreen line"], ["silkHeight", "Min silkscreen text height"], ["silkToPad", "Silkscreen to mask opening"],
    ["edgeClearance", "Copper to board edge"]
  ];
  const FLAGS = [["blind", "Blind vias"], ["buried", "Buried vias"], ["microvia", "Laser microvias"], ["viaInPad", "Via-in-pad (filled and capped)"], ["backdrill", "Back-drilling"]];
  // Rule types a profile writes.
  const TYPES = ["clearance", "width", "viaStyle", "holeSize", "annularRing", "holeToHole", "solderMask", "silkToMask", "silkToSilk"];

  const P = (o) => {
    for (const [k] of LENGTHS) if (finite(o[k])) o[k] = round(o[k]);
    return Object.freeze({approximate:true, builtin:true, maxHole:6.3, microviaAspect:1, blind:false, buried:false, microvia:false, viaInPad:false, backdrill:false, ...o});
  };
  // Profiles of the sourced fab presets (fab-presets.js with app/fab-presets/<vendor>.json, loaded before
  // this file): their limits, with the preset id, data version, read date and sources. PRESET_EXTRAS holds
  // what a preset does not record: the aspect ratio and the option lists the Fab Profiles dialog shows.
  // ALIASES maps retired profile ids to presets, so a board stamped with doc.fabProfile.id keeps resolving.
  const ALIASES = Object.freeze({"jlcpcb-4-6l": "jlcpcb-4l"});
  const PRESET_EXTRAS = {"jlcpcb-2l": {short:"JLC 2L", layers:[1, 2], maxAspect:8, thickness:[.4, .6, .8, 1, 1.2, 1.6, 2], copper:[1, 2]},
    "jlcpcb-4l": {short:"JLC 4L", maxAspect:10, thickness:[.8, 1, 1.2, 1.6, 2], copper:[1, 2], innerCopper:[.5, 1]},
    "jlcpcb-6l": {short:"JLC 6L", maxAspect:10, thickness:[1.6], copper:[1], innerCopper:[.5]}};
  function fromPresets() {
    const FP = globalThis.AtriumFabPresets, out = [];
    for (const [id, x] of Object.entries(PRESET_EXTRAS)) {
      const p = FP?.get?.(id), L = p && FP.limits(p);
      if (!L) continue;
      out.push(P({id, vendor:p.vendor, name:p.name, short:x.short, layers:x.layers || [p.layers, p.layers], track:L.track, space:L.space,
        viaDrill:L.viaDrill, viaDiameter:L.viaDiameter, viaDrillPreferred:L.viaDrillPreferred, viaDiameterPreferred:L.viaDiameterPreferred, annularRing:L.viaRing, pthRing:L.pthRing, minHole:L.minHole, maxHole:L.maxHole, holeToHole:L.holeToHoleVia,
        maxAspect:x.maxAspect, maskExpansion:L.maskExpansion, maskWeb:L.maskWeb, silkWidth:L.silkWidth, silkHeight:L.silkHeight, silkToPad:L.silkToPad,
        edgeClearance:L.edgeClearance, blind:!!L.blind, buried:!!L.buried, microvia:!!L.microvia, viaInPad:!!L.viaInPad, backdrill:!!L.backdrill,
        thickness:x.thickness, copper:x.copper, ...(x.innerCopper ? {innerCopper:x.innerCopper} : {}),
        preset:Object.freeze({id, dataVersion:p.dataVersion, retrieved:p.retrieved, hash:p.hash}), sources:p.sources,
        notes:[p.summary, "From the " + p.vendor + " fab preset " + id + " (data " + p.dataVersion + ", read " + p.retrieved + "); each value's source is in Design › Fab Preset…."].filter(Boolean)}));
    }
    return out;
  }
  const BUILTIN = Object.freeze([
    // JLCPCB: the sourced fab presets (fromPresets above), not a second set of numbers here.
    ...fromPresets(),
    P({id:"pcbway-standard", vendor:"PCBWay", name:"PCBWay Standard", short:"PCBWay Std", layers:[1, 6],
      track:.127, space:.127, viaDrill:.25, viaDiameter:.5, annularRing:.15, minHole:.25, holeToHole:.3, maxAspect:8,
      maskExpansion:.05, maskWeb:.1, silkWidth:.15, silkHeight:.8, silkToPad:.15, edgeClearance:.3,
      thickness:[.4, .6, .8, 1, 1.2, 1.6, 2, 2.4, 3.2], copper:[1, 2, 3], notes:["Standard pricing tier."]}),
    P({id:"pcbway-advanced", vendor:"PCBWay", name:"PCBWay Advanced (HDI)", short:"PCBWay Adv", layers:[4, 20],
      track:.075, space:.075, viaDrill:.15, viaDiameter:.3, annularRing:.075, minHole:.15, holeToHole:.2, maxAspect:12, microviaAspect:.8, microviaDrill:.1,
      maskExpansion:.05, maskWeb:.08, silkWidth:.12, silkHeight:.6, silkToPad:.1, edgeClearance:.25,
      blind:true, buried:true, microvia:true, viaInPad:true, backdrill:true,
      thickness:[.6, .8, 1, 1.2, 1.6, 2, 2.4, 3.2], copper:[.5, 1, 2], notes:["Advanced/HDI process: blind, buried and laser microvias, via-in-pad and back-drilling are quoted separately."]}),
    P({id:"oshpark-2l", vendor:"OSH Park", name:"OSH Park 2-layer", short:"OSHPark 2L", layers:[2, 2],
      track:6 * MIL, space:6 * MIL, viaDrill:10 * MIL, viaDiameter:20 * MIL, annularRing:5 * MIL, minHole:10 * MIL, holeToHole:10 * MIL, maxAspect:6.5,
      maskExpansion:2 * MIL, maskWeb:4 * MIL, silkWidth:6 * MIL, silkHeight:.8, silkToPad:5 * MIL, edgeClearance:15 * MIL,
      thickness:[1.6, .8], copper:[1, 2], notes:["Fixed process: 1.6 mm FR-4, ENIG, purple mask. 0.8 mm and 2 oz are separate services."]}),
    P({id:"oshpark-4l", vendor:"OSH Park", name:"OSH Park 4-layer", short:"OSHPark 4L", layers:[4, 4],
      track:5 * MIL, space:5 * MIL, viaDrill:10 * MIL, viaDiameter:18 * MIL, annularRing:4 * MIL, minHole:10 * MIL, holeToHole:10 * MIL, maxAspect:6.5,
      maskExpansion:2 * MIL, maskWeb:4 * MIL, silkWidth:5 * MIL, silkHeight:.8, silkToPad:5 * MIL, edgeClearance:15 * MIL,
      thickness:[1.6, .8], copper:[1], innerCopper:[.5], notes:["Fixed 4-layer stack, 1 oz outer and 0.5 oz inner copper."]}),
    P({id:"eurocircuits-6", vendor:"Eurocircuits", name:"Eurocircuits Pattern class 6 / drill C", short:"EC 6C", layers:[1, 8],
      track:.15, space:.15, viaDrill:.35, viaDiameter:.6, annularRing:.125, minHole:.35, holeToHole:.25, maxAspect:8,
      maskExpansion:.05, maskWeb:.1, silkWidth:.17, silkHeight:1, silkToPad:.15, edgeClearance:.3,
      thickness:[.8, 1, 1.2, 1.55, 2, 2.4, 3.2], copper:[.5, 1, 2], notes:["Pattern class 6 with drill class C. Classes trade price for finer features."]}),
    P({id:"eurocircuits-8", vendor:"Eurocircuits", name:"Eurocircuits Pattern class 8 / drill D", short:"EC 8D", layers:[1, 16],
      track:.1, space:.1, viaDrill:.25, viaDiameter:.45, annularRing:.1, minHole:.25, holeToHole:.2, maxAspect:10,
      maskExpansion:.05, maskWeb:.08, silkWidth:.15, silkHeight:.8, silkToPad:.1, edgeClearance:.25, viaInPad:true,
      thickness:[.8, 1, 1.2, 1.55, 2, 2.4, 3.2], copper:[.5, 1], notes:["Pattern class 8 with drill class D. Via filling (Type VII) is an option."]}),
    P({id:"ipc-class2", vendor:"Generic", name:"IPC-2221 / IPC-6012 Class 2", short:"IPC C2", layers:[1, 32],
      track:.15, space:.15, viaDrill:.3, viaDiameter:.6, annularRing:.125, minHole:.3, holeToHole:.25, maxAspect:8,
      maskExpansion:.05, maskWeb:.1, silkWidth:.15, silkHeight:1, silkToPad:.15, edgeClearance:.5,
      blind:true, buried:true, microvia:true, viaInPad:true, backdrill:true, microviaDrill:.1,
      thickness:[.8, 1, 1.2, 1.6, 2, 2.4, 3.2], copper:[.5, 1, 2], notes:["Generic dedicated-service electronics. Design values include a fabrication allowance over the IPC-6012 minimums.", "Advanced via types depend on the fab you choose."]}),
    P({id:"ipc-class3", vendor:"Generic", name:"IPC-2221 / IPC-6012 Class 3", short:"IPC C3", layers:[1, 32],
      track:.15, space:.2, viaDrill:.3, viaDiameter:.65, annularRing:.175, minHole:.3, holeToHole:.3, maxAspect:6,
      maskExpansion:.05, maskWeb:.1, silkWidth:.15, silkHeight:1.2, silkToPad:.2, edgeClearance:.6,
      blind:true, buried:true, microvia:true, viaInPad:true, backdrill:true, microviaDrill:.1,
      thickness:[.8, 1, 1.2, 1.6, 2, 2.4, 3.2], copper:[.5, 1, 2], notes:["High-reliability electronics: no annular ring breakout, larger rings and a lower aspect ratio.", "Advanced via types depend on the fab you choose."]})
  ]);

  // ---------------------------------------------------------------- order upload layouts
  // How each board house wants the order files laid out (output job presets use
  // these). {stem} is the fabrication file stem (output-jobs.js: the project name slugified, as File ›
  // Fabrication Outputs names files; {board} is still the board name). Approximate, like the profiles: check
  // the house's current upload instructions.
  //   gerberZip: Gerber and drill files zipped together for the PCB upload
  //   pnp: pick-and-place layout (fab-outputs pnpStyle) and file name
  //   bom: BOM column layout (output-jobs) and file name
  const LAYOUTS = Object.freeze({
    JLCPCB:Object.freeze({vendor:"JLCPCB", gerberZip:"{stem}-Gerber.zip", gerberUnits:"mm", drillUnits:"mm", x2:false /* fab-presets: RS-274X per JLCPCB's Altium guide */, sources:Object.freeze(["https://jlcpcb.com/help/article/pcb-panelization", "https://jlcpcb.com/blog/v-cut-panelization-standards", "https://jlcpcb.com/blog/mouse-bite-panelization-guide", "https://jlcpcb.com/capabilities/pcb-capabilities", "https://jlcpcb.com/help/article/how-to-export-altium-pcb-to-gerber-files", "https://jlcpcb.com/help/article/bill-of-materials-for-pcb-assembly", "https://jlcpcb.com/help/article/pick-place-file-for-pcb-assembly"]), orderNotes:"{stem}-Order-Notes.txt",
      pnp:Object.freeze({style:"jlc", name:"CPL-{stem}.csv"}), bom:Object.freeze({style:"jlc", format:"csv", name:"BOM-{stem}.csv"}),
      notes:Object.freeze(["Upload the Gerber zip for the PCB, then BOM-*.csv and CPL-*.csv for assembly.",
        "BOM columns: Comment, Designator, Footprint, LCSC Part # (from an LCSC/JLC part number parameter).",
        "CPL rotations follow the footprint; check JLC's placement preview."])}),
    PCBWay:Object.freeze({vendor:"PCBWay", gerberZip:"{stem}-Gerber.zip", gerberUnits:"mm", drillUnits:"mm", sources:Object.freeze(["https://www.pcbway.com/capabilities.html"]), orderNotes:"{stem}-Order-Notes.txt",
      pnp:Object.freeze({style:"altium", name:"{stem}-PickPlace.csv"}), bom:Object.freeze({style:"pcbway", format:"csv", name:"{stem}-BOM.csv"}),
      notes:Object.freeze(["Upload the Gerber zip for the PCB; the BOM and pick-and-place files go with the assembly order.",
        "BOM columns follow PCBWay's template: Designator, Qty, Manufacturer, Mfg Part #, Description / Value, Package/Footprint."])})
  });
  // Layout for a profile id, a profile, or a vendor name; null when none is known.
  function outputLayout(id) {
    const p = typeof id === "string" ? (LAYOUTS[id] ? null : get(id)) : id;
    const vendor = typeof id === "string" && LAYOUTS[id] ? id : p?.vendor;
    return vendor && LAYOUTS[vendor] || null;
  }

  // ---------------------------------------------------------------- panelization limits
  // Approximate panel limits per fab, read by the panel check (panel.js). V-score panel size
  // and the 2 mm V-line gap are from JLCPCB's panelization pages; copper-to-V-score clearance is
  // common practice (neither fab publishes one we could confirm) and the PCBWay routing gap is
  // from its capability page. Lengths in mm.
  const PANEL = Object.freeze({
    JLCPCB:Object.freeze({vendor:"JLCPCB", approximate:true, vScoreClearance:.4, vScoreMinPanel:Object.freeze([70, 70]), maxPanel:Object.freeze([475, 475]), vScoreLineGap:2,
      routeGap:1.6, minWeb:.3, biteHole:.6, bitePitch:.95,
      sources:Object.freeze(["https://jlcpcb.com/help/article/pcb-panelization", "https://jlcpcb.com/blog/v-cut-panelization-standards", "https://jlcpcb.com/blog/mouse-bite-panelization-guide"])}),
    PCBWay:Object.freeze({vendor:"PCBWay", approximate:true, vScoreClearance:.5, vScoreMinPanel:Object.freeze([70, 70]), maxPanel:Object.freeze([500, 500]), vScoreLineGap:2,
      routeGap:1.6, minWeb:.3, biteHole:.6, bitePitch:.95, sources:Object.freeze(["https://www.pcbway.com/capabilities.html"])})
  });
  // Panel limits for a profile id, a profile or a vendor name; null when none is known.
  function panelRules(id) {
    if (typeof id === "string" && PANEL[id]) return PANEL[id];
    const p = typeof id === "string" ? get(id) : id;
    return p?.vendor && PANEL[p.vendor] || null;
  }

  // ---------------------------------------------------------------- user profiles
  const storage = () => {try {return globalThis.localStorage || null;} catch {return null;}};
  function cleanProfile(raw) {
    if (!plain(raw)) throw Error("A fab profile must be an object.");
    const name = String(raw.name ?? "").trim();
    if (!name || name.length > 128) throw Error("Each fab profile needs a name of up to 128 characters.");
    const out = {id:typeof raw.id === "string" && /^[\w.-]{1,80}$/.test(raw.id) ? raw.id : "user-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name, vendor:String(raw.vendor || "User").slice(0, 80), short:String(raw.short || name).slice(0, 40), approximate:raw.approximate !== false};
    for (const [k] of LENGTHS) {
      if (raw[k] == null) continue;
      if (!finite(raw[k]) || raw[k] < (k === "maskExpansion" ? -1 : 0) || raw[k] > 100) throw Error(name + ": " + k + " must be a length in millimetres.");
      out[k] = round(raw[k]);
    }
    for (const k of ["track", "space", "viaDrill", "viaDiameter", "annularRing"]) if (!(out[k] > 0)) throw Error(name + ": " + k + " is required.");
    for (const k of ["maxAspect", "microviaAspect"]) if (raw[k] != null) {if (!finite(raw[k]) || raw[k] <= 0 || raw[k] > 50) throw Error(name + ": invalid " + k + "."); out[k] = round(raw[k]);}
    if (!out.maxAspect) out.maxAspect = 8;
    if (!out.microviaAspect) out.microviaAspect = 1;
    for (const [k] of FLAGS) out[k] = raw[k] === true;
    if (Array.isArray(raw.layers) && raw.layers.length === 2 && raw.layers.every(n => Number.isInteger(n) && n >= 1 && n <= 64)) out.layers = [Math.min(...raw.layers), Math.max(...raw.layers)];
    for (const k of ["thickness", "copper", "innerCopper"]) if (Array.isArray(raw[k])) out[k] = raw[k].filter(v => finite(v) && v > 0 && v < 20).slice(0, 32).map(round);
    out.notes = Array.isArray(raw.notes) ? raw.notes.filter(s => typeof s === "string").map(s => s.slice(0, 500)).slice(0, 20) : [];
    return out;
  }
  function userProfiles() {
    const s = storage();
    try {const raw = JSON.parse(s?.getItem(STORE) || "[]"); return Array.isArray(raw) ? raw.map(p => {try {return cleanProfile(p);} catch {return null;}}).filter(Boolean) : [];}
    catch {return [];}
  }
  function writeUser(list) {const s = storage(); try {s?.setItem(STORE, JSON.stringify(list)); return !!s;} catch {return false;}}
  function saveUser(profile) {
    const p = cleanProfile(profile), list = userProfiles().filter(x => x.id !== p.id);
    if (BUILTIN.some(b => b.id === p.id)) p.id = "user-" + p.id;
    list.push(p); writeUser(list);
    return p;
  }
  function removeUser(id) {const list = userProfiles(), next = list.filter(p => p.id !== id); writeUser(next); return next.length !== list.length;}
  const list = () => [...BUILTIN, ...userProfiles().map(p => ({...p, builtin:false}))];
  function get(id) {
    if (plain(id)) return id.builtin ? id : cleanProfile(id);
    if (typeof id === "string" && ALIASES[id]) id = ALIASES[id];
    return list().find(p => p.id === id) || null;
  }
  function exportText(profiles) {return JSON.stringify({format:"atrium-fab", version:1, note:APPROX, profiles:(profiles || userProfiles()).map(p => cleanProfile({...p, builtin:undefined}))}, null, 2);}
  // Parses a .waffle-fab file. Returns the cleaned profiles (not yet saved).
  function importText(text) {
    const raw = typeof text === "string" ? JSON.parse(text) : text;
    if (!plain(raw) || raw.format !== "atrium-fab" || raw.version !== 1 || !Array.isArray(raw.profiles)) throw Error("Choose a .waffle-fab file (format atrium-fab, version 1).");
    if (raw.profiles.length > 200) throw Error("The file holds too many profiles.");
    return raw.profiles.map(p => {const c = cleanProfile(p); if (BUILTIN.some(b => b.id === c.id)) c.id = "user-" + c.id; return c;});
  }

  // ---------------------------------------------------------------- rules from a profile
  const R = () => globalThis.AtriumRules || (() => {throw Error("Design rules are unavailable in this build.");})();
  const prefix = p => p.short || p.name;
  // Rule records (version 2) the profile stands for; priorities are set by the caller.
  function ruleRecords(p) {
    // A preset's profile writes the preset's own rules (AtriumFabPresets.ruleRecords), as Design › Fab Preset… does.
    const FP = globalThis.AtriumFabPresets, pr = p.preset && FP?.get?.(p.preset.id);
    if (pr) return FP.ruleRecords(pr);
    const base = (type, label, props) => {
      const presetKey = "fab-" + p.id + "-" + type;
      return {id:presetKey, presetKey, type, name:(prefix(p) + DASH + label).slice(0, 128), comment:"From fab profile " + p.name + ". " + APPROX,
        enabled:true, priority:1, scope:globalThis.AtriumDesignQueryRecord.selector("all"), ...(R().types[type].two ? {scope2:globalThis.AtriumDesignQueryRecord.selector("all")} : {}), ...props};
    };
    const holeMin = Math.min(...[p.minHole, p.viaDrill, p.microvia ? p.microviaDrill : null].filter(v => v > 0));
    const out = [
      base("clearance", "Clearance", {gap:p.space}),
      base("width", "Width", {min:p.track, preferred:round(Math.max(p.track, .2)), max:null}),
      base("viaStyle", "Routing Vias", {diameterMin:p.microvia && p.microviaDrill ? null : p.viaDiameter, diameterPreferred:round(Math.max(p.viaDiameter, .45)), diameterMax:null,
        holeMin:p.microvia && p.microviaDrill ? p.microviaDrill : p.viaDrill, holePreferred:round(Math.max(p.viaDrill, .2)), holeMax:null}),
      base("holeSize", "Hole Size", {min:holeMin, max:p.maxHole || 6.35}),
      base("annularRing", "Annular Ring", {min:p.annularRing}),
      base("solderMask", "Solder Mask Expansion", {expansion:p.maskExpansion ?? .05})
    ];
    if (p.holeToHole > 0) out.push(base("holeToHole", "Hole To Hole", {gap:p.holeToHole}));
    if (p.silkToPad > 0) out.push(base("silkToMask", "Silk To Mask", {gap:p.silkToPad}));
    if (p.silkWidth > 0) out.push(base("silkToSilk", "Silk To Silk", {gap:round(Math.max(p.silkWidth, .1))}));
    // Rules sort preferred above min; keep the preferred values legal.
    const vs = out.find(r => r.type === "viaStyle");
    if (vs.diameterMin != null && vs.diameterPreferred < vs.diameterMin) vs.diameterPreferred = vs.diameterMin;
    if (vs.holePreferred < vs.holeMin) vs.holePreferred = vs.holeMin;
    return out;
  }
  // Via templates that match a profile.
  function profileTemplates(p) {
    const VS = globalThis.AtriumViaStack, out = [];
    const ring = Math.max(p.annularRing, .1), dia = d => round(Math.ceil((d + 2 * ring) * 200 - 1e-6) / 200);
    // A preset's profile: the standard via is the preset's preferred routing via (its Routing Vias rule), not the minimum.
    const drill = p.viaDrillPreferred > 0 ? p.viaDrillPreferred : p.viaDrill, diameter = round(Math.max(p.viaDiameterPreferred > 0 ? p.viaDiameterPreferred : p.viaDiameter, dia(drill)));
    const std = {id:"fab-" + p.id + "-std", name:prefix(p) + " " + diameter + "/" + drill + " Through", diameter, drill, profile:p.id};
    out.push(std, {...std, id:"fab-" + p.id + "-tented", name:std.name.replace(/ Through$/, " Tented"), ipc4761:"I", ipcSides:"both", tent:{top:true, bottom:true}});
    if (p.viaInPad) {const d = round(Math.max(p.viaDrill, .2)); out.push({id:"fab-" + p.id + "-vip", name:prefix(p) + " VIP " + round(Math.max(p.viaDiameter, dia(d))) + "/" + d + " Filled+Capped", diameter:round(Math.max(p.viaDiameter, dia(d))), drill:d, ipc4761:"VII", viaInPad:true, profile:p.id});}
    if (p.microvia && p.microviaDrill) out.push({id:"fab-" + p.id + "-uvia", name:prefix(p) + " µvia 1-2 " + dia(p.microviaDrill) + "/" + p.microviaDrill, diameter:dia(p.microviaDrill), drill:p.microviaDrill, fromLayer:"Top", toLayer:"Inner 1", microvia:true, ipc4761:"VII", profile:p.id});
    return VS ? out.map(t => VS.cleanTemplate(t)) : out;
  }
  // applyProfile(board, profileOrId, {mode:"replace"|"merge", priority:"lowest"|"highest", project, templates:true})
  //   -> {rules (validated version 2 set), templates, added, removed, notes, profile}
  // replace: every rule of the covered types is removed, the profile rules take over.
  // merge:   rules scoped to nets, classes, pairs or layers stay ahead of the
  //          profile; board-wide rules of the covered types are replaced.
  // Other rule types, net classes and differential pairs are always kept.
  function applyProfile(board, id, o = {}) {
    const p = get(id);
    if (!p) throw Error("Unknown fab profile " + id + ".");
    const mode = o.mode === "merge" ? "merge" : "replace";
    const Rr = R(), key = Rr.presetRuleKey;
    const current = Rr.migrate(o.rules ?? Rr.stored(board, o.project));
    const records = ruleRecords(p), covered = new Set(records.map(r => r.type)), removed = [], kept = [];
    const ours = r => /^(?:fab|fp)-/.test(r.set ? r.id : key(r)) || r.name.includes(DASH) && r.comment?.startsWith("From fab profile");
    for (const r of current.list) {
      const scopes = globalThis.AtriumDesignQueryRecord;
      const drop = covered.has(r.type) && (mode === "replace" || ours(r) || scopes.isAll(r.scope) && (!r.scope2 || scopes.isAll(r.scope2)));
      (drop ? removed : kept).push(r);
    }
    const existing = new Map(removed.filter(r => !r.set && key(r)).map(r => [key(r), r]));
    const names = new Set(kept.map(r => r.name.toLowerCase())), ids = new Set(kept.map(r => r.id));
    const highest = o.priority === "highest";
    const list = [...kept.map(r => ({...r, priority:highest && covered.has(r.type) ? r.priority + 1000 : r.priority}))];
    for (const r of records) {
      let name = r.name, n = 2;
      while (names.has(name.toLowerCase())) name = r.name + " " + n++;
      names.add(name.toLowerCase());
      const previous = existing.get(r.presetKey);
      let rid = previous?.type === r.type ? previous.id : r.id;
      while (ids.has(rid)) rid = r.id + "-" + n++;
      ids.add(rid);
      list.push({...r, id:rid, presetKey:previous?.id === rid ? previous.presetKey : r.presetKey, name,
        priority:(highest ? 1 : 99999) - (r.priority === 0 ? 1 : 0)}); // a preset's narrower rule (priority 0) stays first
    }
    const rules = R().normalize({...current, list});
    R().validate(rules);
    const notes = [APPROX, "Board-outline clearance (" + round(p.edgeClearance || 0) + " mm) is checked by the Board Outline Clearance rule in the starter rule sets (Design › Rule Sets…) and by compare()."];
    if (p.silkWidth) notes.push("Silkscreen minimum line " + round(p.silkWidth) + " mm and text height " + round(p.silkHeight || 0) + " mm are reported by compare(), not by the rule check.");
    return {profile:p, mode, rules, templates:o.templates === false ? [] : profileTemplates(p), added:records.map(r => r.type), removed:removed.map(r => r.name), notes};
  }
  // Stores an applyProfile result on the board: rules, via templates and the
  // profile limits used by the via stack checks (board.fabProfile).
  function install(board, result, project) {
    const rules = R();
    rules.store(board, project, rules.materializePresetRules(result.rules, rules.stored(board, project)));
    const VS = globalThis.AtriumViaStack;
    if (VS && result.templates.length) {
      const lib = VS.library(board, true);
      lib.list = lib.list.filter(t => !String(t.id).startsWith("fab-" + result.profile.id + "-"));
      lib.list.push(...result.templates.map(t => ({...t})));
      if (!lib.defaults.via || !VS.find(board, lib.defaults.via)) lib.defaults.via = result.templates[0].id;
    }
    const p = result.profile;
    board.fabProfile = {id:p.id, name:p.name, approximate:!!p.approximate, maxAspect:p.maxAspect, microviaAspect:p.microviaAspect, viaDrill:p.viaDrill,
      microviaDrill:p.microviaDrill ?? null, annularRing:p.annularRing, edgeClearance:p.edgeClearance ?? null,
      blind:!!p.blind, buried:!!p.buried, microvia:!!p.microvia, viaInPad:!!p.viaInPad, backdrill:!!p.backdrill};
    return board;
  }

  // ---------------------------------------------------------------- comparing a board
  function copperCount(board, defs) {
    try {return globalThis.AtriumStackup ? AtriumStackup.copperLayers(board, defs).length : null;} catch {return null;}
  }
  function thicknessOf(board, defs) {
    try {return globalThis.AtriumStackup ? AtriumStackup.thickness(board, defs) : null;} catch {return null;}
  }
  // Copper closer to the outline than the profile allows. Distance from each
  // copper feature's edge to the nearest outline segment.
  function edgeCheck(board, defs, limit, cap = 200) {
    const out = [], ol = Array.isArray(board?.outline) ? board.outline : [];
    if (!(limit > 0) || ol.length < 3) return out;
    const A = globalThis.Atrium, segs = ol.map((p, i) => [p, ol[(i + 1) % ol.length]]);
    const segDist = (p, q) => {let best = Infinity; for (const [a, b] of segs) {best = Math.min(best, A.nearSegment(p, a, b)); if (q) best = Math.min(best, A.nearSegment(a, p, q), A.nearSegment(b, p, q));} return best;};
    const flag = (id, at, gap, what) => {if (gap + EPS < limit && out.length < cap) out.push({id, at, actual:round(Math.max(0, gap)), required:limit, what});};
    for (const i of board.items || []) {
      if (i.kind === "track" && /^(Top|Bottom|Inner \d+)$/.test(i.layer || "Top") && i.points?.length > 1) {
        let g = Infinity; for (let n = 1; n < i.points.length; n++) g = Math.min(g, segDist(i.points[n - 1], i.points[n]));
        flag(i.id, i.points[0], g - (i.width || 0) / 2, "Track");
      } else if (i.kind === "via" || i.kind === "pad") flag(i.id, [i.x, i.y], segDist([i.x, i.y]) - Math.max(i.diameter || 0, i.w || 0, i.h || 0) / 2, i.kind === "via" ? "Via" : "Pad");
      else if (i.kind === "part") {
        const fp = defs?.get?.(i.def)?.footprint;
        for (const p of fp?.pads || []) {const at = A.world([p.x, p.y], i); flag(i.id, at, segDist(at) - Math.max(p.w || 0, p.h || 0) / 2, "Pad " + (i.ref || "") + "-" + (p.number || ""));}
      }
    }
    return out;
  }
  function silkCheck(board, defs, p) {
    let thin = 0, small = 0;
    const check = s => {if (s.kind === "text" || s.kind === "label") {if ((s.size || .75) + EPS < (p.silkHeight || 0)) small++;} else if (s.width > 0 && s.width + EPS < (p.silkWidth || 0)) thin++;};
    for (const i of board.items || []) {
      if ((i.layer === "Silk" || i.layer === "Bottom silk") && (i.kind === "graphic" || i.kind === "label")) check(i);
      if (i.kind === "part") for (const s of defs?.get?.(i.def)?.footprint?.shapes || []) if (s.style === "silk" || s.layer === "Silk" || s.layer === "Bottom silk") check(s);
    }
    return {thin, small};
  }
  // compare(board, profileOrId, {defs, project, limit}) ->
  //   {profile, rows, capability, drc, viaStack, edge, silk, total}
  function compare(board, id, o = {}) {
    const p = get(id);
    if (!p) throw Error("Unknown fab profile " + id + ".");
    const defs = o.defs || new Map(), q = (type, obj = {}) => {try {return R().query(board, type, obj, {project:o.project});} catch {return null;}};
    const row = (key, label, current, required, kind = "min") => {
      let status = "ok";
      if (current == null) status = "missing";
      else if (kind === "min" && current + EPS < required) status = "looser";
      else if (kind === "equal" && Math.abs(current - required) > 1e-4) status = "differs";
      return {key, label, current:current ?? null, profile:required, status, kind};
    };
    const vs = q("viaStyle", {net:""}) || {};
    const rows = [
      row("space", "Clearance", q("clearance", {net:"", net2:""})?.gap, p.space),
      row("track", "Track width (min)", q("width", {net:""})?.min, p.track),
      row("viaDrill", "Via hole (min)", vs.holeMin, p.microvia && p.microviaDrill ? p.microviaDrill : p.viaDrill),
      row("viaDiameter", "Via diameter (min)", vs.diameterMin, p.microvia && p.microviaDrill ? null : p.viaDiameter),
      row("minHole", "Hole size (min)", q("holeSize", {net:""})?.min, Math.min(...[p.minHole, p.viaDrill, p.microvia ? p.microviaDrill : null].filter(v => v > 0))),
      row("annularRing", "Annular ring", q("annularRing", {net:"", layer:"Multi"})?.min, p.annularRing),
      row("holeToHole", "Hole to hole", q("holeToHole", {net:""})?.gap, p.holeToHole),
      row("maskExpansion", "Solder mask expansion", q("solderMask", {net:"", layer:"Top"})?.expansion, p.maskExpansion, "equal"),
      row("silkToPad", "Silk to mask", q("silkToMask", {net:""})?.gap, p.silkToPad),
      row("silkWidth", "Silk to silk", q("silkToSilk", {net:""})?.gap, round(Math.max(p.silkWidth || 0, .1)))
    ].filter(r => r.profile != null && Number.isFinite(r.profile));
    // Capabilities the board relies on.
    const capability = [], say = (level, text) => capability.push({level, text});
    const n = copperCount(board, defs), th = thicknessOf(board, defs), VS = globalThis.AtriumViaStack;
    if (n != null && p.layers && (n < p.layers[0] || n > p.layers[1])) say("error", n + " copper layers; " + p.name + " builds " + p.layers[0] + (p.layers[1] !== p.layers[0] ? "–" + p.layers[1] : "") + ".");
    if (th != null && p.thickness?.length && !p.thickness.some(t => Math.abs(t - th) <= Math.max(.1 * t, .05))) say("warning", "Board thickness " + round(th) + " mm is not a standard option (" + p.thickness.join(", ") + " mm).");
    const used = {blind:0, buried:0, microvia:0, viaInPad:0, backdrill:0};
    let worst = null;
    if (VS) for (const v of board.items || []) {
      if (v.kind !== "via") continue;
      const spans = VS.drillSpans(v, board, defs), k = spans[0].kind;
      if (k !== "through") used[k]++;
      if (v.viaInPad) used.viaInPad++;
      if (spans.some(s => s.role === "backdrill")) used.backdrill++;
      const m = VS.measure(v, board, defs), limit = k === "microvia" ? p.microviaAspect : p.maxAspect;
      if (v.drill > 0 && m.aspect > limit + EPS && (!worst || m.aspect - limit > worst.over)) worst = {id:v.id, aspect:m.aspect, limit, over:m.aspect - limit, at:[v.x, v.y]};
    }
    for (const [k, label] of FLAGS) if (used[k] && !p[k]) say("error", used[k] + " via" + (used[k] === 1 ? " uses " : "s use ") + label.toLowerCase() + ", which " + p.name + " does not offer.");
    if (worst) say("error", "Via aspect ratio up to " + worst.aspect.toFixed(2) + ":1 exceeds the " + worst.limit + ":1 limit.");
    // Board objects that the profile rules would flag.
    let drc = null;
    try {
      const cand = applyProfile(board, p, {mode:"replace", project:o.project, templates:false}).rules;
      drc = R().drc(board, defs, cand, {types:TYPES, limit:o.limit ?? 50, connections:null});
    } catch (e) {say("warning", "The rule check could not run: " + e.message);}
    const byType = {};
    if (drc) for (const r of drc.rules) byType[r.type] = (byType[r.type] || 0) + r.count;
    // Per-layer rings, microvia spans and back-drills; aspect and capability are summarised above
    // and simple-stack rings are already in the annular ring rule.
    const viaStack = VS ? VS.check(board, defs, {profile:p, project:o.project, annularRing:p.annularRing})
      .filter(r => r.code !== "aspect" && r.code !== "capability" && (r.code !== "ring" || r.mode !== "simple")) : [];
    const edge = edgeCheck(board, defs, p.edgeClearance, o.limit ?? 50), silk = silkCheck(board, defs, p);
    if (edge.length) say("error", edge.length + (edge.length >= (o.limit ?? 50) ? "+" : "") + " copper object" + (edge.length === 1 ? " is" : "s are") + " closer than " + round(p.edgeClearance) + " mm to the board edge.");
    // Plated component holes against the PTH ring (when the profile sets one).
    if (p.pthRing > 0) {
      let thin = 0, least = Infinity;
      for (const i of board.items || []) {
        if (i.kind !== "part") continue;
        for (const pad of defs.get(i.def)?.footprint?.pads || []) {
          if (!(pad.drill > 0) || pad.plated === false || !(pad.w > 0 && pad.h > 0)) continue;
          const ring = (Math.min(pad.w, pad.h) - pad.drill) / 2;
          if (ring <= 0) continue;
          if (ring + EPS < p.pthRing) {thin++; least = Math.min(least, ring);}
        }
      }
      if (thin) say("warning", thin + " plated component hole" + (thin === 1 ? " has" : "s have") + " an annular ring below " + round(p.pthRing) + " mm (smallest " + round(least) + " mm).");
    }
    if (silk.thin) say("warning", silk.thin + " silkscreen line" + (silk.thin === 1 ? " is" : "s are") + " thinner than " + round(p.silkWidth) + " mm.");
    if (silk.small) say("warning", silk.small + " silkscreen text" + (silk.small === 1 ? " is" : "s are") + " smaller than " + round(p.silkHeight) + " mm.");
    const total = (drc?.total || 0) + edge.length + viaStack.length;
    return {profile:p, rows, capability, drc, byType, viaStack, edge, silk, layers:n, thickness:th, total};
  }
  // A profile from the board's current board-wide rules (Save current rules as profile).
  function fromBoard(board, name, o = {}) {
    const q = (type, obj = {}) => {try {return R().query(board, type, obj, {project:o.project});} catch {return null;}};
    const vs = q("viaStyle", {net:""}) || {}, fp = board?.fabProfile || {};
    return cleanProfile({name, vendor:"User", short:o.short || name,
      track:q("width", {net:""})?.min ?? .15, space:q("clearance", {net:"", net2:""})?.gap ?? .2,
      viaDrill:vs.holeMin ?? .3, viaDiameter:vs.diameterMin ?? round((vs.holeMin ?? .3) + 2 * (q("annularRing", {net:""})?.min ?? .1)),
      annularRing:q("annularRing", {net:"", layer:"Multi"})?.min ?? .1, minHole:q("holeSize", {net:""})?.min, maxHole:q("holeSize", {net:""})?.max ?? undefined,
      holeToHole:q("holeToHole", {net:""})?.gap, maskExpansion:q("solderMask", {net:"", layer:"Top"})?.expansion ?? .05,
      silkToPad:q("silkToMask", {net:""})?.gap, silkWidth:q("silkToSilk", {net:""})?.gap, edgeClearance:fp.edgeClearance ?? undefined,
      maxAspect:fp.maxAspect ?? 8, microviaAspect:fp.microviaAspect ?? 1, microviaDrill:fp.microviaDrill ?? undefined,
      blind:!!fp.blind, buried:!!fp.buried, microvia:!!fp.microvia, viaInPad:!!fp.viaInPad, backdrill:!!fp.backdrill,
      layers:[1, Math.max(2, copperCount(board, o.defs) || 2)], approximate:false,
      notes:["Saved from " + (board?.name || "a board") + " on " + new Date().toISOString().slice(0, 10) + "."]});
  }

  // ---------------------------------------------------------------- dialog
  function el(tag, text, cls, attrs) { return AtriumNavCommon.elWithAttributes(tag, text, cls, attrs); }
  const button = (text, act, cls, title) => globalThis.AtriumUI.nativeButton(text, act, cls, title);
  function open(ctx) {
    const doc = ctx.doc;
    if (doc?.kind !== "pcb") {ctx.info?.("Open a board layout to choose a fab profile."); return null;}
    const U = globalThis.Atrium?.units, unit = U ? U.normal(ctx.project?.units) : "mm";
    const fmt = mm => mm == null ? "—" : U ? U.format(mm, unit, unit === "mil" ? 2 : 3) : round(mm) + "mm";
    let profiles = list(), current = doc.fabProfile?.id && profiles.some(p => p.id === doc.fabProfile.id) ? doc.fabProfile.id : profiles[0].id;
    const d = el("dialog", null, "work-dialog ui-dialog fp-dialog", {"aria-label":"Fab profiles"});
    const head = el("div", null, "vs-head");
    const title = el("h2", "Fab Profiles");
    head.append(title, el("span", (doc.name || "Board") + (doc.fabProfile ? " · current: " + doc.fabProfile.name : ""), "vs-sub"));
    const warn = el("div", null, "fp-warning", {role:"note"});
    warn.append(el("strong", "Values are approximate."), el("span", " Built-in profiles summarise published capabilities and change without notice. Check your fab's current capabilities before ordering."));
    const left = el("div", null, "fp-list"), items = el("div", null, "ui-list vs-items", {role:"listbox", "aria-label":"Fab profiles", "data-layout":"stacked"}), right = el("div", null, "fp-detail");
    const status = el("p", null, "fp-status", {role:"status", "aria-live":"polite"});
    const lt = el("div", null, "vs-row vs-tools");
    lt.append(button("Save current rules…", () => {
      const name = prompt?.("Profile name", (doc.name || "Board") + " rules"); if (!name) return;
      try {const p = saveUser(fromBoard(doc, name, {project:ctx.project, defs:ctx.defs})); profiles = list(); current = p.id; paint(); status.textContent = "Saved profile " + p.name + " on this computer.";}
      catch (e) {status.textContent = e.message;}
    }, "", "Store the board's current rules as a user profile"),
    button("Import…", async () => {
      try {
        const f = ctx.pickFile ? await ctx.pickFile([".waffle-fab", ".json"]) : null; if (!f) return;
        const got = importText(f.text ? await f.text() : new TextDecoder().decode(await f.arrayBuffer()));
        for (const p of got) saveUser(p);
        profiles = list(); current = got[0]?.id || current; paint(); status.textContent = got.length + " profile" + (got.length === 1 ? "" : "s") + " imported.";
      } catch (e) {status.textContent = e.message;}
    }), button("Export…", async () => {
      const p = get(current);
      try {await (ctx.exportFile || globalThis.AtriumViaStack?.ui.saveText.bind(null, ctx))?.((p.short || p.name).replace(/[\\/:*?"<>|]/g, "-") + ".waffle-fab", exportText([p]));}
      catch (e) {status.textContent = e.message;}
    }, "", "Export the selected profile as a .waffle-fab file"),
    button("Delete", () => {const p = get(current); if (!p || p.builtin) {status.textContent = "Built-in profiles cannot be deleted."; return;} removeUser(p.id); profiles = list(); current = profiles[0].id; paint();}, "vs-danger"));
    left.append(items, lt);
    function paintList() {
      items.replaceChildren();
      let group = null;
      for (const p of profiles) {
        const g = p.builtin ? p.vendor : "User profiles";
        if (g !== group) {group = g; items.append(el("div", g, "vs-group-title"));}
        const it = el("div", null, "ui-row vs-item", {role:"option", tabindex:"0", "aria-selected":String(p.id === current)});
        it.append(el("strong", p.name), el("small", fmt(p.track) + " / " + fmt(p.space) + " · via " + fmt(p.viaDiameter) + "/" + fmt(p.viaDrill), "ui-row-subtitle"));
        if (doc.fabProfile?.id === p.id) it.append(el("span", "Applied", "ui-badge", {"data-outline": ""}));
        const pick = () => {current = p.id; paint();};
        it.onclick = pick; it.onkeydown = e => {if (e.key === "Enter" || e.key === " ") {pick(); e.preventDefault();}};
        items.append(it);
      }
    }
    function paintDetail() {
      const p = get(current);
      right.replaceChildren();
      if (!p) return;
      const title = el("div", null, "fp-title");
      title.append(el("h3", p.name), el("span", p.builtin ? "Built-in · approximate" : "User profile" + (p.approximate ? " · approximate" : ""), "ui-badge", {"data-outline": ""}));
      right.append(title);
      for (const n of p.notes || []) right.append(el("p", n, "fp-note"));
      let cmp = null;
      try {cmp = compare(doc, p, {defs:ctx.defs, project:ctx.project, limit:50});} catch (e) {right.append(el("p", e.message, "vs-msg vs-error"));}
      // Constraint table.
      const t = el("table", null, "vs-table fp-table"), thead = el("thead"), hr = el("tr");
      for (const h of ["Constraint", "Profile", "Board rules", ""]) hr.append(el("th", h, null, {scope:"col"}));
      thead.append(hr); const tb = el("tbody"); t.append(thead, tb);
      const statusText = {ok:"OK", looser:"Board allows less", missing:"No rule", differs:"Differs"};
      for (const r of cmp?.rows || []) {
        const tr = el("tr");
        tr.append(el("td", r.label), el("td", fmt(r.profile)), el("td", fmt(r.current)), el("td", statusText[r.status], "fp-" + r.status));
        tb.append(tr);
      }
      const facts = [["Max aspect ratio", p.maxAspect + ":1" + (p.microvia ? " · µvia " + p.microviaAspect + ":1" : "")], ["Copper layers", p.layers ? p.layers[0] + (p.layers[1] !== p.layers[0] ? "–" + p.layers[1] : "") : "—"],
        ["Board thickness", (p.thickness || []).join(", ") + " mm"], ["Copper weights", (p.copper || []).join(", ") + " oz" + (p.innerCopper ? " (inner " + p.innerCopper.join(", ") + " oz)" : "")],
        ["Solder mask web", fmt(p.maskWeb)], ["Silkscreen", fmt(p.silkWidth) + " line · " + fmt(p.silkHeight) + " text"], ["Edge clearance", fmt(p.edgeClearance)],
        ["Via technology", FLAGS.filter(([k]) => p[k]).map(([, l]) => l).join(", ") || "Through vias only"]];
      for (const [k, v] of facts) {const tr = el("tr", null, "fp-fact"); tr.append(el("td", k), el("td", v, null, {colspan:"3"})); tb.append(tr);}
      const wrap = el("div", null, "vs-table-wrap"); wrap.append(t); right.append(wrap);
      // Board check.
      if (cmp) {
        const box = el("div", null, "fp-check");
        box.append(el("h3", cmp.total ? cmp.total + " board object" + (cmp.total === 1 ? "" : "s") + " would violate this profile" : "The board meets this profile's checked rules"));
        const ul = el("ul", null, "vs-msgs");
        for (const [type, count] of Object.entries(cmp.byType)) if (count) ul.append(el("li", count + " × " + (R().types[type]?.title || type), "vs-msg vs-error"));
        for (const c of cmp.capability) ul.append(el("li", c.text, "vs-msg vs-" + c.level));
        if (cmp.viaStack.length) ul.append(el("li", cmp.viaStack.length + " via stack problem" + (cmp.viaStack.length === 1 ? "" : "s") + ": " + cmp.viaStack[0].text, "vs-msg vs-error"));
        if (!ul.children.length) ul.append(el("li", "No violations found.", "vs-msg vs-ok"));
        box.append(ul); right.append(box);
      }
      // Apply.
      const ap = el("fieldset", null, "vs-group fp-apply"); ap.append(el("legend", "Apply to " + (doc.name || "board")));
      const mode = el("select", null, "ui-field", {"aria-label":"How to apply"});
      mode.add(new Option("Replace manufacturing rules", "replace")); mode.add(new Option("Merge: keep net, class and layer rules", "merge"));
      const tpl = el("input", null, "ui-checkbox", {type:"checkbox"}); tpl.checked = true;
      const tl = el("label", null, "vs-check"); tl.append(tpl, el("span", "Add matching via templates"));
      const go = button("Apply profile", () => {
        try {
          const res = applyProfile(doc, p, {mode:mode.value, project:ctx.project, templates:tpl.checked});
          ctx.edit(() => install(doc, res, ctx.project));
          ctx.info?.(p.name + " applied · " + res.added.length + " rule types" + (res.templates.length ? " · " + res.templates.length + " via templates" : "") + " · values approximate");
          head.lastChild.textContent = (doc.name || "Board") + " · current: " + p.name;
          paint();
          status.textContent = "Applied. " + (res.removed.length ? "Replaced: " + res.removed.slice(0, 6).join(", ") + (res.removed.length > 6 ? "…" : "") + ". " : "") + "Review the rules in Design › Rules.";
        } catch (e) {status.textContent = e.message;}
      }, "fp-go");
      const row = el("div", null, "vs-row"); row.append(mode, tl, go);
      ap.append(row, el("small", "Profile rules are added board-wide as \"" + prefix(p) + DASH + "Clearance\" and so on. Merge keeps your scoped rules ahead of them. Undo restores the previous rules."));
      right.append(ap);
    }
    function paint() {paintList(); paintDetail();}
    const body = el("div", null, "fp-body"); body.append(left, right);
    const actions = el("div", null, "work-actions ui-dialog-actions"), close = button("Close", () => d.close());
    close.dataset.variant = "primary"; close.dataset.uiDefault = "false";
    actions.append(close);
    d.append(head, warn, body, status, actions);
    paint();
    globalThis.AtriumShell.openDialog(d, {title, body, actions});
    return d;
  }

  return Object.freeze({BUILTIN, LENGTHS, FLAGS, TYPES, APPROX, list, get, cleanProfile, userProfiles, saveUser, removeUser, exportText, importText,
    ruleRecords, profileTemplates, applyProfile, install, compare, edgeCheck, fromBoard, open, LAYOUTS, outputLayout, PANEL, panelRules});
})();
