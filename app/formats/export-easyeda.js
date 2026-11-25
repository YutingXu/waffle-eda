"use strict";
// Worker-local writers for EasyEDA Standard JSON and the Pro 2.x project archive.
globalThis.AtriumEasyEDAExport = (() => {
  const design = d => d.kind === "schematic" || d.kind === "pcb";
  const safe = v => String(v || "Design").replace(/[\\/:*?"<>|\x00-\x1f]/g,"-").replace(/\.(?:json|epro|esch|epcb)$/i,"").trim() || "Design";
  const round = n => {
    if (!Number.isFinite(n)) throw Error("EasyEDA export encountered a non-finite coordinate.");
    return Math.round(n * 1e7) / 1e7 || 0;
  };
  const mode = d => d.sourceEncoding === "easyeda-pro" ? "pro" : d.sourceEncoding === "easyeda-standard" ? "standard" :
    /\.(?:esch|epcb|epro)$/i.test(d.sourceName || "") ? "pro" : /\.json$/i.test(d.sourceName || "") ? "standard" : null;
  const check = signal => {if (signal?.aborted) {const e = Error("EasyEDA export cancelled."); e.name = "AbortError"; throw e;}};
  // Read each authenticated original at most once, and only on an explicit same-edition
  // export. A reusable source record must still have the same native owner and geometry.
  function retainedFiles(provenance) {
    const owners = new Map(), parsed = new Map();
    for (const group of Array.isArray(provenance) ? provenance : [provenance]) {
      const fields = new Map((group?.fields || []).filter(r=>r.type==="item" && r.values?.sourceRecord?.startsWith("easyeda/")).map(r=>[r.id,r.values.sourceRecord]));
      for (const f of group?.files || []) for (const [index,id] of (f.documents || []).entries()) {
        if (owners.has(id)) {owners.set(id,null); continue;}
        owners.set(id,{f,index,fields});
      }
    }
    function decode(f) {
      const I=globalThis.AtriumImportFormats;
      if(!I)return null;
      const descriptors = [];
      const standard = (data,path,scope=path===f.name?"$":path+"#$") => {
        if (Array.isArray(data?.schematics)) {
          for (const key of ["schematics","pcbs"]) for (const [index,e] of (data[key] || []).entries()) standard(typeof e.dataStr==="string"?JSON.parse(e.dataStr):e.dataStr||e,path,scope+"."+key+"["+index+"]"+(e.dataStr?".dataStr":""));
        } else if (["1","3"].includes(String(data?.head?.docType ?? data?.docType))) descriptors.push({edition:"standard",data,path,scope});
      };
      if (f.bytes[0]===80 && f.bytes[1]===75) {
        const files = I.unzip(f.bytes), members = [...files.keys()].filter(k=>/\.(?:esch|epcb)$/i.test(k)).sort();
        let manifest;
        const manifestPath=[...files.keys()].find(k=>/(^|\/)project\.json$/i.test(k));
        if (members.length && manifestPath) manifest=JSON.parse(I.utf8(files.get(manifestPath)));
        if (members.length) for (const k of members) descriptors.push({edition:"pro",lines:I.utf8(files.get(k)).split(/\r?\n/),path:k,manifest});
        else for (const [k,b] of files) if (/\.json$/i.test(k) && !/(^|\/)project\.json$/i.test(k)) {
          try {standard(JSON.parse(I.utf8(b)),k);} catch { /* optional archive metadata */ }
        }
      } else {
        const text=I.utf8(f.bytes).trim();
        if (text.startsWith("{")) standard(JSON.parse(text),f.name);
        else if (text.startsWith("[")) descriptors.push({edition:"pro",lines:I.utf8(f.bytes).split(/\r?\n/),path:f.name});
      }
      if (!descriptors.length) return null;
      return descriptors;
    }
    const byDigest=new Map();
    return d => {
      const bound=owners.get(d.id);if(!bound || !mode(d))return null;
      const f=bound.f;
      if(!parsed.has(f)){
        let descriptor;
        if(f.bytes instanceof Uint8Array && /^[0-9a-f]{64}$/.test(f.sha256) && globalThis.AtriumSourceFile?.sha256(f.bytes)===f.sha256) {
          try {
            if(!byDigest.has(f.sha256))byDigest.set(f.sha256,decode(f) || []);
            descriptor=byDigest.get(f.sha256);
          }catch { /* an unsupported historical source can be regenerated from the current model */ }
        }
        parsed.set(f,descriptor || []);
      }
      const source=parsed.get(f)[bound.index];if(!source)return null;
      const index=f.easyeda?.version===1 && f.easyeda.sha256===f.sha256?f.easyeda:null;
      const unmodeled=(index?.omissions || []).filter(x=>x.scope===(source.scope || source.path));
      const emitted=new Set();
      return {...source,digest:f.sha256,omissions:index?.omissions || [],unmodeled,record(item) {
        const key=bound.fields.get(item.id);
        if (!key || key!==item.sourceRecord || emitted.has(key))return null;
        const match=/^easyeda\/(shape|line)\/(\d+)\/([0-9a-f]{64})$/.exec(key);
        if(!match || !globalThis.AtriumEasyEDAImport || AtriumEasyEDAImport.fingerprint(item)!==match[3])return null;
        const n=Number(match[2]), raw=source.data?.shape?.[n] || source.lines?.[n];
        if(!raw)return null;
        emitted.add(key);return raw;
      }};
    };
  }
  function exportDesign(model,options={},fidelity) {
    check(options.signal);
    const project=globalThis.AtriumTranslatorProvenance?.toLegacy(model,options.provenance) || model;
    const scope=options.scope || (options.documentId ? "document" : "project");
    if (!["project","document","documents"].includes(scope)) throw Error("Unknown EasyEDA export scope.");
    const selected=options.documentId==null ? null : project.documents.find(d=>d.id===options.documentId);
    if ((scope==="document" || options.documentId!=null) && (!selected || !design(selected))) throw Error("Choose a schematic or PCB for EasyEDA export.");
    const docs=scope==="document" ? [selected] : project.documents.filter(design);
    if (!docs.length) throw Error("There are no schematics or PCBs to export.");
    const originals=retainedFiles(options.provenance), sources=new Map(docs.map(d=>[d.id,originals(d)]));
    const inferred=new Set(docs.map(d=>sources.get(d.id)?.edition || mode(d)).filter(Boolean));
    if (!options.edition && inferred.size>1) throw Error("Choose EasyEDA Standard or Pro for a project containing both editions.");
    const edition=options.edition || [...inferred][0] || "standard";
    if (!["standard","pro"].includes(edition)) throw Error("Choose EasyEDA Standard or Pro.");
    const defs=new Map(project.library.map(def=>[def.id,def]));
    const names=new Set(), stems=new Map();
    for (const d of docs) {
      const base=safe(d.name);let name=base, n=2;
      while (names.has(name.toLowerCase())) name=base+"-"+n++;
      names.add(name.toLowerCase());stems.set(d.id,name);
    }
    const add=(kind,status,doc,item,reason,count)=>fidelity?.add(kind,status,{file:doc.sourceName || doc.name || project.name,object:item?.sourceRecord || item?.id || doc.id},reason,count);
    if (scope!=="document") for (const d of project.documents) if (!design(d)) add("Document "+d.kind,"dropped",d,null,"EasyEDA design files contain schematics and boards.");
    const groups=(Array.isArray(options.provenance)?options.provenance:[options.provenance]).filter(Boolean);
    const observed=new Set(groups.flatMap(g=>(g.classRuleDefaults || []).map(r=>r.documentId)));
    const historical=[];
    for(const d of docs){
      const rule=sources.get(d.id)?.data?.DRCRULE?.Default;
      if(d.kind!=="pcb" || observed.has(d.id) || !rule || typeof rule!=="object")continue;
      // Older imports have their original bytes but predate saved field ownership.
      // Read only the dimensions from the already decoded, digest-verified source.
      const defaults=AtriumEasyEDAImport.standardDimensions(rule);
      const set=AtriumImportFormats.rulesFrom(defaults,{});
      historical.push({documentId:d.id,rules:AtriumImportFormats.classRuleEvidence(set,defaults)});
    }
    const hasRules=docs.some(d=>d.kind==="pcb" && (d.rules || project.rules));
    const P=globalThis.AtriumTranslatorProvenance;
    const used=hasRules && P?.usedRule(project,[...groups,{classRuleDefaults:historical}]);
    const defaultRuleKeys=hasRules && P?.defaultRuleKeys(project);
    function rules(d) {
      const R=globalThis.AtriumRules, set=d.rules || (project.rules && R?.stored(d,project));
      if(!set || !R)return set;
      const normalized=set.list?set:R.migrate(set);
      const list=normalized.list.filter(r=>!used || used(d,r));
      return list.length?{list,all:normalized.list}:null;
    }
    const ctx={project,docs,defs,edition,options,scope,stems,safe,round,add,rules,defaultRuleKeys,check:()=>check(options.signal),source:d=>sources.get(d.id)?.edition===edition ? sources.get(d.id) : null};
    const defaulted=new Set(["NET","LAYER","HEAD","LINESTYLE","FONTSTYLE","CANVAS"]);
    const reportedSources=new Set();
    for(const d of docs){
      const source=sources.get(d.id),originalEdition=source?.edition || mode(d);
      if(originalEdition && originalEdition!==edition)add("EasyEDA document edition","approximated",d,null,"Editable "+originalEdition+" design converted to "+edition+" primitives.");
      const dependencyLoss=[];
      if(source && scope==="project" && !reportedSources.has(source.digest)) {
        reportedSources.add(source.digest);
        for(const omission of source.omissions) {
          if(omission.scope==="@archive" || source.edition==="pro" && /\.(?:esym|efoo)$/i.test(omission.scope))dependencyLoss.push(omission);
        }
      }
      for(const x of [...(source?.unmodeled || []),...dependencyLoss]) {
        // Style/header declarations are regenerated; ancillary unrepresented
        // library primitives still get their original file and line in the report.
        if(defaulted.has(x.kind) || x.kind==="Other EasyEDA record" && defaulted.has(/^Unsupported EasyEDA record (.+)\.$/.exec(x.reason)?.[1]))continue;
        fidelity?.add("Original "+x.kind,"dropped",{file:d.sourceName || d.name,object:x.object},x.reason,x.count);
      }
      if(source?.edition==="standard")for(const key of Object.keys(source.data)){
        if(!["head","shape","docType","canvas","layers","DRCRULE","title","BBox"].includes(key)){
          fidelity?.add("Original document setting","dropped",{file:d.sourceName || d.name,object:source.scope+"."+key},"Source-only setting "+key+" is omitted.");
        }
      }
      const body=(v,owner)=>{if(v?.length)add("3D body","dropped",d,owner,"This writer exports the editable two-dimensional design.",v.length);};
      body(d.bodies3d,null);
      if(d.stackup || d.layerStack)add("Physical layer stack","approximated",d,null,"Physical layer identifiers are written; material and dielectric construction are omitted.");
      if(d.schPage || d.page)add("Schematic page setup","approximated",d,null,"The destination uses its own schematic canvas settings.");
      const footprintDefs=new Set();
      const padFeatures=(p,i)=>{
        if(p.padStack && Object.keys(p.padStack).length)add("Layer-specific pad shape","approximated",d,i,"A single default land is written on the pad's layers.");
        if(p.tent && (p.tent.top!=null || p.tent.bottom!=null))add("Mask tenting","dropped",d,i,"Per-side tenting overrides are not written.");
        if(p.maskExpansion!=null || p.pasteExpansion!=null){
          const omitted=p.kind==="via" && (edition==="standard" || p.pasteExpansion!=null);
          add("Mask or paste expansion",omitted?"approximated":"kept",d,i,omitted?"The chosen via format cannot express all of the expansion overrides.":undefined);
        }
      };
      for(const i of d.items){
        body(i.bodies3d,i);
        const fp=i.kind==="part" && defs.get(i.def)?.footprint;
        if(fp && !footprintDefs.has(fp)){footprintDefs.add(fp);body(fp.bodies3d,i);for(const pad of fp.pads || [])padFeatures(pad,i);}
        if(i.kind==="pad" || i.kind==="via")padFeatures(i,i);
        if(i.kind==="via" && (i.fromLayer && i.fromLayer!=="Top" || i.toLayer && i.toLayer!=="Bottom"))add("Blind or buried via span","approximated",d,i,"The exported via uses the destination through-hole span.");
        if(i.regionShape?.cutouts?.length)add("Internal region cutout","dropped",d,i,"Only the outer editable region boundary is emitted.",i.regionShape.cutouts.length);
        if(i.powerPlane)add("Power plane settings","approximated",d,i,"Only the projected polygon, layer, and net are emitted.");
      }
    }
    const files=edition==="standard" ? AtriumEasyEDAStandardWriter.write(ctx) : AtriumEasyEDAProWriter.write(ctx);
    check(options.signal);
    return {files,details:{edition,scope,documents:docs.map(d=>d.id)}};
  }
  return Object.freeze({export:exportDesign});
})();
