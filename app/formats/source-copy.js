"use strict";

// Plan against the exact original file. A Waffle project stores the source digest and
// record identities, so unknown Altium data need never be reconstructed from the editor.
globalThis.AtriumSourceCopy = (() => {
  const tickTolerance = 0.00000131; // Half an Altium coordinate tick, in millimetres, plus round-off.
  // Net identifier scope comes from the project manifest, outside the binary sheet or board.
  const editorFields = new Set(["id", "name", "grid", "notes", "netScope", "sourceName", "sourceProject", "sourceSha256", "schRestored", "sourcePourSignature",
    "items", "rules", "appliedSourceRuleRecords", "ruleCheckSelection", "sourceRuleChecks"]);
  // Copper certification records Waffle's current fill inputs. The source geometry and
  // every editable polygon field remain independently checked against the original.
  const itemFields = new Set(["id", "link", "def", "sourceRecord", "schSource", "copperBasis"]);
  const definitionFields = new Set(["id"]);

  function equal(a, b, tolerance=0) {
    if (a===b) return true;
    if (typeof a==="number" && typeof b==="number") return Math.abs(a-b)<=tolerance || a===Atrium.projectNumber(b) || b===Atrium.projectNumber(a);
    if (!a || !b || typeof a!=="object" || typeof b!=="object" || Array.isArray(a)!==Array.isArray(b)) return false;
    // Project geometry is the circular primitive. A saved projection and a regenerated
    // projection can use different chord counts or differ by a native coordinate tick.
    const arcs=a.arc?.kind==="arc" && b.arc?.kind==="arc" && Atrium.pathArc(a) && Atrium.pathArc(b);
    const keys=Object.keys(a);
    return keys.length===Object.keys(b).length && keys.every(k=>Object.hasOwn(b,k) && (arcs && k==="points" || equal(a[k],b[k],tolerance)));
  }
  function without(obj, omitted) {return Object.fromEntries(Object.entries(obj).filter(([key])=>!omitted.has(key)));}
  // Compare the editor's current values with the actual native projection of the
  // selected binary. Only unchanged projected values may use the source spelling.
  function identical(a,b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key=>Object.hasOwn(b,key) && identical(a[key],b[key]));
  }
  function fromNative(original, stored, current) {
    if (stored === current) return original;
    if (original === undefined && identical(stored,current)) return undefined;
    if (stored == null || current == null || typeof stored !== "object" || typeof current !== "object" ||
        Array.isArray(stored) !== Array.isArray(current)) return current;
    if (Array.isArray(stored)) {
      if (!Array.isArray(original)) return current;
      // Rows with identities can be reordered independently of their source bytes.
      const byId = new Map(stored.flatMap((row,i)=>row?.id ? [[row.id,i]] : []));
      return current.map((row,i)=>{
        const n = row?.id ? byId.get(row.id) : i;
        return n === undefined || n >= stored.length ? row : fromNative(original[n],stored[n],row);
      });
    }
    const result = {...original};
    for (const key of Object.keys(stored)) if (!Object.hasOwn(current,key)) delete result[key];
    for (const key of Object.keys(current)) {
      const value = Object.hasOwn(stored,key) ? fromNative(original?.[key],stored[key],current[key]) : current[key];
      if (value === undefined) delete result[key];
      else if (key === "__proto__") Object.defineProperty(result,key,{value,writable:true,configurable:true,enumerable:true});
      else result[key] = value;
    }
    return result;
  }

  function sameProofs(rows, retained, owners) {
    const M = globalThis.AtriumFormat2Model;
    const key = row => JSON.stringify([row.owner,row.id,row.recordKind,row.property]);
    const proofs = new Map();
    for (const row of retained || []) {
      if (!owners.has(row.owner)) continue;
      const k = key(row);
      proofs.set(k,proofs.has(k) ? null : row);
    }
    return rows.every(row=>{
      if (!owners.has(row.owner)) return true;
      const proof = proofs.get(key(row));
      return !!M.restoreResidual({...row,value:row.nativeValue},proof) &&
        BigInt(row.numerator)*BigInt(proof.denominator) === BigInt(proof.numerator)*BigInt(row.denominator);
    });
  }

  function nativeSourceProjection(base, target, library, digest, groups, repoured) {
    const sources = Array.isArray(groups) ? groups : [groups];
    const candidates = sources.filter(group=>
      group?.files?.some(file=>file.sha256 === digest && file.documents?.includes(target.id)));
    if (!candidates.length) return {doc:target,library};
    const review = !target.sourceSha256;
    if (candidates.length !== 1 || !review && target.sourceSha256 !== digest) throw Error("The original has no unique retained binding for this document.");
    const group = candidates[0], M = globalThis.AtriumFormat2Model, P = globalThis.AtriumTranslatorProvenance;
    const originals = group.files.filter(file=>file.sha256 === digest && file.documents?.includes(target.id));
    if (originals.length !== 1) throw Error("The original has no unique retained binding for this document.");
    const libraryIds = new Set(originals[0].library || []);
    if (!M || !P) throw Error("The native source-copy projection is unavailable.");
    const bindings = new Map(), targetItems = new Map(target.items.map(item=>[item.id,item]));
    const explicit = sources.filter(g=>!g?.files && g?.fields?.some(field=>field.type === "document" &&
      field.id === target.id && field.values?.sourceSha256 === digest));
    for (const field of [group,...explicit].flatMap(g=>g.fields || [])) if (field.type === "item" && sourceKey(field.values)) {
      const key = sourceKey(field.values);
      const item = targetItems.get(field.id);
      if (!item) continue;
      const current = sourceKey(item);
      if (current && current !== key) throw Error("The Altium record binding changed. Recheck the original.");
      if (!current) targetItems.set(field.id,{...item,...(field.values.sourceRecord ?
        {sourceRecord:field.values.sourceRecord} : {schSource:field.values.schSource})});
      bindings.set(key,bindings.has(key) ? null : field.id);
    }
    target = {...target,items:target.items.map(item=>targetItems.get(item.id))};
    if (review && (target.items.length !== base.doc.items.length || target.items.some(sourceKey)))
      throw Error("This older import differs from the original. Link an unedited revision or reimport the original.");
    if (target.kind === "pcb") {
      const polygons = review ? target.items.map((item,i)=>({...item,sourceRecord:base.doc.items[i].sourceRecord})) : target.items;
      alignPolygons(base.doc,{...target,items:polygons});
    }
    const definitions = new Map();
    const items = base.doc.items.map((item,i)=>{
      // An unlinked import can only propose the existing all-fields, in-order review.
      // No matching decision is committed until the caller explicitly applies its receipt.
      const id = review ? target.items[i].id : bindings.get(sourceKey(item)), after = targetItems.get(id);
      if (!after) throw Error("An Altium source object was added, removed, or has no unique retained record.");
      if (item.kind !== "part") return {...item,id};
      if (definitions.has(item.def) && definitions.get(item.def) !== after.def) throw Error("The source library binding changed.");
      definitions.set(item.def,after.def);
      return {...item,id,def:after.def};
    });
    if ([...definitions.values()].some(id=>!libraryIds.has(id))) throw Error("The source library binding changed.");
    const original = {...base.doc,id:target.id,items};
    const defs = [...base.defs.values()].filter(def=>definitions.has(def.id)).map(def=>({...def,id:definitions.get(def.id)}));
    const source = {...Atrium.project("Source",defs),documents:[original],signals:{signals:[],tags:[]}};
    const provenance = {version:1}, separated = P.separate(Atrium.clone(source),provenance);
    const native = M.fromEditor({model:separated,provenance},{encodeModel:raw=>raw});
    // The writer adopted the verified source fill (links, signatures). Unchanged fields restore that adopted original.
    if (original.pcbDrawing?.sourceFill && globalThis.AtriumPolygonPour) {
      original.pcbDrawing = Atrium.clone(original.pcbDrawing);
      AtriumPolygonPour.adoptSourceCopper(source);
      // Signatures are not stored natively: keep them only where the working copy has them.
      for (const key of ["pourSignatures","pourSignatureVersion"]) if (!Object.hasOwn(target.pcbDrawing || {},key)) delete original.pcbDrawing[key];
    }
    const owners = new Set([target.id,...defs.map(def=>def.id)]);
    const scope = group.precision;
    const hasResiduals = native.residuals.some(row=>owners.has(row.owner));
    if (hasResiduals && scope && (scope.version !== 1 || !scope.scopeId ||
        !scope.documents?.includes(target.id) || !sameProofs(native.residuals,scope.rows,owners)))
      throw Error("The retained precision does not match the selected Altium source. No copy was written.");
    const {project, members} = M.manifest(native.manifest);
    const files = new Map(native.files.map(row=>[row.path,row.file]));
    for (const ref of members) {
      const file = files.get(ref.path);
      if (ref.kind === "library") project.library.push(Atrium.definitionGeometry(M.library(file)));
      else project.documents.push(M.document(file,{name:ref.name,nativeAssets:true}));
    }
    const stored = P.toLegacy(project,review ? group : provenance), currentDefs = refs(library), originalDefs=refs(defs), restoredDefs = new Map();
    // A loaded companion supplies STEP text on demand. Authenticate it against the
    // same model reference as the native writer before treating it as unchanged.
    const models = new Map(native.models.map(row=>[row.ref.sha256,row.raw]));
    function resolved(saved,current) {
      const entries = new Map((current.bodyModels || []).map(a=>[a.id,a]));
      for (const asset of saved.bodyModels || []) {
        const loaded = entries.get(asset.id), raw = models.get(asset.model?.sha256);
        if (raw && typeof loaded?.stepText === "string") {
          const text = new TextDecoder().decode(raw);
          if (loaded.stepText !== text) throw Error("The bodyModels field changed. Its STEP bytes differ from the selected original.");
          asset.stepText = text;
        }
      }
      return saved;
    }
    for (const def of stored.library) {
      const current = currentDefs.get(def.id);
      if (!current) continue;
      if (def.footprint && current.footprint) resolved(def.footprint,current.footprint);
      restoredDefs.set(def.id,fromNative(originalDefs.get(def.id),def,current));
    }
    // A repour can insert, remove or reorder regions. Compare only the retained
    // source contours in their original order when restoring their sub-nm coordinates.
    const doc = fromNative(withoutRepours(original,repoured),withoutRepours(resolved(stored.documents[0],target),repoured),
      withoutRepours(target,repoured));
    if (review) {
      delete doc.sourceSha256;
      for (const item of doc.items) { delete item.schSource; delete item.sourceRecord; }
    }
    const outputLibrary = library.map(d=>restoredDefs.get(d.id) || d);
    if (hasResiduals && !scope && (!identical(target,doc) || !identical(library,outputLibrary)))
      throw Error("The retained precision does not match the selected Altium source. No copy was written.");
    return {doc,library:outputLibrary};
  }
  function sourcePadProjection(pad,peer) {
    const stack=pad.padStack;
    if(pad.stackMode!=="tmb"||!stack||Object.keys(stack).length!==3||Object.hasOwn(peer,"padStack")||Object.hasOwn(peer,"stackMode"))return pad;
    // An earlier nominal land represents the source only when each copper face has that same land.
    const nominal={w:pad.w,h:pad.h,shape:pad.shape};
    if(!["Top","Mid","Bottom"].every(k=>equal(stack[k],nominal)))return pad;
    const {stackMode,padStack,...land}=pad;
    return land;
  }
  function sourceItemProjection(original,saved) {
    if(original.kind==="pad")return sourcePadProjection(original,saved);
    if(original.kind!=="polygon")return original;
    const optional=["sourcePourOver"];
    if(original.fillMode!=="hatched")optional.push("hatchPitch");
    if(!original.fillMode||original.fillMode==="solid")optional.push("hatchWidth");
    // Earlier imports lacked the source mode and the hatch settings unused by a solid polygon.
    const omitted=new Set(optional.filter(k=>Object.hasOwn(original,k)&&!Object.hasOwn(saved,k)));
    const shape=original.regionShape;
    if(omitted.has("sourcePourOver")&&shape?.source==="altium"&&shape.cutouts.length===0&&
        original.closed&&saved.closed&&!original.cutout&&!saved.cutout&&
        /^polygons6?\/data#\d+$/.test(original.sourceRecord||"")&&original.sourceRecord===saved.sourceRecord&&
        !Object.hasOwn(saved,"regionShape")&&equal(original.points,saved.points))omitted.add("regionShape");
    return omitted.size?without(original,omitted):original;
  }
  function sourceKey(item) {
    if (typeof item.sourceRecord==="string" && item.sourceRecord) return item.sourceRecord;
    const identity=item.schSource;
    if(identity && Number.isInteger(identity.record) && typeof identity.role==="string")return JSON.stringify([identity.record,identity.role]);
    return null;
  }
  function index(doc, additions=null) {
    const result=new Map();
    for (const i of doc.items) {
      const key=sourceKey(i);
      if (!key && additions && !Object.hasOwn(i,"schSource") && !Object.hasOwn(i,"sourceRecord") && (i.kind==="wire"||i.kind==="junction")){
        additions.push(i);continue;
      }
      if (!key) throw Error("The document contains a new or unlinked "+i.kind+". Added objects require KiCad or Waffle export.");
      if (result.has(key)) throw Error("Two objects claim the same Altium source record. The copy cannot be matched uniquely.");
      result.set(key,i);
    }
    return result;
  }
  const refs = defs => new Map(defs.map(d=>[d.id,d]));
  const describe = i => i.ref || (i.kind+" "+(i.sourceRecord || i.schSource?.record || i.id));
  function sourceFootprint(original,saved) {
    if(!original?.pads||!saved?.pads||original.pads.length!==saved.pads.length)return original;
    const pads=original.pads.map((pad,i)=>sourcePadProjection(pad,saved.pads[i]));
    return pads.some((pad,i)=>pad!==original.pads[i])?{...original,pads}:original;
  }
  function geometry(def,kind,peer) {
    return kind==="pcb"?sourceFootprint(def.footprint,peer?.footprint):{symbol:def.symbol,footprintName:def.footprintName};
  }
  function usedLibrary(doc,library) {
    const ids=new Set(doc.items.filter(i=>i.kind==="part").map(i=>i.def));return library.filter(d=>ids.has(d.id));
  }
  // The parser gives each editor object a fresh ID. Use the open board's polygon IDs when
  // comparing its stored Regions6 islands and polygon-owned tracks with a new source read.
  function alignPolygons(source,doc) {
    const polygons=doc.items.filter(i=>i.kind==="polygon");
    const records=new Map(polygons.filter(i=>i.sourceRecord).map(i=>[i.sourceRecord,i]));
    const ids=new Map(), legacyRecords=new Map();
    let position=0;
    for(const item of source.items)if(item.kind==="polygon"){
      let target=records.get(item.sourceRecord);
      const legacy=polygons[position++];
      // Older imports omitted the Polygons6 record key. Match the original polygon in
      // source order only when all of its editable fields are still identical.
      if(!target && legacy && !legacy.sourceRecord && equal(without(sourceItemProjection(item,legacy),itemFields),without(legacy,itemFields))){
        target=legacy;legacyRecords.set(legacy.id,item.sourceRecord);
      }
      if(target){ids.set(item.id,target.id);item.id=target.id;}
    }
    for(const i of source.items)if(ids.has(i.sourcePour))i.sourcePour=ids.get(i.sourcePour);
    for(const r of source.pcbDrawing?.pours||[])if(ids.has(r.polygon))r.polygon=ids.get(r.polygon);
    return legacyRecords;
  }
  function readSource(name,doc,bytes) {
    const file=AtriumSourceFile.open(bytes), streams=new Map();
    for (const path of file.paths()) streams.set(path.toLowerCase(),file.read(path));
    const kind=doc.kind, drawing=kind==="pcb"?doc.pcbDrawing:doc.schDrawing;
    const result=(kind==="pcb"?AtriumPCB:AtriumSCH).read(name,streams,null,{appearance:!!drawing,drillDrawing:!!doc.sourceDrillDrawing,textPlacement:drawing?.textPlacement||false,nativeText:!!drawing?.nativeText,legacyArcPaths:doc.sourceArcVersion!==1,locks:doc.sourceLockVersion===1,bodyGeometry:!!doc.bodyModelVersion});
    if (result.documents.length!==1) throw Error("The selected file does not contain one supported Altium document.");
    const source=result.documents[0];
    // Earlier Waffle saves had no imported origin. An absent override leaves
    // the original binary datum in place; a different explicit datum still fails verification.
    if(kind==="pcb"&&!Object.hasOwn(doc,"origin"))delete source.origin;
    return {file, streams, doc:source, defs:refs(result.library), legacyRecords:kind==="pcb"?alignPolygons(source,doc):null};
  }
  function verifiedNativeRepours(project, id) {
    const doc=project?.documents.find(d=>d.id===id), drawing=doc?.pcbDrawing, engine=globalThis.AtriumPolygonPour;
    if (!drawing || drawing.sourceFill || drawing.pourSignatures || !engine) return new Set();
    const retained=new Set((drawing.pours || []).filter(r=>Object.hasOwn(r,"source")).map(r=>r.polygon));
    const unverified=new Set(globalThis.AtriumPourMarker?.read(drawing));
    const owners=doc.items.filter(p=>p.kind==="polygon" && !p.cutout && !p.shelved && p.copperBasis && !retained.has(p.id) && !unverified.has(p.id));
    if (!owners.length) return new Set();
    const inputs=engine.polygonSignatures(doc,refs(project.library),{project});
    const bases=engine.copperBases(doc,inputs,owners.map(p=>p.id));
    return new Set(owners.filter(p=>{
      const b=bases.get(p.id);
      return b && b.inputs===p.copperBasis.inputs && b.contours===p.copperBasis.contours;
    }).map(p=>p.id));
  }
  function withoutRepours(doc,owners) {
    if (!owners.size || !doc.pcbDrawing?.pours) return doc;
    const pours=doc.pcbDrawing.pours.filter(r=>!owners.has(r.polygon) || Object.hasOwn(r,"source") && r.source!=="altium");
    return {...doc,pcbDrawing:{...doc.pcbDrawing,pours}};
  }
  function repouredOwners(original, edited) {
    const drawing=edited.pcbDrawing, signatures=drawing?.pourSignatures;
    if(!signatures || drawing.sourceFill || !Number.isInteger(drawing.pourSignatureVersion))return new Set();
    // The pour engine stamps each evaluated polygon, including one that produced no islands.
    // An owner still carrying any source artwork must keep all of its original regions.
    const retained=new Set((drawing.pours||[]).filter(r=>Object.hasOwn(r,"source")).map(r=>r.polygon));
    return new Set(original.items.filter(i=>i.kind==="polygon" && !i.cutout && !i.shelved &&
      Object.hasOwn(signatures,i.id) && typeof signatures[i.id]==="string" && !retained.has(i.id)).map(i=>i.id));
  }
  function sourceDrawing(drawing, hatch, repoured) {
    const marker=globalThis.AtriumPourMarker?.key(drawing);
    if(marker)drawing=without(drawing,new Set([marker]));
    const islands=drawing?.pours?.some(r=>r.polygon!=null && r.source==="altium");
    if(!drawing||!hatch&&!islands&&!repoured.size)return drawing;
    // Inspecting a board indexes the imported copper for connectivity. The index lives in
    // the editor, as do regenerated fills. The native copy retains those source streams,
    // while standalone geometry, polygon definitions and annotations are still checked.
    const {sourceFill,sourceHatchSignature,pourSignatures,pourSignatureVersion,...fields}=drawing;
    if(islands||repoured.size){
      const linkFields=new Set(["links"]);
      const pours=(drawing.pours||[]).filter(r=>!repoured.has(r.polygon) || (Object.hasOwn(r,"source") && r.source!=="altium"))
        .map(r=>r.polygon!=null && r.source==="altium"?without(r,linkFields):r);
      if(pours.length)fields.pours=pours;else delete fields.pours;
    }
    return fields;
  }
  function equalSourceDrawing(a,b) {
    if(!a?.pours||!b?.pours)return equal(a,b);
    const {pours:left,...af}=a,{pours:right,...bf}=b;
    if(left.length!==right.length||!equal(af,bf))return false;
    return left.every((r,n)=>{
      const s=right[n];
      if(r.source!=="altium"||s.source!=="altium"||r.subPolygonIndex!==undefined&&s.subPolygonIndex!==undefined)return equal(r,s);
      // Earlier imports omitted the source index while keeping the contour and its owner.
      const {subPolygonIndex:ri,...leftRegion}=r,{subPolygonIndex:si,...rightRegion}=s;
      return equal(leftRegion,rightRegion);
    });
  }
  function verifyDocument(before,after,storedRepours) {
    const hatch=before.pcbDrawing?.sourceHatchSignature!=null||after.pcbDrawing?.sourceHatchSignature!=null;
    const repoured=repouredOwners(before,after);
    for (const id of storedRepours || []) repoured.add(id);
    function modelDescriptors(models,peer) {
      if(!models)return models;
      const embedded=new Set(models.filter(a=>a.zlib).map(a=>a.id));
      const checksummed=new Set((peer||[]).filter(a=>a.checksum!=null).map(a=>a.id));
      return models.map(({stepText,assetId,checksum,...source})=>{
        if(assetId&&embedded.has(assetId))source.assetId=assetId;
        // Earlier Waffle imports kept the file and bytes without the native model checksum.
        if(checksum!=null&&checksummed.has(source.id))source.checksum=checksum;
        return source;
      });
    }
    for(const field of new Set([...Object.keys(before),...Object.keys(after)])){
      if(editorFields.has(field))continue;
      // A user-supplied companion STEP is a separate project member. The binary
      // board records its id and filename; its bytes do not belong to the PCB.
      const value=(d,other)=>field==="pcbDrawing"?sourceDrawing(d[field],hatch,repoured):field==="bodyModels"?
        modelDescriptors(d.bodyModels,other.bodyModels):d[field];
      const a=value(before,after),b=value(after,before);
      if(!(field==="pcbDrawing"?equalSourceDrawing(a,b):equal(a,b)))throw Error("The "+field+" field changed. It cannot be written to this Altium source format yet.");
    }
  }
  function assertDefinition(source,target,label) {
    const footprint=sourceFootprint(source?.footprint,target?.footprint);
    const projected=source?.footprint===footprint?source:{...source,footprint};
    if(!projected || !target || !equal(without(projected,definitionFields),without(target,definitionFields)))
      throw Error("The library definition for "+label+" differs from the source. Restore its source symbol or footprint, or export as KiCad.");
  }
  function verifyResult(doc,defs,reopened,appended,storedRepours) {
    verifyDocument(reopened.doc,doc,storedRepours);
    const keyed=index(reopened.doc);
    if(keyed.size!==doc.items.length)throw Error("Reopening the copy changed the number of projected objects.");
    for(const i of doc.items){
      const newRecord=appended?.get(i.id),actual=keyed.get(newRecord?sourceKey({schSource:newRecord}):sourceKey(i));
      // An object drawn in Waffle acquires the source sheet's wire/junction
      // styling on its first native export. A split wire keeps its own styling.
      const ignored=newRecord && !i.schPaint?new Set([...itemFields,"schPaint"]):itemFields;
      if(!actual || !equal(without(i,ignored),without(sourceItemProjection(actual,i),ignored),tickTolerance))throw Error("Reopening the copy did not reproduce "+describe(i)+". No file was written.");
      if(i.kind==="part"){
        const expected=defs.get(i.def),observed=reopened.defs.get(actual.def);
        if(!equal(geometry(expected,doc.kind),geometry(observed,doc.kind,expected),tickTolerance))
          throw Error("Reopening the copy changed the library geometry of "+describe(i)+". No file was written.");
      }
    }
  }
  function bindingFingerprint(doc) {
    // Bind the reviewed state, including geometry and IDs. A dialog or a worker
    // can yield to another edit between planning and committing the link.
    return AtriumSourceFile.sha256(new TextEncoder().encode(JSON.stringify(doc)));
  }
  function bindLegacy(doc,defs,base,digest) {
    const original=base.doc;
    if(doc.items.some(sourceKey) || doc.items.length!==original.items.length)throw Error("This older import differs from the original. Link an unedited revision or reimport the original to enable Altium copies.");
    const identities=doc.items.map((i,n)=>{
      const b=original.items[n];
      if(!sourceKey(b)||!equal(without(i,itemFields),without(sourceItemProjection(b,i),itemFields)))throw Error("This older import has edited or reordered objects. Link an unedited revision or reimport the original.");
      if(i.kind==="part")assertDefinition(base.defs.get(b.def),defs.get(i.def),describe(i));
      return b.sourceRecord?{id:i.id,sourceRecord:b.sourceRecord}:{id:i.id,schSource:b.schSource};
    });
    const binding={sha256:digest,identities,documentFingerprint:bindingFingerprint(doc)};
    // The earliest importer did not project the Altium rule stream. Restore
    // it from the verified original when upgrading the project's source link.
    if(doc.sourceRules===undefined && original.sourceRules)binding.sourceRules=original.sourceRules.slice();
    return binding;
  }
  function applyBinding(doc,binding) {
    if(doc.sourceSha256 || binding.identities.length!==doc.items.length || !/^[0-9a-f]{64}$/.test(binding.sha256) || binding.documentFingerprint!==bindingFingerprint(doc))throw Error("Source link is stale. Select the original again.");
    const seen=new Set();
    for(let n=0;n<doc.items.length;n++){
      const identity=binding.identities[n],key=sourceKey(identity);
      if(doc.items[n].id!==identity.id || sourceKey(doc.items[n]) || !key || seen.has(key))throw Error("The document changed during review.");
      seen.add(key);
    }
    for(let n=0;n<doc.items.length;n++){
      const identity=binding.identities[n];
      if(identity.sourceRecord)doc.items[n].sourceRecord=identity.sourceRecord;
      else doc.items[n].schSource={...identity.schSource};
    }
    if(binding.sourceRules)doc.sourceRules=binding.sourceRules.slice();
    doc.sourceSha256=binding.sha256;
  }
  function prepare(doc,library,originalBytes,{provenance = undefined,project = undefined} = {}) {
    const ext=doc.kind==="pcb"?"PcbDoc":"SchDoc", fileName=doc.sourceName;
    if(!fileName || !fileName.toLowerCase().endsWith("."+ext.toLowerCase()))throw Error("Select a document imported from an Altium binary source.");
    const digest=AtriumSourceFile.sha256(originalBytes);
    if(doc.sourceSha256 && digest!==doc.sourceSha256)throw Error("The selected file differs from the imported original (SHA-256 mismatch). Select the original revision.");
    const base=readSource(fileName,doc,originalBytes), reviewed=doc;
    library = library.map(Atrium.definitionGeometry);
    const storedRepours=doc.sourceSha256===digest ? verifiedNativeRepours(project,doc.id) : new Set();
    if (provenance) ({doc,library}=nativeSourceProjection(base,doc,library,digest,provenance,storedRepours));
    const currentDefs=refs(library);
    if(!doc.sourceSha256){
      verifyDocument(base.doc,doc.sourceRules===undefined?{...doc,sourceRules:base.doc.sourceRules}:doc);
      const binding = bindLegacy(doc,currentDefs,base,digest);
      binding.documentFingerprint = bindingFingerprint(reviewed);
      return {binding};
    }
    if(base.legacyRecords?.size)doc={...doc,items:doc.items.map(i=>base.legacyRecords.has(i.id)?{...i,sourceRecord:base.legacyRecords.get(i.id)}:i)};
    const before=index(base.doc), diagnostics=[];
    if(doc.kind==="schematic" && doc.items.some(i=>Atrium.isOffsheet(i) && i.io!==undefined || i.kind==="offsheet" && i.schPaint?.offSheet)){
      // A direction edit can promote an older painted net label. Project only this
      // field back to its verified source representation; compare all other fields.
      doc={...doc,items:doc.items.map(i=>{
        const raw=before.get(sourceKey(i));
        if(!Atrium.isOffsheet(i) || !raw || !Atrium.isOffsheet(raw))return i;
        const {io,...copy}=i;
        if(io!=null && io!=="unspecified")diagnostics.push("Off-sheet connector "+i.text+" ("+i.id+") lost its "+io+" direction in the Altium copy.");
        return {...copy,kind:raw.kind};
      })};
    }
    const additions=[],current=index(doc,doc.kind==="schematic"?additions:null), edits=[];
    if(current.size!==before.size)throw Error("Source objects have been added or removed without a matching record. Removed objects cannot be written to this native format.");
    for(const [key,after] of current){
      const original=before.get(key);
      if(!original || original.kind!==after.kind)throw Error("A source record was replaced or could not be matched: "+describe(after)+".");
      const raw=sourceItemProjection(original,after);
      if(raw.kind==="part")assertDefinition(base.defs.get(raw.def),currentDefs.get(after.def),describe(after));
      if(!equal(without(raw,itemFields),without(after,itemFields))){
        const previous={...raw,id:after.id};
        // Only send the adapter fields the editor actually changed. A saved/reopened
        // coordinate may be the canonical decimal representation of the original.
        for(const key of Object.keys(raw))if(equal(raw[key],after[key]))previous[key]=after[key];
        if(raw.kind==="part"){previous.def=after.def;previous.link=after.link;}
        edits.push({before:previous,after});
      }
    }
    const context={beforeDoc:base.doc,afterDoc:doc,beforeDefs:base.defs,afterDefs:currentDefs,additions};
    const adapter=doc.kind==="pcb"?AtriumPCBPatch:AtriumSchPatch;
    const plan=edits.length||additions.length?adapter.plan(base.streams,edits,context):{replacements:new Map(),changes:[],records:[]};
    // An authored polygon edit can invalidate its fill as well. Report the edit
    // that the source adapter cannot represent before its derived copper mismatch.
    verifyDocument(base.doc,doc,storedRepours);
    const bytes=base.file.write(plan.replacements);
    if(edits.length||additions.length){
      verifyResult(doc,currentDefs,readSource(fileName,doc,bytes),plan.appended,storedRepours);
      if(doc.kind==="pcb")diagnostics.push("Altium’s stored pours, connectivity cache and violation records are retained. Repour and rerun DRC in Altium after opening the copy.");
    }
    if(doc.kind==="pcb")diagnostics.push("Waffle’s active rule overrides stay in the project. The copy retains the original Altium rule records.");
    const name=fileName.replace(/\.[^.]+$/,"").replace(/[\\/:*?"<>|\u0000-\u001f]/g,"-")+"-edited."+ext;
    return {name,bytes,changes:plan.changes,records:plan.records||[],diagnostics,sourceSha256:digest};
  }
  return {prepare,usedLibrary,applyBinding};
})();
