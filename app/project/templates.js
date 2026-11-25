"use strict";
// Project templates for the start page and File → New.
//
//   AtriumTemplates.list()                 -> [{id, title, summary, detail, outline, thumbnail, needs}]
//   AtriumTemplates.build(id, {name, prefs, starter}) -> Promise<project>
//   AtriumTemplates.register(spec)          -> adds a template (extensions and contributions)
//   AtriumTemplates.preview(id)             -> Promise<declared thumbnail geometry, or null>
//
// A template is plain data plus a build(ctx) function that returns an ordinary Waffle project,
// so a contribution is one register() call. build() runs after the modules it lists in `needs`
// have loaded through AtriumLazy (stack-up, fab profiles, rigid-flex). Every board takes its rules
// from a built-in fab profile (JLCPCB's are the sourced fab presets, app/fab-presets/jlcpcb.json, the
// same rules as the Fab Preset start boards), so DRC is right from the first track. ctx.prefs supplies the user's defaults (units, grids, sheet size).
globalThis.AtriumTemplates = (() => {
  const A = () => globalThis.Atrium;
  const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
  const chamfered = (w, h, c) => [[c, 0], [w - c, 0], [w, c], [w, h - c], [w - c, h], [c, h], [0, h - c], [0, c]];
  const BOARD = ["AtriumStackup", "AtriumViaStack", "AtriumRules", "AtriumFabProfiles"];
  const TEMPLATES = [];
  const plainOutline = o => Array.isArray(o) && o.length >= 3 && o.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));

  function register(spec) {
    if (!spec || typeof spec.id !== "string" || !spec.id || typeof spec.build !== "function") throw Error("A template needs an id and a build function.");
    const outline = plainOutline(spec.outline) ? spec.outline.map(p => [...p]) : null;
    // Cards use their declared outline. Templates can also describe layers, impedance
    // profiles, regions, bend lines and part bounds without loading a board editor.
    const thumbnail = outline && {layers: null, profiles: 0, regions: [], bends: [], parts: [],
      ...spec.thumbnail, outline: outline.map(p => [...p])};
    const t = {id: spec.id, title: String(spec.title || spec.id), summary: String(spec.summary || ""), detail: String(spec.detail || ""),
      outline, thumbnail, ...(spec.paper ? {paper:spec.paper} : {}), needs: Array.isArray(spec.needs) ? [...spec.needs] : [], build: spec.build, order: spec.order ?? 100 + TEMPLATES.length};
    const i = TEMPLATES.findIndex(x => x.id === t.id);
    if (i >= 0) TEMPLATES[i] = t; else TEMPLATES.push(t);
    TEMPLATES.sort((a, b) => a.order - b.order);
    return {dispose() { const k = TEMPLATES.indexOf(t); if (k >= 0) TEMPLATES.splice(k, 1); }};
  }
  const list = () => TEMPLATES.map(({build, ...t}) => ({...t, outline: t.outline && t.outline.map(p => [...p])}));

  // ------------------------------------------------------------------ shared steps
  function base(ctx) {
    const lib = [...(globalThis.AtriumParts?.catalogue || [])];
    const p = A().project(ctx.name || "Untitled", lib);
    const pref = k => ctx.prefs?.[k];
    if (pref("general.units") === "mil") p.units = "mil";
    const [sch, pcb] = p.documents;
    if (pref("schematic.grid") > 0) sch.grid = pref("schematic.grid");
    if (pref("pcb.grid") > 0) pcb.grid = pref("pcb.grid");
    const size = pref("schematic.sheetSize"), block = pref("schematic.titleBlock"), orient = pref("schematic.orientation");
    if (size || block || orient) {
      sch.sheet = {};
      if (size) sch.sheet.size = size;
      if (orient === "portrait") sch.sheet.orientation = "portrait";
      if (block) sch.sheet.titleBlock = block;
    }
    if (ctx.starter) for (const d of ctx.starter) if (!p.library.some(x => x.id === d.id)) p.library.push(d);
    return {project: p, sch, pcb};
  }
  function stack(board, layers) {
    const S = globalThis.AtriumStackup;
    if (!S) return null;
    const st = S.preset(layers); delete st.derived;
    board.stackup = JSON.parse(JSON.stringify(st));
    return board.stackup;
  }
  // Impedance profiles on the outer layers, each referenced to the adjacent inner plane:
  // [id, name, type, target ohms, pair gap?]. Widths are left blank, so they are solved
  // from the stack-up (and re-solved when it changes).
  function profiles(st, list) {
    const cu = st.layers.filter(globalThis.AtriumStackup.isCopper).map(l => l.key), inner = cu.length > 2;
    const ref = side => side ? [inner ? cu.at(-2) : cu[0], null] : [null, inner ? cu[1] : cu.at(-1)];
    return list.map(([id, name, type, target, gap]) => ({id, name, type, target, tolerance: 10,
      layers: {[cu[0]]: {enabled: true, ...(gap ? {gap} : {}), reference: ref(0)}, [cu.at(-1)]: {enabled: true, ...(gap ? {gap} : {}), reference: ref(1)}}}));
  }
  function fab(project, board, id) {
    const F = globalThis.AtriumFabProfiles;
    if (!F) { board.notes.push("Fab profile " + id + " was not applied: the fab profiles module did not load."); return; }
    F.install(board, F.applyProfile(board, id, {mode: "replace", project}), project);
    board.notes.push("Rules from the " + F.get(id).name + " fab profile. " + F.APPROX);
  }
  // A placed part on both documents, linked like an ECO-synchronised pair.
  function pair(p, sch, pcb, defId, ref, sAt, bAt) {
    let def = p.library.find(d => d.id === defId);
    if (!def) { def = globalThis.AtriumStarterLibrary?.defs().find(d => d.id === defId); if (!def) return; p.library.push(def); }
    const common = {kind: "part", ref, def: defId, value: def.value || "", link: "link-" + ref, pinNets: {}};
    if (def.symbol && sAt) sch.items.push({...common, id: A().id(), x: sAt[0], y: sAt[1], angle: sAt[2] || 0});
    if (def.footprint && bAt) pcb.items.push({...common, id: A().id(), x: bAt[0], y: bAt[1], angle: bAt[2] || 0});
  }

  // ------------------------------------------------------------------ built-in templates
  register({id: "blank", order: 0, title: "Blank project", summary: "One schematic sheet and an empty board.",
    detail: "No outline or rules yet: draw the board shape when you are ready.", build: ctx => base(ctx).project});
  for (const [n, paper] of ["A4","A3","Letter","infinite"].entries()) {
    const infinite = paper === "infinite";
    register({id:"sheet-"+paper.toLowerCase(), order:(n+1)/10, paper,
      title:infinite ? "Infinite canvas" : paper+" sheet",
      summary:infinite ? "A schematic that grows with the drawing." : "A blank schematic on "+paper+" paper.",
      build:ctx=>{
        const {project,sch}=base(ctx);
        sch.sheet={...sch.sheet,...(infinite?{infinite:true}:{size:paper})};
        return project;
      }});
  }
  register({id: "2l-100x80-jlc", order: 1, title: "2-layer board, 100 × 80 mm", summary: "Standard 1.6 mm two-layer board with JLCPCB-style rules.",
    detail: "Track, space, via and annular-ring rules from the JLCPCB 2-layer profile.", outline: rect(100, 80), thumbnail: {layers: 2}, needs: BOARD,
    build: ctx => { const {project, pcb} = base(ctx); pcb.name = "Board 100×80"; pcb.outline = rect(100, 80); stack(pcb, 2); fab(project, pcb, "jlcpcb-2l"); return project; }});
  register({id: "4l-impedance", order: 2, title: "4-layer board, controlled impedance", summary: "Signal / GND / PWR / Signal with 50 Ω and 90 Ω differential profiles.",
    detail: "Profiles on both outer layers, referenced to the adjacent planes. Widths are solved from the stack-up.", outline: rect(80, 60), thumbnail: {layers: 4, profiles: 3}, needs: [...BOARD, "AtriumImpedance"],
    build: ctx => {
      const {project, pcb} = base(ctx); pcb.name = "Board 80×60 (4 layers)"; pcb.outline = rect(80, 60);
      const st = stack(pcb, 4);
      if (st) st.impedanceProfiles = profiles(st, [["se50", "50 Ω single-ended", "single", 50], ["diff90", "90 Ω differential (USB)", "diff", 90, .15], ["diff100", "100 Ω differential", "diff", 100, .2]]);
      fab(project, pcb, "jlcpcb-4l");
      return project;
    }});
  // A generic plug-on board for popular microcontroller boards: 68.6 × 53.3 mm with four header
  // rows along the long edges. Positions are approximate; check them against your base board.
  register({id: "shield", order: 3, title: "Microcontroller shield, 68.6 × 53.3 mm", summary: "Two-layer plug-on board with four header rows along the long edges.",
    detail: "Header positions are approximate. Check them against your base board before ordering. Header pins carry No ERC markers until you wire them.", outline: chamfered(68.58, 53.34, 2.54), needs: [...BOARD, "AtriumStarterLibrary", "AtriumSchPlace", "AtriumERC"],
    thumbnail: {layers: 2, parts: [[17.49, .72, 38.39, 4.09], [40.35, .72, 61.25, 4.09], [20.03, 48.98, 40.93, 52.35], [45.44, 48.98, 61.24, 52.35]]},
    build: ctx => {
      const {project, sch, pcb} = base(ctx); pcb.name = "Shield"; pcb.outline = chamfered(68.58, 53.34, 2.54); stack(pcb, 2); fab(project, pcb, "jlcpcb-2l");
      const rows = [["J1", "starter-hdr-1x8", [27.94, 2.54]], ["J2", "starter-hdr-1x8", [50.8, 2.54]], ["J3", "starter-hdr-1x8", [30.48, 50.8]], ["J4", "starter-hdr-1x6", [53.34, 50.8]]];
      rows.forEach(([ref, id, at], i) => pair(project, sch, pcb, id, ref, [50.8 + i * 25.4, 76.2, 0], [at[0], at[1], 90]));
      // The headers are deliberately unwired, so a fresh shield compiles clean (Place › Directives
      // › No ERC on Unused Pins does the same for any part).
      globalThis.AtriumSchPlace?.noErcUnused(sch, new Map(project.library.map(d => [d.id, d])));
      return project;
    }});
  register({id: "rigid-flex", order: 4, title: "Rigid-flex example", summary: "Two rigid ends joined by a two-layer flex tail with a 90° bend.",
    detail: "Four-layer rigid stack, a polyimide flex substack on the outer copper, board regions and one bend line.", outline: rect(100, 30), needs: [...BOARD, "AtriumRigidFlex"],
    thumbnail: {layers: 4, profiles: 2, bends: [[[50, 0], [50, 30]]], regions: [
      {points: [[65, 0], [100, 0], [100, 30], [65, 30]], flex: false},
      {points: [[65, 30], [35, 30], [35, 0], [65, 0]], flex: true},
      {points: [[35, 30], [0, 30], [0, 0], [35, 0]], flex: false}]},
    build: ctx => {
      const {project, pcb} = base(ctx), S = globalThis.AtriumStackup, RF = globalThis.AtriumRigidFlex;
      pcb.name = "Rigid-flex"; pcb.outline = rect(100, 30);
      const st = stack(pcb, 4);
      if (st && S?.flexLayers && RF) {
        const cu = S.stored ? S.stored(pcb).layers.filter(S.isCopper) : st.layers.filter(S.isCopper);
        // A 100 µm polyimide core (not the 50 µm default) keeps the solved 50 Ω and 90 Ω widths on
        // the flex above the fab's minimum track width.
        const flex = S.flexLayers(["Top", "Bottom"], cu);
        for (const l of flex) if (l.type === "Dielectric") l.thickness = .1;
        st.substacks = [{id: "flex", name: "Flex", flex: true, layers: flex}];
        S.splitRegion(pcb, {a: [35, -1], b: [35, 31]}); S.splitRegion(pcb, {a: [65, -1], b: [65, 31]});
        const mid = RF.regions(pcb).find(g => RF.geometry.inside([50, 15], g.points));
        if (mid) S.assignStack(pcb, mid.id, "flex");
        const cx = g => g.points.reduce((t, q) => t + q[0], 0) / g.points.length;
        (pcb.stackup.regions || []).slice().sort((a, b) => cx(a) - cx(b)).forEach((g, i, all) => { g.name = all.length === 3 ? ["Left rigid", "Flex tail", "Right rigid"][i] : "Region " + (i + 1); });
        // IPC-2223 static bend: radius at least 10x the finished flex (2 layers, 0.195 mm here,
        // so 1.95 mm). 3 mm leaves margin for a thicker coverlay or a stiffener later.
        RF.addBend(pcb, {a: [50, 0], b: [50, 30], angle: 90, radius: 3, name: "Bend 1"});
        // One set of profiles for the whole board: each region solves it on its own substack
        // (outer layers over the inner planes on the rigid ends, over each other on the flex).
        st.impedanceProfiles = profiles(st, [["se50", "50 Ω single-ended", "single", 50], ["diff90", "90 Ω differential (USB)", "diff", 90, .2]]);
        globalThis.AtriumStackup?.touch?.(pcb); // in place, after the bend edits read the stack
      }
      fab(project, pcb, "jlcpcb-4l");
      return project;
    }});

  async function build(id, ctx = {}) {
    const t = TEMPLATES.find(x => x.id === id);
    if (!t) throw Error("Unknown template " + id + ".");
    const L = globalThis.AtriumLazy;
    if (L && t.needs.length) await L.need(t.needs.filter(n => globalThis[n] == null));
    let starter = ctx.starter;
    if (starter === true) {
      if (L && !globalThis.AtriumStarterLibrary) await L.need("AtriumStarterLibrary");
      starter = globalThis.AtriumStarterLibrary?.defs() || null;
    }
    const project = t.build({...ctx, starter});
    if (L?.validatorsFor) await L.need(L.validatorsFor(project));
    A().validate(project);
    return project;
  }
  async function preview(id) { return TEMPLATES.find(t => t.id === id)?.thumbnail ?? null; }
  return Object.freeze({list, build, register, preview});
})();
