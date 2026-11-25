"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
for (const file of ["model","parts","spatial","altium-rules","rules","connectivity","zip","keymap",
  "uuid-v7","link-record","proposal","atrium-api","extension-host-worker","extensions","butter","butter-ai"]) require(require("../support/app-source-paths.cjs").appFile(file + ".js"));
require("../../app/extensions/manifests.js");
const {realmWorker,realms} = require("../extensions/extension-realm.js");
const X = AtriumExtensions, AI = AtriumAIProviders;
const base = path.resolve(__dirname,"../../extensions/examples/ai-provider");
const pkg = Object.fromEntries(["waffle-extension.json","provider.js"].map(file => [file,fs.readFileSync(path.join(base,file),"utf8")]));
const id = "waffle.local-ai-example:local";
const projectId = "01952010-a000-7000-8000-000000000001";
const documentId = "01952010-a000-7000-8000-000000000002";
const componentId = "01952010-a000-7000-8000-000000000003";
const otherDocument = "01952010-a000-7000-8000-000000000004";
const sample = {id:projectId, documents:[{id:documentId,kind:"pcb",items:[{id:componentId,kind:"part",ref:"U1"}]}], library:[]};
let enabled = false, current = true, network = 0, toolCalls = 0;
globalThis.AtriumPrefs = {get: name => name === "butter.ai" && enabled};
X.attach({project:() => sample, documentId:() => documentId, revision:() => 1, selection:() => new Set([componentId]), info() {}},
  {createWorker:realmWorker, fetch() {network++; throw Error("No provider networking in this test.");},
    consent: request => request.kind === "install" ? {"ai:provider":true} : true});

async function credentialCancellation(manifest,provider) {
  const owner = "waffle.credential-fixture", id = owner + ":local", networkPermission = "network:provider.invalid";
  const bundle = {
    "waffle-extension.json":JSON.stringify({...manifest,id:owner,permissions:["ai:provider",networkPermission],
      contributes:{aiProviders:[{...provider,hosts:["provider.invalid"],auth:"bearer"}]}}),
    "provider.js":`module.exports.respond = async () => {
      await fetch("https://provider.invalid/approved");
      return {type:"answer",text:"Offline response."};
    };`
  };
  const deferred = () => {
    let resolve;
    const promise = new Promise(done => {resolve = done;});
    return {promise,resolve};
  };
  let lookup = deferred(), credential = deferred(), beginFetch = deferred(), fetchCount = 0;
  let abort, expected = "offline-fixture-credential";
  globalThis.AtriumHost = {async aiCredential(operation) {
    if (operation === "load") {lookup.resolve(); return credential.promise;}
    return {available:true,configured:operation === "configure",maxBytes:4096};
  }};
  X.attach({project:() => sample, documentId:() => documentId, revision:() => 1, selection:() => new Set([componentId]), info() {}},
    {createWorker:realmWorker,fetch:(_,options) => {
      fetchCount++;
      assert.deepEqual(options.headers,[["Authorization","Bearer " + expected]]);
      abort = options.signal;
      beginFetch.resolve();
      return new Promise((_,reject) => abort.addEventListener("abort",() => reject(Error("Cancelled")),{once:true}));
    },consent:() => ({"ai:provider":true,[networkPermission]:true})});
  await X.install(bundle);
  const pending = X.askAI(id,{},() => true);
  const staleLookup = assert.rejects(pending,error => error.code === "stale_source");
  await lookup.promise;
  await X.grant(owner,"ai:provider",false);
  await X.grant(owner,"ai:provider",true);
  await staleLookup;
  assert.equal(realms.at(-1).terminated,true);
  credential.resolve(expected);
  await new Promise(resolve => setTimeout(resolve,0));
  assert.equal(fetchCount,0,"a late credential cannot restart the old request");

  lookup = deferred(); credential = deferred();
  const inFlight = X.askAI(id,{},() => true);
  const staleFetch = assert.rejects(inFlight,error => error.code === "stale_source");
  await lookup.promise;
  credential.resolve(expected);
  await beginFetch.promise;
  await X.grant(owner,networkPermission,false);
  await X.grant(owner,networkPermission,true);
  await staleFetch;
  assert.equal(abort.aborted,true,"revocation aborts the trusted fetch");
  assert.ok(!JSON.stringify(realms.at(-1).sent).includes(expected),"the broker does not send the key to the worker");

  lookup = deferred(); credential = deferred();
  const missing = assert.rejects(X.askAI(id,{},() => true),error => error.code === "credential_missing");
  await lookup.promise;
  credential.resolve(null);
  await missing;
  globalThis.AtriumHost.aiCredential = () => Promise.reject(Error("Mocked credential-store error."));
  await assert.rejects(X.askAI(id,{},() => true),error => error.code === "credential_unavailable");
  assert.equal(fetchCount,1);

  require("../../app/automation/ai-provider-desktop.js");
  const account = X.credentialAI(id,"configure");
  assert.ok(account);
  globalThis.AtriumHost.aiCredential = async (operation,selected) => {
    assert.equal(selected,account);
    return {available:true,configured:operation === "configure",maxBytes:4096};
  };
  assert.equal((await AtriumAIProvidersDesktop.credential(id,"configure")).configured,true);
  await X.grant(owner,"ai:provider",false);
  assert.equal(X.credentialAI(id,"configure"),null);
  assert.deepEqual(await AtriumAIProvidersDesktop.credential(id,"forget"),{available:true,configured:false,maxBytes:4096});
}

