"use strict";
if (!globalThis.AtriumBase64 && typeof require === "function") require("../core/base64.js");
// A source set retains the translator's file order, report, object bindings and exact bytes.
// Only verified original payloads have a content-addressed name. Each independent import has
// its own stable index, so two imports of the same files can refer to different native IDs.
globalThis.AtriumImportSidecars = (() => {
  const G = globalThis, HEX = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9_-]{1,100}$/;
  const FORMAT = "2.0", HEADER_KIND = "importBindings";
  const IGNORE = ".waffle/.gitignore", ignoreText = "/cache/\n/previews/\n/history/\n/journal/\n/local/\n";
  const MAX_FILE = 256 * 1048576, MAX_FILES = 500, MAX_INDEX = 128 * 1048576;
  const enc = new TextEncoder(), dec = new TextDecoder("utf-8", {fatal:true});
  const raw = value => typeof value === "string" ? enc.encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
  const sha = async value => {
    const data = raw(value);
    if (G.crypto?.subtle) return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), b => b.toString(16).padStart(2, "0")).join("");
    if (G.AtriumSourceFile) return G.AtriumSourceFile.sha256(data);
    throw Error("Source verification is unavailable.");
  };
  const check = (ok, message) => { if (!ok) throw Error(message); };
  function compareBytes(x,y) {
    const length = Math.min(x.length,y.length);
    for (let i=0; i<length; i++) if (x[i] !== y[i]) return x[i]-y[i];
    return x.length-y.length;
  }
  function cmp(a,b) {
    return a === b ? 0 : compareBytes(enc.encode(a),enc.encode(b));
  }
  // Retain encoded keys only for the binding being prepared or parsed. The value
  // dictionary sorts once with its own cache, so large strings are released early.
  function cachedCompare() {
    const keys = new Map();
    function key(text) {
      const cached = keys.get(text);
      if (cached) return cached;
      const bytes = enc.encode(text);
      keys.set(text,bytes);
      return bytes;
    }
    return (a,b) => a === b ? 0 : compareBytes(key(a),key(b));
  }
  function pathName(path) {
    check(typeof path === "string" && path && path.length <= 4096 && !/[\\:\x00-\x1f\x7f]/u.test(path) &&
      path.split("/").every(p => p && p !== "." && p !== ".." && p.toLowerCase() !== ".git"), "Invalid retained source path.");
    return path;
  }
  const logical = digest => ".waffle/imports/" + digest + "/source";
  const indexPath = (digest, id) => ".waffle/imports/" + digest + "/bindings-" + id + ".json";
  function string(s) {
    check(!/[\ud800-\udfff]/u.test(s), "Invalid Unicode in import binding.");
    return '"' + s.replace(/["\\\u0000-\u001f\u2028\u2029]/gu, c =>
      c === '"' || c === "\\" ? "\\" + c : "\\u" + c.charCodeAt(0).toString(16).padStart(4,"0")) + '"';
  }
  // Sidecars preserve vendor numeric values exactly as the translator represents them. Native
  // geometry has already been projected into the separate nm/nanodegree document records.
  const leading = ["kind","formatVersion","id"];
  function canonicalWriter(compare = cachedCompare()) {
    function write(v) {
      if (v === null || typeof v === "boolean") return String(v);
      if (typeof v === "string") return string(v);
      if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
      if (Array.isArray(v)) return "[" + v.map(write).join(",") + "]";
      check(v && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null),
        "Unsupported data in retained translator binding.");
      const keys = Object.keys(v).filter(k=>v[k] !== undefined);
      return "{" + [...leading.filter(k=>keys.includes(k)), ...keys.filter(k=>!leading.includes(k)).sort(compare)]
        .map(k=>string(k) + ":" + write(v[k])).join(",") + "}";
    }
    return write;
  }
  const canonical = v => canonicalWriter()(v);
  // Repeated source and fidelity rows are columnar canonical JSON. Identifier dictionaries
  // are shared across the report and its precision bindings. Integer index columns use
  // standard unsigned base-128 integers, optionally delta-coded and run-length coded.
  const MAX_CELLS=4000000, MAX_SAFE_STEP=Math.floor(Number.MAX_SAFE_INTEGER/2);
  const {encode: to64, decode: decode64} = G.AtriumBase64;
  function from64(s){
    if(typeof s!=="string"||s.length>MAX_INDEX)throw Error("Invalid binding column.");
    return decode64(s);
  }
  function smallest(a,b){return JSON.stringify(a).length<=JSON.stringify(b).length?a:b;}
  function integers(values){
    let best=["a",...values];
    if(values.length<6||!values.every(n=>Number.isSafeInteger(n)&&Math.abs(n)<=MAX_SAFE_STEP))return best;
    function encode(numbers,delta,runs){
      const bytes=[];
      function write(n){while(n>=128){bytes.push(n%128+128);n=Math.floor(n/128);}bytes.push(n);}
      function signed(n){write(n<0?-2*n-1:2*n);}
      for(let i=0;i<numbers.length;){
        const v=numbers[i++];signed(v);
        if(runs){const start=i;while(i<numbers.length&&numbers[i]===v)i++;write(i-start);}
      }
      return ["i",values.length,delta+(runs?2:0),to64(Uint8Array.from(bytes))];
    }
    for(const delta of [0,1]){
      const ns=delta?values.map((v,i)=>i?v-values[i-1]:v):values;
      if(!ns.every(n=>Number.isSafeInteger(n)&&Math.abs(n)<=MAX_SAFE_STEP))continue;
      best=smallest(best,encode(ns,delta,false));best=smallest(best,encode(ns,delta,true));
    }
    return best;
  }
  function unpackInts(v,limit){
    if(v[0]==="a"){check(v.length-1<=limit && v.slice(1).every(Number.isSafeInteger),"Invalid binding integer list.");return v.slice(1);}
    const [tag,count,mode,b64]=v;
    check(tag==="i" && Number.isSafeInteger(count)&&count>=0&&count<=limit&&[0,1,2,3].includes(mode),"Invalid binding integer column.");
    const data=from64(b64),out=[];let at=0,previous=0;
    function read(){
      let n=0,m=1,b;do{check(at<data.length&&m<=2**49,"Invalid binding integer encoding.");b=data[at++];n+=(b&127)*m;m*=128;}while(b>=128);
      check(Number.isSafeInteger(n),"Binding integer overflow.");return n;
    }
    while(out.length<count){const n=read(),d=n%2?-(n+1)/2:n/2,repeat=mode&2?read()+1:1;
      check(repeat<=count-out.length,"Invalid binding run length.");
      for(let j=0;j<repeat;j++){previous=(mode&1?previous:0)+d;check(Number.isSafeInteger(previous),"Binding delta overflow.");out.push(previous);}
    }
    check(at===data.length,"Trailing binding column data.");return out;
  }
  const plain = o => o!==null&&typeof o==="object"&&!Array.isArray(o);
  function projectionTable(value,compare){
    const counts=new Map();
    (function visit(v){if(typeof v==="string"&&v.length>=5)counts.set(v,(counts.get(v)||0)+1);
      else if(v&&typeof v==="object")for(const x of Object.values(v))visit(x);})(value);
    const dict=[...counts].filter(([s,n])=>n>2||(s.length>12&&n>1)).map(([s])=>s).sort(cachedCompare());
    const byText=new Map(dict.map((s,i)=>[s,i]));
    function numbers(values){
      let best=integers(values);
      if(values.length>=12){
        const ranks=new Map();for(const n of values)ranks.set(n,(ranks.get(n)||0)+1);
        const unique=[...ranks].sort((a,b)=>b[1]-a[1]||a[0]-b[0]).map(pair=>pair[0]);
        if(unique.length*2<values.length){
          const ids=new Map(unique.map((v,i)=>[v,i]));
          best=smallest(best,["l",integers(unique),integers(values.map(n=>ids.get(n)))]);
        }
      }
      return best;
    }
    function words(values,shared=true){
      if(shared&&values.length&&values.every(x=>byText.has(x)))return ["w",integers(values.map(x=>byText.get(x)))];
      let best=["a",...values.map(s=>shared&&byText.has(s)?["s",byText.get(s)]:s)];
      if(values.length<8)return best;
      if(shared && values.some(s=>byText.has(s))){
        const extra=[...new Set(values.filter(s=>!byText.has(s)))],local=new Map(extra.map((s,i)=>[s,-i-1]));
        best=smallest(best,["m",words(extra,false),integers(values.map(s=>byText.get(s)??local.get(s)))]);
      }
      if(values.every(s=>Number.isSafeInteger(+s)&&String(+s)===s))best=smallest(best,["d",numbers(values.map(Number))]);
      const prefixLengths=[],ends=[];let prev="";
      for(const s of values){let n=0;while(n<prev.length&&n<s.length&&s[n]===prev[n])n++;
        if(n && s.charCodeAt(n-1)>=0xd800 && s.charCodeAt(n-1)<=0xdbff)n--;
        prefixLengths.push(n);ends.push(s.slice(n));prev=s;}
      best=smallest(best,["f",integers(prefixLengths),ends]);
      const unique=[...new Set(values)];
      if(unique.length*2<values.length){
        const ids=new Map(unique.map((s,i)=>[s,i]));
        best=smallest(best,["l",words(unique,shared),integers(values.map(s=>ids.get(s)))]);
      }
      const prefixes=[],nums=[];
      for(const s of values){const m=/^(.*?)(0|[1-9][0-9]*)$/u.exec(s);
        if(!m||!Number.isSafeInteger(+m[2])||String(+m[2])!==m[2])return best;
        prefixes.push(m[1]);nums.push(+m[2]);}
      // Literal shared prefixes, including the empty prefix. A suffix of digits can be
      // folded only when its original decimal spelling can be reconstructed exactly.
      const uniquePrefix=[...new Set(prefixes)];if(uniquePrefix.length*2>=prefixes.length)return best;
      const ids=new Map(uniquePrefix.map((s,i)=>[s,i]));
      return smallest(best,["p",uniquePrefix,integers(prefixes.map(s=>ids.get(s))),integers(nums)]);
    }
    function series(list){
      if(list.length<6)return ["a",...list.map(pack)];
      if(list.every(Number.isSafeInteger))return numbers(list);
      if(list.every(v=>typeof v==="string"))return words(list);
      if(list.every(plain)){
        const groups=new Map();
        for(let i=0;i<list.length;i++){
          const keys=Object.keys(list[i]).sort(compare),signature=JSON.stringify(keys);
          let group=groups.get(signature);if(!group)groups.set(signature,group={keys,positions:[],columns:keys.map(()=>[])});
          group.positions.push(i);keys.forEach((k,j)=>group.columns[j].push(list[i][k]));
        }
        if(groups.size*3<list.length) {
          return ["t",list.length,[...groups.values()].map(g=>[g.keys,groups.size===1?null:integers(g.positions),g.columns.map(series)])];
        }
      }
      return ["a",...list.map(pack)];
    }
    function pack(v){
      if(Array.isArray(v))return series(v);
      if(plain(v))return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,pack(x)]));
      if(typeof v==="string"&&byText.has(v))return ["s",byText.get(v)];
      return v;
    }
    return {version:1,strings:words(dict,false),values:pack(value)};
  }
  function readTable(table) {
    check(table?.version===1,"Unsupported import binding table.");
    let dict=[],cells=0;
    const use=n=>{cells+=n;check(Number.isSafeInteger(n)&&n>=0&&cells<=MAX_CELLS,"Import binding table exceeds its row limit.");};
    const at=(a,i)=>{check(Number.isSafeInteger(i)&&i>=0&&i<a.length,"Invalid binding table index.");return a[i];};
    function decode(v,depth=0){
      check(depth<=100,"Import binding table exceeds its nesting limit.");
      const child=x=>decode(x,depth+1);
      if(!Array.isArray(v)){
        if(plain(v))return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,child(x)]));
        return v;
      }
      const [tag,a,b,c]=v;
      switch(tag){
      case "a": use(v.length-1);return v.slice(1).map(child);
      case "s": return at(dict,a);
      case "i": {const r=unpackInts(v,MAX_CELLS-cells);use(r.length);return r;}
      case "w": {const indexes=unpackInts(a,MAX_CELLS-cells);use(indexes.length);return indexes.map(i=>at(dict,i));}
      case "l": {const words=child(a),indexes=unpackInts(b,MAX_CELLS-cells);use(indexes.length);return indexes.map(i=>at(words,i));}
      case "m": {
        const extra=child(a),indexes=unpackInts(b,MAX_CELLS-cells);use(indexes.length);
        return indexes.map(i=>i<0?at(extra,-i-1):at(dict,i));}
      case "d": {const values=child(a);check(values.every(Number.isSafeInteger),"Invalid binding decimal column.");return values.map(String);}
      case "f": {
        check(Array.isArray(b)&&b.every(s=>typeof s==="string"),"Invalid binding dictionary.");
        const sizes=unpackInts(a,MAX_CELLS-cells);use(sizes.length);check(sizes.length===b.length,"Invalid dictionary length.");
        let previous="",bytes=0;
        return sizes.map((n,i)=>{check(n>=0&&n<=previous.length,"Invalid dictionary prefix.");previous=previous.slice(0,n)+b[i];
          bytes+=previous.length;check(bytes<=MAX_INDEX,"Expanded binding dictionary exceeds its limit.");return previous;});}
      case "p": {
        check(Array.isArray(a)&&a.every(p=>typeof p==="string"),"Invalid binding string prefixes.");
        const indexes=unpackInts(b,MAX_CELLS-cells),ns=unpackInts(c,indexes.length);use(ns.length);
        check(indexes.length===ns.length,"Invalid binding string column.");return indexes.map((i,j)=>at(a,i)+String(ns[j]));}
      case "t": {
        use(a);check(Array.isArray(b)&&Number.isSafeInteger(a)&&a>=0,"Invalid binding row table.");
        const rows=new Array(a);
        for(const [keys,indexes,columns] of b){
          check(Array.isArray(keys)&&keys.every(k=>typeof k==="string")&&new Set(keys).size===keys.length&&keys.length===columns.length,"Invalid binding columns.");
          const pos=indexes===null?null:unpackInts(indexes,a),length=pos?pos.length:a,values=columns.map(child);
          check(values.every(col=>col.length===length),"Invalid binding column length.");
          for(let j=0;j<length;j++){const i=pos?pos[j]:j;
            check(i>=0&&i<a&&rows[i]===undefined,"Invalid binding row order.");
            rows[i]=Object.fromEntries(keys.map((k,n)=>[k,values[n][j]]));}
        }
        check(!rows.includes(undefined),"Missing binding table row.");return rows;}
      default: throw Error("Unknown binding table column.");
      }
    }
    dict=decode(table.strings);check(dict.every(t=>typeof t==="string"),"Invalid import binding string table.");
    return decode(table.values);
  }
  function fingerprint({owner,id,property,nativeValue},write){
    return G.AtriumSourceFile.sha256(enc.encode(write({owner,id,property,value:nativeValue})));
  }
  function storedProjection(meta,write,compare){
    const text=write(meta);
    if(text.length<8192)return meta;
    const {kind,id,names,documents,residuals,...other}=meta;
    const packed={...other};
    if(residuals?.length){
      // nativeValue is the original translated integer. Its SHA is independently verified
      // before factoring and reconstructed on read without consulting edited geometry.
      if(residuals.every(r=>Number.isSafeInteger(r.nativeValue)&&G.AtriumSourceFile&&r.fingerprint===fingerprint(r,write)))
        packed.precision=residuals.map(({fingerprint,...r})=>r);
      else packed.residuals=residuals;
    }
    const result={kind,id,names,documents,table:projectionTable(packed,compare)};
    return write(result).length<text.length?result:meta;
  }
  function decodedProjection(meta,write){
    if(!meta?.table)return meta;
    const {table,...header}=meta,value=readTable(table),{precision,...payload}=value;
    // Bound the logical size as well as the physical bytes and decoded cell counts. Repeated
    // references to one large string occupy one dictionary entry but can expand many times.
    let logical=0;
    const queue=[value];
    while(queue.length){
      const node=queue.pop();
      if(typeof node==="string")logical+=node.length+2;
      else if(node&&typeof node==="object"){
        const entries=Object.entries(node);logical+=entries.length+2;
        for(const [key,child] of entries){if(!Array.isArray(node))logical+=key.length+3;queue.push(child);}
      }else logical+=8;
      check(logical<=MAX_INDEX,"Expanded import binding exceeds its size limit.");
    }
    if(precision){
      check(Array.isArray(precision)&&precision.every(r=>Number.isSafeInteger(r.nativeValue)),"Invalid precision binding.");
      payload.residuals=precision.map(r=>({...r,fingerprint:fingerprint(r,write)}));
    }
    return {...header,...payload};
  }
  function gitIdentity(v) {
    if (v === undefined || v === null) return;
    check(v && ["sha1","sha256"].includes(v.algorithm) && typeof v.commit === "string" &&
      (v.algorithm === "sha1" ? /^[a-f0-9]{40}$/ : HEX).test(v.commit) &&
      Object.keys(v).every(k=>["algorithm","commit","path"].includes(k)), "Invalid immutable Git source identity.");
    pathName(v.path);
    return {algorithm:v.algorithm, commit:v.commit, path:v.path};
  }
  function input(row) {
    check(row && row.kind === "input" && /^input-[0-9]{6}$/.test(row.id) && HEX.test(row.sha256) &&
      Number.isSafeInteger(row.byteLength) && row.byteLength >= 0 && row.byteLength <= MAX_FILE,
      "Invalid retained source digest or byte length.");
    check(pathName(row.name) === row.name && !row.name.includes("/"), "Invalid retained input name.");
    if (row.path !== undefined) pathName(row.path);
    gitIdentity(row.git);
    if (row.metadata?.legacy?.disk_git) gitIdentity(row.metadata.legacy.disk_git);
    check(!Object.keys(row.metadata || {}).some(k=>["bytes","sourceToken","git","name","path","sha256","byteLength"].includes(k)),
      "Unexpected retained file metadata.");
    return row;
  }
  const entryRefs = new WeakMap(), grants = new WeakMap(), portableCopies = new WeakSet();
  function retainCopy(file, bytes) { file.bytes=bytes; portableCopies.add(file); }
  function grant(file, token) { if (file && token) grants.set(file,token); }
  const refFor = (id, files) => ({kind:"importIndex",id,path:indexPath(files[0].sha256,id)});
  function parse(value, expected) {
    const data = raw(value);
    check(data.byteLength && data.byteLength <= MAX_INDEX, "Invalid retained import index size.");
    const physical = dec.decode(data);
    check(!physical.includes("\r") || !/[\r\n]/.test(physical.replace(/\r\n/g,"")), "Mixed line endings in retained import index.");
    const text = physical.replace(/\r\n/g,"\n");
    check(text.endsWith("\n"), "Incomplete retained import index.");
    const write = canonicalWriter();
    const rows = text.slice(0,-1).split("\n").map(line => {
      const row = JSON.parse(line);
      check(write(row) === line, "Noncanonical or duplicate data in retained import index."); return row;
    });
    const [header,...records] = rows;
    check(header.kind === HEADER_KIND && header.formatVersion === FORMAT && typeof header.id === "string" && ID.test(header.id) &&
      Object.keys(header).length === 3, "Unsupported retained import index.");
    const inputs = records.slice(0,-1).map(input), metadata = decodedProjection(records.at(-1),write);
    check(inputs.length > 0 && inputs.length <= MAX_FILES && inputs.every((r,i)=>r.id === "input-"+String(i).padStart(6,"0")) &&
      metadata?.kind === "projection" && metadata.id === "projection" && Array.isArray(metadata.documents) && Array.isArray(metadata.names) &&
      metadata.report && typeof metadata.report.translator === "string" && Array.isArray(metadata.report.kinds) &&
      metadata.provenance && !Object.hasOwn(metadata.provenance,"files"), "Invalid retained import projection.");
    const ref = refFor(header.id,inputs);
    check(!expected || expected.id === ref.id && expected.path === ref.path, "Retained binding does not match its manifest reference.");
    return {ref,metadata,inputs};
  }
  function dependencies(binding) {
    return binding.inputs.map(r => ({path:logical(r.sha256),sha256:r.sha256,byteLength:r.byteLength,...(r.git ? {git:r.git} : {})}));
  }
  async function verified(bytes, item) {
    check(bytes != null && raw(bytes).length === item.byteLength && await sha(bytes) === item.sha256,
      "Missing or corrupt retained original " + item.name + " (" + item.sha256 + ").");
    return raw(bytes);
  }
  function* prepareSteps(entries, {locate,signal} = {}) {
    const refs=[], files=new Map(), originals=new Map();
    for (const e of entries) {
      signal?.throwIfAborted();
      if (e.adopted === false) continue;
      const {files:provided, ...provenance} = e.provenance || {};
      if (!provided?.length) continue;
      check(provided.length <= MAX_FILES,"Too many files in retained import.");
      const id = e.scopeId || e.index?.ref.id || entryRefs.get(e) || G.AtriumUUID.next();
      check(ID.test(id),"Invalid import scope identifier."); entryRefs.set(e,id);
      const inputs=[];
      for (const [order, f] of provided.entries()) {
        signal?.throwIfAborted();
        const {name,path,sha256,bytes,byteLength, ...metadata} = f;
        const old = e.index?.inputs[order];
        const row = {kind:"input",id:"input-"+String(order).padStart(6,"0"),name,...(path ? {path} : {}),sha256,
          byteLength:bytes != null ? raw(bytes).length : byteLength ?? old?.byteLength,metadata};
        const pinned = old ? old.git : locate ? yield {location:{file:f,sourceToken:grants.get(f),sha256,byteLength:row.byteLength,signal}} : null;
        if (pinned) row.git = gitIdentity(pinned);
        input(row); inputs.push(row);
        if (bytes != null) {
          const data = raw(bytes);
          check(data.length === row.byteLength && (yield {data}) === row.sha256,
            "Missing or corrupt retained original " + row.name + " (" + row.sha256 + ").");
          if (!row.git || portableCopies.has(f)) files.set(logical(row.sha256),data);
          originals.set(logical(row.sha256),data);
        } else check(old && old.sha256 === sha256 && old.byteLength === row.byteLength,"Exact translator input unavailable for " + name + ".");
      }
      const meta = {kind:"projection",id:"projection",documents:e.documents,names:e.names,report:e.report,provenance,
        ...(e.binding ? {binding:e.binding} : {}), ...(e.residuals?.length ? {residuals:e.residuals} : {}), ...(e.ruleRows?.length ? {ruleRows:e.ruleRows} : {})};
      const compare = cachedCompare(), write = canonicalWriter(compare);
      const projection = storedProjection(meta,write,compare), ref = refFor(id,inputs);
      const index = enc.encode([{kind:HEADER_KIND,formatVersion:FORMAT,id},...inputs,projection].map(write).join("\n")+"\n");
      check(index.length <= MAX_INDEX,"The retained import index exceeds its limit.");
      refs.push(ref); files.set(ref.path,index);
    }
    return {refs,files,originals};
  }
  async function prepare(entries, options = {}) {
    const cursor = prepareSteps(entries, options);
    let step = cursor.next();
    while (!step.done) {
      const {location,data} = step.value;
      step = cursor.next(location ? await options.locate(location) : await sha(data));
    }
    return step.value;
  }
  function prepareSync(entries, options = {}) {
    const cursor = prepareSteps(entries, options);
    let step = cursor.next();
    while (!step.done) {
      const {location,data} = step.value;
      step = cursor.next(location ? options.locate(location) : G.AtriumSourceFile.sha256(data));
    }
    return step.value;
  }
  function restore(binding) {
    const {ref,metadata:m,inputs} = binding;
    const files = inputs.map(r => ({...r.metadata,name:r.name,...(r.path ? {path:r.path} : {}),sha256:r.sha256,byteLength:r.byteLength}));
    return {id:"import-report-"+ref.id,scopeId:ref.id,index:binding,adopted:true,documents:m.documents,names:m.names,
      report:m.report,provenance:{...m.provenance,files},...(m.binding ? {binding:m.binding} : {}),...(m.residuals ? {residuals:m.residuals} : {}),...(m.ruleRows ? {ruleRows:m.ruleRows} : {})};
  }
  function exportProvenance(entry) {
    const rows=entry.residuals ?? entry.binding?.residuals;
    if(!rows?.length)return entry.provenance;
    return {...entry.provenance,precision:{version:1,scopeId:entry.scopeId,documents:entry.documents,rows}};
  }
  // Manufacturing uses the verified numeric bindings. The input files and translator
  // metadata stay with the import report instead of crossing into the plot worker.
  function manufacturingProvenance(groups, documentId) {
    const result = [];
    for (const group of Array.isArray(groups) ? groups : [groups]) {
      const scope = group?.precision;
      const reduced={};
      if (scope?.version === 1 && Array.isArray(scope.documents) && Array.isArray(scope.rows)) {
        const documents = scope.documents.filter(id => !documentId || id === documentId);
        const owners = new Set(documents);
        const rows = scope.rows.filter(row => row && typeof row.property === "string" && owners.has(row.owner) && (
          row.recordKind === "track" && row.property.startsWith("/points/") ||
          row.recordKind === "label" && row.property.startsWith("/sourceTextBox/") ||
          row.recordKind === "part" && /^\/(?:boardLabels|hiddenBoardLabels)\//.test(row.property)
        ));
        if (rows.length) reduced.precision={version:1,scopeId:scope.scopeId,documents,rows};
      }
      for (const drawing of Array.isArray(group?.drillDrawings)?group.drillDrawings:[]) {
        if (!drawing || typeof drawing.documentId!=="string" || (documentId && drawing.documentId!==documentId) ||
            !(drawing.size===null || Number.isFinite(drawing.size) && drawing.size>0) || !Array.isArray(drawing.marks)) continue;
        const marks=[];
        for (const row of drawing.marks) if (Array.isArray(row) && typeof row[0]==="string" && row[0].length<=2048 &&
            Number.isSafeInteger(row[1]) && row[1]>=0) marks.push([row[0],row[1]]);
        if (marks.length) (reduced.drillDrawings ||= []).push({documentId:drawing.documentId,size:drawing.size,marks});
      }
      if (reduced.precision || reduced.drillDrawings) result.push(reduced);
    }
    return result;
  }
  async function originalFiles(binding, read, signal) {
    const files=[];
    for (const r of binding.inputs) {
      signal?.throwIfAborted();
      const data = await verified(await read({path:logical(r.sha256),...r,sourcePath:logical(r.sha256)},signal),r);
      files.push({name:r.name,...(r.path ? {path:r.path} : {}),bytes:data});
    }
    return files;
  }
  // Transaction paths only. The caller checks that each candidate really exists and supplies its
  // physical base digest. Never turn a repo-relative Git locator into a removal target.
  function removed(prior, next) {
    const keep = new Set(next.flatMap(b=>[b.ref.path,...dependencies(b).map(i=>i.path)]));
    return [...new Set(prior.flatMap(b=>[b.ref.path,...dependencies(b).map(i=>i.path)]))].filter(p=>!keep.has(p));
  }
  return Object.freeze({FORMAT,HEADER_KIND,IGNORE,ignoreText,prepare,prepareSync,parse,restore,exportProvenance,manufacturingProvenance,dependencies,originalFiles,removed,grant,retainCopy,sha,verified,pathName,cmp,canonical,logical});
})();
