"use strict";
globalThis.AtriumAltiumIO = (() => {
  const signature=[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1];
  function streams(bytes, lazyModels = false) {
    const typed = globalThis.AtriumSourceFile?.readStreams?.(bytes, {lazyModels});
    if (typed) return typed;
    let compound;
    try{compound=CFB.read(bytes,{type:"array"});if(!compound?.FullPaths?.length||!Array.isArray(compound.FileIndex))throw Error();}
    catch{throw Error("The Altium file is damaged (compound file structure).");}
    /** @type {AltiumStreams} */
    const result=new Map();
    const root=compound.FullPaths[0];
    const models=new Map();
    if(lazyModels)result.modelStream=(path,cap)=>{const b=models.get(path);return b?.length<=cap?new Uint8Array(b):null;};
    compound.FileIndex.forEach((entry,i)=>{
      const path=compound.FullPaths[i].slice(root.length).toLowerCase();
      if(lazyModels && /^(?:library\/)?models\/\d+$/.test(path)){models.set(path,entry.content);return;}
      if(entry.type===2 && entry.content)result.set(compound.FullPaths[i].slice(root.length).toLowerCase(),new Uint8Array(entry.content));
    });
    return result;
  }
  function read(name,bytes,options = {}) {
    const ext=name.split(".").pop().toLowerCase();
    globalThis.AtriumObsoleteProject?.reject(bytes,name);
    if(ext==="step"||ext==="stp"){
      if(bytes.length>32*1048576 || !/^\s*ISO-10303-21\s*;/i.test(new TextDecoder().decode(bytes.subarray(0,256))))throw Error("Invalid supplied STEP model.");
      return {modelFile:{file:name,stepText:new TextDecoder().decode(bytes)},documents:[],library:[],notes:[]};
    }
    if(ext==="prjpcb"){
      const encoding=bytes[0]===0xff&&bytes[1]===0xfe?"utf-16le":bytes[0]===0xfe&&bytes[1]===0xff?"utf-16be":"utf-8";
      let data;
      try{data=new TextDecoder(encoding,{fatal:true}).decode(bytes);}catch{data=new TextDecoder("windows-1252").decode(bytes);}
      const paths=[],modelPaths=[],seen=new Set();let documentSection=true,section="Project";
      const evidence=options.fidelity,reportedSections=new Set();
      for(const line of data.split(/\r\n|\r|\n/)){
        const s=line.trim();
        if(s.startsWith("[")){
          section=s.slice(1,-1); documentSection=/^\[Document\d+\]$/i.test(s);
          if(evidence&&!documentSection&&!reportedSections.has(section)){
            reportedSections.add(section);
            if(!/^(Parameter|OutputGroup)\d+$/i.test(section))evidence.add("Project settings","dropped",{file:name,object:section},
              "Foreign project settings retained in the original manifest.");
          }
          continue;
        }
        if(evidence && /^OutputGroup\d+$/i.test(section) && /^Configuration\d+_Item\d+=/i.test(s)){
          const kind=/[=|]Record=([^|]+)/i.exec(s)?.[1]||"Configuration";
          const gerber=/^GerberView$/i.test(kind);
          evidence.add("Output configuration",gerber?"approximated":"dropped",{file:name,object:section+"/"+s.slice(0,s.indexOf("="))},
            gerber?"Supported drill drawing and board profile settings are interpreted; the complete manufacturing configuration remains in the source.":
            "This manufacturing configuration remains in the original manifest.");
        }
        const ref=documentSection&&/^DocumentPath\s*=\s*(.+)$/i.exec(s);
        if(!ref)continue;
        const path=ref[1].trim().replace(/^"(.*)"$/,"$1"),key=path.replace(/\\/g,"/").toLowerCase();
        if(!seen.has(key)){
          if(/\.(SchDoc|PcbDoc|SchLib|PcbLib)$/i.test(path))paths.push(path);
          else if(/^notebook-[0-9a-f]{64}\.png$/.test(path))modelPaths.push(path);
          else if(/\.(stp|step)$/i.test(path)&&!/^\/|:|(?:^|\/)\.\.(?:\/|$)/.test(key))modelPaths.push(path);
          else evidence?.add("Project member","dropped",{file:name,object:section+"/"+path},"Unsupported project member type or external model path.");
          seen.add(key);
        }
      }
      if(!paths.length && !(options.allowEmptyManifest && /^\[Design\][ \t]*\r?$/im.test(data)))
        throw Error("The project manifest lists no supported documents.");
      // Project parameters ([ParameterN] Name=/Value=): board special strings such as .ProjectTitle
      // and schematic =ProjectTitle read them (fab-outputs.js, sch-appearance.js).
      const parameters={};
      for(const section of data.split(/^(?=\[)/m)){
        if(!/^\[Parameter\d+\]/i.test(section))continue;
        const key=/^Name=(.*)$/im.exec(section)?.[1]?.trim(),value=/^Value=(.*)$/im.exec(section)?.[1];
        if(key&&value!=null&&!/^(__proto__|constructor|prototype)$/.test(key)){
          parameters[key]=value.replace(/\r$/,"");
          evidence?.add("Project parameter","kept",{file:name,object:section.split("]")[0].slice(1)+"/"+key});
        }
      }
      const {drill:drillPlots,profile:profilePlots}=globalThis.AtriumPCB?.gerberPlots?.(data)||{};
      return {manifest:{name:name.replace(/\.[^.]+$/,""),paths,...(drillPlots?.length?{drillPlots}:{}),
        ...(profilePlots?.some(r=>r.options)?{profilePlots}:{}),...(modelPaths.length?{modelPaths}:{}),...(Object.keys(parameters).length?{parameters}:{})},documents:[],library:[],notes:[]};
    }
    if(!["schdoc","pcbdoc","schlib","pcblib"].includes(ext))throw Error("Choose a Waffle project, SchDoc, PcbDoc, SchLib or PcbLib.");
    const binary=signature.every((n,i)=>bytes[i]===n);
    const ascii=binary?null:new TextDecoder("windows-1252").decode(bytes);
    if(ascii!==null&&!/(?:^|\|)(?:HEADER|RECORD)=/im.test(ascii))throw Error("Unrecognised Altium file header.");
    const importer=ext.startsWith("sch")?AtriumSCH:AtriumPCB;
    const parsed=importer.read(name,binary?streams(bytes,ext==="pcbdoc"||ext==="pcblib"):null,ascii,options);
    globalThis.AtriumImportFormats?.scrub?.(parsed,options.fidelity);
    if(!binary)for(const doc of parsed.documents)doc.sourceEncoding="ascii";
    if(binary && parsed.documents.length && globalThis.AtriumSourceFile){
      const digest=AtriumSourceFile.sha256(bytes);
      for(const doc of parsed.documents)doc.sourceSha256=digest;
    }
    if(!parsed.documents.length&&!parsed.library.length)throw Error("No supported documents or library entries were found.");
    return parsed;
  }
  const modelLinks = (all, designs, files, pathOf) => globalThis.AtriumSourceFile.modelLinks(all, designs, files, pathOf);
  const modelNotes = (parsed, count) => globalThis.AtriumSourceFile.modelNotes(parsed, count);
  return {read,streams,modelLinks,modelNotes};
})();
Object.assign(globalThis.AtriumIO ??= {}, globalThis.AtriumAltiumIO);
