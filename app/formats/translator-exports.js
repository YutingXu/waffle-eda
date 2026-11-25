"use strict";
// Worker-local design and portable library/netlist translators. The writers own the
// formats. Only their detached results, names and review data cross this boundary.
globalThis.AtriumTranslatorExports = (() => {
  const P = () => globalThis.AtriumTranslatorProvenance;
  const leaf = name => String(name || "").split(/[\\/]/).pop();
  const safe = name => String(name || "Waffle").replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").trim() || "Waffle";
  const isDesign = d => d.kind === "pcb" || d.kind === "schematic";
  const kindOf = d => d.kind === "pcb" ? "PCB document" : "Schematic document";
  const sourceOf = (d, item) => ({file:d.sourceName || d.name, object:item ?
    String(typeof item === "string" ? item : item.sourceRecord || (item.schSource ? "FileHeader#" + item.schSource.record + "/" + item.schSource.role : d.id + "/" + item.id)) : d.id});
  const output = f => f.bytes ? {name:f.name,bytes:f.bytes} : {name:f.name,text:f.content};
  function select(p, options) {
    const scope = options.scope || (options.documentId ? "document" : "project");
    if (!["project","document","documents"].includes(scope)) throw Error("Unknown design export scope.");
    const doc = options.documentId == null ? null : p.documents.find(d => d.id === options.documentId);
    if ((options.documentId != null || scope === "document") && (!doc || !isDesign(doc))) throw Error("Choose an existing schematic or PCB document.");
    return {scope,doc};
  }
  function skipDocument(fidelity, doc, reason) {
    fidelity.add(kindOf(doc),"dropped",sourceOf(doc),reason);
    for (const item of doc.items) fidelity.add(item.kind,"dropped",sourceOf(doc,item),reason);
  }
  function exportNotes(fidelity, list) {
    for (const message of list) fidelity.note(message);
  }
  function altiumDirectionLoss(fidelity, doc, item, source = null) {
    if (!Atrium.isOffsheet(item) || item.io == null || item.io === "unspecified") return;
    const reason = "The " + item.io + " direction on " + item.text + " was dropped. Altium off-sheet connectors have no I/O type.";
    fidelity.add("Off-sheet connector direction","dropped",source || sourceOf(doc,item),reason);
    return reason;
  }
  function pageSource(fidelity, doc, page) {
    if (page) fidelity.add("Schematic page",page.infinite ? "approximated" : "kept",sourceOf(doc),page.note);
  }
  function pagesFor(model, options, fidelity, format) {
    const legacy=P().toLegacy(model,options.provenance), selection=select(legacy,options);
    const prepared=globalThis.AtriumSchematicOutput?.prepare(legacy,format,{
      pageMode:options.pageMode, documentId:selection.scope === "document" ? selection.doc?.id : null
    }) || {project:legacy,choices:[]};
    const movedSources=new Map();
    for (const choice of prepared.choices) {
      const d=legacy.documents.find(d=>d.id===choice.document);
      const originals=new Map(d.items.map(item=>[item.id,item]));
      fidelity.add("Schematic page","approximated",sourceOf(d),choice.note);
      fidelity.note(choice.note);
      for (const f of choice.frames) {
        fidelity.add("frame","approximated",sourceOf(d,originals.get(f.frame)),"Exported as sheet “"+f.name+"” with a parent sheet symbol.");
        const sources=new Map();
        for (const id of f.moved) {
          const original=originals.get(id);
          if (original) sources.set(id,sourceOf(d,original));
        }
        if (sources.size) movedSources.set(f.document,sources);
      }
    }
    let p=prepared.project;
    const doc=selection.doc && p.documents.find(d=>d.id===selection.doc.id);
    let projection=options.notebookProjection;
    if (projection?.length && prepared.choices.length) {
      const documents=new Map(p.documents.map(sheet=>[sheet.id,sheet]));
      const originalDocs=new Map(legacy.documents.map(sheet=>[sheet.id,sheet]));
      const moved=new Map();
      for (const choice of prepared.choices) for (const frame of choice.frames) {
        for (const itemId of frame.moved) moved.set(JSON.stringify([choice.document,itemId]),frame.document);
      }
      projection=projection.map(row=>{
        const documentId=moved.get(JSON.stringify([row.documentId,row.itemId])) || row.documentId;
        if (documentId!==row.documentId) return {...row,documentId};
        if (!row.box || !prepared.choices.some(choice=>choice.document===documentId)) return row;
        const before=originalDocs.get(documentId)?.items.find(i=>i.id===row.itemId);
        const after=documents.get(documentId)?.items.find(i=>i.id===row.itemId);
        if (!before || !after || !Number.isFinite(before.x) || !Number.isFinite(before.y)) return row;
        const dx=after.x-before.x, dy=after.y-before.y;
        return {...row,box:row.box.map((n,index)=>n+(index%2?dy:dx))};
      });
    }
    if (prepared.choices.length && selection.scope === "document") {
      // A single selected sheet can become a hierarchy. Keep the selected root and its
      // transitive children together without including unrelated sheets or boards.
      const documents=new Map(p.documents.map(d=>[d.id,d])), keep=new Set(), pending=[doc];
      while (pending.length) {
        const d=pending.pop();
        if (!d || keep.has(d.id)) continue;
        keep.add(d.id);
        for (const symbol of d.items) if (symbol.kind === "sheetsymbol") pending.push(documents.get(symbol.sheet));
      }
      p={...p,name:doc.name,documents:[doc,...p.documents.filter(d=>d!==doc && keep.has(d.id))]};
      return {p,doc,scope:"project",projection,movedSources};
    }
    return {p,doc,scope:selection.scope,projection,movedSources};
  }
  function countWritten(fidelity, doc, counts, format) {
    // Primitive counts come from the actual writer. A polyline, for example, may
    // yield several track records. Keep these distinct from source object counts.
    for (const [kind,count] of Object.entries(counts || {})) if (count && kind !== "sheets") {
      fidelity.add(format + " " + kind,"kept",sourceOf(doc),"Records written from this document.",count);
    }
  }
  function boardBodies(doc, defs, visit) {
    for (const body of doc.bodies3d || []) visit(body,doc);
    for (const i of doc.items) if (i.kind === "part") {
      const fp = defs.get(i.def)?.footprint;
      for (const body of i.bodies3d || fp?.bodies3d || []) visit(body,i);
    }
  }
  // The serializer changes the output count only when it actually emits an object.
  // Capture its diagnostic in the same item scope. Whole-document notes (including
  // imported notes) are deliberately excluded from an individual object's status.
  function designObserver(format, fidelity, options, precision, project, provenance) {
    const isUsedRule = options?.usedFeatures && AtriumTranslatorProvenance.usedRule(project,provenance);
    const art=new Map();
    for(const v of options?.notebookProjection || []){
      if(!v || typeof v.documentId!=="string" || typeof v.itemId!=="string")continue;
      let doc=art.get(v.documentId);if(!doc){doc=new Map();art.set(v.documentId,doc);}doc.set(v.itemId,v);
    }
    const entries = new Map(), written = new Map();
    let messages = null;
    const itemSource=(doc,item)=>options.movedSources.get(doc.id)?.get(item.id) || sourceOf(doc,item);
    function usedKind(doc,item) {
      if (doc.kind === "pcb" && (item.kind === "graphic" || item.kind === "label") &&
          (format === "KiCad" || !item.planeVoid) && (item.keepout === true || /^keep-?out/i.test(item.layer || "")))
        return "keepout";
      return item.role === "frame" ? "frame" : globalThis.Atrium.notebookItemKind(item);
    }
    const observer = {
      looseFiles:true,
      usedFeatures:!!options?.usedFeatures,
      precision,
      notebook:(doc,item)=>art.get(doc.id)?.get(item.id),
      diagnostics(note) {
        return message => { if (messages) messages.add(message); return note(message); };
      },
      observed(doc,item,kind,status,reason) {
        item = precision?.original(item) || item;
        if (kind === "Design rule" && isUsedRule && !isUsedRule(doc,item)) return;
        if (observer.primaryOnly && kind === "Design rule" && status !== "dropped" && !["solderMask","pasteMask"].includes(item.type)) {
          status = "dropped"; reason = "This named rule requires a KiCad project or rule companion. Only the primary board was requested.";
        }
        if (!entries.has(doc)) entries.set(doc,new Map());
        entries.get(doc).set(item,{kind,status,reason});
      },
      *items(doc, list, mark, kind, owner) {
        let index = 0;
        for (const item of list) {
          const key = owner ? owner + "/" + kind + "[" + index + "]" : item;
          index++;
          const before = mark(), parent = messages;
          messages = new Set();
          yield precision?.item(doc,item) || item;
          const emitted = mark() > before, notes = [...messages]; messages = parent;
          // KiCad defers wires and junctions until all electrical anchors are known.
          if (format === "KiCad" && !kind && doc.kind === "schematic" && ["wire","junction"].includes(item.kind)) continue;
          // Native Altium polygons are emitted before their children. The later
          // item pass revisits the same polygon to check whether it was omitted.
          if (!emitted && entries.get(doc)?.has(key)) continue;
          if (format === "KiCad" && item.kind === "track" && item.arc) notes.push("The native arc is written as straight track segments.");
          if (!emitted && item.kind === "netlabel" && item.text) notes.push("A label with the same name and anchor may already represent this net.");
          const changed = notes.length > 0;
          const status = emitted ? (changed ? "approximated" : "kept") : "dropped";
          observer.observed(doc,key,kind || item.kind,status,notes.join(" ") || (emitted ? undefined : "No target record was emitted for this source object."));
        }
      },
      written(doc,name,r) { pageSource(fidelity,doc,r.page); written.set(doc,{name,counts:r.counts,offset:r.offset}); },
      flush(doc,defs) {
        const rows = entries.get(doc);
        for (const [item,row] of rows || []) {
          const nativeKind = options?.usedFeatures && row.kind === item.kind && usedKind(doc,item);
          const source=itemSource(doc,item);
          fidelity.add(nativeKind || row.kind,row.status,source,row.reason);
          if (format === "Altium" && doc.kind === "schematic") altiumDirectionLoss(fidelity,doc,item,source);
        }
        if (format === "KiCad" && doc.kind === "schematic") {
          for (const i of doc.items) if (i.kind === "junction" && !rows?.has(i)) {
            fidelity.add("junction","approximated",itemSource(doc,i),"Coincident junctions share a single KiCad junction record.");
          }
        }
        if (format === "KiCad" && doc.kind === "pcb") boardBodies(doc,defs,(b,owner) => fidelity.add("3D body","dropped",
          {file:doc.sourceName || doc.name,object:(owner.id || doc.id) + "/" + (b.sourceRecord || b.id || b.modelId)},"This KiCad board writer does not emit 3D bodies."));
        entries.delete(doc);
      },
      documents:written
    };
    return observer;
  }
  function completedDocument(observer, emitted, doc, fidelity, format, defs) {
    fidelity.add(kindOf(doc),"kept",sourceOf(doc),"Written to " + emitted.name + ".");
    countWritten(fidelity,doc,emitted.counts,format);
    observer.flush(doc,defs);
  }
  function kicadDocument(p, doc, fidelity, defs, observer) {
    const r = doc.kind === "pcb" ? AtriumKiCad.exportBoard(p,doc,observer) : AtriumKiCadSchematic.exportSheet(p,doc,observer);
    pageSource(fidelity,doc,r.page);
    completedDocument(observer,r,doc,fidelity,"KiCad",defs);
    const companions = r.files || [], omitted = observer.primaryOnly ? companions : [];
    for (const f of omitted) fidelity.add("Rule companion","dropped",{file:sourceOf(doc).file,object:f.name},"Only the primary board file was requested.");
    const files = [output(r),...(observer.primaryOnly ? [] : companions.map(output))];
    if (omitted.length) r.diagnostics = [...r.diagnostics,"Primary file only. The following rule companions were omitted: " + omitted.map(f => f.name).join(", ") + "."];
    const info = {name:r.name,documentId:doc.id,kind:doc.kind,counts:r.counts,diagnostics:r.diagnostics,companions:files.slice(1).map(f => f.name),
      ...(r.fidelity?.length ? {fidelity:r.fidelity} : {})};
    const outputs = [info,...files.slice(1).map((f,i) => ({name:f.name,documentId:doc.id,kind:doc.kind,companion:i,counts:{},diagnostics:[]}))];
    return {files,outputs,details:{name:r.name,counts:r.counts,diagnostics:r.diagnostics,...(r.offset ? {offset:r.offset} : {})}};
  }
  function documentStems(docs) {
    const key = (d,s) => d.kind + "/" + s.normalize("NFC").toLowerCase();
    const reserved = new Set(docs.map(d => key(d,AtriumKiCad.nameFor(d.name,"")))), used = new Set(), stems = new Map();
    for (const d of docs) {
      const base = AtriumKiCad.nameFor(d.name,"");
      let name = base, n = 1;
      if (used.has(key(d,name))) {
        do { name = base + "-" + ++n; } while (used.has(key(d,name)) || reserved.has(key(d,name)));
        stems.set(d.id,name);
      }
      used.add(key(d,name));
    }
    return d => stems.get(d.id);
  }
  function kicad(model, options, fidelity) {
    const {p,scope,doc,projection,movedSources} = pagesFor(model,options,fidelity,"kicad");
    const defs = new Map(p.library.map(d => [d.id,d]));
    const observer = designObserver("KiCad",fidelity,{notebookProjection:projection,usedFeatures:options.usedFeatures,movedSources},globalThis.AtriumTranslatorPrecision?.forExport(p,options.provenance,"kicad"),p,options.provenance);
    if (scope !== "project") {
      const docs = scope === "document" ? [doc] : p.documents.filter(isDesign);
      observer.primaryOnly = options.primaryOnly === true;
      if (scope === "documents") observer.fileStem = documentStems(docs);
      if (!docs.length) throw Error("This project has no schematic or PCB documents.");
      const files = [], outputs = [], diagnostics = new Set();
      let details;
      for (const d of docs) {
        const r = kicadDocument(p,d,fidelity,defs,observer);
        files.push(...r.files); outputs.push(...r.outputs);
        for (const m of r.details.diagnostics) diagnostics.add(m);
        if (scope === "document") details = r.details;
      }
      const notes = [...diagnostics];
      exportNotes(fidelity,notes);
      return {files,details:{...(details || {name:safe(p.name),counts:{documents:docs.length},diagnostics:notes}),outputs}};
    }
    const r = AtriumKiCad.exportProject(p,doc,observer), outputs = [];
    const byName = new Map();
    for (const [d,part] of observer.documents) {
      byName.set(part.name,d);
      completedDocument(observer,part,d,fidelity,"KiCad",defs);
    }
    for (const f of r.files) {
      const d = byName.get(f.name);
      outputs.push({name:f.name,...(d ? {documentId:d.id,kind:d.kind} : {}),counts:observer.documents.get(d)?.counts || {}});
    }
    for (const d of p.documents.filter(isDesign)) if (!observer.documents.has(d)) skipDocument(fidelity,d,d.kind === "pcb" ?
      "The KiCad project contains one primary board." : "The writer skipped an empty sheet or a duplicate output filename.");
    exportNotes(fidelity,r.diagnostics);
    return {files:r.files.map(output),details:{name:r.name,archivePrefix:r.name.replace(/-kicad\.zip$/i,""),counts:r.counts,diagnostics:r.diagnostics,outputs}};
  }
  function altium(model, options, fidelity) {
    const {p,scope,doc,projection,movedSources} = pagesFor(model,options,fidelity,"altium");
    const defs = new Map(p.library.map(d => [d.id,d]));
    const project = scope === "document" ? {...p,documents:[doc]} : p, observer = designObserver("Altium",fidelity,{notebookProjection:projection,usedFeatures:options.usedFeatures,movedSources},globalThis.AtriumTranslatorPrecision?.forExport(p,options.provenance,"altium"),p,options.provenance);
    // The project writer resolves, deduplicates and names body model sidecars.
    // Keep it on the selected-board path too, so the PcbDoc references real files.
    let result, files;
    if (scope === "document" && doc.kind === "schematic") {
      observer.primaryOnly=true;
      result = AtriumAltiumExport.exportSchematic(p,doc,observer);
      pageSource(fidelity,doc,result.page);
      files = [{...result,document:doc.id}];
    } else {
      result = AtriumAltiumExport.exportProject(project,observer);
      files = scope === "document" ? result.files.filter(f => !/\.PrjPcb$/i.test(f.name)) : result.files;
    }
    const docs = new Map(project.documents.filter(isDesign).map(d => [d.id,d])), written = new Set(), outputs = [];
    for (const f of files) {
      const d = docs.get(f.document);
      if (d) {
        written.add(d);
        completedDocument(observer,f,d,fidelity,"Altium",defs);
      } else if (/\.step$/i.test(f.name)) fidelity.add("STEP sidecar","kept",{file:f.name},"The PcbDoc uses this emitted model file.");
      outputs.push({name:f.name,...(d ? {documentId:d.id,kind:d.kind} : {}),counts:f.counts || {}});
    }
    for (const d of docs.values()) if (!written.has(d)) skipDocument(fidelity,d,"The ASCII project writer omitted an empty document.");
    const primary = scope === "document" ? files.find(f => f.document === doc.id) : null;
    const details = {name:primary?.name || result.name,counts:primary?.counts || result.counts,outputs,diagnostics:result.diagnostics,
      ...(result.fidelity?.length ? {fidelity:result.fidelity} : {}),
      ...((result.offset || observer.documents.get(doc)?.offset) ? {offset:result.offset || observer.documents.get(doc).offset} : {}),...(scope !== "document" ? {archivePrefix:result.name.replace(/-altium-ascii\.zip$/i,"")} : {})};
    exportNotes(fidelity,details.diagnostics);
    return {files:files.map(output),details};
  }
  function sourceCopy(model, options, fidelity) {
    const p = P().toLegacy(model,options.provenance);
    const doc = select(p,{...options,scope:"document"}).doc;
    const ext = doc.kind === "pcb" ? ".pcbdoc" : ".schdoc", original = options.original;
    if (!original?.name || !(original.bytes instanceof Uint8Array) || !leaf(original.name).toLowerCase().endsWith(ext)) throw Error("Select the original binary " + ext + " file.");
    if (doc.sourceEncoding === "ascii") throw Error("This document was imported from Altium ASCII. A binary copy requires the imported binary original.");
    const entries = (Array.isArray(options.provenance) ? options.provenance : [options.provenance]).flatMap(g => g?.files || []);
    const linked = entries.filter(f => f.documents?.includes(doc.id) && leaf(f.name).toLowerCase().endsWith(ext));
    if (linked.length) {
      const digest = AtriumSourceFile.sha256(original.bytes);
      if (!linked.some(f => f.sha256 === digest)) throw Error("The selected source differs from this document's recorded import digest.");
    }
    const r = AtriumSourceCopy.prepare(doc,p.library,original.bytes,{provenance:options.provenance,project:model});
    if (r.binding) {
      fidelity.note("Review the verified original and link the older document before creating a copy.");
      return {files:[],details:{binding:r.binding}};
    }
    for (const i of doc.items) {
      const loss = doc.kind === "schematic" && altiumDirectionLoss(fidelity,doc,i);
      fidelity.add(i.kind,loss ? "approximated" : "kept",sourceOf(doc,i),loss || "Verified in the native source copy.");
    }
    if (doc.kind === "pcb") {
      if (doc.rules) fidelity.add("Active rule overrides","dropped",sourceOf(doc),"The native copy retains the original Altium rule records.");
      for (const r of p.rules?.list || []) if (r.origin?.kind !== "import" && (!r.boards || r.boards.includes(doc.id))) {
        fidelity.add("Design rule override","dropped",sourceOf(doc,r),"The native copy retains the original Altium constraints.");
      }
    }
    exportNotes(fidelity,r.diagnostics);
    const {bytes,...details} = r;
    return {files:[{name:r.name,bytes}],details};
  }
  function oneFile(files) {
    if (files.length !== 1) throw Error("Select one portable library or netlist file at a time.");
    return files[0];
  }
  function provenanceOf(f, model) {
    const library = model.library.map(d => d.id), documents = model.documents.map(d => d.id);
    return {version:1,files:[{name:f.name,...(f.path ? {path:f.path} : {}),bytes:f.bytes,sha256:AtriumSourceFile.sha256(f.bytes),documents,library}]};
  }
  function libraryFeatures(fidelity, file, defs) {
    for (const d of defs) {
      fidelity.add("Library component","kept",{file,object:d.id});
      for (const [kind,list] of [["Pin",d.symbol?.pins],["Pad",d.footprint?.pads],["3D body",d.footprint?.bodies3d]]) {
        for (const [n,item] of (list || []).entries()) fidelity.add(kind,"kept",{file,object:d.id + "/" + kind + "[" + n + "] " + (item.number || item.id || "")});
      }
    }
  }
  function importLibrary(files, options, fidelity) {
    const f = oneFile(files), file = f.path || f.name, text = new TextDecoder().decode(f.bytes);
    const read = AtriumLibrary.readLibraryFile(text,f.name,(index,d,ok,reason) => {
      if (!ok) fidelity.add("Library component","dropped",{file,object:"defs[" + index + "] " + (d?.id || "")},reason);
    });
    const {defs,componentFamilies,warnings,...metadata} = read;
    const p = Atrium.project(read.name);
    p.documents = []; p.library = defs;
    if (componentFamilies) p.componentFamilies = componentFamilies;
    const prov = provenanceOf(f,p);
    prov.portableLibrary = {...metadata,fileName:f.name,warnings};
    libraryFeatures(fidelity,file,defs);
    for (const family of componentFamilies || []) fidelity.add("Component family","kept",{file,object:family.id});
    exportNotes(fidelity,warnings);
    return {model:P().separate(p,prov),provenance:prov};
  }
  function exportLibrary(model, options, fidelity) {
    const p = P().toLegacy(model,options.provenance);
    const envelope = options.library || options.provenance?.portableLibrary || {};
    const name = envelope.name || p.name || "Library", file = safe(leaf(envelope.fileName || name).replace(/\.atrlib$/i,"")) + ".atrlib";
    const defs = p.library;
    const r = AtriumLibrary.libraryFile({...envelope,name,defs,componentFamilies:p.componentFamilies},p);
    libraryFeatures(fidelity,file,defs.filter(d => !d.mirrorOf));
    for (const d of defs.filter(d => d.mirrorOf)) fidelity.add("Library component","dropped",{file,object:d.id},"A generated mirror is excluded from portable libraries.");
    for (const key of r.removed) fidelity.add("Credential-like field","dropped",{file,object:key},"The portable library writer excludes these fields.");
    return {files:[{name:file,text:r.text}],details:{name:file,removed:r.removed,counts:{components:defs.filter(d => !d.mirrorOf).length},diagnostics:[]}};
  }
  function netlist(format) {
    return {
      import(files, options, fidelity) {
        const f = oneFile(files), file = f.path || f.name;
        const parsed = AtriumNetlist.parse(new TextDecoder().decode(f.bytes),{format,decision(kind,status,object,reason) {
          fidelity.add(kind,status,{file,object},reason);
        }});
        if (!parsed.components.length) throw Error("The netlist lists no components.");
        const p = options.project ? P().toLegacy(options.project,options.provenance) : Atrium.project(options.name || leaf(f.name).replace(/\.[^.]+$/,""));
        if (!options.project) p.documents = [];
        const oldDefs = new Set(p.library.map(d => d.id)), oldDocs = new Set(p.documents.map(d => d.id));
        const r = AtriumNetlist.importInto(p,parsed,{board:options.documentId,sheet_name:options.sheetName || options.sheet_name,starter:options.starter,
          onDefinition(c,how) {
            if (how === "generic") fidelity.add("Symbol geometry","approximated",{file,object:c.ref},"A generic box symbol represents this unmatched component.");
            if (how === "starter") fidelity.add("Library match","approximated",{file,object:c.ref},"A starter component matched by package, designator prefix and pins.");
          }});
        const generated = p.documents.find(d => d.id === r.sheet_id), refs = new Map(generated.items.filter(i => i.kind === "part").map(i => [i.ref.toUpperCase(),i]));
        const actual = AtriumNetlist.extract({...p,documents:[generated]},{source:"schematic"});
        const nets = new Map(actual.nets.map(n => [n.name,new Set(n.nodes.map(v => v.ref.toUpperCase() + "/" + v.pin))]));
        for (const c of parsed.components) fidelity.add("Component",refs.has(c.ref.toUpperCase()) ? "kept" : "dropped",{file,object:c.ref},
          refs.has(c.ref.toUpperCase()) ? "Placed on the generated netlist sheet." : "Designator already exists.");
        for (const n of parsed.nets) {
          const nodes = nets.get(n.name);
          fidelity.add("Net",nodes?.size ? "kept" : "dropped",{file,object:n.name},nodes?.size ? undefined : "The generated sheet has no named connection for this net.");
          for (const v of n.nodes) {
            const present = nodes?.has(v.ref.toUpperCase() + "/" + v.pin);
            fidelity.add("Pin connection",present ? "kept" : "dropped",{file,object:n.name + "/" + v.ref + "/" + v.pin},present ? undefined : "No matching named pin connection on the generated sheet.");
          }
        }
        exportNotes(fidelity,r.issues);
        const prov = provenanceOf(f,p);
        prov.files[0].documents = p.documents.filter(d => !oldDocs.has(d.id)).map(d => d.id);
        prov.files[0].library = p.library.filter(d => !oldDefs.has(d.id)).map(d => d.id);
        prov.netlist = {...r,format};
        if (options.project) {
          // Importing into a working project owns only the new sheet and definitions.
          // The project retains the previous import's original files and field bindings.
          P().separate({documents:p.documents.filter(d => !oldDocs.has(d.id)),library:p.library.filter(d => !oldDefs.has(d.id))},prov);
          P().separate(p,{});
        } else P().separate(p,prov);
        return {model:p,provenance:prov};
      },
      export(model, options, fidelity) {
        const p = P().toLegacy(model,options.provenance);
        const d = options.documentId == null ? null : select(p,options).doc;
        const source = options.source || (d ? d.kind : "auto");
        if (!["auto","pcb","schematic"].includes(source)) throw Error("Choose schematic, PCB or automatic netlist extraction.");
        const refSources = new Map(), represented = new Set();
        const n = AtriumNetlist.extract(p,{source,board:d?.kind === "pcb" ? d.id : options.board,onPart(ref,doc,item) {
          refSources.set(ref,sourceOf(doc,item)); represented.add(item);
        }});
        const name = safe(p.name) + (format === "protel" ? "-protel.net" : format === "csv" ? (options.nameStyle === "command" ? "-netlist.csv" : ".csv") : ".net");
        const text = AtriumNetlist[format](n,{name:p.name,date:options.date});
        const sourceName = d?.sourceName || d?.name || p.name || "Waffle";
        const subjects = p.documents.filter(doc => n.source === "schematic" ? doc.kind === "schematic" : doc.id === n.document);
        for (const subject of subjects) for (const item of subject.items) if (item.kind === "part" && !represented.has(item)) {
          fidelity.add("Component","dropped",sourceOf(subject,item),"The component was excluded by netlist extraction (missing geometry, unannotated or duplicate designator).");
        }
        for (const c of n.components) {
          const ref = refSources.get(c.ref) || {file:sourceName,object:c.ref}, connected = c.pins.some(pin => pin.net);
          const listed = format !== "csv" || connected;
          fidelity.add("Component",listed ? "kept" : "dropped",ref,listed ? undefined : "The CSV contains connected pins only.");
          if (format === "csv" && (c.value || c.footprint)) fidelity.add("Component value and footprint","dropped",ref,"CSV carries the designator, pin and net.");
          if (format !== "kicad" && Object.keys(c.parameters || {}).length) fidelity.add("Component parameter","dropped",ref,"The selected netlist format has no component parameters.",Object.keys(c.parameters).length);
          for (const pin of c.pins) {
            const from = {file:ref.file,object:c.ref + "/" + pin.number};
            if (!pin.net && format !== "kicad") fidelity.add("Unconnected pin","dropped",from,"The format lists only connected pins.");
            if (pin.name && format === "protel") fidelity.add("Pin name","dropped",from,"Protel node blocks carry only the designator and pin number.");
            if (pin.type && format !== "kicad") fidelity.add("Pin electrical type","dropped",from,"This netlist has no electrical-type field.");
          }
        }
        for (const net of n.nets) {
          fidelity.add("Net","kept",{file:refSources.get(net.nodes[0]?.ref)?.file || sourceName,object:net.name});
          for (const v of net.nodes) fidelity.add("Pin connection","kept",{file:refSources.get(v.ref)?.file || sourceName,object:net.name + "/" + v.ref + "/" + v.pin});
        }
        exportNotes(fidelity,n.issues);
        const counts = {components:n.components.length,nets:n.nets.length,connections:n.nets.reduce((s,x) => s + x.nodes.length,0)};
        return {files:[{name,text}],details:{name,format,source:n.source,documentId:n.document,document_id:n.document,diagnostics:n.issues,
          counts,...counts,untrusted_design_text:{issues:n.issues.slice(0,50)}}};
      }
    };
  }
  // These project-owned lists have no storage in the four design exporters. Count
  // authored entities only. Built-in empty defaults and derived output records add no row.
  function projectWriter(write) {
    return {export(model,options,report) {
      const result = write(model,options,report);
      if (!options.usedFeatures || options.scope !== "project") return result;
      const fields = [["variants","Assembly variant"],["outputJobs","Output job"],["bomViews","BOM view"],["layoutBlocks","Reusable layout block"]];
      const add = (feature,item) => report.add(feature,"dropped",{file:model.name || "Project",object:item.id || item.name || feature},
        "The exported project does not include this Waffle definition.");
      for (const [field,kind] of fields) for (const item of model[field] || []) add(kind,item);
      for (const item of Object.values(model.review?.records || {})) {
        if (item.type === "thread" || item.type === "reply") add(item.type === "thread" ? "Review thread" : "Review reply",item);
      }
      return result;
    }};
  }
  return Object.freeze({kicad:projectWriter(kicad),altium:projectWriter(altium),
    eagle:projectWriter((...args) => globalThis.AtriumEagleExport.export(...args)),
    easyeda:projectWriter((...args) => globalThis.AtriumEasyEDAExport.export(...args)),"altium-source-copy":{export:sourceCopy},
    "waffle-library":{import:importLibrary,export:exportLibrary},"netlist-kicad":netlist("kicad"),"netlist-protel":netlist("protel"),"netlist-csv":netlist("csv")});
})();
