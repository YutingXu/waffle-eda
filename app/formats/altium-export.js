"use strict";
// File › Export › Altium Project (ASCII)… (action "export-altium"). PREVIEW.
//
// Writes an Altium Designer® project as plain text: a .PrjPcb project file, one ASCII .SchDoc per
// schematic sheet and one ASCII .PcbDoc per board, in a store-only zip. The record layout
// (|KEY=value| lines; schematic RECORD numbers; PCB RECORD names; 10 mil schematic units with
// _FRAC parts; mil PCB units with Y up) comes from public descriptions of the format and from
// Waffle's own Altium importers (sch-import.js, pcb-import.js), which serve as the round-trip
// oracle in tests/altium-export.cjs. Native Designer checks PiDP-11 schematic records and the
// names, kinds, priorities and scopes of modern DXPRule records. See docs/importing.md for the
// native controls and CONTRIBUTING.md for permitted sources.
//
// Lazy: app/lazy.js loads this file on the first use of the action; the editor's lazy gate runs
// the action once it has registered. DOM-free except open().
//
//   AtriumAltiumExport.exportProject(project) -> {name, files:[{name, content, bytes}], bytes (zip),
//                                                 diagnostics, counts}
//   AtriumAltiumExport.exportSchematic(project, doc) / exportBoard(project, doc) -> {name, content, bytes, diagnostics, counts}
globalThis.AtriumAltiumExport = (() => {
  const A = () => globalThis.Atrium;
  const MIL = .0254, DXP = .254, FRAC = .00000254;
  const stepNotice = "Altium Designer can open ASCII STEP body references as plain extrusions, even with the STEP files beside the board. To restore a body in Altium, open its 3D Body properties, choose Embed Model and select its STEP file. Check the position and rotation.";
  const nativeBodyRoute = "For an imported binary PCB, choose File → Export → Export Design… → Altium source copy and select the original .PcbDoc to preserve embedded models with supported edits.";
  // ---------------------------------------------------------------- text encoding
  // ASCII Altium files are read as Windows-1252. A value with characters outside it is written
  // twice, as Altium does: KEY= with "?" for those characters, and %UTF8%KEY= with the value's
  // UTF-8 bytes (one file character per byte). "|" separates fields and line breaks end records,
  // so both are replaced in values.
  const CP1252 = {0x20ac: 0x80, 0x201a: 0x82, 0x192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x2c6: 0x88, 0x2030: 0x89, 0x160: 0x8a, 0x2039: 0x8b,
    0x152: 0x8c, 0x17d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2dc: 0x98, 0x2122: 0x99, 0x161: 0x9a,
    0x203a: 0x9b, 0x153: 0x9c, 0x17e: 0x9e, 0x178: 0x9f};
  const UNDEFINED = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);
  const BYTE_CHAR = new Map(Object.entries(CP1252).map(([c, b]) => [b, String.fromCharCode(+c)]));
  const single = c => c < 0x80 || (c >= 0xa0 && c <= 0xff) || CP1252[c] != null;
  function encode(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      out[i] = c < 0x80 || (c >= 0xa0 && c <= 0xff) || UNDEFINED.has(c) ? c : CP1252[c] ?? 0x3f;
    }
    return out;
  }
  const clean = s => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\|/g, "\u00a6").replace(/[\x00-\x1f]/g, " ");
  function record(fields, report) {
    const out = [];
    for (const [k, raw] of fields) {
      if (raw === undefined || raw === null) continue;
      const v = typeof raw === "string" ? clean(raw) : String(raw);
      if (typeof raw !== "string" || Array.from(v).every(ch => single(ch.codePointAt(0)))) { out.push(k + "=" + v); continue; }
      out.push(k + "=" + Array.from(v, ch => single(ch.codePointAt(0)) ? ch : "?").join(""));
      out.push("%UTF8%" + k + "=" + Array.from(new TextEncoder().encode(v), b => b < 0x80 || b >= 0xa0 ? String.fromCharCode(b) : BYTE_CHAR.get(b) ?? String.fromCharCode(b)).join(""));
      report?.("Text outside the Windows-1252 code page is written as %UTF8% fields, with \"?\" in the plain field.");
    }
    return "|" + out.join("|");
  }
  const T = b => b ? "T" : "F", TRUE = b => b ? "TRUE" : "FALSE";
  const n4 = v => String(Math.round(v * 1e4) / 1e4 + 0);
  // Stable 8-letter unique ids (Altium UNIQUEID style) from a key.
  function uniqueId(key) {
    let h1 = 2166136261, h2 = 5381;
    for (let i = 0; i < key.length; i++) { const c = key.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2, 33) ^ c; }
    let s = "", x = (h1 >>> 0) * 4294967296 + (h2 >>> 0);
    for (let i = 0; i < 8; i++) { s += String.fromCharCode(65 + (x % 26)); x = Math.floor(x / 26); }
    return s;
  }
  const notebook = () => { const m = new Map(); return {add: s => m.set(s, (m.get(s) || 0) + 1), list: () => [...m].map(([s, k]) => s + (k > 1 ? " (" + k + " instances)" : ""))}; };
  const fileName = (s, ext) => (String(s || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").trim() || "Document") + ext;
  const mod = (a, m) => ((a % m) + m) % m;

  // ---------------------------------------------------------------- schematic (.SchDoc)
  // Schematic coordinates: 10 mil units with a _FRAC part in 1/100000 of that, Y up. Waffle
  // sheets are Y down; one whole-grid shift puts the drawing on the sheet.
  function dxp(key, v) {
    const total = Math.round(v / FRAC), whole = Math.trunc(total / 100000), frac = total - whole * 100000;
    return frac ? [[key, whole], [key + "_FRAC", frac]] : [[key, whole]];
  }
  const SHEETS = [[1150, 760, 0], [1550, 1110, 1], [2230, 1570, 2], [3150, 2230, 3], [4460, 3150, 4]];
  const POWER_STYLE = {circle: 0, arrow: 1, bar: 2, wave: 3, gnd: 4, signal: 5, earth: 6};
  const ELECTRICAL_MAX = 7;
  const IO = {unspecified: 0, output: 1, input: 2, bidirectional: 3};
  function exportSchematic(project, requested, observer, snapshot) {
    const Atr = A(), doc = typeof requested === "string" ? project.documents.find(d => d.id === requested) : requested;
    if (doc?.kind !== "schematic") throw Error("Choose a schematic sheet to export.");
    const defs = new Map(project.library.map(d => [d.id, d])), notes = notebook(), report = observer ? observer.diagnostics(notes.add) : notes.add;
    const notebookValues = globalThis.AtriumCalculationRecords, fidelity = [];
    const evaluations = snapshot || notebookValues?.frozen(project,doc);
    const counts = {components: 0, pins: 0, wires: 0, junctions: 0, labels: 0, graphics: 0, sheetSymbols: 0};
    for (const m of doc.notes || []) notes.add(m);
    const box = Atr.docBounds(doc, defs) || [0, 0, 100, 100], layout = globalThis.AtriumSchematicOutput?.page(doc,defs,"altium");
    // Shift so the drawing's lower left sits 1 inch inside the sheet, on a 100 mil grid.
    const step = 2.54, ox = layout ? -layout.left : Math.ceil((25.4 - box[0]) / step) * step, top = box[3];
    const height = Math.max(box[3] - box[1], 1), width = Math.max(box[2] - box[0], 1);
    const fixed = layout && !layout.infinite && SHEETS.find(([w,h]) => Math.abs(w*DXP-layout.width)<.0001 && Math.abs(h*DXP-layout.height)<.0001);
    const sheet = layout ? fixed : SHEETS.find(([w, h]) => w * DXP >= width + 50.8 && h * DXP >= height + 50.8) || null;
    const sheetH = sheet ? sheet[1] * DXP : Math.ceil((height + 50.8) / step) * step;
    const oy = layout ? layout.top+layout.height : Math.ceil((25.4 + top) / step) * step;      // Altium y = oy - y
    if (layout) report(layout.note);
    const P = p => [p[0] + ox, oy - p[1]];
    const at = (stem, p) => { const q = P(p); return [...dxp(stem + ".X", q[0]), ...dxp(stem + ".Y", q[1])]; };
    const pts = list => [["LOCATIONCOUNT", list.length], ...list.flatMap((p, i) => { const q = P(p); return [...dxp("X" + (i + 1), q[0]), ...dxp("Y" + (i + 1), q[1])]; })];
    // push returns the record's OWNERINDEX: its position among the records after the header line.
    const lines = [], push = fields => { lines.push(record(fields, report)); return lines.length - 1; };
    const text = s => clean(s);
    // Altium lists a part's Links from ComponentLink<N>URL / ComponentLink<N>Description and HelpURL in
    // this spelling. An import may have changed their case; any other name is written as it is.
    const linkName = k => String(k).replace(/^componentlink(\d+)(url|description)$/i, (_, n, f) => "ComponentLink" + n + (f.length === 3 ? "URL" : "Description"))
      .replace(/^helpurl$/i, "HelpURL");
    // Header, then the sheet record (index 0). Child records name their owner by OWNERINDEX,
    // the owner's position among the records after the header.
    push([["RECORD", 31], ["FONTIDCOUNT", 1], ["SIZE1", 10], ["FONTNAME1", "Times New Roman"], ["USEMBCS", "T"], ["ISBOC", "T"], ["HOTSPOTGRIDON", "T"], ["HOTSPOTGRIDSIZE", 4],
      ["SHEETSTYLE", sheet ? sheet[2] : 0], ["SYSTEMFONT", 1], ["BORDERON", "T"], ["SHEETNUMBERSPACESIZE", 4], ["AREACOLOR", 16317695], ["SNAPGRIDON", "T"], ["SNAPGRIDSIZE", 10],
      ["VISIBLEGRIDON", "T"], ["VISIBLEGRIDSIZE", 10], ...(sheet ? [] : [["USECUSTOMSHEET", "T"], ...dxp("CUSTOMX", layout?.width ?? Math.ceil((width + 50.8)/DXP)*DXP), ...dxp("CUSTOMY", layout?.height ?? Math.ceil(sheetH/DXP)*DXP), ["CUSTOMXZONES", 6], ["CUSTOMYZONES", 4], ["CUSTOMMARGINWIDTH", 20]]),
      ["DISPLAY_UNIT", 4]]);
    const owned = (owner, part, fields) => push(owner < 0 ? [...fields.slice(0, 1), ["OWNERPARTID", -1], ...fields.slice(1)] : [...fields.slice(0, 1), ["OWNERINDEX", owner], ["ISNOTACCESIBLE", "T"], ["OWNERPARTID", part], ...fields.slice(1)]);
    // Exact curves (model.js pathArc, sch-curves.js) as Altium arcs, ellipses, elliptical arcs and
    // Bézier curves.
    // Altium's angles turn counterclockwise on its Y-up sheet from STARTANGLE to ENDANGLE.
    // A curve that is not axis-aligned after placement stays a polyline.
    const deg = v => Math.round(((v % 360) + 360) % 360 * 1000) / 1000;
    function curveRecords(owner, partId, s, world, ink) {
      const vec = (c, d) => { const p = world([c[0] + d[0], c[1] + d[1]]), q = world(c); return [p[0] - q[0], p[1] - q[1]]; };
      let c, a, b, sweep;
      const C = globalThis.AtriumSchCurves, arc = Atr.pathArc(s), bezier = !arc && C?.bezier(s);
      if (bezier) return owned(owner, partId, [["RECORD", 5], ["LINEWIDTH", 1], ["COLOR", ink], ...pts(bezier.map(world))]);
      const sym = !arc && C?.arc(s), el = !arc && !sym && C?.ellipse(s);
      // Every curve as c + a·cos t + b·sin t over sweep degrees, in sheet coordinates.
      if (arc) { const t = Atr.rad(arc.start); c = arc.c; a = [arc.r * Math.cos(t), -arc.r * Math.sin(t)]; b = [-arc.r * Math.sin(t), -arc.r * Math.cos(t)]; sweep = Atr.arcSweep(arc); }
      else if (sym) { const t = Atr.rad(sym.start); c = [sym.x, sym.y]; a = [sym.r * Math.cos(t), sym.r * Math.sin(t)]; b = [-sym.r * Math.sin(t), sym.r * Math.cos(t)]; sweep = sym.end - sym.start; }
      else if (el) ({c, a, b, sweep} = el);
      else return -1;
      [a, b] = [vec(c, a), vec(c, b)]; c = world(c);
      const scale = Math.max(Math.hypot(...a), Math.hypot(...b));
      if (!(scale > 0) || Math.abs(a[0] * a[1] + b[0] * b[1]) > scale * (scale * 1e-5 + 4e-6)) return -1;
      const rx = Math.hypot(a[0], b[0]), ry = Math.hypot(a[1], b[1]);
      const angle = t => { const r = Atr.rad(t), x = a[0] * Math.cos(r) + b[0] * Math.sin(r), y = a[1] * Math.cos(r) + b[1] * Math.sin(r); return Math.atan2(-y / ry, x / rx) * 180 / Math.PI; };
      // On screen (Y down), a negative cross product turns counterclockwise as t grows.
      const ccw = (a[0] * b[1] - a[1] * b[0]) * sweep < 0, full = Math.abs(sweep) >= 360 - 1e-9;
      const [from, to] = full ? [0, 360] : ccw ? [deg(angle(0)), deg(angle(sweep))] : [deg(angle(sweep)), deg(angle(0))];
      const round = Math.abs(rx - ry) <= 1e-6 * scale + 2e-6, centre = P(c);
      if (full && (s.closed || s.fill)) return owned(owner, partId, [["RECORD", 8], ...dxp("LOCATION.X", centre[0]), ...dxp("LOCATION.Y", centre[1]), ...dxp("RADIUS", rx), ...dxp("SECONDARYRADIUS", ry),
        ["LINEWIDTH", 1], ["COLOR", ink], ["AREACOLOR", 11599871], ["ISSOLID", T(!!s.fill)]]);
      return owned(owner, partId, [["RECORD", round ? 12 : 11], ...dxp("LOCATION.X", centre[0]), ...dxp("LOCATION.Y", centre[1]), ...dxp("RADIUS", rx),
        ...(round ? [] : dxp("SECONDARYRADIUS", ry)), ["LINEWIDTH", 1], ["STARTANGLE", from], ["ENDANGLE", to], ["COLOR", ink]]);
    }
    function shapeRecords(owner, partId, s, world, ink = 128) {
      const exact = s.kind === "path" ? curveRecords(owner, partId, s, world, ink) : -1;
      if (exact >= 0) return exact;
      if (s.kind === "path" && s.points?.length >= 2) {
        let ps = s.points.map(world);
        const closed = s.closed || s.fill;
        if (closed && ps.length >= 3) {
          if (Atr.same(ps[0], ps.at(-1))) ps = ps.slice(0, -1);
          // A filled axis-aligned rectangle stays a rectangle record; anything else is a polygon.
          return owned(owner, partId, [["RECORD", 7], ["LINEWIDTH", 1], ["COLOR", ink], ["AREACOLOR", 11599871], ["ISSOLID", T(!!s.fill)], ...pts(ps)]);
        }
        return owned(owner, partId, [["RECORD", 6], ["LINEWIDTH", 1], ["COLOR", ink], ...pts(ps)]);
      }
      if (s.kind === "circle") {
        const c = world([s.x, s.y]), q = P(c);
        return owned(owner, partId, [["RECORD", 8], ...dxp("LOCATION.X", q[0]), ...dxp("LOCATION.Y", q[1]), ...dxp("RADIUS", s.r), ...dxp("SECONDARYRADIUS", s.r), ["LINEWIDTH", 1], ["COLOR", ink], ["AREACOLOR", 11599871], ["ISSOLID", T(!!s.fill)]]);
      }
      if (s.kind === "text" && s.text) {
        return owned(owner, partId, [["RECORD", 4], ...at("LOCATION", world([s.x, s.y])), ["COLOR", 8388608], ["FONTID", 1], ["TEXT", text(s.text)]]);
      }
      report("Unsupported symbol shapes (" + (s.kind || "unknown") + ") omitted.");
      return -1;
    }
    const imageCompanions=[];
    for (const i of observer ? observer.items(doc,doc.items,() => lines.length) : doc.items) {
      const art=observer?.notebook?.(doc,i);
      if(art?.type==="child"){
        const visible=art.represented&&!observer.primaryOnly;
        observer.observed(doc,i,i.kind,visible?"approximated":"dropped",visible?art.reason:"The exported sheet uses a textual image description.");continue;
      }
      if(art || i.kind==="image"&&i.asset){
        const box=art?.box||[i.x,i.y,i.x+i.w,i.y+i.h];
        if(art?.type==="image" && !observer.primaryOnly){
          const data=Uint8Array.from(atob(art.data),c=>c.charCodeAt(0));
          const leaf="notebook-"+globalThis.AtriumSourceFile.sha256(data)+".png";
          push([["RECORD",30],...at("LOCATION",[box[0],box[3]]),...at("CORNER",[box[2],box[1]]),
            ["FILENAME",leaf],["EMBEDIMAGE","F"],["KEEPASPECT","T"],["UNIQUEID",uniqueId(i.id)]]);
          if(!imageCompanions.some(f=>f.name===leaf))imageCompanions.push({name:leaf,bytes:data,document:leaf});
          report("The image is flattened into its accompanying PNG.");
        }else{
          const value=art?.text||art?.alt||i.caption||i.alt||i.name||"Image";
          push([["RECORD",4],...at("LOCATION",box.slice(0,2)),["COLOR",128],["FONTID",1],["TEXT",text(value)],["UNIQUEID",uniqueId(i.id)]]);
          report(art?.reason||"This single schematic retains the textual description of the image.");
        }
        counts.graphics++;continue;
      }
      if (i.kind === "part") {
        const def = defs.get(i.def), sym = def?.symbol;
        if (!sym) { report("Components with missing symbol geometry omitted."); continue; }
        const angle = mod(i.angle || 0, 360), q = Math.round(angle / 90) % 4;
        if (angle % 90) report("Non-cardinal component rotations were rounded to the nearest 90°.");
        const placed = {...i, angle: q * 90}, world = p => Atr.world(p, placed);
        const gate = sym.parts > 1 ? (i.unit || i.part || 1) : 1, view = Atr.gate ? Atr.gate(sym, i) : sym;
        if (i.mirror) report("Mirrored components are written with ISMIRRORED; check their pins in Altium.");
        const footprint = project.documents.filter(d => d.kind === "pcb").flatMap(d => d.items).find(b => b.kind === "part" && b.link && b.link === i.link);
        const fpName = (footprint && defs.get(footprint.def)?.footprint?.name) || def.footprint?.name || def.footprintName || "";
        const owner = push([["RECORD", 1], ["LIBREFERENCE", text(def.name || "Symbol")], ["COMPONENTDESCRIPTION", text(def.description || "")], ["PARTCOUNT", (sym.parts > 1 ? sym.parts : 1) + 1],
          ["DISPLAYMODECOUNT", 1], ["INDEXINSHEET", counts.components + 1], ["OWNERPARTID", -1], ...at("LOCATION", [i.x, i.y]), ["CURRENTPARTID", gate], ["ORIENTATION", (4 - q) % 4],
          ...(i.mirror ? [["ISMIRRORED", "T"]] : []), ["LIBRARYPATH", "*"], ["SOURCELIBRARYNAME", "Atrium.SchLib"], ["SHEETPARTFILENAME", "*"], ["TARGETFILENAME", "*"],
          ["UNIQUEID", uniqueId(i.link || i.id)], ["AREACOLOR", 11599871], ["COLOR", 128], ["PARTIDLOCKED", "F"], ["DESIGNITEMID", text(def.name || "Symbol")]]);
        counts.components++;
        // Pins: a two-point lead ending on the pin becomes the pin's length (Altium draws the
        // lead); other pins get length 0 at their connection point.
        const used = new Set(), leads = view.shapes.map((s, k) => s.kind === "path" && !s.closed && !s.fill && s.points?.length === 2 ? k : -1).filter(k => k >= 0);
        for (const pin of view.pins || []) {
          const hot = [pin.x, pin.y];
          const cands = leads.filter(k => !used.has(k) && view.shapes[k].points.some(p => Atr.same(p, hot)));
          let body = hot, len = 0;
          if (cands.length === 1) {
            const s = view.shapes[cands[0]], other = Atr.same(s.points[0], hot) ? s.points[1] : s.points[0];
            if (other[0] === hot[0] || other[1] === hot[1]) { used.add(cands[0]); body = other; len = Math.hypot(hot[0] - other[0], hot[1] - other[1]); }
          }
          const wb = world(body), wh = world(hot), d = [wh[0] - wb[0], wh[1] - wb[1]];
          // Rotation 0 right, 1 up, 2 left, 3 down (Waffle screen directions: up is -y).
          const rot = len ? (Math.abs(d[0]) >= Math.abs(d[1]) ? (d[0] > 0 ? 0 : 2) : (d[1] < 0 ? 1 : 3)) : 0;
          const flags = rot | (pin.hidden ? 4 : 0) | 8 | 16;
          owned(owner, gate, [["RECORD", 2], ["OWNERPARTDISPLAYMODE", 0], ["ELECTRICAL", Math.min(ELECTRICAL_MAX, Math.max(0, pin.electrical ?? 4))], ["PINCONGLOMERATE", flags],
            ...dxp("PINLENGTH", len), ...at("LOCATION", wb), ["NAME", text(pin.name || "")], ["DESIGNATOR", text(pin.number || "")], ["SWAPIDPIN", text(pin.number || "")]]);
          counts.pins++;
        }
        view.shapes.forEach((s, k) => { if (!used.has(k)) shapeRecords(owner, gate, s, world); });
        const textAt = (off, dy) => off ? Atr.world(off, placed) : [i.x, i.y + dy];
        owned(owner, -1, [["RECORD", 34], ...at("LOCATION", textAt(i.refAt, -5)), ["COLOR", 8388608], ["FONTID", 1], ["TEXT", text(i.ref || "")], ["NAME", "Designator"], ["READONLYSTATE", 1],
          ...(i.showRef === false ? [["ISHIDDEN", "T"]] : [])]);
        owned(owner, -1, [["RECORD", 41], ...at("LOCATION", textAt(i.valueAt, 5)), ["COLOR", 8388608], ["FONTID", 1], ["TEXT", text(i.value || "")], ["NAME", "Comment"],
          ...(i.showValue === false ? [["ISHIDDEN", "T"]] : [])]);
        const params = {...(def.parameters || {}), ...(i.parameters || {})};
        for (const [k, v] of Object.entries(params)) {
          if (/^(comment|value|designator)$/i.test(k) || v == null || v === "") continue;
          owned(owner, -1, [["RECORD", 41], ...at("LOCATION", [i.x, i.y]), ["COLOR", 8388608], ["FONTID", 1], ["ISHIDDEN", i.paramShow?.[k] ? "F" : "T"], ["TEXT", text(v)], ["NAME", text(linkName(k))]]);
        }
        if (fpName) {
          const list = owned(owner, -1, [["RECORD", 44]]);
          owned(list, -1, [["RECORD", 45], ["DESCRIPTION", text(fpName)], ["MODELNAME", text(fpName)], ["MODELTYPE", "PCBLIB"], ["DATAFILECOUNT", 1], ["MODELDATAFILEENTITY0", text(fpName)],
            ["MODELDATAFILEKIND0", "PCBLib"], ["ISCURRENT", "T"]]);
        }
      } else if (i.kind === "wire" || i.kind === "bus") {
        if (i.points?.length < 2) continue;
        push([["RECORD", i.kind === "wire" ? 27 : 26], ["INDEXINSHEET", lines.length + 1], ["LINEWIDTH", 1], ["COLOR", i.kind === "wire" ? 8388608 : 8388608], ...pts(i.points)]);
        counts.wires++;
        if (i.kind === "wire" && i.net) { push([["RECORD", 25], ...at("LOCATION", i.points[0]), ["COLOR", 128], ["FONTID", 1], ["TEXT", text(i.net)]]); counts.labels++; }
      } else if (i.kind === "junction") {
        push([["RECORD", 29], ...at("LOCATION", [i.x, i.y]), ["COLOR", 128], ["LOCKED", "F"]]); counts.junctions++;
      } else if (i.kind === "netlabel" || i.kind === "power" || i.kind === "port" || i.kind === "offsheet") {
        if (i.kind === "netlabel" && i.autoName) report("Pin-based automatic net names export as literal net labels. Review the net names in repeated channels.");
        const paint = i.schPaint || {}, name = text(i.text || "");
        if (Atr.isOffsheet(i)) {
          const angle = mod(-Atr.offsheetAngle(i), 360);
          push([["RECORD", 17], ["ISCROSSSHEETCONNECTOR", "T"], ["STYLE", paint.style ?? 1], ["SHOWNETNAME", T(paint.showName !== false)], ...at("LOCATION", [i.x, i.y]), ["ORIENTATION", Math.round(angle / 90) % 4], ["COLOR", 128], ["TEXT", name]]);
          if (i.io != null && i.io !== "unspecified") report("Off-sheet connector direction " + i.io + " was dropped. Altium off-sheet connectors have no I/O type.");
          if (angle % 90) report("Off-sheet connector rotation was rounded to the nearest 90°.");
        } else if (i.kind === "power" || paint.type === "power") {
          const style = i.kind === "power" ? POWER_STYLE[i.style] ?? 2 : paint.style ?? 2, dir = i.kind === "power" ? i.direction ?? 1 : paint.direction ?? 1;
          push([["RECORD", 17], ["STYLE", style], ["SHOWNETNAME", T((i.kind === "power" ? i.showName : paint.showName) !== false)], ...at("LOCATION", [i.x, i.y]), ["ORIENTATION", dir], ["COLOR", 128], ["TEXT", name]]);
        } else if (i.kind === "port" || paint.type === "port") {
          // Imported ports can connect at the far end. The paint offset is the
          // source origin relative to the connected terminal.
          const w = i.width || paint.width || 10.16, horizontal = (paint.style ?? 0) < 4;
          const origin = paint.offset ? [i.x + paint.offset[0], i.y + paint.offset[1]] : [i.x, i.y];
          push([["RECORD", 18], ["STYLE", horizontal ? 3 : 7], ["IOTYPE", IO[i.io] ?? 0], ["ALIGNMENT", 0], ...dxp("WIDTH", w), ...dxp("HEIGHT", paint.height || 2.54), ...at("LOCATION", origin),
            ["COLOR", 128], ["AREACOLOR", 8454143], ["TEXTCOLOR", 128], ["NAME", name], ["UNIQUEID", uniqueId(i.id)]]);
        } else {
          const a = mod(-(i.angle || 0), 360);
          push([["RECORD", 25], ...at("LOCATION", [i.x, i.y]), ["ORIENTATION", Math.round(a / 90) % 4], ["COLOR", 128], ["FONTID", 1], ["TEXT", name]]);
        }
        counts.labels++;
      } else if (i.kind === "label") {
        push([["RECORD", 4], ...at("LOCATION", [i.x, i.y]), ["ORIENTATION", Math.round(mod(-(i.angle || 0), 360) / 90) % 4], ["COLOR", 8388608], ["FONTID", 1], ["TEXT", text(i.text || "")],
          ...(i.url ? [["URL", text(i.url)]] : [])]);
        counts.graphics++;
      } else if (i.kind === "graphic") {
        if (shapeRecords(-1, -1, {...i, kind: "path"}, p => p, 128) >= 0) counts.graphics++;
      } else if (i.kind === "busentry") {
        const end = globalThis.AtriumSchObjects?.busEntryEnd ? AtriumSchObjects.busEntryEnd(i) : [i.x + (i.size || 2.54), i.y - (i.size || 2.54)];
        push([["RECORD", 37], ...at("LOCATION", [i.x, i.y]), ...at("CORNER", end), ["LINEWIDTH", 1], ["COLOR", 8388608]]); counts.graphics++;
      } else if (i.kind === "noerc") {
        push([["RECORD", 22], ...at("LOCATION", [i.x, i.y]), ["COLOR", 255], ["ISACTIVE", "T"]]); counts.graphics++;
      } else if (i.kind === "sheetsymbol") {
        const child = project.documents.find(d => d.id === i.sheet), file = child ? fileName(child.name, ".SchDoc") : String(i.file || "Sheet.SchDoc");
        const owner = push([["RECORD", 15], ...at("LOCATION", [i.x, i.y]), ...dxp("XSIZE", i.w), ...dxp("YSIZE", i.h), ["COLOR", 128], ["AREACOLOR", 8454016], ["ISSOLID", "T"], ["UNIQUEID", uniqueId(i.id)]]);
        for (const e of i.entries || []) {
          const off = (e.offset || 0) / 2.54, whole = Math.trunc(off);
          owned(owner, -1, [["RECORD", 16], ["SIDE", ["left", "right", "top", "bottom"].indexOf(e.side) < 0 ? 0 : ["left", "right", "top", "bottom"].indexOf(e.side)],
            ["DISTANCEFROMTOP", whole], ...(off - whole ? [["DISTANCEFROMTOP_FRAC1", Math.round((off - whole) * 100000)]] : []), ["IOTYPE", ({unspecified: 0, output: 1, input: 2, bidirectional: 3})[e.io] ?? 0],
            ["NAME", text(e.name || "")], ["COLOR", 128], ["AREACOLOR", 8454143], ["TEXTCOLOR", 128]]);
        }
        owned(owner, -1, [["RECORD", 32], ...at("LOCATION", [i.x, i.y - 1.5]), ["COLOR", 8388608], ["FONTID", 1], ["TEXT", text(i.name || "Sheet")]]);
        owned(owner, -1, [["RECORD", 33], ...at("LOCATION", [i.x, i.y + i.h + 2]), ["COLOR", 8388608], ["FONTID", 1], ["TEXT", text(file)]]);
        if (/^\s*repeat\s*\(/i.test(i.name || "") || i.repeat) report("Repeated (multi-channel) sheet symbols keep their Repeat() name; check the channel setup in Altium.");
        counts.sheetSymbols++;
      } else if (i.kind === "textframe" && i.role === "frame") {
        push([["RECORD",14], ...at("LOCATION",[i.x,i.y+i.h]), ...at("CORNER",[i.x+i.w,i.y]), ["COLOR",128], ["ISSOLID","F"]]);
        push([["RECORD",4], ...at("LOCATION",[i.x+1.27,i.y+2.54]), ["COLOR",128], ["FONTID",1], ["TEXT",text(i.text)]]);
        counts.graphics += 2; report("Named frame written as an editable rectangle and title.");
      } else if (i.kind === "textframe" && i.math === true) {
        const value = globalThis.AtriumMath?.layout(i.text, {display:true}).plain || i.text;
        push([["RECORD", 4], ...at("LOCATION", [i.x, i.y]), ["COLOR", 8388608], ["FONTID", 1], ["TEXT", text(value)], ["UNIQUEID", uniqueId(i.id)]]);
        counts.graphics++; report("Equation " + i.id + " was converted to static text.");
      } else if (i.kind === "textframe") {
        if (i.calculation && notebookValues) {
          const projected = notebookValues.staticOutput(notebookValues.read(i),evaluations.get(i.id),"Altium");
          for (const [n,line] of projected.text.split("\n").entries())
            push([["RECORD",4],...at("LOCATION",[i.x,i.y+3*n]),["FONTID",1],["TEXT",text(line)]]);
          counts.graphics++; fidelity.push(projected.fidelity); report(projected.message); continue;
        }
        // A hyperlinked one-line text (an Altium text with a field, read as a text frame) stays a linked text.
        if (i.url && !i.widget && !i.sticky && !i.callout && !String(i.text ?? "").includes("\n")) {
          push([["RECORD", 4], ...at("LOCATION", [i.x, i.y]), ["COLOR", 8388608], ["FONTID", 1], ["TEXT", text(i.text || "")], ["URL", text(i.url)], ["UNIQUEID", uniqueId(i.id)]]);
          counts.graphics++; continue;
        }
        const rich=i.richText || i.math || i.widget || i.calculation || i.sticky || i.callout;
        const note=rich && globalThis.AtriumNotebook?.describe(project,doc,i);
        const value=note?.text ?? i.text ?? "",x0=Math.min(i.x,i.x+i.w),x1=Math.max(i.x,i.x+i.w),y0=Math.min(i.y,i.y+i.h),y1=Math.max(i.y,i.y+i.h);
        push([["RECORD",28],...at("LOCATION",[x0,y1]),...at("CORNER",[x1,y0]),["FONTID",1],["WORDWRAP","T"],["CLIPTORECT","T"],
          ["SHOWBORDER",T(i.border!==false)],["ALIGNMENT",1],["TEXT",text(value.replace(/\r?\n/g,"~1"))]]);counts.graphics++;
        if(rich) report(note?"Notebook content was exported as a static text frame with its current field values.":"Notebook content used its plain-text projection because its field reader was unavailable.");
      } else if (i.kind === "image") report("Embedded images were omitted.");
      else report("Unsupported sheet item " + i.kind + " omitted.");
    }
    if (doc.items.some(i => i.kind === "part" && defs.get(i.def)?.symbol?.alternate)) report("De Morgan (alternate) symbol views export the view placed on the sheet only.");
    // WEIGHT counts the numbered design records, including the sheet itself and all component children.
    const header = record([["HEADER", "Protel for Windows - Schematic Capture Ascii File Version 5.0"], ["WEIGHT", lines.length]]);
    const content = header + "\r\n" + lines.join("\r\n") + "\r\n";
    return {name: fileName(doc.name, ".SchDoc"), content, bytes: encode(content), diagnostics: notes.list(), counts, offset: [ox, oy],imageCompanions, ...(layout ? {page:layout} : {}), ...(fidelity.length ? {fidelity} : {})};
  }

  // ---------------------------------------------------------------- board (.PcbDoc)
  // PCB coordinates: mil with up to four decimals (Altium's 1/10000 mil), Y up.
  const mil = v => n4(v / MIL) + "mil";
  const COPPER = /^(Top|Bottom|Inner (\d+))$/;
  const LAYERS = {Top: "TOP", Bottom: "BOTTOM", Silk: "TOPOVERLAY", "Bottom silk": "BOTTOMOVERLAY", "Top paste": "TOPPASTE", "Bottom paste": "BOTTOMPASTE",
    "Top mask": "TOPSOLDER", "Bottom mask": "BOTTOMSOLDER", Keepout: "KEEPOUT", Multi: "MULTILAYER", Mechanical: "MECHANICAL1",
    "Drill drawing": "DRILLDRAWING"};
  function layerOf(l) {
    if (Object.hasOwn(LAYERS, l || "")) return LAYERS[l];
    const m = /^Inner (\d+)$/.exec(l || ""); if (m && +m[1] <= 30) return "MID" + m[1];
    const k = /^Mechanical (\d+)$/.exec(l || ""); if (k && +k[1] >= 1 && +k[1] <= 16) return "MECHANICAL" + k[1];
    return null;
  }
  const SHAPES = {rect: "RECTANGLE", rectangle: "RECTANGLE", round: "ROUND", circle: "ROUND", oval: "ROUND", ellipse: "ROUND", roundrect: "ROUNDEDRECTANGLE", rounded: "ROUNDEDRECTANGLE", roundedrect: "ROUNDEDRECTANGLE", octagon: "OCTAGONAL", octagonal: "OCTAGONAL"};
  // A rule scope as an Altium query. Signals and tags (format 1.4) have no Altium keyword: a tag is the net
  // class it exports as; a signal is its nets.
  function altiumScope(scope, project, doc) {
    const q = v => "'" + String(v).replace(/'/g, "''") + "'";
    const env = globalThis.AtriumSignals?.scopeEnv?.(doc, project), S = globalThis.AtriumSignals;
    const nets = name => { const n = env ? [...env.netsOfSignal(name)].sort() : []; return n.length ? "(" + n.map(x => "InNet(" + q(x) + ")").join(" Or ") + ")" : "InDifferentialPair(" + q(name) + ")"; };
    // A tag is the class it exports as (its net class, else its pair class), else its nets.
    const tag = name => { const t = env?.model.store.tags?.find(x => x.name.toLowerCase() === String(name).toLowerCase()) || {name}, nc = S ? S.exportName(t, "net") : name, pc = S ? S.exportName(t, "pair") : null;
      if (nc !== null) return "InNetClass(" + q(nc) + ")"; if (pc !== null) return "InDifferentialPairClass(" + q(pc) + ")";
      const n = env ? [...env.netsOfTag(name)].sort() : []; return n.length ? "(" + n.map(x => "InNet(" + q(x) + ")").join(" Or ") + ")" : "InNetClass(" + q(name) + ")"; };
    // Altium's InDifferentialPair is one pair: a diff signal of several stages is each stage's pair.
    const pair = name => { const st = env ? env.model.stages().filter(x => x.signal.toLowerCase() === String(name).toLowerCase()) : []; return st.length > 1 ? "(" + st.map(x => "InDifferentialPair(" + q(x.name) + ")").join(" Or ") + ")" : "InDifferentialPair(" + q(name) + ")"; };
    const exchange=globalThis.AtriumQueryExchange, design=globalThis.AtriumDesignQuery;
    if (!exchange || !design) return {ok:false,diagnostics:[{message:"The Altium scope translator is unavailable."}]};
    let native=scope;
    if (!native?.languageVersion) {
      try {native=scope?.kind==="query" ? exchange.fromClassic(scope.value).scope : globalThis.AtriumDesignQueryRecord.fromSelector(scope);}
      catch(e){return {ok:false,diagnostics:[{message:e.message}]};}
    }
    return exchange.toAltium(native,design.context(project,doc),{expand(family,name){
      if(family==="tag")return tag(name);
      if(family==="signal")return nets(name);
      if(family==="diffpair")return pair(name);
    }});
  }
  function sourceRuleFields(line) {
    const fields = new Map(), utf = [];
    for (const part of line.split("|")) {
      const at = part.indexOf("="); if (at < 1) continue;
      const key = part.slice(0,at).trim().toUpperCase(), value = part.slice(at + 1);
      if (key === "RECORD" || key === "INDEXFORSAVE") continue;
      if (key.startsWith("%UTF8%")) utf.push([key.slice(6),value]); else fields.set(key,value);
    }
    for (const [key,value] of utf) if (key !== "RECORD" && key !== "INDEXFORSAVE") fields.set(key,value);
    return fields;
  }
  // Designer 26 reads DXPRule as the authoritative constraints. Its own ASCII
  // writer also emits a Protel legacy Rule that can disable a complex query.
  function writeBoardRules(doc, project, set, encode, write, skipped, report, observer, scopeProblems) {
    const R = globalThis.AtriumRules, sources = doc.sourceRules || [], current = (set?.list || []).map(r => observer?.precision?.rule(doc,r) || r);
    const records = sources.map(line => sourceRuleFields(line));
    const legacyRows = new Set(records.filter((fields,i)=>fields.has("SCOPE1COUNT") || /(?:^|\|)RECORD=Rule(?:\||$)/i.test(sources[i])));
    const writeSource = fields => write(fields,!fields.has("SCOPE1EXPRESSION") && legacyRows.has(fields));
    if (records.length && (!set || !R?.replaceWithSource || !globalThis.AtriumAltiumRules ||
          project.rules?.list && !globalThis.AtriumProjectRules?.originRecords)) {
      for (const [i,fields] of records.entries()) {
        writeSource(fields);
        observer?.observed(doc,"Rules record " + (i+1),"Source design rule","kept");
      }
      if (set) report?.("The retained Altium rules were written because the editable rule book was unavailable.");
      return;
    }
    const originals = new Map(), stock = new Map(), controlled = new Set(set ? doc.appliedSourceRuleRecords : []);
    const origins = new Map(), byName = new Map(), sourcePriorities = new Map();
    const projectRules = globalThis.AtriumProjectRules;
    const owned = new Map((project.rules?.list || []).filter(rule => projectRules?.appliesToBoard(rule, doc.id)).map(rule => [rule.id, rule]));
    const stockByTypeAndName = new Map();
    const identity = f => (f.get("RULEKIND") || "").toLowerCase() + "\0" + (f.get("NAME") || "").toLowerCase();
    const slot = r => r.type + "\0" + r.name;
    const signature = ({id, ...fields}) => JSON.stringify(fields, (_, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key,value[key]])) : value);
    if (records.length && R?.replaceWithSource && globalThis.AtriumAltiumRules) {
      const defaults = R.migrate(null);
      for (const rule of defaults.list) {stock.set(rule.id, rule); stockByTypeAndName.set(slot(rule), rule);}
      const baseline = R.replaceWithSource(defaults, sources, doc);
      for (const rule of baseline.set.list) {
        const n = baseline.origins.get(rule.id);
        if (n) {
          originals.set(n,rule);
          const priority = Number(records[n-1].get("PRIORITY"));
          if (Number.isInteger(priority) && priority > 0) {
            if (!sourcePriorities.has(rule.type)) sourcePriorities.set(rule.type,[]);
            sourcePriorities.get(rule.type)[rule.priority-1] = priority;
          }
        }
      }
      records.forEach((f,i) => {
        const key = identity(f);
        byName.set(key, byName.has(key) ? null : i + 1);
      });
      if (set) for (const [id,n] of projectRules?.originRecords(doc,project.rules?.list || []) || []) {
        origins.set(id,n); controlled.add(n);
      }
    }
    const updated = new Set(), appended = [];
    function mergeChanges(target, before, after) {
      const keys = new Set([...before.keys(),...after.keys()]);
      for (const k of keys) {
        if (k === "UNIQUEID" || before.get(k) === after.get(k)) continue;
        if (after.has(k)) target.set(k,after.get(k)); else target.delete(k);
      }
    }
    function sourcePriority(r) {
      const slots = sourcePriorities.get(r.type);
      return slots?.[r.priority-1] ?? (slots?.length && r.priority>slots.length ? slots[slots.length-1]+r.priority-slots.length : r.priority);
    }
    for (const r of current) {
      const active = R.ruleActive(set,r);
      const local = active === r.enabled ? r : {...r,enabled:active};
      const record = owned.get(r.id), origin = record?.origin;
      const proven = stock.get(origin?.kind === "default" ? origin.key : r.id);
      // Early UUID-based books have no default provenance. Recover an unchanged
      // template only if its complete rule still matches and the source owns that name.
      const older = record && !origin && !record.boards && !record.exceptBoards && !record.severity && !record.where &&
        globalThis.AtriumUUID?.isV7(r.id) && stockByTypeAndName.get(slot(r));
      const olderFields = older && encode(older);
      const inherited = proven?.type === r.type ? proven : olderFields && byName.get(identity(olderFields)) &&
        signature(older) === signature(local) ? older : null;
      const fields = encode(local), n = origins.get(r.id);
      if (n) {
        updated.add(n);
        const original = originals.get(n);
        if (!original || original.type !== r.type) {
          observer?.observed(doc,r,"Design rule","approximated","The original constraints were retained.");
          report("The source constraints for “" + r.name + "” were retained because its original editable rule could not be reconstructed.");
          continue;
        }
        const base = encode(original,!fields), next = fields || encode(local,true);
        if (base && next) {
          const target = records[n-1], legacy = !target.has("SCOPE1EXPRESSION") && target.has("SCOPE1COUNT");
          mergeChanges(target,base,next);
          if (original.priority !== r.priority) target.set("PRIORITY",sourcePriority(r));
          if (legacy && ["SCOPE1EXPRESSION","SCOPE2EXPRESSION"].some(k=>base.get(k)!==next.get(k))) {
            for (const key of target.keys()) if (/^SCOPE[12](?:COUNT|_\d+_\w+)$/.test(key)) target.delete(key);
            for (const key of ["SCOPE1EXPRESSION","SCOPE2EXPRESSION"]) target.set(key,next.get(key));
          }
        }
        observer?.observed(doc,r,"Design rule",fields && base && next ? "kept" : "approximated",fields && base && next ? undefined : scopeProblems?.get(r.id) || "The original rule options were retained.");
        if (!fields) report("The original Altium constraint options were kept for “" + r.name + "”. Its current Waffle options have no Altium encoding.");
      } else if (!fields) {
        if (!inherited) { skipped(r); observer?.observed(doc,r,"Design rule","dropped",scopeProblems?.get(r.id) || "No Altium rule encoding."); }
      } else if (inherited) {
        const defaultFields = encode(inherited);
        if (!defaultFields) continue;
        const changed = [...new Set([...defaultFields.keys(),...fields.keys()])].some(k => k !== "UNIQUEID" && defaultFields.get(k) !== fields.get(k));
        if (!changed) continue; // Checking an imported board against local defaults is not an authored export edit.
        observer?.observed(doc,r,"Design rule","kept");
        const source = byName.get(identity(defaultFields));
        if (source && !controlled.has(source)) mergeChanges(records[source-1],defaultFields,fields);
        else appended.push(fields);
      } else {
        if (origins.size) fields.set("PRIORITY",sourcePriority(r));
        appended.push(fields);
        observer?.observed(doc,r,"Design rule",r.type === "fanoutControl" ? "approximated" : "kept",r.type === "fanoutControl" ? "Only the rule scope is encoded." : undefined);
        if (r.type === "fanoutControl") report("Fanout Control rules are written with their scope only. Set their options in Altium.");
      }
    }
    const names = new Set();
    for (const [i,f] of records.entries()) {
      const removed = controlled.has(i+1) && !updated.has(i+1);
      observer?.observed(doc,"Rules record " + (i+1),"Source design rule",removed ? "dropped" : "kept",removed ? "The adopted rule was removed from this board." : undefined);
      if (removed) continue;
      names.add((f.get("NAME") || "").toLowerCase());
      // Preserve an actual Version 4-only rule as such. Never widen an unknown legacy scope.
      writeSource(f);
    }
    for (const fields of appended) {
      const name = fields.get("NAME");let unique = name, suffix = 1;
      while (names.has(unique.toLowerCase())) unique = name + "_" + suffix++;
      if (unique !== name) report("The added rule “" + name + "” is written as “" + unique + "” because another source rule uses its name.");
      names.add(unique.toLowerCase());fields.set("NAME",unique);write(fields,false);
    }
  }
  // xSignals as Altium keeps them ("pin pairs", indexed keys of the Board record): PINPAIRPINSi is the path of
  // pads, start pad, both pads of each series part in order, end pad. The GUID and pad UNIQUEIDs of an
  // imported xSignal are kept; a new one gets a GUID only.
  function pinPairFields(project, doc) {
    const S = globalThis.AtriumSignals, src = globalThis.AtriumAltiumRules?.classes?.(doc.sourceClasses || []) || {ids: {}};
    const raw = new Map((doc.sourceClasses || []).filter(l => /^RECORD=xSignal\|/i.test(l)).map(l => { const f = Object.fromEntries(l.split("|").map(x => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)])); return [f.NAME, f]; }));
    let list = [];
    try { list = S ? S.model(project, doc).xSignals() : []; } catch { list = []; }
    if (!list.length) return [];
    const parts = new Map(doc.items.filter(i => i.kind === "part" && i.ref).map(i => [i.ref, i])), out = [["PINPAIRCOUNT", String(list.length)]];
    const pads = x => {
      const path = [x.from.ref + "-" + x.from.pin];
      let net = parts.get(x.from.ref)?.pinNets?.[x.from.pin];
      for (const ref of x.through || []) {
        const part = parts.get(ref), pins = Object.keys(part?.pinNets || {}).filter(k => part.pinNets[k]);
        const pairs = S?.series ? S.series(part) : pins.length === 2 ? [pins] : [];
        const pr = pairs.find(([a, b]) => part.pinNets[a] === net || part.pinNets[b] === net) || pairs[0];
        if (!pr) continue;
        const [a, b] = part.pinNets[pr[0]] === net ? pr : [pr[1], pr[0]];
        path.push(ref + "-" + a, ref + "-" + b); net = part.pinNets[b];
      }
      path.push(x.to.ref + "-" + x.to.pin);
      return path.join(",");
    };
    list.forEach((x, i) => {
      const r = raw.get(x.name);
      out.push(["PINPAIRNAME" + i, clean(x.name)], ["PINPAIRCOLOR" + i, String(r?.COLOR ?? 7709086)], ["PINPAIROVERRIDECOLORFORDRAW" + i, r?.OVERRIDECOLORFORDRAW ?? "FALSE"], ["PINPAIRPINS" + i, clean(pads(x))]);
      if (r?.PINUNIQUEIDS && r.PINS === pads(x)) out.push(["PINPAIRPINUNIQUEIDS" + i, clean(r.PINUNIQUEIDS)]);
      out.push(["PINPAIRGUID" + i, src.ids["xsignal:" + x.name] || "{" + uniqueId(doc.id + "/xsignal/" + x.name) + "}"]);
    });
    return out;
  }
  function exportBoard(project, requested, modelFiles = new Map(), observer) {
    const Atr = A(), doc = typeof requested === "string" ? project.documents.find(d => d.id === requested) : requested;
    if (doc?.kind !== "pcb") throw Error("Choose a PCB layout to export.");
    const defs = new Map(project.library.map(d => [d.id, d])), notes = notebook(), report = observer ? observer.diagnostics(notes.add) : notes.add, text = s => clean(s);
    const counts = {components: 0, pads: 0, tracks: 0, arcs: 0, vias: 0, fills: 0, texts: 0, regions: 0, polygons: 0, rules: 0, nets: 0};
    for (const m of doc.notes || []) notes.add(m);
    // Altium's workspace starts at its absolute origin, so a board with negative Altium coordinates
    // (any Waffle board drawn below and right of its origin, Y down) moves up by a whole 100 mil
    // step. The relative origin takes the same shift as the artwork. Boards
    // already in Altium's workspace keep their absolute coordinates.
    const ext = Atr.docBounds?.(doc, defs) || Atr.bounds(doc.outline?.length ? doc.outline : [[0, 0]]) || [0, 0, 0, 0];
    const step = 2.54, sx = ext[0] < 0 ? Math.ceil((25.4 - ext[0]) / step) * step : 0, sy = -ext[3] < 0 ? Math.ceil((25.4 + ext[3]) / step) * step : 0;
    const X = v => mil(v + sx), Y = v => mil(sy - v), XY = (kx, ky, p) => [[kx, X(p[0])], [ky, Y(p[1])]];
    const rot = a => globalThis.AtriumTranslatorPrecision?.angle(a) ?? n4(mod(-(a || 0), 360));
    const lines = [], push = fields => lines.push(record(fields, report));
    // Nets in name order; IDs are positions.
    const netSet = new Set();
    for (const i of doc.items) { if (i.net) netSet.add(i.net); for (const v of Object.values(i.pinNets || {})) if (v) netSet.add(v); }
    for (const def of defs.values()) for (const p of def.footprint?.pads || []) if (p.net && doc.items.some(i => i.kind === "part" && i.def === def.id)) netSet.add(p.net);
    for (const i of doc.items) if (i.kind === "part") for (const s of defs.get(i.def)?.footprint?.shapes || []) if (s.net) netSet.add(s.net);
    const netNames = [...netSet].sort(), netId = new Map(netNames.map((s, k) => [s, k]));
    const netField = net => net && netId.has(net) ? [["NET", netId.get(net)]] : [];
    // Board: outline and layer stack.
    const board = [["RECORD", "Board"], ["KIND", "Protel_Advanced_PCB"], ["VERSION", "5.00"], ["FILENAME", text(fileName(doc.name, ".PcbDoc"))],
      ...XY("ORIGINX", "ORIGINY", doc.origin || [0, 0])];
    board.push(...pinPairFields(project, doc));
    const outline = doc.outline || [];
    function contourFields(segments, vertices = null) {
      return segments.flatMap((g, k) => {
        const arc = g.kind === "arc", p = vertices?.[k] || (arc ? Atr.arcPoint(g, g.start) : g.a);
        return [["KIND" + k, arc ? 1 : 0], ...XY("VX" + k, "VY" + k, p),
          ["CX" + k, arc ? X(g.c[0]) : "0mil"], ["CY" + k, arc ? Y(g.c[1]) : "0mil"],
          ["SA" + k, arc ? g.ccw ? g.start : g.end : 0], ["EA" + k, arc ? g.ccw ? g.end : g.start : 0], ["R" + k, arc ? mil(g.r) : "0mil"]];
      });
    }
    const perimeter = globalThis.AtriumBoardShape?.fresh(doc)?.contour;
    if (outline.length >= 3) {
      // A Board uses consecutive vertex pairs. The last row terminates its last edge.
      const edges = perimeter ? perimeter.slice() : outline.map(a => ({kind:"line",a}));
      const vertices = edges.map((edge, k) => {
        if (edge.kind !== "arc") return edge.a;
        // An adjacent line retains the shared source vertex. Rounding the center
        // and radius separately can put its computed location one native tick away.
        const previous = edges[(k + edges.length - 1) % edges.length];
        const point = Atr.arcPoint(edge,edge.start), end = previous.kind === "line" && previous.b;
        return end && Math.max(Math.abs(end[0]-point[0]),Math.abs(end[1]-point[1])) <= 2*MIL/10000 ? end : point;
      });
      const start = vertices[0];
      // Board6 and saved projects can already include the closing row as a zero-length line.
      while (edges.length > 1) {
        const last = edges.at(-1);
        if (last.kind !== "line" || X(last.a[0]) !== X(start[0]) || Y(last.a[1]) !== Y(start[1])) break;
        edges.pop(); vertices.pop();
      }
      edges.push({kind:"line",a:start}); vertices.push(start);
      for (const field of contourFields(edges,vertices)) board.push(field);
    } else report("No closed board outline available.");
    // Copper layers in stack order: Top (1), Mid n (n+1), Bottom (32).
    const inner = new Set();
    const mark = l => { const m = /^Inner (\d+)$/.exec(l || ""); if (m) inner.add(+m[1]); };
    for (const i of doc.items) { mark(i.layer); mark(i.fromLayer); mark(i.toLayer); }
    let stack = null;
    try { stack = doc.stackup ? globalThis.AtriumStackup?.get?.(doc, defs) || doc.stackup : null; } catch { stack = doc.stackup || null; }
    const copper = (stack?.layers || []).filter(l => COPPER.test(l.key || ""));
    for (const l of copper) mark(l.key);
    const chain = ["Top", ...[...inner].sort((a, b) => a - b).filter(k => k <= 30).map(k => "Inner " + k), "Bottom"];
    if ([...inner].some(k => k > 30)) report("Inner layers beyond 30 have no Altium mid layer and were left out.");
    const planes = new Map(doc.items.filter(i => i.kind === "polygon" && i.powerPlane).map(i => [i.layer, i.powerPlane.sourceLayer]));
    const idOf = key => planes.has(key) ? 38 + Number(planes.get(key).slice(5)) : key === "Top" ? 1 : key === "Bottom" ? 32 : +key.slice(6) + 1;
    chain.forEach((key, k) => {
      const id = idOf(key), next = k < chain.length - 1 ? idOf(chain[k + 1]) : 0, layer = copper.find(l => l.key === key);
      board.push(["LAYER" + id + "NAME", text(layer?.name || (key === "Top" ? "Top Layer" : key === "Bottom" ? "Bottom Layer" : "Mid-Layer " + key.slice(6)))], ["LAYER" + id + "NEXT", next],
        ["LAYER" + id + "PREV", k ? idOf(chain[k - 1]) : 0], ["LAYER" + id + "MECHENABLED", "TRUE"], ["LAYER" + id + "COPTHICK", mil(layer?.thickness || .035)]);
      if (next) {
        const list = stack?.layers || [], a = list.indexOf(layer), b = list.findIndex(l => l.key === chain[k + 1]);
        const diel = a >= 0 && b > a ? list.slice(a + 1, b).filter(l => l.type === "Dielectric") : [];
        const h = diel.reduce((s, l) => s + (l.thickness || 0), 0) || (chain.length === 2 ? 1.5 : 1.5 / (chain.length - 1));
        board.push(["LAYER" + id + "DIELTYPE", diel[0]?.dielectric === "Prepreg" ? 2 : 1], ["LAYER" + id + "DIELCONST", n4(diel[0]?.dk || 4.8)], ["LAYER" + id + "DIELHEIGHT", mil(h)],
          ["LAYER" + id + "DIELMATERIAL", text(diel[0]?.material || "FR-4")]);
      }
    });
    if (copper.some(l => l.type === "Plane" && !planes.has(l.key))) report("Plane layers export as signal (mid) layers; set them as internal planes in Altium's Layer Stack Manager.");
    const mask = (stack?.layers || []).filter(l => l.type === "Solder Mask");
    if (mask[0]) board.push(["TOPHEIGHT", mil(mask[0].thickness || .01016)], ["TOPMATERIAL", text(mask[0].material || "Solder Resist")], ["TOPCONST", n4(mask[0].dk || 3.5)]);
    if (mask[1]) board.push(["BOTTOMHEIGHT", mil(mask[1].thickness || .01016)], ["BOTTOMMATERIAL", text(mask[1].material || "Solder Resist")], ["BOTTOMCONST", n4(mask[1].dk || 3.5)]);
    for (let k = 1; k <= 16; k++) { const name = doc.layerNames?.["Mechanical " + k]; if (name) board.push(["LAYER" + (56 + k) + "NAME", text(name)]); }
    push(board);
    netNames.forEach((name, k) => { push([["RECORD", "Net"], ["ID", k], ["NAME", text(name)]]); counts.nets++; });
    // Primitives. owner: component ID or null.
    const ownerField = owner => owner == null ? [] : [["COMPONENT", owner]];
    const zones = doc.items.filter(i => i.kind === "polygon" && !i.cutout && i.points?.length >= 3 && COPPER.test(i.layer || "") && (i.powerPlane?.sourceLayer || layerOf(i.layer)));
    const zoneRecords = new Map(zones.map((p,n) => [p.id,n]));
    const pourParent = i => zoneRecords.has(i.sourcePour) ? [["POLYGON",zoneRecords.get(i.sourcePour)]] : [];

    // Parent IDs precede every primitive which references them. A Polygon has
    // a repeated closing vertex, a UTF-16 code-unit list for its name, and
    // AREATHRESHOLD in square 1/10000 mil (not square mil).
    const tick = MIL / 10000;
    for (const zone of observer ? observer.items(doc,zones,() => counts.polygons) : zones) {
      const id = zoneRecords.get(zone.id), layer = zone.powerPlane?.sourceLayer || layerOf(zone.layer);
      const exact = globalThis.AtriumBoardShape?.regionOf(zone)?.contour;
      const edges = exact ? exact.slice() : zone.points.map(a => ({kind:"line",a}));
      const first = edges[0].kind === "arc" ? Atr.arcPoint(edges[0],edges[0].start) : edges[0].a;
      if (exact || !Atr.same(first,edges.at(-1).a)) edges.push({kind:"line",a:first});
      const name = String(zone.name || "").split("").map(ch => ch.charCodeAt(0)).join(",");
      const outlined = zone.fillMode === "outline", hatched = zone.fillMode === "hatched";
      const settings = [["RECORD","Polygon"],["ID",id],...netField(zone.net),["INDEXFORSAVE",id],["LAYER",layer],
        ["POLYGONTYPE",zone.powerPlane ? "Split Plane" : "Polygon"],["POUROVER",TRUE(zone.pourOverSameNet !== false)],["REMOVEDEAD",TRUE(zone.removeDeadCopper !== false)],
        ["GRIDSIZE",mil(zone.hatchPitch || (hatched ? .5 : .254))],["TRACKWIDTH",mil(zone.hatchWidth || (hatched || outlined ? .15 : .254))],
        ["HATCHSTYLE",outlined ? "None" : hatched ? zone.hatchAngle === 45 ? "45Degree" : zone.hatchAngle === 0 ? "Horizontal" : "90Degree" : "Solid"],
        ["MINPRIMLENGTH",mil(zone.minPrimLength ?? .0762)]];
      for (const pair of contourFields(edges)) settings.push(pair);
      if (zone.sourcePourOver?.sameNet === zone.pourOverSameNet && [0,1,2].includes(zone.sourcePourOver?.style))
        settings.push(["POUROVERSTYLE",zone.sourcePourOver.style]);
      settings.push(["SHELVED",TRUE(!!zone.shelved)],["RESTORELAYER","UNKNOWN"],["RESTORENET",zone.net || ""],
        ["ARCRESOLUTION",mil(zone.arcApproximation ?? .0127)], ["REMOVEISLANDSBYAREA",TRUE(zone.islandAreaThreshold > 0)],
        ["AREATHRESHOLD",zone.islandAreaThreshold > 0 ? zone.islandAreaThreshold / (tick*tick) : 0],
        ["REMOVENECKS",TRUE(zone.neckWidth > 0)],["NECKWIDTHTHRESHOLD",mil(zone.neckWidth || 0)],
        ["NAME",name],["POURINDEX",Math.round(+zone.pourIndex || 0)]);
      push(settings);counts.polygons++;
      if (zone.connectStyle && zone.connectStyle !== "relief" || zone.clearance != null)
        report("Pour connect styles and clearances come from Altium's design rules. Per-pour overrides require review after repouring in Altium.");
    }
    const drawing = doc.pcbDrawing, P = globalThis.AtriumPolygonPour, archive = globalThis.AtriumPCBPours;
    let saved = drawing?.pours || [], replaced = new Set();
    if (saved.length || drawing?.sourceHatchSignature || Object.keys(drawing?.pourSignatures || {}).length || doc.items.some(i => i.sourcePour != null)) {
      if (P && archive) {
        const current = P.outputCopper(doc, defs, {project, evaluatedOnly:true});
        saved = current.regions; replaced = new Set(current.filled);
      } else if (!archive?.matchesSignature(doc,defs,project)) {
        throw Error("Stored polygon copper could not be verified. Load the polygon pour engine before exporting this board.");
      }
    }

    function track(points, width, layer, net, owner, extra = [], preservePointStroke = false) {
      const singleStroke = preservePointStroke && points.length === 2;
      for (let k = 1; k < points.length; k++) {
        const a = points[k - 1], b = points[k];
        // PCB tracks use the file's native coordinates, finer than the model's
        // connection key. A two-point stroke can also describe a round dot.
        if (!singleStroke && Atr.same(a, b)) continue;
        push([["RECORD", "Track"], ["LAYER", layer], ...ownerField(owner), ...netField(net), ...XY("X1", "Y1", a), ...XY("X2", "Y2", b), ["WIDTH", mil(width)], ...extra]);
        counts.tracks++;
      }
    }
    // A Fill is a rectangle before its optional rotation around the centre.
    function filled(points, layer, net, owner, extra = []) {
      let ps = points;
      if (ps.length === 5 && Atr.same(ps[0], ps[4])) ps = ps.slice(0,-1);
      if (ps.length !== 4) return false;
      const [a,b,c,d] = ps, u=[b[0]-a[0],b[1]-a[1]], v=[c[0]-b[0],c[1]-b[1]];
      const w=Math.hypot(...u), h=Math.hypot(...v);
      if (!(w>0 && h>0) || Math.abs(u[0]*v[0]+u[1]*v[1])>1e-7*w*h ||
          Math.hypot(c[0]-u[0]-d[0],c[1]-u[1]-d[1])>1e-6) return false;
      const x=(a[0]+c[0])/2, y=(a[1]+c[1])/2, angle=Math.atan2(u[1],u[0])*180/Math.PI;
      push([["RECORD","Fill"],["LAYER",layer],...ownerField(owner),...netField(net),
        ...XY("X1","Y1",[x-w/2,y+h/2]),...XY("X2","Y2",[x+w/2,y-h/2]),["ROTATION",rot(angle)],...extra]);
      counts.fills++; return true;
    }
    function regionRecord(points, shape, layer, net, owner, kind, extra = [], raw = null, sub = -1) {
      const S = globalThis.AtriumBoardShape;
      // Straight native hole vertices are already precise. Display flattening
      // rounds to a nanometre, enough to push a tangential hole beyond its wall.
      const holes = raw ? raw.slice(1) : (shape?.cutouts || []).map(c =>
        c.every(e => e.kind === "line") ? c.map(e => e.a) : S.flattenContour(c));
      const fields = [["RECORD", "Region"], ["INDEXFORSAVE", counts.regions], ["LAYER", layer], ["V7_LAYER", layer], ...ownerField(owner), ...netField(net),
        ["KIND", kind === "polygon cutout" ? 1 : 0], ["ISBOARDCUTOUT", TRUE(kind === "board cutout")],
        // Designer selects typed VX/Y edges when the field is present, even
        // when the text says FALSE. Its flat MVX/Y records omit it entirely.
        ["ISSHAPEBASED", shape ? "TRUE" : undefined], ["SUBPOLYINDEX", sub], ...extra];
      const vertices = (ring, prefix) => {
        for (let k = 0; k < ring.length; k++) {
          const [x,y] = ring[k];
          fields.push([prefix+"VX"+k,raw ? x+sx/tick : (sx+x)/tick], [prefix+"VY"+k,raw ? y+sy/tick : (sy-y)/tick]);
        }
      };
      if (shape) {
        fields.push(["MAINCONTOURVERTEXCOUNT", shape.contour.length]);
        for (const pair of contourFields(shape.contour)) fields.push(pair);
      } else {
        const ring = raw ? raw[0] : points.length > 3 && Atr.same(points[0], points.at(-1)) ? points.slice(0,-1) : points;
        fields.push(["MAINCONTOURVERTEXCOUNT",ring.length]);vertices(ring,"M");
      }
      fields.push(["HOLECOUNT",holes.length]);
      holes.forEach((ring,h) => {
        fields.push(["HOLE"+h+"VERTEXCOUNT",ring.length]);vertices(ring,"H"+h);
      });
      push(fields); counts.regions++;
    }
    const shapeAPI = globalThis.AtriumBoardShape, boardShape = shapeAPI?.fresh(doc);
    for (const [i, contour] of (boardShape?.cutouts || []).entries())
      regionRecord([], shapeAPI.cutoutRegion(boardShape,i) || {contour}, "MULTILAYER", "", null, "board cutout");
    const justifications=["top-left","middle-left","bottom-left","top-center","center","bottom-center","top-right","middle-right","bottom-right"];
    function textRecord(o, layer, owner, extra = [], source) {
      const size=o.size>0?o.size:1, width=o.width>0?o.width:Math.min(.25,size/8);
      const mirror=o.mirrored ?? /^BOTTOM/i.test(layer), ttf=o.font==="truetype", box=o.sourceTextBox;
      const justify=o.justify || (o.align==="center"?"bottom-center":o.align==="right"?"bottom-right":undefined);
      const code=justifications.indexOf(justify)+1, anchor=[o.x,o.y], angle=o.angle||0;
      let baseline=anchor;
      const style=box && (ttf ? box.font!=="stroke" && box.family===(o.family||"Arial") && !!box.bold===!!o.bold && !!box.italic===!!o.italic :
        box.font==="stroke" && box.strokeFont===(o.strokeFont||"default") && box.strokeWidth===(o.width||0));
      const matches=style && box.text===o.text && box.size===size, fields=[];
      if(code){
        let offset=null;
        if(matches && box.sourceJustify===justify && Array.isArray(box.writingOffset) && box.writingOffset.length===2 && box.writingOffset.every(Number.isFinite))
          offset=box.writingOffset;
        else if(globalThis.AtriumPCBText){
          // Changed lettering and earlier projects have no matching saved pen offset.
          // Align their actual ink to the same box in the native lower-left writing frame.
          const T=globalThis.AtriumPCBText, item={...o,mirrored:false,justify};
          const placed=T.layoutItem(item,layer).box;
          const writing=T.layoutItem({...item,justify:"bottom-left",sourceTextBox:box?{...box,mode:"baseline"}:undefined},layer).box;
          offset=[placed[0]-writing[0],placed[1]-writing[1]];
        }
        if(offset){
          const v=Atr.rotate([mirror?-offset[0]:offset[0],offset[1]],angle);
          baseline=[anchor[0]+v[0],anchor[1]+v[1]];
        }
        fields.push(["TTFINVERTEDTEXTJUSTIFY",code],["ADVANCESNAPPING","TRUE"],...XY("JUSTIFICATIONCENETERX","JUSTIFICATIONCENETERY",anchor));
      }
      if(matches && box.width>0 && box.height>0){
        const pen=ttf?0:width;
        fields.push(["INVRECTWIDTH",mil(box.width+pen)],["INVRECTHEIGHT",mil(box.height+pen)],["USEINVERTEDRECTANGLE",TRUE(box.mode==="frame")]);
      }
      const value=String(o.text??"");
      push([["RECORD","Text"],["LAYER",layer],...ownerField(owner),...XY("X","Y",baseline),["HEIGHT",mil(size)],["WIDTH",mil(width)],
        ["ROTATION",observer?.precision?.angle(source) ?? rot(angle)],["MIRROR",TRUE(mirror)],["FONT",o.strokeFont==="sans"?"SansSerif":o.strokeFont==="serif"?"Serif":"DEFAULT"],
        ["USETTFONTS",TRUE(ttf)],["TEXTKIND",ttf?1:0],["FONTNAME",text(o.family||"Arial")],["BOLD",TRUE(!!o.bold)],["ITALIC",TRUE(!!o.italic)],
        ["INVERTED",TRUE(!!o.inverted)],["INVERTEDTTTEXTBORDER",o.margin!=null?mil(o.margin):undefined],
        ["TEXT",text(value)],["WIDESTRING",value.split("").map(c=>c.charCodeAt(0)).join(",")],...fields,...extra]);
      counts.texts++;
    }
    function arcRecord(g, layer, width, net, owner, extra = []) {
      // Altium arcs always run counter-clockwise. Swap the endpoints of a clockwise path
      // and retain its traversal sense for an editable Waffle round trip.
      const start = mod(g.ccw ? g.start : g.end, 360), full = Math.abs(Atr.arcSweep(g)) === 360;
      const end = full ? start + 360 : mod(g.ccw ? g.end : g.start, 360);
      // Designer reads the dotted fields. X/Y keep older Waffle readers interoperable.
      push([["RECORD", "Arc"], ["LAYER", layer], ...ownerField(owner), ...netField(net), ...XY("LOCATION.X", "LOCATION.Y", g.c),
        ...XY("X", "Y", g.c), ["RADIUS", mil(g.r)], ["STARTANGLE", start], ["ENDANGLE", end], ["WIDTH", mil(width)],
        ...(!g.ccw ? [["WAFFLECLOCKWISE", "TRUE"]] : []), ...extra]);
      counts.arcs++;
    }
    function graphic(o, owner, world = p => p, angle = 0, partLayer = "Top", mirror = false) {
      const keep = !o.planeVoid && (o.keepout === true || /^keep-?out/i.test(o.layer || ""));
      const side = partLayer === "Bottom" ? "Bottom" : "Top";
      const raw = o.layer || (o.style === "package" ? "Mechanical 13" : side === "Bottom" ? "Bottom silk" : "Silk");
      const layer = o.planeVoid && planes.has(raw) ? planes.get(raw) : keep && o.keepout !== true ? "KEEPOUT" : layerOf(raw);
      if (!layer) { report("Graphics on layers Altium has no equivalent for (" + raw + ") omitted."); return; }
      const extra = keep ? [["KEEPOUT", "TRUE"], ["KEEPOUTRESTRICTIONS", o.keepoutRestrictions]] : [...pourParent(o), ...maskFields(o)];
      if (keep && o.keepout === true) report("Single-layer keep-outs are written as keep-out primitives on their copper layer (KEEPOUT=TRUE).");
      if (o.dimension && globalThis.AtriumPCBDraw) { for (const p of AtriumPCBDraw.dimensionPrimitives(o)) graphic({...p, dimension: undefined}, owner, world, angle, partLayer); report("Dimensions export as lines and text (Altium dimension objects are not written)."); return; }
      if (o.kind === "text" || o.kind === "label") {
        if (o.kind === "text" && !o.text) return;
        const t = o.text === ".Designator" || o.text === ".Comment" ? o.text : o.text;
        textRecord({...o, ...(() => { const q = world([o.x, o.y]); return {x: q[0], y: q[1]}; })(), angle: (o.angle || 0) + angle, text: t}, layer, owner, extra, owner == null ? o : undefined);
        return;
      }
      if (o.kind === "circle") {
        arcRecord({kind:"arc", c:world([o.x,o.y]), r:o.r, start:0, end:360, ccw:true}, layer, o.width || .12, o.net, owner, extra);
        if (o.fill) report("Filled circles export as their outline."); return;
      }
      const arc = Atr.pathArc(o);
      if (arc && !o.fill) { arcRecord(Atr.transformArc(arc, world, angle, mirror), layer, o.width ?? .1, o.net, owner, extra); return; }
      const pts = (o.points || []).map(world);
      if (pts.length < 2) return;
      if ((o.fill || o.cutout) && pts.length >= 3) {
        let shape = shapeAPI?.regionOf(o);
        if (!shape && !o.cutout && (o.fillRect || o.width !== 0) && filled(pts, layer, o.net, owner, extra)) return;
        if (shape && owner != null) {
          const move = c => shapeAPI.placeContour(c, world, angle, mirror);
          shape = {contour:move(shape.contour), cutouts:shape.cutouts.map(move)};
        }
        regionRecord(pts, shape, layer, o.net, owner, o.cutout ? "polygon cutout" : "region", extra);
        return;
      }
      const closed = (o.closed || o.fill) && pts.length >= 3 && !Atr.same(pts[0], pts.at(-1)) ? [...pts, pts[0]] : pts;
      track(closed, o.width > 0 ? o.width : .1, layer, COPPER.test(raw) ? o.net : "", owner, extra);
    }
    const testpointFields = o => o.fabTestpoint ? [["TESTPOINTTOP", TRUE(o.fabTestpoint !== "Bottom")], ["TESTPOINTBOTTOM", TRUE(o.fabTestpoint !== "Top")]] : [];
    function pad(o, owner, world, angle, partLayer, net, source) {
      const at = world([o.x, o.y]), drill = o.drill || 0, shape = SHAPES[String(o.shape || "round").toLowerCase()];
      let w = o.w, h = o.h;
      if (!(w > 0 && h > 0)) { report("Pads without copper size omitted."); return; }
      if (!shape) { report("Custom-shaped pads export as rectangles of their extent; redraw them in Altium."); }
      if (shape === "ROUND" && Math.abs(w - h) > 1e-9 && /ellipse|oval/.test(o.shape || "")) report("Oval pads export as Altium rounded (obround) pads.");
      if (shape === "OCTAGONAL") report("Octagonal pads export as Altium octagonal pads (Waffle's Altium importer reads them as rectangles).");
      const stack=[];
      if(o.stackMode==="tmb" && ["Top","Mid","Bottom"].every(k=>o.padStack?.[k])){
        stack.push(["PADMODE","TopMiddleBottom"]);
        for(const [k,prefix] of [["Top","TOP"],["Mid","MID"],["Bottom","BOT"]]){
          const row=o.padStack[k];stack.push([prefix+"XSIZE",mil(row.w)],[prefix+"YSIZE",mil(row.h)],[prefix+"SHAPE",SHAPES[row.shape]||shape||"RECTANGLE"]);
        }
      }
      const layer = drill > 0 ? "MULTILAYER" : layerOf(o.layer || partLayer || "Top") || "TOP";
      push([["RECORD", "Pad"], ...ownerField(owner), ...netField(net), ["NAME", text(o.number ?? "")], ["LAYER", layer], ...XY("X", "Y", at), ["XSIZE", mil(o.holeOnly ? 0 : w)], ["YSIZE", mil(o.holeOnly ? 0 : h)], ...stack, ...maskFields(o),
        ["SHAPE", shape || "RECTANGLE"], ...(shape==="ROUNDEDRECTANGLE" && o.roundrectRadiusRatio!=null ? [["CRPERCENTAGE", +((A().padCornerRatio(o)*200).toFixed(6))]] : []), ["HOLESIZE", mil(drill)], ...(o.slotLength > drill ? [["HOLETYPE","Slot"],["HOLELENGTH",mil(o.slotLength)],["HOLEROTATION",observer?.precision?.angle(source, "slotAngle") ?? rot(o.slotAngle || 0)]] : []), ["ROTATION", observer?.precision?.angle(source) ?? rot((o.angle || 0) + angle)], ["PLATED", TRUE(o.plated !== false)], ...testpointFields(o), ["DAISYCHAIN", "Load"]]);
      counts.pads++;
    }
    function maskFields(o) {
      const fields=[];
      for(const [side,key] of [["top","TENTINGTOP"],["bottom","TENTINGBOTTOM"]]){
        if(typeof o.tent?.[side]==="boolean")fields.push([key,TRUE(o.tent[side])]);
      }
      for(const [field,key] of [["maskExpansion","SOLDERMASK"],["pasteExpansion","PASTEMASK"]]){
        if(Number.isFinite(o[field]))fields.push([key+"EXPANSION_MODE","Manual"],[key+"EXPANSION_MANUAL",mil(o[field])]);
      }
      return fields;
    }
    function via(o, p, net, owner = null) {
      if (!(o.diameter > 0 && o.drill > 0)) { report("Vias without a valid diameter and drill omitted."); return; }
      const from = o.fromLayer ? layerOf(o.fromLayer) : "TOP", to = o.toLayer ? layerOf(o.toLayer) : "BOTTOM";
      if (o.fromLayer || o.toLayer) report("Blind and buried vias keep their layer span; define the drill pairs in Altium.");
      if (o.stackMode || o.padStack || o.backdrill) report("Via stacks (per-layer lands, back-drill) export at the nominal diameter.");
      push([["RECORD", "Via"], ["LAYER", "MULTILAYER"], ...ownerField(owner), ...netField(net), ...XY("X", "Y", p), ["DIAMETER", mil(o.diameter)],
        ["HOLESIZE", mil(o.drill)], ["STARTLAYER", from || "TOP"], ["ENDLAYER", to || "BOTTOM"], ...maskFields(o), ...testpointFields(o)]);
      counts.vias++;
    }
    const catalogues = new Map();
    let stepBodies = 0, missingBodyFiles = 0;
    function componentBody(b, owner, i, source = doc) {
      if (!catalogues.has(source)) catalogues.set(source, new Map((source.bodyModels || []).map(a => [a.id, a])));
      const asset = catalogues.get(source).get(b.modelId);
      const flipped = (i?.layer === "Bottom" ? "Bottom" : "Top") !== b.ownerSide, sign = flipped ? -1 : 1;
      const side = flipped ? (b.side === "Bottom" ? "Top" : "Bottom") : b.side;
      // world() reflects a mirrored part's local X (pcb-appearance.js); its arcs turn to 180 - angle with it.
      const world = q => i ? Atr.world([q[0], sign * q[1]], i) : q, mirror = i?.mirror === true;
      const turn = v => (mirror ? 180 - sign * v : sign * v) - (i?.angle || 0);
      const outer = b.contour?.length ? b.contour.map(g => g.kind === "line" ? {kind: "line", a: world(g.a)} :
        {...g, c: world(g.c), start: turn(g.start), end: turn(g.end), ccw: flipped !== mirror ? !g.ccw : g.ccw}) :
        (b.rings?.[0] || []).map(q => ({kind: "line", a: world(q)}));
      const holes = (b.rings || []).slice(1);
      const fields = [["RECORD", "ComponentBody"], ["COMPONENT", owner], ["LAYER", layerOf(b.layer) || b.layer],
        ["INDEXFORSAVE", counts.bodies3d || 0], ["KIND", 0], ["SUBPOLYINDEX", -1], ["ARCRESOLUTION", "0.5mil"],
        ["ISSHAPEBASED", "TRUE"], ["MAINCONTOURVERTEXCOUNT", outer.length], ...contourFields(outer), ["HOLECOUNT", holes.length],
        ["MODEL.MODELTYPE", b.type === "step" ? 1 : b.type === "extruded" ? 0 : b.modelType], ["MODELID", b.modelId],
        ["WAFFLE.SOURCERECORD", b.sourceRecord], ["WAFFLE.SHAPERECORD", b.shapeRecord],
        ["BODYPROJECTION", side === "Bottom" ? 1 : 0], ["IDENTIFIER", (b.identifier || "").split("").map(c => c.charCodeAt(0)).join(",")],
        ["STANDOFFHEIGHT", mil(b.minZ)], ["OVERALLHEIGHT", mil(b.maxZ)],
        ["BODYCOLOR3D", b.color], ["BODYOPACITY3D", b.opacity], ...XY("MODEL.2D.X", "MODEL.2D.Y", world(b.at)),
        ["MODEL.2D.ROTATION", n4(sign * b.angle - (i?.angle || 0))], ["MODEL.3D.DZ", mil(b.dz)],
        ...["ROTX", "ROTY", "ROTZ"].map((k, n) => ["MODEL.3D." + k, b.rotation[n]])];
      if (b.type === "extruded") fields.push(["MODEL.EXTRUDED.MINZ", mil(b.minZ)], ["MODEL.EXTRUDED.MAXZ", mil(b.maxZ)]);
      if (b.type === "step") {
        const member = modelFiles.get(asset), path = asset?.file || "";
        const name = member || path.split(/[\\/]/).pop() || "";
        fields.push(["MODEL.EMBED", "FALSE"], ["MODEL.CHECKSUM", asset?.checksum], ["MODEL.NAME", name], ["MODEL.MODELSOURCE", "Undefined"]);
        // Keep the original locator so the Waffle resolver can distinguish a safe
        // project-relative path from an unresolved absolute or parent path.
        if (!member && path !== name) fields.push(["WAFFLE.MODELPATH", path]);
        stepBodies++;
        if (!member) missingBodyFiles++;
        const bodyRef = (i?.id || doc.id) + "/" + (b.sourceRecord || b.id || b.modelId);
        observer?.observed(doc,bodyRef,"STEP body","approximated",member ? "The native record and accompanying STEP file are recoverable; check model appearance in Altium Designer." : "The body retains a reference but no STEP companion was available.");
      }
      for (const [h, ring] of holes.entries()) {
        fields.push(["HOLE" + h + "VERTEXCOUNT", ring.length]);
        for (const [n, q] of ring.entries()) {
          const [x,y] = world(q);
          fields.push(["H" + h + "VX" + n, n4((x + sx)/FRAC)], ["H" + h + "VY" + n, n4((sy - y)/FRAC)]);
        }
      }
      push(fields);
      counts.bodies3d = (counts.bodies3d || 0) + 1;
    }
    for (const b of doc.bodies3d || []) componentBody(b, null, null);
    let componentId = 0;
    for (const i of observer ? observer.items(doc,doc.items,() => lines.length) : doc.items) {
      if (i.sourcePour != null && replaced.has(i.sourcePour)) continue;
      if (i.kind === "part") {
        const def = defs.get(i.def), fp = observer?.precision?.footprint(doc,def) || def?.footprint;
        if (!fp) { report("Components without a footprint omitted."); continue; }
        const id = componentId++, side = i.layer === "Bottom" ? "Bottom" : "Top", world = p => Atr.world(p, i);
        const linked=Array.isArray(i.boardLabels)?i.boardLabels:doc.pcbDrawing?.annotations && /^components(?:6)?\/data#\d+$/.test(i.sourceRecord||"") ?
          (doc.pcbDrawing.annotations[i.sourceRecord]||[]) : null;
        const hidden=i.hiddenBoardLabels||[];
        const nameOn=i.showRef ?? (!!i.designator || (linked?linked.some(a=>a.field==="ref"):true));
        const commentOn=i.showValue ?? (linked?linked.some(a=>a.field==="value"):false);
        push([["RECORD", "Component"], ["ID", id], ["LAYER", side === "Bottom" ? "BOTTOM" : "TOP"], ...XY("X", "Y", [i.x, i.y]), ["ROTATION", observer?.precision?.angle(i) ?? rot(i.angle)], ["PATTERN", text(fp.name || def.name || "Footprint")], ["HEIGHT", Number.isFinite(i.height) ? mil(i.height) : undefined],
          ["SOURCEDESIGNATOR", text(i.ref || "")], ["SOURCECOMMENT", text(i.value || "")], ["SOURCEUNIQUEID", "\\" + uniqueId(i.link || i.id)], ["SOURCEFOOTPRINTLIBRARY", "Atrium.PcbLib"],
          ["NAMEON", TRUE(nameOn)], ["COMMENTON", TRUE(commentOn)], ["LOCKED", TRUE(!!i.locked)]]);
        counts.components++;
        for (const b of i.bodies3d || fp.bodies3d || []) componentBody(b, id, i, i.bodies3d ? doc : fp);
        // Keep the component's text objects even when their visibility is off.
        const box = Atr.bounds(Atr.symbolPoints(fp)) || [0,0,0,0];
        for(const field of ["ref","value"]){
          const isRef=field==="ref", role=[[isRef?"DESIGNATOR":"COMMENT","TRUE"]];
          const placed=isRef && i.designator && globalThis.AtriumDesignators?.label(i,def);
          if(placed){
            textRecord({x:placed.anchor[0],y:placed.anchor[1],angle:placed.angle,size:placed.height,width:placed.stroke,
              mirrored:placed.mirror,justify:"bottom-center",text:placed.text},layerOf(placed.layer),id,role);
            continue;
          }
          const rows=[...(linked||[]),...hidden].filter(a=>a.field===field);
          if(rows.length){
            for(const a of rows){
              const q=world(a.at), textLayer=layerOf(a.layer);
              if(textLayer)textRecord({...a,x:q[0],y:q[1],angle:(i.angle||0)+(a.angle||0),text:i[field]||""},textLayer,id,role);
            }
          }else{
            const local=isRef?(i.refAt||[(box[0]+box[2])/2,box[1]-.7]):(i.valueAt||[(box[0]+box[2])/2,box[3]+1]);
            const q=world(local), layer=isRef?(side==="Bottom"?"BOTTOMOVERLAY":"TOPOVERLAY"):"MECHANICAL13";
            textRecord({x:q[0],y:q[1],text:i[field]||"",size:1,angle:i.angle||0},layer,id,role);
          }
        }
        // PcbDoc primitives have no mirror flag: a mirrored part writes its reflected footprint.
        const {item: frame, footprint: local} = Atr.pcbMirror.placed(i, fp), place = p => Atr.world(p, frame);
        const shapes = (local.shapes || []).filter(s => !((s.kind === "text" || s.kind === "label") && (s.text === ".Designator" || s.text === ".Comment")));
        for (const s of observer ? observer.items(doc,shapes,() => lines.length,"Footprint graphic",i.id) : shapes) {
          graphic(s, id, place, i.angle || 0, side, false);
        }
        for (const p of observer ? observer.items(doc,local.pads || [],() => counts.pads + counts.vias,"Footprint pad",i.id) : local.pads || []) {
          const net = i.pinNets?.[p.number] ?? p.net ?? "";
          if (p.kind === "via") { via(p, place([p.x, p.y]), net, id); continue; }
          pad(p, id, place, i.angle || 0, side, net, !i.angle && !i.mirror ? p : undefined);
        }
      } else if (i.kind === "pad") pad({...i, x: 0, y: 0}, null, p => [p[0] + i.x, p[1] + i.y], 0, i.layer, i.net || "", i);
      else if (i.kind === "via") via(i, [i.x, i.y], i.net || "");
      else if (i.kind === "track") {
        const layer = layerOf(i.layer);
        if (!layer || !COPPER.test(i.layer || "")) { report("Tracks on unsupported layers omitted."); continue; }
        const extra = [...pourParent(i), ...maskFields(i)];
        const arc = Atr.pathArc(i);
        if (arc) arcRecord(arc, layer, i.width ?? .25, i.net, null, extra);
        else track(i.points || [], i.width || .25, layer, i.net, null, extra, i.width > 0);
      } else if (i.kind === "graphic" || i.kind === "label") {
        if (i.kind === "label" && !i.layer) { textRecord(i, "TOPOVERLAY", null, [], i); continue; }
        graphic(i, null);
      } else if (i.kind === "polygon") {
        if (i.cutout) graphic(i, null);
        else if (!zoneRecords.has(i.id)) report("Polygon pours on unsupported layers or without a closed outline omitted.");
      } else report("Unsupported board item " + i.kind + " omitted.");
    }
    const nextIsland = new Map();
    // A board saved by a previous Waffle version may mix numbered source
    // islands with unnumbered derived copper. Reserve every existing index.
    for (const r of saved) if (r.polygon != null && Number.isSafeInteger(r.subPolygonIndex) && r.subPolygonIndex >= 0)
      nextIsland.set(r.polygon, Math.max(nextIsland.get(r.polygon) || 0, r.subPolygonIndex+1));
    for (const r of observer ? observer.items(doc,saved,() => counts.regions,"Filled copper region",doc.id + "/pours") : saved) {
      const parent = zoneRecords.get(r.polygon), zone = parent == null ? null : zones[parent];
      if (r.polygon != null && (!zone || zone.shelved || zone.powerPlane)) continue;
      if (zone?.fillMode === "hatched" || zone?.fillMode === "outline") {
        report("Repour edited hatch and outline polygons in Altium to regenerate their native track primitives.");
        continue;
      }
      const layer = layerOf(r.layer);
      if (!layer || !archive) throw Error("A stored copper region could not be written.");
      let sub = -1;
      if (zone) {
        sub = r.subPolygonIndex;
        if (!Number.isSafeInteger(sub) || sub < 0) {
          sub = nextIsland.get(zone.id) || 0;
          nextIsland.set(zone.id, sub+1);
        }
      }
      regionRecord([], null, layer, zone ? "" : r.net, null, "region", zone ? [["POLYGON",parent]] : [], archive.nativeContours(r), sub);
    }
    // Design rules: Waffle's rules as Altium rule records, scoped with Altium query expressions.
    const R = globalThis.AtriumRules;
    const writeRule = (fields, legacy) => push([["RECORD", legacy ? "Rule" : "DXPRule"], ["INDEXFORSAVE", counts.rules++], ...fields]);
    if (R?.effective) {
      let set = null; try { set = R.effective(doc, project); } catch (e) { report("Design rules could not be read: " + e.message); }
      const FIELDS = {componentClearance:{GAP:"gap", VERTICALGAP:"vertical"}, supplyNets: {}, modifiedPolygon: {}, layerPairs: {}, componentHeight: {MINHEIGHT:"min", PREFHEIGHT:"preferred", MAXHEIGHT:"max"},
        fabricationTestpoint:{MINSIZE:"minSize", PREFEREDSIZE:"preferredSize", MAXSIZE:"maxSize", MINHOLESIZE:"minHole", PREFEREDHOLESIZE:"preferredHole", MAXHOLESIZE:"maxHole"},
        clearance: {GAP: "gap"}, width: {MINLIMIT: "min", PREFEREDWIDTH: "preferred", MAXLIMIT: "max"},
        viaStyle: {MINWIDTH: "diameterMin", WIDTH: "diameterPreferred", MAXWIDTH: "diameterMax", MINHOLEWIDTH: "holeMin", HOLEWIDTH: "holePreferred", MAXHOLEWIDTH: "holeMax"},
        diffPairsRouting: {MINWIDTH: "widthMin", PREFEREDWIDTH: "widthPreferred", MAXWIDTH: "widthMax", MINGAP: "gapMin", PREFEREDGAP: "gapPreferred", MAXGAP: "gapMax", MAXUNCOUPLEDLENGTH: "maxUncoupled"},
        routingCorners: {MINSETBACK: "setbackMin", MAXSETBACK: "setbackMax"}, solderMask: {EXPANSION: "expansion"}, pasteMask: {EXPANSION: "expansion"}, annularRing: {MINIMUMRING: "min"},
        holeSize: {MINLIMIT: "min", MAXLIMIT: "max"}, polygonConnect: {RELIEFCONDUCTORWIDTH: "conductorWidth", AIRGAPWIDTH: "airGap"}, holeToHole: {GAP: "gap"}, silkToMask: {MINSILKSCREENTOMASKGAP: "gap"},
        silkToSilk: {SILKTOSILKCLEARANCE: "gap"}, length: {MINLIMIT: "min", MAXLIMIT: "max"}, matchedLengths: {TOLERANCE: "tolerance"}, boardOutlineClearance: {GAP: "gap"}};
      const skipped = new Map(),scopeProblems=new Map();
      function ruleFields(r, headerOnly=false) {
        const t = R.types[r.type];
        if (!t?.altium || !headerOnly && ((r.type === "componentClearance" && r.mode !== "authored") ||
            !(FIELDS[r.type] || ["short", "unrouted", "routingTopology", "routingPriority", "routingLayers", "fanoutControl"].includes(r.type)))) return null;
        const first=altiumScope(r.scope,project,doc),second=r.scope2 ? altiumScope(r.scope2,project,doc) : {ok:true,source:"All"};
        if(!first.ok || !second.ok){
          const error=!first.ok ? first : second, side=!first.ok ? 1 : 2;
          const d=error.diagnostics[0],reason="Scope "+side+(d?.span ? " ["+d.span.join(",")+"]" : "")+". "+(d?.message || "No Altium expression.");
          scopeProblems.set(r.id,reason);report("“"+r.name+"”. "+reason);
          return null;
        }
        /** @type {Array<[string, string | number]>} */
        const fields = [["RULEKIND", t.altium], ["NAME", text(r.name || t.altium)], ["ENABLED", TRUE(r.enabled !== false)], ["PRIORITY", r.priority], ["COMMENT", text(r.comment || "")],
          ["UNIQUEID", uniqueId(doc.id + "/rule/" + r.id)], ["SCOPE1EXPRESSION", text(first.source)], ["SCOPE2EXPRESSION", text(second.source)],
          ["LAYERKIND", "SameLayer"], ["NETSCOPE", r.type === "clearance" || r.type === "short" ? "DifferentNets" : "AnyNet"], ["DEFINEDBYLOGICALDOCUMENT", "FALSE"]];
        if (headerOnly) return new Map(fields);
        for (const [key, field] of Object.entries(FIELDS[r.type] || {})) if (Number.isFinite(r[field])) fields.push([key, mil(r[field])]);
        if (r.type === "componentClearance") fields.push(["COLLISIONCHECKMODE", "3"], ["DONOTCHECKWITHOUT3DBODY", TRUE(!!r.skipMissingBody)]);
        if (r.type === "silkToMask") fields.push(["CLEARANCETOEXPOSEDCOPPER", TRUE(!!r.exposedCopper)]);
        if (r.type === "supplyNets") fields.push(["VOLTAGE", r.voltage]);
        if (r.type === "modifiedPolygon") fields.push(["ALLOWMODIFIED", TRUE(r.allowModified)], ["ALLOWSHELVED", TRUE(r.allowShelved)]);
        if (r.type === "fabricationTestpoint") fields.push(["ALLOWSIDETOP", TRUE(r.allowTop)], ["ALLOWSIDEBOTTOM", TRUE(r.allowBottom)]);
        if (r.type === "layerPairs") fields.push(["ENFORCE", TRUE(r.enforce)]);
        if (r.type === "solderMask") for (const [key, source] of [["tentTop","ISTENTINGTOP"], ["tentBottom","ISTENTINGBOTTOM"]]) if (r[key] != null) fields.push([source, TRUE(r[key])]);
        if (r.type === "clearance" && r.ignoreFootprintPadPairs) fields.push(["IGNOREPADTOPADCLEARANCEINFOOTPRINT", "TRUE"]);
        if (r.type === "clearance" && r.objects) {
          const map = {track: "Track", arc: "Arc", smd: "SMDPad", th: "THPad", via: "Via", fill: "Fill", poly: "Poly", region: "Region", text: "Text", hole: "Hole"};
          fields.push(["OBJECTCLEARANCES", Object.entries(r.objects).map(([k, v]) => { const [a, b] = k.split("-"); return "ClearanceObj_" + map[a] + "-ClearanceObj_" + map[b] + ":" + Math.round(v / MIL * 10000); }).join(";")]);
        }
        if (r.type === "polygonConnect") fields.push(["CONNECTSTYLE", r.style === "direct" ? "Direct" : r.style === "none" ? "NoConnect" : "Relief"], ["RELIEFENTRIES", r.entries || 4], ["POLYGONRELIEFANGLE", (r.angle || 90) + " Angle"]);
        if (r.type === "polygonConnect" && Object.keys(r.kinds || {}).length) {
          for (const [kind,prefix] of [["th","THPAD."],["smd","SMDPAD."],["via","VIA."]]) {
            const row = {...r,...r.kinds[kind]};
            fields.push([prefix+"CONNECTSTYLE", row.style === "none" ? "NoConnect" : row.style === "direct" ? "Direct" : "Relief"],
              [prefix+"AIRGAPWIDTH",mil(row.airGap)], [prefix+"RELIEFCONDUCTORWIDTH",mil(row.conductorWidth)],
              [prefix+"RELIEFENTRIES",row.entries], [prefix+"POLYGONRELIEFANGLE",row.angle+" Angle"]);
          }
        }
        if (r.type === "width" || r.type === "diffPairsRouting") {
          const names={widthMin:"MINWIDTH",widthPreferred:"PREFWIDTH",widthMax:"MAXWIDTH",gapMin:"MINGAP",gapPreferred:"PREFGAP",gapMax:"MAXGAP"};
          for(const [layer,row] of Object.entries(r.layers||{})){
            const prefix=layer==="Top"?"TOPLAYER":layer==="Bottom"?"BOTTOMLAYER":layer.replace(/^Inner /,"MIDLAYER");
            for(const [key,value] of Object.entries(row))if(names[key]&&value!=null)fields.push([prefix+"_"+names[key],mil(value)]);
          }
        }
        if (r.type === "short") fields.push(["ALLOWED", TRUE(!!r.allowed)]);
        if (r.type === "routingPriority") fields.push(["ROUTINGPRIORITY", r.value || 0]);
        if (r.type === "routingTopology") fields.push(["TOPOLOGY", ({flyBy: "daisyChainSimple", tBranch: "starburst"})[r.topology] /* hs-topology */ || r.topology || "shortest"]);
        if (r.type === "routingCorners") fields.push(["CORNERSTYLE", r.style === "90" ? "90 Degrees" : r.style === "rounded" ? "Rounded" : "45 Degrees"]);
        if (r.type === "matchedLengths") fields.push(["CHECKNETSINDIFFPAIR", TRUE(!!r.withinPair)]);
        if (r.type === "holeToHole" && r.allowStackedMicrovias != null) fields.push(["ALLOWSTACKEDMICROVIAS", TRUE(r.allowStackedMicrovias)]);
        if (r.type === "holeSize") fields.push(["ABSOLUTEVALUES", "TRUE"]);
        if (r.type === "routingLayers") {
          const keys = ["Top", ...Array.from({length:30}, (_,i) => "Inner "+(i+1)), "Bottom"];
          for(const key of keys){
            const name=key==="Top"?"TOP LAYER":key==="Bottom"?"BOTTOM LAYER":key.replace(/^Inner /,"MID LAYER ");
            fields.push([name+"_V5", TRUE(!(r.excluded||[]).includes(key))]);
          }
        }
        return new Map(fields);
      }
      const noteSkipped = r => {const name = R.types[r.type]?.title || r.type; skipped.set(name, (skipped.get(name) || 0) + 1);};
      writeBoardRules(doc, project, set, ruleFields, writeRule, noteSkipped, report, observer, scopeProblems);
      if (skipped.size) report("Design rules with no Altium rule kind written here were left out: " + [...skipped.keys()].join(", ") + ".");
      // Classes and pairs (signals.js views: tags are net / pair classes, a diff signal is one pair per stage),
      // as Class (KIND 0 nets, 6 pairs, 10 xSignals) and DifferentialPair records; UNIQUEIDs from the import.
      // docs/design/altium-pairs-xsignals-format.md (Designer 26.12); xSignals go in the Board record (pinPairFields).
      if (set) {
        const src = globalThis.AtriumAltiumRules?.classes?.(doc.sourceClasses || [])?.ids || {};
        const cls = (kind, name, members) => { push([["RECORD", "Class"], ["NAME", text(name)], ["KIND", kind], ["SUPERCLASS", "FALSE"], ...members.map((m, k) => ["M" + k, text(m)]),
          ["UNIQUEID", src[kind + ":" + name] || uniqueId(doc.id + "/class/" + kind + "/" + name)]]); counts.classes = (counts.classes || 0) + 1; };
        const pairs = R.diffPairs(doc, {project}), pairClasses = {};
        for (const p of pairs) for (const c of p.classes || []) (pairClasses[c] ||= []).push(p.name);
        for (const [name, nets] of Object.entries(R.netClasses(doc, {project}))) if (!/^all nets$/i.test(name)) cls(0, name, nets);
        for (const p of pairs) { push([["RECORD", "DifferentialPair"], ["NAME", text(p.name)], ["POSITIVENETNAME", text(p.positive)], ["NEGATIVENETNAME", text(p.negative)],
          ["UNIQUEID", src["pair:" + p.name] || uniqueId(doc.id + "/pair/" + p.name)]]); counts.pairs = (counts.pairs || 0) + 1; }
        for (const [name, list] of Object.entries(pairClasses)) cls(6, name, list);
        const S = globalThis.AtriumSignals, M = S ? S.model(project, doc) : null;
        for (const [name, list] of Object.entries(M ? M.xSignalClasses() : {})) cls(10, name, list);
        if (pairs.length) report("Differential pairs are written as DifferentialPair records; check them in Altium's PCB panel (Differential Pairs Editor).");
      }
    } else {
      writeBoardRules(doc, project, null, null, writeRule, undefined, undefined, observer);
      report("Only retained Altium source rules could be exported because the editable rule book was unavailable.");
    }
    if (stepBodies) {
      report(stepNotice);
      if (doc.sourceEncoding !== "ascii" && /\.pcbdoc$/i.test(doc.sourceName || "")) report(nativeBodyRoute);
      if (missingBodyFiles) report(missingBodyFiles + " STEP body reference(s) have no STEP companion in this export.");
    }
    const content = lines.join("\r\n") + "\r\n";
    return {name: fileName(doc.name, ".PcbDoc"), content, bytes: encode(content), diagnostics: notes.list(), counts, offset: [sx, -sy]};
  }

  // ---------------------------------------------------------------- project (.PrjPcb)
  function exportProject(project, observer) {
    const docs = project.documents.filter(d => (d.kind === "schematic" || d.kind === "pcb") && (d.items.length || d.outline?.length || d.sheet?.infinite === true));
    if (!docs.length) throw Error("This project has no schematic or board to export.");
    const files = [], diagnostics = [], counts = {sheets: 0, boards: 0}, taken = new Set();
    const evaluated = globalThis.AtriumCalculationRecords?.frozenProject(project), fidelity = [];
    const sidecars = [], modelNames = new Map(), usedModelNames = new Set(), defs = new Map(project.library.map(d => [d.id,d]));
    let modelBytes = 0;
    for (const d of docs) {
      const modelFiles = new Map();
      const sources = new Set([d]);
      for (const item of d.items) {
        const fp = item.kind === "part" && !item.bodies3d && defs.get(item.def)?.footprint;
        if (fp?.bodies3d?.length) sources.add(fp);
      }
      for (const source of sources) {
        const byId = new Map((source.bodyModels || []).map(a => [a.id, a]));
        for (const a of byId.values()) {
          const actual = a.assetId ? byId.get(a.assetId) : a;
          const key = actual?.zlib || actual?.stepText;
          if (!key) continue;
          if (!modelNames.has(key)) {
            try {
              const bytes = globalThis.AtriumImportFormats?.stepBytes(actual);
              if (!bytes) throw Error("The STEP decoder is unavailable.");
              const content = actual.stepText || new TextDecoder().decode(bytes);
              if (modelBytes + bytes.length > 128 * 1048576) throw Error("The project exceeds the 128 MB STEP output limit.");
              const original = (a.file || "body.step").split(/[\\/]/).pop();
              const ext = /\.(?:stp|step)$/i.exec(original)?.[0] || ".step";
              let stem = fileName(original.replace(/\.(?:stp|step)$/i, "").slice(0, 100), "").replace(/[. ]+$/, "") || "body";
              if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = "_" + stem;
              let name = stem + ext, n = 1;
              while (usedModelNames.has(name.toLowerCase())) name = stem + "-" + (++n) + ext;
              usedModelNames.add(name.toLowerCase());
              modelBytes += bytes.length; modelNames.set(key, name); sidecars.push({name, content, bytes, document: name});
            } catch (e) { modelNames.set(key, null); diagnostics.push("STEP model omitted. " + e.message); }
          }
          modelFiles.set(a, modelNames.get(key));
        }
      }
      const r = d.kind === "pcb" ? exportBoard(project, d, modelFiles, observer) : exportSchematic(project, d, observer, evaluated);
      if ("fidelity" in r && r.fidelity) fidelity.push(...r.fidelity.map(f => ({documentId:d.id,...f})));
      let name = r.name, k = 1;
      while (taken.has(name.toLowerCase())) name = r.name.replace(/(\.[^.]+)$/, "-" + (++k) + "$1");
      taken.add(name.toLowerCase());
      observer?.written(d,name,r);
      if ("imageCompanions" in r) {
        for (const f of r.imageCompanions) if (!sidecars.some(v=>v.name===f.name)) sidecars.push(f);
      }
      files.push({name, content: r.content, bytes: r.bytes, counts: r.counts, document: d.id});
      for (const m of r.diagnostics) diagnostics.push(d.name + ": " + m);
      if (d.kind === "pcb") counts.boards++; else counts.sheets++;
    }
    files.push(...sidecars);
    const base = fileName(project.name || "Project", "");
    // Altium resolves board and sheet special strings from these literal INI values.
    // Pipes, equals signs, quotes and Unicode are data here, unlike primitive records.
    const parameters=Array.isArray(project.parameters)?project.parameters.filter(p=>p && typeof p.name==="string").map(p=>[p.name,p.value??""]):Object.entries(project.parameters||{});
    const parameterLines=[], named=new Map();
    for(const [name,value] of parameters){
      if(!name.trim() || /^(?:__proto__|prototype|constructor)$/.test(name) || !["string","number","boolean"].includes(typeof value))continue;
      if(/[\r\n\0]/.test(name+String(value)) || name!==name.trim()){
        diagnostics.push("A project parameter was omitted because its name or value cannot be represented on a single Altium INI line.");
        continue;
      }
      named.set(name.toLowerCase(),[name,String(value)]);
    }
    let parameterIndex=0;
    for(const [name,value] of named.values())parameterLines.push("[Parameter"+(++parameterIndex)+"]","Name="+name,"Value="+value,"");
    const H = globalThis.AtriumHierarchy, scope = H?.scopeSetting(project) || "global";
    const sourceAutomatic = H?.sourceAutomatic(project);
    const retainAutomatic = sourceAutomatic && H.effectiveScope(project, "automatic") === scope;
    const mode = retainAutomatic ? 0 : {automatic:0, flat:1, hierarchical:2, global:3}[scope];
    if (sourceAutomatic && !retainAutomatic) diagnostics.push("Net identifier scope exported as " + scope + " to preserve the imported connections after schematic edits.");
    const prj = ["[Design]", "Version=1.0", "HierarchyMode=" + mode, "ChannelRoomNamingStyle=0", "OutputPath=Project Outputs for " + clean(base), "LogFolderPath=",
      "ManagedProjectGUID=", "", ...files.flatMap((f, k) => ["[Document" + (k + 1) + "]", "DocumentPath=" + clean(f.name), "AnnotationEnabled=1", "AnnotateStartValue=1",
        "AnnotationIndexControlEnabled=0", "AnnotateSuffix=", "AnnotateScope=All", "AnnotateOrder=-1", "DoLibraryUpdate=1", "DoDatabaseUpdate=1", "ClassGenCCAutoEnabled=1",
        "ClassGenCCAutoRoomEnabled=1", "ClassGenNCAutoScope=None", "DItemRevisionGUID=", "GenerateClassCluster=0", "DocumentUniqueId=" + uniqueId(f.document), ""]),...parameterLines].join("\r\n") + "\r\n";
    // Native projects use a UTF-8 BOM to identify Unicode INI values.
    const prjBytes=/[^\x00-\x7f]/.test(prj)?new TextEncoder().encode("\ufeff"+prj):encode(prj);
    files.unshift({name:base+".PrjPcb",content:prj,bytes:prjBytes});
    diagnostics.unshift("Preview export. Extract the complete ZIP and open its .PrjPcb in Altium Designer. Review the exported sheets, board layers and output details.");
    const bytes = !observer?.looseFiles && globalThis.AtriumZip?.create(files.map(f => ({name: base + "/" + f.name, data: f.bytes})));
    return {name: base + "-altium-ascii.zip", files, diagnostics: [...new Set(diagnostics)], counts,
      ...(fidelity.length ? {fidelity} : {}), ...(bytes ? {bytes} : {})};
  }

  function open(ctx = globalThis.AtriumNavHost) {
    if (!globalThis.document?.createElement) return ctx?.project ? exportProject(ctx.project()) : null;
    return globalThis.AtriumLazy.need("AtriumAltiumProjectExport").then(ui => ui.open(ctx));
  }
  function attach(h) { h.registerAction("export-altium", () => open(h)); }
  return Object.freeze({exportProject, exportSchematic, exportBoard, open, attach, encode, uniqueId});
})();
