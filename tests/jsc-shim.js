// Minimal Node.js shim for running tests/*.cjs under JavaScriptCore's jsc (see scripts/test-jsc.sh).
// Tests that need real files, processes or workers still need Node: node tests/run.cjs
// Usage: jsc node-shim.js -- /abs/path/to/test.cjs [args...]
var __shimArgs=typeof scriptArgs!=="undefined"?Array.from(scriptArgs):typeof arguments!=="undefined"?Array.from(arguments):[];
(function(){
  const G=globalThis;
  G.ATRIUM_DEV=true; // dev-only checks (idle.js: idle callbacks that overrun their slice)
  const argv=__shimArgs;
  // Node writes one sorted basename inventory before jsc starts. Reading that named
  // file keeps directory enumeration out of this shim.
  if (typeof G.ATRIUM_APP_SOURCE_INVENTORY_FILE === "string" && G.ATRIUM_APP_SOURCE_INVENTORY_FILE)
    G.ATRIUM_APP_SOURCE_INVENTORY = JSON.parse(readFile(G.ATRIUM_APP_SOURCE_INVENTORY_FILE));
  // The bare test shell has no Web Crypto. Production headless hosts supply OS entropy.
  G.__waffleUUIDSeed ??= Array.from({length:20}, () => Math.floor(Math.random()*16).toString(16)).join("");
  // ---- text codecs ----
  const cp1252={0x80:0x20ac,0x82:0x201a,0x83:0x192,0x84:0x201e,0x85:0x2026,0x86:0x2020,0x87:0x2021,0x88:0x2c6,0x89:0x2030,0x8a:0x160,0x8b:0x2039,0x8c:0x152,0x8e:0x17d,0x91:0x2018,0x92:0x2019,0x93:0x201c,0x94:0x201d,0x95:0x2022,0x96:0x2013,0x97:0x2014,0x98:0x2dc,0x99:0x2122,0x9a:0x161,0x9b:0x203a,0x9c:0x153,0x9e:0x17e,0x9f:0x178};
  function utf8Decode(b){let s="";for(let i=0;i<b.length;){const c=b[i++];
    if(c<0x80)s+=String.fromCharCode(c);
    else if(c>=0xc0&&c<0xe0&&i<b.length)s+=String.fromCharCode(((c&31)<<6)|(b[i++]&63));
    else if(c>=0xe0&&c<0xf0&&i+1<b.length){s+=String.fromCharCode(((c&15)<<12)|((b[i++]&63)<<6)|(b[i++]&63));}
    else if(c>=0xf0&&i+2<b.length){const cp=((c&7)<<18)|((b[i++]&63)<<12)|((b[i++]&63)<<6)|(b[i++]&63);s+=cp<=0x10ffff?String.fromCodePoint(cp):"\ufffd";}
    else s+="�";}return s;}
  function utf8Encode(s,replaceUnpaired=false){const out=[];for(const ch of String(s)){let cp=ch.codePointAt(0);
    if(replaceUnpaired&&cp>=0xd800&&cp<=0xdfff)cp=0xfffd;
    if(cp<0x80)out.push(cp);else if(cp<0x800)out.push(0xc0|cp>>6,0x80|cp&63);
    else if(cp<0x10000)out.push(0xe0|cp>>12,0x80|(cp>>6)&63,0x80|cp&63);
    else out.push(0xf0|cp>>18,0x80|(cp>>12)&63,0x80|(cp>>6)&63,0x80|cp&63);}return new Uint8Array(out);}
  function strictUtf8(u){let i=0;while(i<u.length){const c=u[i];let n=c<0x80?0:c>=0xc2&&c<0xe0?1:c>=0xe0&&c<0xf0?2:c>=0xf0&&c<0xf5?3:-1;
    if(n<0||i+n>=u.length+0&&n>0&&i+n>u.length-1+1)throw new TypeError("invalid utf-8");for(let k=1;k<=n;k++)if((u[i+k]&0xc0)!==0x80)throw new TypeError("invalid utf-8");i+=n+1;}}
  G.TextDecoder=class{constructor(enc="utf-8",opts={}){this.encoding=String(enc).toLowerCase();this.fatal=!!opts.fatal;}
    decode(b){if(!b)return "";const u=b instanceof Uint8Array?b:ArrayBuffer.isView(b)?new Uint8Array(b.buffer,b.byteOffset,b.byteLength):new Uint8Array(b);
      if(/utf-?16/.test(this.encoding)){const be=/be/.test(this.encoding);let s="";let i=(be?(u[0]===0xfe&&u[1]===0xff):(u[0]===0xff&&u[1]===0xfe))?2:0;for(;i+1<u.length;i+=2)s+=String.fromCharCode(be?u[i]<<8|u[i+1]:u[i+1]<<8|u[i]);return s;}
      if(this.fatal&&!/1252|latin|ascii/.test(this.encoding))strictUtf8(u);
      if(/1252|latin|ascii/.test(this.encoding)){let s="";for(const c of u)s+=String.fromCharCode(cp1252[c]||c);return s;}
      return utf8Decode(u);}};
  G.TextEncoder=class{encode(s){return utf8Encode(s,true);}};
  // ---- Buffer ----
  class Buffer extends Uint8Array{
    static alloc(n,fill=0){const b=new Buffer(n);if(fill)b.fill(fill);return b;}
    static from(x,enc){
      if(typeof x==="string"){
        if(enc==="latin1"||enc==="binary"){const b=new Buffer(x.length);for(let i=0;i<x.length;i++)b[i]=x.charCodeAt(i)&255;return b;}
        if(enc==="base64")return Buffer.from(atob(x.replace(/-/g,"+").replace(/_/g,"/")),"latin1");
        if(enc==="utf16le"||enc==="ucs2"||enc==="utf-16le"){const b=new Buffer(x.length*2);for(let i=0;i<x.length;i++){const c=x.charCodeAt(i);b[i*2]=c&255;b[i*2+1]=c>>8;}return b;}
        if(enc==="hex"){const b=new Buffer(x.length>>1);for(let i=0;i<b.length;i++)b[i]=parseInt(x.substr(i*2,2),16);return b;}
        const e=utf8Encode(x),b=new Buffer(e.length);b.set(e);return b;
      }
      if(x instanceof ArrayBuffer){return new Buffer(x);}
      const b=new Buffer(x.length);b.set(x);return b;
    }
    static concat(list){const n=list.reduce((s,b)=>s+b.length,0),b=new Buffer(n);let o=0;for(const x of list){b.set(x,o);o+=x.length;}return b;}
    static isBuffer(b){return b instanceof Buffer;}
    dv(){return new DataView(this.buffer,this.byteOffset,this.byteLength);}
    writeUInt32LE(v,o=0){this.dv().setUint32(o,v>>>0,true);return o+4;}
    writeInt32LE(v,o=0){this.dv().setInt32(o,v,true);return o+4;}
    writeUInt16LE(v,o=0){this.dv().setUint16(o,v,true);return o+2;}
    writeInt16LE(v,o=0){this.dv().setInt16(o,v,true);return o+2;}
    writeDoubleLE(v,o=0){this.dv().setFloat64(o,v,true);return o+8;}
    writeUInt8(v,o=0){this[o]=v;return o+1;}
    readUInt32LE(o=0){return this.dv().getUint32(o,true);}
    readInt32LE(o=0){return this.dv().getInt32(o,true);}
    readUInt16LE(o=0){return this.dv().getUint16(o,true);}
    readInt16LE(o=0){return this.dv().getInt16(o,true);}
    readDoubleLE(o=0){return this.dv().getFloat64(o,true);}
    readUInt8(o=0){return this[o];}
    copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
      if (targetStart < 0 || sourceStart < 0 || sourceStart > this.length || sourceEnd < 0)
        throw new RangeError("Buffer.copy offset out of range");
      const count = Math.min(target.length - targetStart, Math.min(sourceEnd, this.length) - sourceStart);
      if (count <= 0) return 0;
      target.set(this.subarray(sourceStart, sourceStart + count), targetStart);
      return count;
    }
    equals(o){if(o.length!==this.length)return false;for(let i=0;i<o.length;i++)if(o[i]!==this[i])return false;return true;}
    toString(enc, start = 0, end = this.length) {
      const bytes = this.subarray(Math.max(0, start), Math.max(0, end));
      if (enc === "latin1" || enc === "binary") {
        let s = "";
        for (const value of bytes) s += String.fromCharCode(value);
        return s;
      }
      if (enc === "utf16le" || enc === "utf-16le" || enc === "ucs2") {
        let s = "";
        for (let i = 1; i < bytes.length; i += 2) s += String.fromCharCode(bytes[i - 1] | bytes[i] << 8);
        return s;
      }
      if (enc === "base64") return bytes.toBase64?.() ?? btoa(bytes.toString("latin1"));
      if (enc === "hex") return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
      return utf8Decode(bytes);
    }
  }
  G.Buffer=Buffer;
  // ---- assert ----
  class AssertionError extends Error{}
  const fmt=v=>{try{return JSON.stringify(v,(k,x)=>x instanceof Map?[...x]:x instanceof Set?[...x]:ArrayBuffer.isView(x)?Array.from(x):x)?.slice(0,400);}catch{return String(v);}};
  function deepEq(a,b){
    if(Object.is(a,b))return true;
    if(typeof a!=="object"||typeof b!=="object"||!a||!b)return false;
    if(ArrayBuffer.isView(a)||ArrayBuffer.isView(b)){if(!ArrayBuffer.isView(a)||!ArrayBuffer.isView(b)||a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}
    if(Array.isArray(a)!==Array.isArray(b))return false;
    if(a instanceof Map||b instanceof Map){if(!(a instanceof Map&&b instanceof Map)||a.size!==b.size)return false;for(const [k,v] of a)if(!b.has(k)||!deepEq(v,b.get(k)))return false;return true;}
    if(a instanceof Set||b instanceof Set){if(!(a instanceof Set&&b instanceof Set)||a.size!==b.size)return false;for(const v of a)if(!b.has(v))return false;return true;}
    if(Object.getPrototypeOf(a)!==Object.getPrototypeOf(b))return false;
    const ka=Object.keys(a),kb=Object.keys(b);if(ka.length!==kb.length)return false;
    for(const k of ka)if(!Object.prototype.hasOwnProperty.call(b,k)||!deepEq(a[k],b[k]))return false;return true;
  }
  const fail=(m,d)=>{throw new AssertionError(m instanceof Error?m.message:(m||d));};
  function assert(v,m){if(!v)fail(m,"Expected truthy, got "+fmt(v));}
  function matchesError(e,exp){
    if(exp==null)return true;
    if(typeof exp==="function"){if(exp.prototype instanceof Error||exp===Error)return e instanceof exp;return exp(e)===true;}
    if(exp instanceof RegExp)return exp.test(String(e&&e.message!==undefined?e.message:e))||exp.test(String(e));
    if(typeof exp==="object"){for(const k of Object.keys(exp)){const v=exp[k];if(v instanceof RegExp?!v.test(e[k]):!deepEq(e[k],v))return false;}return true;}
    return true;
  }
  Object.assign(assert,{AssertionError,ok:assert,
    equal(a,b,m){if(!Object.is(a,b))fail(m,fmt(a)+" !== "+fmt(b));},strictEqual(a,b,m){assert.equal(a,b,m);},
    notEqual(a,b,m){if(Object.is(a,b))fail(m,fmt(a)+" === "+fmt(b));},notStrictEqual(a,b,m){assert.notEqual(a,b,m);},
    deepEqual(a,b,m){if(!deepEq(a,b))fail(m,"deepEqual failed:\n  "+fmt(a)+"\n  "+fmt(b));},deepStrictEqual(a,b,m){assert.deepEqual(a,b,m);},
    notDeepEqual(a,b,m){if(deepEq(a,b))fail(m,"notDeepEqual failed "+fmt(a));},
    throws(fn,exp,m){try{fn();}catch(e){if(!matchesError(e,exp))fail(typeof m==="string"?m:null,"Unexpected error: "+(e&&e.message));return;}fail(typeof exp==="string"?exp:m,"Missing expected exception");},
    doesNotThrow(fn,m){try{fn();}catch(e){fail(m,"Got unwanted exception: "+e.message);}},
    match(s,r,m){if(!r.test(s))fail(m,fmt(s)+" does not match "+r);},doesNotMatch(s,r,m){if(r.test(s))fail(m,fmt(s)+" matches "+r);},
    fail(m){fail(m,"Failed");},
    async rejects(p,exp,m){try{await (typeof p==="function"?p():p);}catch(e){if(!matchesError(e,exp))fail(m,"Unexpected rejection "+e.message);return;}fail(m,"Missing expected rejection");}
  });
  // ---- path ----
  const norm=p=>{const abs=p.startsWith("/"),out=[];for(const s of p.split("/")){if(!s||s===".")continue;if(s===".."){out.pop();continue;}out.push(s);}return (abs?"/":"")+out.join("/");};
  const path={join:(...a)=>norm(a.join("/")),resolve:(...a)=>{let p="";for(const x of a)p=x.startsWith("/")?x:p+"/"+x;return norm(p.startsWith("/")?p:"/"+p);},
    dirname:p=>norm(p).replace(/\/[^/]*$/,"")||"/",basename:(p,ext)=>{let b=p.replace(/.*\//,"");if(ext&&b.endsWith(ext))b=b.slice(0,-ext.length);return b;},extname:p=>(/\.[^./]*$/.exec(p)||[""])[0],sep:"/"};
  const fs={readFileSync(p,enc){if(enc==="utf8"||enc==="utf-8"||enc?.encoding)return readFile(p);const u=readFile(p,"binary");return Buffer.from(u);},
    existsSync(p){try{readFile(p);return true;}catch{return false;}},
    writeFileSync(){throw Error("fs.writeFileSync unavailable in jsc shim");}};
  // ---- scratch directories (in memory) ----
  // fs.mkdtempSync makes a virtual directory; writeFileSync, readFileSync, existsSync, statSync,
  // readdirSync and rmSync work on files inside it, so tests that only round-trip their own
  // output through a temp dir run under jsc. Writes anywhere else still throw. Nothing touches disk.
  {
    const scratch=new Map(),dirs=new Set();let seq=0;
    const inScratch=p=>{const n=norm(String(p));for(const d of dirs)if(n===d||n.startsWith(d+"/"))return n;return null;};
    const toBytes=(data,enc)=>typeof data==="string"?(enc==="latin1"||enc==="binary"?Buffer.from(data,"latin1"):Buffer.from(data)):Buffer.from(ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):data);
    const {readFileSync:diskRead,existsSync:diskExists,writeFileSync:diskWrite}=fs;
    Object.assign(fs,{
      mkdtempSync(prefix){const d=norm(String(prefix)+"jsc"+(++seq).toString(36)+Date.now().toString(36));dirs.add(d);return d;},
      mkdirSync(p){const n=inScratch(p);if(n==null)throw Error("fs.mkdirSync unavailable in jsc shim outside fs.mkdtempSync directories");dirs.add(n);},
      writeFileSync(p,data,o){const n=inScratch(p);if(n==null)return diskWrite(p,data,o);scratch.set(n,toBytes(data,typeof o==="string"?o:o?.encoding));},
      readFileSync(p,enc){const n=inScratch(p);if(n==null)return diskRead(p,enc);if(!scratch.has(n))throw Error("ENOENT: no such file "+p);const b=scratch.get(n);
        return enc==="utf8"||enc==="utf-8"||enc?.encoding?b.toString():Buffer.from(b);},
      existsSync(p){const n=inScratch(p);return n==null?diskExists(p):scratch.has(n)||dirs.has(n);},
      statSync(p){const n=inScratch(p);if(n==null||!(scratch.has(n)||dirs.has(n)))throw Error("ENOENT: fs.statSync "+p);const f=scratch.get(n);
        return {size:f?f.length:0,isFile:()=>!!f,isDirectory:()=>!f};},
      readdirSync(p){const n=inScratch(p);if(n==null)throw Error("fs.readdirSync unavailable in jsc shim outside fs.mkdtempSync directories");
        return [...new Set([...scratch.keys(),...dirs].filter(k=>k.startsWith(n+"/")).map(k=>k.slice(n.length+1).split("/")[0]))].sort();},
      rmSync(p){const n=inScratch(p);if(n==null)return;for(const k of [...scratch.keys()])if(k===n||k.startsWith(n+"/"))scratch.delete(k);for(const d of [...dirs])if(d===n||d.startsWith(n+"/"))dirs.delete(d);}
    });
  }
  const sha1=bytes=>{const rol=(x,n)=>(x<<n)|(x>>>(32-n)),len=bytes.length,input=new Uint8Array(Math.ceil((len+9)/64)*64);input.set(bytes);input[len]=128;const v=new DataView(input.buffer);v.setUint32(input.length-4,len*8);const h=[0x67452301,0xefcdab89,0x98badcfe,0x10325476,0xc3d2e1f0],w=new Int32Array(80);for(let p=0;p<input.length;p+=64){for(let i=0;i<16;i++)w[i]=v.getInt32(p+i*4);for(let i=16;i<80;i++)w[i]=rol(w[i-3]^w[i-8]^w[i-14]^w[i-16],1);let [a,b,c,d,e]=h;for(let i=0;i<80;i++){const f=i<20?(b&c)|(~b&d):i<40?b^c^d:i<60?(b&c)|(b&d)|(c&d):b^c^d,k=i<20?0x5a827999:i<40?0x6ed9eba1:i<60?0x8f1bbcdc:0xca62c1d6,t=(rol(a,5)+f+e+k+w[i])|0;e=d;d=c;c=rol(b,30);b=a;a=t;}[a,b,c,d,e].forEach((x,i)=>h[i]=(h[i]+x)|0);}const out=new Buffer(20),o=new DataView(out.buffer);h.forEach((x,i)=>o.setInt32(i*4,x));return out;};
  // Test-only SHA-256 reference from FIPS 180-4. Derive the constants with integer
  // roots and use BigInt words, independently of Waffle's source-file implementation.
  const word32 = value => BigInt.asUintN(32, value);
  function sha256Parameters() {
    const primes = [];
    for (let candidate = 2; primes.length < 64; candidate++) {
      if (primes.every(prime => candidate % prime !== 0)) primes.push(candidate);
    }
    function fraction(prime, degree) {
      const scale = 1n << 32n;
      const target = BigInt(prime) * scale ** degree;
      let low = 0n, high = BigInt(prime) * scale;
      while (high - low > 1n) {
        const mid = (low + high) >> 1n;
        if (mid ** degree <= target) low = mid;
        else high = mid;
      }
      return word32(low);
    }
    return {initial: primes.slice(0, 8).map(p => fraction(p, 2n)), rounds: primes.map(p => fraction(p, 3n))};
  }
  let sha256Tables;
  function sha256(bytes) {
    const {initial, rounds} = sha256Tables ??= sha256Parameters();
    const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const input = new DataView(padded.buffer);
    input.setBigUint64(padded.length - 8, BigInt(bytes.length) * 8n);
    const rotate = (value, shift) => (value >> shift) | word32(value << (32n - shift));
    let state = initial;
    for (let offset = 0; offset < padded.length; offset += 64) {
      const words = [];
      for (let i = 0; i < 16; i++) words.push(BigInt(input.getUint32(offset + i * 4)));
      for (let i = 16; i < 64; i++) {
        const x = words[i - 15], y = words[i - 2];
        const s0 = rotate(x, 7n) ^ rotate(x, 18n) ^ (x >> 3n);
        const s1 = rotate(y, 17n) ^ rotate(y, 19n) ^ (y >> 10n);
        words.push(word32(words[i - 16] + s0 + words[i - 7] + s1));
      }
      let [a, b, c, d, e, f, g, h] = state;
      for (let i = 0; i < 64; i++) {
        const choose = g ^ (e & (f ^ g));
        const majority = (a & b) | (c & (a | b));
        const upperE = rotate(e, 6n) ^ rotate(e, 11n) ^ rotate(e, 25n);
        const upperA = rotate(a, 2n) ^ rotate(a, 13n) ^ rotate(a, 22n);
        const t1 = h + upperE + choose + rounds[i] + words[i];
        [a, b, c, d, e, f, g, h] = [word32(t1 + upperA + majority), a, b, c, word32(d + t1), e, f, g];
      }
      const block = [a, b, c, d, e, f, g, h];
      state = state.map((word, i) => word32(word + block[i]));
    }
    const result = Buffer.alloc(32), output = new DataView(result.buffer);
    state.forEach((word, i) => output.setUint32(i * 4, Number(word)));
    return result;
  }
  const hashes = new Map([["sha1", sha1], ["sha-1", sha1], ["sha256", sha256], ["sha-256", sha256]]);
  const crypto = {
    createHash(name) {
      if (typeof name !== "string") throw new TypeError("Hash algorithm must be a string");
      const hash = hashes.get(name.toLowerCase());
      if (!hash) throw Error("Unsupported hash algorithm: " + name);
      const parts = [];
      let finalized = false;
      return {
        update(value, encoding) {
          if (finalized) throw Error("Hash already finalized");
          if (typeof value === "string") parts.push(Buffer.from(value, encoding));
          else if (ArrayBuffer.isView(value)) parts.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
          else throw new TypeError("Hash input must be a string or an ArrayBuffer view");
          return this;
        },
        digest(encoding) {
          if (finalized) throw Error("Hash already finalized");
          finalized = true;
          const result = hash(Buffer.concat(parts));
          parts.length = 0;
          return encoding ? result.toString(encoding) : result;
        }
      };
    }
  };
  const url={pathToFileURL:p=>({href:"file://"+encodeURI(norm(p)),pathname:norm(p),toString(){return this.href;}}),fileURLToPath:u=>decodeURI(String(u.href||u).replace(/^file:\/\//,""))};
  const perf={performance:G.performance||{now:()=>Date.now()}};
  // node:vm on top of JSC realms ($262.createRealm), so sandboxed tests really run their bodies.
  const vm={createContext(o={}){if(typeof $262==="undefined"||!$262.createRealm)throw Error("vm.createContext unavailable in this jsc");const r=$262.createRealm();for(const k of Object.keys(o))r.global[k]=o[k];Object.defineProperty(r.global,"__jscRealm",{value:r});return r.global;},
    runInContext(code,g){if(!g||!g.__jscRealm)throw Error("vm.runInContext: not a context");return g.__jscRealm.evalScript(String(code));},
    runInThisContext(code){return (0,eval)(String(code));},isContext:g=>!!(g&&g.__jscRealm)};
  const builtins={assert,"assert/strict":assert,fs,path,os:{tmpdir:()=>"/tmp"},crypto,child_process:{spawnSync(){throw Error("unavailable");}},vm,url,perf_hooks:perf,buffer:{Buffer}};
  const cache=new Map();
  const requireCache={};
  let mainModule=null; // the test file itself, so `require.main===module` guards run their bodies
  function makeRequire(dir){
    const resolve=id=>{let file=id.startsWith("/")?norm(id):path.join(dir,id);if(!/\.(c?js|json)$/.test(file))file+=".js";return file;};
    const require=function(id){
      const bare=id.replace(/^node:/,"");if(builtins[bare])return builtins[bare];
      let file=id.startsWith("/")?norm(id):path.join(dir,id);
      if(!/\.(c?js|json)$/.test(file))file+=".js";
      if(requireCache[file])return requireCache[file].exports;
      const module={exports:{},filename:file,id:file};requireCache[file]=module;if(!mainModule)mainModule=module;
      const src=readFile(file);
      if(file.endsWith(".json")){module.exports=JSON.parse(src);return module.exports;}
      const fn=new Function("module","exports","require","__dirname","__filename",src+"\n//# sourceURL="+file);
      fn.call(G,module,module.exports,makeRequire(path.dirname(file)),path.dirname(file),file);
      return module.exports;
    };
    require.cache=requireCache;require.resolve=resolve;Object.defineProperty(require,"main",{get:()=>mainModule});return require;
  }
  const testFile=argv[0];
  let exitCode=0,lastError="";
  G.process={argv:["node",testFile,...argv.slice(1)],env:{},platform:"darwin",versions:{},on(){},exit(c){throw Error("process.exit("+c+")");},stdout:{write:s=>print(String(s).replace(/\n$/,""))},
    get exitCode(){return exitCode;},
    // A test may change or clear its exit code after the synchronous body returned. The runner
    // reads the last status once JSC has drained its timers and promises, as Node does on exit.
    set exitCode(code){exitCode=code;print("SHIM-EXIT "+(Number(code) ? "process.exitCode="+code+(lastError?": "+lastError:"") : "0"));}};
  G.console={log:(...a)=>print(a.join(" ")),error:(...a)=>{lastError=a.join(" ");print("ERR: "+lastError);},warn:(...a)=>print("WARN: "+a.join(" ")),info:(...a)=>print(a.join(" "))};
  G.global=G;
  G.queueMicrotask??=f=>Promise.resolve().then(f);
  // The standalone JSC shell has no Web API cancellation signal. Run both completion and
  // cancellation paths in tests that schedule work with the browser's AbortController contract.
  G.AbortController??=class AbortController {
    constructor(){
      const listeners=new Set();
      const signal=this.signal={aborted:false,reason:undefined,onabort:null,
        addEventListener(type,listener){if(type==="abort"&&listener&&!signal.aborted)listeners.add(listener);},
        removeEventListener(type,listener){if(type==="abort")listeners.delete(listener);},
        throwIfAborted(){if(signal.aborted)throw signal.reason;}};
      this.abort=(reason=Object.assign(new Error("The operation was aborted."),{name:"AbortError"}))=>{
        if(signal.aborted)return;
        signal.aborted=true;signal.reason=reason;
        const event={type:"abort",target:signal};signal.onabort?.(event);
        for(const listener of listeners){if(typeof listener==="function")listener.call(signal,event);else listener.handleEvent?.(event);}
        listeners.clear();
      };
    }
  };
  // jsc has setTimeout but no clearTimeout: a polled timer table whose cleared entries never keep jsc alive.
  if(typeof G.clearTimeout!=="function"){const native=G.setTimeout,live=new Map();let seq=0,ticking=false;
    const tick=()=>{const now=Date.now();for(const [k,t] of [...live])if(t.at<=now&&live.delete(k))t.f(...t.a);if(live.size)native(tick,4);else ticking=false;};
    G.setTimeout=(f,ms,...a)=>{live.set(++seq,{f,a,at:Date.now()+(ms||0)});if(!ticking){ticking=true;native(tick,0);}return seq;};
    G.clearTimeout=k=>{live.delete(k);};}
  G.structuredClone??=v=>JSON.parse(JSON.stringify(v));
  // Any unhandled promise rejection fails the test (async test bodies would otherwise pass silently).
  let rejected=null;
  if(typeof setUnhandledRejectionCallback==="function")setUnhandledRejectionCallback((a,b)=>{const e=b??a;if(!rejected){rejected=e;print("SHIM-FAIL "+path.basename(testFile)+": unhandled rejection: "+(e&&e.message)+"\n"+(e&&e.stack||e));}});
  try{
    makeRequire(path.dirname(testFile))(testFile);
    // Async tests: wait for globalThis.__testDone when a test sets it.
    const pending=G.__testDone;
    const verdict=()=>print("SHIM-OK "+path.basename(testFile));
    if(pending&&typeof pending.then==="function")pending.then(verdict,e=>print("SHIM-FAIL "+path.basename(testFile)+": "+(e&&e.message)+"\n"+(e&&e.stack||e)));
    else verdict();
  }catch(e){print("SHIM-FAIL "+path.basename(testFile)+": "+(e&&e.message)+"\n"+(e&&e.stack||e));}
})();
