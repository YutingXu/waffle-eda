"use strict";

// Output job sets, the engine behind File › Release… (release-ui.js draws the page, release.js
// adds pre-flight gates, versioned packages and the release history). Modelled on Altium's OutJob
// and KiCad's jobsets: a named, ordered list of outputs with their options, run in one go into a
// named folder or one ZIP, with a manifest of SHA-256 checksums. Job sets live in the project as
// `project.outputJobs`.
//
// Job set (version 2; version 1 sets are read unchanged and produce the same files):
//   {name, description?, board?: PCB document id (default: first layout),
//    revision?: text for {rev} (default: project.revision, else the project/board "Revision" parameter, else "1"),
//    folder: "{project}-{rev}-{date}"   output folder template ("" = none),
//    zip: false, zipName?: "{folder}.zip", stopOnFailure: false,
//    package: {mode: "folder"|"zip"|"vendor", vendor?: "JLCPCB"|"PCBWay"}   (v2; zip mirrors mode "zip"),
//    variants?: "active" (default) | "base" | "all" | [variant names]       (v2; used by release.js),
//    gates?: {drc, erc, bom, variants, git: false to leave a pre-flight check out} (v2),
//    from?: the preset a saved set was forked from (v2),
//    outputs: [{id, kind, enabled, label?, folder?: sub-folder template, options: {...}}]}
// "vendor" packages lay Gerber (zipped), BOM, pick-and-place and order notes out flat as the board
// house's upload form expects; it fills in only options and folders a set leaves unset.
// Template fields: {project} {board} {rev} {date} (YYYY-MM-DD) {time} (HHMM) {job} {folder}, and
// {stem}: the fabrication file stem, as File › Fabrication Outputs names files (the project name
// slugified, plus the board name when the project has several boards: "Sensor-interface").
// Gerber, drill, readme, pick-and-place and assembly files start with {stem}; vendor layouts use it too.
//
// Output kinds and options (all optional), grouped by destination (GROUPS):
// Fabrication
//   gerber    Gerber X2 + Excellon (AtriumFabOutputs options: units, format, origin,
//             layers, profileWidth, maskExpansion, pasteExpansion, tentVias, overrideExpansions,
//             drillUnits, drillFormat, drillOrigin) plus profileOnly (false), drill (true), readme (true),
//             pack ("" or a zip name template, e.g. "{stem}-Gerber.zip")
//   ipc2581   IPC-2581 rev B: units mm|in, impedance (opt-in Specs)
//   notes     board-house order notes (panel.js)
// Assembly
//   bom       view (saved BOM view), format csv|xlsx|html, style default|jlc|pcbway, source, name
//   pnp       pick and place: units mm|mil, style altium|jlc, origin, name
//   assembly  assembly drawings: top, bottom
// Documentation
//   pdf       schematic and board PDF (print.js), when loaded (options passed through)
//   drawing   drawing documents as vector PDF (drawing.js): drawings (names, comma separated;
//             empty: every drawing), paper (tile larger sheets at 1:1), name
//   step      3D model: format step|glb, components, copper, silkscreen, vias, generated
//   kicad     .kicad_pcb (and .kicad_sch for every sheet with sheets: true)
// Reports
//   drc / erc reports; failOver: fail the output when violations exceed it
//             (null = never); erc level Error|Warning; format html|json
//   bomcost   BOM cost: boards (quantity built), format csv|html; unit prices from the parts'
//             "Unit Price" / "Price" / "Cost" parameters
//   readme    README with the job summary and SHA-256 of every file, plus SHA256SUMS
// Any output's options may carry `variant` (variants.js): id or name, "" for the base design.
//
// run(project, jobSetNameOrDefinition, {date, revision, files}) is DOM-free and
// synchronous: -> {files: [{name, data}], report}. `files` false leaves data
// out (report only). runAsync() is the same with progress callbacks, support for
// asynchronous outputs (PDF), cancellation (opts.signal) and opts.intercept, a hook
// release.js uses to serve an output from its cache or a worker.
if (!globalThis.AtriumSHA256) {
  if (typeof importScripts === "function") importScripts("../core/sha256.js");
  else if (typeof require === "function") require("../core/sha256.js");
}
globalThis.AtriumOutputJobs = (() => {
  const VERSION = 2, MAX_SETS = 100, MAX_OUTPUTS = 64;
  const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const str = v => typeof v === "string";
  const clone = v => JSON.parse(JSON.stringify(v));
  const fail = m => { throw Error(m); };
  const odbAvailable = opts => opts.odbEnabled === true || globalThis.AtriumPrefs?.get("butter.odb") === true;

  // ---------------------------------------------------------------- catalogue
  // fields: [key, label, type, values|default, hint, input attributes]
  const yes = [true, false];
  const ORIGINS = [["auto", "Board origin, else lower-left"], ["outline", "Board lower-left corner"], ["absolute", "Design origin"]];
  const KINDS = Object.freeze({
    odb: {label:"ODB++ Design 8.1", folder:"ODB++", fields:[
      ["units","Units","select",[["mm","Millimetres"],["in","Inches"]]],
      ["origin","Origin","select",ORIGINS], ["omitUnconnectedMidLayerPads","Omit isolated inner-layer pads","bool",false],
      ["name","File name","text","","Template ending in .tgz"]]},
    gerber: {label: "Gerber and drill", folder: "Gerber", fields: [
      ["units", "Units", "select", [["mm", "Millimetres"], ["in", "Inches"]]], ["format", "Format", "select", [["", "Default (6 decimals)"], ["4:6", "4:6"], ["3:6", "3:6"], ["2:6", "2:6 (inch)"],
        ["4:4", "4:4 (metric, legacy)"], ["4:3", "4:3 (metric, legacy)"], ["2:5", "2:5 (inch, legacy)"], ["2:4", "2:4 (inch, legacy)"]]],
      ["origin", "Origin", "select", ORIGINS],
      ["profileWidth", "Profile stroke width (mm)", "number", .1, "Width of the line along the board edge and cutouts.", {step: "any", min: "0"}],
      ["profileOnly", "Plot the board profile only", "bool", false],
      ["omitUnconnectedMidLayerPads", "Omit isolated inner-layer pads", "bool", false],
      ["tentVias", "Tent vias", "bool", true], ["maskExpansion", "Mask expansion (mm)", "number", .1016], ["pasteExpansion", "Paste expansion (mm)", "number", 0],
      ["overrideExpansions", "Override rule expansions", "bool", false], ["drill", "Drill files", "bool", true],
      ["drillUnits", "Drill units", "select", [["mm", "Millimetres"], ["in", "Inches"]]],
      ["drillOrigin", "NC drill origin", "select", [["shared", "Use shared origin"], ...ORIGINS]], ["readme", "Fabrication readme", "bool", true],
      ["pack", "Zip Gerber and drill as", "text", "", "Empty: separate files. Example: {stem}-Gerber.zip"]]},
    pnp: {label: "Pick and place", folder: "Assembly", fields: [
      ["style", "Layout", "select", [["altium", "Altium-style CSV"], ["jlc", "JLCPCB CPL format"]]], ["units", "Units", "select", [["mm", "Millimetres"], ["mil", "Mils"]]],
      ["origin", "Origin", "select", ORIGINS],
      ["name", "File name", "text", "", "Template; empty uses the default name"]]},
    assembly: {label: "Assembly drawings", folder: "Assembly", fields: [["top", "Top drawing", "bool", true], ["bottom", "Bottom drawing", "bool", true]]},
    bom: {label: "Bill of materials", folder: "BOM", fields: [
      ["view", "Saved BOM view", "view", ""], ["format", "Format", "select", [["csv", "CSV"], ["xlsx", "Excel (.xlsx)"], ["html", "HTML"]]],
      ["style", "Column layout", "select", [["default", "From the view"], ["jlc", "JLCPCB (LCSC Part #)"], ["pcbway", "PCBWay template"]]],
      ["source", "Source", "select", [["", "Automatic"], ["pcb", "Board"], ["schematic", "Schematic"]]], ["name", "File name", "text", "", "Template; empty uses the default name"]]},
    step: {label: "3D model (STEP / glTF)", folder: "3D", fields: [
      ["format", "Format", "select", [["step", "STEP AP214"], ["glb", "Binary glTF (.glb)"]]], ["components", "Components", "bool", true],
      ["copper", "Copper", "bool", false], ["silkscreen", "Silkscreen", "bool", false], ["vias", "Drill vias", "bool", true]]},
    kicad: {label: "KiCad export", folder: "KiCad", fields: [["sheets", "Schematic sheets", "bool", true]]},
    ipc2581: {label: "IPC-2581 (rev B)", folder: "IPC-2581", fields: [["units", "Units", "select", [["mm", "Millimetres"], ["in", "Inches"]]],
      ["impedance", "Impedance specs", "bool", false, "Tags controlled-impedance tracks; least certain part of the schema"]]},
    pdf: {label: "PDF documents", folder: "PDF", needs: "AtriumPDF", fields: [
      ["paper", "Paper", "select", [["A4", "A4"], ["A3", "A3"], ["Letter", "Letter"], ["Tabloid", "Tabloid"]]], ["color", "Colour", "select", [["color", "Colour"], ["grey", "Greyscale"], ["mono", "Monochrome"]]],
      ["infiniteLayout", "Infinite sheet layout", "select", [["", "Fit whole drawing on one page"], ["frames", "One page per frame"], ["tile", "Tile at chosen scale"]]],
      ["infiniteScale", "Tile scale (1 = 1:1)", "ratio", 1, "Adjacent pages overlap by 6 mm."],
      ["viewerLayers", "Viewer layers", "bool", true], ["properties", "Part property notes", "bool", true], ["attachments", "Attach BOM and netlist", "bool", true],
      ["name", "File name", "text", "", "Template; empty uses {project}.pdf"]]},
    drc: {label: "Design rule check report", folder: "Reports", fields: [
      ["failOver", "Fail above (violations)", "count", 0, "Empty: report only"], ["format", "Format", "select", [["html", "HTML"], ["json", "JSON"]]]]},
    erc: {label: "Electrical rule check report", folder: "Reports", fields: [
      ["failOver", "Fail above (messages)", "count", 0, "Empty: report only"], ["level", "Count", "select", [["Error", "Errors and fatal"], ["Warning", "Warnings and above"]]],
      ["format", "Format", "select", [["html", "HTML"], ["json", "JSON"]]]]},
    drawing: {label: "Drawings (PDF)", folder: "Drawings", needs: "AtriumDrawing", fields: [
      ["drawings", "Drawings", "text", "", "Names, comma separated; empty: every drawing"],
      ["paper", "Tile onto", "select", [["", "Sheet size (1:1)"], ["A4", "A4 at 1:1"], ["A3", "A3 at 1:1"], ["Letter", "Letter at 1:1"]]],
      ["name", "File name", "text", "", "Template; empty uses {project}-Drawings.pdf"]]},
    notes: {label: "Order notes", folder: "", needs: "AtriumPanel", fields: [
      ["vendor", "Fab", "select", [["", "From the fab profile"], ["JLCPCB", "JLCPCB"], ["PCBWay", "PCBWay"]]], ["name", "File name", "text", "", "Template; empty uses {stem}-Order-Notes.txt"]]},
    bomcost: {label: "BOM cost", folder: "Reports", fields: [
      ["boards", "Boards built", "count", 1, "Quantity the cost is worked out for"], ["format", "Format", "select", [["html", "HTML"], ["csv", "CSV"]]],
      ["currency", "Currency", "text", "", "Shown beside prices, e.g. USD"]]},
    readme: {label: "README and checksums", folder: "", fields: [["sums", "SHA256SUMS file", "bool", true]]}
  });
  const ORDER = Object.keys(KINDS);
  // Release page groups: where the files are going.
  const GROUPS = Object.freeze([
    {id: "fabrication", label: "Fabrication", hint: "What the board house makes the bare board from.", kinds: ["gerber", "ipc2581", "odb", "notes"]},
    {id: "assembly", label: "Assembly", hint: "What the assembler places parts from.", kinds: ["bom", "pnp", "assembly"]},
    {id: "documentation", label: "Documentation", hint: "For people: schematics, drawings and 3D.", kinds: ["pdf", "drawing", "step", "kicad"]},
    {id: "reports", label: "Reports", hint: "Checks and the paper trail.", kinds: ["drc", "erc", "bomcost", "readme"]}]);
  const groupOf = kind => GROUPS.find(g => g.kinds.includes(kind))?.id || "documentation";
  // Options a newly added output starts with: the catalogue defaults that matter (DRC/ERC gates fail above 0).
  const defaultsOf = kind => Object.fromEntries((KINDS[kind]?.fields || []).filter(f => f[2] === "count" && f[3] != null).map(f => [f[0], f[3]]));

  // ---------------------------------------------------------------- validation
  const id = () => globalThis.Atrium.id();
  function cleanValue(v, depth) {
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (str(v)) return v.slice(0, 500);
    if (Array.isArray(v) && depth < 3) return v.slice(0, 200).map(x => cleanValue(x, depth + 1));
    if (plain(v) && depth < 3) {
      const out = {};
      for (const [k, x] of Object.entries(v).slice(0, 100)) if (k.length <= 64 && k !== "__proto__") { const c = cleanValue(x, depth + 1); if (c !== undefined) out[k] = c; }
      return out;
    }
    return undefined;
  }
  // A cleaned copy of a job set; throws on what cannot be repaired.
  function normalise(raw) {
    if (!plain(raw)) fail("An output job set must be an object.");
    const name = str(raw.name) ? raw.name.trim() : "";
    if (!name || name.length > 80) fail("Each output job set needs a name of up to 80 characters.");
    if (!Array.isArray(raw.outputs)) fail(name + ": outputs must be a list.");
    if (raw.outputs.length > MAX_OUTPUTS) fail(name + ": a job set holds at most " + MAX_OUTPUTS + " outputs.");
    // Forward compatibility: a newer set keeps its version, and fields, gates and output fields this
    // build doesn't know are copied through unchanged (an edit in the release UI keeps them).
    const out = {name, version: Number.isInteger(raw.version) && raw.version > VERSION ? raw.version : VERSION, folder: str(raw.folder) ? raw.folder.slice(0, 200) : "{project}-{rev}-{date}", zip: raw.zip === true, outputs: []};
    for (const k of ["description", "zipName", "revision", "board", "fabProfile", "panel"]) if (str(raw[k]) && raw[k].trim()) out[k] = raw[k].slice(0, k === "description" ? 1000 : 200);
    if (raw.stopOnFailure === true) out.stopOnFailure = true;
    // v2: the package (folder, one zip, or a board house's upload layout) is the one place
    // that says where files go; `zip` stays in step so a v1 reader runs the set the same way.
    out.package = packageOf(raw);
    out.zip = out.package.mode === "zip";
    if (str(raw.from) && raw.from.trim()) out.from = raw.from.slice(0, 80);
    if (raw.variants === "base" || raw.variants === "all") out.variants = raw.variants;
    else if (Array.isArray(raw.variants)) { const v = [...new Set(raw.variants.filter(x => str(x) && x.trim()).map(x => x.slice(0, 80)))].slice(0, 64); if (v.length) out.variants = v; }
    if (plain(raw.gates)) { const g = {}; for (const k of GATES) if (raw.gates[k] === false || (k === "placeholders" && raw.gates[k] === "block")) g[k] = raw.gates[k]; keepUnknown(g, raw.gates, GATES); if (Object.keys(g).length) out.gates = g; }
    const ids = new Set();
    for (const o of raw.outputs) {
      if (!plain(o) || !str(o.kind) || !/^[a-z0-9-]{1,32}$/.test(o.kind)) fail(name + ": each output needs a kind.");
      let oid = str(o.id) && /^[\w-]{1,40}$/.test(o.id) ? o.id : id();
      while (ids.has(oid)) oid = id();
      ids.add(oid);
      const c = {id: oid, kind: o.kind, enabled: o.enabled !== false, options: plain(o.options) ? cleanValue(o.options, 0) : {}};
      // Release gates: failOver must be a whole number (numeric strings are coerced); empty or
      // null means report only. Anything else is an error, never a silently passing gate.
      if ((o.kind === "drc" || o.kind === "erc") && "failOver" in c.options) {
        const v = c.options.failOver;
        if (v === null || v === "" || (str(v) && !v.trim())) c.options.failOver = null;
        else if (typeof v === "number" && Number.isInteger(v) && v >= 0) c.options.failOver = v;
        else if (str(v) && /^\s*\d+\s*$/.test(v)) c.options.failOver = Number(v);
        else fail(name + ": " + o.kind.toUpperCase() + " failOver must be a whole number of at least 0, or empty to only report.");
      }
      if (str(o.label) && o.label.trim()) c.label = o.label.slice(0, 80);
      if (str(o.folder)) c.folder = o.folder.slice(0, 200);
      out.outputs.push(keepUnknown(c, o, OUTPUT_KEYS));
    }
    return keepUnknown(out, raw, SET_KEYS);
  }
  const SET_KEYS = ["name", "version", "folder", "zip", "outputs", "description", "zipName", "revision", "board", "fabProfile", "panel", "stopOnFailure", "package", "from", "variants", "gates"];
  const OUTPUT_KEYS = ["id", "kind", "enabled", "options", "label", "folder"];
  function keepUnknown(o, raw, known) {
    for (const k of Object.keys(raw)) if (!known.includes(k) && !Object.hasOwn(o, k) && k !== "__proto__") o[k] = JSON.parse(JSON.stringify(raw[k] ?? null));
    return o;
  }
  // The package a set writes. v1 sets (no `package`) are read from zip and, for sets made from a
  // board-house preset (fab profile plus flat Gerber/BOM/pick-and-place), as that vendor's bundle.
  const GATES = ["drc", "erc", "bom", "variants", "git", "dfm", "placeholders"]; // dfm: fab-presets (dfm.js); placeholders: false, or "block" to fail on any unresolved placeholder
  const VENDORS = ["JLCPCB", "PCBWay"];
  function packageOf(raw) {
    const p = plain(raw.package) ? raw.package : null;
    if (p && (p.mode === "folder" || p.mode === "zip")) return {mode: p.mode};
    if (p && p.mode === "vendor") { const v = VENDORS.find(x => same(x, p.vendor)) || layout(raw.fabProfile)?.vendor || "JLCPCB"; return {mode: "vendor", vendor: v}; }
    if (raw.zip === true) return {mode: "zip"};
    const v = str(raw.fabProfile) ? layout(raw.fabProfile)?.vendor : null, outs = Array.isArray(raw.outputs) ? raw.outputs : [];
    const flat = outs.filter(o => plain(o) && ["gerber", "bom", "pnp"].includes(o.kind));
    if (v && VENDORS.includes(v) && flat.length && flat.every(o => o.folder === "")) return {mode: "vendor", vendor: v};
    return {mode: "folder"};
  }
  // A v1 (or any) job set as a v2 one, without changing what it writes.
  const migrate = raw => normalise(raw);
  const list = project => Array.isArray(project?.outputJobs) ? project.outputJobs.filter(j => plain(j) && str(j.name)) : [];
  const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  const find = (project, name) => list(project).find(j => same(j.name, name)) || null;
  function save(project, set) {
    if (Array.isArray(set?.outputs)) for (const out of set.outputs) {
      if (out?.kind !== "pdf" || !plain(out.options)) continue;
      const lenient = !!(project.atriumCompat?.newer || project.atriumCompat?.readOnly);
      const o = out.options;
      const valid = globalThis.Atrium?.validInfinitePdfOptions?.(o,lenient) ??
        ((o.infiniteLayout === undefined || ["fit","frames","tile"].includes(o.infiniteLayout) || lenient && str(o.infiniteLayout) && o.infiniteLayout.length<=64) &&
         (o.infiniteScale === undefined || Number.isFinite(o.infiniteScale) && o.infiniteScale>0));
      if (!valid) fail("A PDF output needs a supported infinite sheet layout and a positive tile scale.");
    }
    const v = normalise(set);
    if (!Array.isArray(project.outputJobs)) project.outputJobs = [];
    const i = project.outputJobs.findIndex(j => same(j?.name, v.name));
    if (i >= 0) project.outputJobs[i] = v;
    else { if (project.outputJobs.length >= MAX_SETS) fail("A project holds at most " + MAX_SETS + " output job sets."); project.outputJobs.push(v); }
    return v;
  }
  function remove(project, name) {
    const before = list(project).length;
    if (Array.isArray(project.outputJobs)) project.outputJobs = project.outputJobs.filter(j => !same(j?.name, name));
    if (Array.isArray(project.outputJobs) && !project.outputJobs.length) delete project.outputJobs;
    return before !== list(project).length;
  }

  // ---------------------------------------------------------------- presets
  // Board-house layouts come from fab-profiles.js (approximate, like the profiles).
  const FALLBACK_LAYOUTS = {
    JLCPCB: {gerberZip: "{stem}-Gerber.zip", pnp: {style: "jlc", name: "CPL-{stem}.csv"}, bom: {style: "jlc", format: "csv", name: "BOM-{stem}.csv"}, notes: []},
    PCBWay: {gerberZip: "{stem}-Gerber.zip", pnp: {style: "altium", name: "{stem}-PickPlace.csv"}, bom: {style: "pcbway", format: "csv", name: "{stem}-BOM.csv"}, notes: []}
  };
  const layout = vendor => globalThis.AtriumFabProfiles?.outputLayout?.(vendor) || FALLBACK_LAYOUTS[vendor];
  const o = (kind, options = {}, extra = {}) => ({id: kind + (extra.n || ""), kind, enabled: true, options, ...extra});
  function vendorSet(name, vendor, profile, more) {
    const L = layout(vendor);
    return {name, preset: true, fabProfile: profile, package: {mode: "vendor", vendor},
      description: "The files " + vendor + " asks for, laid out flat for its upload form. " + (L.notes || []).join(" "),
      folder: "{project}-{rev}-" + vendor + "-{date}", zip: false, outputs: [
        o("drc", {failOver: 0, format: "html"}),
        o("gerber", {units: L.gerberUnits || "mm", drillUnits: L.drillUnits || "mm", readme: false, pack: L.gerberZip}, {folder: ""}),
        o("bom", {style: L.bom.style, format: L.bom.format, source: "pcb", name: L.bom.name}, {folder: ""}),
        o("pnp", {style: L.pnp.style, units: "mm", name: L.pnp.name}, {folder: ""}),
        ...more,
        o("notes", {vendor}, {folder: ""}),
        o("readme")]};
  }
  // Release presets, in the order the Release page lists them. Each is a template: running it
  // changes nothing; editing one and saving makes a project job set ("from" names the preset).
  const PRESETS = () => [
    vendorSet("JLCPCB order", "JLCPCB", "jlcpcb-2l", []),
    vendorSet("PCBWay order", "PCBWay", "pcbway-standard", [o("assembly", {top: true, bottom: true}, {folder: ""})]),
    {name: "Generic fab + assembly", description: "Gerber X2, drill, IPC-2581, BOM, pick and place and assembly drawings for any board house, with the DRC and ERC gates.",
      folder: "{project}-{rev}-{date}", package: {mode: "zip"}, outputs: [
        o("erc", {failOver: 0, level: "Error"}), o("drc", {failOver: 0}), o("gerber"), o("ipc2581"),
        o("bom", {format: "csv"}), o("pnp"), o("assembly"), o("readme")]},
    // The generic set, but a release: every placeholder must be resolved (other sets only warn about them).
    {name: "Release (placeholders resolved)", description: "The generic fabrication and assembly outputs with the DRC and ERC gates, refusing to release while any placeholder is unresolved.",
      folder: "{project}-{rev}-{date}", package: {mode: "zip"}, gates: {placeholders: "block"}, outputs: [
        o("erc", {failOver: 0, level: "Error"}), o("drc", {failOver: 0}), o("gerber"), o("ipc2581"),
        o("bom", {format: "csv"}), o("pnp"), o("assembly"), o("readme")]},
    {name: "Documentation only", description: "For review and archive: schematic and board PDF, drawings, a 3D model, the BOM and the check reports (reports never fail).",
      folder: "{project}-{rev}-docs-{date}", package: {mode: "folder"}, outputs: [
        o("pdf"), o("drawing"), o("step", {format: "step"}), o("bom", {format: "html"}), o("erc", {failOver: null}), o("drc", {failOver: null}), o("readme")]},
    {name: "Everything", description: "Every output Waffle makes: fabrication, assembly, documentation, KiCad, BOM cost and every report, in one ZIP.",
      folder: "{project}-{rev}-{date}", package: {mode: "zip"}, outputs: [
        o("erc", {failOver: 0, level: "Error"}), o("drc", {failOver: 0}),
        o("gerber"), o("ipc2581"), o("bom", {format: "xlsx"}, {label: "BOM (Excel)"}), o("bom", {format: "csv"}, {n: "-csv", label: "BOM (CSV)"}), o("pnp"), o("assembly"),
        o("pdf"), o("drawing"), o("step", {format: "step"}), o("kicad"), o("bomcost", {boards: 1}), o("readme")]}
  ].map(s => ({...normalise(s), preset: true}));
  // v1 preset names. Still resolvable by name (MCP run_output_job, scripts), not listed.
  const LEGACY = () => [
    {name: "Full release", preset: true, description: "Everything for a release: fabrication, assembly, BOM, 3D, IPC-2581, KiCad, documents and checks, in one ZIP.",
      folder: "{project}-{rev}-{date}", zip: true, stopOnFailure: false, outputs: [
        o("erc", {failOver: 0, level: "Error"}), o("drc", {failOver: 0}),
        o("gerber"), o("pnp"), o("assembly"), o("bom", {format: "xlsx"}, {label: "BOM (Excel)"}), o("bom", {format: "csv"}, {n: "-csv", label: "BOM (CSV)"}),
        o("step", {format: "step"}), o("ipc2581"), o("kicad"), o("pdf"), o("readme")]},
    {name: "Review pack", preset: true, description: "For design review: documents, assembly drawings, BOM, a 3D model and the check reports (never fails).",
      folder: "{project}-{rev}-review-{date}", zip: true, outputs: [
        o("pdf"), o("assembly"), o("bom", {format: "html"}), o("step", {format: "glb"}), o("erc", {failOver: null}), o("drc", {failOver: null}), o("readme")]}
  ].map(s => ({...normalise(s), preset: true, legacy: true}));
  function presets(opts={}) {
    const list=PRESETS();
    if (odbAvailable(opts))
      list.push({...normalise({name:"ODB++ fabrication", description:"ODB++ Design 8.1 with the manufacturing readme.",
        folder:"{project}-{rev}-fab-{date}",outputs:[o("odb"),o("readme")]}),preset:true});
    return opts.legacy?[...list,...LEGACY()]:list;
  }
  function resolve(project, ref, opts={}) {
    if (plain(ref)) return normalise(ref);
    const name = String(ref ?? "");
    const all = presets({...opts,legacy:true}), own = find(project, name), s = own || all.find(p => same(p.name, name) || same(p.name, name + " order"));
    if (!s) fail("There is no output job set called " + name + ". Job sets: " + [...list(project).map(j => j.name), ...presets(opts).map(p => p.name + " (preset)")].join(", ") + ".");
    return own ? normalise(s) : {...normalise(s), preset: true};
  }

  // ---------------------------------------------------------------- helpers
  const pad2 = n => String(n).padStart(2, "0");
  const dateText = d => d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  const safe = s => String(s ?? "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim();
  function expand(template, vars) {
    return String(template ?? "").replace(/\{(\w+)\}/g, (m, k) => Object.prototype.hasOwnProperty.call(vars, k) ? safe(vars[k]) : m);
  }
  // A relative path of safe segments ("a/b/c.txt"), never escaping the folder.
  function joinPath(...parts) {
    const segs = [];
    for (const p of parts) for (const s of String(p ?? "").split(/[\\/]+/)) {
      // No hidden or dot-led segments (".git", ".ssh"): they become "_git", "_ssh".
      const t = safe(s).replace(/^\.+$/, "").replace(/^\.+/, "_");
      if (t) segs.push(t);
    }
    return segs.join("/");
  }
  const utf8 = s => globalThis.AtriumZip?.utf8 ? AtriumZip.utf8(s) : new TextEncoder().encode(s);
  const bytesOf = d => d instanceof Uint8Array ? d : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : utf8(String(d ?? ""));

  function sha256(input) {
    const data = bytesOf(input);
    // Hash the visible bytes, independent of a typed-array subclass's subarray implementation.
    return globalThis.AtriumSHA256.bytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  // ---------------------------------------------------------------- generators
  // Each returns {files: [{name, data}], warnings, summary, status?, message?}.
  const need = (name, what) => globalThis[name] || fail(what + " is not available in this build.");
  const FAB_KEYS = ["units", "format", "origin", "layers", "profileWidth", "maskExpansion", "pasteExpansion", "tentVias", "overrideExpansions", "drillUnits", "drillFormat", "drillOrigin", "omitUnconnectedMidLayerPads"];
  function fabOptions(ctx, opt, extra) {
    const out = {date: ctx.date, fileStem: ctx.vars.stem, ...extra};
    for (const k of FAB_KEYS) if (opt[k] !== undefined && opt[k] !== null && opt[k] !== "") out[k] = opt[k];
    return out;
  }
  function collectBOM(ctx, project, options) {
    const B = globalThis.AtriumBOM;
    const sameBoard = project === ctx.project && options.source === "pcb" && options.board === ctx.board?.id;
    // An unapplied project can still have a variant pinned by a BOM view.
    if (!sameBoard || (options.variant !== undefined && project.variantApplied === undefined)) return B.collect(project, options);
    return ctx.pcbBOM ??= B.collect(project, options);
  }
  function preparation(ctx) {
    const F = need("AtriumFabOutputs", "Fabrication output (fab-outputs.js)");
    return ctx.preparation ??= F.createPreparation();
  }
  function panelPreparation(ctx) {
    need("AtriumPanel", "Panelization (panel.js)");
    return preparation(ctx).panelInputs(ctx.project, ctx.panel.id, {date:ctx.date, provenance:ctx.provenance});
  }
  function fabModel(ctx, omitUnconnectedMidLayerPads = false) {
    const prep = preparation(ctx), options = {omitUnconnectedMidLayerPads, provenance:ctx.provenance};
    if (ctx.panel) {
      need("AtriumPanel", "Panelization (panel.js)");
      return prep.panel(ctx.project, ctx.panel.id, {...options,date:ctx.date}).fm;
    }
    return prep.board(ctx.project, ctx.board, {
      ...options, collectBOM: globalThis.AtriumBOM && ((project, settings) => collectBOM(ctx, project, settings))
    }).fm;
  }
  const after = (r, fn) => r && typeof r.then === "function" ? {pending:r.then(fn)} : fn(r);
  const jobFiles = r => r.files.map(f => ({name:f.name, data:f.text ?? f.bytes}));
  function fabFiles(ctx, opt, kinds, extra, finish) {
    const options = fabOptions(ctx, opt, extra);
    if (ctx.translate) return after(ctx.translate(ctx.project, {...options, date:ctx.date.toISOString(),
      documentId:ctx.board.id, panelId:ctx.panel?.id, include:kinds, profileOnly:opt.profileOnly === true}), r =>
      finish({files:jobFiles(r), warnings:r.details.warnings, parts:r.details.files.find(f => f.kind === "pnp")?.stats.components}));
    const F = AtriumFabOutputs, model = fabModel(ctx,options.omitUnconnectedMidLayerPads === true);
    const writers = preparation(ctx), plan = F.plan(model,options,undefined,writers);
    const files = plan.files.filter(f => kinds.includes(f.kind) && (opt.profileOnly !== true || f.layer?.key === "outline"));
    return finish({files:files.map(f => ({name:f.name, data:F.generate(model,plan,f,writers).content})), warnings:F.warnings(model), parts:model.parts.length - (model.dnp?.size || 0)});
  }
  const translatedBy = (translator, generate) => Object.assign(generate, {translator});
  const stepFormat = opt => opt.format === "glb" ? "glb" : "step";
  const GEN = {
    odb: translatedBy("odb", (ctx,opt) => {
      const o={date:ctx.date.toISOString(),units:opt.units,origin:opt.origin,variant:opt.variant,omitUnconnectedMidLayerPads:opt.omitUnconnectedMidLayerPads,
        documentId:ctx.board.id,panelId:ctx.panel?.id,odbEnabled:true};
      const named=opt.name ? safe(expand(opt.name,ctx.vars)) : null;
      if (named && !/\.tgz$/i.test(named)) fail("Name the ODB++ output with a .tgz extension.");
      const count=(n,one,many)=>globalThis.AtriumI18n?.plural?.(n,one,many)??n+" "+(n===1?one:many);
      const done=(files,stats,warnings)=>({
        files:named?files.map(f=>({...f,name:named})):files,warnings,
        summary:"Design 8.1 · "+count(stats.layers,"layer","layers")+" · "+count(Object.keys(stats.steps).length,"step","steps")
      });
      if (ctx.translate) return after(ctx.translate(ctx.project,o),r=>done(jobFiles(r),r.details.stats,r.details.warnings));
      const ODB=need("AtriumODB","ODB++ Design export (odb.js)");
      const source=ctx.provenance, sourced=source && !(Array.isArray(source) && !source.length);
      const effective=ctx.panel || sourced ? ctx : variantContext(ctx,opt);
      const model=ctx.panel || sourced ? undefined : fabModel(effective,o.omitUnconnectedMidLayerPads===true);
      const prepared=sourced ? undefined : {writers:preparation(effective)};
      if (prepared && ctx.panel) prepared.panel = () => {
        const V = globalThis.AtriumVariants, variant = opt.variant;
        if (variant === undefined || V && (variant === null || typeof variant === "string") &&
            V.current(ctx.project,variant)?.id === V.current(ctx.project)?.id) return panelPreparation(ctx);
      };
      const result=ODB.build(ctx.project,ctx.board.id,{...o,model,provenance:source},prepared);
      return done([{name:result.name,data:result.bytes}],result.stats,result.warnings);
    }),
    gerber: translatedBy("fabrication", (ctx, opt) => {
      const kinds = ["gerber"];
      if (opt.profileOnly !== true) {
        if (opt.drill !== false) kinds.push("drill", "drillmap", "drillreport");
        if (opt.readme !== false) kinds.push("readme");
      }
      return fabFiles(ctx, opt, kinds, {pnp:false, assemblyTop:false, assemblyBottom:false, readme:kinds.includes("readme")}, r => {
        if (opt.x2 === false) r.files = r.files.map(f => /\.G[A-Z0-9]+$/i.test(f.name) ? {...f, data:stripX2(f.data)} : f);
        const layers = r.files.filter(f => /\.G[A-Z0-9]+$/i.test(f.name) && !/\.GD1$/i.test(f.name)).length;
        const drills = r.files.filter(f => /\.TXT$/.test(f.name)).length;
        if (opt.pack) {
          const zipName = expand(opt.pack, ctx.vars) || "Gerber.zip";
          return {files:[{name:zipName, data:AtriumZip.create(r.files, {date:ctx.date})}], warnings:r.warnings,
            summary:layers + " layers, " + drills + " drill files in " + zipName};
        }
        return {files:r.files, warnings:r.warnings, summary:layers + " Gerber layers, " + drills + " drill files"};
      });
    }),
    pnp: translatedBy("fabrication", (ctx, opt) => {
      const o = {pnp:true, pnpUnits:opt.units === "mil" ? "mil" : "mm", pnpStyle:opt.style === "jlc" ? "jlc" : "altium", readme:false, assemblyTop:false, assemblyBottom:false};
      return fabFiles(ctx, {origin:opt.origin}, ["pnp"], o, r => {
        if (opt.name) r.files.forEach(f => { f.name = expand(opt.name, ctx.vars); });
        return {files:r.files, warnings:r.warnings.filter(w => /pick and place|Do-not-populate/i.test(w)), summary:r.parts + " placements"};
      });
    }),
    assembly: translatedBy("fabrication", (ctx, opt) => {
      return fabFiles(ctx, {}, ["assembly"], {pnp:false, readme:false, assemblyTop:opt.top !== false, assemblyBottom:opt.bottom !== false}, r =>
        ({files:r.files, warnings:[], summary:r.files.length + " drawing" + (r.files.length === 1 ? "" : "s")}));
    }),
    bom(ctx, opt) {
      const B = need("AtriumBOM", "The bill of materials (bom.js)"), format = ["csv", "xlsx", "html"].includes(opt.format) ? opt.format : "csv";
      const style = opt.style === "jlc" || opt.style === "pcbway" ? opt.style : "default";
      const settings = {now: ctx.date.toISOString()};
      if (opt.view) settings.view = opt.view;
      const source = opt.source || (style !== "default" ? "pcb" : undefined);
      if (source) settings.source = source;
      if (source === "pcb") settings.board = ctx.board.id;
      const LAYOUT = {jlc: [["comment", "Comment"], ["designator", "Designator"], ["footprint", "Footprint"], ["supplierPn", "LCSC Part #"]],
        pcbway: [["designator", "Designator"], ["quantity", "Qty"], ["manufacturer", "Manufacturer"], ["mpn", "Mfg Part #"], ["comment", "Description / Value"], ["footprint", "Package/Footprint"]]}[style];
      if (LAYOUT) { settings.columns = LAYOUT.map(c => c[0]); settings.titleBlock = false; settings.showDnp = false; }
      const merged = B.viewSettings(ctx.project, settings), collected = collectBOM(ctx, ctx.project, merged);
      // A supplier lookup (BOM › Optimise › Assign part numbers) records JLC Basic / Extended: add it as a column.
      if (style === "jlc" && collected.params?.includes("JLC PART TYPE")) { merged.columns = [...merged.columns, "p:JLC PART TYPE"]; LAYOUT.push(["p:JLC PART TYPE", "Basic/Extended Part"]); }
      const r = B.report(ctx.project, merged, collected);
      const warnings = [];
      for (const m of collected.mismatches) if (m.kind === "footprint")
        warnings.push(m.ref + " uses footprint " + m.schematic + " on the schematic and " + m.board + " on the PCB.");
      if (ctx.panel) warnings.push(...need("AtriumPanel", "Panelization (panel.js)").panelBom(ctx.project, ctx.panel, r, ctx.board));
      if (LAYOUT) {
        r.columns.forEach((c, i) => { c.label = LAYOUT[i]?.[1] ?? c.label; });
        if (style === "jlc") {
          // fab-presets: designators joined by "," without spaces, as JLCPCB's sample BOM (R5,R6).
          for (const row of r.rows) if (typeof row[1] === "string") row[1] = row[1].replace(/,\s+/g, ",");
          // JLCPCB assembles by LCSC code (C + digits); another supplier's part number in that column doesn't count.
          const missing = r.rows.filter(row => !/^C\d{3,10}$/i.test(String(row[3] ?? "").trim()));
          if (missing.length) warnings.push(missing.length + " of " + r.rows.length + " BOM line" + (r.rows.length === 1 ? "" : "s") + " have no LCSC part number, so JLCPCB cannot assemble them: " +
            missing.slice(0, 12).map(row => (row[1] || "?") + (row[0] ? " (" + row[0] + ")" : "")).join("; ") + (missing.length > 12 ? "; and " + (missing.length - 12) + " more" : "") +
            ". Starter parts are generic: fill in \"LCSC #\", or use BOM › Optimise › Suppliers and Assign part numbers.");
        }
      }
      const data = format === "xlsx" ? B.xlsx(r) : format === "html" ? B.html(r) : B.csv(r, {bom: style === "default"});
      const name = opt.name ? expand(opt.name, ctx.vars).replace(/\.(csv|xlsx|html)$/i, "") + "." + format : B.fileName(ctx.project.name, format);
      return {files: [{name, data}], warnings, summary: r.lineCount + " lines, " + r.totalParts + " parts" + (opt.view ? " (view " + opt.view + ")" : "")};
    },
    step: translatedBy(stepFormat, (ctx, opt) => {
      const S = need("AtriumSTEP", "3D export (step-export.js)"), o = {format: stepFormat(opt), timestamp: ctx.date.toISOString().slice(0, 19)};
      for (const [k, v] of Object.entries({components: "components", copper: "copper", silkscreen: "silk", vias: "vias", generated: "generated", boardColor: "boardColor", minHole: "minHole"}))
        if (opt[k] !== undefined && opt[k] !== null) o[v] = opt[k];
      if (ctx.translate) return after(ctx.translate(ctx.project, {...o, documentId:ctx.board.id, panelId:ctx.panel?.id}), r =>
        ({files:jobFiles(r), warnings:r.details.notes, summary:(o.format === "glb" ? "glTF" : "STEP") + ", " + r.details.stats.parts + " components"}));
      const r = ctx.panel ? need("AtriumPanel", "Panelization (panel.js)").step(ctx.project, ctx.panel, o) : S.build(ctx.project, ctx.board, o);
      return {files: [{name: r.name, data: r.data}], warnings: r.notes || [], summary: (o.format === "glb" ? "glTF" : "STEP") + ", " + (r.stats?.parts ?? 0) + " components"};
    }),
    kicad: translatedBy("kicad", (ctx, opt) => {
      const files = [], warnings = [];
      if (ctx.translate) {
        const docs = [ctx.board, ...(opt.sheets === false ? [] : ctx.project.documents.filter(d => d.kind === "schematic"))];
        // Output jobs publish the primary board and sheet documents with their established names.
        const take = (r, doc) => {
          const primary = jobFiles(r).find(file => file.name === r.details.name);
          if (!primary) fail("The KiCad document writer returned no primary file.");
          while (files.some(old => old.name === primary.name)) {
            if (doc.kind !== "schematic") fail("Two KiCad documents share the name " + primary.name + ".");
            primary.name = primary.name.replace(/(\.kicad_sch)$/i, "_" + doc.id + "$1");
          }
          files.push(primary);
          warnings.push(...(r.details.diagnostics || []).map(m => doc.kind === "schematic" ? doc.name + ": " + m : m));
        };
        const finish = () => ({files, warnings:[...new Set(warnings)], summary:files.length + " file" + (files.length === 1 ? "" : "s")});
        let pending;
        for (const doc of docs) {
          const write = () => {
            const r = ctx.translate(ctx.project, {scope:"document", documentId:doc.id, primaryOnly:true});
            return r?.then ? r.then(value => take(value, doc)) : take(r, doc);
          };
          pending = pending ? pending.then(write) : write();
        }
        return pending ? {pending:pending.then(finish)} : finish();
      }
      const K = need("AtriumKiCad", "KiCad export (kicad-export.js)"), b = K.exportBoard(ctx.project, ctx.board.id);
      files.push({name: b.name, data: b.content}); warnings.push(...(b.diagnostics || []));
      if (opt.sheets !== false && globalThis.AtriumKiCadSchematic) for (const d of ctx.project.documents.filter(x => x.kind === "schematic")) {
        const s = AtriumKiCadSchematic.exportSheet(ctx.project, d.id);
        let name = s.name;
        while (files.some(f => f.name === name)) name = name.replace(/(\.kicad_sch)$/, "_" + d.id + "$1");
        files.push({name, data: s.content}); warnings.push(...(s.diagnostics || []).map(m => d.name + ": " + m));
      }
      return {files, warnings: [...new Set(warnings)], summary: files.length + " file" + (files.length === 1 ? "" : "s")};
    }),
    ipc2581: translatedBy("ipc2581", (ctx, opt) => {
      const X = need("AtriumIPC2581", "IPC-2581 export (ipc2581.js)");
      const o = {date:ctx.date.toISOString(), units:opt.units, impedance:opt.impedance === true, revision:ctx.vars.rev};
      if (ctx.translate) return after(ctx.translate(ctx.project, {...o, documentId:ctx.board.id, panelId:ctx.panel?.id}), r => {
        const {stats, warnings, revision, check} = r.details;
        return {files:jobFiles(r), warnings:[...new Set([...warnings, ...check.warnings])],
          summary:"rev " + revision + ": " + stats.components + " components, " + stats.pads + " pads, " + stats.holes + " holes, structural check passed"};
      });
      const r = X.build(ctx.project, ctx.board, {...o, model:fabModel(ctx), date:ctx.date});
      const c = X.check(r.content);
      const warnings = [...new Set(r.warnings)];
      if (!c.ok) return {files: [{name: r.name, data: r.content}], warnings, status: "error", message: "The IPC-2581 file failed the structural check: " + c.errors.slice(0, 3).join("; "), summary: "structural check failed"};
      return {files: [{name: r.name, data: r.content}], warnings: [...warnings, ...c.warnings],
        summary: "rev " + r.revision + ": " + r.stats.components + " components, " + r.stats.pads + " pads, " + r.stats.holes + " holes, structural check passed"};
    }),
    pdf(ctx, opt) {
      // AtriumPrint.exportPDF (print.js: schematic sheets and board layer sets
      // drawn by the editor's renderer), else an AtriumPDF entry point.
      const Pr = globalThis.AtriumPrint, P = globalThis.AtriumPDF;
      if (!P && !Pr) return {files: [], warnings: [], status: "skipped", message: "The PDF module is not loaded in this build.", summary: "skipped"};
      const fn = typeof Pr?.exportPDF === "function" ? Pr.exportPDF.bind(Pr) : [P?.export, P?.build, P?.exportPDF].find(f => typeof f === "function")?.bind(P);
      if (!fn) return {files: [], warnings: [], status: "skipped", message: "PDF output needs the print module (print.js).", summary: "skipped"};
      const base = opt.name ? expand(opt.name, ctx.vars).replace(/\.pdf$/i, "") : safe(ctx.vars.project);
      const finish = r => {
        const items = (Array.isArray(r) ? r : [r]).filter(Boolean).map((x, i) => x instanceof Uint8Array || str(x)
          ? {name: base + (i ? "-" + (i + 1) : "") + ".pdf", data: x} : {name: x.name || base + ".pdf", data: x.data ?? x.bytes ?? x.content, warnings: x.notes || x.warnings});
        return {files: items.map(x => ({name: x.name, data: x.data})), warnings: items.flatMap(x => x.warnings || []), summary: items.length + " PDF file" + (items.length === 1 ? "" : "s")};
      };
      const o = {attachments:!!(ctx.preparePDF || globalThis.AtriumNetlistText), ...opt, date: ctx.date, title: ctx.project.name, board: ctx.board?.id, signal: ctx.signal};
      delete o.name;
      const r = ctx.preparePDF && Pr?.preparePDF ? Pr.preparePDF(ctx.project,o,ctx.pdfProviders) : fn(ctx.project,o);
      return r && typeof r.then === "function" ? {pending: r.then(finish)} : finish(r);
    },
    drawing(ctx, opt) {
      const DR = globalThis.AtriumDrawing;
      if (!DR) return {files: [], warnings: [], status: "skipped", message: "Drawing output needs the drawing module (drawing.js).", summary: "skipped"};
      const want = str(opt.drawings) ? opt.drawings.split(",").map(s => s.trim()).filter(Boolean) : Array.isArray(opt.drawings) ? opt.drawings : [];
      if (!ctx.project.documents.some(d => d.kind === "drawing")) return {files: [], warnings: [], status: "skipped", message: "The project has no drawings.", summary: "skipped"};
      const r = DR.build(ctx.project, {documents: want, paper: opt.paper || undefined, date: ctx.date});
      const base = opt.name ? expand(opt.name, ctx.vars).replace(/\.pdf$/i, "") : safe(ctx.vars.project) + "-Drawings";
      return {files: [{name: base + ".pdf", data: r.bytes()}], warnings: r.notes, summary: r.pages.length + " page" + (r.pages.length === 1 ? "" : "s") + ", embedded font"};
    },
    notes(ctx, opt) {
      const PN = need("AtriumPanel", "Order notes (panel.js)"), vendor = opt.vendor || (ctx.fabProfile && layout(ctx.fabProfile)?.vendor) || "";
      const r = PN.orderNotes(ctx.project, ctx.panel || ctx.board, {date: ctx.date, vendor, fabProfile: ctx.fabProfile || undefined});
      const name = expand(opt.name || layout(vendor)?.orderNotes || "{stem}-Order-Notes.txt", ctx.vars);
      return {files: [{name, data: r.text}], warnings: [], summary: r.facts.layers + " layers, min track " + (r.facts.minTrack ?? "n/a") + " mm" + (ctx.panel ? ", panel " + ctx.panel.name : "")};
    },
    drc(ctx, opt) {
      const R = need("AtriumRules", "Design rules (rules.js)"), doc = ctx.board;
      const prepared = R.reportInput(doc, {project: ctx.project, limit: opt.limit ?? 2000, cache: ctx});
      const {result, waived, warnings} = prepared, W = globalThis.AtriumDRCWaivers;
      const name = safe(doc.name) + " DRC." + (opt.format === "json" ? "json" : "html");
      let data;
      if (opt.format !== "json" && globalThis.AtriumDRC?.report) {
        data = AtriumDRC.report(result, {board: doc.name, project: ctx.project.name, rules: R.effective?.(doc, ctx.project) || null, date: ctx.date});
        if (waived.length && W.reportSection) data = data.replace("</body></html>", W.reportSection(waived) + "</body></html>");
      } else data = JSON.stringify({board: doc.name, total: result.total, rules: result.rules, notes: result.notes, violations: result.violations.map(v => ({type: v.type, rule: v.ruleName, title: v.title, at: v.at || null})),
        waived: waived.map(({violation: v, waiver: w}) => ({type: v.type, rule: v.ruleName, title: v.title, at: v.at || null, waiver_id: w.id, note: w.note || ""}))}, null, 2) + "\n";
      return threshold({files: [{name, data}], warnings, summary: result.total + " violation" + (result.total === 1 ? "" : "s") + (waived.length ? " (" + waived.length + " waived)" : "") + ", " + result.rules.length + " rules"},
        result.total, opt.failOver, ["rule violation", "rule violations"]);
    },
    erc(ctx, opt) {
      const ERC = need("AtriumERC", "The electrical rules check (erc.js)");
      const r = ERC.run(ctx.project, ctx.calculationSnapshot ? {calculationSnapshot: ctx.calculationSnapshot} : undefined);
      const levels = opt.level === "Warning" ? ["Fatal", "Error", "Warning"] : ["Fatal", "Error"];
      const counted = r.messages.filter(m => m.check !== "summary" && levels.includes(m.class));
      const name = safe(ctx.project.name) + " ERC." + (opt.format === "json" ? "json" : "html");
      const rows = r.messages.filter(m => m.check !== "summary");
      const data = opt.format === "json" ? JSON.stringify({passed: r.passed, complete:r.complete, diagnostics:r.diagnostics, summary: r.summary, counts: r.counts,
        messages: rows.map(m => ({class: m.class, check: m.check, text: m.text, document: m.documentId ?? null}))}, null, 2) + "\n"
        : htmlReport("Electrical Rule Check", ctx, r.summary || "", ["Class", "Check", "Message"], rows.map(m => [m.class, m.check, m.text]));
      return threshold({files: [{name, data}], warnings: [], summary: counted.length + " " + (opt.level === "Warning" ? "warnings or errors" : "errors") + ", " + rows.length + " messages"}, counted.length, opt.failOver, ["ERC message", "ERC messages"]);
    }
  };
  // BOM cost: one line per BOM row, priced from the parts' own parameters. Lines with no price are
  // listed and warned about, never priced as zero silently.
  const PRICE_KEYS = ["UNIT PRICE", "UNITPRICE", "PRICE", "COST", "UNIT COST"];
  const priceOf = p => { for (const k of PRICE_KEYS) { const v = parseFloat(String(p.params?.[k] ?? "").replace(/[^\d.eE+-]/g, "")); if (Number.isFinite(v) && v >= 0) return v; } return null; };
  GEN.bomcost = (ctx, opt) => {
    const B = need("AtriumBOM", "The bill of materials (bom.js)"), boards = Math.max(1, Math.min(1e6, Number.isInteger(opt.boards) ? opt.boards : 1));
    const collected = B.collect(ctx.project, {source: opt.source || undefined, board: ctx.board?.id}), rows = B.build(collected, {}).filter(r => !r.dnp);
    const cur = str(opt.currency) ? opt.currency.trim().slice(0, 8) : "", money = v => v == null ? "" : (Math.round(v * 10000) / 10000).toFixed(v < 1 ? 4 : 2);
    let total = 0, priced = 0;
    const lines = rows.map(r => {
      const unit = r.parts.map(priceOf).find(v => v != null) ?? null, qty = r.parts.length * boards, ext = unit == null ? null : unit * qty;
      if (ext != null) { total += ext; priced++; }
      return [r.refs.join(" "), r.values.comment ?? "", r.parts.find(p => p.mpn)?.mpn || "", r.parts.length, qty, money(unit), money(ext)];
    });
    const missing = rows.length - priced, warnings = missing ? [missing + " of " + rows.length + " BOM line" + (rows.length === 1 ? "" : "s") + " have no unit price (add a \"Unit Price\" parameter, or use BOM › Optimise)."] : [];
    const head = ["Designators", "Comment", "MPN", "Per board", "Quantity", "Unit price" + (cur ? " (" + cur + ")" : ""), "Extended" + (cur ? " (" + cur + ")" : "")];
    const summary = (priced ? "total " + money(total) + (cur ? " " + cur : "") + " for " + boards + " board" + (boards === 1 ? "" : "s") : "no prices") + ", " + priced + "/" + rows.length + " lines priced";
    const name = safe(ctx.project.name) + " BOM cost." + (opt.format === "csv" ? "csv" : "html");
    const data = opt.format === "csv" ? [head, ...lines, ["Total", "", "", "", "", "", money(total)]].map(r => r.map(c => B.csvCell ? B.csvCell(c) : String(c)).join(",")).join("\r\n") + "\r\n"
      : htmlReport("BOM cost", ctx, summary, head, [...lines, ["Total", "", "", "", "", "", money(total)]]);
    return {files: [{name, data}], warnings, summary};
  };
  function threshold(res, count, limit, what) {
    if (limit == null || limit === "") return res;
    const n = typeof limit === "number" ? limit : str(limit) && /^\s*\d+\s*$/.test(limit) ? Number(limit) : NaN;
    if (!Number.isFinite(n) || n < 0) { res.status = "failed"; res.message = "The gate threshold " + JSON.stringify(limit) + " is not a whole number."; }
    else if (count > n) { res.status = "failed"; res.message = count + " " + (count === 1 ? what[0] : what[1]) + " (more than " + n + ")."; }
    return res;
  }
  const escHTML = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"})[c]);
  function htmlReport(title, ctx, summary, head, rows) {
    return "<!doctype html><html lang=en><head><meta charset=utf-8><title>" + escHTML(title + " · " + ctx.project.name) + "</title><style>:root{color-scheme:light dark}" +
      "body{margin:24px;font:13px/1.45 system-ui,sans-serif}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #8884;padding:4px 8px;text-align:left;vertical-align:top}</style></head><body>" +
      "<h1>" + escHTML(title) + "</h1><p>" + escHTML(ctx.project.name + " · " + ctx.date.toISOString().slice(0, 19).replace("T", " ") + " UTC · " + summary) + "</p><table><thead><tr>" +
      head.map(h => "<th>" + escHTML(h) + "</th>").join("") + "</tr></thead><tbody>" + rows.map(r => "<tr>" + r.map(v => "<td>" + escHTML(v) + "</td>").join("") + "</tr>").join("") + "</tbody></table></body></html>\n";
  }

  // ---------------------------------------------------------------- runner
  function context(project, set, opts) {
    if (!project || !Array.isArray(project.documents)) fail("Open a project first.");
    const boards = project.documents.filter(d => d.kind === "pcb");
    const panelRef = opts.panel ?? set.panel, panel = panelRef ? project.documents.find(d => d.kind === "panel" && (d.id === panelRef || d.name === panelRef)) || fail("The project has no panel " + panelRef + ".") : null;
    const board = set.board ? boards.find(d => d.id === set.board) : panel ? boards.find(d => d.id === panel.panel?.board) || boards[0] : boards[0];
    if (set.board && !board) fail("The job set's board " + set.board + " is not in the project.");
    const date = opts.date instanceof Date ? opts.date : opts.date ? new Date(opts.date) : new Date();
    if (!Number.isFinite(date.getTime())) fail("Use an ISO 8601 date such as 2026-01-31T12:00:00Z.");
    const param = o => o?.parameters && (o.parameters.Revision ?? o.parameters.REVISION ?? o.parameters.Rev);
    // project.revision is the hook for board revisions (another module may manage it); the
    // Revision parameter is the v1 source.
    const hook = v => str(v) && v.trim() ? v.trim() : plain(v) && str(v.letter) && v.letter.trim() ? v.letter.trim() : null;
    const rev = String(opts.revision ?? set.revision ?? hook(project.revision) ?? param(project) ?? param(board) ?? "1");
    const vars = {project: project.name || "Project", board: board?.name || "Board", rev, date: dateText(date), time: pad2(date.getHours()) + pad2(date.getMinutes()), job: set.name};
    // The fab dialog's file stem (fab-outputs.js defaultStem): project name slugified, + board when there are several.
    const F = globalThis.AtriumFabOutputs;
    vars.stem = F?.defaultStem && board ? F.defaultStem(project, board) : vars.board;
    vars.folder = joinPath(expand(set.folder, vars));
    if (panel) vars.panel = panel.name;
    return {project, board, boards, panel, fabProfile: set.fabProfile || null, date, vars, connections: null,
      calculationSnapshot: opts.calculationSnapshot, preparePDF: opts.preparePDF, pdfProviders: opts.pdfProviders, signal: opts.signal,
      odbEnabled:odbAvailable(opts), provenance:opts.provenance,

      ...(opts.translate ? {translate:(id, p, o) => opts.translate(id, p, {...o, provenance:opts.provenance})} : {})};
  }
  const BOARD_KINDS = new Set(["gerber", "pnp", "assembly", "step", "kicad", "ipc2581", "odb", "drc", "notes"]);
  // RS-274X without X2: drop the %TF/%TA/%TO/%TD attribute commands, each on its own line (fab-presets).
  function stripX2(data) {
    const s = typeof data === "string" ? data : new TextDecoder().decode(data), out = s.replace(/^%T[FAOD][^\n]*\n/gm, "");
    return typeof data === "string" ? out : new TextEncoder().encode(out);
  }
  // A vendor package fills in the board house's layout where the set leaves an option or folder unset.
  function vendorFill(set) {
    if (set.package?.mode !== "vendor") return set;
    const L = layout(set.package.vendor);
    if (!L) return set;
    const fill = {gerber: {pack: L.gerberZip, readme: false, units: L.gerberUnits, drillUnits: L.drillUnits, x2: L.x2 /* fab-presets */}, bom: {style: L.bom.style, format: L.bom.format, source: "pcb", name: L.bom.name},
      pnp: {style: L.pnp.style, name: L.pnp.name}, notes: {vendor: set.package.vendor}, odb:{name:L.odbName||"{stem}-ODB.tgz",units:L.gerberUnits}};
    return {...set, fabProfile: set.fabProfile || ({JLCPCB: "jlcpcb-2l", PCBWay: "pcbway-standard"})[set.package.vendor], outputs: set.outputs.map(out => {
      const f = fill[out.kind];
      if (!f) return out;
      const options = {...out.options};
      for (const [k, v] of Object.entries(f)) if (v !== undefined && (options[k] === undefined || options[k] === "")) options[k] = v;
      return {...out, folder: out.folder ?? "", options};
    })};
  }
  // The DFM gate checks the mask and legend films selected by each Gerber
  // output. Use the runner's board selection and the writer's option defaults.
  function gerberMaskContext(project, set) {
    const resolved = vendorFill(set), selected = resolved.outputs.filter(out => out.enabled !== false && out.kind === "gerber");
    if (!selected.length) return null;
    const ctx = context(project, resolved, {});
    return ctx.board && {board: ctx.board, panel: ctx.panel, multiple: selected.length > 1, settle: () => gerberMaskPolicies(ctx, selected)};
  }
  function gerberMaskPolicies(ctx, selected) {
    const F = need("AtriumFabOutputs", "Fabrication output (fab-outputs.js)");
    const policies = new Map(), labels = selected.map(out => out.label || out.id);
    selected.forEach((out, i) => {
      if (out.options?.profileOnly === true) return;
      const {maskExpansion, tentVias, overrideExpansions, layers} = F.settle(fabOptions(ctx, out.options || {}, {}));
      const faces = {Top: Boolean(layers.GTS ?? true), Bottom: Boolean(layers.GBS ?? true)};
      if (!faces.Top && !faces.Bottom) return;
      const silk = {top: Boolean(layers.GTO ?? true), bottom: Boolean(layers.GBO ?? true)};
      const key = JSON.stringify([maskExpansion, !!tentVias, !!overrideExpansions, faces, silk]);
      if (!policies.has(key)) policies.set(key, {maskExpansion, tentVias, overrideExpansions, faces, silk, outputs: []});
      const label = labels[i];
      policies.get(key).outputs.push(labels.indexOf(label) === labels.lastIndexOf(label) ? label : label + " (" + out.id + ")");
    });
    return [...policies.values()];
  }
  function begin(project, ref, opts) {
    const set = vendorFill(resolve(project, ref, opts)), ctx = context(project, set, opts);
    // README steps run last wherever they sit, so the manifest lists every file.
    const steps = set.outputs.map(out => ({out, label: out.label || KINDS[out.kind]?.label || out.kind})).sort((a, b) => (a.out.kind === "readme") - (b.out.kind === "readme"));
    return {set, ctx, steps, entries: [], report: {job: set.name, preset: !!set.preset, board: ctx.board?.name || null, board_id: ctx.board?.id || null, panel: ctx.panel?.name || null, date: ctx.date.toISOString(),
      revision: ctx.vars.rev, folder: ctx.vars.folder, zip: null, ok: true, failed: [], outputs: [], warnings: [], ms: 0}};
  }
  function settleStep(run, step, res, ms, err) {
    const {out, label} = step, kind = KINDS[out.kind];
    const row = {id: out.id, kind: out.kind, label, status: "ok", files: [], warnings: [], summary: "", message: "", ms};
    if (err) { row.status = "error"; row.message = err.message || String(err); }
    else {
      row.status = res.status || (res.warnings?.length ? "warning" : "ok");
      if (res.translationReports?.length) row.translationReports = res.translationReports;
      row.warnings = res.warnings || []; row.summary = res.summary || ""; row.message = res.message || "";
      const sub = out.folder != null ? expand(out.folder, run.ctx.vars) : kind?.folder || "";
      for (const f of res.files || []) {
        const path = joinPath(sub, f.name), data = f.data;
        if (run.entries.some(e => e.path === path)) { row.warnings.push("Two outputs wrote " + path + "; the later one was kept."); run.entries = run.entries.filter(e => e.path !== path); }
        run.entries.push({path, data, output: out.id});
        row.files.push(path);
      }
    }
    if (row.status === "failed" || row.status === "error") { run.report.ok = false; run.report.failed.push(out.id); }
    run.report.outputs.push(row);
    return row;
  }
  function skip(run, step, why) { return settleStep(run, step, {status: "skipped", message: why, summary: "skipped"}, 0); }
  // Assembly variants (variants.js): an output's options.variant (id or name; "" or null for the
  // base design) runs it on that variant; without it outputs follow the project's active variant.
  function variantContext(ctx, opt) {
    const V = globalThis.AtriumVariants;
    if (!V || opt.variant === undefined) return ctx;
    const key = opt.variant == null ? "" : String(opt.variant);
    if (!ctx.variantContexts) ctx.variantContexts = new Map();
    if (!ctx.variantContexts.has(key)) {
      const project = V.forOutput(ctx.project, opt.variant);
      ctx.variantContexts.set(key, project === ctx.project ? ctx : {...ctx, project, board: ctx.board && project.documents.find(d => d.id === ctx.board.id),
        boards: project.documents.filter(d => d.kind === "pcb"), pcbBOM:null, preparation:null, connections:null, variantContexts:null});
    }
    const scoped = ctx.variantContexts.get(key);
    if (scoped !== ctx) Object.assign(scoped, {date:ctx.date, panel:ctx.panel, provenance:ctx.provenance});
    return scoped;
  }
  // One step: generator result, or {pending} for asynchronous outputs.
  function produce(run, step) {
    const {out} = step;
    if (!out.enabled) return {skip: "Disabled."};
    if (out.kind === "odb" && !run.ctx.odbEnabled) return {skip:"ODB++ output is disabled in Experimental features."};
    // The README still runs, so the folder says what failed.
    if (out.kind === "readme") return {readme: true};
    if (run.report.failed.length && run.set.stopOnFailure) return {skip: "Not run: an earlier output failed."};
    const gen = GEN[out.kind];
    if (!gen) return {skip: "Unknown output kind " + out.kind + " (from a newer Waffle?)."};
    if (BOARD_KINDS.has(out.kind) && !run.ctx.board) return {skip: "The project has no PCB layout."};
    const ctx = out.kind==="odb" ? run.ctx : variantContext(run.ctx,out.options||{});
    return {res:ctx.translate ? translatedOutput(ctx, out, ctx.translate) : gen(ctx, out.options || {})};
  }
  // The bytes written are the bytes hashed: text is encoded once (lone surrogates become U+FFFD).
  function digestOf(e) {
    if (!e.sha) { if (typeof e.data === "string") e.data = utf8(e.data); e.sha = sha256(e.data); }
    return e.sha;
  }
  function manifest(run, out) {
    const opt = out.options || {}, lines = [], rows = run.entries.map(e => ({path: e.path, bytes: bytesOf(e.data), sha: digestOf(e), output: e.output}));
    const ctx = run.ctx, rep = run.report;
    lines.push(ctx.vars.job + " — " + ctx.vars.project, "",
      "Board:     " + (ctx.board?.name || "none"), "Revision:  " + ctx.vars.rev, "Date:      " + rep.date, "Generator: Waffle output job set" + (rep.preset ? " (preset)" : ""), "",
      "Outputs:");
    for (const r of rep.outputs) lines.push("  [" + r.status.toUpperCase() + "] " + r.label + (r.summary ? " — " + r.summary : "") + (r.message ? " — " + r.message : ""));
    const warn = rep.outputs.flatMap(r => r.warnings.map(w => r.label + ": " + w));
    if (warn.length) { lines.push("", "Warnings:"); for (const w of warn) lines.push("  - " + w); }
    lines.push("", "Files (SHA-256, bytes, path):");
    const sums = rows;
    for (const r of sums) lines.push("  " + r.sha + "  " + String(r.bytes.length).padStart(9) + "  " + r.path);
    lines.push("", "Check with: shasum -a 256 -c SHA256SUMS (macOS) or sha256sum -c SHA256SUMS (Linux), from this folder.", "");
    const files = [{name: "README.txt", data: lines.join("\n")}];
    if (opt.sums !== false) files.push({name: "SHA256SUMS", data: sums.map(r => r.sha + "  " + r.path).join("\n") + "\n"});
    return {files, warnings: [], summary: sums.length + " files listed with SHA-256"};
  }
  function finish(run, opts, started) {
    const {ctx, set, report} = run;
    // File sizes and checksums for the report.
    // Hashed once per entry (README already did it); a host that hashes the written files
    // itself (MCP, Python hashlib) passes reportHashes: false and fills them in.
    const sized = new Map(run.entries.map(e => [e.path, {bytes: bytesOf(e.data).length, ...(e.sha || opts.reportHashes !== false ? {sha256: digestOf(e)} : {})}]));
    for (const r of report.outputs) r.files = r.files.map(p => ({name: p, ...sized.get(p)}));
    report.warnings = report.outputs.flatMap(r => r.warnings.map(w => r.label + ": " + w));
    let files = run.entries.map(e => ({name: joinPath(ctx.vars.folder, e.path), data: e.data}));
    if (set.zip) {
      if (!globalThis.AtriumZip) fail("ZIP support is unavailable in this build.");
      const name = joinPath(expand(set.zipName || "{folder}.zip", ctx.vars) || "outputs.zip");
      const data = AtriumZip.create(files, {date: ctx.date});
      report.zip = {name, bytes: data.length, sha256: sha256(data)};
      files = [{name, data}];
    }
    report.ms = Math.round(Date.now() - started);
    return {files: opts.files === false ? files.map(f => ({name: f.name})) : files, report};
  }
  function run(project, ref, opts = {}) {
    const started = Date.now(), r = begin(project, ref, opts);
    for (const step of r.steps) {
      const t0 = Date.now();
      let p;
      try { p = produce(r, step); } catch (e) { settleStep(r, step, null, Date.now() - t0, e); continue; }
      if (p.skip) skip(r, step, p.skip);
      else if (p.readme) settleStep(r, step, manifest(r, step.out), Date.now() - t0);
      else if (p.res.pending) { p.res.pending.catch(() => {}); settleStep(r, step, null, Date.now() - t0, Error("This output runs asynchronously; use runAsync (the editor does).")); }
      else settleStep(r, step, p.res, Date.now() - t0);
    }
    return finish(r, opts, started);
  }
  // Outputs that plot the board's copper pours.
  const COPPER_KINDS = new Set(["gerber", "ipc2581", "odb", "step", "pdf", "drawing", "assembly"]);
  // Before any file is made, the board's copper pours settle to the exact fill (polygon-pour.js settle:
  // in the editor it waits for the live repour or runs Repour All with its progress display). Elsewhere
  // it resolves at once and the fabrication analysis fills out-of-date pours on a copy, so no output
  // ever plots stale copper or leaves it out. A cancel (opts.signal) during the fill rejects with an
  // AbortError: no file has been made. progress({phase: "pours", done, total}).
  async function settle(project, ref, opts = {}, progress) {
    const P = globalThis.AtriumPolygonPour;
    if (!P?.settle) return null;
    const set=resolve(project,ref,opts), ctx=context(project,set,opts), {board}=ctx;
    if (!board || !set.outputs.some(o=>o.enabled!==false&&COPPER_KINDS.has(o.kind)&&(o.kind!=="odb"||ctx.odbEnabled))) return null;
    return P.settle(board, new Map((project.library || []).map(d => [d.id, d])), {project, signal: opts.signal,
      onProgress: p => progress?.({phase: "pours", done: p.done, total: p.total, label: "Copper pours"})});
  }
  async function runAsync(project, ref, opts = {}, progress) {
    if (opts.settle !== false) await settle(project, ref, opts, progress);
    const set = resolve(project, ref, opts);
    if (!opts.signal?.aborted && !opts.calculationSnapshot && set.outputs.some(o => o.enabled !== false && o.kind === "erc")) {
      const calculationSnapshot = await globalThis.AtriumERC?.prepareCalculations?.(project, {signal: opts.signal});
      if (calculationSnapshot) opts = {...opts, calculationSnapshot};
    }
    const started = Date.now(), r = begin(project, set, {...opts, preparePDF:true}), total = r.steps.length;
    for (let i = 0; i < total; i++) {
      const step = r.steps[i], t0 = Date.now();
      progress?.({index: i, total, label: step.label, kind: step.out.kind, id: step.out.id, phase: "start"});
      await new Promise(resolve => setTimeout(resolve, 0));
      let row;
      try {
        if (opts.signal?.aborted) { row = skip(r, step, "Cancelled."); progress?.({index: i, total, label: step.label, kind: step.out.kind, id: step.out.id, phase: "done", row, files: []}); continue; }
        const p = opts.intercept && step.out.enabled && step.out.kind !== "readme" && GEN[step.out.kind] && !(r.report.failed.length && r.set.stopOnFailure) && !(BOARD_KINDS.has(step.out.kind) && !r.ctx.board)
          && (step.out.kind!=="odb"||r.ctx.odbEnabled)
          ? await opts.intercept(step.out,r.ctx,()=>produce(r,step),step.out.kind==="odb"?r.ctx:variantContext(r.ctx,step.out.options||{})) : produce(r,step);
        if (p.skip) row = skip(r, step, p.skip);
        else if (p.readme) row = settleStep(r, step, manifest(r, step.out), Date.now() - t0);
        else { row = settleStep(r, step, p.res.pending ? await p.res.pending : p.res, Date.now() - t0); if (p.cached) row.cached = true; }
      } catch (e) { row = settleStep(r, step, null, Date.now() - t0, e); }
      progress?.({index: i, total, label: step.label, kind: step.out.kind, id: step.out.id, phase: "done", row, files: r.entries.filter(e => e.output === step.out.id).map(e => ({name: e.path, data: e.data}))});
    }
    if (opts.signal?.aborted) r.report.ok = false;
    return finish(r, opts, started);
  }
  function outputTranslator(out) {
    const id = GEN[out.kind]?.translator;
    return typeof id === "function" ? id(out.options || {}) : id;
  }
  function translatorNeeds(job, opts = {}) {
    const ids = new Set();
    for (const out of job.outputs) {
      if (!out.enabled || out.kind === "odb" && !odbAvailable(opts)) continue;
      const id = outputTranslator(out);
      if (id) ids.add(id);
    }
    return [...ids];
  }
  function translatedOutput(ctx, out, translate) {
    const id = outputTranslator(out), generate = GEN[out.kind];
    if (!id) return generate(ctx, out.options || {});
    const reports = [];
    const capture = r => { reports.push(r.report); return r; };
    const send = (model, options) => {
      const r = translate(id, model, options);
      return r?.then ? r.then(capture) : capture(r);
    };
    const res = generate({...ctx, translate:send}, out.options || {});
    const finish = r => reports.length ? {...r, translationReports:reports} : r;
    return res.pending ? {pending:res.pending.then(finish)} : finish(res);
  }
  // One output at a time on a shared context, reusing the fabrication model.
  function session(project, ref, opts = {}) {
    const r = begin(project, ref, {...opts,preparePDF:true});
    return {ctx: r.ctx, set: r.set, async generate(out) {
      const p = produce(r, {out, label: out.label || KINDS[out.kind]?.label || out.kind});
      if (p.skip || p.readme) return {files: [], warnings: [], status: "skipped", message: p.skip || "README runs with the whole job.", summary: "skipped"};
      return p.res.pending ? await p.res.pending : p.res;
    }};
  }
  // The planned layout without generating anything (for previews and MCP plan).
  function describe(project, ref, opts = {}) {
    const set = resolve(project, ref, opts), ctx = context(project, set, opts);
    return {name: set.name, folder: ctx.vars.folder, zip: set.zip ? joinPath(expand(set.zipName || "{folder}.zip", ctx.vars)) : null, board: ctx.board?.name || null,
      outputs: set.outputs.map(o => ({id: o.id, kind: o.kind, label: o.label || KINDS[o.kind]?.label || o.kind, enabled: o.enabled,
        folder: o.folder != null ? expand(o.folder, ctx.vars) : KINDS[o.kind]?.folder ?? "", available: o.kind==="odb" ? ctx.odbEnabled : !KINDS[o.kind]?.needs || !!globalThis[KINDS[o.kind].needs]}))};
  }

  // ---------------------------------------------------------------- Release page
  // File › Release… (the "output-jobs" action) opens the Release page (release-ui.js), which
  // loads with release.js and release-preview.js on first use. Registered here so the eager
  // index.html stays the same size.
  globalThis.AtriumLazy?.register?.("AtriumReleaseUI", {scripts: ["workers/release-worker-modules.js", "formats/release.js", "formats/release-preview.js", "formats/release-ui.js"], deps: ["AtriumOutputJobs", "AtriumDFM", "AtriumWorkerPool"]}); // fab-presets: the DFM gate; worker-pool.js starts release-worker.js
  async function open(ctx, options) {
    const UI = globalThis.AtriumReleaseUI || (globalThis.AtriumLazy ? await AtriumLazy.need("AtriumReleaseUI") : null);
    if (!UI) { ctx?.info?.("The Release page is not available in this build."); return null; }
    return UI.open(ctx, options);
  }

  return Object.freeze({VERSION, KINDS, ORDER, GROUPS, GATES, VENDORS, groupOf, defaultsOf, normalise, migrate, packageOf, list, find, save, remove, presets, resolve,
    expand, joinPath, safe, dateText, sha256, utf8, bytesOf, run, runAsync, settle, session, translatedOutput, translatorNeeds, describe, layout, open, gerberMaskContext});
})();
