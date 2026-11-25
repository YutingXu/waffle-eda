"use strict";
// Ordinary ZIP, with explicit project discovery. Only the validated transitive closure is
// installed. Read access is provided by one snapshot lease or by this immutable ZIP buffer.
globalThis.AtriumProjectArchive = (() => {
  const G=globalThis, side=()=>G.AtriumImportSidecars, Z=()=>G.AtriumZip;
  const bounds=Object.freeze({entries:10000,entryBytes:256*1048576,totalBytes:512*1048576,ratio:400});
  const decode = new TextDecoder("utf-8",{fatal:true}), encode=new TextEncoder();
  const fail = message=>{throw Error(message);};
  const check=(ok,message)=>{if(!ok)fail(message);};
  const bytes=v=>typeof v==="string"?encode.encode(v):v instanceof Uint8Array?v:new Uint8Array(v);
  const ignored=/^\.waffle\/(?:cache|previews|history|journal|local)(?:\/|$)/i;
  const HEX=/^[a-f0-9]{64}$/;
  function portable(path) {
    side().pathName(path);
    G.AtriumFormat2?.portablePath(path);
    const parts=path.split("/");
    check(parts.every(p=>encode.encode(p).length<=255 && !/[<>"|?*]/.test(p) && !/[ .]$/.test(p) &&
      !/^(?:aux|com[1-9¹²³]|con|lpt[1-9¹²³]|nul|prn|conin\$|conout\$)(?:\.|$)/i.test(p) &&
      !/^git~[1-9]$/i.test(p)), "Nonportable ZIP member: "+path);
    return path;
  }
  const fold=s=>G.AtriumFormat2?.pathKey(s)||s.normalize("NFC").toUpperCase().toLowerCase();
  function zipDirectory(input) {
    const data=bytes(input);
    check(data.length>=22 && data.length<=bounds.totalBytes, "Invalid project ZIP size.");
    const view=new DataView(data.buffer,data.byteOffset,data.byteLength), u16=i=>view.getUint16(i,true), u32=i=>view.getUint32(i,true);
    let end=data.length-22;
    for(;end>=Math.max(0,data.length-65557);end--) if (u32(end)===0x06054b50 && end+22+u16(end+20)===data.length) break;
    check(end>=0 && u32(end)===0x06054b50 && !u16(end+4) && !u16(end+6) && u16(end+8)===u16(end+10),"Unsupported or damaged ZIP directory.");
    const count=u16(end+10), central=u32(end+16);
    check(count<=bounds.entries && central+u32(end+12)===end,"Invalid or excessive ZIP directory.");
    const entries=new Map(), names=new Map(), ranges=[]; let p=central,total=0;
    function register(path,dir) {
      const parts=path.split("/"); let name="";
      for(const [i,part] of parts.entries()){
        name+=(i?"/":"")+part;
        const key=fold(name),prev=names.get(key),isDir=dir||i<parts.length-1,explicit=i===parts.length-1;
        if(prev) {
          check(prev.name===name && prev.dir && isDir && !(prev.explicit&&explicit),"Duplicate or colliding ZIP path: "+name);
          if(explicit)prev.explicit=true;
        }else names.set(key,{name,dir:isDir,explicit});
      }
    }
    for(let i=0;i<count;i++){
      check(p+46<=end && u32(p)===0x02014b50,"Damaged ZIP directory.");
      const flags=u16(p+8),method=u16(p+10),crc=u32(p+16),compressed=u32(p+20),size=u32(p+24);
      const nl=u16(p+28),extra=u16(p+30),comment=u16(p+32),attrs=u32(p+38),local=u32(p+42);
      check(p+46+nl+extra+comment<=end && !u16(p+34) && !(flags&~0x080e) && [0,8].includes(method),"Unsupported ZIP entry encoding.");
      const encoded=data.subarray(p+46,p+46+nl),original=decode.decode(encoded);
      const dir=original.endsWith("/"),path=portable(dir?original.slice(0,-1):original);
      const type=(attrs>>>16)&0xf000;
      check(!(attrs&0x400) && (!type || type===(dir?0x4000:0x8000)) && (!(attrs&0x10)||dir),"Linked or special ZIP entry: "+path);
      check(!dir || (!size&&!compressed), "Invalid ZIP directory entry.");
      register(path,dir);
      check(local+30<=central && u32(local)===0x04034b50 && u16(local+6)===flags && u16(local+8)===method && u16(local+26)===nl,
        "ZIP local header differs: "+path);
      const start=local+30+nl+u16(local+28);
      check(start+compressed<=central && decode.decode(data.subarray(local+30,local+30+nl))===original &&
        ((flags&8)|| (u32(local+14)===crc && u32(local+18)===compressed && u32(local+22)===size)),"Invalid ZIP local entry: "+path);
      check((method!==0 || compressed===size) && size<=bounds.entryBytes && (size<=1048576||size<=compressed*bounds.ratio),"ZIP expansion exceeds the limit: "+path);
      total+=size;check(total<=bounds.totalBytes,"Project ZIP exceeds its expanded size limit.");
      ranges.push([local,start+compressed]);if(!dir)entries.set(path,{path,start,compressed,size,crc,method});
      p+=46+nl+extra+comment;
    }
    check(p===end,"Invalid end of ZIP directory.");
    ranges.sort((a,b)=>a[0]-b[0]);
    for(let i=1;i<ranges.length;i++)check(ranges[i][0]>=ranges[i-1][1],"Overlapping ZIP members.");
    async function read(path,{signal}={}) {
      const e=entries.get(path);
      check(e,"Required project ZIP member is missing: "+path);signal?.throwIfAborted();
      const payload=data.subarray(e.start,e.start+e.compressed);let result=payload;
      if(e.method===8){
        if(typeof DecompressionStream==="function"){
          const reader=new Blob([payload]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
          result=new Uint8Array(e.size);let offset=0;
          try{for(;;){signal?.throwIfAborted();const {done,value}=await reader.read();if(done)break;
            check(offset+value.length<=e.size,"ZIP entry exceeded its declared length: "+path);
            result.set(value,offset);offset+=value.length;}check(offset===e.size,"Truncated ZIP entry: "+path);}
          finally{await reader.cancel().catch(()=>{});}
        }else{
          const format=G.AtriumImportFormats || await G.AtriumLazy.need("AtriumImportFormats");
          result=format.inflate(payload,e.size,e.size);
        }
      }
      check(result.length===e.size && Z().crc32(result)===e.crc,"Damaged ZIP member: "+path);return result;
    }
    async function projects({signal}={}) {
      const found=[];
      let obsolete=false;
      for(const path of entries.keys())if(/\.(waffle|atrium)$/i.test(path)&&!path.split("/").includes(".waffle")){
        signal?.throwIfAborted();const raw=await read(path,{signal}),lf=raw.indexOf(10);
        if(G.AtriumObsoleteProject.recognize(raw,path)){obsolete=true;continue;}
        if(!/\.waffle$/i.test(path)||lf<1||lf>1048576)continue;
        let h;try{h=JSON.parse(decode.decode(raw.subarray(0,lf)));}catch{continue;}
        if(h.kind==="project" && /^2(?:\.[0-9]+)+$/.test(h.formatVersion) && typeof h.id==="string")
          found.push({manifest:path.split("/").pop(),prefix:path.slice(0,path.lastIndexOf("/")+1),name:h.name||path.split("/").pop()});
      }
      if(!found.length && obsolete)throw G.AtriumObsoleteProject.error();
      return found.sort((a,b)=>side().cmp(a.prefix+a.manifest,b.prefix+b.manifest));
    }
    return {entries,read,projects};
  }
  // The same typed graph and canonical version service is used by folder Open and History.
  // Keep physical member bytes for the archive; the codec separately canonicalizes logical
  // text, checks package/asset identities and follows immutable released snapshots.
  async function verifyClosure({manifestPath,read,readBatch,original,signal}) {
    const verifier=G.AtriumFormat2Closure || await G.AtriumLazy.need("AtriumFormat2Closure");
    const files=new Map(),indexes=new Map();let total=0;
    function remember(path,value) {
      signal?.throwIfAborted();
      check(value!=null,"Missing required project member: "+path);
      const data=bytes(value);total+=data.length;
      check(data.length<=bounds.entryBytes && total<=bounds.totalBytes && files.size<bounds.entries,"The saved closure exceeds the project ZIP limit.");
      files.set(path,data);return data;
    }
    const manifest=G.AtriumFormat2Model.parse(await remember(manifestPath,await read(manifestPath,{signal})),{kind:"project"});
    const checked=await verifier.verify(manifest,async(path,ref)=>{
      signal?.throwIfAborted();
      if(ref.kind==="source" && original){
        const binding=indexes.get(ref.bindingPath), row=binding?.inputs.find(r=>r.id===ref.inputId);
        check(row,"Missing authorised retained input: "+path);return remember(path,await original(binding,row));
      }
      return remember(path,await read(path,{signal}));
    },{signal,accelerateDigests:true,onBinding:binding=>indexes.set(binding.ref.path,binding),
      readBatch:readBatch && (async paths=>{
        const values=await readBatch(paths,{signal});
        return paths.map((path,index)=>remember(path,values[index]));
      }),
      verifyModel:G.AtriumFormat2Models ? undefined : async(gzip,{byteLength})=>{
      check(Number.isSafeInteger(byteLength) && byteLength>=0 && byteLength<=bounds.entryBytes,"Invalid uncompressed model length.");
      const reader=new Blob([gzip]).stream().pipeThrough(new DecompressionStream("gzip")).getReader(),result=new Uint8Array(byteLength);
      let pos=0;try{for(;;){signal?.throwIfAborted();const v=await reader.read();if(v.done)break;
        check(pos+v.value.length<=byteLength,"Model exceeds its declared raw size.");result.set(v.value,pos);pos+=v.value.length;}}
      finally{await reader.cancel().catch(()=>{});}
      check(pos===byteLength,"Model length differs from its native reference.");return result;
    }});
    return {manifestPath,manifest,files,members:checked.members,version:checked.sha256,indexes:[...indexes.values()],read:async path=>files.get(path)};
  }
  function logicalMember(path) {
    portable(path);check(!ignored.test(path) && path!==side().IGNORE,"Private workspace state appeared in the project closure: "+path);return path;
  }
  // closure() resolves and verifies graph membership using the same codec as normal folder Open.
  // It supplies a byte reader scoped to that lease, including Git-backed logical source members.
  async function materialize(closure,{signal}={}) {
    const manifest=portable(closure.manifestPath);
    check(!manifest.includes("/") && /\.waffle$/i.test(manifest),"Invalid saved manifest name.");
    const files=new Map(),folded=new Set();let total=0;
    async function add(path,spec) {
      signal?.throwIfAborted();
      check(!folded.has(fold(path)) && files.size<bounds.entries,"Duplicate or excessive project members.");
      let value=await closure.read(path,{signal});
      check(value!=null,"Required archive member is missing: "+path);
      const data=bytes(value);
      check(data.length<=bounds.entryBytes && total+data.length<=bounds.totalBytes,"Saved project exceeds the ZIP size limit.");
      if(spec?.rawSha256)check(await side().sha(data)===spec.rawSha256,"Saved member changed during export: "+path);
      const expected=/^(?:assets\/|\.waffle\/imports\/)([0-9a-f]{64})(?:\/source)?$/.exec(path);
      if(expected)check(await side().sha(data)===expected[1],"Content identity differs: "+path);
      total+=data.length;folded.add(fold(path));files.set(path,data);
    }
    await add(manifest);
    for(const member of closure.members){
      const spec=typeof member==="string"?{path:member}:member;
      await add(logicalMember(spec.path),spec);
    }
    await add(side().IGNORE);
    return files;
  }
  async function archive(closure,{signal}={}) {
    const files=await materialize(closure,{signal}),stem=closure.manifestPath.replace(/\.waffle$/i,"");
    portable(stem);signal?.throwIfAborted();
    const entries=[...files].sort(([a],[b])=>side().cmp(a,b)).map(([name,data])=>({name:stem+"/"+name,data}));
    return {name:stem+".zip",bytes:Z().create(entries,{date:new Date(1980,0,1,0,0,0),portableFiles:true}),snapshotId:closure.snapshotId};
  }
  async function extract(zip,project,verify,{signal}={}) {
    const read=(name,opts)=>zip.read(project.prefix+portable(name),opts);
    const closure=await verify({manifestPath:project.manifest,read,signal});
    check(closure?.version && HEX.test(closure.version),"Cannot verify the extracted project version.");
    const files=await materialize({...closure,manifestPath:project.manifest,read},{signal});
    return {files,manifest:project.manifest,version:closure.version,project:closure.project};
  }
  return Object.freeze({zipDirectory,archive,extract,materialize,verifyClosure,portable,bounds});
})();
