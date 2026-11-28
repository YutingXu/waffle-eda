"use strict";
// AtriumPrefsStorage: tools' own localStorage keys in Settings sync and Reset all settings.
//  - export → Reset all → import round-trips every registered "setting" key exactly;
//  - Reset all clears every registered key ("state" too) and leaves user content alone;
//  - every localStorage key in app/ is registered or deliberately left out (the list below).
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const store=new Map();
const storage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k),
  key:i=>[...store.keys()][i]??null,get length(){return store.size;}};
Object.defineProperty(globalThis,"localStorage",{value:storage,configurable:true,writable:true});
require("../../app/core/model.js");
require("../../app/editor/prefs.js");
require("../../app/editor/prefs-storage.js");
const P=AtriumPrefs,S=AtriumPrefsStorage;

// Kinds, prefixes and registration.
assert.equal(S.kind("waffle.si.options"),"setting");
assert.equal(S.kind("waffle.notes.brush"),"setting","the review-notes brush is exported and reset");
assert.equal(S.kind("waffle.notes.sheet.doc-1"),"state","per-sheet note visibility is reset");
assert.equal(S.kind("atrium-online-drc"),"setting","drc-view.js keeps its own key; it is registered here");
assert.equal(S.kind("atrium.eco.autoCluster"),"setting","atrium.eco. is a prefix");
assert.equal(S.kind("atrium.eco."),"setting");
assert.equal(S.kind("atrium-eco-unticked:board-1"),"state");
assert.equal(S.kind("atrium.diff.recent.v1"),"state");
const gitSeenV1="atrium.git.seen.v1",gitSeenV2="atrium.git.seen.v2";
assert.equal(S.kind(gitSeenV1),"state","Reset clears remembered paths from older installations");
assert.equal(S.kind(gitSeenV2),"state","Last Opened is local Git history");
assert.equal(S.kind("atrium.suppliers"),undefined,"secrets are never registered");
assert.equal(S.kind("atrium.fabProfiles.v1"),undefined,"user content is never registered");
assert.throws(()=>S.register("other.key","setting"),/atrium/);
assert.throws(()=>S.register("atrium.x","both"),/setting/);
S.register("waffle.test.tool.v1","state");assert.equal(S.kind("waffle.test.tool.v1"),"state","Waffle-named keys register too");
S.register("atrium.test.tool.v1","setting");assert.equal(S.kind("atrium.test.tool.v1"),"setting");

// Every registered key gets a distinctive value (prefixes get two members).
const SOURCE=fs.readFileSync(path.join(__dirname,"../../app/editor/prefs-storage.js"),"utf8");
const registered=[...new Set([...SOURCE.matchAll(/"((?:atrium|waffle)[.\-][A-Za-z0-9._:\-]*)"/g)].map(m=>m[1]))].filter(k=>S.kind(k));
registered.push("atrium.test.tool.v1");
assert.ok(registered.length>=45,"registered keys found: "+registered.length);
const expanded=registered.flatMap(k=>/[.:]$/.test(k)?[k+"one",k+"two"]:[k]);
const historyHead="c".repeat(40),projectKey="a".repeat(64),oldPath="/example/Private Board.waffle";
const seen={
  [gitSeenV1]:JSON.stringify({[oldPath]:{head:historyHead,at:1}}),
  [gitSeenV2]:JSON.stringify({[projectKey]:{head:historyHead,at:2,previous:{head:"d".repeat(40),at:1}}})
};
function value(k) {
  if (k in seen) return seen[k];
  if (k.includes("bom")) return JSON.stringify({widths:{mpn:200},k});
  if (k.endsWith("units")) return "mil";
  return "v:"+k+":"+'"quoted" ✓';
}
for(const k of expanded)store.set(k,value(k));
// Content that must survive Reset all and never be exported.
const kept={"atrium.suppliers":JSON.stringify({apiKey:"sk-live"}),"atrium.fabProfiles.v1":"[{\"name\":\"Mine\"}]","atrium.themes.user":"[]",
  "atrium-keymap-v1":"{\"user\":1}","waffle-editor-drafts-v1":"{}","waffle-editor-drafts-v1:doc:mine":"private draft","atrium.clipboard.v1":"{}","atrium.scripts.v1":"[]","atrium.libraries.v1":"[]",
  "atrium.group-library.v1":"1","atrium.group-member.v1":"{}","atrium.camera.views.v1":"{}","atrium.selmem.v1":"{}","atrium.extensions.v1":"{}","atrium-workspace-v1":"{}"};
