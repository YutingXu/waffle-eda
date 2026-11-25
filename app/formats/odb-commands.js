"use strict";

// Both hosts publish the resolved document through their isolated manufacturing translator.
(() => {
  const G=globalThis;
  async function output(args,ctx) {
    const {project,mode,source}=ctx;
    if (args.board!==undefined&&args.panel!==undefined) throw Error("Choose a PCB or a panel, rather than both.");
    if (args.date!==undefined&&!Number.isFinite(new Date(args.date).getTime())) throw Error("Choose a valid ODB++ creation date.");
    const host=source==="editor" ? G.AtriumNavHost : null;
    const documents=host?.documentRefs?.()||project.documents;
    const match=(d,id)=>d.id===id||d.name===id;
    const panel=args.panel===undefined?null:documents.find(d=>d.kind==="panel"&&match(d,args.panel));
    const board=args.panel!==undefined?null:documents.find(d=>d.kind==="pcb"&&(args.board===undefined||match(d,args.board)));
    if (args.panel!==undefined&&!panel || !board&&!panel) throw Error("Choose a PCB or panel in this project.");
    const result={format:"ODB++ Design 8.1",target:panel?.name??board?.name,units:args.units??"mm"};
    const options={date:args.date,origin:args.origin,units:args.units,variant:args.variant,documentId:board?.id,panelId:panel?.id,
      omitUnconnectedMidLayerPads:args.omitUnconnectedMidLayerPads,odbEnabled:true};
    if (mode!=="write") return {result};
    if (source==="mcp")
      return {result:{...result,publication:{options,maxBytes:G.AtriumButter.fileByteLimit}}};
    const worker=await G.AtriumLazy.need("AtriumTranslatorClient");
    const folder=host?.folderProject?.();
    const check=()=>{
      if (!ctx.isCurrent()) throw Object.assign(Error("The project changed before ODB++ output started."),{code:"stale_source"});
    };
    check();
    await folder?.ensureDocument((panel||board).id,{purpose:"ODB++ fabrication"});
    check();
    const r=await worker.export("odb",host.project(),options), file=r.files[0];
    check();
    return {result:{...result,...r.details,report:r.report},file:{name:file.name,data:new Uint8Array(file.bytes),binary:true}};
  }
  G.AtriumButter.register("odb",{export:output});
})();
