"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const {Worker} = require("node:worker_threads");
const filesPath = path.join(__dirname,"../../app");
for (const source of ["core/model","project/source-file","formats/format-2-codec","formats/format-2-units",
  "formats/format-2-values","formats/format-2-model","formats/format-2-closure","formats/sexpr",
  "core/zip","vendor/zipjs-deflate","formats/format-2-models","project/folder-project"])
  require(path.join(filesPath,source+".js"));

function workerScript(name) {
  const worker = new Worker(`
    const {workerData,parentPort} = require("node:worker_threads");
    const path = require("node:path");
    globalThis.self = globalThis;
    globalThis.importScripts = (...files) =>
      files.forEach(file=>require(path.resolve(path.dirname(workerData.entry),file)));
    globalThis.postMessage = (data,transfer) => parentPort.postMessage(data,transfer);
    require(workerData.entry);
    parentPort.on("message",data=>globalThis.onmessage({data}));
  `,{eval:true,workerData:{entry:path.join(filesPath,name)}});
  const handle = {postMessage:(...args)=>worker.postMessage(...args),terminate:()=>worker.terminate()};
  worker.on("message",data=>handle.onmessage?.({data}));
  worker.on("error",error=>handle.onerror?.(error));
  return handle;
}

async function main() {
  const F = AtriumFormat2, C = AtriumFormat2Closure, M = AtriumFormat2Models;
  const project = Atrium.project("Proof",[]);
  project.documents[1].bodyModels = [{id:"step",file:"test.step",stepText:"ISO-10303-21;\nEND-ISO-10303-21;\n"}];
  const native = AtriumFormat2Model.fromEditor(project);
  assert.equal(native.models.length,1);
  const modelPath = native.models[0].path, manifest = "Proof.waffle", root = "selected";
  const data = new Map(native.files.map(row=>[row.path,F.serialize(row.file)]));
  for (const row of native.models) data.set(row.path,M.encode(row.raw));
  const version = (await C.verify(native.manifest,key=>data.get(key))).sha256;
  let next = 0, mode = "fast";
  const leases = new Map(), calls = [];
  function dispatch(packet) {
    const {action,grant,lease,paths,id,verificationNonce} = packet;
    const verified = action === "folderReadVerified";
    const respond = verified ? globalThis.__waffleReceiveVerifiedFolderRead : globalThis.__atriumReceive;
    try {
      assert.equal(grant,root);
      calls.push({action,paths});
      switch (action) {
        case "folderLocalState": case "folderClose": return respond(id,{});
        case "folderReadLease": {
          const lease = "lease-" + ++next;
          leases.set(lease,new Set());
          return respond(id,{lease,verifyModels:mode.startsWith("legacy") ? undefined : "gzip-v1"});
        }
        case "folderRelease": {
          assert.ok(leases.delete(lease));
          return mode === "changed" ? respond(id,null,"A saved member changed.") : respond(id,true);
        }
        case "folderRead": case "folderReadVerified": break;
        default: assert.fail("Unexpected host action " + action);
      }
      const observed = leases.get(lease);
      assert.ok(observed);
      if (verified) {
        assert.ok(observed.has(manifest));
        assert.match(verificationNonce,/^[0-9a-f]{32}$/);
        assert.deepEqual(packet.models.map(row=>row.path),paths);
        if (mode === "rejected") return respond(id,{lease,verificationNonce},"The compressed model is damaged.");
        if (mode === "forged-error") return respond(id,{lease,verificationNonce:"0".repeat(32)},"Plausible host error.");
      }
      const files = paths.map((path,index) => {
        const bytes = data.get(path);
        assert.ok(bytes);
        observed.add(path);
        const row = {path,length:bytes.length,sha256:F.sha256(bytes)};
        if (!verified) {
          if (mode === "legacy-proof" && path === modelPath) row.model = {sha256:native.models[0].sha256};
          return {...row,data:Buffer.from(bytes).toString("base64")};
        }
        const {sha256,byteLength} = packet.models[index];
        const raw = M.decode(bytes,{sha256,byteLength});
        const result = {...row,model:{sha256:F.sha256(raw),byteLength:raw.length}};
        if (mode === "wrong-path") result.path += "-wrong";
        if (mode === "raw-digest") result.model.sha256 = "0".repeat(64);
        if (mode === "raw-length") result.model.byteLength++;
        if (mode === "stored-digest") result.sha256 = "invalid";
        if (mode === "stored-length") result.length = 1;
        if (mode === "body-proof") result.data = "AA==";
        return result;
      });
      if (!verified) return respond(id,{files});
      const reply = {files,lease,verificationNonce};
      // The public body callback cannot complete a model proof, even if given its nonce.
      globalThis.__atriumReceive(id,{...reply,files:[]});
      if (mode === "wrong-lease") reply.lease += "-wrong";
      if (mode === "wrong-nonce") reply.verificationNonce = "0".repeat(32);
      if (mode === "omission") reply.files = [];
      respond(id,reply);
    } catch (error) { respond(id,verified ? {lease,verificationNonce} : null,error.message); }
  }
  globalThis.window = globalThis;
  globalThis.top = globalThis;
  globalThis.webkit = {messageHandlers:{atriumHost:{postMessage:text=>queueMicrotask(()=>dispatch(JSON.parse(text)))}}};
  globalThis.AtriumWorkerPool = {script:workerScript};
  require("../bridge.js");
  const folder = {grant:root,manifest,name:"Proof"};
  const session = await AtriumFolderProject.open(folder,{host:AtriumHost});
  const usesModel = (action) => calls.some(call=>call.action === action && call.paths?.includes(modelPath));
  try {
    assert.ok(!usesModel("folderRead") && !usesModel("folderReadVerified"),"ordinary open does not read models");
    assert.throws(()=>{ globalThis.__waffleReceiveVerifiedFolderRead = () => {}; },TypeError);
    assert.throws(()=>{ globalThis.AtriumHost = {}; },TypeError);
    assert.ok(!AtriumHost.isVerifiedFolderRead({lease:"arbitrary",files:[]}));
    for (const [nextMode,error] of [
      ["wrong-nonce",/authenticated/],["forged-error",/authenticated/],["wrong-lease",/native lease/],["wrong-path",/requested files/],
      ["omission",/requested files/],["raw-digest",/failed verification/],["raw-length",/failed verification/],
      ["stored-digest",/Expected a lowercase SHA-256/],["stored-length",/Invalid native model proof/],
      ["body-proof",/Invalid native model proof/],["rejected",/compressed model is damaged/],["changed",/saved member changed/]
    ]) {
      mode = nextMode;
      calls.length = 0;
      await assert.rejects(session.verifySavedVersion(),error);
      assert.ok(usesModel("folderReadVerified") && !usesModel("folderRead"),"proof failures cannot trigger body fallback");
      assert.equal(leases.size,0,"all proof failures release their snapshot");
    }
    mode = "fast";
    calls.length = 0;
    assert.equal(await session.verifySavedVersion(),version);
    assert.ok(usesModel("folderReadVerified") && !usesModel("folderRead"));
    calls.length = 0;
    assert.equal((await session.requireClosure({saved:true})).version,version);
    assert.ok(usesModel("folderRead") && !usesModel("folderReadVerified"),"a full projection still reads model bodies");
    mode = "legacy";
    calls.length = 0;
    assert.equal(await session.verifySavedVersion(),version);
    assert.ok(usesModel("folderRead") && !usesModel("folderReadVerified"),"unsupported peers use byte verification");
    mode = "legacy-proof";
    await assert.rejects(session.verifySavedVersion(),/unexpected model proof/);
  } finally { await session.close(); }

  mode = "fast";
  calls.length = 0;
  const fake = {...AtriumHost,folderReadVerified() { assert.fail("an injected host must not verify model proofs"); }};
  const fallback = await AtriumFolderProject.open(folder,{host:fake});
  try {
    assert.equal(await fallback.verifySavedVersion(),version);
    assert.ok(usesModel("folderRead") && !usesModel("folderReadVerified"));
  } finally { await fallback.close(); }
  console.log("Authenticated, lease-bound native model proofs match byte verification and reject stale, malformed or unsupported replies.");
}

main().catch(error=>{ console.error(error); process.exitCode=1; });
