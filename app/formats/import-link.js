"use strict";
globalThis.AtriumImportLink=(()=>{
  const A=Atrium;
  const key=s=>String(s||"").trim().toUpperCase();
  function placeholder(kind,name){
    const d=A.sheet(kind,name);
    d.importPlaceholder={name:d.name,grid:d.grid};
    return d;
  }
  function compatible(sd,bd){
    if(!sd?.symbol||!bd?.footprint)return false;
    const wanted=key(sd.footprintName||sd.footprint?.name),got=key(bd.footprint.name);
    // A named mismatch cannot be overridden by coincidentally matching
    // pin numbers. A missing name requires equal sets of numbered terminals.
    if(wanted && wanted!==got)return false;
    const logical=new Set(sd.symbol.pins.map(p=>p.number).filter(Boolean));
    const physical=new Set(bd.footprint.pads.map(p=>p.number).filter(Boolean));
    if(wanted)return [...logical].every(n=>physical.has(n));
    return logical.size>0 && logical.size===physical.size && [...logical].every(n=>physical.has(n));
  }
  // The Altium project's [Design] section owns this setting. A standalone sheet
  // has no project-wide scope to contribute to an existing project.
  function manifestScope(parsed, bytes, record) {
    if (!parsed?.manifest || !bytes || parsed.manifest.netScope) return parsed;
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
    let design = false;
    for (const line of new TextDecoder(encoding).decode(bytes).split(/\r\n|\r|\n/)) {
      const text = line.trim();
      if (text.startsWith("[")) design = /^\[Design\]$/i.test(text);
      else if (design) {
        const m = /^HierarchyMode\s*=\s*(\d+)$/i.exec(text);
        if (!m) continue;
        const mode = Number(m[1]), scope = ["automatic", "flat", "hierarchical", "global", "hierarchical"][mode];
        const reason = mode === 4 ? "Strict Hierarchical imported as Hierarchical. Power ports connect globally in Waffle." :
          !scope ? "Unknown Altium net identifier scope. Waffle uses Global connections." : undefined;
        if (scope) parsed.manifest.netScope = scope;
        if (reason) parsed.notes.push(reason);
        record?.(scope ? mode === 4 ? "approximated" : "kept" : "dropped", reason);
        break;
      }
    }
    return parsed;
  }
  function reconcile(project,importedDocs,netScope = ""){
    const incoming=new Set(importedDocs.map(d=>typeof d==="string"?d:d.id));
    if(!incoming.size)return {linked:0,removed:[],notes:[]};
    const arrivedKinds=new Set(project.documents.filter(d=>incoming.has(d.id)&&!A.pristineImportPlaceholder(d)).map(d=>d.kind));
    const removed=project.documents.filter(d=>!incoming.has(d.id)&&arrivedKinds.has(d.kind)&&A.pristineImportPlaceholder(d)).map(d=>d.id);
    if(removed.length){const ids=new Set(removed);project.documents=project.documents.filter(d=>!ids.has(d.id));}
    // Imported boards' rules (doc.rules) join the project rule book, and the source tool's net identifier
    // scope hint (doc.netScope; KiCad: hierarchical, so local labels stay on their sheet) becomes its rule
    // when the project has none; any "global" hint (KiCad bus groups) keeps the default (project-rules.js absorb).
    const docs=project.documents.filter(d=>incoming.has(d.id));
    // @ts-ignore: CommonJS (tests, tools); the browser loads it first (lazy.js)
    if(!globalThis.AtriumProjectRules&&typeof require==="function"&&(netScope||docs.some(d=>d.rules!=null)))require("../checks/rules.js");
    const P=globalThis.AtriumProjectRules,PS=globalThis.AtriumPCBPours,libDefs=new Map(project.library.map(d=>[d.id,d]));
    // A board's imported pour artwork is signed over the rules it reads (pcb-pours.js): signed as imported, it is
    // signed again once those rules are the project's.
    const signed=PS?docs.filter(d=>d.kind==="pcb"&&PS.matchesSignature(d,libDefs)):[];
    if(P){
      P.absorb(project,docs);
      if(netScope) {
        // Retain both the source declaration and the imported electrical behavior.
        // A later manual edit must not reinterpret a source project under Automatic.
        for(const d of docs)d.netScope=netScope;
        P.setNetScope(project,globalThis.AtriumHierarchy.effectiveScope(project,netScope),{kind:"import",tool:"Altium"});
      }
    }else if(netScope||docs.some(d=>d.rules!=null))throw Error("Design rules are not loaded.");
    globalThis.AtriumSignals?.attach(project);
    for(const d of signed)PS.storeSignature(d,libDefs);
    // Imported sheet symbols name their child by file; link them to the imported sheets.
    const base=n=>String(n||"").split(/[\\/]/).pop().trim().toUpperCase();
    for(const doc of project.documents)if(doc.kind==="schematic")for(const s of doc.items)
      if(s.kind==="sheetsymbol"&&!s.sheet&&s.file){const child=project.documents.find(d=>d.kind==="schematic"&&d.id!==doc.id&&base(d.sourceName)===base(s.file));if(child)s.sheet=child.id;}
    const defs=new Map(project.library.map(d=>[d.id,d])),groups=new Map(),used=new Map(),messages=new Map();
    const warn=(why,ref)=>{if(!messages.has(why))messages.set(why,new Set());messages.get(why).add(ref);};
    for(const doc of project.documents){
      const altium=doc.kind==="pcb"?/\.pcbdoc$/i.test(doc.sourceName||""):/\.schdoc$/i.test(doc.sourceName||"");
      for(const item of doc.items){
        if(item.kind!=="part")continue;
        if(item.link)used.set(item.link,(used.get(item.link)||0)+1);
        const ref=key(item.ref);
        if(!ref||/[?*=]/.test(ref))continue;
        if(!groups.has(ref))groups.set(ref,{schematic:[],pcb:[]});
        groups.get(ref)[doc.kind].push({item,doc,altium,recent:incoming.has(doc.id)});
      }
    }
    let linked=0;
    for(const [ref,g] of groups){
      if(!g.schematic.length||!g.pcb.length||![...g.schematic,...g.pcb].some(e=>e.recent))continue;
      if(g.schematic.length!==1||g.pcb.length!==1){warn("Ambiguous designators across sheets or boards",ref);continue;}
      const [s]=g.schematic,[b]=g.pcb;
      if(s.item.link && s.item.link===b.item.link)continue;
      // Manually authored documents might share reference numbering with an
      // imported assembly. Explicit links into those sheets still participate
      // in the used-link check and are never replaced.
      if(!s.altium||!b.altium)continue;
      if(s.item.altiumSourceId&&b.item.altiumSourceId&&s.item.altiumSourceId!==b.item.altiumSourceId){
        warn("Different source component IDs; review in Update PCB",ref);continue;
      }
      if((used.get(s.item.link)||0)>1||(used.get(b.item.link)||0)>1){warn("Existing component links retained",ref);continue;}
      if(s.doc.sourceProject&&b.doc.sourceProject&&key(s.doc.sourceProject)!==key(b.doc.sourceProject)){
        warn("Different source projects",ref);continue;
      }
      if(!compatible(defs.get(s.item.def),defs.get(b.item.def))){warn("Incompatible or unverified footprint mappings",ref);continue;}
      const existing=b.recent&&!s.recent?s.item:!b.recent&&s.recent?b.item:s.item;
      const link=existing.link||s.item.link||b.item.link||A.id();
      s.item.link=link;b.item.link=link;used.set(link,2);linked++;
    }
    const notes=[...messages].map(([reason,refs])=>reason+" · "+[...refs].sort((a,b)=>a.localeCompare(b,"en",{numeric:true})).join(", ")+".");
    return {linked,removed,notes};
  }
  return {placeholder,preferred:A.preferredDocument,reconcile,manifestScope};
})();