for(const [k,v] of Object.entries(kept))store.set(k,v);
P.set("general.units","mil");

const settings=expanded.filter(k=>S.kind(k)==="setting"),states=expanded.filter(k=>S.kind(k)==="state");
assert.ok(settings.length>20&&states.length>20);
assert.deepEqual(S.keys("setting"),[...settings].sort());
assert.deepEqual(S.keys("state"),[...states].sort());

// Export: settings only, text kept exactly; no state, no secrets, no user content.
const bundle=JSON.parse(P.exportSettings());
assert.deepEqual(Object.keys(bundle.storage).sort(),[...settings].sort());
for(const k of settings)assert.equal(bundle.storage[k],value(k),k);
const text=JSON.stringify(bundle);
for(const k of states)assert.ok(!(k in bundle.storage),k);
for(const k of Object.keys(kept))assert.ok(!(k in bundle.storage),k);
assert.doesNotMatch(text,/sk-live/);
for(const privateValue of [oldPath,projectKey,historyHead])assert.ok(!text.includes(privateValue),"Settings export omits local Git history");

// Reset all: every registered key goes, preferences return to their defaults, content stays.
const cleared=S.resetAll();
assert.deepEqual([...cleared].sort(),[...expanded].sort());
for(const k of expanded)assert.equal(store.has(k),false,k);
for(const [k,v] of Object.entries(kept))assert.equal(store.get(k),v,k+" is kept");
assert.equal(P.get("general.units"),"mm");

// Import: every setting comes back exactly; state stays cleared; unknown keys are skipped.
bundle.storage["atrium.suppliers"]="{}";bundle.storage["not-atrium"]="x";bundle.storage["atrium.diff.recent.v1"]="[]";
Object.assign(bundle.storage,seen);
const r=P.importSettings(JSON.stringify(bundle));
for(const k of settings)assert.equal(store.get(k),value(k),k+" round-trips");
for(const k of states)assert.equal(store.has(k),false,k);
assert.equal(P.get("general.units"),"mil");
assert.ok(r.applied.some(a=>/^tool settings/.test(a)),r.applied.join());
for(const k of ["atrium.suppliers","not-atrium","atrium.diff.recent.v1",gitSeenV1,gitSeenV2])assert.ok(r.skipped.includes(k),k);
assert.equal(store.get("atrium.suppliers"),kept["atrium.suppliers"],"an import never writes an unregistered key");
// An older bundle without the storage section still imports.
const old=JSON.parse(JSON.stringify(bundle));delete old.storage;assert.ok(P.importSettings(JSON.stringify(old)).applied.includes("preferences"));

