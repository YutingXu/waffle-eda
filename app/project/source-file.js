"use strict";

if (!globalThis.AtriumSHA256 && typeof require === "function") require("../core/sha256.js");

// MS-CFB versions 3 and 4. Keep the original directory, storage identities,
// timestamps and unreferenced bytes. Growth appends sectors rather than reusing
// the source file's unused sectors. A failed plan never writes to its input.
globalThis.AtriumSourceFile = (() => {
  const FREE=0xffffffff, END=0xfffffffe, FAT=0xfffffffd, DIF=0xfffffffc;
  const signature=[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1];
  function bytesOf(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value) && "BYTES_PER_ELEMENT" in value && value.BYTES_PER_ELEMENT===1) return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
    throw Error("Expected binary file contents.");
  }
  const invalid=message=>{throw Error("Invalid compound file: "+message);};
  function open(input) {
    const bytes=bytesOf(input), view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const u16=at=>view.getUint16(at,true), u32=at=>view.getUint32(at,true);
    if(bytes.length<512 || !signature.every((b,i)=>bytes[i]===b))invalid("signature");
    const version=u16(26), size=2**u16(30), words=size/4, small=64, cutoff=4096;
    if(u16(28)!==0xfffe || !((version===3&&size===512)||(version===4&&size===4096)) || u16(32)!==6 || u32(56)!==cutoff)invalid("unsupported sector layout");
    if(bytes.length%size || bytes.length<size*2)invalid("truncated sector");
    const sectors=bytes.length/size-1, offset=id=>(id+1)*size;
    const fatCount=u32(44), difCount=u32(72), miniFatCount=u32(64);
    if(!fatCount || fatCount>sectors || difCount>sectors || miniFatCount>sectors)invalid("allocation table count");
    const fatIds=[], difIds=[], claimed=new Uint8Array(sectors);
    function claim(id,owners) {
      if(id>=owners.length || owners[id])invalid("out-of-range, shared or cyclic sector chain");
      owners[id]=1;
    }
    function fatReference(at) {
      const id=u32(at);if(id===FREE)return;
      if(fatIds.length===fatCount)invalid("extra FAT reference");
      claim(id,claimed);fatIds.push(id);
    }
    for(let slot=0;slot<109;slot++)fatReference(76+slot*4);
    let next=u32(68);
    for(let n=0;n<difCount;n++){
      claim(next,claimed);difIds.push(next);const at=offset(next);
      for(let j=0;j<words-1;j++)fatReference(at+j*4);
      next=u32(at+size-4);
    }
    if((next!==END && !(difCount===0&&next===FREE)) || fatIds.length!==fatCount || fatCount*words<sectors)invalid("incomplete FAT");
    function wordAt(ids,i){return u32(offset(ids[Math.floor(i/words)])+4*(i%words));}
    for(const id of fatIds)if(wordAt(fatIds,id)!==FAT)invalid("FAT marker");
    for(const id of difIds)if(wordAt(fatIds,id)!==DIF)invalid("DIFAT marker");
    function chain(first,table,owners,expected) {
      if(expected!=null && expected>owners.length)invalid("stream length exceeds storage");
      const ids=[];
      if(expected===0 && (first===END||first===FREE))return ids;
      for(let id=first;id!==END;id=wordAt(table,id)){
        if(expected!=null&&ids.length>=expected)invalid("overlong sector chain");
        claim(id,owners);ids.push(id);
      }
      if(expected!=null&&ids.length!==expected)invalid("short sector chain");
      return ids;
    }
    const dir=chain(u32(48),fatIds,claimed,version===4?u32(40):null);
    if(!dir.length)invalid("missing directory");
    const miniFat=chain(u32(60),fatIds,claimed,miniFatCount);
    const entries=dir.length*(size/128);
    const dirOffset=i=>offset(dir[Math.floor(i*128/size)])+(i*128)%size;
    function lengthAt(at){const n=u32(at)+0x100000000*u32(at+4);if(!Number.isSafeInteger(n)||n>bytes.length)invalid("unsupported stream length");return n;}
    const rootAt=dirOffset(0), rootSize=lengthAt(rootAt+120);
    if(bytes[rootAt+66]!==5 || rootSize%small)invalid("root mini stream");
    const rootChain=chain(u32(rootAt+116),fatIds,claimed,Math.ceil(rootSize/size));
    if(rootSize/small>miniFat.length*words)invalid("mini FAT is too short");
    const miniClaimed=new Uint8Array(rootSize/small), visited=new Uint8Array(entries), streams=new Map();
    const stack=[];
    function enqueue(id,parent){if(id!==FREE)stack.push({id,parent});}
    enqueue(u32(rootAt+76),"");visited[0]=1;
    while(stack.length){
      const {id,parent}=stack.pop();
      if(id>=entries||visited[id])invalid("invalid directory tree");visited[id]=1;
      const at=dirOffset(id),chars=u16(at+64), type=bytes[at+66];
      if((type!==1&&type!==2)||chars<4||chars>64||chars%2||u16(at+chars-2)!==0)invalid("invalid directory entry");
      let name="";for(let pos=0;pos<chars-2;pos+=2)name+=String.fromCharCode(u16(at+pos));
      if(name.includes("/")||name.includes("\0"))invalid("invalid entry name");
      const path=parent+name;
      enqueue(u32(at+68),parent);enqueue(u32(at+72),parent);
      if(type===1){enqueue(u32(at+76),path+"/");continue;}
      if(u32(at+76)!==FREE)invalid("stream with child directory");
      const length=lengthAt(at+120), mini=length<cutoff;
      // Some writers leave an unused sector number in a zero-length entry.
      const ids=length?chain(u32(at+116),mini?miniFat:fatIds,mini?miniClaimed:claimed,Math.ceil(length/(mini?small:size))):[];
      const key=path.toLowerCase();if(streams.has(key))invalid("duplicate stream path");
      streams.set(key,{path,at,length,mini,ids,index:id});
    }
    for(let i=1;i<entries;i++)if(!visited[i]&&bytes[dirOffset(i)+66]!==0)invalid("unreachable directory entry");
    const normalize=path=>String(path).replace(/^\/+/,"").toLowerCase();
    function entry(path){const e=streams.get(normalize(path));if(!e)throw Error("Missing compound file stream: "+path);return e;}
    function dataOffset(id,mini,root){return mini?offset(root[Math.floor(id*small/size)])+(id*small)%size:offset(id);}
    function read(path){
      const e=entry(path), result=new Uint8Array(e.length), unit=e.mini?small:size;
      for(let i=0;i<e.ids.length;i++){
        const at=dataOffset(e.ids[i],e.mini,rootChain),n=Math.min(unit,e.length-i*unit);
        result.set(bytes.subarray(at,at+n),i*unit);
      }
      return result;
    }
    function write(replacements){
      if(!(replacements instanceof Map))throw Error("Stream replacements must be a Map.");
      const plans=[],seen=new Set(), fatChanges=new Map(), miniChanges=new Map();
      const finalFat=fatIds.slice(),finalDif=difIds.slice();
      let tail=sectors, miniTail=rootSize/small;
      const alloc=()=>tail++, allocMini=()=>miniTail++;
      function resize(original,count,links,allocate){
        const ids=original.slice(0,count);
        for(let i=count;i<original.length;i++)links.set(original[i],FREE);
        while(ids.length<count)ids.push(allocate());
        if(count!==original.length&&count){
          for(let i=Math.max(0,Math.min(count,original.length)-1);i<count;i++)links.set(ids[i],i+1<count?ids[i+1]:END);
        }
        return ids;
      }
      for(const [path,value] of replacements){
        const e=entry(path), data=bytesOf(value);
        if(seen.has(e))throw Error("Duplicate replacement for "+e.path);seen.add(e);
        const mini=data.length<cutoff, unit=mini?small:size, links=mini?miniChanges:fatChanges;
        if(mini!==e.mini)resize(e.ids,0,e.mini?miniChanges:fatChanges,alloc);
        const ids=resize(mini===e.mini?e.ids:[],Math.ceil(data.length/unit),links,mini?allocMini:alloc);
        plans.push({e,data,mini,unit,ids});
      }
      const finalRoot=resize(rootChain,Math.ceil(miniTail*small/size),fatChanges,alloc);
      // Existing mini FAT sectors may reserve capacity beyond the current mini stream.
      const finalMiniFat=resize(miniFat,Math.max(miniFat.length,Math.ceil(miniTail/words)),fatChanges,alloc);
      while(finalFat.length*words<tail || 109+finalDif.length*(words-1)<finalFat.length){
        if(finalFat.length*words<tail){const id=alloc();finalFat.push(id);fatChanges.set(id,FAT);}
        else {const id=alloc();finalDif.push(id);fatChanges.set(id,DIF);}
      }
      const result=new Uint8Array((tail+1)*size);result.set(bytes);
      const out=new DataView(result.buffer),set=(at,n)=>out.setUint32(at,n,true);
      function setWord(table,i,n){set(offset(table[Math.floor(i/words)])+(i%words)*4,n);}
      for(const [ids,old] of [[finalFat,fatIds.length],[finalMiniFat,miniFat.length],[finalDif,difIds.length]]){
        for(let i=old;i<ids.length;i++)result.fill(255,offset(ids[i]),offset(ids[i])+size);
      }
      if(finalFat.length!==fatIds.length || finalDif.length!==difIds.length){
        set(44,finalFat.length);set(68,finalDif[0]??END);set(72,finalDif.length);
        for(let i=0;i<109;i++)set(76+i*4,finalFat[i]??FREE);
        for(let i=0;i<finalDif.length;i++){
          const at=offset(finalDif[i]);
          for(let j=0;j<words-1;j++)set(at+j*4,finalFat[109+i*(words-1)+j]??FREE);
          set(at+size-4,finalDif[i+1]??END);
        }
      }
      if(finalMiniFat.length!==miniFat.length){set(60,finalMiniFat[0]);set(64,finalMiniFat.length);}
      for(const [i,n] of fatChanges)setWord(finalFat,i,n);
      for(const [i,n] of miniChanges)setWord(finalMiniFat,i,n);
      function updateEntry(at,ids,length){
        set(at+116,ids[0]??END);set(at+120,length>>>0);set(at+124,Math.floor(length/0x100000000));
      }
      if(miniTail*small!==rootSize)updateEntry(rootAt,finalRoot,miniTail*small);
      for(const {e,data,mini,ids,unit} of plans){
        if(e.length!==data.length)updateEntry(e.at,ids,data.length);
        for(let i=0;i<ids.length;i++)result.set(data.subarray(i*unit,(i+1)*unit),dataOffset(ids[i],mini,finalRoot));
      }
      return result;
    }
    function paths({directoryOrder=false}={}) {
      if(!directoryOrder)return Array.from(streams.values(),s=>s.path);
      // Importers present library entries in their original directory order.
      return Array.from(streams.values()).sort((a,b)=>a.index-b.index).map(s=>s.path);
    }
    return {has:path=>streams.has(normalize(path)),size:path=>entry(path).length,paths,read,write};
  }
  // Read large embedded streams into byte storage, preserving the importer's
  // directory order. Some readable Altium files omit final sector padding
  // and need the legacy decoder. Resource errors must not trigger a second read.
  function readStreams(input, {lazyModels = false} = {}) {
    let source;
    try { source = open(input); }
    catch (error) {
      if (error?.message?.startsWith("Invalid compound file:")) return null;
      throw error;
    }
    /** @type {AltiumStreams} */
    const result = new Map();
    if (lazyModels) result.modelStream = (path, cap) => source.has(path) && source.size(path) <= cap ? source.read(path) : null;
    for (const path of source.paths({directoryOrder: true})) {
      if (lazyModels && /^(?:library\/)?models\/\d+$/i.test(path)) continue;
      const content = source.read(path);
      if (content.length) result.set(path.toLowerCase(), content);
    }
    return result;
  }
  function sha256(input) { return globalThis.AtriumSHA256.bytes(bytesOf(input)); }
  // A source string cannot grant filesystem access. Only exact, unambiguous
  // names from the user's selected project members can supply model bytes.
  function* modelLinks(all, designs, files, pathOf = f => f.name) {
    const clean = path => {
      const s = String(path || "").replace(/\\/g, "/").normalize("NFC").toLowerCase();
      if (!s || s.length > 1024 || /[:\x00-\x1f\x7f]|^\//.test(s) || s.split("/").includes("..")) return "";
      return s.split("/").filter(p => p && p !== ".").join("/");
    };
    const choices = new Map();
    for (const f of files) {
      const key = clean(pathOf(f));
      if (key && /\.(stp|step)$/.test(key)) choices.set(key, choices.has(key) ? null : f);
    }
    for (const [index, parsed] of all.entries()) for (const d of modelOwners(parsed)) {
      const dir = clean(pathOf(designs[index])).split("/").slice(0, -1).join("/");
      for (const asset of d.bodyModels || []) {
        const path = clean(asset.file);
        if (asset.zlib || asset.stepText || asset.assetId || !path) continue;
        const local = dir ? dir + "/" + path : path;
        // Boards may use a board-relative or project-relative member path. Both
        // candidates must identify one selected file, including on case-folding filesystems.
        const keys = [...new Set([local, path])].filter(k => choices.has(k));
        if (keys.length === 1 && choices.get(keys[0])) yield {asset, f: choices.get(keys[0]), parsed};
      }
    }
  }
  function modelOwners(parsed) {
    return [...(parsed.documents || []), ...(parsed.library || []).map(d => d.footprint).filter(fp => fp?.bodyModels)];
  }
  function modelNotes(parsed, count) {
    let unresolved = 0;
    for (const doc of modelOwners(parsed)) {
      const supplied = new Map();
      for (const a of doc.bodyModels || []) {
        if (a.stepText && supplied.has(a.stepText)) { a.assetId = supplied.get(a.stepText); delete a.stepText; }
        else if (a.stepText) supplied.set(a.stepText, a.id);
        else if (!a.zlib && !a.assetId) unresolved++;
      }
    }
    const update = notes => notes.filter(n => !/^\d+ STEP body reference\(s\) need a matching project model\.$/.test(n))
      .concat(count + " supplied STEP model(s) linked.", ...(unresolved ? [unresolved + " STEP model(s) unresolved."] : []));
    parsed.notes = update(parsed.notes);
    for (const d of parsed.documents || []) if (d.bodyModels) d.notes = update(d.notes);
  }
  return {open,sha256,readStreams,modelLinks,modelNotes};
})();
