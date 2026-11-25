"use strict";
// Editor-owned insert and secondary actions for the shared palette and search index.
// Capture nearby geometry once per invocation. Every placement rechecks its original document.
globalThis.AtriumPaletteActions = (() => {
  const G = globalThis, model = () => G.Atrium, sch = () => G.AtriumSchObjects;
  const need = name => G[name] ? Promise.resolve(G[name]) : G.AtriumLazy.need(name);
  const named = (id, label, value) => ({id, label, type:"text", value});
  const choices = (id, label, value, choices) => ({id, label, type:"select", value, choices});
  const widths = (w, h) => [{id:"w", label:"Width (mm)", type:"number", value:w}, {id:"h", label:"Height (mm)", type:"number", value:h}];
  const realPoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  const documents = new WeakMap();
  let nextDocument = 0;
  function documentToken(doc) {
    if (!documents.has(doc)) documents.set(doc, ++nextDocument);
    return documents.get(doc);
  }
  function surface(target) { return target?.closest?.("dialog[open]")?.paletteSurface || null; }

  function danglingEnd(host, items, point, radius) {
    const A = model(), defs = host.defs(), distances = [];
    for (const wire of items) {
      if (wire.kind !== "wire" || !wire.points?.length) continue;
      for (const at of [wire.points[0], wire.points.at(-1)]) {
        const distance = Math.hypot(point[0] - at[0], point[1] - at[1]);
        if (distance <= radius) distances.push({wire, at, distance});
      }
    }
    for (const {wire, at} of distances.sort((a, b) => a.distance - b.distance || String(a.wire.id).localeCompare(String(b.wire.id)))) {
      const attached = items.some(i => {
        if (i === wire) return false;
        if (i.kind === "wire") return i.points.some((p, k) => k && A.nearSegment(at, i.points[k - 1], p) < .00011);
        if (i.kind === "part") return A.pins(i, defs.get(i.def), "schematic").some(pin => !pin.hidden && A.same(pin.at, at));
        if (i.kind === "netlabel" || i.kind === "junction") return A.same([i.x, i.y], at);
        return sch()?.hotspots(i)?.some(p => A.same(p, at));
      });
      if (!attached) return at.slice();
    }
    return null;
  }
  function context(host, ctx) {
    const doc = host?.doc?.(), point = ctx.point;
    if (!doc || ctx.surface || !realPoint(point) || ctx.kind !== doc.kind) return {};
    if (!["schematic", "pcb"].includes(doc.kind)) return {documentToken:documentToken(doc)};
    const view = host.view(), radius = 6 / (view.scale() || 1);
    const around = view.query(doc, host.defs(), [point[0] - radius, point[1] - radius, point[0] + radius, point[1] + radius]);
    if (doc.kind === "pcb") {
      const hit = host.hitAt(point), at = host.snapAt(point);
      const target = hit && G.AtriumCrossProbe?.targetAt(doc, host.defs(), hit, point);
      const primary = ctx.selection?.[0], selected = primary && doc.items.find(i => i.id === primary);
      return {documentToken:documentToken(doc), net:target?.net || host.netAt?.(at)?.net || hit?.net || selected?.net || host.highlight() || "",
        track:around.some(i => i.kind === "track" && i.points.some((p, k) => k && model().nearSegment(point, i.points[k - 1], p) <= radius))};
    }
    const inside = around.filter(i => {
      if (i.kind !== "textframe" && !G.AtriumNotebook?.isNote?.(i)) return false;
      return point[0] >= i.x && point[0] <= i.x + i.w && point[1] >= i.y && point[1] <= i.y + i.h;
    }).sort((a, b) => a.w * a.h - b.w * b.h || String(a.id).localeCompare(String(b.id)));
    const end = danglingEnd(host, around, point, radius);
    return {documentToken:documentToken(doc), dangling:!!end, endpoint:end, notebook:!!inside.length, frameId:inside.find(i => sch()?.isFrame?.(i))?.id};
  }
  function owner(ctx) {
    if (ctx.labsSignal?.aborted) throw Object.assign(Error("Notebook action cancelled."),{name:"AbortError"});
    const doc = ctx.host.doc();
    if (ctx.surface || ctx.host.currentId() !== ctx.docId || doc.id !== ctx.docId || doc.kind !== ctx.kind || ctx.documentToken && documentToken(doc) !== ctx.documentToken)
      throw Error("The palette’s document changed. Open it again on the active canvas.");
    return doc;
  }
  function anchor(ctx, endpoint = false) {
    owner(ctx);
    return endpoint && ctx.endpoint ? ctx.endpoint.slice() : ctx.host.snapAt(ctx.point);
  }
  // A single guarded editor operation owns the new item, its library definition (if needed) and Undo.
  function add(ctx, label, create, library = false) {
    const {host} = ctx, doc = owner(ctx);
    let item;
    host.edit(() => {item = create(doc, host.project()); doc.items.push(item);}, label,
      () => library ? [{doc, items:[item]}, {library:true}] : [item]);
    if (!item) return;
    host.setTool("select"); host.select([item.id]); host.canvas().focus(); return item;
  }
  async function placeLibrary(def, request, value) {
    const ctx = request.context, {host} = ctx, source = request.library;
    const [library, placement] = await Promise.all([source ? need("AtriumLibrary") : null,
      ctx.kind === "schematic" ? need("AtriumSchPlace") : null]);
    // The library panel's source-aware copy operation preserves attribution and family membership.
    const doc = owner(ctx), project = host.project();
    if (!["schematic", "pcb"].includes(doc.kind) || !model().geometries(def, doc.kind)) throw Error("This part has no geometry for the active editor.");
    const saved = source ? project.library.find(d => library.sameLibrary(source, d.libraryRef) && d.libraryRef.id === def.id) : host.defs().get(def.id);
    const at = anchor(ctx);
    return add(ctx, "Place " + (def.name || "component"), () => {
      if (saved) def = saved;
      else if (source) def = library.addFromLibrary(source, def, project);
      else {def = model().clone(def); project.library.push(def);}
      const part = model().instantiate(project, def, at);
      if (placement) {
        placement.beginPart(def); placement.decorate(part, def, project);
      }
      if (value != null) part.value = value;
      if (request.part?.parameters) part.parameters = model().clone(request.part.parameters);
      return part;
    }, !saved);
  }
  const icons = {
    "sch-port":"junction", "sch-netlabel":"label", "sch-power":"junction", "sch-offsheet":"schematic", "sch-sheetsymbol":"schematic",
    "sch-text":"dtext", "sch-note":"comment", "sch-frame":"project", "sch-wire":"route", resistor:"chip",
    "pcb-track":"route", "pcb-via":"via", "pcb-text":"dtext", "pcb-polygon":"layers", "pcb-keepout-region":"layers",
    "pcb-dim-linear":"ddim", "pcb-tune":"measure", "pcb-class":"layers",
    "drawing-sheet":"drawing", "drawing-board":"dview", "drawing-assembly":"board",
    "drawing-bom":"dtable", "drawing-text":"dtext", "drawing-line":"dline", "panel-rows":"grid", "panel-cols":"grid"
  };
  function row(id, label, detail, keywords, run, extras = {}) {
    return {key:"insert:" + id, kind:"insert", label, detail, keywords, icon:icons[id] || "plus",
      preview:() => ({kind:"text", title:label, text:detail}), run, ...extras};
  }
  const nonempty = (v, fallback) => String(v ?? "").trim() || fallback;
  const characteristic = (v, d) => Number.isFinite(+v) && +v > 0 && +v <= 100000 ? +v : d;
  async function arm(request, id, start = false) {
    const ctx = request.context, {host} = ctx, lazy = G.AtriumLazy;
    const names = lazy?.forAction(id, ctx.kind);
    if (names) await lazy.need(names);
    owner(ctx); host.act(id);
    if (start) host.executeKey("place-at-pointer", ctx.point);
  }
  const projected = (ctx, family) => ctx.kind === "pcb" ? family.footprint : family.symbol;
  function basicResistor(ctx) {
    const known = ctx.host.defs().get("std-r") || ctx.host.project().library.find(d => d.catalogueId === "std-r");
    const starter = G.AtriumParts?.catalogue?.find(d => d.id === "std-r");
    return [known, starter].find(def => def && projected(ctx, def));
  }
  function resistor(ctx) {
    const def = basicResistor(ctx);
    if (!def) return null;
    const raw = r => nonempty(r.values?.value, r.argument || def.value || "10k");
    const valueOf = r => G.AtriumGenericParts?.parseValue(raw(r), "resistor")?.text;
    return row("resistor", "Resistor", def.footprint?.name || "Library component", "res resistance ohm component part footprint passive", r => {
      const value = valueOf(r);
      if (!value) throw Error("Enter a resistance such as 10k, 4k7 or 220 Ω.");
      return placeLibrary(def, r, value);
    }, {inline:["res", "resistor"], group:"Library", options:[named("value", "Resistance", def.value || "10 kΩ")],
      describe:r => {const v = valueOf(r); return {options:[named("value", "Resistance", v || raw(r))], ...(v ? {label:"Resistor · " + v} : {detail:"Enter a resistance such as 10k or 4k7."})};},
      preview:r => ({kind:ctx.kind === "pcb" ? "footprint" : "symbol", def:{...def, value:valueOf(r) || raw(r)}})});
  }
  // File, clipboard and camera pickers can return after a tab or folder is replaced.
  async function insertMedia(request, session, source) {
    const {context:ctx, signal} = request, host = ctx.host;
    const operation = new AbortController(), cancel = () => operation.abort();
    const stop = host.on("document", cancel);
    signal?.addEventListener("abort", cancel, {once:true});
    function valid() {
      if (signal?.aborted || operation.signal.aborted) return false;
      owner(ctx);
      if (host.folderProject?.() !== session || session.readOnly || !session.canEdit(ctx.docId))
        throw Error("Choose an editable schematic in a folder project.");
      return true;
    }
    try {
      if (!valid()) return;
      const media = await need("AtriumNotebookImageUI");
      if (!valid() || source === "camera" && !media.canCamera()) return;
      return await media.insert({host, point:ctx.point, source, signal:operation.signal});
    } finally {
      stop(); signal?.removeEventListener("abort", cancel);
    }
  }
  function mediaEntries(ctx, modules) {
    const backend = G.AtriumNotebookImageUI, host = G.AtriumHost, session = ctx.host.folderProject?.();
    if (!(backend?.insert || modules.includes("AtriumNotebookImageUI")) || !session || session.readOnly || !session.canEdit?.(ctx.docId)) return [];
    const pick = !!(host?.folderPickAsset && host.folderStageAsset), camera = !!host?.notebookTransfer &&
      (backend?.canCamera?.() ?? ((G.navigator?.maxTouchPoints || 0) > 0 && !!G.HTMLInputElement && "capture" in G.HTMLInputElement.prototype));
    return [
      ["image", "Image from File", "Choose an image to place on this sheet", "image picture photo svg png webp heic jpeg", pick],
      ["pdf", "PDF Datasheet Clip", "Choose a PDF page and region", "pdf document data sheet clip crop region", pick && !!host.notebookClip],
      ["clipboard", "Image from Clipboard", "Paste the system clipboard image at this point", "paste clipboard picture screenshot", !!host?.notebookPaste],
      ["camera", "Take Photo", "Capture a photo for this sheet", "camera capture image photograph", camera]
    ].filter(([, , , , available]) => available).map(([source, label, detail, words]) =>
      row("media-" + source, label, detail, words, request => insertMedia(request, session, source),
        {group:"Notes", icon:source === "pdf" ? "book" : "dview", boost:ctx.notebook ? 150 : 0}));
  }
  function noteEntries(ctx) {
    const modules = G.AtriumLazy?.modules?.() || [], out = mediaEntries(ctx, modules);
    if (G.AtriumRichText?.insert || modules.includes("AtriumRichText")) {
      const levels = ["h1","h2","h3"].map((value,i) => ({value,label:"Heading " + (i+1)}));
      for (const [id, label, style, keywords] of [["rich-text","Rich Text","paragraph","formatted note annotation paragraph"],
        ["heading","Heading","h1","title heading notebook"], ["checklist","Checklist","check","todo task check list"]]) {
        out.push(row(id, label, "Schematic notes", keywords, async request => {
          const notes = await need("AtriumRichText"); owner(request.context);
          const heading = request.values?.level;
          return notes.insert(request, style === "h1" && levels.some(option => option.value === heading) ? heading : style);
        }, {boost:ctx.notebook ? 160 : 0, icon:style === "check" ? "dtable" : "dtext",
          ...(style === "h1" ? {options:[choices("level","Level","h1",levels)]} : {}),
          ...(style === "check" ? {inline:["todo","checklist"], describe:r => ({detail:r.argument || "Schematic notes"}),
            preview:r => ({kind:"text", title:label, text:r.argument || "Checklist"})} : {})}));
      }
    }
    if (G.AtriumCalculationSheet?.compose || modules.includes("AtriumCalculationSheet")) {
      out.push(row("calculation", "Calculation", "Schematic notes", "expression formula engineering units assertion block", async request => {
        const {context:c, argument, signal} = request;
        if (signal?.aborted) return;
        const sheet = await need("AtriumCalculationSheet"); owner(c);
        if (!signal?.aborted) return sheet.compose(c.host, null, {...c, source:argument || ""});
      }, {icon:"measure", inline:["calc"], boost:ctx.notebook ? 160 : 0}));
    }
    if (G.AtriumMathEditor?.open || modules.includes("AtriumMathEditor")) {
      out.push(row("math", "Equation", "Schematic notes", "math latex formula equation", async request => {
        const editor = await need("AtriumMathEditor"); owner(request.context); return editor.open(request);
      }, {icon:"measure", inline:["math"], boost:ctx.notebook ? 160 : 0,
        preview:async request => {
          await need("AtriumMathEditor");
          return {kind:"equation", tex:request.argument || ""};
        }}));
    }
    return out;
  }
  function schematic(ctx) {
    const S = sch(), endpoint = ctx.dangling ? 140 : 0, note = ctx.notebook ? 145 : 0;
    const out = noteEntries(ctx), io = S.IO.map(v => ({value:v, label:v[0].toUpperCase() + v.slice(1)}));
    for (const [kind, title, name, words] of [
      ["port", "Port", "PORT1", "sheet signal connection input output"],
      ["netlabel", "Net Label", "SIGNAL", "wire name electrical net"],
      ["power", "Power Port", "GND", "ground supply VCC power rail"],
      ["offsheet", "Off-Sheet Connector", "NET1", "offsheet connection connector schematic"]
    ]) {
      const opts = [named("name", kind === "power" ? "Power net" : "Name", name)];
      if (kind === "port" || kind === "offsheet" && S.offsheetIO) opts.push(choices("io", "Direction", "unspecified", io));
      out.push(row("sch-" + kind, title, "Schematic", words, ({context:c, values}) => {
        const at = anchor(c, true), text = nonempty(values?.name, name), direction = S.IO.includes(values?.io) ? values.io : "unspecified";
        return add(c, "Place " + title, () => kind === "netlabel"
          ? {id:model().id(), kind, x:at[0], y:at[1], text}
          : S.make(kind, at, {text, io:direction, ...(kind === "power" ? {style:G.AtriumSchPlace?.powerStyleFor(text) || (/^(?:GND|VSS)$/i.test(text) ? "gnd" : "bar")} : {})}));
      }, {boost:endpoint, options:opts}));
    }
    const sheets = ctx.host.project().documents.filter(d => d.kind === "schematic" && d.id !== ctx.docId);
    const initial = sheets[0]?.id || "*new";
    out.push(row("sch-sheetsymbol", "Sheet Symbol", "Schematic", "child sheet hierarchical block", ({context:c, values:v}) => {
      const at = anchor(c), childId = v?.sheet || initial;
      const existing = c.host.project().documents.find(d => d.id === childId && d.kind === "schematic" && d !== c.host.doc());
      if (!existing && childId !== "*new") throw Error("The selected child sheet is unavailable.");
      return add(c, "Place Sheet Symbol", (_, p) => {
        const child = existing || model().sheet("schematic", nonempty(v?.newName, "Sheet " + (sheets.length + 2)));
        if (!existing) p.documents.push(child);
        const item = S.make("sheetsymbol", at, {name:nonempty(v?.name, "U_" + child.name.replace(/\s+/g, "_")), sheet:child.id});
        item.entries = S.layoutEntries(S.portsOf(child)); S.fitSymbol(item, {snug:true}); return item;
      });
    }, {options:[choices("sheet", "Child sheet", initial, [...sheets.map(d => ({value:d.id, label:d.name})), {value:"*new", label:"New sheet"}]), named("name", "Designator", ""), named("newName", "New sheet name", "")]}));
    for (const [kind, title, text, w, h] of [["text", "Text", "Text", 0, 0], ["note", "Note", "Note", 30.48, 15.24], ...(S.isFrame ? [["frame", "Frame", "Frame", 60.96, 40.64]] : [])]) {
      out.push(row("sch-" + kind, title, kind === "frame" ? "Sheet organisation" : "Schematic notes", "annotation notebook " + kind, ({context:c, values:v}) => {
        const p = anchor(c), body = nonempty(v?.text, text);
        return add(c, "Place " + title, () => kind === "text" ? {kind:"label", id:model().id(), x:p[0], y:p[1], text:body} :
          S.make(kind === "frame" ? "frame" : "textframe", p, {w:characteristic(v?.w, w), h:characteristic(v?.h, h), text:kind === "frame" ? body.slice(0,300) : body, note:true}));
      }, {group:"Notes", boost:note, options:[named("text", kind === "frame" ? "Title" : "Text", text), ...(w ? widths(w,h) : [])]}));
    }
    for (const [kind,title,words] of [["sticky","Sticky note","annotation rich text"],["callout","Callout","anchor target pin leader annotation"],
      ["reviewChecklist","Review checklist","linked comments tasks"],["sketch","Sketch","draw pen ink highlighter eraser"]]) {
      out.push(row("notes-"+kind,title,"Schematic notes",words,async ({context:c,values,argument})=>{
        const ui=await need("AtriumReviewNotes"),at=anchor(c);
        return ui.place(kind,at,argument || values?.text);
      },{group:"Notes",boost:note,...(kind==="sketch"?{}:{options:[named("text","Text",kind==="reviewChecklist"?"Review item":title)]})}));
    }
    out.push(row("sch-wire", "Wire", "Start a wire at this point", "connect schematic routing", r => arm(r, "route", true)));
    return out;
  }
  function pcb(ctx) {
    const out = [];
    const boost = ctx.net ? 130 : 0;
    out.push(row("pcb-track", "Route Track", ctx.net || "Start routing at this point", "track wire route interactive routing", r => arm(r, "route", true), {boost}));
    out.push(row("pcb-via", "Via", "Board layout", "place via drill plated through hole", async ({context:c}) => {
      const V = await need("AtriumViaStack"), p = anchor(c);
      return add(c, "Place Via", (doc, project) => V.place(doc, {id:model().id(), x:p[0], y:p[1], net:c.net || ""}, {project}));
    }));
    out.push(row("pcb-text", "Board Text", "Top overlay", "silk legend label text", ({context:c, values:v}) => {
      const p = anchor(c);
      return add(c, "Place Board Text", () => ({kind:"label", id:model().id(), x:p[0], y:p[1], layer:"Silk", size:1, text:nonempty(v?.text, "Text")}));
    }, {options:[named("text", "Text", "Text")]}));
    for (const [id, title, detail] of [
      ["pcb-polygon", "Polygon Pour", "Start the copper boundary"], ["pcb-keepout-region", "Keepout Region", "Start the keepout boundary"],
      ["pcb-dim-linear", "Linear Dimension", "Place the first dimension point"]
    ]) out.push(row(id, title, detail, "board " + id.replace(/-/g, " "), async ({context:c}) => {const D = await need("AtriumPCBDraw"); owner(c); D.startAt(id, c.point, c.net);}));
    // These commands use the track or net captured when the palette opened.
    out.push(row("pcb-tune", "Tune Track Length", ctx.net || "Interactive length tuning", "track delay length tuning routing", r => arm(r, "length-tune", ctx.track), {kind:"command", boost}));
    out.push(row("pcb-class", "Edit Net Class", ctx.net || "Signals and tags", "net class tag membership rules", async ({context:c}) => {
      const S = await need("AtriumSignalsPanel"); owner(c); return S.show(c.host, c.net || "");
    }, {kind:"command", boost}));
    return out;
  }
  function library(ctx) {
    const s = ctx.surface, editor = ctx.kind === "symbol" ? "Symbol Editor" : "Footprint Editor";
    if (!s?.dialog?.open) return [];
    if (ctx.kind === "ipc") return s.families().map(f => row("ipc-" + f.id, f.title, "IPC Footprint Wizard", [f.id, f.group, f.keywords, ...f.presets].filter(Boolean).join(" "), ({values}) => s.chooseFamily(f.id, values?.preset), {
      icon:"chip", options:f.presets.length ? [choices("preset", "Package", f.presets[0], f.presets.map(v => ({label:v, value:v})))] : [],
      preview:({values}) => {
        try {return {kind:"footprint", def:G.AtriumFootprintWizard.generate(G.AtriumFootprintWizard.defaults(f.id, values?.preset || f.presets[0]))};}
        catch {return {kind:"text", title:f.title, text:[f.group, ...f.presets.slice(0,5)].join(" · ")};}
      }
    }));
    const tools = [[ctx.kind === "symbol" ? "pin" : "pad", ctx.kind === "symbol" ? "Pin" : "Pad"], ["rect","Rectangle"], ["line","Line"], ["circle","Circle"], ["text","Text"]];
    if (ctx.kind === "symbol") tools.push(["arc","Arc"]);
    return tools.map(([id, title]) => row(ctx.kind + "-" + id, title, editor, [ctx.kind, id, title, "shape"].join(" "), ({context:c}) => {
      if (s.dialog.open) s.insert(id, c.point);
    }, {icon:{pin:"junction", pad:"via", line:"dline", rect:"dview", circle:"measure", arc:"measure", text:"dtext"}[id]}));
  }
  function drawings(ctx) {
    const out = [row("drawing-sheet", "Drawing Sheet", "Add a page to this drawing", "page sheet fabrication", r => arm(r,"drawing-sheet"))];
    for (const [id, label, detail] of [["board","Board Fabrication View","Board outline and holes"], ["assembly","Assembly View","Board components"], ["bom","Bill of Materials Table","Live board parts table"], ["text","Drawing Text","Sheet annotation"], ["line","Drawing Line","Start the line at this point"]]) {
      out.push(row("drawing-" + id, label, detail, "draft manufacturing drawing " + id, async ({context:c, values}) => {
        const D = await need("AtriumDrawing"); owner(c);
        const op = id === "line" ? "drawing-line" : id === "text" ? {op:"add_text", text:nonempty(values?.text,"Text")} : {op:"add_view", type:id};
        return D.placeAt(id === "text" || id === "line" ? id : "view", op, c.point);
      }, id === "text" ? {options:[named("text","Text","Text")]} : {}));
    }
    return out;
  }
  function panels(ctx) {
    const out = [];
    for (const [key, label] of [["rows","Add Board Row"], ["cols","Add Board Column"]]) {
      if ((ctx.host.doc().panel?.[key] || 2) >= 30) continue;
      out.push(row("panel-" + key, label, "Panel board array", "repeat board instance " + key, async ({context:c}) => {
        const P = await need("AtriumPanel"), d = owner(c);
        const old = P.normalize(d.panel);
        if (old[key] >= 30) return;
        c.host.edit(() => {d.panel = P.normalize({...old, [key]:old[key] + 1});}, label);
        c.host.info("Board array " + d.panel.rows + " × " + d.panel.cols + ".");
      }));
    }
    return out;
  }
  function entries(ctx) {
    if (!ctx?.host) return [];
    if (ctx.surface) return library(ctx);
    const providers = {schematic, pcb, drawing:drawings, panel:panels};
    const out = providers[ctx.kind]?.(ctx) || [];
    if (ctx.kind === "schematic" || ctx.kind === "pcb") {const r = resistor(ctx); if (r) out.push(r);}
    if (ctx.selection?.length && G.AtriumMacros) for (const macro of G.AtriumMacros.selectionCommands()) {
      out.push(row("macro-" + macro.id, macro.name, "Run on selection", "macro " + macro.alias, ({context}) => {
        owner(context);
        const selected = context.host.selection();
        if (selected.length !== context.selection.length || selected.some((id, i) => id !== context.selection[i]))
          throw Error("The selection changed. Open the palette again.");
        return macro.run();
      }, {kind:"command", group:"Macros"}));
    }
    return out;
  }
  function datasheetOf(item, def, parameters) {
    const raw = item?.datasheet || def.datasheet || parameters.DATASHEET || parameters["DATA SHEET"] || parameters["DATASHEET URL"];
    if (typeof raw !== "string" || raw.length > 4096) return "";
    try {
      const url = new URL(raw);
      return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : "";
    } catch {return "";}
  }
  function actions(entry, request) {
    const ctx = request?.context, h = ctx?.host, t = entry?.target;
    if (!h || !t || ctx.surface || !["part", "library", "net"].includes(t.type)) return [];
    const project = h.project(), defs = h.defs(), index = G.AtriumPalette.index?.(), out = [];
    const include = (id, label, fn) => out.push({id, label, run:() => {
      if (h.project() !== project) throw Error("The project changed. Search again.");
      return fn();
    }});
    if (t.type === "net") {
      const docs = index?.state.netDocs.get(t.net), documentId = t.docId || (docs?.has(ctx.docId) || !docs?.size ? ctx.docId : docs.values().next().value);
      const d = h.docById(documentId);
      if (!d) return [];
      function activate() {if (h.currentId() !== d.id) h.selectDocument(d.id);}
      include("highlight", "Highlight Net", () => {activate(); h.setHighlight(t.net);});
      include("select", "Select All on Net", async () => {
        const tools = await need("AtriumAltiumKeys"); if (ctx.labsSignal?.aborted || h.project() !== project) return;
        activate(); tools.selectNet(t.net);
      });
      const board = d.kind === "pcb" ? d : project.documents.find(x => x.kind === "pcb" && docs?.has(x.id));
      if (board) {
        include("class", "Edit Net Class", async () => {const S = await need("AtriumSignalsPanel"); if (ctx.labsSignal?.aborted || h.project() !== project) return; h.selectDocument(board.id); S.show(h, t.net);});
        include("length", "Show Routed Length", async () => {
          const L = await need("AtriumLength");
          if (ctx.labsSignal?.aborted || h.project() !== project) return;
          const m = L.netLength(board, h.defs(), t.net, {project, revision:h.revision()});
          h.info(t.net + " · " + model().units.format(m.length, h.units()) + " routed" + (m.unrouted ? " · incomplete" : ""));
        });
      }
      return out;
    }
    const doc = t.docId && h.docById(t.docId), item = doc?.items.find(i => i.id === t.id && i.kind === "part");
    const rec = t.type === "library" ? index?.get(entry.key) : null;
    const def = item ? defs.get(item.def) : rec?.def || defs.get(t.id) || G.AtriumCatalogue?.get?.(t.id, {project});
    if (!def) return [];
    if ((ctx.kind === "pcb" || ctx.kind === "schematic") && (projected(ctx, def) || projected(ctx, def.stub || {})))
      include("place", ctx.kind === "pcb" ? "Place Footprint" : "Place Component", async () => {
        const loaded = def.stub && rec?.library ? await (await need("AtriumLibrarySources")).load(rec.library, def.id) : def;
        return placeLibrary(loaded, {...request, library:rec?.library, part:item}, item?.value);
      });
    const P = model().partParameters, parameters = P.parameters(item, def);
    const url = datasheetOf(item, def, parameters);
    if (url && (G.AtriumHost?.openURL || !G.AtriumHost && G.open)) include("datasheet", "Open Datasheet", () => {
      if (G.AtriumHost?.openURL) return G.AtriumHost.openURL(url);
      G.open(url, "_blank", "noopener,noreferrer");
    });
    if (rec?.library || defs.has(def.id)) include("library", "Show in Library", async () => {
      await G.AtriumLazy.need(["AtriumLibrary", "AtriumEditorWorkflows"]); if (ctx.labsSignal?.aborted || h.project() !== project) return;
      h.act("library"); G.AtriumLibrary.reveal(def, rec?.library);
    });
    const X = G.AtriumCrossProbe, target = item && X?.targetAt(doc, defs, item);
    if (target && X.resolve(project, defs, doc.id, target)) include("crossprobe", doc.kind === "pcb" ? "Show in Schematic" : "Show on Board", () => X.probe(target));
    const mpn = P.fieldOf(parameters).mpn || item?.mpn || def.mpn;
    if (mpn && G.navigator?.clipboard?.writeText) include("mpn", "Copy MPN", async () => {await G.navigator.clipboard.writeText(mpn); h.info("Copied " + mpn);});
    return out;
  }
  return {context, entries, placeLibrary, surface, actions};
})();
globalThis.AtriumPalette?.registerProvider?.("builtin", AtriumPaletteActions.entries);
