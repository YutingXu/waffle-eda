"use strict";

// The editor supplies trusted selections and resolves the actual drop target.
globalThis.AtriumDropEditor = (() => {
  const G = globalThis, D = G.AtriumDrop, L = G.AtriumLazy;
  const enabled = () => G.AtriumPrefs?.get("butter.drop") === true;
  const type = "application/x-waffle-drop";
  let pending, offered;
  // The drop-target language and transfer status (drop-ui.js, lazy).
  L.register("AtriumDropUI", {scripts:["editor/drop-ui.js"], css:["editor/drop-ui.css"]});
  const ui = () => G.AtriumDropUI;
  L.need("AtriumDropUI").then(module => module.install(), error => G.console?.warn?.(error));

  function offer(event, source, prepare) {
    if (!enabled() || !event?.isTrusted || event.type !== "dragstart" || !event.dataTransfer) return false;
    const host = G.AtriumNavHost, project = host.project(), token = crypto.randomUUID();
    offered = {source:{...source,projectId:project.id}, token, project, revision:host.revision(), prepare};
    event.dataTransfer.setData(type,token);
    event.dataTransfer.effectAllowed = "copy";
    event.target.addEventListener("dragend",()=>{
      if (offered?.token === token) offered = null;
    },{once:true});
    return true;
  }

  async function receive(host, receiver, source, target, scope, signal) {
    const ticket = receiver.capture(source,target,scope);
    const cancel = () => receiver.cancel(ticket);
    pending?.();
    pending = cancel;
    const key = event => {if (event.key === "Escape") cancel();};
    const offProject = host.on("replace",cancel), offDoc = host.on("document",cancel);
    const offEdit = host.on("change",cancel);
    const offPrefs = G.AtriumPrefs.on("butter.drop",()=>{if (!enabled()) cancel();});
    document.addEventListener("keydown",key,true);
    signal?.addEventListener("abort",cancel,{once:true});
    if (signal?.aborted) cancel();
    const approve = ui()?.track({receiver,ticket,cancel}) ?? (()=>true);
    let outcome, failure;
    try {
      return outcome = await receiver.apply(ticket,approve);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      ui()?.settle(outcome,failure);
      document.removeEventListener("keydown",key,true);
      signal?.removeEventListener("abort",cancel);
      offProject?.();
      offDoc?.();
      offEdit?.();
      offPrefs?.();
      if (pending === cancel) pending = null;
    }
  }

  function report(host,error) {
    if (error.name !== "AbortError" && !["cancelled","consent_required","stale_target"].includes(error.code))
      host.info(error.message);
  }

  const editPlan = change => ({apply:({commit})=>{commit(); return change();}});
  function place(host,doc,point,definition,library) {
    const A = G.Atrium, project = host.project();
    let instance;
    const accepted = host.edit(()=>{
      const def = library ? G.AtriumLibrary.addFromLibrary(library,definition,project) : definition;
      if (!A.geometries(def,doc.kind)) throw Error("This component has no symbol or footprint for this editor.");
      instance = A.instantiate(project,def,point.map(value=>A.snap(value,doc.grid)));
      doc.items.push(instance);
    },"Place library component",undefined,{documents:[doc.id],items:[]});
    if (accepted && host.doc()===doc && doc.items.includes(instance)) host.select([instance.id]);
    return !!accepted;
  }

  async function reference(event, host, target) {
    const packet = offered, doc = host.doc();
    if (!enabled() || !packet || !event?.isTrusted || event.token !== packet.token) return false;
    offered = null;
    const current = () => host.project() === packet.project && host.doc() === doc && host.revision() === packet.revision;
    if (!current()) return false;
    const args = {documentId:doc.id,...target.args};
    const command = (route, options) => ({apply:async ({commit})=>{
      const editor = await L.need("AtriumButterEditor");
      return editor.apply(route,options,{beforeCommit:commit});
    }});
    const source = packet.source;
    const receiver = D.createReceiver({enabled,current,handlers:{
      "place-library": async ({target,signal,check}) => {
        const result = packet.prepare ? await packet.prepare(signal) : {def:host.defs().get(source.id)};
        check();
        if (!G.Atrium.geometries(result?.def,doc.kind)) throw Error("This component has no symbol or footprint for this editor.");
        return editPlan(()=>place(host,doc,target.point,result.def,result.lib));
      },
      "scope-rule": () => command("butter.drop.scope-rule",{...args,ruleId:target.id,netId:source.id}),
      "bind-calculation": () => command("butter.drop.bind-calculation",{...args,calculationId:target.id,
        partId:source.id,partDocumentId:source.documentId}),
      "resolve-result": () => ({apply:async ({commit})=>{
        const result = await G.AtriumButter.run("butter.drop.resolve-result",
          source.kind === "object-link" ? {link:source.id} : {objectId:source.id,documentId:source.documentId,projectId:packet.project.id});
        const found = result.result?.target;
        if (result.result?.status !== "found" || !found?.documentId) return false;
        commit();
        await host.selectDocument(found.documentId);
        if (host.project() !== packet.project || host.doc()?.id !== found.documentId) return false;
        const selected = host.doc().items.find(item=>item.id===(found.presentedId ?? found.objectId));
        if (!selected) return false;
        host.select([selected.id]);
        host.zoomTo(G.Atrium.bounds(G.Atrium.itemPoints(selected,host.defs().get(selected.def),host.doc().kind)));
        return true;
      }}),
      "paste-entry": () => command("butter.visualHistory.clipboard-paste",{entry:source.id,
        documentId:doc.id,x:target.point[0],y:target.point[1]}),
      "transfer-tab": () => command("butter.windows.move-tab-to-new-window",{tab:source.id})
    }});
    try {return await receive(host,receiver,source,target,doc);}
    catch (error) {report(host,error); return false;}
  }

  async function prepareModel(host, hit, input, signal) {
    const def = host.defs().get(hit.item.def);
    const client = await L.need("AtriumTranslatorClient");
    const result = await client.import([input],{translator:"step",transferInput:true,signal});
    const read = result.provenance?.files?.[0], mesh = result.provenance?.mechanical?.mesh;
    if (!read?.bytes || mesh?.error) throw Error(mesh?.error || "The STEP model could not be read.");
    const next = G.AtriumDropData.model(def.footprint.model3d,input.name,new TextDecoder().decode(read.bytes));
    const step = await L.need("AtriumSTEPImport");
    if (mesh) step.remember(next.stepText,mesh);
    return editPlan(()=>host.edit(()=>{def.footprint.model3d = next;},"Attach STEP model"));
  }

  async function prepareLibrary(host,doc,point,file,signal,check,load) {
    await L.need(["AtriumDesignReader","AtriumLibrary"]);
    check();
    if (load) {
      const input = await D.readBytes(file,{signal,load:signal=>load(file,signal)});
      check();
      file = {name:input.name,size:input.size,arrayBuffer:async()=>input.bytes.buffer};
    }
    const library = await G.AtriumDesignReader.readLibrary(file,{signal,check});
    const candidates = library.defs.filter(def=>G.Atrium.geometries(def,doc.kind));
    if (candidates.length !== 1) throw Error(candidates.length ? "Open the library and drag a single component onto the canvas." :
      "The library has no component for this editor.");
    return editPlan(()=>place(host,doc,point,candidates[0],library));
  }

  function destination(event,host,attachments,kinds) {
    const {clientX,clientY} = event, doc = host.doc(), canvas = host.canvas();
    const hit = event.target === canvas && canvas && host.hit(canvas,clientX,clientY);
    if (!hit || hit.doc !== doc) return {target:{kind:"workspace"}};
    const editable = host.folderProject?.()?.canEdit?.(doc.id) !== false;
    if (kinds.every(kind=>kind === "library") && editable && ["pcb","schematic"].includes(doc.kind))
      return {target:{kind:doc.kind === "pcb" ? "board" : "sheet",point:hit.point},hit};
    if (kinds.length === 1 && editable) {
      const [kind] = kinds, item = hit.item, datasheets = G.AtriumPrefs?.get("butter.datasheets") === true;
      if (kind === "step" && doc.kind === "pcb" && item?.kind === "part" && host.defs().get(item.def)?.footprint)
        return {target:{kind:"part",id:item.id},hit};
      if (kind === "csv" && doc.kind === "schematic" && item?.widget?.type === "table")
        return {target:{kind:"table",id:item.id},hit};
      const notebook = attachments() && host.folderProject?.();
      if (doc.kind === "schematic" && (kind === "pdf" && (datasheets || notebook) || kind === "image" && notebook))
        return {target:{kind:"sheet",point:hit.point},hit,datasheets};
    }
    return {target:{kind:"workspace"},hit};
  }

  async function handle(event,host,attachments,{load,signal}={}) {
    if (!enabled() || !event.isTrusted || !event.files.length) return false;
    const doc = host.doc(), project = host.project(), revision = host.revision(), canvas=host.canvas();
    const live = () => host.doc() === doc && host.project() === project && host.revision() === revision && host.canvas() === canvas;
    let kinds, files = event.files;
    // A mixed offer keeps the usable files and reports the rest with the original count.
    const unsupported = files.filter(file=>{
      try {D.fileMetadata(file,!!load); return false;} catch (error) {return error.code === "unsupported_type";}
    });
    if (unsupported.length && unsupported.length < files.length) {
      files = files.filter(file=>!unsupported.includes(file));
      ui()?.summary({total:event.files.length,accepted:files.length,unsupported:unsupported.map(file=>file.name)});
    }
    try {kinds = files.map(file=>D.fileMetadata(file,!!load).kind);}
    catch (error) {
      if (error.code === "unsupported_type") return false;
      report(host,error);
      return true;
    }
    const {target,hit,datasheets} = destination(event,host,attachments,kinds);
    const route = D.routeFor(target,kinds);
    if (!route || load && route === "open-design") return false;
    const media = async ({inputs}) => {
      const ui = await L.need("AtriumNotebookImageUI");
      return {apply:({signal,commit})=>ui.insert({host,file:files[0],point:hit.point,signal,approved:inputs[0],beforeCommit:commit})};
    };
    const receiver = D.createReceiver({enabled,current:live,delegate:["open-design","place-library"],load,handlers:{
      "open-design":()=>({apply:({signal,commit,check})=>host.openFiles(files,{drop:true,signal,beforeCommit:commit,current:check})}),
      "insert-pdf":async args=>{
        if (!datasheets) return media(args);
        const service = await L.need("AtriumDatasheets"), {bytes,name} = args.inputs[0];
        return {apply:({signal,commit})=>service.referenceBytes({host,bytes,name,signal,current:live,beforeCommit:commit})};
      },
      "insert-image":media,
      "place-library":({signal,check})=>prepareLibrary(host,doc,hit.point,files[0],signal,check,load),
      "attach-model":({inputs,signal})=>prepareModel(host,hit,inputs[0],signal),
      "import-table":({inputs})=>{
        const item = hit.item, prepared = G.AtriumDropData.table(item,inputs[0].bytes);
        return editPlan(()=>host.edit(()=>{item.widget.state=prepared.state;},"Import CSV into table",[item],
          {documents:[doc.id],items:[item.id]}));
      }
    }});
    try {await receive(host,receiver,{files},target,{hit},signal);}
    catch (error) {report(host,error);}
    return true;
  }

  return Object.freeze({handle,offer,reference,type});
})();
