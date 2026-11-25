"use strict";

// Commands are data-only. Byte capabilities enter through admitted editor inputs
// or the bound MCP workspace adapter, outside public command arguments.
(() => {
  const G = globalThis, R = G.AtriumDatasheetRecord, L = G.AtriumLinkRecord;
  const fail = (code, message) => {throw Object.assign(Error(message), {code});};
  const copy = value => JSON.parse(JSON.stringify(value));
  const set = (path, before, after) => ({op:"set", target:"project", path, ...(before !== undefined && {before}), after});
  const list = project => project.datasheets ?? [];
  function tableText(rows) {
    let table = "", used = 0;
    for (const row of rows) {
      const line = row.map(cell => '"' + cell.replaceAll('"','""') + '"').join(",");
      if (used >= 4096 || table.length+line.length+1 > 200000) break;
      table += (used ? "\n" : "") + line;
      used++;
    }
    return {table,partial:used < rows.length};
  }

  function reference({grant,sourceURL,version,existingId,embed}, {project,source,services}) {
    const supplied = source === "mcp" ? services.native?.reference : G.AtriumDatasheets.input(grant,project.id);
    if (!supplied) fail("datasheet_grant_required", "Choose and approve the PDF in this workspace first.");
    if (embed === true && !supplied.asset)
      fail("datasheet_grant_required","Approve an exact PDF copy and an editable project before embedding.");
    const info = {...supplied};
    if (sourceURL !== undefined) info.sourceURL = R.safeURL(sourceURL);
    if (version !== undefined) info.version = version;
    if (!R.validateReference(info)) fail("invalid_arguments", "The datasheet metadata is invalid.");
    if (existingId !== undefined) {
      const existing = choose(project,existingId);
      if (existing.sha256 !== info.sha256 || existing.byteLength !== info.byteLength || !info.asset)
        fail("source_changed","Choose the exact original PDF to embed this reference.");
      if (existing.asset) return {result:{reference:existing},ops:[]};
      const next = {...existing,asset:info.asset};
      return {result:{reference:next},ops:[set(["datasheets"],project.datasheets,list(project).map(row=>row.id===existingId?next:row))]};
    }
    const prior = list(project).find(row => row.sha256 === info.sha256 && row.sourceURL === info.sourceURL &&
      row.version === info.version && !!row.asset === !!info.asset);
    if (prior) return {result:{reference:prior},ops:[]};
    const next = {id:G.Atrium.id(),...info};
    return {result:{reference:next},ops:[set(["datasheets"],project.datasheets,[...list(project),next])]};
  }

  function choose(project,id) {
    const ref = list(project).find(row => row.id === id);
    if (!ref) fail("missing_datasheet", "Choose a datasheet referenced by this project.");
    return ref;
  }
  function fragment(project, id, page) {
    const info = R.resolveFragment(project,{objectId:id},{page});
    if (!info) fail("missing_fragment", "Choose a page in the selected datasheet.");
    return {url:L.format({projectId:project.id,objectId:id,fragment:"datasheet:page="+page}),...info};
  }
  function assign({definitionId,id}, {project}) {
    const ref = choose(project,id), def = project.library.find(row=>row.id===definitionId);
    if (!def) fail("missing_object", "Choose a library part in this project.");
    const prior = Object.values(project.links ?? {}).find(link=>link.source.objectId === def.id && link.label === "Datasheet");
    if (prior?.target.objectId===id && prior.target.projectId===project.id) return {result:{record:prior},ops:[]};
    const record = L.authoredRecord({objectId:def.id,kind:"library"},{projectId:project.id,objectId:ref.id,fragment:"datasheet:page=1"},
      "Datasheet",prior?.id);
    return {result:{record},ops:[set(["links",record.id],prior,record)]};
  }
  async function annotate({id,...data}, context) {
    const {project} = context;
    fragment(project,id,data.page);
    const fields = {...data,datasheetId:id};
    if (!R.validateAnnotation(fields)) fail("invalid_arguments", "The page annotation is invalid.");
    const {pages} = await extract("info",{id},context);
    if (!R.pageNumber(pages) || data.page>pages)
      fail("missing_fragment","Choose a page in the selected datasheet.");
    const row = {id:G.Atrium.id(),...fields}, prior = project.datasheetAnnotations;
    return {result:{annotation:row},ops:[set(["datasheetAnnotations"],prior,[...(prior??[]),row])]};
  }
  function annotationList({id,page,offset=0,limit=100},{project}) {
    choose(project,id);
    const rows=(project.datasheetAnnotations??[]).filter(row=>row.datasheetId===id && (page===undefined || row.page===page));
    return {total:rows.length,items:rows.slice(offset,offset+limit)};
  }

  async function extract(op, args, {project,source,isCurrent,services}) {
    const {id,...options} = args, ref = choose(project,id);
    if (source === "mcp") {
      if (services.native?.reference?.sha256 !== ref.sha256 || !services.native.pdf)
        fail("invalid_pdf", "The authorized PDF does not match this reference.");
      return copy(services.native.pdf);
    }
    const reader = G.AtriumDatasheets.createReader(ref,{current:isCurrent,load:G.AtriumDatasheets.loadFor(project.id)});
    try {return await reader[op](options);}
    finally {reader.close();}
  }
  async function pinTable(args, context) {
    const {rows,fields,partial,page} = await extract("table",args,context);
    const wizard = tableText(rows);
    return {rows,fields,partial:partial || wizard.partial,page,wizardInput:{table:wizard.table,delimiter:"csv"}};
  }
  const decode = value => {
    if (Uint8Array.fromBase64) return Uint8Array.fromBase64(value);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const bytes = new Uint8Array(Math.floor(value.replace(/=+$/,"").length*6/8));
    let bits=0, current=0, n=0;
    for (const char of value) {
      if (char==="=") break;
      const digit=alphabet.indexOf(char);
      if (digit<0) fail("invalid_pdf","The PDF raster surface returned invalid bytes.");
      current=(current<<6)|digit; bits+=6;
      if (bits>=8) {bits-=8;bytes[n++]=(current>>bits)&255;}
    }
    return bytes;
  };
  async function snip(args, context) {
    const link = fragment(context.project,args.id,args.page);
    const {png,base64,...image} = await extract("snip",args,context);
    const result = {...image,link:link.url,source:args.id};
    return {result,file:context.mode==="write" && {name:"Datasheet page "+args.page+".png",binary:true,data:png||decode(base64)}};
  }

  G.AtriumButter.register("datasheets",{
    reference, annotate, "assign-part":assign, "list-annotations":annotationList, "pin-table":pinTable, snip,
    list:({offset=0,limit=100},{project})=>({total:list(project).length,items:list(project).slice(offset,offset+limit)}),
    "page-link":({id,page},{project})=>fragment(project,id,page),
    info:(args,context)=>extract("info",args,context),
    text:(args,context)=>extract("text",args,context),
    search:(args,context)=>extract("search",args,context)
  });
})();
