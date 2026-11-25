"use strict";
if (!globalThis.AtriumBase64 && typeof require === "function") require("../core/base64.js");
globalThis.AtriumProjectArchiveUI = (() => {
  const G=globalThis, S=G.AtriumImportSidecars, Z=G.AtriumProjectArchive, R=G.AtriumImportReports;
  const utf8=new TextEncoder(), decode=new TextDecoder("utf-8",{fatal:true});
  const check=(ok,message)=>{if(!ok)throw Error(message);};
  const folderOf=host=>{const s=host?.folderProject?.();check(s,"Save the project to a Waffle folder first.");return s;};
  const stop=signal=>signal?.throwIfAborted();
  function unpack(v) {
    v=v?.data??v?.bytes??v;
    if(typeof v!=="string")return v instanceof Uint8Array?v:new Uint8Array(v);
    return G.AtriumBase64.decode(v);
  }
  const packed = G.AtriumBase64.encode;
  async function sidecarPlan({host,entries,prior=[],read,signal}) {
    const was=[],previous=new Map();
    for(const ref of prior) {
      const file=await read(ref.path);check(file!=null,"Missing retained index: "+ref.path);
      const bytes=unpack(file),binding=S.parse(bytes,ref);was.push(binding);previous.set(ref.path,{bytes,binding});
    }
    // A new import can be added before the existing reports have ever been opened.
    if(!entries && was.length && !R.capture()?.loadedRetained)R.installRetained(host.fileSession(),was.map(S.restore));
    // Persist authorized input bytes. Repository membership is never part of a save plan.
    const prepared=await S.prepare(entries || R.retained(),{signal});
    const now=prepared.refs.map(r=>S.parse(prepared.files.get(r.path),r)),plan=[];
    const indexes=new Map(now.map(binding=>[binding.ref.path,binding])),logicalHashes=new Map();
    const oldIgnore=await read(S.IGNORE);
    if(oldIgnore==null)plan.push({path:S.IGNORE,expected:null,text:S.ignoreText});
    for(const [path,data] of prepared.files) {
      stop(signal);
      const before=previous.get(path),old=before?.bytes??await read(path);
      const current=old==null?null:await S.sha(unpack(old)),next=await S.sha(data);
      if(current===next)continue;
      const after=indexes.get(path);
      if(before && after){
        // Another scope can be saved beside an older representation or a CRLF checkout.
        // Its exact physical bytes and its previous logical identity both survive the save.
        const raw=before.bytes;
        const logical=raw.includes(13)?await S.sha(utf8.encode(decode.decode(raw).replace(/\r\n/g,"\n"))):current;
        if(logical===next || (S.canonical(before.binding.inputs)===S.canonical(after.inputs) &&
            S.canonical(before.binding.metadata)===S.canonical(after.metadata))){
          logicalHashes.set(path,logical);
          continue;
        }
      }
      const source=path.endsWith("/source");
      if(source && current!==null)throw Error("The stored original differs from its digest: "+path);
      plan.push(source ? {path,expected:current,data:packed(data)} : {path,expected:current,text:decode.decode(data)});
    }
    for(const path of S.removed(was,now)){
      const old=await read(path); if(old==null)continue;
      const digest=await S.sha(unpack(old));
      if(path.endsWith("/source") && digest!==path.split("/").at(-2))throw Error("Changed retained source preserved: "+path);
      plan.push({path,expected:digest,remove:true});
    }
    const identities=new Map();
    for(const b of now){
      identities.set(b.ref.path,logicalHashes.get(b.ref.path)??await S.sha(prepared.files.get(b.ref.path)));
      for(const m of S.dependencies(b))identities.set(m.path,m.sha256);
    }
    return {refs:prepared.refs,plan,members:[...identities].map(([path,sha256])=>({path,sha256}))};
  }
  async function restoreSidecars({host,session,refs,lease,signal}) {
    const entries=[];
    for(const ref of refs) {const [f]=await lease.read([ref.path],{signal,purpose:"import report"});entries.push(S.restore(S.parse(unpack(f),ref)));}
    if(host.fileSession()!==session)throw Error("The project changed while loading import reports.");
    R.installRetained(session,entries);
  }
  async function originalFiles(binding,{host=G.AtriumNavHost,signal,lease:inLease}={}) {
    const lease=inLease||await folderOf(host).readLease({signal,purpose:"retained original"});
    try {
      return await S.originalFiles(binding,async r=>{
        stop(signal);
        if(r.git && G.AtriumHost?.folderReadImportSource){
          const v=await G.AtriumHost.folderReadImportSource({grant:lease.grant,lease:lease.lease,bindingPath:binding.ref.path,inputId:r.id});
          return unpack(v);
        }
        const [f]=await lease.read([r.sourcePath],{signal,purpose:"retained original"});return unpack(f);
      },signal);
    }finally{if(!inLease)await lease.release();}
  }
  async function useOriginal(entry, action, {host,signal}) {
    const session=host.fileSession(),working=host.project(), files=entry.index ? await originalFiles(entry.index,{host,signal}) : entry.provenance.files;
    check(session===host.fileSession(),"The project changed while reading the original.");
    const identityBindings = entry.provenance.identityBindings;
    if(action==="open"){
      const input=files.map(f=>{const file=new File([f.bytes],f.name);if(f.path)Object.defineProperty(file,"altiumPath",{value:f.path});return file;});
      return host.openFiles(input,{identityBindings});
    }
    const [client,viewer]=await G.AtriumLazy.need(["AtriumTranslatorClient","AtriumDiffView"]);
    const original=await client.import(files,{translator:entry.report.translator,identityBindings,signal});
    check(session===host.fileSession(),"The project changed during original comparison.");
    return viewer.start({project:original.model,label:"Imported original"},{project:working,working:true,label:"Working design"});
  }
  async function acquireSavedExportSnapshot({project,signal,host=G.AtriumNavHost}) {
    check(project && host.project()===project,"The selected project changed before export.");
    const folder=folderOf(host), lease=await folder.readLease({signal,purpose:"project ZIP"});
    let ended=false;
    async function release() { if(!ended){ended=true;signal?.removeEventListener("abort",release);await lease.release();} }
    signal?.addEventListener("abort",release,{once:true});
    try {
      stop(signal);
      const saved=await folder.requireClosure({purpose:"saved export",signal,saved:true,assets:false,lease});
      const members=new Map(saved.members.map(m=>[m.path,unpack(m)]));
      async function readBatch(paths,{signal:requestSignal=signal}={}) {
        stop(requestSignal);stop(signal);
        const missing=paths.filter(path=>!members.has(path));
        if(missing.length){
          const files=await lease.readBatch(missing,{signal:requestSignal,purpose:"project ZIP"});
          for(const [index,path] of missing.entries())members.set(path,unpack(files[index]));
        }
        return paths.map(path=>members.get(path));
      }
      const read=async(path,opts)=>(await readBatch([path],opts))[0];
      const [ignoreFile]=await lease.read([S.IGNORE],{signal,optional:true,purpose:"saved export"});
      members.set(S.IGNORE,ignoreFile==null?utf8.encode(S.ignoreText):unpack(ignoreFile));
      const snapshotId=G.crypto?.randomUUID?.() || G.Atrium.id(), projectCopy=saved.project;
      async function archiveSnapshot(archiveSignal) {
        // A PDF with no attached project needs its saved owners and the images actually used.
        // Only an explicit ZIP request traverses frozen revisions, models and original inputs.
        const checked=await Z.verifyClosure({manifestPath:saved.manifestPath,read,readBatch,signal:archiveSignal,
          original:async(binding,row)=>{
            if(!folder.temporary && G.AtriumHost?.folderReadImportSource)return unpack(await G.AtriumHost.folderReadImportSource({
              grant:lease.grant,lease:lease.lease,bindingPath:binding.ref.path,inputId:row.id}));
            return read(S.logical(row.sha256),{signal:archiveSignal});
          }});
        return Z.archive({...checked,snapshotId,read:async p=>checked.files.get(p)??read(p,{signal:archiveSignal})},{signal:archiveSignal});
      }
      async function resolveAsset({owner,ref,purpose="export",signal:assetSignal}){
        const ownerId=typeof owner==="string"?owner:owner?.documentId||owner?.id;
        stop(assetSignal);stop(signal);check(!ended && host.folderProject()===folder,"The saved export snapshot is stale.");
        check(ownerId && ref && /^[a-f0-9]{64}$/.test(ref.sha256) && Number.isSafeInteger(ref.byteLength) &&
          ref.byteLength>=0 && ref.byteLength<=Z.bounds.entryBytes && typeof ref.mediaType==="string","Invalid saved asset request.");
        const native=G.AtriumHost;
        if (folder.temporary) {
          const bytes = await read("assets/"+ref.sha256,{signal:assetSignal});
          check(bytes.length === ref.byteLength && await S.sha(bytes) === ref.sha256 && !ended,"The saved asset identity changed.");
          return {...ref,bytes,snapshotId};
        }
        check(native?.folderReadAsset,"Saved owner-bound asset reads are unavailable.");
        const result=new Uint8Array(ref.byteLength);let offset=0;
        do {
          stop(assetSignal);stop(signal);check(!ended,"The saved export snapshot is stale.");
          const chunk=await native.folderReadAsset({grant:lease.grant,lease:lease.lease,ownerId,assetRef:ref,purpose,offset,length:Math.min(1048576,Math.max(1,ref.byteLength-offset))});
          const part=unpack(chunk);
          check(chunk.offset===offset && part.length===chunk.length && part.length<=ref.byteLength-offset &&
            (part.length || chunk.eof===true),"Invalid saved asset chunk.");
          result.set(part,offset);offset+=part.length;
          check(chunk.eof===(offset===ref.byteLength),"Incomplete saved asset response.");
        }while(offset<ref.byteLength);
        check(await S.sha(result)===ref.sha256 && !ended,"The saved asset identity changed.");
        return {...ref,bytes:result,snapshotId};
      }
      return {project:projectCopy,snapshotId,release,resolveAsset,async projectArchive({signal:archiveSignal}={}){
        stop(archiveSignal);stop(signal);check(!ended && host.folderProject()===folder,"The saved export snapshot is stale.");
        const result=await archiveSnapshot(archiveSignal||signal);stop(archiveSignal);stop(signal);
        check(!ended && host.folderProject()===folder,"The saved export snapshot is stale.");return result;
      }};
    }catch(e){await release();throw e;}
  }
  function choose(title,description,rows,choices) {
    return new Promise(resolve=>{
      const d=document.createElement("dialog");d.setAttribute("aria-label",title);
      const heading=document.createElement("h2");heading.textContent=title;d.append(heading);
      const desc=document.createElement("p");desc.textContent=description;d.append(desc);
      const select=document.createElement("select");select.className="ui-field";select.setAttribute("aria-label",title);
      if(rows?.length){rows.forEach((r,i)=>select.add(new Option(r,String(i))));d.append(select);}
      const actions=document.createElement("div");
      function finish(result){d.remove();resolve(result);}
      for(const [id,name] of choices){
        const b=document.createElement("button");b.type="button";b.textContent=name;
        b.dataset.variant=id==="all"?"primary":id==="discard"?"danger":"secondary";
        b.onclick=()=>{d.close();finish({id,index:Number(select.value)||0});};actions.append(b);
      }
      d.append(actions);
      AtriumShell.adoptDialog(d,{title:heading,body:[desc,...(rows?.length?[select]:[])],actions,
        initialFocus:rows?.length?select:actions.firstElementChild});
      d.addEventListener("close",()=>finish(null),{once:true});document.body.append(d);d.showModal();
    });
  }
  async function chooseSavedExportSnapshot({project,signal,host=G.AtriumNavHost,purpose="export"}) {
    stop(signal);
    check(project && host.project()===project,"The selected project changed before export.");
    const folder=host.folderProject?.(),zip=purpose==="zip";
    if(!folder){
      const pick=await choose("Save project first",G.AtriumHost?.chooseProjectFolder ?
        "Choose a folder for this project to export a saved version." : "Prepare the saved Waffle project for export.",null,
        [["cancel","Cancel"],["all","Save project…"]]);
      stop(signal);
      if(!pick || pick.id==="cancel")return null;
      check(host.project()===project,"The project changed before saving.");
      const name=project.name,documentIds=project.documents.map(doc=>doc.id);
      if(!await host.saveAll({download:false,nativeOnly:true}))return null;
      // New projects receive their first native project ID on conversion. Use the saved manifest,
      // since inactive documents may still be waiting for their first editor paint.
      const adopted=host.project(),opened=host.folderProject?.();
      const savedIds=new Set(opened?.documents().map(doc=>doc.id));
      check(opened?.project===adopted && adopted.name===name && (!project.id || adopted.id===project.id) &&
        savedIds.size===documentIds.length && documentIds.every(id=>savedIds.has(id)),
        "The new project folder could not be opened for export.");
      return acquireSavedExportSnapshot({project:adopted,host,signal});
    }
    if(host.isDirty()){
      const detail=zip?"Choose the version to include in the ZIP.":"Choose the version to export.";
      const pick=await choose("Use saved project","This project has unsaved changes. "+detail,null,
        [["cancel","Cancel"],["saved",zip?"Zip Last Saved":"Use Last Saved"],["all",zip?"Save All and Zip":"Save All"]]);
      stop(signal);
      if(!pick || pick.id==="cancel")return null;
      check(host.folderProject()===folder && host.project()===project,"The selected project changed before export.");
      if(pick.id==="all" && !await host.saveAll({download:false}))return null;
    }
    return acquireSavedExportSnapshot({project,host,signal});
  }
  async function save({host=G.AtriumNavHost,current=false}={}) {
    const input={project:host.project(),host,purpose:"zip"};
    const lease=await (current ? acquireSavedExportSnapshot(input) : chooseSavedExportSnapshot(input));
    if(!lease)return false;
    try {const result=await lease.projectArchive();const saved=await G.AtriumIO.exportFile(result.name,result.bytes);
      if(saved)host.info("Saved "+result.name+".");return !!saved;}finally{await lease.release();}
  }
  async function discard({host=G.AtriumNavHost}={}) {
    await host.folderProject?.()?.ensureImportReports?.();
    const rows=R.retained(),session=host.fileSession();
    if(!rows.length){host.info("This project has no retained import data.");return false;}
    const pick=await choose("Discard Import Data","Choose one import. Discarding it removes its source comparison, exact re-import, precision residuals and source-assisted export. Your native design and original source files remain available.",
      rows.map(e=>e.names.join(", ")),[["cancel","Cancel"],["discard","Discard selected import"]]);
    if(!pick||pick.id!=="discard")return false;
    check(host.fileSession()===session,"The project changed. Review its import data again.");
    const row=rows[pick.index];
    if(row.index){
      // A portable ZIP can carry a local copy of a Git-pinned input. Remember whichever
      // physical copies this transaction removes so Undo works, including after Save All.
      const lease=await folderOf(host).readLease({purpose:"discard import"});
      try {
        const byHash=new Map();
        for(const [i,input] of row.index.inputs.entries()){
          if(!byHash.has(input.sha256)){
            const [record]=await lease.read([S.logical(input.sha256)],{optional:true,purpose:"discard import"});
            byHash.set(input.sha256,record==null?null:await S.verified(unpack(record),input));
          }
          const bytes=byHash.get(input.sha256);
          if(bytes)S.retainCopy(row.provenance.files[i],bytes);
        }
      }finally{await lease.release();}
    }
    check(host.fileSession()===session,"The project changed. Review its import data again.");
    if(!R.discard(row.scopeId))return false;
    host.folderProject?.()?.markSidecarsDirty?.();
    host.info("Import data discarded. Save All to update the project folder.");return true;
  }
  async function readProjectZIP(file,{signal,install=false,reference=false}={}) {
    check(file.size<=Z.bounds.totalBytes,"The selected ZIP exceeds the project archive size limit.");
    stop(signal);
    const detector=G.AtriumObsoleteProject;
    detector.reject(new Uint8Array(await file.slice(0,detector.limit).arrayBuffer()),file.name);
    const zip=Z.zipDirectory(new Uint8Array(await file.arrayBuffer())),projects=await zip.projects({signal});
    check(projects.length,"This ZIP contains no Waffle format 2 project.");
    if(reference && projects.length===1)return Z.extract(zip,projects[0],Z.verifyClosure,{signal});
    const pick=await choose("Open project ZIP",install ?
      "Extract the selected project into a new folder." : "Open the selected project from the ZIP.",projects.map(p=>p.prefix+p.manifest),
      [["cancel","Cancel"],["open",install ? "Extract and open…" : "Open project"]]);
    if(pick?.id==="open")return Z.extract(zip,projects[pick.index],Z.verifyClosure,{signal});
  }

  async function chooseReference() {
    const file=await G.AtriumIO.pickFile([".zip"]);
    if(!file)return null;
    const verified=await readProjectZIP(file,{reference:true});
    if(!verified)return null;
    const [B,F]=await G.AtriumLazy.need(["AtriumBrowserProject","AtriumFolderProject"]);
    const folder=B.create(verified.manifest,verified.files);
    let session;
    try {
      session=await F.open({...folder,readOnly:true},{host:folder.host});
      const {project}=await session.requireClosure({saved:true,purpose:"comparison",assets:false});
      return {name:file.name,project};
    } finally {await session?.close();}
  }

  async function open(file,{host=G.AtriumNavHost,openFolder,signal}={}) {
    const native=G.AtriumHost;
    const verified=await readProjectZIP(file,{signal,install:!!native?.installProjectArchive});
    if(!verified)return false;
    const result=native?.installProjectArchive ? await native.installProjectArchive({manifest:verified.manifest,version:verified.version,
      files:[...verified.files].map(([path,data])=>({path,data:packed(data)}))}) :
      (await G.AtriumLazy.need("AtriumBrowserProject")).create(verified.manifest,verified.files);
    if(!result)return false;
    const adopt=openFolder||host.openGrantedFolder;
    check(typeof adopt==="function","The archive was extracted. Open its project manifest.");
    return await adopt(result.folderProject||result);
  }

  function chooseBrowserFolder(name) {
    return new Promise(resolve=>{
      const d=document.createElement("dialog"), input=document.createElement("input"), actions=document.createElement("div");
      const title=document.createElement("h2");title.textContent="Open project folder";d.setAttribute("aria-label",title.textContent);
      const detail=document.createElement("p");detail.textContent="Choose the folder containing "+name+".";
      input.type="file";input.multiple=true;input.webkitdirectory=true;input.hidden=true;
      const cancel=document.createElement("button");cancel.type="button";cancel.textContent="Cancel";cancel.onclick=()=>d.close();
      const pick=document.createElement("button");pick.type="button";pick.textContent="Choose folder…";pick.onclick=()=>input.click();
      pick.dataset.variant="primary";
      let files;
      input.onchange=()=>{files=[...input.files];d.close();};input.oncancel=()=>d.close();
      actions.append(cancel,pick);d.append(title,detail,input,actions);
      AtriumShell.adoptDialog(d,{title,body:detail,actions,initialFocus:cancel});
      d.onclose=()=>{d.remove();resolve(files);};document.body.append(d);d.showModal();
    });
  }

  async function openManifest(manifest,files,{openFolder,signal}) {
    const name=Z.portable(manifest.name);
    const obsolete=G.AtriumObsoleteProject;
    check(manifest.size<=Z.bounds.entryBytes,"The selected project file exceeds its size limit.");
    if(manifest.slice)obsolete.reject(new Uint8Array(await manifest.slice(0,obsolete.limit).arrayBuffer()),name);
    if(files.length===1)files=await chooseBrowserFolder(name);
    if(!files?.length)return false;
    stop(signal);
    const entries=new Map(), folded=new Set();
    for(const file of files){
      const path=Z.portable(file.webkitRelativePath?.split("/").slice(1).join("/")||file.name);
      const key=path.normalize("NFC").toUpperCase().toLowerCase();
      check(!folded.has(key),"Two selected project files collide: "+path);
      folded.add(key);entries.set(path,file);
    }
    const chosen=entries.get(name);
    check(chosen && chosen.size===manifest.size && chosen.size<=Z.bounds.entryBytes &&
      await S.sha(await chosen.arrayBuffer())===await S.sha(await manifest.arrayBuffer()),"Choose the folder containing the selected "+name+".");
    async function read(path){
      stop(signal);
      const file=entries.get(path);
      if(!file && path===S.IGNORE)return utf8.encode(S.ignoreText);
      check(file,"Required project file is missing: "+path);
      check(file.size<=Z.bounds.entryBytes,"The selected project file exceeds its size limit.");
      return new Uint8Array(await file.arrayBuffer());
    }
    const verified=await Z.verifyClosure({manifestPath:name,read,signal});
    if(!verified.files.has(S.IGNORE))verified.files.set(S.IGNORE,await read(S.IGNORE));
    return openFolder((await G.AtriumLazy.need("AtriumBrowserProject")).create(name,verified.files));
  }
  return Object.freeze({save,discard,open,openManifest,chooseReference,sidecarPlan,restoreSidecars,originalFiles,useOriginal,chooseSavedExportSnapshot,acquireSavedExportSnapshot});
})();
