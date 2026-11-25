"use strict";
// New-project step for fab presets: File › New / the start page list JLCPCB 2-, 4- and 6-layer
// boards that start with the preset applied (rules, stack-up, outputs; fab-presets.js). Loaded with
// templates.js. The preset data loads when a project is created.
(() => {
  const T = globalThis.AtriumTemplates;
  if (!T?.register) return;
  const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
  const NEEDS = ["AtriumStackup", "AtriumViaStack", "AtriumRules", "AtriumFabProfiles", "AtriumImpedance", "AtriumFabPresets", "AtriumFabPresetsJLCPCB"];
  const board = (id, preset, order, title, summary, w, h, layers) => T.register({id, order, title, summary, outline: rect(w, h),
    thumbnail: {layers, profiles: layers > 2 ? 3 : 0}, needs: NEEDS,
    detail: "Design rules, layer stack, impedance profiles and the JLCPCB order files from the " + title + " fab preset. Check JLCPCB's current capabilities before ordering.",
    build(ctx) {
      const A = globalThis.Atrium, F = globalThis.AtriumFabPresets;
      const p = A.project(ctx.name || "Untitled", [...(globalThis.AtriumParts?.catalogue || []), ...(ctx.starter || [])]);
      if (ctx.prefs?.["general.units"] === "mil") p.units = "mil";
      const pcb = p.documents.find(d => d.kind === "pcb");
      if (ctx.prefs?.["pcb.grid"] > 0) pcb.grid = ctx.prefs["pcb.grid"];
      pcb.name = "Board " + w + "×" + h; pcb.outline = rect(w, h);
      F.apply(p, pcb, preset, {defs: new Map(p.library.map(d => [d.id, d]))});
      return p;
    }});
  board("jlcpcb-2l", "jlcpcb-2l", 5, "JLCPCB 2-layer (cheapest)", "1.6 mm FR-4, 1 oz, HASL, green: JLCPCB's lowest-cost options and order files.", 100, 80, 2);
  board("jlcpcb-4l", "jlcpcb-4l", 6, "JLCPCB 4-layer (JLC04161H-7628)", "JLCPCB's 4-layer stack-up with 50/90/100 Ω profiles and order files.", 80, 60, 4);
  board("jlcpcb-6l", "jlcpcb-6l", 7, "JLCPCB 6-layer (JLC06161H-3313)", "JLCPCB's 6-layer impedance stack-up, ENIG, with profiles and order files.", 80, 60, 6);
})();
