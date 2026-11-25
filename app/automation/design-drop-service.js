"use strict";

// First-party interop commands. All mutations are proposed as normal guarded
// edits so they share the existing edit, Undo, and durable Save paths.
(() => {
  const G = globalThis;
  const copy = value => JSON.parse(JSON.stringify(value));
  const fail = (code, message) => { throw Object.assign(Error(message), {code}); };
  const docOf = (project, id) => project.documents.find(doc => doc.id === id) ||
    fail("missing_document", "The destination document is no longer available.");
  const itemOf = (doc, id, test) => doc.items?.find(item => item.id === id && (!test || test(item))) ||
    fail("missing_object", "The selected object is no longer available.");
  const outputName = (base, extension) => (String(base || "Waffle").replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "-")
    .replace(/^[. ]+|[. ]+$/gu, "").slice(0, 150) || "Waffle") + "." + extension;

  function placeLibrary(args, {project}) {
    const doc = docOf(project,args.documentId);
    const def = project.library.find(row => row.id === args.definitionId);
    if (!["schematic","pcb"].includes(doc.kind) || !G.Atrium.geometries(def, doc.kind))
      fail("unsupported_target", "Choose a component with a symbol or footprint for this editor.");
    const item = G.Atrium.instantiate(project,def,[args.x,args.y]);
    return {result:{documentId:doc.id, definitionId:def.id, objectId:item.id, reference:item.ref},
      ops:[{op:"add", target:"item", document:doc.id, value:item, after_id:doc.items.at(-1)?.id ?? null}]};
  }

  function scopeRule(args, {project}) {
    const doc = docOf(project,args.documentId), R = G.AtriumProjectRules;
    if (doc.kind !== "pcb") fail("unsupported_target", "Choose a rule and net on a board.");
    const book = R.book(project), applicable = R.forBoard(project,doc,book).list;
    const matching = book.list.filter(rule => rule.id === args.ruleId && !R.isErc(rule.type) && R.appliesToBoard(rule,doc.id));
    if (matching.length !== 1 || !applicable.some(rule => rule.id === args.ruleId))
      fail("missing_object", "Choose an unambiguous layout rule on this board.");
    const defs = new Map(project.library.map(def => [def.id,def]));
    const nets = G.AtriumSignals.model(project,doc,{defs});
    const selected = nets.index.pinsOf.has(args.netId) || nets.byNet.has(args.netId) ||
      doc.items.some(item => item.net === args.netId);
    if (!selected) fail("missing_object", "The selected net is no longer available.");
    const scope=G.AtriumDesignQueryRecord.selector("net",args.netId), index=book.list.indexOf(matching[0]);
    const draft={...project,documents:project.documents.map(row=>({...row,
      ...(row.drcWaivers && {drcWaivers:copy(row.drcWaivers)})}))};
    R.edit(draft,next=>{next.list[index].scope=scope;});
    const ops=[{op:"set",target:"project",path:["rules"],
      ...(project.rules && {before:copy(project.rules)}),after:draft.rules}];
    for (const [i,next] of draft.documents.entries()) {
      const prior=project.documents[i].drcWaivers;
      if (prior && JSON.stringify(prior)!==JSON.stringify(next.drcWaivers))
        ops.push({op:"set",target:"document",id:next.id,path:["drcWaivers"],before:copy(prior),after:next.drcWaivers});
    }
    return {result:{ruleId:draft.rules.list[index].id,net:args.netId,scope},ops};
  }

  function resolveResult(args,{project}) {
    if (args.projectId && args.projectId !== project.id) return {status:"missing-project"};
    if (args.link) return G.AtriumLinks.resolve(project,args.link);
    const doc = docOf(project,args.documentId);
    const item = itemOf(doc,args.objectId);
    return {status:"found", target:{documentId:doc.id, objectId:item.id, kind:item.kind}};
  }

  function authorizedFile(context, expected) {
    const file = context.services.native?.file;
    if (!file || typeof file.data !== "string")
      fail("ungranted_source", "Select a regular file using the host before applying this import.");
    const text = atob(file.data), bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    const meta = G.AtriumDrop.fileMetadata({name:file.name,size:bytes.length});
    if (meta.kind !== expected) fail("invalid_payload", "The selected file has the wrong type.");
    return {name:file.name,bytes};
  }

  function attachModel(args,context) {
    const doc = docOf(context.project,args.documentId), part = itemOf(doc,args.partId,item=>item.kind==="part");
    const def = context.project.library.find(row=>row.id===part.def);
    if (doc.kind !== "pcb" || !def?.footprint) fail("unsupported_target", "Choose a board component with a footprint.");
    const {name,bytes} = authorizedFile(context,"step");
    const read = G.AtriumIO.read(name,bytes).modelFile;
    const mesh = G.AtriumSTEPImport.ensure(read.stepText);
    if (mesh.error) fail("invalid_payload",mesh.error);
    const previous = def.footprint.model3d;
    const model = G.AtriumDropData.model(previous,name,read.stepText);
    const result = {documentId:doc.id,partId:part.id,definitionId:def.id,source:name};
    return {result, ops:[{op:"set",target:"library",id:def.id,path:["footprint","model3d"],
      ...(previous && {before:copy(previous)}),after:model}]};
  }

  function importTable(args,context) {
    const doc=docOf(context.project,args.documentId);
    if (doc.kind !== "schematic") fail("unsupported_target", "Choose a schematic table.");
    const item=itemOf(doc,args.tableId,candidate=>candidate.widget?.type==="table");
    const {name,bytes}=authorizedFile(context,"csv");
    const {state,rows,columns}=G.AtriumDropData.table(item,bytes);
    return {result:{documentId:doc.id,tableId:item.id,source:name,rows,columns},ops:[{
      op:"set",target:"item",document:doc.id,id:item.id,path:["widget","state"],
      before:copy(item.widget.state),after:state
    }]};
  }

  function bindCalculation(args,{project}) {
    const doc=docOf(project,args.documentId), R=G.AtriumCalculationRecords;
    const item=itemOf(doc,args.calculationId,i=>R.isBlock(i)), record=R.read(item);
    const sourceDoc=docOf(project,args.partDocumentId);
    const part=itemOf(sourceDoc,args.partId,i=>i.kind==="part");
    const target={scope:"item",docId:sourceDoc.id,itemId:part.id,field:args.field ?? "value"};
    const span=[args.start,args.end];
    if (span[0]>=span[1] || span[1]>record.source.length)
      fail("invalid_target", "Choose a reference inside the calculation.");
    const evaluated=G.AtriumCalculations.evaluateExpressionSnapshot(project,{source:record.source,
      previousSource:record.source,bindings:record.bindings,documentId:doc.id,
      choices:[{span,target}],pinnedFunctions:record.functions});
    const chosen=evaluated.references?.find(row=>row.span[0]===span[0] && row.span[1]===span[1]);
    const resolved=chosen && G.AtriumNoteFields.resolve(project,sourceDoc,chosen.name,target);
    if (!chosen?.target || !resolved || resolved.broken || resolved.raw == null || resolved.raw === "")
      fail("invalid_target", "Choose a readable component field and an exact calculation reference.");
    const metadata=item.kind==="textframe" ? item.calculation : record, prior=metadata.bindings;
    const binding=evaluated.bindings.find(row=>row.id===chosen.id);
    const next={...copy(metadata),bindings:[...(prior || []).filter(row=>row.span[0]!==span[0] || row.span[1]!==span[1]),binding]};
    const proposed=item.kind==="textframe" ? {...item,calculation:next} : next;
    if (!binding || !R.valid(proposed)) fail("invalid_payload", "The new binding is invalid.");
    const path=item.kind==="textframe" ? ["calculation","bindings"] : ["bindings"];
    return {result:{documentId:doc.id,calculationId:item.id,partId:part.id,field:target.field},
      ops:[{op:"set",target:"item",document:doc.id,id:item.id,path,
        ...(prior !== undefined && {before:copy(prior)}),after:next.bindings}]};
  }

  function exportBOM(args,{project,mode}) {
    const bom = G.AtriumBOM;
    const report = bom.report(project,{view:args.view, titleBlock:args.titleBlock === true,
      now:"1970-01-01T00:00:00Z", date:project.revision?.date?.slice(0,10) || "—"});
    const name = outputName(project.name + "-BOM","csv");
    return {result:{name, lines:report.lineCount, parts:report.totalParts},
      ...(mode === "write" && {file:{name,data:bom.csv(report)}})};
  }

  async function exportFrame(args,context) {
    const V = G.AtriumSavedViews;
    const doc = await V.loadDocument(context,args.documentId,"Frame PDF");
    if (V.documentStatus(doc) !== "ready") fail("missing_document", "The frame's document is unavailable.");
    if (doc.kind !== "schematic") fail("unsupported_target", "Choose a frame on a schematic sheet.");
    const frames = G.AtriumSchObjects;
    const frame = itemOf(doc,args.frameId,frames.isFrame);
    const name = outputName(frame.text || doc.name,"pdf");
    const result = {name, documentId:doc.id, frameId:frame.id};
    if (context.mode !== "write") return {result};
    const job = {documentId:doc.id, infinite:true, frame, title:frame.text || doc.name,
      box:frames.frameBounds(frame)};
    return V.preparePDF(context,{feature:"drop",presentation:[job],attachments:false}, print =>
      ({result:{...result,notes:print.notes}, file:{name,data:print.bytes(),binary:true}}));
  }

  function exportSelection(args,{project,mode,documentId,selection}) {
    const doc = docOf(project,args.documentId ?? documentId), ids = args.objectIds ?? selection;
    if (!ids.length || ids.length > 1000 || !["schematic","pcb"].includes(doc.kind))
      fail("invalid_selection", "Choose one to 1,000 selected schematic or board objects.");
    const wanted = new Set(ids), items = doc.items.filter(item => wanted.has(item.id));
    if (items.length !== wanted.size) fail("missing_object", "The selection no longer matches this document.");
    if (args.format === "link") {
      if (items.length !== 1) fail("invalid_selection", "Choose one object for a project link.");
      const link = G.AtriumLinks.format({projectId:project.id, objectId:items[0].id});
      if (!link) fail("invalid_selection", "This selection has no durable project link.");
      const name = outputName(doc.name + "-selection","txt"), result = {name, link, documentId:doc.id};
      return {result,...(mode === "write" && {file:{name,data:link+"\n"}})};
    }
    const format=args.format ?? "svg", name=outputName(doc.name + "-selection",format);
    const result={name,count:items.length,documentId:doc.id};
    if (mode !== "write") return {result};
    const defs = new Map(project.library.map(def => [def.id,def]));
    const cropped = {...doc, items, outline:[]};
    const [left,top,right,bottom] = G.Atrium.docBounds(cropped,defs);
    const margin = Math.max(right-left,bottom-top,1) * .04;
    const w = right-left+2*margin, h = bottom-top+2*margin;
    const width = args.width ?? 1600, height = Math.max(16,Math.min(3200,Math.round(width*h/w)));
    function paint(target) {
      const ratio=Math.min(4,Math.max(1,G.devicePixelRatio || 1));
      // Output surfaces have no layout box. The renderer still uses the
      // display ratio, so size the logical viewport to yield the requested pixels.
      const surface={
        get width(){return target.width;}, set width(value){target.width=value;},
        get height(){return target.height;}, set height(value){target.height=value;},
        getContext:kind=>target.getContext(kind),
        getBoundingClientRect:()=>({width:width/ratio,height:height/ratio})
      };
      const canvas=G.AtriumCanvas.create(surface), scale=Math.min(width/w,height/h)/ratio;
      canvas.restoreCamera({cx:(left+right)/2,cy:(top+bottom)/2,scale,referenceScale:scale});
      canvas.render(cropped,defs,{project,grid:false,origin:false,showUnrouted:false,purpose:"print"});
    }
    const metadata={...result,width,height};
    if (format==="png") {
      const bitmap=G.document?.createElement("canvas");
      if (typeof bitmap?.toBlob!=="function")
        fail("desktop_renderer_required","PNG needs a desktop canvas.");
      bitmap.width=width; bitmap.height=height;
      paint(bitmap);
      return new Promise((resolve,reject)=>bitmap.toBlob(blob=>blob ? resolve(blob) : reject(Error("The selection image could not be encoded.")),"image/png"))
        .then(async blob=>({result:metadata,file:{name,data:new Uint8Array(await blob.arrayBuffer()),binary:true}}));
    }
    const record=G.AtriumPDF.recorder(width,height);
    paint(record.canvas);
    return {result:metadata,file:{name,data:G.AtriumPDF.svg(width,height,record.list)}};
  }

  G.AtriumButter.register("drop", {
    "inspect": (args) => G.AtriumDrop.describe(args.source,args.target),
    "open-design": (args, context) => context.services.native?.opened ??
      fail("ungranted_source", "Select a native project or source inputs through the host."),
    "place-library": placeLibrary,
    "scope-rule": scopeRule,
    "bind-calculation": bindCalculation,
    "attach-model": attachModel,
    "import-table": importTable,
    "resolve-result": resolveResult,
    "export-bom": exportBOM,
    "export-frame": exportFrame,
    "export-selection": exportSelection
  });
})();