(async () => {
  const manifest = JSON.parse(pkg["waffle-extension.json"]);
  assert.throws(() => X.validateManifest({...manifest,permissions:[]},pkg), /ai:provider/);
  const provider = manifest.contributes.aiProviders[0];
  assert.throws(() => X.validateManifest({...manifest,contributes:{aiProviders:[{...provider,hosts:["ungranted.invalid"]}]}},pkg), /network hosts/);
  assert.throws(() => X.validateManifest({...manifest,contributes:{aiProviders:[{...provider,auth:"bearer"}]}},pkg), /exact HTTPS/);

  const start = performance.now();
  await X.install(pkg);
  assert.deepEqual(X.providersAI(),[]);
  assert.ok(!X.workers.some(worker => worker.pool.startsWith("ai:")));
  await assert.rejects(AtriumButter.run("butter.ai.providers"), err => err.code === "butter_disabled");
  const offMs = performance.now() - start;

  enabled = true;
  assert.deepEqual(X.providersAI().map(row => row.id),[id]);
  assert.equal(X.credentialAI(id),null);
  const context = {project:sample,documentId,selection:[componentId],revision:4,isCurrent:() => current};
  const request = {provider:id,prompt:"Which parts are in the approved view?"};
  const transport = {
    decision:{providers:[id],documents:[documentId],objects:[componentId],fields:["id","kind","documentId"],tools:["query"]},
    provider:(providerId,input) => X.askAI(providerId,input,() => current),
    tool(name,args,scope) {
      toolCalls++;
      assert.equal(name,"query");
      assert.deepEqual(args,{scope:"part"});
      assert.deepEqual(scope.documents,[documentId]);
      return [
        {documentId,id:componentId,kind:"part",ungranted:"Drop this unknown field"},
        {documentId:otherDocument,id:otherDocument,kind:"part"}
      ];
    }
  };
  const begin = performance.now();
  const answer = await AI.capture(request, context, transport);
  const callMs = performance.now() - begin;
  assert.equal(answer.text,"Read 1 approved rows.");
  assert.equal(answer.citations[0].url,`waffle://${projectId}/${componentId}`);
  assert.equal(answer.citations.length,1);
  assert.equal(toolCalls,1);
  assert.equal(network,0);
  assert.ok(!X.workers.some(worker => worker.pool.startsWith("ai:")));

  const incoming = input => input.reads.length ? {type:"answer",text:"password: test-sentinel",citations:["bad-link"]} :
    {type:"tools",calls:[{tool:"query",args:{scope:"part",documentId:otherDocument}}]};
  await assert.rejects(AI.capture(request,context,{...transport,provider:(_,input) => incoming(input)}),
    err => err.code === "invalid_arguments");
  await assert.rejects(AI.capture(request,context,{...transport,
    decision:{...transport.decision,documents:[otherDocument]}}),err => err.code === "permission_denied");
  await assert.rejects(AI.capture(request,context,{...transport,provider:() => {
    current = false; return {type:"answer",text:"This stale result must be discarded."};
  }}),err => err.code === "stale_source");
  assert.equal(toolCalls,1);
  current = true;
  const cited = await AI.capture(request,context,{
    ...transport,
    provider:(_,input) => input.reads.length ? {type:"answer",text:"Citing projected evidence.",
      citations:["invalid",...input.reads.flatMap(read => read.rows.map(row => row.citation))]} : {
      type:"tools",calls:[{tool:"query",args:{scope:"part"}},{tool:"query",args:{scope:"part"}}]
    },
    tool:() => Array.from({length:16},(_,index) => ({documentId,id:"legacy-" + index,kind:"part",excluded:"private"}))
  });
  assert.equal(cited.citations.length,16);
  assert.equal(cited.citationsOmitted,16);
  assert.deepEqual(cited.citations[0],{ticket:"t1.1",evidence:{tool:"query",row:{documentId,id:"legacy-0",kind:"part"}}});
  assert.equal(AI.redact("password: test-sentinel"),"[redacted]");
  current = true;
  await X.setEnabled("waffle.local-ai-example",false);
  await assert.rejects(X.askAI(id,{},() => true), /unavailable/);
  assert.deepEqual(X.providersAI(),[]);
  if (typeof AbortController === "function") await credentialCancellation(manifest,provider);
  console.log("AI provider consent, scoped citations, stale/refused calls, redaction and idle termination passed.");
  console.log("Local off install/check " + offMs.toFixed(1) + " ms; isolated two-turn tool request " + callMs.toFixed(1) + " ms.");
})().catch(error => { console.error(error); process.exitCode = 1; });
