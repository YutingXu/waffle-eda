"use strict";
// A separate JS realm that stands in for an extension Worker in tests (JavaScriptCore $262.createRealm
// or Node vm): joined to the host only by JSON strings. Used by tests/extensions*.cjs.
// ---------------------------------------------------------------- a separate realm
// Binary-safe JSON: ArrayBuffers and typed arrays cross the realm boundary as byte lists.
const CODEC=`const __enc = (k, v) => v instanceof ArrayBuffer ? {$ab: Array.from(new Uint8Array(v))} : ArrayBuffer.isView(v) ? {$view: v.constructor.name, $ab: Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))} : v;
const __dec = (k, v) => v && typeof v === "object" && Array.isArray(v.$ab) ? (b => v.$view ? new globalThis[v.$view](b) : b)(new Uint8Array(v.$ab).buffer) : v;`;
const {__enc,__dec}=new Function(CODEC+";return {__enc,__dec};")();
const BOOT=CODEC+`(function(){
  const post = globalThis.__hostPost; delete globalThis.__hostPost;
  const inbox = [];
  globalThis.self = globalThis;
  self.postMessage = m => post(JSON.stringify(m, __enc));
  self.addEventListener = (type, f) => { if (type === "message") inbox.push(f); };
  globalThis.__deliver = text => { const data = JSON.parse(text, __dec); for (const f of inbox) f({data}); };
  // Timers the host can stop when it "terminates" this realm (a real Worker just dies).
  const nativeTimeout = setTimeout, live = new Map(); let id = 0, ticking = false, dead = false;
  const tick = () => { const now = Date.now(); for (const [k, t] of [...live]) if (t.at <= now && live.delete(k)) { if (t.every) live.set(k, {...t, at: now + t.every}); t.f(); } if (live.size && !dead) nativeTimeout(tick, 4); else ticking = false; };
  const add = (f, ms, every) => { if (dead) return 0; live.set(++id, {f, at: Date.now() + (ms || 0), every}); if (!ticking) { ticking = true; nativeTimeout(tick, 0); } return id; };
  globalThis.setTimeout = (f, ms) => add(f, ms, 0);
  globalThis.setInterval = (f, ms) => add(f, ms, Math.max(1, ms || 0));
  globalThis.clearTimeout = globalThis.clearInterval = k => { live.delete(k); };
  globalThis.__stopTimers = () => { dead = true; live.clear(); };
})();`;
const realms=[];
function realmWorker(source,config){
  const outer={onmessage:null,terminated:false,config,sent:[],terminate(){this.terminated=true;stopTimers?.();}};
  let stopTimers=null;realms.push(outer);
  const hostPost=text=>{if(!outer.terminated)Promise.resolve().then(()=>{if(!outer.terminated)outer.onmessage?.({data:JSON.parse(text,__dec)});});};
  let deliver;
  if(globalThis.$262?.createRealm){
    const r=$262.createRealm();r.global.__hostPost=hostPost;r.evalScript(BOOT);deliver=r.global.__deliver;stopTimers=r.global.__stopTimers;r.evalScript("delete globalThis.__deliver; delete globalThis.__stopTimers");r.evalScript(source);
  }else{
    const vm=require("node:vm"),ctx=vm.createContext({__hostPost:hostPost,setTimeout,clearTimeout});
    vm.runInContext(BOOT,ctx);deliver=vm.runInContext("__deliver",ctx);stopTimers=vm.runInContext("__stopTimers",ctx);vm.runInContext("delete globalThis.__deliver; delete globalThis.__stopTimers",ctx);vm.runInContext(source,ctx);
  }
  outer.postMessage=m=>{const text=JSON.stringify(m,__enc);outer.sent.push(JSON.parse(text));if(outer.sent.length>200)outer.sent.shift();Promise.resolve().then(()=>{if(!outer.terminated)deliver(text);});};
  return outer;
}
module.exports={realmWorker,realms,__enc,__dec};
