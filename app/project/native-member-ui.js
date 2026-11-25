"use strict";

// A loose native member uses the same owner projection and edit/save cursor as a
// folder member. The synthetic index lives in memory and has no filesystem grant.
globalThis.AtriumNativeMemberUI = (() => {
  const F = globalThis.AtriumFormat2, M = globalThis.AtriumFormat2Model;
  const kinds = new Map(Object.entries({...F.documentSuffix,library:".wlib"}).map(([kind, suffix]) => [suffix,kind]));
  const utf8 = new TextEncoder();
  const limit = 256 * 1024 * 1024;
  const suffix = name => /\.[^.]+$/.exec(name ?? "")?.[0]?.toLowerCase();
  const stem = name => name.slice(0,name.lastIndexOf("."));
  const copyName = (name, ext) => name + " copy" + ext;
  function safeName(name, kind) {
    let value = name.slice(0,240).normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g,"-").trim().replace(/[. ]+$/,"");
    if (!value || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)) value = "_" + (value || kind);
    while (utf8.encode(value).length > 200) value = Array.from(value).slice(0,-1).join("");
    return value;
  }
  async function read(file) {
    const ext = suffix(file.name), kind = kinds.get(ext);
    if (!kind || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > limit || typeof file.arrayBuffer !== "function")
      throw Error("Choose one regular Waffle document or component file.");
    let bytes;
    try { bytes = new Uint8Array(await file.arrayBuffer()); }
    catch { throw Error("Waffle cannot read the selected item as a regular file."); }
    if (bytes.byteLength !== file.size) throw Error("The document changed while opening. Select the file again.");
    const record = M.parse(bytes,{kind});
    if (record.header.requires?.includes(F.tableFeature)) await globalThis.AtriumLazy.need("AtriumTableFormat");
    const id = record.header.id, name = safeName(stem(file.name),kind);
    return {record,kind,id,name,ext,bytes,proof:file.nativeCopy};
  }
  function notice(member) {
    const unsupported = F.unsupportedMessage(member.record);
    return unsupported ? "This file is read-only. " + unsupported :
      "This Waffle document is read-only.";
  }
  function reference(member,path) {
    return member.kind === "library" ? {kind:"library",id:member.id,path} :
      {kind:"document",id:member.id,docKind:member.kind,name:member.name,path};
  }
  async function saveBrowser(file, before, next, host) {
    const handle = file.fileHandle;
    if (!handle?.createWritable) {
      if (await host.exportFile(file.name,next.bytes) === false) throw Error("Save cancelled.");
      return {transaction:"download"};
    }
    const current = await handle.getFile();
    if (F.sha256(new Uint8Array(await current.arrayBuffer())) !== before.sha256)
      throw Error("This document changed on disk. Reopen the file before saving.");
    const writer = await handle.createWritable();
    try { await writer.write(next.bytes); await writer.close(); }
    catch (error) { await writer.abort().catch(() => {}); throw error; }
    const written = await handle.getFile();
    if (F.sha256(new Uint8Array(await written.arrayBuffer())) !== next.sha256)
      throw Error("The saved file could not be verified.");
    return {transaction:"browser-document"};
  }
  async function standalone(file, member, ctx) {
    const native = globalThis.AtriumHost, grant = file.standaloneMember;
    if (grant && grant.sha256 !== F.sha256(member.bytes))
      throw Error("The selected file differs from the approved document.");
    const readOnly = !!(grant?.readOnly || member.record.readOnly || member.kind === "library" && member.record.newer || native && !grant);
    const Browser = await AtriumLazy.need("AtriumBrowserProject");
    const {kind,id,name,ext,record,bytes} = member;
    const path = (kind === "library" ? "libraries/" : "") + name + ext;
    const mask = "Project.waffle", originals = new Map([[path,bytes]]);
    const projectId = "loose-" + F.sha256(utf8.encode(id)), refs = [reference(member,path)];
    let entryDocument = id;
    if (kind === "library") {
      const blank = {...Atrium.sheet("schematic","Component"),id:projectId + "/component"};
      entryDocument = blank.id;
      const canvas = "Component.wsch";
      originals.set(canvas,F.serialize(M.createDocument(blank)));
      refs.push(reference({kind:blank.kind,id:blank.id,name:blank.name},canvas));
    }
    const {formatVersion,compatibleWith} = record.header;
    const header = {kind:"project",id:projectId,formatVersion,name,entryDocument};
    if (compatibleWith) header.compatibleWith = compatibleWith;
    originals.set(mask,F.serialize(F.create(header,refs,M.readOptions("project",projectId))));
    const folder = Browser.create(mask,originals,{
      temporary:false, draftScope:grant?.draftScope || null,
      close:grant && (() => native?.nativeMemberClose?.({grant:grant.grant})),
      async commit(previous,next,plan) {
        // A loose file has no grant for its synthetic index, another document or external media.
        if (plan.length !== 1 || plan[0].path !== path || !previous.has(path) || !next.has(path))
          throw Error("This change needs a Waffle project folder.");
        const before = previous.get(path), after = next.get(path);
        if (!grant) return saveBrowser(file,before,after,ctx.host);
        const change = plan[0], update = change.splice && grant.splices ? {splice:change.splice} :
          {data:change.data ?? AtriumFolderDrafts.base64(after.bytes)};
        const reply = await native.nativeMemberCommit({grant:grant.grant,expected:before.sha256,...update});
        if (!reply?.saved || reply.hash !== after.sha256) throw Error(reply?.error || "The saved document could not be verified.");
        return reply;
      }
    });
    folder.readOnly = readOnly;
    folder.standalone = {id,path,kind,name:file.name,nativeGrant:grant?.grant,readOnly,notice:readOnly ? notice(member) : "",
      beforeSave: !grant && typeof file.fileHandle?.requestPermission === "function" ? async () => {
        if (await file.fileHandle.requestPermission({mode:"readwrite"}) !== "granted") throw Error("Write access was not granted.");
      } : null,
      async copyOriginal() {
        const session = ctx.host.folderProject();
        if (session?.standalone !== this) return false;
        try {
          const output = await session.copyStandalone(), outputName = copyName(stem(file.name),ext);
          if (ctx.host.folderProject() !== session) return false;
          if (grant && native?.nativeMemberExportCopy)
            return await native.nativeMemberExportCopy({grant:grant.grant,name:outputName,data:AtriumFolderDrafts.base64(output)});
          if (native && grant) {
            const url = URL.createObjectURL(new Blob([output],{type:"application/octet-stream"}));
            const link = Object.assign(document.createElement("a"),{href:url,download:outputName});
            link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
            return true;
          }
          return await ctx.host.exportFile(outputName,output);
        } catch (error) { ctx.host.info(error.message); return false; }
      }
    };
    if (!await ctx.openFolder(folder)) return false;
    if (kind === "library") await showLibrary(await ctx.host.folderProject().ensureDocument(id),ctx.host,folder.standalone);
    if (readOnly) ctx.host.info(folder.standalone.notice);
    return true;
  }
  async function showLibrary(definition,host,standalone) {
    const catalogue = await AtriumLazy.need("AtriumCatalogue"), session = host.fileSession();
    const current = () => host.project().library.find(d => d.id === definition.id);
    const canEdit = standalone && !standalone.readOnly;
    const body = document.createElement("div");
    catalogue.preview(body,definition,{pins:true});
    if (standalone?.notice) {
      const hint = document.createElement("p");
      hint.textContent = standalone.notice; body.prepend(hint);
    }
    const edit = async (kind,dialog) => {
      const L = await AtriumLazy.need("AtriumLibrary");
      const def = current();
      if (host.fileSession() !== session || !def) return;
      const context = {currentProject:host.project,info:host.info,edit:fn => {
        if (host.fileSession() !== session || !host.edit(fn,"Edit component",null,{documents:[def.id]}))
          throw Error("This Waffle component is read-only.");
        host.saveProject();
      }};
      (kind === "symbol" ? L.openSymbolEditor : L.openFootprintEditor)(context,def);
      dialog.close();
    };
    const actions = [{label:"Close"}];
    if (standalone?.readOnly) actions.unshift({label:"Save Original Copy…",run:() => standalone.copyOriginal()});
    if (canEdit) {
      if (definition.symbol) actions.unshift({label:"Edit Symbol…",run:d => edit("symbol",d)});
      if (definition.footprint) actions.unshift({label:"Edit Footprint…",run:d => edit("footprint",d)});
      actions.unshift({label:"Save",primary:true,run:async () => { await host.saveProject(); return false; }});
    }
    AtriumShell.dialog({title:definition.name,body:[body],actions,sheet:true});
    return true;
  }
  function uniqueName(name, existing) {
    const used = new Set(existing.map(F.pathKey));
    if (!used.has(F.pathKey(name))) return name;
    for (let n = 2;; n++) {
      const next = name + " (" + n + ")";
      if (!used.has(F.pathKey(next))) return next;
    }
  }
  // The copy owns new document/item identities. Only typed local reference fields
  // are rebased. External sheet/library/asset references can remain unresolved.
  const referenceKeys = new Set(["id","item","itemId","object","objectId","document","documentId","doc","docId",
    "board","sheet","view","note","anchorId","polygon","ownerId","sourceItem","targetId","frame","frameId","part","partId",
    "parent","owner","thread","threadId","image","imageId","panel","panelId","track","trackId"]);
  const referenceLists = new Set(["itemIds","objectIds","trackIds","partIds"]);
  function independentDocument(owner,record) {
    const ids = new Map([[owner.id,Atrium.id()]]);
    const allocate = id => { if (typeof id === "string" && id && !ids.has(id)) ids.set(id,Atrium.id()); };
    for (const item of owner.items) allocate(item.id);
    for (const row of record.records()) if (row.kind !== "modelAlias") { allocate(row.id); allocate(row.value?.id); }
    for (const collection of Object.values(owner.drawing || {})) if (Array.isArray(collection))
      for (const child of collection) allocate(child?.id);
    function rebase(value) {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(rebase); return; }
      for (const [key,child] of Object.entries(value)) {
        if (referenceKeys.has(key) && ids.has(child)) value[key] = ids.get(child);
        else if (referenceLists.has(key) && Array.isArray(child)) value[key] = child.map(id => ids.get(id) ?? id);
        else rebase(child);
      }
    }
    rebase(owner);
    return owner;
  }
  async function copy(member,host,options={}) {
    const session = host.fileSession(), project = host.project(), folder = host.folderProject();
    if (folder?.standalone) throw Error("Open a Waffle project folder before adding a document copy.");
    const raw = member.record.readOnly;
    if (raw && !folder) throw Error("Save this project to a Waffle folder before adding a read-only document.");
    if (!raw && (member.record.newer || [...member.record.records()].some(row => member.record.isOpaque(row.id))))
      throw Error("This file needs a newer Waffle reader for an editable copy. Open it to save an unchanged copy.");
    const library = member.kind === "library";
    const owner = library ? M.library(member.record) : M.document(member.record,{name:member.name});
    owner.name ||= member.name;
    const referencedMedia = M.dependencies(member.record).some(ref => ref.kind === "asset" || ref.kind === "model");
    if (!library && !raw) independentDocument(owner,member.record);
    if (library) {
      if (!raw) {
        if (project.library.some(def => def.id === owner.id) || folder?.getDocumentRef(owner.id)) owner.id = Atrium.id();
        owner.name = uniqueName(owner.name || member.name,project.library.map(def => def.name));
      }
    } else {
      await AtriumLazy.need(AtriumLazy.validatorsFor({documents:[owner],library:[]}));
      if (owner.kind === "drawing" && !owner.drawing) owner.drawing = AtriumDrawing.normalize({});
      if (!raw) owner.name = uniqueName(owner.name,host.documentRefs().map(doc => doc.name));
    }
    if (raw && globalThis.AtriumHost && (!member.proof?.grant || member.proof.sha256 !== F.sha256(member.bytes)))
      throw Error("Choose the original file with Add Existing to Project so Waffle can verify the copy.");
    const stage = raw && await folder.prepareNativeCopy(owner,member.kind,member.bytes,member.proof);
    if (host.fileSession() !== session || host.project() !== project) throw Error("The open project changed. Add the file again.");
    options.current?.();
    options.beforeCommit?.();
    const discard = stage && stage();
    let added = false;
    try {
      added = !!host.edit(() => (library ? project.library : project.documents).push(owner),library ? "Add component copy" : "Add document copy");
      if (!added) return false;
    } finally { if (!added && discard) discard(); }
    if (!library) await host.selectDocument(owner.id);
    const message = "Added " + owner.name + " as a copy." + (raw ? " " + notice(member) : "");
    host.info(referencedMedia ? message + " Referenced media stays separate." : message);
    return true;
  }
  async function open(file,{host,openFolder,into,current,beforeCommit}) {
    const anchor = host.fileSession(), project = host.project(), grant = file.standaloneMember?.grant;
    try {
      const member = await read(file);
      current?.();
      if (host.fileSession() !== anchor || host.project() !== project) throw Error("The open project changed. Select the file again.");
      return await (into ? copy(member,host,{current,beforeCommit}) : standalone(file,member,{host,openFolder}));
    } finally {
      if (grant && host.folderProject()?.standalone?.nativeGrant !== grant)
        await Promise.resolve(globalThis.AtriumHost?.nativeMemberClose?.({grant})).catch(() => {});
    }
  }
  async function focusMember(path,host) {
    const session = host.folderProject(), selected = session?.memberAtPath(path);
    if (!selected) return false;
    if (selected.kind !== "library") { await host.selectDocument(selected.id); return true; }
    const component = await session.ensureDocument(selected.id);
    return host.folderProject() === session && showLibrary(component,host,session.standalone);
  }
  async function readComponent(file) {
    const member = await read(file);
    if (member.kind !== "library" || member.record.readOnly || member.record.newer ||
        [...member.record.records()].some(row=>member.record.isOpaque(row.id)))
      throw Error("Choose a Waffle component supported by this version.");
    return {id:member.id,name:member.name,defs:[M.library(member.record)]};
  }
  return Object.freeze({open,showLibrary,focusMember,readComponent});
})();