// Completeness: each localStorage key named in app/ is registered or deliberately left out.
const LEFT_OUT={
  "atrium.prefs":"its own export","atrium-prefs":"format name","atrium.theme":"its own export","atrium-theme":"format name","atrium.theme.cache":"derived cache",
  "atrium-keymap-v1":"its own export and reset","atrium-recovery-v2":"recovery","atrium-recovery-v2:":"recovery","atrium-workspace-v1":"project data",
  "atrium.suppliers":"secret","atrium.suppliers.cache":"supplier cache","atrium.clipboard.v1":"user content","atrium-clip-history":"format name",
  "atrium.fabProfiles.v1":"user content","atrium.themes.user":"user content","atrium.scripts.v1":"user content","atrium.libraries.v1":"user content","atrium.library-folders.v1":"this machine's folders",
  "atrium.group-library.v1":"local library copies","atrium.group-member.v1":"local library member identity","atrium.collab.hostToken":"private relay credential",
  "atrium.camera.views.v1":"per-document content","atrium.selmem.v1":"per-document content","atrium-update":"format name",
  "atrium.extensions.v1":"extensions","atrium.extensions.registry":"extensions","atrium.extensions.registry.installed":"extensions",
  "atrium.ext.settings.":"extensions","atrium.ext.storage.":"extensions","atrium.ext.trust.v1":"extensions","atrium.ext.code.":"extensions","atrium-routing-habits":"format name","atrium.dev":"developer switch",
  "atrium-split-follow-v1":"sessionStorage","waffle-editor-drafts-v1":"recovery","waffle-foreign-draft:":"recovery","waffle-editor-draft-session:":"a Web Locks name, not storage",
  "atrium.ai.project.":"per-project AI permission policy, never exported","atrium.kicad-model-folders.v1":"this machine's folders",
  "atrium-diagnostics-v1":"legacy diagnostic migration","atrium-diagnostics-counts-v1":"legacy undated diagnostic counts",
  "atrium-diagnostics-counts-v2":"local rolling diagnostic counts","atrium-diagnostics-clear-v2":"diagnostic clear generation",
  "atrium.":"review.author fallback before AtriumPref (eager) existed"};
const app=path.join(__dirname,"../../app");
// Every app module that touches localStorage, found by scanning, so a new tool cannot be missed.
// The shared app inventory is the same walk under Node and JavaScriptCore, which cannot list a directory.
const modules=[...require("../support/app-source-paths.cjs").inventoryFrom().values()]
  .filter(rel=>rel.endsWith(".js")&&!rel.split("/").slice(0,-1).includes("vendor"));
const SOURCES=modules.map(file=>({file,src:fs.readFileSync(path.join(app,file),"utf8")})).filter(m=>/localStorage/.test(m.src));
assert.ok(SOURCES.length>=70,"modules using localStorage found: "+SOURCES.length);
const lit=/"((?:atrium|waffle)[.\-][A-Za-z0-9._:\-]*)"/g;
const cand=/localStorage|getItem|setItem|\b(?:const|let)\s+[A-Z_]*(?:KEY|STORE|PREFS?|VIEWS|SOURCES|RECENT|HINT|USER|CONFIG|PROVENANCE|DRAFT|HISTORY|SAVED|HEIGHT)\b|\b(?:key|KEY)\s*=\s*"atrium|ls\.(?:get|set)\(|=\s*(?:\([^)]*\)\s*=>\s*)?"(?:atrium|waffle)[.\-][A-Za-z0-9._\-]*[.:]"/;
const missing=[];
for(const {file,src} of SOURCES){
  for(const line of src.split("\n"))if(cand.test(line))for(const m of line.matchAll(lit)){const k=m[1];if(!S.kind(k)&&!(k in LEFT_OUT))missing.push(file+": "+k);}
}
if(missing.length)console.log("MISSING "+missing.join(" | "));
assert.deepEqual(missing,[],"register these in app/editor/prefs-storage.js or list them in LEFT_OUT");
// Every current key has a producer. Older path-indexed Git history remains eligible for reset.
const all=SOURCES.filter(m=>m.file!=="editor/prefs-storage.js").map(m=>m.src).join("\n");
assert.ok(!all.includes('"'+gitSeenV1+'"'),"the old path-indexed history is retained only for reset");
for(const k of registered)if(k!=="atrium.test.tool.v1"&&k!==gitSeenV1)assert.ok(all.includes('"'+k+'"'),k+" is registered but no module uses it");
console.log("SHIM-OK prefs-storage");
