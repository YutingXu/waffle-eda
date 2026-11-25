"use strict";
globalThis.AtriumDesignReview = (() => {
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function button(text, fn, variant="secondary"){
    const b=globalThis.AtriumUI.button(el("button",text),variant);
    b.onclick=fn;
    return b;
  }
  function modal(title){
    const d=el("dialog",null,"work-dialog ui-dialog"), heading=el("h2",title);
    const body=el("div",null,"ui-dialog-body"), actions=el("div",null,"work-actions ui-dialog-actions");
    d.append(heading,body,actions);
    return {d,heading,body,actions};
  }
  const count=(n,one,many=one+"s")=>globalThis.AtriumI18n?.plural?.(n,one,many)??n+" "+(n===1?one:many);
  function connectivity(ctx){
    const {d,heading,body,actions}=modal("Board connectivity"), result=ctx.connections();
    body.append(el("p",ctx.doc.name+" · "+count(result.nets.length,"net")+" · "+count(result.shorts.length,"short")+" · "+count(result.airwires.length,"unrouted connection")));
    const search=el("input", null, "ui-field");search.type="search";search.placeholder="Find a net or terminal";search.setAttribute("aria-label","Find a net or terminal");
    const list=el("div",null,"work-list"), coverage=el("details");
    const coverageNotes=el("ul");for(const note of result.sourceNotes)coverageNotes.append(el("li",note));
    coverage.append(el("summary","Geometry checked"),el("p",count(result.excluded,"unsupported copper object")+" excluded. "+count(result.unassigned,"unassigned copper object")+" checked for physical contact."),coverageNotes);
    const show=button("",()=>{ctx.toggleUnrouted();showText();});
    function showText(){show.textContent=ctx.showUnrouted()?"Hide unrouted connections":"Show unrouted connections";show.setAttribute("aria-pressed",String(ctx.showUnrouted()));}
    function locate(id,at){d.close();ctx.locate(id,at);}
    function pair(issue,label){
      const line=el("div",null,"review-line"),names=el("div");names.append(el("strong",label),el("small",issue.fromLabel+" ↔ "+issue.toLabel));
      const buttons=el("div",null,"pair-actions");buttons.append(button("First",()=>locate(issue.fromId,issue.from)),button("Second",()=>locate(issue.toId,issue.to)));
      buttons.firstChild.setAttribute("aria-label","Locate "+issue.fromLabel);buttons.lastChild.setAttribute("aria-label","Locate "+issue.toLabel);
      line.append(names,buttons);list.append(line);
    }
    function paint(){
      list.replaceChildren();const q=search.value.trim().toLowerCase();let found=0;
      function match(values){return values.join(" ").toLowerCase().includes(q);}
      for(const s of result.shorts){if(match([...s.nets,s.fromLabel,s.toLabel])&&++found<=100)pair(s,"Short · "+s.nets.join(" / "));}
      for(const a of result.airwires){if(match([a.net,a.fromLabel,a.toLabel])&&++found<=100)pair(a,a.net+" · "+Number(a.distance.toFixed(2))+" mm");}
      if(!found)list.append(el("p",q?"No matching connections.":"All named copper is connected within the checked geometry."));
      if(found>100)list.append(el("p","Showing 100 of "+found+" connections. Search to narrow the list."));
    }
    body.append(search,list,coverage);actions.append(show,button("Done",()=>d.close(),"primary"));
    search.oninput=paint;showText();paint();
    globalThis.AtriumShell.openDialog(d,{title:heading,body,actions,initialFocus:search});
  }
  function exportDesign(ctx){
    const {d,heading,body,actions}=modal("Export Design"),select=el("select", null, "ui-field"),format=el("select", null, "ui-field"),notes=el("ul"),summary=el("p"),details=el("details"),status=el("p");
    const label=(text,control)=>{const l=el("label",null,"work-row");l.append(el("span",text),control);control.setAttribute("aria-label",text);return l;};
    status.setAttribute("role","status");details.append(el("summary","Export details"),notes);
    const host=globalThis.AtriumNavHost, session=host?.project()===ctx.project ? host.folderProject?.() : null;
    const documents=session?.documents() || ctx.project.documents;
    for(const doc of documents)if(doc.kind==="pcb"||doc.kind==="schematic")select.add(new Option(doc.name,doc.id));
    if([...select.options].some(o=>o.value===ctx.doc.id))select.value=ctx.doc.id;
    if(!select.options.length){d.remove();ctx.info("Open a schematic or PCB document to export.");return;}
    const selected=()=>ctx.project.documents.find(doc=>doc.id===select.value) || documents.find(doc=>doc.id===select.value);
    const abort=new AbortController();
    async function loadSelected(scope, frames) {
      const id = select.value;
      if(!session)return selected();
      if(scope==="project" || frames) {
        const purpose=scope==="project"?"export":"schematic-export";
        if(!session.completeFor(purpose)) await session.requireClosure({purpose,signal:abort.signal});
      } else if(!host.docById(id)) await session.ensureDocument(id,{purpose:"export",signal:abort.signal});
      return host.docById(id);
    }
    const version=()=>ctx.revision?.() ?? 0;
    const registered=id=>globalThis.AtriumTranslatorRegistry.get(id)?.export;
    const imported=doc=>globalThis.AtriumImportReports?.sourceDocument(doc)||doc;
    const translate=(id,options)=>globalThis.AtriumTranslatorClient.export(id,ctx.project,{
      ...options,provenance:globalThis.AtriumImportReports?.provenance()||[]
    });
    let output=null,source=null,binding=null,reviewedVersion=null,request=0,saving=false;
    let frameExport;
    const split=button("One sheet per frame",()=>{
      frameExport={pageMode:"frames",scope:format.value==="kicad-project"?"project":"document"};
      format.value="kicad-project";
      preview();
    });
    split.hidden=true;
    const more=button("More changes",showMore);
    let nextChange=0;
    const choose=button("Choose original…",async()=>{
      const ticket=++request, doc=selected();
      try{
        const file=await ctx.pickFile([doc.kind==="pcb"?".PcbDoc":".SchDoc"]);
        if(!file || !active(ticket))return;
        clear();source=null;status.textContent="Reading original…";
        const bytes=new Uint8Array(await file.arrayBuffer());
        if(!active(ticket))return;
        source={file,bytes};await prepare();
      }catch(error){if(active(ticket)){clear();status.textContent=error.message;}}
    });
    const link=button("Link source to document",async()=>{
      if(!binding || reviewedVersion!==version()){await prepare();return;}
      try{
        await AtriumImportReports.bindSource(ctx.project,selected(),binding);
        await prepare();
      }
      catch(error){clear();status.textContent=error.message;}
    });
    const write=button("Export",async()=>{
      if(!output || saving)return;
      const binary=format.value==="altium";
      if(reviewedVersion!==version()){if(binary)await prepare();else await preview();return;}
      saving=true;write.disabled=true;format.disabled=true;select.disabled=true;choose.disabled=true;
      try{
        const saved=binary?await ctx.exportBinaryCopy(output.name,output.bytes,source.file):await ctx.exportFile(output.name,output.content);
        if(saved){ctx.info("Exported "+output.name);d.close();}
      }catch(error){status.textContent=error.message;}
      finally{saving=false;write.disabled=!output;format.disabled=false;select.disabled=false;choose.disabled=false;}
    });
    function active(ticket){return ticket===request && d.isConnected && format.value==="altium";}
    function clear(){
      output=null;binding=null;reviewedVersion=null;link.hidden=true;write.disabled=true;details.hidden=true;
      notes.replaceChildren();nextChange=0;more.hidden=true;summary.textContent="";status.textContent="";
    }
    function note(text){notes.append(el("li",text));}
    function field(value){return typeof value==="string"?value:JSON.stringify(value)??"–";}
    function showMore(){
      if(!output?.changes)return;
      const end=Math.min(nextChange+40,output.changes.length);
      while(nextChange<end){
        const entry=output.changes[nextChange++],row=el("li");
        row.append(el("strong",entry.field+" · "+entry.record));
        const values=field(entry.before)+" → "+field(entry.after);
        if(values.length>150){
          const expand=el("details");expand.append(el("summary","Show values"),el("small",values));row.append(expand);
        }else row.append(el("small",values));
        notes.append(row);
      }
      more.hidden=nextChange===output.changes.length;
    }
    async function prepare(){
      if(!source)return;
      const ticket=++request,at=version();clear();status.textContent="Checking native records…";
      try{
        const doc=await loadSelected("document",false);
        if(!active(ticket))return;
        const r=await translate("altium-source-copy",{documentId:doc.id,original:{name:source.file.name,bytes:source.bytes}});
        const value={...r.details,name:r.files[0]?.name,bytes:r.files[0]?.bytes};
        if(!active(ticket))return;
        if(at!==version())throw Error("The design changed during review. Choose the original again.");
        reviewedVersion=at;status.textContent="";
        if(value.binding){
          binding=value.binding;link.hidden=false;
          summary.textContent="This older import matches the original. Link it to enable native copies.";
          return;
        }
        output=value;const edits=value.changes;
        summary.textContent=edits.length?count(edits.length,"edited field")+" · "+value.name:"No native changes. The copy is byte-identical to the original.";
        for(const message of value.diagnostics)note(message);
        if(edits.length && value.records?.length===0)note("The edits round to the original Altium coordinate precision. The copy is byte-identical.");
        if(value.records?.length){
          const row=el("li"),records=el("details");
          records.append(el("summary",count(value.records.length,"source record")+" changed"));
          records.ontoggle=()=>{
            if(records.open && records.childElementCount===1)records.append(el("small",value.records.join(", ")));
          };
          row.append(records);notes.append(row);
        }
        showMore();
        details.hidden=!notes.childNodes.length;details.open=true;write.disabled=false;
      }catch(error){if(active(ticket)){clear();status.textContent=error.message;}}
    }
    async function preview(){
      const ticket=++request,at=version();source=null;clear();split.hidden=true;
      const binary=format.value==="altium";choose.hidden=!binary;
      if(binary){summary.textContent="Choose the original "+imported(selected()).sourceName+" to review changes.";return;}
      if(!format.value)return;
      status.textContent="Preparing export…";
      try{
        const whole=format.value==="kicad-project", scope=frameExport?.scope || (whole?"project":"document");
        const doc=await loadSelected(scope, !!frameExport);
        if(ticket!==request||!d.isConnected)return;
        if(session && host.project()!==ctx.project) throw Error("Open Export Design again for this project.");
        if(!doc) throw Error("The selected document is unavailable.");
        const tooLarge=globalThis.AtriumSchematicOutput?.oversized(ctx.project,"kicad",scope==="project"?null:doc.id) || [];
        if(tooLarge.length && !frameExport){
          split.hidden=tooLarge.some(doc=>!doc.items.some(i=>i.kind==="textframe"&&i.role==="frame"));
          status.textContent=tooLarge.map(doc=>doc.name).join(", ")+" exceeds KiCad’s 3048 mm page limit. "+(split.hidden?"Add named frames to divide the drawing.":"Export a KiCad project with one sheet per frame.");
          return;
        }
        const r=await translate("kicad",{scope,documentId:doc.id,pageMode:frameExport?.pageMode});
        if(ticket!==request||!d.isConnected)return;
        if(at!==version())throw Error("The design changed during export. Select the format again.");
        const primary=r.files[0],meta=r.details;
        if(!primary)throw Error("The translator returned no design files.");
        output=whole?{name:meta.name,content:AtriumZip.create(r.files.map(f=>({
          name:(meta.archivePrefix?meta.archivePrefix.replace(/\/$/,"")+"/":"")+f.name,data:f.bytes??f.text
        })))}:{name:primary.name,content:primary.bytes??primary.text};
        reviewedVersion=at;
        const c=meta.counts||{},totals=(doc.kind==="pcb"||whole&&c.footprints!=null)?
          [[c.footprints,"footprint"],[c.pads,"pad"],[c.segments,"track segment"],[c.vias,"via"]]:
          [[c.symbols,"symbol"],[c.pins,"pin"],[c.wires,"wire segment"],[c.junctions,"junction"]];
        summary.textContent=totals.filter(([n])=>n!=null).map(([n,label])=>count(n,label)).join(" · ");
        for(const message of r.report.notes)note(message);
        if(!whole && r.files.length>1)note("Use KiCad project to include "+r.files.slice(1).map(f=>f.name).join(", ")+".");
        status.textContent="";details.hidden=!notes.childNodes.length;details.open=true;write.disabled=false;
      }catch(error){if(ticket===request){clear();status.textContent=error.message;}}
    }
    function formats(){
      const old=format.value,doc=selected(),primary=doc.kind==="pcb"?"board":"schematic";
      format.replaceChildren();
      const original=imported(doc),native=registered("altium-source-copy")&&original.sourceEncoding!=="ascii"&&/\.(pcbdoc|schdoc)$/i.test(original.sourceName||"");
      if(native)format.add(new Option("Altium source copy (."+ (doc.kind==="pcb"?"PcbDoc":"SchDoc")+")","altium"));
      if(registered("kicad")){
        if(doc.kind==="pcb"||doc.kind==="schematic")format.add(new Option(primary==="board"?"KiCad board (.kicad_pcb)":"KiCad schematic (.kicad_sch)",primary));
        format.add(new Option("KiCad project (.zip: board, rules and sheets)","kicad-project"));
      }
      format.value=native&&(!old||old==="altium")?"altium":(doc.kind==="pcb"||doc.kind==="schematic")?primary:"kicad-project";
      preview();
    }
    // Bills of materials come from the Active BOM (Reports › Bill of Materials), not this dialog.
    const bomNote=el("p","Bill of materials: use the Active BOM (Reports › Bill of Materials) for CSV, XLSX and grouped BOMs. ");
    bomNote.className="review-bom-note";bomNote.append(button("Open Active BOM",()=>{d.close();globalThis.AtriumNavHost?.act?.("bom");}));
    select.onchange=()=>{frameExport=undefined;formats();};format.onchange=()=>{frameExport=undefined;preview();};
    details.append(more);
    write.disabled=true;
    write.dataset.variant="primary";
    actions.append(button("Cancel",()=>d.close()),write);
    body.append(label("Document",select),label("Format",format),choose,split,summary,link,details,status,bomNote);
    globalThis.AtriumShell.openDialog(d,{title:heading,body,actions,initialFocus:select,onClose:()=>abort.abort()});
    if (session?.ensureImportReports) {
      status.textContent="Preparing export…";
      session.ensureImportReports().catch(error=>ctx.info(error.message)).then(()=>{if(d.open)formats();});
    } else formats();
  }
  async function exportBinaryCopy(name,bytes,sourceFile) {
    const sourceName=sourceFile?.name || "";
    const ext=/\.(schdoc|pcbdoc)$/i.exec(sourceName)?.[1].toLowerCase();
    if(!ext || !(bytes instanceof Uint8Array))throw Error("Select the original Altium document to export a binary copy.");
    let filename=String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g,"-").trim();
    if(!filename.toLowerCase().endsWith("."+ext))throw Error("Use the same document extension as the source.");
    if(filename.normalize("NFC").toLowerCase()===sourceName.normalize("NFC").toLowerCase()){
      const dot=filename.lastIndexOf(".");
      filename=filename.slice(0,dot)+"-edited"+filename.slice(dot);
    }
    if(globalThis.AtriumHost)return await AtriumHost.exportBinaryCopy(filename,bytes,sourceFile);
    return globalThis.AtriumIO.exportFile(filename,bytes);
  }
  return {connectivity,exportDesign,exportBinaryCopy};
})();
