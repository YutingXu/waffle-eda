"use strict";

// These bindings run inside the translator worker. The geometry, output options and file names
// come from the same engines used by manufacturing jobs and MCAD exchange.
globalThis.AtriumTranslatorManufacturing = (() => {
  const G = globalThis;
  const pathOf = f => f.path || f.name;
  const ref = (file, object) => object == null ? {file} : {file, object:String(object)};
  const textOf = file => new TextDecoder().decode(file.bytes);
  const notes = (sink, values) => { for (const text of values || []) sink.note(text); };
  function reference(files, mechanical) {
    const model = G.Atrium.project(files[0].name);
    model.documents = [];
    return {model, provenance: {version: 1, files: files.map(f => ({
      name: f.name, ...(f.path ? {path: f.path} : {}), bytes: f.bytes,
      sha256: G.AtriumSourceFile.sha256(f.bytes), documents: [], library: []
    })), mechanical}};
  }
  function one(files, limit) {
    if (files.length !== 1) throw Error("Choose one mechanical file for this operation.");
    if (files[0].bytes.byteLength > limit) throw Error("The mechanical file exceeds the reader's size limit.");
    return files[0];
  }
  function designFor(model, opt, kind = "pcb") {
    // Restore source artwork metadata while retaining the rule inputs that
    // verified the native copper fill.
    const project = G.AtriumTranslatorProvenance.toLegacy(model, opt.provenance, {keepSignals:true});
    return {project, doc:documentFor(project,opt,kind)};
  }
  function documentFor(project, opt, kind = "pcb") {
    const id = kind === "panel" ? opt.panelId : opt.documentId;
    const doc = project.documents.find(d => d.kind === kind && (id == null || d.id === id));
    if (!doc) throw Error(kind === "panel" ? "Choose a PCB panel to export." : "Choose a PCB layout to export.");
    return doc;
  }
  function dateOf(value) {
    const date = value == null ? new Date() : new Date(value);
    if (!Number.isFinite(date.getTime())) throw Error("Choose a valid output date.");
    return date;
  }
  const variantName = p => p.variantApplied?.name ?? G.AtriumVariants?.find(p, p.activeVariant)?.name ?? null;

  // Resolve physical primitives to the native board object that the engine actually used.
  // A pooled footprint can appear many times. Each member address includes its placed owner.
  function fabSources(doc, library) {
    const defs = new Map(library.map(d => [d.id, d]));
    const sources = new WeakMap(), members = new WeakMap();
    const fallback = new Map();
    function featureSource(f, owner, member, layer) {
      let kind = owner?.kind || (owner?.rings || owner?.polygon != null ? "copper pour" : "layer feature");
      let id = owner?.id || owner?.polygon;
      if (id == null) {
        const n = (fallback.get(layer) || 0) + 1;
        fallback.set(layer, n);
        id = doc.id + "/" + layer + "/feature/" + n;
      }
      if (member) {
        let suffix = members.get(member);
        if (!suffix) {
          const footprint = defs.get(owner.def)?.footprint;
          for (const [name, list] of [["pad", footprint?.pads], ["graphic", footprint?.shapes]])
            (list || []).forEach((m, i) => members.set(m, name + "/" + (i + 1)));
          suffix = members.get(member);
        }
        id += "/" + suffix;
        kind = suffix?.startsWith("pad/") ? "footprint pad" : "footprint graphic";
      }
      sources.set(f, {kind, id});
    }
    return {sources, featureSource};
  }
  const filmKind = {stroke:"stroke", circle:"circle", flash:"land", region:"region", pour:"pour", clear:"clearance"};
  function recorder(doc, trace, sink) {
    const rows = new Map();
    return {
      plot(f, kept, layer) {
        const s = trace.sources.get(f);
        // Drill-drawing tool marks and synthetic layer geometry can have no editor item.
        if (!s) return;
        const key = s.id + "\n" + layer, prev = rows.get(key);
        if (!prev) rows.set(key, {source:s, layer, kept, omitted:!kept});
        else { prev.kept ||= kept; prev.omitted ||= !kept; }
      },
      flush() {
        for (const {source, layer, kept, omitted} of rows.values()) {
          const status = !kept ? "dropped" : omitted ? "approximated" : "kept";
          const reason = !kept ? "No feature remained after the selected layer and opening settings." :
            omitted ? "The layer contains only part of this object's physical geometry." : undefined;
          sink.add(source.kind, status, ref(doc.name, source.id + " on " + layer), reason);
        }
      }
    };
  }
  function exportScope(model, opt, prepared) {
    if (!prepared) return;
    let byProvenance = prepared.get(model);
    if (!byProvenance) prepared.set(model,byProvenance = new Map());
    const provenance = Array.isArray(opt.provenance) && !opt.provenance.length ? undefined : opt.provenance;
    let scope = byProvenance.get(provenance);
    if (!scope) {
      const project = G.AtriumTranslatorProvenance.toLegacy(model, provenance, {keepSignals:true});
      byProvenance.set(provenance,scope = {project,preparation:G.AtriumFabOutputs.createPreparation()});
    }
    return scope;
  }
  function boardModel(model, opt, prepared) {
    const scope = exportScope(model,opt,prepared);
    const {project,doc} = scope ? {project:scope.project,doc:documentFor(scope.project,opt)} : designFor(model,opt);
    const physical = scope?.preparation || G.AtriumFabOutputs.createPreparation();
    const {fm,trace} = physical.board(project,doc,{variant:opt.variant,provenance:opt.provenance,
      strictLayers:opt.strictLayers === true, omitUnconnectedMidLayerPads:opt.omitUnconnectedMidLayerPads === true},fabSources);
    return {project,doc,fm,trace,scope};
  }
  function panelScope(model, opt, prepared) {
    const source = opt.provenance;
    // The caller can edit retained drill and precision data independently of the project.
    if (source && !(Array.isArray(source) && !source.length)) return null;
    return exportScope(model,opt,prepared);
  }
  function panelPreparation(scope, opt, date) {
    return scope?.preparation.panelInputs(scope.project, opt.panelId, {...opt,date});
  }
  function panelSources(fm) {
    // Source references use the panel's feature order, including repeated artwork and rails.
    const sources = new WeakMap();
    for (const [layer, list] of fm.layers) list.forEach((f,i) => sources.set(f,
      {kind:"Panel " + (filmKind[f.t] || "feature"), id:fm.doc.id + "/" + layer + "/" + (i + 1)}));
    fm.drills.forEach((h,i) => sources.set(h, {kind:"Panel drill", id:fm.doc.id + "/drill/" + (i + 1)}));
    return {sources};
  }
  function panelModel(model, opt, prepared) {
    const scope = panelScope(model,opt,prepared);
    const {project} = scope || designFor(model,opt);
    if (scope) documentFor(project,opt);
    const physical = scope?.preparation || G.AtriumFabOutputs.createPreparation();
    const {fm,trace} = physical.panel(project,opt.panelId,{variant:opt.variant,provenance:opt.provenance,
      omitUnconnectedMidLayerPads:opt.omitUnconnectedMidLayerPads === true,date:opt.date},panelSources);
    return {fm,trace,scope};
  }
  function prepare(model, opt, sink, prepared) {
    const F = G.AtriumFabOutputs;
    const {fm,trace,scope} = opt.panelId ? panelModel(model,opt,prepared) : boardModel(model,opt,prepared);
    const out = recorder(fm.doc, trace, sink);
    notes(sink, F.warnings(fm));
    return {F, fm, doc:fm.doc, project:fm.project, out, scope};
  }
  function fabrication(id, model, options, sink, prepared) {
    const date = dateOf(options.date);
    const {F, fm, doc, project, out, scope} = prepare(model, {...options,date}, sink, prepared);
    const {provenance, documentId, panelId, fileName, include, profileOnly, variant, strictLayers, ...settings} = options;
    const fileStem = settings.fileStem || F.defaultStem(project, doc);
    const writers = scope?.preparation;
    const catalogue = writers?.catalogue(fm) ?? F.gerberLayers(fm), plan = F.plan(fm,{...settings,date,fileStem},catalogue,writers);
    const requested = include == null ? null : new Set(include);
    const selected = plan.files.filter(f => (!fileName || f.name === fileName) &&
      (id !== "gerber" || f.kind === "gerber" || f.kind === "drillmap") &&
      (id !== "excellon" || f.kind === "drill") && (!requested || requested.has(f.kind)) &&
      (!profileOnly || f.layer?.key === "outline"));
    if (fileName && !selected.length) throw Error("The requested output is absent from the current fabrication plan.");
    const files = [], descriptors = [];
    for (const f of selected) {
      const key = f.layer?.key || f.kind;
      plan.options.plottedFeature = (feature, kept) => out.plot(feature, kept, key);
      const r = F.generate(fm, plan, f, writers);
      files.push({name:f.name, text:r.content});
      descriptors.push({name:f.name, kind:f.kind, title:f.title, stats:r.stats, ...(r.tools ? {tools:r.tools} : {})});
      if (f.kind === "drill") for (const hit of f.group.hits) out.plot(hit, true, f.name);
      if (f.layer?.key === "outline" && fm.outline.length) sink.add("Board profile", "kept", ref(doc.name, doc.id + "/outline"));
      if (f.kind === "pnp" || f.kind === "assembly") for (const part of fm.parts) {
        if (f.side && part.side !== f.side) continue;
        const omitted = f.kind === "pnp" && fm.dnp.has(part.item);
        sink.add(f.kind === "pnp" ? "Placement" : "Assembly placement", omitted ? "dropped" : "kept",
          ref(doc.name, part.item.id + (part.instance == null ? "" : "/instance/" + part.instance)), omitted ? "This assembly variant marks the component as unfitted." : undefined);
      }
      if (f.kind === "drillmap" || f.kind === "drillreport") sink.add(f.kind === "drillmap" ? "Drill drawing" : "Drill report", "kept", ref(doc.name, doc.id + "/drill table"));
    }
    out.flush();
    const {plottedFeature, layers, fileStem:stem, ...settled} = plan.options;
    const layerInfo = catalogue.map(l => ({ext:l.ext, title:l.title, objects:l.count}));
    for (const i of doc.items) {
      if (i.kind === "part" && !fm.defs.get(i.def)?.footprint) sink.add("Footprint", "dropped", ref(doc.name, i.id), "The placed component has no footprint.");
      else if (i.kind === "track" && !(i.width > 0) && selected.some(f => f.layer?.key === i.layer))
        sink.add("Track", "dropped", ref(doc.name, i.id), "A zero-width copper track produces no Gerber draw.");
    }
    for (const issue of fm.layerIssues || []) if (issue.action === "omitted") {
      sink.add("Off-stack object", "dropped", ref(doc.name, doc.id + "/layers/" + issue.layer), "The board stack omits this copper layer.", issue.count);
    }
    sink.note("Film counts refer to native objects on each selected layer. Gerber and drill output carry manufacturing geometry and do not store editable design rules.");
    return {files, details:{document_id:doc.id, board:doc.name, variant:variantName(project), stem, packageName:F.baseName(stem) + "-Fabrication.zip",
      files:descriptors, warnings:F.warnings(fm), layers:layerInfo, options:{...settled, date:date.toISOString()}}};
  }
  function ipc(model, opt, sink, prepared) {
    const date = dateOf(opt.date);
    const {fm, doc, project, out} = prepare(model, {...opt,date}, sink, prepared);
    const o = {...opt, date, model:fm, plottedFeature:(f, kept, layer) => out.plot(f, kept, layer)};
    const result = G.AtriumIPC2581.build(project, doc, o), check = G.AtriumIPC2581.check(result.content);
    if (!check.ok) throw Error("The IPC-2581 structural check failed. " + check.errors.slice(0, 3).join(" "));
    out.flush();
    for (const p of fm.parts) sink.add("Component placement", "kept", ref(doc.name, p.item.id + (p.instance == null ? "" : "/instance/" + p.instance)));
    const assumed = !fm.outline.length;
    sink.add("Board profile", assumed ? "approximated" : "kept", ref(doc.name, doc.id + "/outline"),
      assumed ? "The writer used the design extents." : undefined);
    notes(sink, [...result.warnings, ...check.warnings, ...check.notes]);
    return {files:[{name:result.name, text:result.content}], details:{stats:result.stats, warnings:result.warnings, revision:result.revision, check}};
  }
  function odb(model, opt, sink, prepared) {
    const board = opt.panelId == null ? boardModel(model,opt,prepared) : null;
    const scope = board ? board.scope : panelScope(model,opt,prepared);
    const {project,doc} = board || (scope ? {project:scope.project,doc:documentFor(scope.project,opt,"panel")} : designFor(model,opt,"panel"));
    const out = recorder(doc,board?.trace || fabSources(doc,project.library),sink);
    const result=G.AtriumODB.build(project,doc.id,{...opt, model:board?.fm, plottedFeature:(f,kept,layer)=>out.plot(f,kept,layer)},
      {writers:scope?.preparation, panel:date=>panelPreparation(scope,opt,date)});
    out.flush();
    for (const [step,stats] of Object.entries(result.stats.steps)) {
      sink.add("Board profile","kept",ref(doc.name,step+"/profile"));
      if (stats.components) sink.add("Package body outlines","approximated",ref(doc.name,step+"/eda/data"),
        "Package envelope outlines use the extents of the native footprint.",stats.components);
      if (opt.panelId && stats.features) sink.add("Layer features","kept",ref(doc.name,step+"/layers"),undefined,stats.features);
      if (stats.netPoints) sink.add("CAD net points","kept",ref(doc.name,step+"/netlists/cadnet/netlist"),undefined,stats.netPoints);
    }
    notes(sink,result.warnings);
    return {files:[{name:result.name,bytes:result.bytes}],details:{document_id:doc.id,revision:"8.1",stats:result.stats,warnings:result.warnings}};
  }
  function stepImport(files, opt, sink) {
    const S = G.AtriumSTEPImport, f = one(files, S.LIMITS.bytes);
    const mesh = S.tessellate(textOf(f), {faceResult(id, surface) {
      const flat = surface === "faceted" || surface === "planar";
      const status = surface === "skipped" ? "dropped" : flat ? "kept" : "approximated";
      const reason = surface === "skipped" ? "The face had no readable boundary." : surface === "approximated" ?
        "The reader projected the surface boundary onto a plane." : flat ? undefined : "The curved surface is tessellated to the display chord tolerance.";
      sink.add("STEP preview face", status, ref(pathOf(f), "#" + id), reason);
    }});
    if (mesh.error) throw Error(mesh.error);
    notes(sink, mesh.notes);
    sink.add("STEP reference file", "kept", {file:pathOf(f)}, "The original selected bytes are available in import data.");
    const mechanical = {mesh};
    if (opt.mode === "outline") {
      mechanical.design = G.AtriumMCADStep.boardFromStep(mesh, {z:opt.z, maxHole:opt.maxHole});
      proposalRows(mechanical.design, pathOf(f), sink, undefined, true);
    }
    return reference(files, mechanical);
  }
  function stepExport(id, model, opt, sink) {
    let {project, doc} = designFor(model, opt);
    project = G.AtriumVariants?.forOutput(project, opt.variant) || project;
    doc = project.documents.find(d => d.id === doc.id);
    const o = {...opt, format:id, ...(opt.date != null && !opt.timestamp ? {timestamp:dateOf(opt.date).toISOString().slice(0, 19)} : {})};
    if (opt.panelId) {
      const panel = project.documents.find(d => d.id === opt.panelId && d.kind === "panel");
      if (!panel) throw Error("Choose a valid panel document.");
      const flat = G.AtriumPanel.flatten(project, panel, null, o);
      doc = flat.doc;
      project = {...project, library:[...flat.defs.values()], documents:[...project.documents.filter(d => d.kind !== "panel"), doc]};
    }
    const holes = [];
    o.holeResult = (item, owner, hit, reason) => holes.push({item, owner, hit, reason});
    let mesh;
    o.meshResult = result => { mesh = result; };
    const scene = G.AtriumSTEP.model(project, doc.id, o);
    const r = G.AtriumSTEP.buildModel(scene, o);
    if (opt.panelId) r.name = r.name.replace(/^[^.]*/, G.AtriumFabOutputs.baseName(doc.name));
    notes(sink, r.notes);
    const approximate = id === "glb" || !(doc.outline?.length >= 3) || !!scene.board.folded;
    sink.add("Board body", approximate ? "approximated" : "kept", ref(doc.name, doc.id + "/outline"),
      approximate ? (id === "glb" ? "The board body is tessellated to triangles." : scene.board.folded ?
        "Bent regions are polyhedral solids." : "The board body uses the design extents.") : undefined);
    const emittedHoles = new Set(scene.board.holes);
    for (const h of holes) {
      const present = emittedHoles.has(h.hit), slot = h.hit?.bore.cutter.kind === "slot";
      const partial = present && (h.hit.bore.z[0] > scene.board.z0 || h.hit.bore.z[1] < scene.board.z1);
      sink.add(slot ? "Slotted hole" : partial ? "Partial-depth hole" : "Through hole",
        !present ? "dropped" : id === "glb" || scene.board.folded ? "approximated" : "kept",
        ref(doc.name, h.owner ? h.owner.id + "/pad/" + h.item.number : h.item.id), !present ?
        h.reason || "The hole failed the selected size or solid-boundary checks." :
        scene.board.folded ? "Holes crossing a bend cut may be omitted." : id === "glb" ? "The hole wall was tessellated." : undefined);
    }
    const meshes = new Map((mesh?.parts || []).filter(p => p.kind === "component").map(p => [p.id + "/" + (p.bodyRecord || ""), p]));
    const represented = new Set();
    for (const p of scene.parts) {
      represented.add(p.id);
      const key = p.id + "/" + (p.bodyRecord || ""), rendered = meshes.get(key), missing = id === "glb" && !rendered;
      const generated = p.source === "generated" || p.source === "envelope";
      sink.add("Component body", missing ? "dropped" : generated || id === "glb" ? "approximated" : "kept", ref(doc.name, p.bodyRecord ? key : p.id),
        missing ? "No readable body triangles were available." : rendered?.boundsOnly ? "The mesh uses the component model's bounding box." :
        generated ? "A footprint-derived body represents the component." : id === "glb" ? "The component body was tessellated to triangles." : undefined);
    }
    for (const item of doc.items) if (item.kind === "part" && !represented.has(item.id))
      sink.add("Component body", "dropped", ref(doc.name, item.id), "No component body was included by the active options, variant and available geometry.");
    for (const l of scene.layers) sink.add("Artwork layer", "approximated", ref(doc.name, l.name), "Copper or legend artwork is represented by thin component solids.");
    return {files:[typeof r.data === "string" ? {name:r.name, text:r.data} : {name:r.name, bytes:r.data}],
      details:{name:r.name, binary:id === "glb", stats:r.stats, notes:r.notes, variant:variantName(G.AtriumVariants?.forOutput(project, opt.variant) || project)}};
  }
  function proposalRows(design, file, sink, approximations = new WeakMap(), fromMesh = false) {
    function add(kind, row, name) {
      const reason = fromMesh ? "Derived from the section of a tessellated STEP body." : approximations.get(row);
      sink.add(kind, reason ? "approximated" : "kept", ref(file, row.ident?.number || row.number || row.ref || row.key || name), reason);
    }
    if (design.board) add("Mechanical board profile", design.board, "board outline");
    for (const [field, kind] of [["parts","Component placement"], ["holes","Drilled hole"], ["keepouts","Mechanical keep-out"],
      ["removed","Removed object"], ["responses","Proposal response"]])
      (design[field] || []).forEach((row, i) => add(kind, row, field + "/" + (i + 1)));
    notes(sink, design.notes);
  }
  function exchangeImport(id, files, opt, sink) {
    let primary, library, design;
    const approximations = new WeakMap(), trace = {
      approximate:(row, reason) => approximations.set(row, reason),
      omitted:(kind, object, reason, role) => sink.add(kind, "dropped", ref(pathOf(role === "library" ? library : primary), object), reason)
    };
    if (id === "idf") {
      const mains = files.filter(f => !/\.emp$/i.test(f.name)), libs = files.filter(f => /\.emp$/i.test(f.name));
      if (mains.length !== 1 || libs.length > 1) throw Error("Choose one IDF board and an optional companion package library.");
      primary = mains[0];
      library = libs[0];
      design = G.AtriumIDF.read(textOf(primary), library && textOf(library), trace);
      if (library) sink.add("IDF library source", "kept", {file:pathOf(library)}, "The original selected library bytes are available in import data.");
    } else {
      primary = one(files, 64 * 1048576);
      design = G.AtriumIDX.read(textOf(primary), {trace});
    }
    proposalRows(design, pathOf(primary), sink, approximations);
    return reference(library ? [primary, library] : [primary], {design});
  }
  function exchangeExport(id, model, opt, sink) {
    const {project, doc} = designFor(model, opt), o = {...opt, record:false}, MC = G.AtriumMCAD;
    const mode = opt.mode || "baseline";
    if (id === "idx" && !["baseline","changes","response"].includes(mode)) throw Error("Choose an IDX baseline, change set or response.");
    let snap;
    o.snapshotResult = value => { snap = value; };
    if (id === "idf" || mode === "baseline") {
      const indices = new WeakMap();
      for (const def of project.library) (def.footprint?.pads || []).forEach((pad, index) => indices.set(pad, index + 1));
      o.mechanicalHole = (pad, owner, included) => {
        const slot = pad.slotLength > pad.drill;
        sink.add("Drilled hole", !included ? "dropped" : slot ? "approximated" : "kept",
          ref(doc.name, owner ? owner.id + "/pad/" + indices.get(pad) : pad.id),
          !included ? "The selected exchange options exclude this pin or via hole." : slot ? "The exchange carries the round drill diameter of the slot." : undefined);
      };
    }
    const result = id === "idf" ? G.AtriumIDF.write(project, doc, o) : G.AtriumIDX[mode](project, doc, o);
    const files = id === "idf" ? [result.emn, result.emp] : [{name:result.name, text:result.text}];
    if (id === "idf" || mode === "baseline") {
      sink.add("Mechanical board profile", "kept", ref(doc.name, doc.id + "/outline"));
      for (const part of snap.parts) {
        sink.add("Component placement", "kept", ref(doc.name, part.key));
        sink.add("Package body", "approximated", ref(doc.name, part.key), "The exchange uses a planar package outline and height to represent the component body.");
      }
      for (const item of snap.keepouts) {
        const limited = id === "idf" && (item.z0 !== 0 || item.kind === "other" || !["Top","Bottom","Keepout","All"].includes(item.layer));
        sink.add("Mechanical keep-out", limited ? "approximated" : "kept", ref(doc.name, item.key),
          limited ? "The IDF section uses a top, bottom or through-board keep-out with a single height." : undefined);
      }
      for (const bend of snap.bends) sink.add("Bend", id === "idf" ? "dropped" : "kept", ref(doc.name, bend.key),
        id === "idf" ? "The IDF writer omits bend zones." : undefined);
    } else if (mode === "changes") {
      const change = MC.changesSince(doc, snap);
      for (const key of ["added","changed","removed"]) for (const item of change[key]) sink.add("IDX " + key, "kept", ref(doc.name, item));
    } else for (const p of MC.peek(doc)?.inbox || []) if (p.batch === result.stats.batch && p.ident?.number && ["accepted","rejected"].includes(p.status))
      sink.add("Proposal response", "kept", ref(doc.name, p.id));
    notes(sink, (result.problems || []).map(p => p.message));
    const baseline = id === "idx" && snap && opt.captureBaseline ? MC.recordSent(doc, snap, {at:opt.date, reset:mode === "baseline"}) : null;
    return {files, details:{stats:result.stats, problems:result.problems || [], ...(baseline ? {baseline} : {})}};
  }
  function dxfImport(files, opt, sink) {
    const f = one(files, 64 * 1048576), X = G.AtriumDXF, layers = opt.layers ? new Set(opt.layers) : null;
    const drawing = X.read(f.bytes, {entityResult(object, kind, status, layer) {
      const selected = !layers || layers.has(layer);
      sink.add("DXF " + kind, selected ? status : "dropped", ref(pathOf(f), object),
        !selected ? "The layer was excluded from this import." : status === "dropped" ? "This drawing entity has no supported geometry." :
        status === "approximated" ? "The curve or 3D polyline was sampled or projected into the drawing plane." : undefined);
    }});
    notes(sink, drawing.warnings);
    const result = reference(files, {drawing});
    if (!opt.mode || opt.mode === "inspect") return result;
    const board = G.Atrium.sheet("pcb", f.name), S = G.AtriumBoardShape;
    const choices = {layers:opt.layers, mm:opt.mm ?? drawing.units.mm, offset:opt.offset || [0, 0]};
    if (!(Number.isFinite(choices.mm) && choices.mm > 0) || !Array.isArray(choices.offset) ||
        choices.offset.length !== 2 || !choices.offset.every(Number.isFinite)) throw Error("Choose valid DXF units and origin.");
    if (opt.mode === "outline") {
      const res = G.AtriumBoardShapeSources.fromSegments(X.segments(drawing, choices), {tolerance:opt.tolerance, source:"dxf"});
      if (!res.shape) throw Error("The selected DXF entities do not form a closed board outline.");
      notes(sink, res.warnings);
      if (res.gaps.length) sink.add("Open DXF endpoint", "dropped", {file:pathOf(f)}, "Only closed loops form board contours.", res.gaps.length);
      S.apply(board, res.shape, "dxf");
      sink.produced("pcb", "board outline", {file:pathOf(f)}, board.id);
    } else if (opt.mode === "graphics") {
      const lines = X.polylines(drawing, {...choices, exactArcs:true});
      if (lines.length > 200000) throw Error("The selected DXF layers exceed 200,000 polylines.");
      const width = opt.width ?? .1;
      if (!Number.isFinite(width) || width < 0) throw Error("The DXF line width must be a nonnegative number.");
      board.items = lines.filter(p => p.points.length >= 2).map(p => {
        const id = G.Atrium.id();
        sink.produced("pcb", "graphic", ref(pathOf(f), p.reference), id);
        return {id, kind:"graphic", layer:opt.target || "Mechanical 1", width, points:p.points,
          ...(p.arc ? {arc:p.arc} : {}), ...(p.closed ? {closed:true} : {})};
      });
    } else throw Error("Choose DXF inspection, board outline or mechanical graphics.");
    result.model.documents = [board];
    delete result.provenance.mechanical.drawing;
    return result;
  }
  function dxfExport(model, opt, sink) {
    const {project, doc} = designFor(model, opt), defs = new Map(project.library.map(d => [d.id, d]));
    const r = G.AtriumDXF.exportBoard(doc, defs, {...opt, sourceEntity(kind, id, status) {
      sink.add(kind, status, ref(doc.name, id), status === "approximated" ?
        (kind === "Hole" ? "The drawing contains the drill diameter of the slot." : "The drawing carries the centreline or boundary without fill or stroke width.") : undefined);
    }});
    const name = (opt.nameStyle === "command" ? (doc.name || "board").replace(/[^\w.-]+/g, "_") : String(doc.name || "Board").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim()) + ".dxf";
    return {files:[{name, text:r.text}], details:{document_id:doc.id, name, entities:r.entities}};
  }
  const app = {};
  for (const id of ["gerber","excellon","fabrication"]) app[id] = {export:(m,o,f,p) => fabrication(id,m,o,f,p)};
  app.ipc2581 = {export:ipc};
  app.odb = {export:odb};
  app.dxf = {import:dxfImport, export:dxfExport};
  app.step = {import:stepImport, export:(m,o,f) => stepExport("step",m,o,f)};
  app.glb = {export:(m,o,f) => stepExport("glb",m,o,f)};
  for (const id of ["idx","idf"]) app[id] = {import:(fs,o,f) => exchangeImport(id,fs,o,f), export:(m,o,f) => exchangeExport(id,m,o,f)};
  return Object.freeze(app);
})();
