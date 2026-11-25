"use strict";
// Only the 1.x compatibility boundary restores source records. Object IDs survive edits and
// reordering; removing a placed part or a document must never resurrect it on export.
globalThis.AtriumTranslatorProvenance = (() => {
  const fields = {
    project: ["sourceDrillPlots"],
    document: ["sourceName", "sourceEncoding", "sourceSha256", "sourceProject", "sourceRules", "sourceRuleChecks", "sourceRuleLayers", "sourceClasses", "kicadUuid", "kicadInstances", "kicadInstanceList"],
    item: ["sourceRecord", "sourcePourOver", "schSource", "altiumSourceId", "kicadSourceId", "kicadPath", "kicadPaths", "kicadUuid"],
    library: ["sourceName", "source"]
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  const referenceFields = new Set(["id", "def", "defId", "sheet", "sheetId", "docId", "documentId", "document_id",
    "entryDocument", "projectId", "itemId", "objectId", "partId", "entityId", "signalId", "parameterId", "blockId",
    "board", "part", "room", "polygon", "sourcePour", "sourceTrack", "targetId", "parentId"]);
  const referenceLists = new Set(["boards", "exceptBoards", "links", "members", "objectIds", "partIds", "sourceIds"]);
  const referenceTables = new Set(["instanceRefs", "pourSignatures", "items", "definitions", "parts"]);
  const vendorFields = new Set(["source", "schSource", "sourceRules", "sourceRuleChecks", "sourceClasses", "sourceDrillPlots", "kicadPaths",
    "kicadInstances", "kicadInstanceList"]);

  function rebindReferences(value, ids) {
    const seen = new WeakSet(), replace = id => ids.get(id) ?? id;
    const instance = value => value.split("/").map(part => {
      const delimiter = part.lastIndexOf("#");
      return delimiter < 0 ? replace(part) : replace(part.slice(0, delimiter)) + part.slice(delimiter);
    }).join("/");
    const channelLink = value => {
      const delimiter = value.lastIndexOf("@");
      return delimiter < 0 ? replace(value) : replace(value.slice(0, delimiter)) + "@" + instance(value.slice(delimiter + 1));
    };
    function visit(node, field) {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const [index, child] of node.entries()) {
          if (typeof child === "string" && referenceLists.has(field)) node[index] = replace(child);
          else visit(child);
        }
        return;
      }
      const keys = Object.keys(node);
      if (referenceTables.has(field)) {
        const changes = keys.filter(key => ids.has(key)).map(key => [key, replace(key), node[key]]);
        for (const [key] of changes) delete node[key];
        for (const [, key, child] of changes) node[key] = child;
      }
      for (const [name, child] of Object.entries(node)) {
        if (vendorFields.has(name)) continue;
        if (typeof child !== "string") visit(child, name);
        else if (referenceFields.has(name)) node[name] = replace(child);
        else if (name === "instanceId" || name === "channel") node[name] = instance(child);
        else if (name === "link") node[name] = channelLink(child);
      }
    }
    visit(value);
  }

  // Keep the source key separate from the time-ordered native UUID. Ordinal
  // addresses are scoped to exact bytes, so a reordered revision cannot inherit
  // identities just because it has the same number of objects.
  function adoptIdentities(project, provenance, prior) {
    const UUID = globalThis.AtriumUUID;
    const files = provenance.files.filter(file => file.documents.length || file.library.length);
    const fileName = file => file.path || file.name;
    const encoder = new TextEncoder(), scopes = new Map();
    const digest = value => {
      const text = JSON.stringify(value);
      if (!scopes.has(text)) scopes.set(text, AtriumSourceFile.sha256(encoder.encode(text)));
      return scopes.get(text);
    };
    const inputDigest = group => digest(group.map(file => JSON.stringify([fileName(file), file.sha256])).sort());
    const exact = inputDigest(files.length ? files : provenance.files);
    const docs = new Map(), libraries = new Map();
    for (const file of files) {
      for (const id of file.documents) {
        if (!docs.has(id)) docs.set(id, []);
        docs.get(id).push(file);
      }
      for (const id of file.library) {
        if (!libraries.has(id)) libraries.set(id, []);
        libraries.get(id).push(file);
      }
    }
    const proposed = [], take = (owner, stable, fallback) => proposed.push({
      owner, stable: stable && JSON.stringify(stable), fallback: JSON.stringify(fallback)
    });
    const names = list => list.map(fileName).sort();
    take(project, ["project", digest(names(files))], ["project", exact]);
    const boardScopes = new Map();
    for (const [index, doc] of project.documents.entries()) {
      const source = docs.get(doc.id) || [], title = [doc.kind, doc.sourceName || doc.name];
      const fileScope = digest([names(source), ...title]);
      const location = source.length ? inputDigest(source) : exact;
      const address = digest([location, ...title, index]);
      if (doc.kind === "pcb") boardScopes.set(doc.id, fileScope);
      take(doc, source.length && ["document", fileScope, doc.kicadUuid || ""], ["document", address]);
      for (const [ordinal, item] of (doc.items || []).entries()) {
        const altium = /^a[uc]-[a-z0-9]+$/.test(item.id || "") ? item.id : null;
        const vendor = item.kicadSourceId || altium;
        take(item, vendor && ["item", fileScope, item.kind, vendor],
          ["item", address, item.kind, ordinal]);
      }
    }
    for (const [index, definition] of project.library.entries()) {
      const source = libraries.get(definition.id) || [], location = source.length ? inputDigest(source) : exact;
      const altium = /^a[uc]-[a-z0-9]+$/.test(definition.id || "") ? definition.id : null;
      const origin = definition.source, member = origin?.member || origin?.libref || altium;
      take(definition, member && ["library", digest(names(source)), member], ["library", location, index]);
    }
    // The compatibility view uses stable scratch signal IDs. Assign native IDs
    // only when a foreign design actually adopts those signals.
    const generated = !project.signals && project.documents.some(doc => doc.sourceClasses?.length);
    if (generated) project.signals = clone(AtriumSignals.fromLegacy(project));
    for (const [index, signal] of (project.signals?.signals ?? []).entries()) {
      const scope = (signal.boards ?? [...boardScopes.keys()]).map(id => boardScopes.get(id) ?? id).sort();
      take(signal, ["signal", digest(scope), signal.kind, signal.name], ["signal", exact, index]);
    }
    const counts = new Map();
    const previous = new Map(), priorIds = new Set();
    for (const row of (Array.isArray(prior) ? prior : [])) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || !UUID.isV7(row[1])) continue;
      if (previous.has(row[0]) || priorIds.has(row[1])) throw Error("Duplicate retained import identity.");
      previous.set(row[0], row[1]);
      priorIds.add(row[1]);
    }
    // An output identity is scoped to its job. Different boards can both
    // contribute an imported profile carrying the same source option name.
    for (const [index, job] of (project.outputJobs ?? []).entries()) {
      const scope = boardScopes.get(job.board);
      take(job, ["outputJob", scope, job.name], ["outputJob", exact, index]);
      for (const [ordinal, output] of job.outputs.entries()) {
        const name = output.id;
        delete output.id;
        take(output, ["output", scope, job.name, name], ["output", exact, index, ordinal]);
      }
    }
    for (const {stable} of proposed) if (stable) counts.set(stable, (counts.get(stable) || 0) + 1);
    const ids = new Map(), priorOwners = new Set(), used = new Set(), identityBindings = [];
    for (const {owner} of proposed) {
      if (!owner.id) continue;
      if (priorOwners.has(owner.id)) throw Error("Duplicate identity in translated design.");
      priorOwners.add(owner.id);
    }
    for (const {owner, stable, fallback} of proposed) {
      const key = counts.get(stable) === 1 ? stable : fallback;
      const old = owner.id, known = previous.get(key);
      let next = known || (UUID.isV7(old) ? old : UUID.next());
      if (used.has(next) || next !== old && priorOwners.has(next)) next = UUID.next();
      used.add(next);
      identityBindings.push([key, next]);
      if (old && old !== next) ids.set(old, next);
      else if (!old) owner.id = next;
    }
    if (ids.size) {
      // Source copper signatures can contain polygon IDs or scoped rules. Only a
      // signature verified before rebinding can be reissued for the same geometry.
      const pours = globalThis.AtriumPCBPours;
      const defs = new Map(project.library.map(def => [def.id, def]));
      const signed = pours ? project.documents.filter(doc =>
        doc.kind === "pcb" && pours.matchesSignature(doc, defs, project)) : [];
      rebindReferences(project, ids);
      if (signed.length) {
        const updated = new Map(project.library.map(def => [def.id, def]));
        for (const doc of signed) pours.storeSignature(doc, updated, project);
      }
      for (const file of provenance.files) {
        file.documents = file.documents.map(id => ids.get(id) ?? id);
        file.library = file.library.map(id => ids.get(id) ?? id);
      }
      for (const row of provenance.classRuleDefaults || []) row.documentId = ids.get(row.documentId) ?? row.documentId;
      for (const row of provenance.libraryAlternatives || []) row.id = ids.get(row.id) ?? row.id;
    }
    provenance.identityBindings = identityBindings;
    if (generated) provenance.generatedSignals = clone(project.signals);
  }
  function owners(p, visit) {
    visit("project", "", p);
    for (const d of p.documents || []) {
      visit("document", d.id, d);
      for (const i of d.items || []) visit("item", i.id, i);
    }
    for (const d of p.library || []) visit("library", d.id, d);
  }
  function schematicSourceKey(item) {
    const k = item.schSource;
    return Number.isInteger(k?.record) && typeof k.role === "string" ? k.record+":"+k.role : null;
  }
  function importedSheetSettings(name) {
    return /\.schdoc$/i.test(name) ? {sheetOrigin:"bottom-left",netNaming:"first-pin"} : {sheetOrigin:"bottom-left"};
  }
  // Component holes are identified in footprint coordinates, so moving or rotating
  // their original placed part retains its artwork. A new placement has a different ID.
  function drillKey(item, parent) {
    const kind=item.kind || "pad";
    return JSON.stringify(parent ? [parent.id,parent.def,kind,item.id || "",String(item.number ?? ""),
      Math.round(item.x*1e6),Math.round(item.y*1e6)] : [item.id,kind]);
  }
  function visitDrills(doc, defs, visit) {
    for (const item of doc.items || []) {
      if (item.kind==="pad" || item.kind==="via") visit(item,null);
      if (item.kind==="part") for (const pad of defs.get(item.def)?.footprint?.pads || []) visit(pad,item);
    }
  }
  function drillDrawingSize(project, doc) {
    const boards=project.documents.filter(d=>d.kind==="pcb");
    const basename=d=>(d.sourceName || "").split(/[\\/]/).pop().toLowerCase();
    const name=basename(doc), plots=(Array.isArray(project.sourceDrillPlots)?project.sourceDrillPlots:[]).filter(p=>p && (p.board ? p.board===name : boards.length===1));
    if (!plots.length) return 1.27;
    const size=plots[0].size;
    return boards.filter(d=>basename(d)===name).length===1 && plots.every(p=>p.size===size) ? size : null;
  }
  function retainDrillDrawings(project, provenance) {
    const boards=project.documents.filter(d=>d.kind==="pcb" && d.sourceDrillDrawing?.tools?.length);
    if (!boards.length) return;
    const defs=new Map(project.library.map(d=>[d.id,d])), captured=new Set();
    for (const doc of boards) {
      const marks=[];
      visitDrills(doc,defs,(hole,parent)=>{
        if (Number.isInteger(hole.sourceDrillTool) && hole.sourceDrillTool>=0) {
          marks.push([drillKey(hole,parent),hole.sourceDrillTool]);
          captured.add(hole);
        }
      });
      if (marks.length) {
        const drawings=(provenance.drillDrawings || []).filter(d=>d.documentId!==doc.id);
        provenance.drillDrawings=[...drawings,{documentId:doc.id,size:drillDrawingSize(project,doc),marks}];
      }
    }
    // A shared footprint can occur on more than one board.
    for (const hole of captured) delete hole.sourceDrillTool;
  }
  function drillDrawing(groups, documentId) {
    const found=(Array.isArray(groups)?groups:[groups]).flatMap(g=>
      Array.isArray(g?.drillDrawings) ? g.drillDrawings.filter(d=>d?.documentId===documentId) : []);
    if (!found.length) return;
    if (found.length!==1 || !Array.isArray(found[0].marks)) return {size:null,tool:()=>undefined};
    const marks=new Map();
    for (const row of found[0].marks) {
      if (!Array.isArray(row) || typeof row[0]!=="string" || !Number.isInteger(row[1]) || row[1]<0) continue;
      // Repeated indistinguishable lands have no safe individually addressable mark.
      marks.set(row[0],marks.has(row[0])?undefined:row[1]);
    }
    return {size:found[0].size,tool:(hole,parent)=>marks.get(drillKey(hole,parent))};
  }
  function separate(p, provenance) {
    const stored = [];
    retainDrillDrawings(p,provenance);
    // Classes, differential pairs and signal paths remain usable without the source record text.
    if (!p.signals && p.documents.some(d => d.sourceClasses?.length)) {
      p.signals = AtriumSignals.fromLegacy(p);
      provenance.generatedSignals = clone(p.signals);
    }
    for (const tag of p.signals?.tags || []) if (tag.altium) {
      (provenance.signalTags ||= []).push({name:tag.name,source:tag.altium});
      delete tag.altium;
    }
    // Typed appearance geometry remains editable. Annotation ownership no longer depends on a
    // compound-file row number, and the chosen schematic page origin and net naming stay intact.
    for (const d of p.documents) {
      if (d.kind === "schematic" && d.sourceName) {
        for (const [key,value] of Object.entries(importedSheetSettings(d.sourceName))) {
          if (key === "sheetOrigin" && d.sheetOrigin === "top-left") continue;
          if (Object.hasOwn(d,key)) (provenance.existingSheetSettings ||= []).push({id:d.id,key,value:d[key]});
          d[key] = value;
        }
      }
      if (d.schRestored?.items) {
        const external = new Map(Object.entries(d.schRestored.items)), native = new Map(), used = new Set();
        for (const item of d.items) {
          const ref = schematicSourceKey(item);
          if (external.has(item.id)) {
            native.set(item.id,external.get(item.id)); used.add(item.id);
            if (ref) (provenance.nativeSheetStyles ||= []).push(item.id);
          } else if (ref && external.has(ref)) { native.set(item.id,external.get(ref)); used.add(ref); }
        }
        for (const k of used) external.delete(k);
        if (external.size) (provenance.unplacedSheetStyles ||= []).push({documentId:d.id,rows:Object.fromEntries(external)});
        d.schRestored.items = Object.fromEntries(native);
      }
      if (!d.pcbDrawing?.annotations) continue;
      for (const i of d.items) if (i.kind === "part" && /^components6?\/data#\d+$/.test(i.sourceRecord || "")) {
        if (Array.isArray(i.boardLabels)) {
          (provenance.nativeBoardLabels ||= []).push(i.id);
          continue;
        }
        const labels = d.pcbDrawing.annotations[i.sourceRecord];
        if (labels && !labels.length) (provenance.emptyBoardLabels ||= []).push(i.id);
        i.boardLabels = labels || [];
        delete d.pcbDrawing.annotations[i.sourceRecord];
      }
      if (Object.keys(d.pcbDrawing.annotations).length) {
        (provenance.unplacedBoardLabels ||= []).push({documentId:d.id,rows:d.pcbDrawing.annotations});
        d.pcbDrawing.annotations = {};
      }
    }
    owners(p, (type, id, owner) => {
      const bodies = type === "library" ? owner.footprint?.bodies3d : owner.bodies3d;
      // 1.x requires a body identity string. Preserve that native identity contract with an
      // owner-local key; physical contour, placement, material and referenced model stay editable.
      for (const [i,b] of (Array.isArray(bodies) ? bodies : []).entries()) {
        if (!b || typeof b.sourceRecord !== "string" || !/\/data#\d+$/i.test(b.sourceRecord)) continue;
        const token = "body/" + id + "/" + i;
        (provenance.bodies ||= []).push({type,id,token,record:b.sourceRecord,...(b.shapeRecord ? {shape:b.shapeRecord} : {})});
        if (b.modelId === b.sourceRecord) b.modelId = token;
        b.sourceRecord = token;
        delete b.shapeRecord;
      }
      if (type === "document" && typeof owner.mcad?.enclosure?.text === "string") {
        const e = owner.mcad.enclosure;
        (provenance.embeddedEnclosures ||= []).push({documentId:id,name:e.name,digest:e.digest,text:e.text});
        delete e.text;
      }
      const values = {};
      for (const key of fields[type]) if (Object.hasOwn(owner, key)) {
        values[key] = owner[key];
        delete owner[key];
      }
      if (Object.keys(values).length) stored.push({type, id, values});
    });
    if (p.atriumCompat) {
      // Keep user-facing compatibility state in the model; the unrecognised records themselves
      // belong to provenance. forSave receives the entire original compatibility envelope.
      provenance.compatibility = p.atriumCompat;
      p.atriumCompat = Object.fromEntries(["newer","readOnly","compatible","lossless","backup","from"]
        .filter(k=>Object.hasOwn(provenance.compatibility,k)).map(k=>[k,provenance.compatibility[k]]));
    }
    provenance.fields = stored;
    return p;
  }
  function toLegacy(model, provenance, {keepSignals = false} = {}) {
    const p = clone(model);
    const groups = (Array.isArray(provenance) ? provenance : [provenance]).filter(Boolean);
    if (!groups.length) return p;
    const byId = new Map();
    owners(p, (type, id, owner) => byId.set(type + "/" + id, owner));
    // Old 1.x writers stored standalone library constraints in project import notes.
    // Restore them only where their corresponding note still exists in the edited copy.
    const libraryNotes = new Map();
    for (const g of groups) for (const r of g.libraryRules || []) {
      if (!libraryNotes.has(r.summary)) libraryNotes.set(r.summary,new Set());
      libraryNotes.get(r.summary).add(r.prefix+" "+r.text);
    }
    if (libraryNotes.size && Array.isArray(p.importNotes)) {
      p.importNotes = p.importNotes.flatMap(n=>libraryNotes.has(n)?[...libraryNotes.get(n)]:[n]);
    }
    for (const group of groups) {
      for (const row of group.embeddedEnclosures || []) {
        const e = byId.get("document/" + row.documentId)?.mcad?.enclosure;
        if (e && e.name === row.name && e.digest === row.digest && e.text == null) e.text = row.text;
      }
      const enc = group.enclosure;
      if (enc) {
        const e = byId.get("document/" + enc.documentId)?.mcad?.enclosure;
        const files = (group.files || []).filter(f => f.name === enc.file || f.path === enc.file);
        const f = files.length === 1 && files[0];
        if (e && e.digest === enc.digest && e.text == null && f?.bytes && f.bytes.length <= 8 * 1048576) {
          const text = new TextDecoder().decode(f.bytes);
          if (text.length <= 2 * 1048576 && (!globalThis.AtriumSourceFile || AtriumSourceFile.sha256(f.bytes) === f.sha256)
            && (!globalThis.AtriumMCADStep || AtriumMCADStep.digest(text) === e.digest)) e.text = text;
        }
      }
      // Lookup is linear even when a board owns tens of thousands of bodies.
      const originals = new Map((group.bodies || []).map(r => [r.token,r]));
      if (originals.size) owners(p,(type,id,owner) => {
        const bodies = type === "library" ? owner.footprint?.bodies3d : owner.bodies3d;
        for (const b of bodies || []) {
          const r = originals.get(b.sourceRecord);
          if (!r || r.type !== type || r.id !== id) continue;
          if (b.modelId === b.sourceRecord) b.modelId = r.record;
          b.sourceRecord = r.record;
          if (r.shape) b.shapeRecord = r.shape;
        }
      });
      if (group.compatibility && p.atriumCompat) p.atriumCompat = {...clone(group.compatibility), ...p.atriumCompat};
      for (const row of group.fields || []) {
        const owner = byId.get(row.type + "/" + row.id);
        if (!owner || !Object.hasOwn(fields, row.type)) continue;
        if (row.type === "document" && Object.hasOwn(row.values,"appliedSourceRuleRecords") && !Object.hasOwn(owner,"appliedSourceRuleRecords")) {
          owner.appliedSourceRuleRecords = clone(row.values.appliedSourceRuleRecords);
        }
        for (const key of fields[row.type]) if (Object.hasOwn(row.values, key) && !Object.hasOwn(owner, key)) {
          owner[key] = clone(row.values[key]);
        }
      }
      const tags = new Map((p.signals?.tags || []).map(t=>[t.name,t]));
      for (const r of group.signalTags || []) {
        const t = tags.get(r.name);
        if (t && !Object.hasOwn(t,"altium")) t.altium = clone(r.source);
      }
      for (const r of group.unplacedBoardLabels || []) {
        const d = byId.get("document/"+r.documentId);
        if (d?.pcbDrawing) for (const [ref,rows] of Object.entries(r.rows)) {
          if (/^components6?\/data#\d+$/.test(ref) && !Object.hasOwn(d.pcbDrawing.annotations,ref)) d.pcbDrawing.annotations[ref] = clone(rows);
        }
      }
      if (!keepSignals && group.generatedSignals && JSON.stringify(p.signals) === JSON.stringify(group.generatedSignals)) delete p.signals;
    }
    if (groups.some(group=>group.drillDrawings?.length)) {
      const defs=new Map(p.library.map(d=>[d.id,d]));
      for (const doc of p.documents.filter(d=>d.kind==="pcb")) {
        const retained=drillDrawing(groups,doc.id);
        if (retained) visitDrills(doc,defs,(hole,parent)=>{
          const tool=retained.tool(hole,parent);
          if (tool!==undefined) hole.sourceDrillTool=tool;
        });
      }
    }
    const nativeSheetStyles = new Set(groups.flatMap(g=>g.nativeSheetStyles || []));
    const nativeBoardLabels = new Set(groups.flatMap(g=>g.nativeBoardLabels || []));
    const emptyBoardLabels = new Set(groups.flatMap(g=>g.emptyBoardLabels || []));
    const originalSettings = new Map(groups.flatMap(g=>(g.existingSheetSettings || []).map(row=>[row.id+"/"+row.key,row.value])));
    for (const d of p.documents || []) {
      if (d.schRestored?.items) {
        const native = new Map(Object.entries(d.schRestored.items)), legacy = new Map();
        for (const group of groups) for (const r of group.unplacedSheetStyles || []) {
          if (r.documentId === d.id) for (const [key,style] of Object.entries(r.rows)) legacy.set(key,clone(style));
        }
        for (const item of d.items) if (native.has(item.id)) {
          const key = nativeSheetStyles.has(item.id) ? item.id : schematicSourceKey(item) || item.id;
          legacy.set(key,native.get(item.id)); native.delete(item.id);
        }
        d.schRestored.items = Object.fromEntries([...native,...legacy]);
      }
      if (d.kind === "schematic" && d.sourceName) {
        for (const [key,value] of Object.entries(importedSheetSettings(d.sourceName))) if (d[key] === value) {
          const field = d.id+"/"+key;
          if (originalSettings.has(field)) d[key] = clone(originalSettings.get(field));
          else delete d[key];
        }
      }
      for (const i of d.items || []) if (i.boardLabels && !nativeBoardLabels.has(i.id) && d.pcbDrawing && /^components6?\/data#\d+$/.test(i.sourceRecord || "")) {
        if (i.boardLabels.length || emptyBoardLabels.has(i.id)) d.pcbDrawing.annotations[i.sourceRecord] = i.boardLabels;
        delete i.boardLabels;
      }
    }
    return p;
  }
  // A native UUID identifies the editable rule. The default key identifies
  // the source template that was materialized into that rule.
  function defaultRuleKeys(project) {
    return new Map((project.rules?.list || []).filter(r=>r.origin?.kind==="default").map(r=>[r.id,r.origin.key]));
  }
  function usedRule(project, provenance) {
    const R = globalThis.AtriumRules;
    if (!R) return () => true;
    // Migrate/normalise materialises the complete Waffle rule book even for one bare track.
    // Compare the complete rule, including its identity, name, scope, priority and options.
    const signature = r => JSON.stringify(r,(_,v)=>v && typeof v==="object" && !Array.isArray(v) ?
      Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
    const defaults = R.migrate(null).list, stock = new Map(defaults.map(r=>[r.id,signature(r)]));
    const fromClass = new Map();
    for (const g of Array.isArray(provenance) ? provenance : [provenance]) for (const item of g?.classRuleDefaults || []) {
      const bound = new Map();
      for (const r of item.rules || []) {
        if (r.explicit === false && r.baseline) {
          bound.set(r.id, signature(r.baseline));
          continue;
        }
        const baseline = defaults.find(d=>d.type===r.type && R.kit.allScope(d.scope));
        if (baseline && Object.hasOwn(baseline,r.field)) bound.set(r.id,r.explicit ? null :
          signature({...baseline,id:r.id,priority:r.priority,[r.field]:r.value}));
      }
      fromClass.set(item.documentId,bound);
    }
    const records = project.rules?.list || [];
    const adopted = new Set(records.filter(r=>r.origin?.kind==="import").map(r=>r.origin.board+"/"+r.id));
    const materialized = defaultRuleKeys(project);
    return (doc,r) => {
      if (adopted.has(doc.id+"/"+r.id)) return true;
      const id = materialized.get(r.id) || r.id, bound = fromClass.get(doc.id);
      const current = signature(id === r.id ? r : {...r,id});
      if (bound?.has(id)) return bound.get(id)!==current;
      return stock.get(id)!==current;
    };
  }
  return Object.freeze({adoptIdentities, separate, toLegacy, schematicSourceKey, drillDrawing, usedRule, defaultRuleKeys});
})();
