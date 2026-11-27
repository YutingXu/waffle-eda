"use strict";
// Synchronous, worker-local adapters. All input is already selected and bounded by the request;
// manifest references and external models never acquire an implicit right to read another file.
globalThis.AtriumTranslatorAdapters = (() => {
  const A = () => globalThis.Atrium;
  const P = () => globalThis.AtriumTranslatorProvenance;
  const fileName = f => f.path || f.name;
  function original(f) {
    const bytes = new Uint8Array(f.bytes);
    return {name:f.name, ...(f.path ? {path:f.path} : {}), sha256:AtriumSourceFile.sha256(bytes), bytes, documents:[], library:[]};
  }
  function validate(p) {
    // Library-only reads deliberately contain zero documents. Validate their definitions using
    // the same project validator as a placed design without fabricating an imported sheet.
    return A().validate(p.documents.length ? p : {...p, documents:[A().sheet("schematic", "Library validation")]});
  }
  // A decoder reports a decision while it still has the source record in hand. The final size/
  // coordinate scrub can reject the resulting object; revise that specific record before emission.
  // decide(kind,source,resolve) defers a record's status until every selected file is read and linked:
  // resolve(confirmed) returns {status,reason}; confirmed(key) tells whether any file called confirm(key).
  function tracking(fidelity) {
    const pending = [], outputs = [], rejected = new WeakSet(), replacements = new WeakMap(), decisions = [], confirmed = new Set();
    return {
      add: (...args) => fidelity.add(...args), note: s => fidelity.note(s),
      decide(kind,source,resolve) { decisions.push({kind,source,resolve}); },
      confirm(key) { confirmed.add(key); },
      track(kind,status,source,object,reason) {
        if (!object || typeof object !== "object") fidelity.add(kind,status,source,reason);
        else pending.push({kind,status,source,object,reason});
      },
      produced(documentKind,source,object) { outputs.push({documentKind,source,object}); },
      remap(first, next) { replacements.set(first,next); },
      reject(object) { if (object && typeof object === "object") rejected.add(object); },
      finish() {
        const has = key => confirmed.has(key);
        for (const d of decisions) { const r = d.resolve(has); fidelity.add(d.kind, r.status, d.source, r.reason); }
        for (const r of outputs) if (!rejected.has(r.object)) {
          const item = replacements.get(r.object) || r.object;
          fidelity.produced(r.documentKind,item.kind,r.source,item.id);
        }
        for (const r of pending) {
          const invalid = rejected.has(r.object);
          fidelity.add(r.kind, invalid ? "dropped" : r.status, r.source, invalid ? "Invalid coordinates or sizes." : r.reason);
        }
      }
    };
  }
  function scope(sink, f) {
    const qualify = s => ({...s,file:s.file === f.name || s.file === AtriumImportFormats.baseName(f.name) || !s.file ? fileName(f) : s.file});
    return {
      add:(k,v,s,r,n) => sink.add(k,v,qualify(s),r,n),
      decide:(k,s,resolve) => sink.decide(k,qualify(s),resolve), confirm:key => sink.confirm(key),
      track:(k,v,s,o,r) => sink.track(k,v,qualify(s),o,r),
      produced:(d,s,o) => sink.produced(d,qualify(s),o), reject:o => sink.reject(o), note:s => sink.note(s)
    };
  }
  function attachModels(results, designs, assets, fidelity) {
    const loaded = new Map(), changed = new Map(), used = new Set();
    let bytes = 0;
    for (const {f,asset,parsed} of AtriumIO.modelLinks(results, designs, assets, fileName)) {
      if (!loaded.has(f)) {
        let text = null;
        if (f.bytes.length <= Math.min(32 * 1048576, 64 * 1048576 - bytes)) {
          try { text = AtriumIO.read(f.name, f.bytes).modelFile.stepText; bytes += f.bytes.length; }
          catch { /* Preserve an unreadable candidate in the provenance with its own reference. */ }
        }
        loaded.set(f, text);
      }
      if (loaded.get(f)) { asset.stepText = loaded.get(f); used.add(f); changed.set(parsed,(changed.get(parsed)||0)+1); }
    }
    for (const [parsed,n] of changed) AtriumIO.modelNotes(parsed,n);
    for (const f of assets) fidelity.add("STEP model",used.has(f)?"kept":"dropped",{file:fileName(f)},
      used.has(f) ? undefined : "No unique, readable selected asset matched a board or footprint body.");
  }
  function rules(model, use, results, files, fidelity) {
    const summaries = [], defs = new Map(model.library.map(d => [d.id,d]));
    for (const [i,result] of results.entries()) for (const doc of result.documents || []) {
      if (!doc.sourceRules?.length) continue;
      const base = {document_id:doc.id, tool:"Altium", count:doc.sourceRules.length};
      const converted = use && AtriumImportRules.apply(doc,model,defs);
      const rows = converted ? converted.report : AtriumRules.sourceReport(doc.sourceRules, doc);
      for (const row of rows) {
        const status = !use || row.status === "source-only" ? "dropped" : row.status === "partial" ? "approximated" : "kept";
        const diagnostics=(row.scopeDiagnostics || []).map(d=>"Scope "+d.side+" ["+d.span.join(",")+"]. "+d.message);
        const reason=!use ? "Original rule retained in import data. The active rule book uses its existing rules." : row.reason;
        fidelity.add("Design rule",status,{file:fileName(files[i]),object:result.ruleRefs?.[row.record-1] || "Rules record " + row.record},
          [reason,...diagnostics].filter(Boolean).join(" ") || undefined);
      }
      summaries.push(converted ? {...base,applied:true,converted:converted.converted,report:rows,rule_types:converted.types,
        repoured_regions:converted.repoured,kept_pours:converted.kept||0} : {...base,applied:false,report:rows,
        note:"Checked against Waffle's default rules. Use the imported rules to apply the board's own constraints."});
    }
    return summaries;
  }
  function designImport(files, options, fidelity) {
    const sink = tracking(fidelity), assets = [], designs = [];
    const formats = new Map(files.map((f,i)=>[f,options.formats?.[i]]));
    const images=new Map(),imageFiles=new Map(),matched=new Set();
    for(const f of files){
      if(/^notebook-[0-9a-f]{64}\.png$/.test(f.name)){
        const digest=f.name.slice(9,-4);
        const meta=globalThis.AtriumSexpr?.pngInfo(f.bytes);
        if(!meta || AtriumSourceFile.sha256(f.bytes)!==digest)throw Error("The selected schematic image does not match its name.");
        let binary="";for(let p=0;p<f.bytes.length;p+=16384)binary+=String.fromCharCode(...f.bytes.subarray(p,p+16384));
        images.set(f.name,{src:"data:image/png;base64,"+btoa(binary),extent:[meta.width,meta.height]});imageFiles.set(f.name,f);continue;
      }
      (formats.get(f)==="step" || /\.(step|stp)$/i.test(f.name)?assets:designs).push(f);
    }
    const graphic=name=>{if(images.has(name))matched.add(name);return images.get(name);};
    if (!designs.length) throw Error("Choose a board or library with its referenced STEP models.");
    const entries = files.map(original), entry = new Map(files.map((f,i) => [f,entries[i]]));
    const provenance = {version:1,files:entries};
    const source = f => {
      const reporter=scope(sink,f);
      if(formats.get(f)==="easyeda")reporter.captureEasyEDA=omissions=>{const e=entry.get(f);e.easyeda={version:1,sha256:e.sha256,omissions};};
      return reporter;
    };
    if (designs.filter(f=>/\.prjpcb$/i.test(f.name)).length > 1 || designs.filter(f=>/\.kicad_pro$/i.test(f.name)).length > 1)
      throw Error("Choose one project manifest of each format at a time.");
    const libraryOrigins = new Map();
    const onlyAltium = designs.every(f => formats.get(f) === "altium" || !formats.get(f) && /\.(schdoc|pcbdoc|schlib|pcblib|prjpcb)$/i.test(f.name));
    // Altium reads file by file here. KiCad and the others report from readSet.
    const altiumRead = (f,i) => {
      options.progress?.({done:i,total:designs.length,name:fileName(f)});
      return AtriumIO.read(f.name,f.bytes,{fidelity:source(f),selectedImage:graphic});
    };
    const results = onlyAltium ? designs.map(altiumRead) :
      AtriumImportFormats.readSet(designs,{formatFor:f=>formats.get(f),fidelityFor:source,existing:options.existing,libraryOrigins,progress:options.progress});
    if (onlyAltium) options.progress?.({done:designs.length,total:designs.length,name:""});
    let all = results;
    if (onlyAltium && designs.every(f=>/\.(schlib|pcblib)$/i.test(f.name))) {
      const inputs = designs.map((f,i)=>({name:fileName(f),sha256:entry.get(f).sha256,library:results[i].library}));
      const paired = AtriumLibraryImportAltium.pair(inputs,{existing:options.existing});
      all = results.map((r,i)=>({...r,library:i?[]:paired.library,
        ...(i ? {} : {pairing:paired.report,notes:[...r.notes,...paired.report.notes]})}));
    }
    const unscoped = all;
    all = AtriumAltiumIds.distinct(unscoped);
    // Same-named source files may live in different selected folders. The collision resolver
    // deliberately re-keys the second document; keep each record attached to that final object.
    all.forEach((r,i)=>{
      if (r === unscoped[i]) return;
      r.documents?.forEach((d,j)=>d.items.forEach((item,k)=>sink.remap(unscoped[i].documents[j].items[k],item)));
    });
    attachModels(all,designs,assets,sink);
    for(const [name,f] of imageFiles)fidelity.add("Schematic PNG companion",matched.has(name)?"kept":"dropped",{file:fileName(f)},
      matched.has(name)?"A selected schematic references these verified pixels.":"No selected schematic references this image.");
    const manifestIndex = all.findIndex(r => r.manifest);
    const manifestFile = designs[manifestIndex];
    const manifest = manifestFile && AtriumImportLink.manifestScope(all[manifestIndex], manifestFile.bytes, (status, reason) =>
      sink.add("Net identifier scope", status, {file:fileName(manifestFile),object:"Design/HierarchyMode"}, reason)).manifest;
    const docs = all.flatMap(r => r.documents || []), libs = all.flatMap(r => r.library || []);
    if (!docs.length && !libs.length && !all.some(r => r.pairing?.skipped)) throw Error(manifest ? "Select the project together with its referenced documents: " + manifest.paths.join(", ") : "No supported documents or library entries were found.");
    const p = A().project(String(options.name || manifest?.name || AtriumImportFormats.stem(designs[0].name)));
    p.documents = docs; p.library = libs;
    if (manifest) {
      provenance.manifest = manifest;
      for (const d of docs) d.sourceProject = manifest.name;
      if (manifest.drillPlots?.length) p.sourceDrillPlots = manifest.drillPlots;
      if (manifest.parameters) p.parameters = {...manifest.parameters};
    }
    const notes = [], libraryMembers = new Map(entries.map(e=>[e,new Set()])), sourceMatches = new Map();
    for (const [i,r] of all.entries()) {
      const f = designs[i], e = entry.get(f);
      for (const [j,doc] of (r.documents || []).entries()) {
        e.documents.push(doc.id);
        const rules = globalThis.AtriumImportFormats?.sourceClassDefaults?.(unscoped[i].documents[j]);
        if (rules) (provenance.classRuleDefaults ||= []).push({documentId:doc.id,rules});
        sink.add(doc.kind === "pcb" ? "PCB document" : "Schematic document","kept",{file:fileName(f),object:doc.name});
      }
      for (const def of r.library || []) {
        // A paired definition belongs to both source library files even when the pairer returned
        // its complete library on the first result.
        const origins = libraryOrigins.get(def.id) || [def.source,def.source?.footprint].filter(o=>o?.file);
        if (!origins.length) { libraryMembers.get(e).add(def.id); continue; }
        for (const origin of origins) {
          const path = origin.path || origin.file || origin.name;
          const key = JSON.stringify([origin.sha256,path,origin.name]);
          let candidates = sourceMatches.get(key);
          if (!candidates) {
            const same = entries.filter(x => !origin.sha256 || x.sha256 === origin.sha256);
            const exact = same.filter(x=>fileName(x) === path);
            candidates = exact.length ? exact : same.filter(x=>x.name === path || x.name === origin.name);
            sourceMatches.set(key,candidates);
          }
          if (candidates.length === 1) {
            libraryMembers.get(candidates[0]).add(def.id);
          } else if (candidates.length) {
            (provenance.libraryAlternatives ||= []).push({id:def.id,member:path,files:candidates.map(fileName)});
          }
        }
      }
      const libraryRules = new Map((r.libraryRules || []).map(rule=>[rule.note,rule]));
      for (const [index,n] of (r.notes || []).entries()) {
        const prefix = fileName(f) + " — ", rule = libraryRules.get(index);
        const line = prefix + (rule ? rule.prefix+" ["+rule.source+"]" : n);
        if (rule) (provenance.libraryRules ||= []).push({source:{file:fileName(f),object:rule.source},sha256:e.sha256,
          summary:line,prefix:prefix+rule.prefix,text:rule.text});
        notes.push(line); sink.note(line);
      }
      if (r.pairing) provenance.pairing = r.pairing;
    }
    for (const [e,ids] of libraryMembers) e.library = [...ids];
    AtriumPCB.addProfileJobs(p,manifest);
    P().adoptIdentities(p, provenance, options.identityBindings);
    const linked = AtriumImportLink.reconcile(p, docs, manifest?.netScope);
    // Altium's per-sheet component classes that equal the classes Waffle generates from the linked sheets.
    for (const {board, note} of AtriumImportLink.settleComponentClasses(p, docs) || []) {
      const line = (board.sourceName || board.name) + " — " + note; notes.push(line); sink.note(line);
    }
    notes.unshift(...linked.notes);
    notes.push(...(p.importNotes || []));
    if (manifest) {
      // Folder and browser selections can provide exact paths. A flat selection can match a
      // basename only when the file and the requested basename are each unambiguous.
      const key = n => n.replace(/\\/g,"/").normalize("NFC").toLowerCase();
      const base = n => key(n).split("/").pop();
      const refs = [...manifest.paths,...(manifest.modelPaths || [])];
      const counts = new Map();
      for (const ref of refs) counts.set(base(ref),(counts.get(base(ref))||0)+1);
      const exact = new Map(), flat = new Map();
      for (const f of files) { const map = f.path ? exact : flat, k = f.path ? key(f.path) : base(f.name); map.set(k,(map.get(k)||0)+1); }
      for (const ref of refs) {
        const found = exact.get(key(ref)) === 1 || !exact.has(key(ref)) && counts.get(base(ref)) === 1 && flat.get(base(ref)) === 1;
        sink.add("Project member",found?"kept":"dropped",{file:fileName(manifestFile),object:ref},found ? undefined : "Referenced file was not in the selection.");
        if (!found) notes.push("Referenced file could not be opened: " + ref);
      }
    }
    provenance.sourceRules = rules(p, options.source_rules === "use", all, designs, sink);
    p.importNotes = provenance.notes = [...new Set(notes)];
    validate(p);
    sink.finish();
    // Verify source-filled polygons while the raw board and its source rules can
    // still be compared with the importer’s original whole-board signature.
    globalThis.AtriumPolygonPour?.adoptSourceCopper(p);
    P().separate(p,provenance);
    return {model:p,provenance};
  }
  const design = {import:designImport};
  return Object.freeze({altium:design,kicad:design,eagle:design,easyeda:design});
})();
